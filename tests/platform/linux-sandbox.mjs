#!/usr/bin/env node
// What the two systemd units confine, read from the running service itself
// (Linux with systemd; run after `service.mjs install` and `service.mjs apply`).
//
//   node tests/platform/linux-sandbox.mjs generated
//       The unit `vectory setup` registers in /etc/systemd/system
//       (ProtectSystem=full, ProtectHome=read-only): its properties, the
//       service's own mount table, writes made as the service account inside
//       the service's mount namespace, and systemd's own security analysis.
//       Also that it takes precedence over the packaged unit.
//   node tests/platform/linux-sandbox.mjs packaged
//       packaging/systemd/vectory.service, installed in /usr/lib/systemd/system
//       as the .deb and .rpm install it, with only ExecStart pointing at the
//       agent this job installed: the same reading, with the strict
//       expectations (ProtectSystem=strict, ProtectHome=true).
//
// Writes are made with `nsenter --mount` into the service's namespace and
// `setpriv` down to the service account (sudo -u would test the host's file
// system, not the unit's), so a probe answers what the service itself can do.
// The packaged phase leaves the device running under the strict unit; run
// `service.mjs apply strict` afterwards to apply a pipeline under it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GENERATED_UNIT, SYSTEMD_UNIT, expectProperties } from "./adapters.mjs";
import { bind } from "./checks.mjs";
import { connect } from "./instance.mjs";
import {
  isReadOnly,
  main,
  mountFor,
  outputRoot,
  parseDuration,
  parseExposure,
  parseMountInfo,
  readContext,
  root,
  run,
  until,
  writeContext,
} from "./lib.mjs";

const PACKAGED_UNIT = "/usr/lib/systemd/system/vectory.service";
/** A folder the service account owns, outside everything either unit lists. */
const PROBE_DIR = "/srv/vectory-sandbox-probe";
const phase = process.argv[2];

const PROPERTIES = [
  "LoadState",
  "ActiveState",
  "SubState",
  "MainPID",
  "UnitFileState",
  "FragmentPath",
  "User",
  "Group",
  "Restart",
  "KillMode",
  "TimeoutStopUSec",
  "NoNewPrivileges",
  "PrivateTmp",
  "ProtectSystem",
  "ProtectHome",
  "UMask",
  "ReadWritePaths",
  "ExecStart",
  "Result",
  "NRestarts",
  "ControlGroup",
];

/** The service's main process, and the account it runs as. */
function serviceProcess(adapter, context) {
  const state = adapter.state();
  if (!state.running)
    throw new Error(`The service is not running:\n${adapter.describe()}`);
  const id = (flag) =>
    Number(run("id", [flag, context.account], { quiet: true }).stdout);
  return { pid: state.pid, uid: id("-u"), gid: id("-g") };
}

/** Runs a shell script as the service account inside the service's mount namespace. */
function asService({ pid, uid, gid }, script, ...args) {
  return run(
    "nsenter",
    [
      "-t",
      String(pid),
      "-m",
      "--",
      "setpriv",
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--clear-groups",
      "sh",
      "-c",
      script,
      "probe",
      ...args,
    ],
    { elevated: true, allowFailure: true, quiet: true },
  );
}

const TRY_WRITE =
  'out=$(touch "$1/.vectory-probe" 2>&1) && { rm -f "$1/.vectory-probe"; echo WRITABLE; } || echo "$out"';

/** The write probes and mount flags both units are held to; `strict` is the packaged unit. */
function expectations(context, strict) {
  const home = path.dirname(os.homedir());
  return {
    mounts: [
      { path: "/usr/bin", readOnly: true },
      { path: "/etc/passwd", readOnly: true },
      ...(fs.existsSync("/boot") ? [{ path: "/boot", readOnly: true }] : []),
      // ProtectHome=true hides /home behind an inaccessible folder; the home step below checks what the service sees there.
      ...(strict ? [] : [{ path: home, readOnly: true }]),
      { path: PROBE_DIR, readOnly: strict },
      { path: path.dirname(context.managedConfig), readOnly: false },
      { path: context.stateDir, readOnly: false },
      { path: "/var/lib/vector", readOnly: false },
    ],
    writes: [
      { path: "/usr", writable: false, erofs: true },
      { path: "/etc", writable: false, erofs: true },
      { path: PROBE_DIR, writable: !strict, erofs: strict },
      { path: path.dirname(context.managedConfig), writable: true },
      { path: context.stateDir, writable: true },
      { path: "/var/lib/vector", writable: true },
      { path: "/tmp", writable: true },
    ],
  };
}

