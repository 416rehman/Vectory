import { describe, expect, it } from "vitest";
import type {
  ConfigurationDiffHunk,
  DeviceConfiguration,
  DeviceConfigurationDiff,
  OfferedGeneration,
} from "./api";
import {
  changesHeading,
  configurationPath,
  countsSentence,
  diffPath,
  downloadName,
  driftLine,
  evidenceKey,
  fieldLabel,
  generationOptions,
  generationsNote,
  hunkTitle,
  shortDigest,
  sizeText,
  variableRows,
  versionName,
  versionText,
} from "./effectiveConfigurationModel";

const SHA = (letter: string) => letter.repeat(64);
const version = (
  number: number | null,
  name: string | null = "Edge syslog",
) => ({
  id: `00000000-0000-4000-8000-${String(number ?? 0).padStart(12, "0")}`,
  number,
  configuration_id: "00000000-0000-4000-8000-000000000900",
  configuration_name: name,
});
const generation = (
  n: number,
  sha: string,
  v: number | null = n,
  at: string | null = "2026-09-29T12:00:00Z",
): OfferedGeneration => ({
  generation: n,
  version: version(v),
  sha256: sha,
  offered_at: at,
});

/** A read of generation 12 (current), run by an agent that reports nothing yet. */
function read(over: Partial<DeviceConfiguration> = {}): DeviceConfiguration {
  return {
    device_id: "d",
    generation: 12,
    current: true,
    offered_at: "2026-09-29T12:00:00Z",
    version: version(3),
    sha256: SHA("a"),
    size: 4200,
    format: "json",
    content: "{}\n",
    uses_local_secrets: false,
    variables: [],
    running: {
      sha256: null,
      template_sha256: null,
      matches: null,
      matches_generation: null,
      reported_at: null,
    },
    previous: { generation: 11, version: version(2), sha256: SHA("b") },
    generations: {
      total: 2,
      items: [generation(12, SHA("a"), 3), generation(11, SHA("b"), 2)],
    },
    ...over,
  };
}
const running = (over: Partial<DeviceConfiguration["running"]>) => ({
  sha256: SHA("a"),
  template_sha256: null,
  matches: null,
  matches_generation: null,
  reported_at: "2026-09-29T12:05:00Z",
  ...over,
});
const device = (over: Record<string, unknown> = {}) => ({
  status: "verified",
  apply_state: "verified_applied",
  sync_paused: false,
  local_paused: false,
  desired_generation: 12,
  ...over,
});

