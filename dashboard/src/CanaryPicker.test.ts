import { describe, expect, it } from "vitest";
import type { CanaryPlan, Device } from "./api";
import { canaryExplanation, canaryStageColumn } from "./CanaryPicker";

const entry = (
  name: string,
  over: Partial<CanaryPlan["devices"][number]> = {},
): CanaryPlan["devices"][number] => ({
  device_id: `id-${name}`,
  device_name: name,
  chosen: false,
  readiness: "ready",
  reason: "Online and healthy, and it reports metrics",
  ...over,
});
const plan = (...devices: CanaryPlan["devices"]): CanaryPlan => ({
  size: devices.length,
  chosen_by_you: devices.some((device) => device.chosen),
  device_ids: devices.map((device) => device.device_id),
  devices,
});

describe("saying who the canary is and why", () => {
  it("says which device was chosen for you and why", () => {
    expect(canaryExplanation(plan(entry("edge-nyc-02")), false)).toBe(
      "Chosen for you: online and healthy, and it reports metrics.",
    );
  });
  it("says what the person chose, and that the rest were filled in", () => {
    expect(
      canaryExplanation(
        plan(
          entry("edge-fra-01", { chosen: true, reason: "You chose it" }),
          entry("edge-nyc-02"),
        ),
        false,
      ),
    ).toBe(
      "You chose edge-fra-01. The rest were chosen for you: online and healthy, and it reports metrics.",
    );
    expect(
      canaryExplanation(
        plan(
          entry("edge-fra-01", { chosen: true, reason: "You chose it" }),
          entry("edge-nyc-02", { chosen: true, reason: "You chose it" }),
        ),
        false,
      ),
    ).toBe("You chose edge-fra-01 and edge-nyc-02.");
  });
  it("does not repeat one reason for devices that rank differently", () => {
    expect(
      canaryExplanation(
        plan(
          entry("edge-nyc-02"),
          entry("edge-nyc-03", {
            readiness: "no_metrics",
            reason: "Online and healthy, but it reports no metrics",
          }),
        ),
        false,
      ),
    ).toBe("Chosen for you: the most ready devices first.");
  });
  it("says a scheduled rollout chooses again when it starts", () => {
    expect(canaryExplanation(plan(entry("edge-nyc-02")), true)).toContain(
      "The choice is made again when the schedule starts",
    );
  });
});

describe("the review table's Stage column", () => {
  const device = (id: string) => ({ id, name: id }) as unknown as Device;
  it("is absent unless the request is a canary", () => {
    expect(canaryStageColumn(null)).toEqual([]);
    expect(canaryStageColumn(undefined)).toEqual([]);
  });
  it("calls the canary devices Canary and the rest Then", () => {
    const [column] = canaryStageColumn(plan(entry("edge-nyc-02")));
    expect(column.header).toBe("Stage");
    expect(column.value?.(device("id-edge-nyc-02"))).toBe("Canary");
    expect(column.value?.(device("id-edge-nyc-03"))).toBe("Then");
    expect(column.filter?.options?.map((option) => option.value)).toEqual([
      "Canary",
      "Then",
    ]);
  });
});
