// The text sc.exe prints and the access lists PowerShell reads, as the Windows host
// of the agent-update checks (update-host-windows.mjs) takes them: parsed by
// functions that take text and return values, so that they are tested here, on every
// platform, before a Windows runner spends an hour on a check that misreads them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ACCOUNT,
  MASK,
  describeAcl,
  expectedLayout,
  parseFailureActions,
  parseFailureFlag,
  parseServiceConfig,
  parseServiceQuery,
  rootOnlyProblems,
  serviceRightsProblems,
  serviceSid,
  splitCommandLine,
  summarizeAcl,
} from "./update-host-windows.mjs";
import { root } from "./lib.mjs";

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("a service's SID is derived from its name the way the product derives it", () => {
  // The two the product's own tests know: the agent's and TrustedInstaller's.
  assert.equal(
    serviceSid("Vectory"),
    "S-1-5-80-706499921-4073424311-170640362-3342322694-3009795177",
  );
  assert.equal(
    serviceSid("TrustedInstaller"),
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
  );
  assert.equal(serviceSid("vectory"), serviceSid("VECTORY"));
});

test("the masks the checks expect are the ones the product writes", () => {
  const acl = read("agent/internal/agent/rootpath_acl.go");
  assert.match(acl, /const sddlReadAndRun = "0x1200a9"/);
  assert.equal(MASK.readAndRun, 0x1200a9);
  // FA is FILE_ALL_ACCESS, and FR is FILE_GENERIC_READ.
  assert.equal(MASK.full, 0x1f01ff);
  assert.equal(MASK.read, 0x120089);
  // The descriptor the product writes: the Administrators own it, the list is protected,
  // and SYSTEM and the Administrators have full control (the owner and these two entries
  // are what the checks read back).
  for (const text of ['"O:BAD:P(A;"', ";FA;;;SY)", ";FA;;;BA)", ';FR;;;"'])
    assert.ok(acl.includes(text), `rootpath_acl.go no longer says ${text}`);
});

const RUNNING = `
SERVICE_NAME: VectoryUpdate
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : 4321
        FLAGS              :
`;

test("sc queryex says whether a service exists, its state, its process and how it last ended", () => {
  assert.deepEqual(parseServiceQuery(RUNNING), {
    exists: true,
    state: "RUNNING",
    pid: 4321,
    exitCode: 0,
    serviceExitCode: 0,
  });
  const crashed = RUNNING.replace("4  RUNNING", "1  STOPPED")
    .replace(
      "WIN32_EXIT_CODE    : 0  (0x0)",
      "WIN32_EXIT_CODE    : 1067  (0x42b)",
    )
    .replace("PID                : 4321", "PID                : 0");
  assert.deepEqual(parseServiceQuery(crashed), {
    exists: true,
    state: "STOPPED",
    pid: 0,
    exitCode: 1067,
    serviceExitCode: 0,
  });
  const ownError = RUNNING.replace("4  RUNNING", "1  STOPPED")
    .replace(
      "WIN32_EXIT_CODE    : 0  (0x0)",
      "WIN32_EXIT_CODE    : 1066  (0x42a)",
    )
    .replace("SERVICE_EXIT_CODE  : 0  (0x0)", "SERVICE_EXIT_CODE  : 2  (0x2)");
  assert.equal(parseServiceQuery(ownError).serviceExitCode, 2);
  assert.deepEqual(
    parseServiceQuery(
      "[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.\n",
    ),
    {
      exists: false,
      state: "NOT_INSTALLED",
      pid: 0,
      exitCode: 0,
      serviceExitCode: 0,
    },
  );
  assert.equal(
    parseServiceQuery(
      "[SC] OpenService FAILED 1072:\n\nThe specified service has been marked for deletion.\n",
    ).state,
    "MARKED_FOR_DELETE",
  );
});

