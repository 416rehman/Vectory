import { describe, expect, it } from "vitest";
import {
  approvalBasis,
  approvalEvidence,
  approvalHeadline,
  approvalParagraphs,
  approvalParts,
  approvalSummary,
  approvalsCovered,
  passedHeadline,
  passedSentence,
  refusalCondition,
} from "./hostApprovalStanding";

const none = { destinations: [], listeners: [], fileRoots: [] };
const needed = {
  destinations: ["127.0.0.1:8678"],
  listeners: ["127.0.0.1:8088"],
  fileRoots: ["/var/log/app"],
};
const device = (id: string, version?: string) => ({
  id,
  running_version: version
    ? {
        id: version,
        number: 1,
        configuration_id: "c",
        configuration_name: "Pipeline",
      }
    : null,
});

describe("what a restricted host is asked to allow", () => {
  it("lists each kind in the product's words", () => {
    expect(approvalParts(needed)).toEqual([
      "destination 127.0.0.1:8678",
      "listener 127.0.0.1:8088",
      "files under /var/log/app",
    ]);
    expect(
      approvalParts({
        destinations: ["a:1", "b:2"],
        listeners: ["0.0.0.0:514", "0.0.0.0:515"],
        fileRoots: ["/a", "/b"],
      }),
    ).toEqual([
      "destinations a:1, b:2",
      "listeners 0.0.0.0:514, 0.0.0.0:515",
      "files under /a, /b",
    ]);
    expect(approvalParts(none)).toEqual([]);
  });

  it("names one item and counts several for a row", () => {
    expect(approvalSummary({ ...none, destinations: ["127.0.0.1:8678"] })).toBe(
      "destination 127.0.0.1:8678",
    );
    expect(approvalSummary({ ...none, listeners: ["0.0.0.0:514"] })).toBe(
      "listener 0.0.0.0:514",
    );
    expect(approvalSummary({ ...none, fileRoots: ["/var/log"] })).toBe(
      "files under /var/log",
    );
    expect(approvalSummary(needed)).toBe(
      "1 destination, 1 listener and files under 1 directory",
    );
    expect(
      approvalSummary({
        destinations: ["a:1", "b:2"],
        listeners: ["0.0.0.0:514"],
        fileRoots: [],
      }),
    ).toBe("2 destinations and 1 listener");
    expect(approvalSummary({ ...none, fileRoots: ["/a", "/b", "/c"] })).toBe(
      "files under 3 directories",
    );
  });

  it("says a restricted host refuses it unless it already allows these, never that it does", () => {
    const row = refusalCondition({ ...none, destinations: ["127.0.0.1:8678"] });
    expect(row).toBe(
      "refuses it unless its host allows destination 127.0.0.1:8678",
    );
    expect(row).not.toMatch(/until|approves/);
    expect(approvalHeadline(["qa-restr-01"])).toBe(
      "qa-restr-01 runs in restricted mode and needs its host to allow what this version uses",
    );
    expect(approvalHeadline(["a", "b", "c"])).toBe(
      "3 selected devices run in restricted mode and need their hosts to allow what this version uses",
    );
    expect(approvalParagraphs(needed, 1)).toEqual([
      "It uses destination 127.0.0.1:8678; listener 127.0.0.1:8088; files under /var/log/app. It refuses this version unless its host already allows these.",
      "Vectory can't see a host's allowances; Check on devices in the review shows whether it has them. Only the host operator can allow these; the dashboard can't.",
    ]);
    expect(approvalParagraphs(needed, 2)).toEqual([
      "It uses destination 127.0.0.1:8678; listener 127.0.0.1:8088; files under /var/log/app. They refuse this version unless their hosts already allow these.",
      "Vectory can't see a host's allowances; Check on devices in the review shows whether they have them. Only the host operator can allow these; the dashboard can't.",
    ]);
  });

  it("names the devices the review already knows are fine", () => {
    expect(approvalEvidence([], [])).toBeNull();
    expect(approvalEvidence(["alpha"], [])).toBe(
      "Check on devices passed on alpha.",
    );
    expect(approvalEvidence([], ["alpha"])).toBe(
      "alpha already runs a version that uses these.",
    );
    expect(approvalEvidence(["a", "b", "c"], ["d", "e"])).toBe(
      "Check on devices passed on a, b and 1 more. d and e already run a version that uses these.",
    );
    expect(passedHeadline(["alpha"])).toBe("Check on devices passed on alpha");
    expect(passedSentence(1)).toBe(
      "It runs in restricted mode, and its host accepted this version.",
    );
    expect(passedSentence(2)).toBe(
      "They run in restricted mode, and their hosts accepted this version.",
    );
  });
});

