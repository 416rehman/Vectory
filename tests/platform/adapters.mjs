// The service managers the platform checks drive: systemd on Linux, launchd on
// macOS and the Service Control Manager on Windows. Each adapter says what the
// manager reports about the agent's service, and restarts, stops, starts and
// kills it, so the lifecycle checks read the same on every platform. The
// agent's own commands (service-stop, service-start) are used where an operator
// would use them; the manager's native commands (systemctl restart, launchctl
// kickstart, Restart-Service) where the manager's behaviour is what is checked.
import fs from "node:fs";
import path from "node:path";
import { linux, macos, parseKeyValues, run, windows } from "./lib.mjs";

export const SYSTEMD_UNIT = "vectory.service";
/** Where `vectory setup` registers the unit; a unit here takes precedence over /usr/lib/systemd/system. */
export const GENERATED_UNIT = "/etc/systemd/system/vectory.service";
export const LAUNCHD_LABEL = "io.vectory.agent";
export const WINDOWS_SERVICE = "Vectory";

/** Compares a manager's properties with what a check expects; one error lists every difference. */
export function expectProperties(actual, expected, what) {
  const problems = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    const ok =
      typeof want === "function"
        ? want(got ?? "")
        : want instanceof RegExp
          ? want.test(got ?? "")
          : got === want;
    if (!ok)
      problems.push(
        `${key}: expected ${typeof want === "function" ? "a value that passes its check" : String(want)}, found ${JSON.stringify(got)}`,
      );
  }
  if (problems.length)
    throw new Error(
      `${what} differs from what the product documents:\n  ${problems.join("\n  ")}\nAll properties:\n${Object.entries(
        actual,
      )
        .map(([k, v]) => `  ${k}=${v}`)
        .join("\n")}`,
    );
}

const psRows = (text) =>
  text
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, user, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      user,
      command,
    }));

/**
 * The processes the agent started, out of a list of { pid, ppid, user, command }:
 * the supervisors it runs (`vectory __vector-host ...`) and the Vector processes
 * they run. A Vector is the agent's when its command line begins with the
 * executable and `--config-json` and carries --graceful-shutdown-limit-secs,
 * which only the agent passes: the validator's short runs, and any shell or
 * script that merely mentions the words, don't match.
 */
const VECTOR_COMMAND = /^"?(?:.*[\\/])?vector(?:\.exe)?"? --config-json /;
const SUPERVISOR_COMMAND = /^"?(?:.*[\\/])?vectory(?:\.exe)?"? __vector-host /;
export function classifyProcesses(rows) {
  return {
    vectors: rows.filter(
      (row) =>
        VECTOR_COMMAND.test(row.command) &&
        row.command.includes("--graceful-shutdown-limit-secs"),
    ),
    supervisors: rows.filter((row) => SUPERVISOR_COMMAND.test(row.command)),
  };
}

/** Every process the agent started on this host. */
export function agentProcesses() {
  let rows;
  if (windows) {
    const script =
      "$p = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'vector.exe' -or $_.Name -eq 'vectory.exe') -and $_.CommandLine } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; user = ''; command = $_.CommandLine } }); ConvertTo-Json -InputObject $p -Compress";
    const result = run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { quiet: true },
    );
    const text = result.stdout.trim();
    rows = text ? JSON.parse(text) : [];
  } else {
    rows = psRows(
      run("ps", ["-A", "-o", "pid=,ppid=,user=,command="], { quiet: true })
        .stdout,
    );
  }
  return classifyProcesses(rows);
}

export const describeProcesses = () => {
  const { vectors, supervisors } = agentProcesses();
  const line = (row) =>
    `  pid ${row.pid} (parent ${row.ppid}${row.user ? `, ${row.user}` : ""}): ${row.command.slice(0, 160)}`;
  return `Vector processes the agent started: ${vectors.length}\n${vectors.map(line).join("\n")}\nSupervisors: ${supervisors.length}\n${supervisors.map(line).join("\n")}`;
};