describe("the drift sentence", () => {
  it("does not call a matching managed file running when activation is unknown or failed", () => {
    for (const apply_state of ["verification_unknown", "failed"]) {
      const line = driftLine(
        read({ running: running({ matches: null }) }),
        device({ status: apply_state, apply_state }),
      );
      expect(line).toMatchObject({
        badge: "Not verified",
        tone: "neutral",
        headline:
          "The managed file matches this offer, but activation isn't verified.",
      });
      expect(line.detail).not.toMatch(/verified running|applied this/);
    }
    // A stale server response must not make an unverified apply green either.
    expect(
      driftLine(
        read({ running: running({ matches: true }) }),
        device({
          status: "verification_unknown",
          apply_state: "verification_unknown",
        }),
      ),
    ).toMatchObject({ badge: "Not verified", tone: "neutral" });
  });

  it("distinguishes a reported secret template from verified activation", () => {
    const line = driftLine(
      read({
        uses_local_secrets: true,
        running: running({
          matches: null,
          sha256: SHA("f"),
          template_sha256: SHA("a"),
        }),
      }),
      device({
        status: "verification_unknown",
        apply_state: "verification_unknown",
      }),
    );
    expect(line).toMatchObject({
      badge: "Not verified",
      tone: "neutral",
      headline:
        "The agent reports this template, but activation isn't verified.",
    });
  });

  it("describes an earlier matching file without calling its offer active", () => {
    const line = driftLine(
      read({
        current: false,
        generation: 10,
        running: running({ matches: null }),
      }),
      device({ apply_state: "desired" }),
    );
    expect(line).toMatchObject({
      badge: "Not verified",
      tone: "neutral",
      headline:
        "The managed file matches generation 10, but activation isn't verified.",
    });
  });

  it("says the running configuration matches only when the server verified it", () => {
    const line = driftLine(
      read({ running: running({ matches: true }) }),
      device(),
    );
    expect(line).toMatchObject({
      badge: "Matches",
      tone: "success",
      headline: "Running matches what Vectory offered.",
      detail: "",
      showReportedAt: true,
    });
  });

  it("names the generation a differing file matches", () => {
    const line = driftLine(
      read({ running: running({ matches: false, matches_generation: 10 }) }),
      device({ apply_state: "desired", status: "applying" }),
    );
    expect(line.headline).toBe(
      "The managed file differs from what Vectory offered at generation 12: it matches generation 10.",
    );
    expect(line).toMatchObject({ badge: "Differs", tone: "warning" });
    expect(line.detail).toBe(
      "The agent hasn't finished applying generation 12.",
    );
  });

  it("offers both explanations when the agent is not in the middle of applying", () => {
    const line = driftLine(
      read({ running: running({ matches: false, matches_generation: 11 }) }),
      device({ apply_state: "failed", status: "failed" }),
    );
    expect(line.detail).toContain(
      "may not be applied yet, or its apply failed",
    );
    expect(line.detail).toContain("Running vs desired above");
  });

  it("never claims what a file the server has not seen contains", () => {
    const line = driftLine(
      read({ running: running({ matches: false }) }),
      device(),
    );
    expect(line.headline).toBe(
      "The managed file differs from what Vectory offered at generation 12.",
    );
    expect(line.detail).toContain("isn't any configuration Vectory offered");
    expect(line.detail).toContain("Vectory sees only the file's digest, never");
    // No markup: the line is plain text.
    expect(line.detail).not.toContain("`");
    // It does not say what the file became or who changed it.
    expect(line.detail).not.toMatch(/someone|was edited by|contains/i);
  });

  it("tells the truth about what the agent does next, by sync state", () => {
    const on = driftLine(
      read({ running: running({ matches: false }) }),
      device(),
    );
    expect(on.detail).toContain(
      "restores the offered configuration at its next check-in",
    );
    const paused = driftLine(
      read({ running: running({ matches: false }) }),
      device({ sync_paused: true }),
    );
    expect(paused.detail).toContain(
      "Sync is paused, so the agent leaves the file as it is.",
    );
    const local = driftLine(
      read({ running: running({ matches: false }) }),
      device({ local_paused: true }),
    );
    expect(local.detail).toContain("Sync is paused");
  });

  it("says not reported when the agent sends no digest, and does not guess", () => {
    const line = driftLine(
      read({ running: running({ sha256: null }) }),
      device(),
    );
    expect(line).toMatchObject({
      badge: "Not reported",
      tone: "neutral",
      headline: "Not reported by this agent.",
      detail: "Vectory can't say whether it runs this configuration.",
      showReportedAt: false,
    });
  });

  it("says a device that never checked in has not reported", () => {
    const line = driftLine(
      read({ running: running({ sha256: null, reported_at: null }) }),
      device({ status: "awaiting_first_check_in" }),
    );
    expect(line.headline).toBe("This device hasn't checked in yet.");
  });

  it("makes a stale report read as stale", () => {
    const line = driftLine(
      read({ running: running({ matches: true }) }),
      device({ status: "offline" }),
    );
    expect(line.detail).toContain("offline, so this is its last report");
  });

  it("explains a version that reads device secrets", () => {
    const matches = driftLine(
      read({
        uses_local_secrets: true,
        running: running({
          matches: true,
          template_sha256: SHA("a"),
          sha256: SHA("f"),
        }),
      }),
      device(),
    );
    expect(matches.headline).toBe("Running matches what Vectory offered.");
    expect(matches.detail).toContain("the host's own values");
    expect(matches.detail).toContain("applied this exact template");
    const changed = driftLine(
      read({
        uses_local_secrets: true,
        running: running({ matches: false, template_sha256: SHA("a") }),
      }),
      device(),
    );
    expect(changed.detail).toContain("changed after the agent verified it");
    expect(changed.detail).toContain("rotated secret");
    const unknown = driftLine(
      read({ uses_local_secrets: true, running: running({ matches: null }) }),
      device(),
    );
    expect(unknown).toMatchObject({ badge: "Can't compare", tone: "neutral" });
    expect(unknown.headline).toContain("file on the host");
  });

  it("reads an earlier generation as a file comparison, not activation proof", () => {
    const stillRuns = driftLine(
      read({
        generation: 10,
        current: false,
        running: running({ matches: true }),
      }),
      device(),
    );
    expect(stillRuns).toMatchObject({ badge: "File matches", tone: "neutral" });
    expect(stillRuns.headline).toBe("The managed file matches generation 10.");
    expect(stillRuns.detail).toBe("Generation 12 is the one offered now.");
    const notRunning = driftLine(
      read({
        generation: 10,
        current: false,
        running: running({ matches: false, matches_generation: 12 }),
      }),
      device(),
    );
    expect(notRunning).toMatchObject({
      badge: "File differs",
      tone: "neutral",
    });
    expect(notRunning.detail).toBe(
      "Its agent reports what Vectory offered at generation 12.",
    );
    const never = driftLine(
      read({
        generation: 10,
        current: false,
        running: running({ matches: false }),
      }),
      device(),
    );
    expect(never.detail).toBe(
      "Its agent reports a file Vectory never offered it.",
    );
  });

  it("says nothing is offered, and what the reported file is", () => {
    const nothing = read({
      content: null,
      version: null,
      sha256: null,
      size: null,
      format: null,
      running: running({ matches: null, matches_generation: 4 }),
    });
    const line = driftLine(nothing, device());
    expect(line.badge).toBe("Nothing offered");
    expect(line.headline).toBe("Nothing is offered to this device now.");
    expect(line.detail).toBe(
      "The file its agent reports is what Vectory offered at generation 4.",
    );
    const adopted = driftLine(
      {
        ...nothing,
        running: running({ matches: null, matches_generation: null }),
      },
      device(),
    );
    expect(adopted.detail).toContain("configuration adopted at setup");
    const silent = driftLine(
      {
        ...nothing,
        running: running({ sha256: null, matches_generation: null }),
      },
      device(),
    );
    expect(silent.detail).toBe("Its agent reports no managed file.");
    expect(silent.showReportedAt).toBe(false);
  });

  it("does not judge a revoked device", () => {
    const line = driftLine(
      read({ running: running({ matches: null }) }),
      device({ status: "revoked" }),
    );
    expect(line).toMatchObject({ badge: "Revoked", tone: "neutral" });
    expect(line.headline).toBe(
      "This device can no longer report what it runs.",
    );
    expect(line.detail).toBe("Its last report is the file digest below.");
  });
});

