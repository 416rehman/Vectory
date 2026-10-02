import { describe, expect, it } from "vitest";
import type { Issue, IssueGroup, User } from "./api";
import {
  groupSubject,
  issueAction,
  issueSubject,
  type IssueSubject,
} from "./issueActions";

const user = (role: User["role"]): User => ({
  id: "u",
  email: "u@example.test",
  name: "U",
  role,
  enabled: true,
  revision: 1,
});
const viewer = user("viewer"),
  editor = user("editor"),
  operator = user("operator"),
  admin = user("admin");

const rollout = "00000000-0000-4000-8000-0000000000d1";
const pipeline = "00000000-0000-4000-8000-0000000000c1";
const base: IssueSubject = {
  code: "PROCESS_EXITED",
  configuration_id: pipeline,
  deployments: [rollout],
  device_id: "00000000-0000-4000-8000-0000000000e1",
  device_revoked: false,
  resolved: false,
  diagnostics: [],
};
const finding = (extra: object) => ({
  severity: "error" as const,
  code: "X",
  message: "m",
  ...extra,
});

describe("what an issue most likely needs next", () => {
  it("rolls back a delivery problem for someone who can operate", () => {
    const subject = { ...base, code: "DATA_PLANE_STALLED" };
    for (const person of [operator, admin])
      expect(issueAction(subject, person)).toEqual({
        kind: "rollback",
        label: "Roll back",
        href: `#/deployments/${rollout}`,
        deployment: rollout,
      });
    // Without that role the same rollout can still be read.
    for (const person of [viewer, editor])
      expect(issueAction(subject, person)).toEqual({
        kind: "rollout",
        label: "Open rollout",
        href: `#/deployments/${rollout}`,
      });
  });

  it("sends a finding only the pipeline can clear to its step and field", () => {
    const subject = {
      ...base,
      code: "VALIDATION_FAILED",
      diagnostics: [
        finding({
          severity: "warning",
          code: "VRL_E110",
          component_id: "other",
          field: "x",
        }),
        finding({ code: "DATA_DIR_MISSING", component_id: "host" }),
        finding({ code: "VRL_E100", component_id: "parse", field: "source" }),
      ],
    };
    for (const person of [editor, admin])
      expect(issueAction(subject, person)).toEqual({
        kind: "fix",
        label: "Fix in pipeline",
        href: `#/configurations/${pipeline}?select=parse&field=source`,
      });
    // An operator may not edit: the rollout is what they can open.
    expect(issueAction(subject, operator)?.kind).toBe("rollout");
    expect(issueAction(subject, viewer)?.kind).toBe("rollout");
  });

  it("names the step alone when the finding has no field, and none when it has no step", () => {
    const fix = (diagnostics: object[]) =>
      issueAction(
        {
          ...base,
          code: "VALIDATION_FAILED",
          diagnostics: diagnostics as never,
        },
        editor,
      );
    const unknown = { code: "UNKNOWN_FIELD" };
    expect(fix([finding({ ...unknown, component_id: "out" })])?.href).toBe(
      `#/configurations/${pipeline}?select=out`,
    );
    expect(fix([finding({ ...unknown, field: "rate" })])?.href).toBe(
      `#/configurations/${pipeline}`,
    );
    expect(fix([finding(unknown)])?.href).toBe(`#/configurations/${pipeline}`);
    // The step is the first fixable finding's that names one.
    expect(
      fix([
        finding(unknown),
        finding({
          code: "INPUT_NOT_FOUND",
          component_id: "tag",
          field: "inputs",
        }),
      ])?.href,
    ).toBe(`#/configurations/${pipeline}?select=tag&field=inputs`);
  });

  it("leaves a problem on the device, or a warning, out of the pipeline", () => {
    const outcome = (diagnostics: object[], person = editor) =>
      issueAction(
        {
          ...base,
          code: "VALIDATION_FAILED",
          deployments: [],
          diagnostics: diagnostics as never,
        },
        person,
      )?.kind;
    // A missing directory is the device's to fix; no findings say nothing.
    expect(outcome([finding({ code: "DATA_DIR_MISSING" })])).toBe("device");
    expect(outcome([])).toBe("device");
    expect(outcome([finding({ code: "VRL_E100", severity: "warning" })])).toBe(
      "device",
    );
    expect(outcome([finding({ code: "VRL_E100" })])).toBe("fix");
    expect(outcome([finding({ code: "INVALID_OPTION" })])).toBe("fix");
  });

  it("offers a fix only for a pipeline that exists", () => {
    const subject = {
      ...base,
      code: "VALIDATION_FAILED",
      diagnostics: [finding({ code: "ADDRESS_IN_USE" })],
      configuration_id: null,
      deployments: [],
    };
    expect(issueAction(subject, editor)?.kind).toBe("device");
  });

  it("opens the rollout, then the device, and nothing when neither exists", () => {
    expect(issueAction(base, viewer)).toEqual({
      kind: "rollout",
      label: "Open rollout",
      href: `#/deployments/${rollout}`,
    });
    const noRollout = { ...base, deployments: [] };
    expect(issueAction(noRollout, viewer)).toEqual({
      kind: "device",
      label: "Open device",
      href: `#/devices/${base.device_id}`,
    });
    // A revoked device's page still exists; a device that is gone has none.
    expect(
      issueAction({ ...noRollout, device_revoked: true }, viewer)?.kind,
    ).toBe("device");
    expect(
      issueAction({ ...noRollout, device_revoked: null }, viewer),
    ).toBeNull();
    expect(
      issueAction({ ...noRollout, device_id: undefined }, viewer),
    ).toBeNull();
  });

  it("offers nothing for an issue that is resolved", () => {
    for (const code of ["DATA_PLANE_STALLED", "VRL_E100", "PROCESS_EXITED"])
      expect(issueAction({ ...base, code, resolved: true }, admin)).toBeNull();
  });

  it("needs exactly one rollout to roll back or open", () => {
    const subject = { ...base, code: "DATA_PLANE_BUFFER_FULL" };
    const several = { ...subject, deployments: [rollout, "another"] };
    expect(issueAction(several, admin)?.kind).toBe("device");
    expect(issueAction({ ...several, device_id: undefined }, admin)).toBeNull();
    expect(issueAction({ ...subject, deployments: [] }, admin)).toEqual({
      kind: "device",
      label: "Open device",
      href: `#/devices/${base.device_id}`,
    });
  });

  it("encodes what it links to", () => {
    const odd = { ...base, deployments: ["a/b"], device_id: "d/1" };
    expect(issueAction(odd, viewer)?.href).toBe("#/deployments/a%2Fb");
    expect(issueAction({ ...odd, deployments: [] }, viewer)?.href).toBe(
      "#/devices/d%2F1",
    );
  });
});