/** The reading both phases share: properties, mount table, probes, privileges, analysis. */
async function confinement(evidence, context, adapter, { strict, expected }) {
  const label = strict ? "packaged" : "generated";
  await evidence.softStep(
    `The unit systemd runs has the properties of the ${label} unit`,
    () => {
      const properties = adapter.show(PROPERTIES);
      evidence.observe(`${label}_properties`, properties);
      expectProperties(properties, expected, `The ${label} unit`);
    },
  );

  run(
    "install",
    [
      "-d",
      "-o",
      context.account,
      "-g",
      context.account,
      "-m",
      "0700",
      PROBE_DIR,
    ],
    { elevated: true },
  );
  const service = serviceProcess(adapter, context);

  await evidence.softStep(
    "Probes run as the service account, without capabilities, in the service's mount namespace",
    () => {
      const identity = asService(
        service,
        'echo "uid=$(id -u) gid=$(id -g)"; grep -E "^CapEff:" /proc/self/status',
      ).stdout;
      evidence.observe(`${label}_probe_identity`, identity.trim());
      if (!identity.includes(`uid=${service.uid} gid=${service.gid}`))
        throw new Error(
          `The probe does not run as ${context.account} (${service.uid}:${service.gid}):\n${identity}`,
        );
      if (!/CapEff:\s+0+\s*$/m.test(identity))
        throw new Error(
          `The probe keeps capabilities, so it proves nothing about file permissions:\n${identity}`,
        );
    },
  );

  const table = expectations(context, strict);
  await evidence.softStep(
    `The service's mount table: /usr, /etc and /boot read-only, its own folders writable (${label})`,
    () => {
      const mounts = parseMountInfo(
        run("cat", [`/proc/${service.pid}/mountinfo`], {
          elevated: true,
          quiet: true,
        }).stdout,
      );
      const rows = table.mounts.map(({ path: file, readOnly }) => {
        const mount = mountFor(file, mounts);
        return {
          path: file,
          expected: readOnly ? "ro" : "rw",
          mount_point: mount?.mountPoint,
          options: mount?.options.join(","),
          root: mount?.root,
          ok: isReadOnly(mount) === readOnly,
        };
      });
      evidence.observe(`${label}_mounts`, rows);
      for (const row of rows)
        console.log(
          `  ${row.ok ? "ok  " : "FAIL"} ${row.path}: mount ${row.mount_point} (${row.options}), expected ${row.expected}`,
        );
      const wrong = rows.filter((row) => !row.ok);
      if (wrong.length)
        throw new Error(
          `The mount table of pid ${service.pid} differs from the unit:\n${wrong.map((row) => `  ${row.path}: ${row.expected} expected, ${row.options} on ${row.mount_point}`).join("\n")}\nFull table:\n${run("cat", [`/proc/${service.pid}/mountinfo`], { elevated: true, quiet: true }).stdout}`,
        );
    },
  );

  await evidence.softStep(
    `Writes as the service account: allowed where the unit allows them, refused with a read-only error elsewhere (${label})`,
    () => {
      const rows = table.writes.map(({ path: dir, writable, erofs }) => {
        const out = asService(service, TRY_WRITE, dir).stdout.trim();
        const wasWritable = out === "WRITABLE";
        const ok =
          wasWritable === writable &&
          (!erofs || wasWritable || /Read-only file system/.test(out));
        return {
          path: dir,
          expected: writable
            ? "writable"
            : erofs
              ? "Read-only file system"
              : "refused",
          observed: out,
          ok,
        };
      });
      evidence.observe(`${label}_writes`, rows);
      for (const row of rows)
        console.log(
          `  ${row.ok ? "ok  " : "FAIL"} ${row.path}: ${row.observed} (expected ${row.expected})`,
        );
      const wrong = rows.filter((row) => !row.ok);
      if (wrong.length)
        throw new Error(
          `Writes differ from the unit's promise:\n${wrong.map((row) => `  ${row.path}: expected ${row.expected}, got ${row.observed}`).join("\n")}`,
        );
    },
  );

  await evidence.softStep(
    `Home directories: ${strict ? "hidden from the service" : "visible and read-only"} (${label})`,
    () => {
      const home = path.dirname(os.homedir());
      const listing = asService(
        service,
        'ls -A "$1" | wc -l',
        home,
      ).stdout.trim();
      const probe = asService(service, TRY_WRITE, os.homedir()).stdout.trim();
      evidence.observe(`${label}_home`, {
        entries_visible: listing,
        write: probe,
      });
      if (strict) {
        if (listing !== "0")
          throw new Error(
            `${home} shows ${listing} entries to the service; ProtectHome=true should hide them.`,
          );
        if (asService(service, 'test -e "$1"', os.homedir()).code === 0)
          throw new Error(`${os.homedir()} exists for the service.`);
      } else {
        if (Number(listing) < 1)
          throw new Error(
            `${home} is empty for the service; ProtectHome=read-only should leave it readable.`,
          );
        if (probe === "WRITABLE")
          throw new Error(
            `${os.homedir()} is writable for the service; ProtectHome=read-only should refuse that.`,
          );
      }
    },
  );

  await evidence.softStep(
    `PrivateTmp: a file the service writes to /tmp is not on the host (${label})`,
    () => {
      const name = `vectory-private-tmp-${process.pid}`;
      const out = asService(
        service,
        'touch "/tmp/$1" && echo CREATED',
        name,
      ).stdout.trim();
      if (out !== "CREATED")
        throw new Error(`The service cannot write /tmp: ${out}`);
      if (fs.existsSync(path.join("/tmp", name)))
        throw new Error(
          `/tmp/${name} is on the host's /tmp: the service's /tmp is not private.`,
        );
    },
  );

  await evidence.softStep(
    `systemd's own analysis of the unit (${label})`,
    () => {
      const text = run(
        "systemd-analyze",
        ["security", "--no-pager", SYSTEMD_UNIT],
        { elevated: true, allowFailure: true },
      ).stdout;
      const exposure = parseExposure(text);
      if (!exposure)
        throw new Error(
          `systemd-analyze printed no overall exposure level:\n${text}`,
        );
      const checks = JSON.parse(
        run(
          "systemd-analyze",
          ["security", "--no-pager", "--json=short", SYSTEMD_UNIT],
          { elevated: true, quiet: true },
        ).stdout,
      );
      const set = Object.fromEntries(
        checks.map((check) => [check.json_field, check.set]),
      );
      evidence.observe(`${label}_exposure`, exposure);
      evidence.observe(
        `${label}_analysis`,
        checks.map(({ json_field, set: on, exposure: weight }) => ({
          json_field,
          set: on,
          exposure: weight,
        })),
      );
      console.log(
        `  Overall exposure level of ${label} unit: ${exposure.score} ${exposure.level}`,
      );
      const wanted = {
        UserOrDynamicUser: true,
        NoNewPrivileges: true,
        PrivateTmp: true,
        ProtectSystem: strict,
        ProtectHome: strict,
      };
      const wrong = Object.entries(wanted).filter(
        ([key, want]) => set[key] !== want,
      );
      if (wrong.length)
        throw new Error(
          `systemd's analysis disagrees with the unit:\n${wrong.map(([key, want]) => `  ${key}: ${want ? "in effect" : "not in effect"} expected, found ${set[key]}`).join("\n")}`,
        );
      return exposure;
    },
  );
}

