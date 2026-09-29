import { describe, expect, it } from "vitest";
import type { Device } from "./api";
import { applySteps, runningVersionText } from "./DeviceDetail";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const device = (overrides: Partial<Device> = {}): Device =>
  ({
    id: id(1),
    name: "edge-fra-01",
    desired_generation: 3,
    reported_generation: 3,
    desired_version_id: id(30),
    desired_sha256: "a".repeat(64),
    desired_version: {
      id: id(30),
      number: 3,
      configuration_id: id(40),
      configuration_name: "Edge syslog processing",
    },
    apply_state: "rolled_back",
    status: "rolled_back",
    ...overrides,
  }) as Device;
const attempt = (stage: string, state = "rolled_back") =>
  ({
    generation: 3,
    version_id: id(30),
    sha256: "a".repeat(64),
    state,
    error: { code: "ADDRESS_IN_USE", stage, message: "in use" },
  }) as Device["configuration_attempt"];

describe("which version a device runs", () => {
  it("names the last verified version, with its pipeline only when it differs", () => {
    expect(
      runningVersionText(
        device({
          running_version: {
            id: id(20),
            number: 2,
            configuration_id: id(40),
            configuration_name: "Edge syslog processing",
          },
        }),
      ),
    ).toBe("v2");
    expect(
      runningVersionText(
        device({
          running_version: {
            id: id(21),
            number: 1,
            configuration_id: id(41),
            configuration_name: "Nginx metrics",
          },
        }),
      ),
    ).toBe("Nginx metrics v1");
  });
  it("says nothing when no managed version was ever verified", () => {
    expect(runningVersionText(device({ running_version: null }))).toBeNull();
  });
});

describe("the device page's apply progress", () => {
  const states = (d: Device) => applySteps(d).map((step) => step.state);
  it("blames the step the agent reported, the same one the rollout page blames", () => {
    expect(
      states(device({ configuration_attempt: attempt("rollback") })),
    ).toEqual(["done", "done", "done", "done", "failed", "todo"]);
    expect(
      states(
        device({
          apply_state: "failed",
          status: "failed",
          configuration_attempt: attempt("validation", "failed"),
        }),
      ),
    ).toEqual(["done", "done", "failed", "todo", "todo", "todo"]);
  });
});
