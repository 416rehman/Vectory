// node --test tests/platform/lib.test.mjs
// The parsers and the comparison the platform checks rely on, tested against
// the text each tool really prints, so a wrong guess shows up here and not on
// a runner that takes ten minutes to reach it.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyProcesses, expectProperties } from "./adapters.mjs";
import {
  Evidence,
  isReadOnly,
  mountFor,
  parseDuration,
  parseExposure,
  parseKeyValues,
  parseMountInfo,
  run,
  until,
} from "./lib.mjs";

test("systemctl show output becomes properties, keeping values that contain =", () => {
  const values = parseKeyValues(
    "ActiveState=active\nExecStart={ path=/usr/local/bin/vectory ; argv[]=/usr/local/bin/vectory run --state-dir /var/lib/vectory-agent ; }\nMainPID=812\n\n",
  );
  assert.equal(values.ActiveState, "active");
  assert.equal(values.MainPID, "812");
  assert.ok(
    values.ExecStart.includes(
      "argv[]=/usr/local/bin/vectory run --state-dir /var/lib/vectory-agent",
    ),
  );
});

test("systemd time spans in seconds", () => {
  assert.equal(parseDuration("5min 30s"), 330);
  assert.equal(parseDuration("330s"), 330);
  assert.equal(parseDuration("1h 2min 3s"), 3723);
  assert.equal(parseDuration("100ms"), 0.1);
  assert.equal(parseDuration("infinity"), Infinity);
  assert.ok(Number.isNaN(parseDuration("soon")));
});

const MOUNTINFO = `
36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue
50 1 254:0 / / rw,relatime shared:1 - ext4 /dev/vda rw,discard
76 50 254:0 /usr /usr ro,relatime - ext4 /dev/vda rw,discard
77 50 254:0 /etc /etc ro,relatime - ext4 /dev/vda rw,discard
78 77 254:0 /etc/vectory/managed /etc/vectory/managed rw,relatime - ext4 /dev/vda rw,discard
79 50 254:0 /systemd/inaccessible/dir /home ro,nosuid,nodev,noexec - tmpfs tmpfs rw,mode=755
80 50 0:45 /systemd-private-abc-vectory.service-xyz/tmp /tmp rw,relatime - tmpfs tmpfs rw
81 50 254:0 /a\\040b /srv/a\\040b ro,relatime - ext4 /dev/vda rw
82 76 254:0 /usr /usr rw,relatime - ext4 /dev/vda rw
`;

test("mount table: the longest mount point wins, and a later mount on the same point is on top", () => {
  const mounts = parseMountInfo(MOUNTINFO);
  assert.equal(mounts.length, 9);
  assert.equal(mountFor("/etc/passwd", mounts).mountPoint, "/etc");
  assert.equal(isReadOnly(mountFor("/etc/passwd", mounts)), true);
  assert.equal(
    mountFor("/etc/vectory/managed/vector.json", mounts).mountPoint,
    "/etc/vectory/managed",
  );
  assert.equal(isReadOnly(mountFor("/etc/vectory/managed", mounts)), false);
  assert.equal(isReadOnly(mountFor("/var/lib/vector", mounts)), false);
  assert.equal(mountFor("/var/lib/vector", mounts).mountPoint, "/");
  assert.equal(isReadOnly(mountFor("/home/runner", mounts)), true);
  assert.ok(mountFor("/tmp/x", mounts).root.includes("systemd-private"));
  // /usr appears twice; the second, writable mount is on top of the first.
  assert.equal(isReadOnly(mountFor("/usr/bin", mounts)), false);
  // A prefix is a path component, not a string prefix.
  assert.equal(mountFor("/etcetera", mounts).mountPoint, "/");
  // Octal escapes in the table are decoded.
  assert.equal(mountFor("/srv/a b/file", mounts).mountPoint, "/srv/a b");
});

test("the overall exposure line of systemd-analyze security", () => {
  assert.deepEqual(
    parseExposure(
      "→ Overall exposure level for vectory.service: 8.3 EXPOSED :-(",
    ),
    { score: 8.3, level: "EXPOSED" },
  );
  assert.equal(parseExposure("nothing here"), null);
});