describe("the generation picker", () => {
  it("leads with the current generation and notes retries", () => {
    const config = read({
      generations: {
        total: 4,
        items: [
          generation(12, SHA("a"), 3),
          generation(11, SHA("b"), 2),
          generation(10, SHA("b"), 2),
          generation(9, SHA("c"), 1, null),
        ],
      },
    });
    const options = generationOptions(config, 12, true);
    expect(options.map((option) => option.generation)).toEqual([12, 11, 10, 9]);
    expect(options[0].label).toBe("Current: v3 · generation 12");
    expect(options[1].label).toMatch(/^v2 · generation 11 · same as 10 · /);
    expect(options[2].label).toMatch(/^v2 · generation 10 · /);
    // A generation with no stored time shows none.
    expect(options[3].label).toBe("v1 · generation 9");
  });

  it("names the pipeline when more than one was offered", () => {
    const other = {
      ...generation(11, SHA("b"), 2),
      version: {
        ...version(2, "Web access logs"),
        configuration_id: "00000000-0000-4000-8000-000000000901",
      },
    };
    const config = read({
      generations: { total: 2, items: [generation(12, SHA("a"), 3), other] },
    });
    const options = generationOptions(config, 12, true);
    expect(options[0].label).toBe("Current: Edge syslog v3 · generation 12");
    expect(options[1].label).toMatch(/^Web access logs v2 · generation 11/);
  });

  it("has no current option when nothing is offered now", () => {
    const options = generationOptions(read(), 12, false);
    expect(options[0].label).toMatch(/^v3 · generation 12 · /);
  });

  it("keeps a generation read by number that the newest 50 do not hold", () => {
    const config = read({
      generation: 3,
      current: false,
      generations: { total: 90, items: [generation(12, SHA("a"), 3)] },
    });
    const options = generationOptions(config, 12, true);
    expect(options.at(-1)).toEqual({
      generation: 3,
      label: "v3 · generation 3",
    });
  });

  it("says how many of the offered generations the picker holds, only when it holds fewer", () => {
    const items = Array.from({ length: 50 }, (_, index) =>
      generation(212 - index, SHA("a")),
    );
    expect(generationsNote(read({ generations: { total: 212, items } }))).toBe(
      "Showing the newest 50 of 212",
    );
    expect(
      generationsNote(read({ generations: { total: 1_284, items } })),
    ).toBe("Showing the newest 50 of 1,284");
    expect(
      generationsNote(read({ generations: { total: 50, items } })),
    ).toBeNull();
    expect(
      generationsNote(
        read({ generations: { total: 1, items: [generation(12, SHA("a"))] } }),
      ),
    ).toBeNull();
  });
});