describe("whether a version's destinations, listeners and roots are already in use", () => {
  it("needs every item, exactly for addresses and by directory for files", () => {
    expect(approvalsCovered(needed, needed)).toBe(true);
    expect(approvalsCovered(none, none)).toBe(true);
    expect(approvalsCovered(none, needed)).toBe(true);
    expect(
      approvalsCovered(needed, { ...needed, destinations: ["127.0.0.1:9"] }),
    ).toBe(false);
    expect(
      approvalsCovered(needed, { ...needed, listeners: ["127.0.0.1:8089"] }),
    ).toBe(false);
    expect(approvalsCovered(needed, { ...needed, fileRoots: [] })).toBe(false);
    // A root is allowed with everything below it, and never the other way.
    expect(
      approvalsCovered(needed, { ...needed, fileRoots: ["/var/log"] }),
    ).toBe(true);
    expect(
      approvalsCovered(
        { ...needed, fileRoots: ["/var/log"] },
        { ...needed, fileRoots: ["/var/log/app"] },
      ),
    ).toBe(false);
    expect(
      approvalsCovered(needed, { ...needed, fileRoots: ["/var/log/ap"] }),
    ).toBe(false);
    expect(approvalsCovered(needed, { ...needed, fileRoots: ["/"] })).toBe(
      true,
    );
  });
});

describe("which restricted devices are known to need nothing more", () => {
  const evidence = (extra = {}) => ({
    passed: new Set<string>(),
    running: new Map<string, typeof needed | null>(),
    comparable: true,
    ...extra,
  });

  it("knows nothing for a host that was never approved, however many times it is reviewed", () => {
    expect(
      approvalBasis(needed, [device("a"), device("b", "v1")], evidence()),
    ).toEqual(new Map());
  });

  it("drops the condition for a device whose verified running version uses all of it", () => {
    const known = approvalBasis(
      needed,
      [device("a", "v1"), device("b", "v2"), device("c")],
      evidence({
        running: new Map([
          ["v1", { ...needed, destinations: ["127.0.0.1:8678", "x:1"] }],
          ["v2", { ...needed, listeners: [] }],
        ]),
      }),
    );
    expect(known).toEqual(new Map([["a", "runs"]]));
  });

  it("trusts nothing it could not read or compare", () => {
    const running = new Map([["v1", null]]);
    expect(
      approvalBasis(needed, [device("a", "v1")], evidence({ running })),
    ).toEqual(new Map());
    // A version whose addresses differ by device proves nothing about this one.
    expect(
      approvalBasis(
        needed,
        [device("a", "v1")],
        evidence({ running: new Map([["v1", needed]]), comparable: false }),
      ),
    ).toEqual(new Map());
    // A version still being read is not a version that covers it.
    expect(approvalBasis(needed, [device("a", "v1")], evidence())).toEqual(
      new Map(),
    );
  });

  it("drops the condition for a device a check passed on, and prefers that reason", () => {
    const known = approvalBasis(
      needed,
      [device("a", "v1"), device("b"), device("c")],
      evidence({
        passed: new Set(["a", "b"]),
        running: new Map([["v1", needed]]),
      }),
    );
    expect(known).toEqual(
      new Map([
        ["a", "passed"],
        ["b", "passed"],
      ]),
    );
    // A pass counts even where the version uses device-specific values: the
    // check ran on each device's own rendering.
    expect(
      approvalBasis(
        needed,
        [device("b")],
        evidence({ passed: new Set(["b"]), comparable: false }),
      ),
    ).toEqual(new Map([["b", "passed"]]));
  });
});