async function generated(evidence) {
  const context = readContext();
  const { api } = await connect();
  const { adapter } = bind(context, api);
  await evidence.softStep(
    "The device's data directory is the one the documentation names",
    async () => {
      const row = (await api("/devices")).find(
        (d) => d.id === context.deviceId,
      );
      const runtime = (await api(`/devices/${context.deviceId}`)).host_runtime;
      evidence.observe("host_runtime", runtime);
      if (runtime?.data_dir !== "/var/lib/vector")
        throw new Error(
          `The agent chose ${runtime?.data_dir} (${runtime?.data_dir_source}), not /var/lib/vector, so the packaged unit's writable folder is not exercised. Device: ${JSON.stringify(row)}`,
        );
    },
  );
  await confinement(evidence, context, adapter, {
    strict: false,
    expected: {
      FragmentPath: GENERATED_UNIT,
      User: context.account,
      ProtectSystem: "full",
      ProtectHome: "read-only",
      NoNewPrivileges: "yes",
      PrivateTmp: "yes",
      KillMode: "mixed",
      TimeoutStopUSec: (value) => parseDuration(value) === 330,
      ReadWritePaths: (value) =>
        value.includes(context.stateDir) &&
        value.includes(path.dirname(context.managedConfig)),
    },
  });
  await evidence.softStep(
    "The unit setup registered takes precedence over the packaged unit in /usr/lib/systemd/system",
    () => {
      const text = adjustedPackagedUnit(context).text;
      const staged = path.join(
        os.tmpdir(),
        `vectory-packaged-${process.pid}.service`,
      );
      fs.writeFileSync(staged, text);
      try {
        run("install", ["-m", "0644", staged, PACKAGED_UNIT], {
          elevated: true,
        });
        run("systemctl", ["daemon-reload"], { elevated: true });
        const fragment = adapter.show(["FragmentPath"]).FragmentPath;
        if (fragment !== GENERATED_UNIT)
          throw new Error(
            `systemd uses ${fragment}, not ${GENERATED_UNIT}, although both exist.`,
          );
      } finally {
        run("rm", ["-f", PACKAGED_UNIT], { elevated: true });
        run("systemctl", ["daemon-reload"], { elevated: true });
        fs.rmSync(staged, { force: true });
      }
    },
  );
}