describe("version names", () => {
  it("reads without a number or a pipeline name", () => {
    expect(versionText(version(3))).toBe("v3");
    expect(versionText(version(null))).toBe("version");
    expect(versionName(version(3))).toBe("Edge syslog v3");
    expect(versionName(version(3, null))).toBe("v3");
    expect(versionName(null)).toBe("version");
  });
});

describe("the changes panel", () => {
  const hunk = (
    over: Partial<ConfigurationDiffHunk> = {},
  ): ConfigurationDiffHunk => ({
    old_start: 12,
    old_lines: 7,
    new_start: 12,
    new_lines: 7,
    section: "sinks.out.buffer",
    lines: [],
    ...over,
  });

  it("counts what changed and says when nothing did", () => {
    expect(countsSentence({ added: 3, removed: 1, changed: 2 })).toBe(
      "3 added · 1 removed · 2 changed",
    );
    expect(countsSentence({ added: 0, removed: 0, changed: 1 })).toBe(
      "1 changed",
    );
    expect(countsSentence({ added: 1200, removed: 0, changed: 0 })).toBe(
      (1200).toLocaleString() + " added",
    );
    expect(countsSentence({ added: 0, removed: 0, changed: 0 })).toBe(
      "No changes",
    );
  });

  it("titles a hunk by its components and its lines in the newer text", () => {
    expect(hunkTitle(hunk())).toEqual({
      where: "sinks.out.buffer",
      lines: "lines 12–18",
    });
    expect(hunkTitle(hunk({ section: null, new_lines: 1 }))).toEqual({
      where: "Top level",
      lines: "line 12",
    });
    // Only removals: the range in the older text.
    expect(
      hunkTitle(
        hunk({ new_start: 0, new_lines: 0, old_start: 4, old_lines: 2 }),
      ),
    ).toEqual({ where: "sinks.out.buffer", lines: "lines 4–5" });
  });

  it("leads with what the comparison is against", () => {
    const diff = { from: { generation: 11 } } as DeviceConfigurationDiff;
    expect(changesHeading(11, diff)).toBe("What changed since generation 11");
    expect(changesHeading(null, diff)).toBe("First configuration offered");
  });

  it("asks for exactly the pair on screen", () => {
    expect(diffPath("a b", 11, 12)).toBe(
      "/devices/a%20b/configuration/diff?from=11&to=12",
    );
  });
});

