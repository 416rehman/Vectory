import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { APIError, type DeviceValidation } from "./api";
import DeviceCheck, { DeviceCheckResults } from "./DeviceCheck";
import {
  POLL_BACKOFF_MS,
  POLL_MS,
  bindCommands,
  checkBody,
  checkKind,
  checkLook,
  explainCheckError,
  hostHint,
  isRunning,
  isUnanswered,
  leadFinding,
  mergeRuns,
  nextPollDelay,
  retryBody,
  reviewIdentity,
  runsToRead,
  secretLine,
  summarize,
  testsLine,
  throttleMessage,
  tookText,
  truncationNote,
  waitText,
  type Run,
} from "./deviceCheckModel";

type Row = DeviceValidation["devices"][number];

const row = (
  name: string,
  state: Row["state"],
  extra: Partial<Row> = {},
): Row => ({
  id: `id-${name}`,
  name,
  state,
  diagnostics: [],
  tests: [],
  secrets_missing: [],
  updated_at: "2026-10-02T12:00:00Z",
  ...extra,
});
const finding = (message: string, extra = {}) => ({
  severity: "error" as const,
  code: "VECTOR_VALIDATION",
  message,
  ...extra,
});
const validation = (
  devices: Row[],
  extra: Partial<DeviceValidation> = {},
): DeviceValidation => ({
  id: "check-1",
  state: devices.some((item) => item.state === "pending")
    ? "running"
    : "complete",
  created_at: "2026-10-02T12:00:00Z",
  expires_at: "2026-10-02T12:10:00Z",
  truncated: false,
  run_tests: false,
  devices,
  ...extra,
});
const run = (
  detail: DeviceValidation | null,
  extra: Partial<Run> = {},
): Run => ({
  id: detail?.id ?? "check-1",
  identity: "same",
  requestedAt: 0,
  scope: null,
  detail,
  ...extra,
});

describe("what a row comes to", () => {
  it("reads a failure that names a missing secret as a secret, any other as a fix", () => {
    expect(
      checkKind(row("a", "failed", { secrets_missing: ["API_KEY"] })),
    ).toBe("needs_secret");
    expect(checkKind(row("a", "failed"))).toBe("needs_fix");
    for (const state of [
      "pending",
      "passed",
      "offline",
      "expired",
      "unsupported",
    ] as const)
      expect(checkKind(row("a", state))).toBe(state);
  });

  it("words each state as the review shows it", () => {
    expect(
      Object.fromEntries(
        Object.entries(checkLook).map(([kind, look]) => [kind, look.label]),
      ),
    ).toEqual({
      pending: "Checking…",
      passed: "Passes here",
      needs_fix: "Needs a fix",
      needs_secret: "Needs a secret",
      offline: "Offline: not checked",
      expired: "No answer in time",
      unsupported: "Older agent: can't check",
    });
  });

  it("groups what nothing came back for: offline and expired, not an older agent", () => {
    expect(isUnanswered("offline")).toBe(true);
    expect(isUnanswered("expired")).toBe(true);
    expect(isUnanswered("unsupported")).toBe(false);
    expect(isUnanswered("needs_fix")).toBe(false);
  });

  it("says the secret as a sentence", () => {
    expect(secretLine("API_KEY")).toBe(
      "Secret API_KEY isn't bound on this device",
    );
  });
});