function systemd(context) {
  const show = (properties) =>
    parseKeyValues(
      run(
        "systemctl",
        [
          "show",
          SYSTEMD_UNIT,
          "--no-pager",
          ...properties.map((p) => `--property=${p}`),
        ],
        { quiet: true },
      ).stdout,
    );
  return {
    kind: "systemd",
    serviceName: SYSTEMD_UNIT,
    account: "vectory",
    createUser: true,
    show,
    state() {
      const s = show([
        "LoadState",
        "ActiveState",
        "SubState",
        "MainPID",
        "Result",
        "NRestarts",
        "FragmentPath",
        "UnitFileState",
      ]);
      return {
        installed: s.LoadState === "loaded",
        running: s.ActiveState === "active" && s.SubState === "running",
        pid: Number(s.MainPID) || 0,
        restarts: Number(s.NRestarts) || 0,
        summary: `${s.LoadState}, ${s.ActiveState}/${s.SubState}, MainPID=${s.MainPID}, Result=${s.Result}, NRestarts=${s.NRestarts}, ${s.UnitFileState}, ${s.FragmentPath}`,
        raw: s,
      };
    },
    describe() {
      return [
        run("systemctl", ["status", SYSTEMD_UNIT, "--no-pager", "-l"], {
          allowFailure: true,
          quiet: true,
        }).text,
        run(
          "journalctl",
          ["-u", SYSTEMD_UNIT, "--no-pager", "-n", "40", "-o", "short-iso"],
          { elevated: true, allowFailure: true, quiet: true },
        ).text,
        describeProcesses(),
      ].join("\n");
    },
    /** The journal of the unit, optionally from an ISO time on. */
    journal(since) {
      const args = [
        "-u",
        SYSTEMD_UNIT,
        "--no-pager",
        "-o",
        "short-iso",
        ...(since ? ["--since", since] : []),
      ];
      return run("journalctl", args, {
        elevated: true,
        quiet: true,
        allowFailure: true,
      }).stdout;
    },
    restart() {
      run("systemctl", ["restart", SYSTEMD_UNIT], {
        elevated: true,
        timeoutMs: 400000,
      });
      return `systemctl restart ${SYSTEMD_UNIT}`;
    },
    stop() {
      run("systemctl", ["stop", SYSTEMD_UNIT], {
        elevated: true,
        timeoutMs: 400000,
      });
      return `systemctl stop ${SYSTEMD_UNIT}`;
    },
    start() {
      run(context.agent, ["service-start"], {
        elevated: true,
        timeoutMs: 120000,
      });
      return "vectory service-start";
    },
    crash(pid) {
      run("kill", ["-9", String(pid)], { elevated: true });
      return `kill -9 ${pid}`;
    },
    // A packaged unit under /usr/lib may take over once the generated one in /etc is gone,
    // so "unregistered" means that file is gone and nothing runs.
    unregistered() {
      return (
        !fs.existsSync(GENERATED_UNIT) &&
        show(["ActiveState"]).ActiveState !== "active"
      );
    },
    /** What the registration left on disk, for the evidence. */
    artifacts() {
      return { [GENERATED_UNIT]: fs.existsSync(GENERATED_UNIT) };
    },
    collect(dir) {
      const save = (name, result) =>
        fs.writeFileSync(path.join(dir, name), result.text);
      save(
        "systemctl-show.txt",
        run("systemctl", ["show", SYSTEMD_UNIT, "--no-pager"], {
          allowFailure: true,
          quiet: true,
        }),
      );
      save(
        "systemctl-status.txt",
        run("systemctl", ["status", SYSTEMD_UNIT, "--no-pager", "-l"], {
          allowFailure: true,
          quiet: true,
        }),
      );
      save(
        "unit.txt",
        run("systemctl", ["cat", SYSTEMD_UNIT, "--no-pager"], {
          allowFailure: true,
          quiet: true,
        }),
      );
      save(
        "journal.txt",
        run(
          "journalctl",
          ["-u", SYSTEMD_UNIT, "--no-pager", "-o", "short-iso"],
          { elevated: true, allowFailure: true, quiet: true },
        ),
      );
      save(
        "processes.txt",
        run("ps", ["-A", "-o", "pid,ppid,user,etime,command", "--forest"], {
          allowFailure: true,
          quiet: true,
        }),
      );
    },
  };
}