test("a property check lists every difference and all properties", () => {
  const actual = {
    ActiveState: "active",
    User: "root",
    KillMode: "control-group",
  };
  assert.doesNotThrow(() =>
    expectProperties(
      actual,
      { ActiveState: "active", User: /^root$/, KillMode: (v) => v.length > 3 },
      "The unit",
    ),
  );
  assert.throws(
    () =>
      expectProperties(
        actual,
        { User: "vectory", KillMode: "mixed" },
        "The unit",
      ),
    (error) =>
      error.message.includes("User: expected vectory") &&
      error.message.includes(
        'KillMode: expected mixed, found "control-group"',
      ) &&
      error.message.includes("ActiveState=active"),
  );
});

test("until returns the first truthy value and explains a timeout", async () => {
  let calls = 0;
  assert.equal(
    await until("a value", () => (++calls === 3 ? "done" : null), {
      intervalMs: 5,
    }),
    "done",
  );
  await assert.rejects(
    until("never", () => false, {
      timeoutMs: 30,
      intervalMs: 5,
      describe: () => "state: stuck",
    }),
    /Timed out after .* waiting for: never\.\nLast observed:\n\s+state: stuck/,
  );
});

test("a soft step is recorded as failed and the phase goes on; a hard step stops it", async () => {
  const evidence = new Evidence("soft-step-test");
  const quiet = console.error;
  console.error = () => {};
  try {
    await evidence.softStep("independent reading", () => {
      throw new Error("not what the unit says");
    });
    await evidence.step("the next check", () => "ran");
    await assert.rejects(
      evidence.step("a dependent check", () => {
        throw new Error("stop here");
      }),
      /stop here/,
    );
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(evidence.failures, ["independent reading"]);
  assert.deepEqual(
    evidence.checks.map((check) => check.status),
    ["failed", "passed", "failed"],
  );
});

test("run reports the command and everything it printed when it fails", () => {
  assert.throws(
    () =>
      run(
        process.execPath,
        ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
        { quiet: true },
      ),
    (error) =>
      /exited 3/.test(error.message) &&
      error.message.includes("out") &&
      error.message.includes("err"),
  );
  const result = run(process.execPath, ["-e", "process.exit(4)"], {
    quiet: true,
    allowFailure: true,
  });
  assert.equal(result.code, 4);
  const piped = run(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { quiet: true, input: "secret-in-stdin" },
  );
  assert.equal(piped.stdout, "secret-in-stdin");
});

test("only the agent's own supervisors and Vector processes are counted", () => {
  const row = (pid, command) => ({ pid, ppid: 1, user: "x", command });
  const { vectors, supervisors } = classifyProcesses([
    row(
      1,
      "/usr/local/bin/vector --config-json /etc/vectory/managed/vector.json --log-format json --graceful-shutdown-limit-secs 60",
    ),
    row(
      2,
      '"C:\\Program Files\\Vector\\bin\\vector.exe" --config-json C:\\ProgramData\\Vectory\\managed\\vector.json --graceful-shutdown-limit-secs 60',
    ),
    row(
      3,
      "/opt/tools/vector-x86_64/bin/vector --config-json /tmp/validate.json",
    ),
    row(
      4,
      "vector validate --config-json /tmp/x.json --graceful-shutdown-limit-secs 5",
    ),
    row(
      5,
      "/bin/bash -c pgrep -f 'vector --config-json' --graceful-shutdown-limit-secs",
    ),
    row(
      6,
      "/home/r/native workflow x/bin/vectory __vector-host /usr/local/bin/vector /etc/x restricted",
    ),
    row(
      7,
      '"C:\\Program Files\\Vectory\\vectory.exe" __vector-host "C:\\Program Files\\Vector\\bin\\vector.exe" x restricted',
    ),
    row(8, "/bin/bash -c echo __vector-host"),
    row(9, "/usr/local/bin/vectory run --state-dir /var/lib/vectory-agent"),
  ]);
  assert.deepEqual(
    vectors.map((r) => r.pid),
    [1, 2],
  );
  assert.deepEqual(
    supervisors.map((r) => r.pid),
    [6, 7],
  );
});