/** packaging/systemd/vectory.service with ExecStart pointing at the agent this job installed, and nothing else changed. */
function adjustedPackagedUnit(context) {
  const original = fs.readFileSync(
    path.join(root, "packaging", "systemd", "vectory.service"),
    "utf8",
  );
  const exec = `ExecStart=${context.agent} run --state-dir ${context.stateDir}`;
  const text = original.replace(/^ExecStart=.*$/m, exec);
  const before = original.split("\n");
  const after = text.split("\n");
  const changed = before
    .map((line, index) => [line, after[index]])
    .filter(([a, b]) => a !== b);
  if (before.length !== after.length || changed.length > 1)
    throw new Error(
      "Adjusting ExecStart changed more than one line of the packaged unit.",
    );
  return { text, changed };
}

async function packaged(evidence) {
  const context = readContext();
  const { api } = await connect();
  const { adapter, device, settled } = bind(context, api);

  await evidence.step(
    "The generated unit is gone, so the packaged one applies",
    () => {
      if (fs.existsSync(GENERATED_UNIT)) {
        console.log(
          "  The generated unit is still registered; removing it with service-uninstall, as an operator moving to the package would.",
        );
        run(context.agent, ["service-uninstall"], {
          elevated: true,
          timeoutMs: 400000,
        });
      }
      if (fs.existsSync(GENERATED_UNIT))
        throw new Error(`${GENERATED_UNIT} still exists.`);
    },
  );

  // What the server last verified on the device, before the unit changes.
  const row = await device();
  // (After the apply phase the device is unmanaged and keeps running it.)
  const lastGood = ["verified_applied", "unmanaged"].includes(row.apply_state)
    ? row.actual_sha256
    : null;
  if (!lastGood)
    throw new Error(
      `No pipeline runs on the device; run service.mjs apply first: ${JSON.stringify(row)}`,
    );

  await evidence.step(
    "Install packaging/systemd/vectory.service as the package does, with only ExecStart adjusted",
    () => {
      const { text, changed } = adjustedPackagedUnit(context);
      evidence.observe(
        "packaged_unit_difference",
        changed.map(([was, now]) => ({ packaged: was, installed: now })),
      );
      console.log(
        `  The only difference from the packaged unit:\n    - ${changed[0]?.[0]}\n    + ${changed[0]?.[1]}`,
      );
      const staged = path.join(
        os.tmpdir(),
        `vectory-packaged-${process.pid}.service`,
      );
      fs.writeFileSync(staged, text);
      try {
        run("install", ["-m", "0644", staged, PACKAGED_UNIT], {
          elevated: true,
        });
      } finally {
        fs.rmSync(staged, { force: true });
      }
      run("systemctl", ["daemon-reload"], { elevated: true });
      const properties = adapter.show([
        "FragmentPath",
        "UnitFileState",
        "ActiveState",
      ]);
      if (properties.FragmentPath !== PACKAGED_UNIT)
        throw new Error(
          `systemd loads ${properties.FragmentPath}, not ${PACKAGED_UNIT}.`,
        );
    },
  );

  await evidence.step(
    "Enable and start the unit; the enrolled device comes back with its last known good",
    async () => {
      const began = Date.now();
      run("systemctl", ["enable", "--now", SYSTEMD_UNIT], {
        elevated: true,
        timeoutMs: 120000,
      });
      await until("the service is running", () => adapter.state().running, {
        timeoutMs: 120000,
        describe: () => adapter.describe(),
      });
      await settled("under the packaged unit", began, { lastGood });
    },
  );

  await confinement(evidence, context, adapter, {
    strict: true,
    expected: {
      FragmentPath: PACKAGED_UNIT,
      User: context.account,
      ProtectSystem: "strict",
      ProtectHome: "yes",
      NoNewPrivileges: "yes",
      PrivateTmp: "yes",
      KillMode: "mixed",
      UMask: "0077",
      TimeoutStopUSec: (value) => parseDuration(value) === 330,
      ReadWritePaths: (value) =>
        [
          "/var/lib/vectory-agent",
          "/etc/vectory/managed",
          "/var/lib/vector",
        ].every((dir) => value.includes(dir)),
      ExecStart: (value) =>
        value.includes(
          `argv[]=${context.agent} run --state-dir ${context.stateDir}`,
        ),
    },
  });

  await evidence.softStep(
    "The packaged unit is no weaker than the generated one in systemd's analysis",
    () => {
      const here = evidence.observations.packaged_exposure;
      if (!here)
        throw new Error("The packaged unit's exposure was not recorded above.");
      let there = null;
      try {
        there = JSON.parse(
          fs.readFileSync(
            path.join(outputRoot, "sandbox-generated.json"),
            "utf8",
          ),
        ).observations?.generated_exposure;
      } catch {
        console.log(
          "  The generated unit's evidence is not here (run the generated phase first); only the packaged score is recorded.",
        );
      }
      evidence.observe("exposure_comparison", {
        generated: there ?? null,
        packaged: here,
      });
      if (there && here.score > there.score)
        throw new Error(
          `The packaged unit scores ${here.score} against ${there.score} for the generated one; higher is more exposed.`,
        );
    },
  );

  writeContext({ ...context, strictUnit: true });
}

const phases = { generated, packaged };
if (!phases[phase]) {
  console.error(
    `Usage: node tests/platform/linux-sandbox.mjs <${Object.keys(phases).join("|")}>`,
  );
  process.exit(2);
}
if (process.platform !== "linux") {
  console.error("The systemd units are checked on Linux.");
  process.exit(2);
}
await main(`sandbox-${phase}`, (evidence) => phases[phase](evidence));