function launchd(context) {
  const target = `system/${LAUNCHD_LABEL}`;
  const plist = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
  const print = () =>
    run("launchctl", ["print", target], {
      elevated: true,
      allowFailure: true,
      quiet: true,
    });
  return {
    kind: "launchd",
    serviceName: LAUNCHD_LABEL,
    account: "_vectory",
    createUser: true,
    plist,
    print,
    state() {
      const installed = fs.existsSync(plist);
      const result = print();
      if (result.code !== 0)
        return {
          installed,
          loaded: false,
          running: false,
          pid: 0,
          restarts: 0,
          summary: `plist ${installed ? "present" : "absent"}, not loaded by launchd`,
          raw: result.text,
        };
      const value = (key) =>
        new RegExp(`^\\s*${key} = (.+)$`, "m").exec(result.stdout)?.[1]?.trim();
      const status = value("state");
      const pid = Number(value("pid") || 0);
      return {
        installed,
        loaded: true,
        running: status === "running" && pid > 0,
        pid,
        restarts: Number(value("runs") || 0),
        summary: `plist ${installed ? "present" : "absent"}, state=${status}, pid=${pid}, runs=${value("runs")}, last exit code=${value("last exit code")}`,
        raw: result.stdout,
      };
    },
    describe() {
      return [print().text, describeProcesses()].join("\n");
    },
    restart() {
      run("launchctl", ["kickstart", "-k", target], {
        elevated: true,
        timeoutMs: 400000,
      });
      return `launchctl kickstart -k ${target}`;
    },
    stop() {
      run(context.agent, ["service-stop"], {
        elevated: true,
        timeoutMs: 400000,
      });
      return "vectory service-stop (launchctl bootout)";
    },
    start() {
      run(context.agent, ["service-start"], {
        elevated: true,
        timeoutMs: 120000,
      });
      return "vectory service-start (launchctl bootstrap)";
    },
    crash(pid) {
      run("kill", ["-9", String(pid)], { elevated: true });
      return `kill -9 ${pid}`;
    },
    unregistered() {
      return !fs.existsSync(plist) && print().code !== 0;
    },
    artifacts() {
      return { [plist]: fs.existsSync(plist) };
    },
    collect(dir) {
      const save = (name, result) =>
        fs.writeFileSync(path.join(dir, name), result.text);
      save("launchctl-print.txt", print());
      save(
        "plist.txt",
        run("cat", [plist], {
          elevated: true,
          allowFailure: true,
          quiet: true,
        }),
      );
      save(
        "processes.txt",
        run("ps", ["-A", "-o", "pid,ppid,user,etime,command"], {
          allowFailure: true,
          quiet: true,
        }),
      );
    },
  };
}

function scm(context) {
  const query = () =>
    run("sc.exe", ["queryex", WINDOWS_SERVICE], {
      allowFailure: true,
      quiet: true,
    });
  const powershell = (script, timeoutMs = 120000) =>
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeoutMs },
    );
  return {
    kind: "windows",
    serviceName: WINDOWS_SERVICE,
    account: "NT SERVICE\\Vectory",
    createUser: false,
    query,
    state() {
      const result = query();
      if (/1060/.test(result.text))
        return {
          installed: false,
          running: false,
          pid: 0,
          restarts: 0,
          summary: "the service is not installed (1060)",
          raw: result.text,
        };
      const status = /STATE\s*:\s*\d+\s+(\w+)/.exec(result.stdout)?.[1];
      const pid = Number(/PID\s*:\s*(\d+)/.exec(result.stdout)?.[1] ?? 0);
      return {
        installed: result.code === 0,
        running: status === "RUNNING",
        pid,
        restarts: 0,
        summary: `${status ?? "unknown"}, pid ${pid}`,
        raw: result.text,
      };
    },
    describe() {
      return [
        query().text,
        run("sc.exe", ["qc", WINDOWS_SERVICE], {
          allowFailure: true,
          quiet: true,
        }).text,
        describeProcesses(),
      ].join("\n");
    },
    restart() {
      powershell(
        `Restart-Service -Name ${WINDOWS_SERVICE} -Force -ErrorAction Stop`,
        400000,
      );
      return `Restart-Service ${WINDOWS_SERVICE}`;
    },
    stop() {
      run(context.agent, ["service-stop"], { timeoutMs: 400000 });
      return "vectory service-stop";
    },
    start() {
      run(context.agent, ["service-start"], { timeoutMs: 120000 });
      return "vectory service-start";
    },
    crash(pid) {
      run("taskkill.exe", ["/F", "/PID", String(pid)]);
      return `taskkill /F /PID ${pid}`;
    },
    unregistered() {
      return /1060/.test(query().text);
    },
    artifacts() {
      return { [`service ${WINDOWS_SERVICE}`]: !/1060/.test(query().text) };
    },
    collect(dir) {
      const save = (name, result) =>
        fs.writeFileSync(path.join(dir, name), result.text);
      save("sc-queryex.txt", query());
      save(
        "sc-qc.txt",
        run("sc.exe", ["qc", WINDOWS_SERVICE], {
          allowFailure: true,
          quiet: true,
        }),
      );
      save(
        "sc-qfailure.txt",
        run("sc.exe", ["qfailure", WINDOWS_SERVICE], {
          allowFailure: true,
          quiet: true,
        }),
      );
      save("processes.txt", { text: describeProcesses() });
      const programData = process.env.ProgramData || "C:\\ProgramData";
      save(
        "acl-state.txt",
        run("icacls.exe", [path.join(programData, "Vectory")], {
          allowFailure: true,
          quiet: true,
        }),
      );
    },
  };
}

/** The adapter for this host. `context` carries the installed agent's path. */
export function adapterFor(context = {}) {
  if (windows) return scm(context);
  if (macos) return launchd(context);
  if (linux) return systemd(context);
  throw new Error(`No service manager adapter for ${process.platform}.`);
}