test("sc qc says how a service is registered", () => {
  const step = parseServiceConfig(`[SC] QueryServiceConfig SUCCESS

SERVICE_NAME: VectoryUpdate
        TYPE               : 10  WIN32_OWN_PROCESS
        START_TYPE         : 2   AUTO_START  (DELAYED)
        ERROR_CONTROL      : 1   NORMAL
        BINARY_PATH_NAME   : C:\\ProgramData\\Vectory\\update-state\\private\\helper\\vectory.exe update-helper --state-dir C:\\ProgramData\\Vectory\\agent
        LOAD_ORDER_GROUP   :
        TAG                : 0
        DISPLAY_NAME       : Vectory agent update step
        DEPENDENCIES       :
        SERVICE_START_NAME : LocalSystem
`);
  assert.equal(step.startType, "AUTO_START");
  assert.equal(step.delayed, true);
  assert.equal(step.account, "LocalSystem");
  assert.ok(step.type.includes("WIN32_OWN_PROCESS"));
  assert.deepEqual(splitCommandLine(step.binaryPath), [
    "C:\\ProgramData\\Vectory\\update-state\\private\\helper\\vectory.exe",
    "update-helper",
    "--state-dir",
    "C:\\ProgramData\\Vectory\\agent",
  ]);
  const manual = parseServiceConfig(
    "        START_TYPE         : 3   DEMAND_START\r\n",
  );
  assert.deepEqual([manual.startType, manual.delayed], ["DEMAND_START", false]);
});

test("sc qfailure says what the manager does when a service fails, and the flag says when an error is a failure", () => {
  const failure = parseFailureActions(`[SC] QueryServiceConfig2 SUCCESS

SERVICE_NAME: VectoryUpdate
        RESET_PERIOD (in seconds)    : 86400
        REBOOT_MESSAGE               :
        COMMAND_LINE                 :
        FAILURE_ACTIONS              : RESTART -- Delay = 5000 milliseconds.
                                       RESTART -- Delay = 30000 milliseconds.
                                       RESTART -- Delay = 60000 milliseconds.
`);
  assert.deepEqual(failure, {
    resetPeriod: 86400,
    actions: [
      { action: "RESTART", delayMs: 5000 },
      { action: "RESTART", delayMs: 30000 },
      { action: "RESTART", delayMs: 60000 },
    ],
  });
  assert.deepEqual(parseFailureActions("nothing"), {
    resetPeriod: null,
    actions: [],
  });
  assert.equal(
    parseFailureFlag(
      "SERVICE_NAME: VectoryUpdate\n        FAILURE_ACTIONS_ON_NONCRASH_FAILURES: TRUE\n",
    ),
    true,
  );
  assert.equal(
    parseFailureFlag("        FAILURE_ACTIONS_ON_NONCRASH_FAILURES: FALSE"),
    false,
  );
  assert.equal(parseFailureFlag("nothing"), null);
});

test("a command line is split the way Windows splits it", () => {
  assert.deepEqual(
    splitCommandLine(
      '"C:\\Program Files\\Vectory\\vectory.exe" service --state-dir C:\\ProgramData\\Vectory\\agent',
    ),
    [
      "C:\\Program Files\\Vectory\\vectory.exe",
      "service",
      "--state-dir",
      "C:\\ProgramData\\Vectory\\agent",
    ],
  );
  assert.deepEqual(splitCommandLine('a "b \\"c\\" d" e'), [
    "a",
    'b "c" d',
    "e",
  ]);
  assert.deepEqual(splitCommandLine('"C:\\x y\\\\" z'), ["C:\\x y\\", "z"]);
  assert.deepEqual(splitCommandLine("  a   b  "), ["a", "b"]);
  assert.deepEqual(splitCommandLine(""), []);
  assert.deepEqual(splitCommandLine('""'), [""]);
});

const rule = (identity, mask, extra = {}) => ({
  identity,
  type: "Allow",
  mask,
  inherited: false,
  inheritOnly: false,
  ...extra,
});

test("an access list is summarized by who has what, and what only passes on to children is left out", () => {
  const summary = summarizeAcl({
    owner: ACCOUNT.administrators,
    protected: true,
    rules: [
      rule(ACCOUNT.system, 0x1f01ff),
      rule(ACCOUNT.administrators, 0x1f01ff),
      rule(ACCOUNT.administrators, 0x1f01ff),
      rule(ACCOUNT.users, 0x1200a9, { inheritOnly: true }),
      rule(ACCOUNT.agentService, 0x120089),
      { ...rule(ACCOUNT.users, 0x2), type: "Deny" },
    ],
  });
  assert.deepEqual(summary, {
    owner: ACCOUNT.administrators,
    protected: true,
    access: [
      `NT AUTHORITY\\SYSTEM:1f01ff`,
      `BUILTIN\\Administrators:1f01ff`,
      `NT SERVICE\\Vectory:120089`,
      `deny BUILTIN\\Users:2`,
    ].sort(),
  });
});