describe("the summary line", () => {
  it("counts what answered and says what didn't", () => {
    const rows = [
      row("a", "passed"),
      row("b", "passed"),
      row("c", "failed", { secrets_missing: ["API_KEY"] }),
      row("d", "offline"),
    ];
    const summary = summarize(rows);
    expect(summary.text).toBe(
      "Checked 3 of 4 devices: 2 pass, 1 needs a secret, 1 offline.",
    );
    expect(summary.answered).toBe(3);
    expect(summary.running).toBe(false);
  });

  it("is true while devices are still checking", () => {
    const summary = summarize([
      row("a", "passed"),
      row("b", "pending"),
      row("c", "pending"),
    ]);
    expect(summary.text).toBe(
      "Checked 1 of 3 devices so far: 1 passes, 2 still checking.",
    );
    expect(summary.running).toBe(true);
    expect(summarize([row("a", "pending")]).text).toBe(
      "Checked 0 of 1 device so far: 1 still checking.",
    );
  });

  it("agrees with the count for every kind", () => {
    const rows = [
      row("a", "failed"),
      row("b", "failed"),
      row("c", "failed", { secrets_missing: ["X"] }),
      row("d", "failed", { secrets_missing: ["X"] }),
      row("e", "expired"),
      row("f", "expired"),
      row("g", "unsupported"),
      row("h", "unsupported"),
      row("i", "offline"),
    ];
    expect(summarize(rows).text).toBe(
      "Checked 4 of 9 devices: 2 need a secret, 2 need a fix, 1 offline, 2 didn't answer, 2 have an older agent.",
    );
    expect(summarize([row("a", "expired"), row("b", "unsupported")]).text).toBe(
      "Checked 0 of 2 devices: 1 didn't answer, 1 has an older agent.",
    );
    expect(summarize([]).text).toBe("No device was asked.");
  });

  it("says what a cut list covered and left out", () => {
    expect(truncationNote(50, 57)).toBe(
      "Checked the first 50 devices by name. The other 7 weren't checked.",
    );
    expect(truncationNote(50, 51)).toBe(
      "Checked the first 50 devices by name. The other 1 wasn't checked.",
    );
    expect(truncationNote(17, 17)).toBe(
      "Checked the first 17 devices by name.",
    );
  });
});

describe("what a check belongs to", () => {
  const devices = [{ id: "a" }, { id: "b" }];
  const artifacts = [
    { device_id: "a", sha256: "1".repeat(64) },
    { device_id: "b", sha256: "2".repeat(64) },
  ];
  const base = reviewIdentity({ version_id: "v1" }, devices, artifacts);

  it("ignores order and what doesn't change a candidate", () => {
    expect(
      reviewIdentity(
        { version_id: "v1" },
        [...devices].reverse(),
        [...artifacts].reverse(),
      ),
    ).toBe(base);
  });

  it("changes with the version, a device or a device's candidate", () => {
    expect(reviewIdentity({ version_id: "v2" }, devices, artifacts)).not.toBe(
      base,
    );
    expect(
      reviewIdentity(
        { version_id: "v1" },
        [...devices, { id: "c" }],
        artifacts,
      ),
    ).not.toBe(base);
    expect(
      reviewIdentity({ version_id: "v1" }, devices.slice(0, 1), artifacts),
    ).not.toBe(base);
    expect(
      reviewIdentity({ version_id: "v1" }, devices, [
        artifacts[0],
        { device_id: "b", sha256: "3".repeat(64) },
      ]),
    ).not.toBe(base);
  });
});

describe("the request", () => {
  const request = {
    version_id: "v1",
    selector: {
      device_ids: ["a", "b", "c"],
      group_ids: ["g"],
      exclude_ids: [],
    },
    variable_bindings: {
      defaults: { region: "eu" },
      devices: { a: { region: "us" }, b: { region: "ap" } },
    },
    replaces: ["assignment-1"],
    priority: 150,
    target_mode: "persistent",
    scheduled_at: "2027-01-01T00:00:00.000Z",
    rollout: {
      kind: "canary",
      canary_size: 2,
      batch_size: 5,
      observation_seconds: 30,
      failure_threshold: 1,
      canary_device_ids: ["a"],
    },
  };

  it("asks for the whole review exactly as it was sent", () => {
    expect(checkBody(request, true)).toEqual({
      ...request,
      device_validation: true,
      run_tests: true,
    });
    expect(request).not.toHaveProperty("device_validation");
  });

  it("asks again for some devices with only what decides their candidate", () => {
    const body = retryBody(request, ["b", "b", "c"], false);
    expect(body).toEqual({
      version_id: "v1",
      selector: { device_ids: ["b", "c"], group_ids: [], exclude_ids: [] },
      variable_bindings: {
        defaults: { region: "eu" },
        devices: { b: { region: "ap" } },
      },
      priority: 150,
      target_mode: "snapshot",
      scheduled_at: null,
      rollout: {
        kind: "all",
        canary_size: 1,
        batch_size: 10,
        observation_seconds: 60,
        failure_threshold: 0,
      },
      device_validation: true,
      run_tests: false,
    });
  });

  it("leaves out values for a version that declares none", () => {
    const { variable_bindings: _values, ...plain } = request;
    expect(retryBody(plain, ["a"], false)).not.toHaveProperty(
      "variable_bindings",
    );
  });
});

