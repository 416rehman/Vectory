import { describe, expect, it } from "vitest";
import { deferralNote, testHeadline } from "./PipelineTestResults";

const test = (passed: boolean) => ({ name: "t", passed });

describe("pipeline test headline", () => {
  it("counts Vector's own verdicts", () => {
    expect(
      testHeadline({
        valid: true,
        errors: [],
        tests: [test(true), test(true)],
      }),
    ).toBe("All 2 tests passed");
    expect(testHeadline({ valid: true, errors: [], tests: [test(true)] })).toBe(
      "1 test passed",
    );
    expect(
      testHeadline({
        valid: false,
        errors: [],
        tests: [test(true), test(false), test(false)],
      }),
    ).toBe("1 of 3 tests passed");
  });

  it("separates deferred runs and configurations that did not load", () => {
    expect(testHeadline({ valid: false, errors: [], deferred: true })).toBe(
      "These tests need the device environment",
    );
    expect(
      testHeadline({ valid: false, errors: ["x"], tests_run: false }),
    ).toBe("Vector couldn't load this pipeline to run its tests");
    expect(testHeadline({ valid: false, errors: ["x"] })).toBe(
      "Pipeline tests failed",
    );
  });

  it("leads with the verdict when deferred tests still ran", () => {
    const run = {
      valid: true,
      errors: [],
      deferred: true,
      tests_run: true,
      output: "2 of 2 tests passed.",
      tests: [test(true), test(true)],
      warnings: [
        "Each device checks /var/log/nginx/access.log before applying this version.",
      ],
    };
    expect(testHeadline(run)).toBe("All 2 tests passed");
    expect(deferralNote(run)).toBe(
      "Vector ran them with stand-ins for device values. Each device checks /var/log/nginx/access.log before applying this version.",
    );
    expect(
      deferralNote({ valid: true, errors: [], tests: [test(true)] }),
    ).toBeNull();
  });

  it("does not say tests passed when Vector reported none for a pipeline that has some", () => {
    const empty = {
      valid: true,
      errors: [],
      tests_run: true,
      tests: [],
      output: "0 of 0 tests passed.",
    };
    expect(testHeadline(empty, 2)).toBe("Vector didn't run these tests");
    // A pipeline without tests keeps the plain wording.
    expect(testHeadline(empty, 0)).toBe("Pipeline tests passed");
  });
});