test("an access list is described with its owner, each entry's mask in hexadecimal, what is inherited or only passes on, and the descriptor text", () => {
  assert.equal(
    describeAcl("C:\\ProgramData", {
      owner: ACCOUNT.system,
      protected: false,
      sddl: "O:SYG:SYD:PAI(A;OICI;FA;;;SY)",
      rules: [
        rule(ACCOUNT.system, 0x1f01ff),
        rule(ACCOUNT.users, 0x116, { inherited: true }),
        rule(ACCOUNT.creatorOwner, 0x10000000, { inheritOnly: true }),
        { ...rule(ACCOUNT.users, 0x2), type: "Deny" },
        // A generic right is read as a negative number when its top bit is set.
        rule(ACCOUNT.users, -2147483648, {
          inherited: true,
          inheritOnly: true,
        }),
      ],
    }),
    [
      "C:\\ProgramData",
      "  owner NT AUTHORITY\\SYSTEM",
      "  allow NT AUTHORITY\\SYSTEM 0x1f01ff",
      "  allow BUILTIN\\Users 0x116 (inherited)",
      "  allow CREATOR OWNER 0x10000000 (inherit only)",
      "  deny BUILTIN\\Users 0x2",
      "  allow BUILTIN\\Users 0x80000000 (inherit only, inherited)",
      "  O:SYG:SYD:PAI(A;OICI;FA;;;SY)",
    ].join("\n"),
  );
  // Without the descriptor text, and with the list protected, there is no such line.
  assert.equal(
    describeAcl("C:\\x", {
      owner: ACCOUNT.administrators,
      protected: true,
      rules: [],
    }),
    "C:\\x\n  owner BUILTIN\\Administrators, protected",
  );
});

test("a path is root's alone to change unless another account owns it or may write, delete or take it over", () => {
  const trustedInstaller = [
    rule(ACCOUNT.trustedInstaller, 0x1f01ff),
    rule(ACCOUNT.system, 0x1f01ff),
    rule(ACCOUNT.administrators, 0x1f01ff),
    rule(ACCOUNT.users, 0x1200a9),
    rule(ACCOUNT.creatorOwner, 0x10000000, { inheritOnly: true }),
    rule("APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES", 0x1200a9),
  ];
  assert.deepEqual(
    rootOnlyProblems({
      owner: ACCOUNT.administrators,
      rules: trustedInstaller,
    }),
    [],
  );
  assert.deepEqual(
    rootOnlyProblems({
      owner: ACCOUNT.trustedInstaller,
      rules: trustedInstaller,
    }),
    [],
  );
  assert.match(
    rootOnlyProblems({ owner: "WIN\\runner", rules: trustedInstaller })[0],
    /belongs to WIN\\runner/,
  );
  for (const [what, mask] of Object.entries({
    write: 0x2,
    append: 0x4,
    "write attributes": 0x100,
    delete: 0x10000,
    "delete a child": 0x40,
    "change the access list": 0x40000,
    "take ownership": 0x80000,
    "modify (a Users default of ProgramData)": 0x1301bf,
  }))
    assert.equal(
      rootOnlyProblems({
        owner: ACCOUNT.administrators,
        rules: [...trustedInstaller, rule(ACCOUNT.users, mask)],
      }).length,
      1,
      `Users may ${what}`,
    );
  // An entry for what is made in the directory later, and a refusal, change nothing.
  assert.deepEqual(
    rootOnlyProblems({
      owner: ACCOUNT.administrators,
      rules: [
        ...trustedInstaller,
        rule(ACCOUNT.users, 0x1301bf, { inheritOnly: true }),
        { ...rule(ACCOUNT.users, 0x1301bf), type: "Deny" },
      ],
    }),
    [],
  );
});