describe("runs", () => {
  const first = run(
    validation([
      row("edge-1", "passed"),
      row("edge-2", "offline"),
      row("edge-3", "failed"),
    ]),
  );

  it("shows the newest answer for each device, in name order", () => {
    const again = run(
      validation([row("edge-2", "passed")], { id: "check-2" }),
      {
        scope: ["id-edge-2"],
      },
    );
    expect(
      mergeRuns([first, again]).map((item) => [item.name, item.state]),
    ).toEqual([
      ["edge-1", "passed"],
      ["edge-2", "passed"],
      ["edge-3", "failed"],
    ]);
  });

  it("shows a device that was asked again as checking until it answers", () => {
    const asked = run(null, { id: "check-2", scope: ["id-edge-2"] });
    const rows = mergeRuns([first, asked]);
    expect(rows.map((item) => item.state)).toEqual([
      "passed",
      "pending",
      "failed",
    ]);
    expect(rows[1]).toMatchObject({ name: "edge-2", diagnostics: [] });
    expect(isRunning([first, asked])).toBe(true);
    expect(runsToRead([first, asked]).map((item) => item.id)).toEqual([
      "check-2",
    ]);
  });

  it("has nothing to show before the first read, and is running until it is complete", () => {
    expect(mergeRuns([run(null)])).toEqual([]);
    expect(isRunning([run(null)])).toBe(true);
    expect(isRunning([first])).toBe(false);
    expect(isRunning([run(validation([row("a", "pending")]))])).toBe(true);
  });
});

describe("one device's row", () => {
  it("leads with the first error, else the first finding", () => {
    const warning = { ...finding("Careful"), severity: "warning" as const };
    expect(
      leadFinding({ diagnostics: [warning, finding("Broken")] })?.message,
    ).toBe("Broken");
    expect(leadFinding({ diagnostics: [warning] })?.message).toBe("Careful");
    expect(leadFinding({ diagnostics: [] })).toBeUndefined();
  });

  it("counts tests that passed, failed and didn't run", () => {
    expect(testsLine([])).toBeNull();
    expect(testsLine([{ name: "a", passed: true }])).toBe("1 of 1 test passes");
    expect(
      testsLine([
        { name: "a", passed: true },
        { name: "b", passed: true },
        { name: "c", passed: false, message: "Failed." },
        { name: "d", passed: false, not_run: true },
      ]),
    ).toBe("2 of 4 tests pass, 1 fails, 1 didn't run");
    expect(
      testsLine([
        { name: "a", passed: true },
        { name: "b", passed: true },
        { name: "c", passed: true },
      ]),
    ).toBe("3 of 3 tests pass");
  });

  it("says how long it took", () => {
    expect(tookText(undefined)).toBeNull();
    expect(tookText(850)).toBe("850 ms");
    expect(tookText(1400)).toBe("1.4 s");
  });
});