describe("the variables table", () => {
  it("reads a field as dotted keys and a source as a phrase", () => {
    expect(fieldLabel("/sinks/out/buffer/max_events")).toBe(
      "sinks.out.buffer.max_events",
    );
    expect(fieldLabel("/a~1b/c~0d")).toBe("a/b.c~d");
    const rows = variableRows([
      {
        name: "max_events",
        path: "/sinks/out/buffer/max_events",
        type: "integer",
        value: 700,
        source: "device",
      },
      {
        name: "site",
        path: "/sources/in/format",
        type: "string",
        value: "json",
        source: "default",
      },
      {
        name: "flag",
        path: "/sinks/out/enabled",
        type: "boolean",
        value: false,
        source: null,
      },
      {
        name: "hidden",
        path: "/sinks/out/auth/token",
        type: "string",
        value: null,
        source: "group",
      },
    ]);
    expect(rows.map((row) => row.value)).toEqual([
      "700",
      "json",
      "false",
      null,
    ]);
    expect(rows.map((row) => row.source)).toEqual([
      "Set for this device",
      "Deployment default",
      "Not recorded",
      "Group default",
    ]);
    expect(rows[2].value).toBe("false");
  });
});

describe("reads, files and sizes", () => {
  it("sends a generation only when one was chosen", () => {
    expect(configurationPath("edge-1", null)).toBe(
      "/devices/edge-1/configuration",
    );
    expect(configurationPath("edge/1", 4)).toBe(
      "/devices/edge%2F1/configuration?generation=4",
    );
  });

  it("reads again only when what the device reports about its file changes", () => {
    const base = {
      status: "verified",
      desired_generation: 12,
      desired_version_id: "v",
      desired_sha256: SHA("a"),
      actual_sha256: SHA("a"),
      applied_template_sha256: undefined,
      reported_generation: 12,
    };
    const key = evidenceKey(base);
    // A check-in that changes none of these is not a reason to read.
    expect(evidenceKey({ ...base })).toBe(key);
    for (const change of [
      { desired_generation: 13 },
      { desired_version_id: "w" },
      { desired_sha256: SHA("b") },
      { actual_sha256: SHA("c") },
      { applied_template_sha256: SHA("d") },
      { reported_generation: 11 },
      { status: "revoked" },
    ])
      expect(evidenceKey({ ...base, ...change })).not.toBe(key);
    // Other status changes (offline, applying) are not a different file.
    expect(evidenceKey({ ...base, status: "offline" })).toBe(key);
  });

  it("names a download for the device, the generation and the format", () => {
    expect(downloadName("edge-nyc-01", 12, "json")).toBe(
      "edge-nyc-01-generation-12.json",
    );
    expect(downloadName("Edge NYC 01", 3, "yaml")).toBe(
      "edge-nyc-01-generation-3.yaml",
    );
    expect(downloadName("../../etc/passwd", 1, null)).toBe(
      "etc-passwd-generation-1.json",
    );
    expect(downloadName("***", 1, "json")).toBe("device-generation-1.json");
  });

  it("formats sizes and digests", () => {
    expect(sizeText(900)).toBe("900 B");
    expect(sizeText(4200)).toBe("4.1 KB");
    expect(sizeText(600 * 1024)).toBe("600.0 KB");
    expect(sizeText(1024 * 1024)).toBe("1.0 MB");
    expect(shortDigest(SHA("a"))).toBe("aaaaaaaa…aaaa");
    expect(shortDigest("abc")).toBe("abc");
  });
});