test("what the checks expect of the step's files is what the product's access lists say", () => {
  const paths = {
    updateRoot: "C:\\ProgramData\\Vectory",
    policyDir: "C:\\ProgramData\\Vectory\\updates",
    stepDir: "C:\\ProgramData\\Vectory\\update-state",
    probe: "C:\\ProgramData\\Vectory\\update-state\\probe",
    private: "C:\\ProgramData\\Vectory\\update-state\\private",
    status: "C:\\ProgramData\\Vectory\\update-state\\status.json",
    policy: "C:\\ProgramData\\Vectory\\updates\\policy.json",
    helper:
      "C:\\ProgramData\\Vectory\\update-state\\private\\helper\\vectory.exe",
  };
  const layout = expectedLayout(paths);
  assert.deepEqual(Object.keys(layout), Object.values(paths));
  for (const entry of Object.values(layout)) {
    assert.equal(entry.owner, ACCOUNT.administrators);
    assert.equal(entry.protected, true);
  }
  const closed = [
    `NT AUTHORITY\\SYSTEM:1f01ff`,
    `BUILTIN\\Administrators:1f01ff`,
  ];
  // Private: SYSTEM and the Administrators, and nobody else, the agent's account included.
  assert.deepEqual(layout[paths.private].access, [...closed].sort());
  // What the agent reads: its virtual account may read the step's directory and files.
  for (const readable of [
    paths.stepDir,
    paths.probe,
    paths.policyDir,
    paths.status,
    paths.policy,
  ])
    assert.deepEqual(
      layout[readable].access,
      [...closed, "NT SERVICE\\Vectory:120089"].sort(),
    );
  // The directory they are made in: the account may list and read it, and what it is given doesn't pass on.
  assert.deepEqual(
    layout[paths.updateRoot].access,
    [...closed, "NT SERVICE\\Vectory:1200a9"].sort(),
  );
  // The helper copy runs as SYSTEM: the Users and the agent's account read and run it, nothing more.
  assert.deepEqual(
    layout[paths.helper].access,
    [
      ...closed,
      "NT SERVICE\\TrustedInstaller:1f01ff",
      "BUILTIN\\Users:1200a9",
      "NT SERVICE\\Vectory:1200a9",
    ].sort(),
  );
  // None of them lets another account change a file: the check the product makes of the
  // directories it uses (rootOnlyProblems), run on what is expected.
  for (const entry of Object.values(layout)) {
    const rules = entry.access.map((line) => {
      const at = line.lastIndexOf(":");
      return rule(line.slice(0, at), Number.parseInt(line.slice(at + 1), 16));
    });
    assert.deepEqual(rootOnlyProblems({ owner: entry.owner, rules }), []);
  }
});

// What the system gives a service an administrator creates: SYSTEM and the
// Administrators may do anything, interactive users and service logons may read it,
// and Everyone is audited.
const DEFAULT_SERVICE_DESCRIPTOR =
  "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)";

test("the descriptor the system gives a service is not too much", () => {
  const agent = serviceSid("Vectory");
  assert.deepEqual(
    serviceRightsProblems(DEFAULT_SERVICE_DESCRIPTOR, agent),
    [],
  );
  // Authenticated users may read it too; the audit entry for Everyone is not a right.
  assert.deepEqual(
    serviceRightsProblems(
      DEFAULT_SERVICE_DESCRIPTOR.replace("S:", "(A;;CCLCSWLOCRRC;;;AU)S:"),
      agent,
    ),
    [],
  );
});

test("an entry for the agent's service, or a right to start, stop or change the service for anyone but root, is too much", () => {
  const agent = serviceSid("Vectory");
  const plus = (entry) =>
    DEFAULT_SERVICE_DESCRIPTOR.replace("S:", `${entry}S:`);
  const withAgent = plus(`(A;;CCLCSWLOCRRC;;;${agent})`);
  assert.equal(serviceRightsProblems(withAgent, agent).length, 1);
  assert.match(
    serviceRightsProblems(withAgent, agent)[0],
    /the agent's service, has an entry/,
  );
  for (const rights of ["RP", "WP", "DT", "DC", "SD", "WD", "WO", "GA", "GR"])
    assert.equal(
      serviceRightsProblems(plus(`(A;;CCLC${rights};;;WD)`), agent).length,
      1,
      `Everyone may ${rights}`,
    );
  // A mask in hexadecimal is not a list of rights this reads.
  assert.equal(
    serviceRightsProblems(plus("(A;;0xf01ff;;;BU)"), agent).length,
    1,
  );
  // A refusal grants nothing.
  assert.deepEqual(
    serviceRightsProblems(plus("(D;;CCLCSWRPWPDTLOCRRC;;;WD)"), agent),
    [],
  );
});