describe("when something goes wrong", () => {
  const failure = (
    status: number,
    code: string,
    message = "Server words.",
    retryAfter?: number,
    serverRejection = true,
  ) => new APIError(code, message, status, serverRejection, retryAfter);

  it("tells a role that can't ask or read, without blaming the check", () => {
    expect(explainCheckError(failure(403, "FORBIDDEN"), "start")).toMatchObject(
      {
        kind: "role",
        message:
          "Your role can't run a check. Ask an operator or administrator.",
      },
    );
    expect(explainCheckError(failure(403, "FORBIDDEN"), "read")).toMatchObject({
      kind: "role",
      message: "Your role can't read these results.",
    });
  });

  it("waits out a 429 for as long as Retry-After says", () => {
    expect(
      explainCheckError(failure(429, "RATE_LIMITED", "Slow down", 42), "start"),
    ).toMatchObject({
      kind: "throttled",
      retryAfter: 42,
      message: "Checks are limited to a few a minute. Try again in 42 s.",
    });
    expect(
      explainCheckError(failure(429, "CAPACITY_BUSY", "Busy", 60), "start")
        .message,
    ).toBe(
      "Too many checks are waiting for devices to answer. Try again in 1 min.",
    );
    expect(
      explainCheckError(failure(429, "RATE_LIMITED"), "start").message,
    ).toBe("Checks are limited to a few a minute. Try again shortly.");
    expect(
      explainCheckError(failure(429, "RATE_LIMITED", "x", 20), "read").message,
    ).toBe("Too many requests just now. The results load again in 20 s.");
    expect(throttleMessage("start", "RATE_LIMITED", 5)).toBe(
      "Checks are limited to a few a minute. Try again in 5 s.",
    );
  });

  it("says results that are gone are gone, never as current", () => {
    expect(explainCheckError(failure(404, "NOT_FOUND"), "read")).toMatchObject({
      kind: "gone",
      message:
        "These results are no longer available. Check again for current ones.",
    });
  });

  it("is honest that a lost connection may or may not have started a check", () => {
    const network = failure(
      0,
      "NETWORK_UNAVAILABLE",
      "Vectory didn't answer.",
      undefined,
      false,
    );
    expect(explainCheckError(network, "start")).toMatchObject({
      kind: "network",
      message:
        "Vectory didn't answer, so the check may not have started. Try again.",
    });
    expect(explainCheckError(network, "read").message).toBe(
      "Can't reach Vectory. Trying again…",
    );
    expect(
      explainCheckError(
        failure(0, "REQUEST_TIMEOUT", "Slow", undefined, false),
        "start",
      ).kind,
    ).toBe("network");
  });

  it("passes on what the server explained, and ends the session quietly", () => {
    expect(
      explainCheckError(
        failure(409, "CONFLICT", "The reviewed devices changed. Review again."),
        "start",
      ),
    ).toMatchObject({
      kind: "refused",
      message: "The reviewed devices changed. Review again.",
    });
    expect(
      explainCheckError(
        new APIError("SESSION_ENDED", "Your session ended.", 0),
        "read",
      ),
    ).toMatchObject({ kind: "session", message: "Your session ended." });
    expect(explainCheckError(new Error("boom"), "start").kind).toBe("failed");
    expect(
      explainCheckError(
        failure(500, "INTERNAL", "Oops.", undefined, false),
        "read",
      ).message,
    ).toBe("Couldn't read the check's results. Oops.");
  });

  it("formats a wait", () => {
    expect(waitText(0.2)).toBe("1 s");
    expect(waitText(42)).toBe("42 s");
    expect(waitText(60)).toBe("1 min");
    expect(waitText(61)).toBe("2 min");
  });

  it("reads every two seconds, backs off while reads fail and honours a 429", () => {
    expect(nextPollDelay(0)).toBe(POLL_MS);
    expect(nextPollDelay(1)).toBe(4000);
    expect(nextPollDelay(2)).toBe(8000);
    expect(nextPollDelay(9)).toBe(POLL_BACKOFF_MS);
    expect(nextPollDelay(3, 30)).toBe(30000);
    expect(nextPollDelay(0, 1)).toBe(POLL_MS);
  });
});