describe("one device and a group of them decide alike", () => {
  const issue = (extra: Partial<Issue> = {}) =>
    ({
      id: "i",
      device_id: "d1",
      device_name: "edge-1",
      device_revoked: false,
      code: "DATA_PLANE_SINK_ERRORS",
      configuration_id: pipeline,
      deployment_id: rollout,
      diagnostics: [],
      resolved: false,
      ...extra,
    }) as Issue;
  const group = (extra: Partial<IssueGroup> = {}) =>
    ({
      code: "DATA_PLANE_SINK_ERRORS",
      configuration_id: pipeline,
      deployment_ids: [rollout],
      diagnostics: [],
      devices: [issue(), issue({ id: "j" })],
      ...extra,
    }) as IssueGroup;

  it("reads an issue and a group the same way", () => {
    expect(issueAction(issueSubject(issue()), operator)?.kind).toBe("rollback");
    expect(issueAction(groupSubject(group()), operator)?.kind).toBe("rollback");
  });

  it("gives a group no device to open and no rollout to choose among several", () => {
    const several = group({ deployment_ids: [rollout, "other"] });
    expect(issueAction(groupSubject(several), admin)).toBeNull();
    expect(
      issueAction(groupSubject(group({ deployment_ids: [] })), admin),
    ).toBeNull();
  });

  it("opens the device of a group that is about one", () => {
    const one = group({
      deployment_ids: [],
      device_count: 1,
      devices: [issue()],
    });
    expect(issueAction(groupSubject(one), viewer)).toEqual({
      kind: "device",
      label: "Open device",
      href: "#/devices/d1",
    });
    const gone = group({
      deployment_ids: [],
      device_count: 1,
      devices: [issue({ device_revoked: null })],
    });
    expect(issueAction(groupSubject(gone), viewer)).toBeNull();
    expect(
      issueAction(groupSubject({ ...one, device_count: 2 }), viewer),
    ).toBeNull();
  });

  it("is resolved only when every device in it is", () => {
    const some = group({
      devices: [issue({ resolved: true }), issue({ id: "j" })],
    });
    expect(issueAction(groupSubject(some), admin)?.kind).toBe("rollback");
    const all = group({
      devices: [issue({ resolved: true }), issue({ id: "j", resolved: true })],
    });
    expect(issueAction(groupSubject(all), admin)).toBeNull();
    expect(issueAction(groupSubject(group({ devices: [] })), admin)?.kind).toBe(
      "rollback",
    );
  });
});