describe("the results", () => {
  const known = new Map([
    [
      "id-edge-secret",
      {
        id: "id-edge-secret",
        name: "edge-secret",
        os: "linux",
        secret_names: ["DD_API_KEY"],
      },
    ],
    [
      "id-win-secret",
      { id: "id-win-secret", name: "win-secret", os: "windows" },
    ],
    [
      "id-edge-offline",
      {
        id: "id-edge-offline",
        name: "edge-offline",
        os: "linux",
        last_seen: new Date(Date.now() - 3 * 3600_000).toISOString(),
      },
    ],
  ]);
  const rows: Row[] = [
    row("edge-ok", "passed", {
      valid: true,
      duration_ms: 1400,
      tests: [{ name: "adds a field", passed: true }],
    }),
    row("edge-fix", "failed", {
      valid: false,
      diagnostics: [
        finding("Sink out can't reach 10.0.0.9:9", {
          component_kind: "sink",
          component_id: "out",
          field: "endpoint",
          hint: "Allow the address on this host.",
        }),
        finding("Second finding"),
        { ...finding("A warning"), severity: "warning" as const },
      ],
      tests: [
        { name: "adds a field", passed: false, message: "Condition failed." },
        { name: "drops noise", passed: false, not_run: true },
      ],
    }),
    row("edge-secret", "failed", {
      valid: false,
      secrets_missing: ["API_KEY", "TLS_KEY"],
      diagnostics: [
        finding('This device has no file bound to secret "API_KEY".'),
      ],
    }),
    row("win-secret", "failed", { secrets_missing: ["API_KEY"] }),
    row("edge-offline", "offline"),
    row("edge-late", "expired"),
    row("edge-old", "unsupported"),
    row("edge-wait", "pending"),
  ];
  const render = (layout: "table" | "cards", blocked = false) =>
    renderToStaticMarkup(
      createElement(DeviceCheckResults, {
        rows,
        devices: known,
        layout,
        blocked,
        onRetry: () => {},
      }),
    );

  for (const layout of ["table", "cards"] as const)
    describe(layout, () => {
      const html = render(layout);

      it("says every state in the product's words", () => {
        for (const label of [
          "Passes here",
          "Needs a fix",
          "Needs a secret",
          "Offline: not checked",
          "No answer in time",
          "Older agent: can&#x27;t check",
          "Checking…",
        ])
          expect(html).toContain(label);
      });

      it("leads a failure with the component, field, message and fix, and opens to the rest", () => {
        expect(html).toContain("Sink out can&#x27;t reach 10.0.0.9:9");
        expect(html).toContain("<code>out</code>");
        expect(html).toContain("<code>endpoint</code>");
        expect(html).toContain("Allow the address on this host.");
        expect(html).toContain(
          "2 more findings · 0 of 2 tests pass, 1 fails, 1 didn&#x27;t run",
        );
        expect(html).toContain("Second finding");
        expect(html).toContain("Condition failed.");
        expect(html).toContain("Didn&#x27;t run");
      });

      it("names each unbound secret and gives the exact commands with a copy button", () => {
        expect(html).toContain("<code>API_KEY</code>");
        expect(html).toContain("<code>TLS_KEY</code>");
        expect(html).toContain("isn&#x27;t bound on this device.");
        expect(html).toContain(
          "Bind them on the host, with the agent stopped:",
        );
        expect(html).toContain("Bind it on the host, with the agent stopped:");
        expect(html).toContain(
          "sudo vectory configure-secrets --secret-files /etc/vectory/secret-bindings.json",
        );
        // Windows hosts get theirs for PowerShell, with the full path, never sudo.
        expect(html).toContain(
          "configure-secrets --secret-files &#x27;C:\\ProgramData\\Vectory\\secret-bindings.json&#x27;",
        );
        expect(html).toContain("# In an elevated PowerShell:");
        expect(html).toContain("Copy the commands for edge-secret");
        expect(html).toContain("Copy the commands for win-secret");
        // The bindings file keeps what the host already has bound.
        expect(html).toContain("DD_API_KEY");
        expect(html).toContain("This file replaces the host&#x27;s bindings");
      });

      it("explains the others and says what to do", () => {
        expect(html).toContain("Validation found no error on this host.");
        expect(html).toContain("1 of 1 test passes · Took 1.4 s");
        expect(html).toContain(
          "It hasn&#x27;t checked in recently, so it wasn&#x27;t asked.",
        );
        expect(html).toContain("Last seen 3h ago.");
        expect(html).toContain(
          "It didn&#x27;t answer in time. A check lasts 10 minutes, and a newer check for the same device replaces it.",
        );
        expect(html).toContain("Upgrade agent");
        expect(html).toContain("#/devices/id-edge-old");
        expect(html).toContain("Waiting for the device to answer.");
      });

      it("offers to ask again only where something can still change", () => {
        expect(html).toContain("Check edge-fix again");
        expect(html).toContain("Check edge-secret again");
        expect(html).toContain("Retry edge-offline");
        expect(html).toContain("Retry edge-late");
        expect(html).toContain("Retry edge-old");
        expect(html).not.toContain("Retry edge-ok");
        expect(html).not.toContain("Check edge-ok again");
        expect(html).not.toContain("Retry edge-wait");
      });

      it("never prints a secret value", () => {
        expect(html).not.toMatch(/password|token=|BEGIN [A-Z ]+KEY/i);
      });
    });

  it("is a table with named columns from 768 px and cards below", () => {
    const table = render("table");
    expect(table).toContain("<table");
    expect(table).toContain('aria-label="Check results by device"');
    for (const heading of ["Device", "Result", "What it found"])
      expect(table).toContain(`>${heading}</th>`);
    expect(table).not.toContain("device-check-card");
    const cards = render("cards");
    expect(cards).not.toContain("<table");
    expect(cards).toContain("device-check-card");
  });

  it("keeps the asking buttons focusable but inert while a request is out", () => {
    expect(render("table", true)).toContain('aria-disabled="true"');
    expect(render("table", false)).not.toContain('aria-disabled="true"');
  });
});

describe("commands made for the host", () => {
  const file = "/etc/vectory/secret-bindings.json";
  const linux = { os: "linux", secret_names: ["DD_API_KEY"] };
  const winExe = "& 'C:\\Program Files\\Vectory\\vectory.exe'";
  const winFile = "'C:\\ProgramData\\Vectory\\secret-bindings.json'";

  it("are the three usual lines on a host with a service and the default state directory", () => {
    for (const service_manager of ["systemd", "launchd"] as const)
      expect(
        bindCommands(["API_KEY"], {
          ...linux,
          service_manager,
          state_dir: "/var/lib/vectory-agent",
        }).commands,
      ).toBe(
        [
          "sudo vectory service-stop",
          `sudo vectory configure-secrets --secret-files ${file}`,
          "sudo vectory service-start",
        ].join("\n"),
      );
    // The bindings file still lists what the host already has bound.
    expect(JSON.parse(bindCommands(["API_KEY"], linux).bindings)).toEqual({
      API_KEY: "/etc/vectory/secrets/API_KEY",
      DD_API_KEY: "/etc/vectory/secrets/DD_API_KEY",
    });
  });

  it("name a state directory that isn't the default, and stop and start the agent the way it runs", () => {
    expect(
      bindCommands(["API_KEY"], {
        ...linux,
        state_dir: "/srv/vectory state",
        service_manager: "none",
      }).commands,
    ).toBe(
      [
        "# First stop the agent: Ctrl-C where `vectory run` runs (`vectory status` shows its pid).",
        "sudo vectory configure-secrets \\",
        "  --state-dir '/srv/vectory state' \\",
        `  --secret-files ${file}`,
        "# Then start the agent again the way you started it.",
      ].join("\n"),
    );
    expect(
      bindCommands(["API_KEY"], {
        ...linux,
        state_dir: "/srv/vectory",
        service_manager: "systemd",
      }).commands,
    ).toBe(
      [
        "sudo vectory service-stop",
        "sudo vectory configure-secrets \\",
        "  --state-dir /srv/vectory \\",
        `  --secret-files ${file}`,
        "sudo vectory service-start",
      ].join("\n"),
    );
  });

  it("say what an agent that doesn't report how it runs leaves open", () => {
    expect(bindCommands(["API_KEY"], linux).commands).toBe(
      [
        "# Without a service (`vectory run`), stop it with Ctrl-C instead, and start it again yourself.",
        "sudo vectory service-stop",
        `sudo vectory configure-secrets --secret-files ${file}`,
        "sudo vectory service-start",
      ].join("\n"),
    );
  });

  it("are for PowerShell on Windows, with the state directory when it isn't the default", () => {
    const win = { os: "windows", secret_names: [] };
    expect(
      bindCommands(["API_KEY"], {
        ...win,
        service_manager: "windows",
        state_dir: "C:\\ProgramData\\Vectory\\agent",
      }).commands,
    ).toBe(
      [
        "# In an elevated PowerShell:",
        `${winExe} service-stop`,
        `${winExe} configure-secrets --secret-files ${winFile}`,
        `${winExe} service-start`,
      ].join("\n"),
    );
    expect(
      bindCommands(["API_KEY"], {
        ...win,
        service_manager: "none",
        state_dir: "D:\\Vectory State",
      }).commands,
    ).toBe(
      [
        "# In an elevated PowerShell. First stop the agent: Ctrl-C where `vectory run` runs.",
        `${winExe} configure-secrets --state-dir 'D:\\Vectory State' --secret-files ${winFile}`,
        "# Then start the agent again the way you started it.",
      ].join("\n"),
    );
  });

  it("are the generic ones when the device isn't known, and say so when a value can't be carried", () => {
    expect(bindCommands(["API_KEY"]).commands).toBe(
      [
        "sudo vectory service-stop",
        `sudo vectory configure-secrets --secret-files ${file}`,
        "sudo vectory service-start",
      ].join("\n"),
    );
    expect(
      bindCommands(["API_KEY"], {
        ...linux,
        state_dir: "/srv/vec\u0007tory",
        service_manager: "none",
      }).commands,
    ).toBe(
      [
        "# No command can be shown for this host: the state directory contains a control character.",
        "# Check where the agent keeps its state, then write the vectory configure-secrets command by hand.",
      ].join("\n"),
    );
  });
});

describe("fixes that name a command", () => {
  const hint =
    "Allow it on the host, with the agent stopped: vectory allow --network 10.0.0.9:9. Or deploy to a full-mode device.";

  it("add the state directory when the host keeps its state elsewhere", () => {
    expect(
      hostHint(hint, { os: "linux", state_dir: "/srv/vectory state" }),
    ).toBe(
      "Allow it on the host, with the agent stopped: vectory allow --state-dir '/srv/vectory state' --network 10.0.0.9:9. Or deploy to a full-mode device.",
    );
    expect(
      hostHint("Run vectory allow --file-root DIR on the host.", {
        os: "windows",
        state_dir: "D:\\Agent",
      }),
    ).toBe(
      "Run vectory allow --state-dir 'D:\\Agent' --file-root DIR on the host.",
    );
  });

  it("leave a fix alone when nothing differs, nothing is known or it names no such command", () => {
    for (const device of [
      { os: "linux", state_dir: "/var/lib/vectory-agent" },
      { os: "darwin", state_dir: "/Library/Application Support/Vectory/agent" },
      { os: "windows", state_dir: "C:\\ProgramData\\Vectory\\agent" },
      { os: "linux" },
      { os: "linux", state_dir: "/srv/vec\u0007tory" },
    ])
      expect(hostHint(hint, device)).toBe(hint);
    expect(hostHint(hint)).toBe(hint);
    expect(hostHint(undefined, { os: "linux", state_dir: "/srv/x" })).toBe(
      undefined,
    );
    const other = "Bind it on the host with configure-secrets.";
    expect(hostHint(other, { os: "linux", state_dir: "/srv/x" })).toBe(other);
    // Already there: said once, however often it is applied.
    const once = hostHint(hint, { os: "linux", state_dir: "/srv/x" });
    expect(hostHint(once, { os: "linux", state_dir: "/srv/x" })).toBe(once);
  });

  it("reach the row's fix line and its secret commands", () => {
    const device = {
      os: "linux",
      state_dir: "/srv/vectory state",
      service_manager: "none" as const,
    };
    const html = renderToStaticMarkup(
      createElement(DeviceCheckResults, {
        rows: [
          row("edge-fix", "failed", {
            diagnostics: [
              finding(
                "Sink out sends to 10.0.0.9:9, which this host hasn't approved.",
                { hint },
              ),
            ],
          }),
          row("edge-secret", "failed", { secrets_missing: ["API_KEY"] }),
        ],
        devices: new Map([
          ["id-edge-fix", { id: "id-edge-fix", name: "edge-fix", ...device }],
          [
            "id-edge-secret",
            { id: "id-edge-secret", name: "edge-secret", ...device },
          ],
        ]),
        layout: "table",
        blocked: false,
        onRetry: () => {},
      }),
    );
    expect(html).toContain(
      "vectory allow --state-dir &#x27;/srv/vectory state&#x27; --network 10.0.0.9:9.",
    );
    expect(html).toContain("sudo vectory configure-secrets \\");
    expect(html).toContain("--state-dir &#x27;/srv/vectory state&#x27; \\");
    expect(html).toContain("# First stop the agent: Ctrl-C where");
    expect(html).not.toContain("sudo vectory service-stop");
  });
});

describe("the section before anything is asked", () => {
  const html = (testCount: number) =>
    renderToStaticMarkup(
      createElement(DeviceCheck, {
        request: { version_id: "v1" },
        devices: [],
        artifacts: [],
        testCount,
      }),
    );

  it("offers the check with its promise and the tests switch, and says nothing yet", () => {
    const out = html(2);
    expect(out).toContain(
      "Runs the check on each host. It doesn&#x27;t start or change anything.",
    );
    expect(out).toContain("Check on devices");
    expect(out).toContain('role="switch"');
    expect(out).toContain("Also run the pipeline&#x27;s tests");
    expect(out).toContain("2 tests. Each host runs them too");
    expect(out).toContain('role="status"');
    expect(out).not.toContain("device-check-summary");
    expect(out).not.toContain("advisory");
  });

  it("leaves the switch off for a pipeline that has no tests", () => {
    const out = html(0);
    expect(out).toContain("This pipeline has no tests.");
    expect(out).toMatch(/<input[^>]*disabled/);
    expect(html(1)).toContain("1 test. Each host runs it too");
  });
});
