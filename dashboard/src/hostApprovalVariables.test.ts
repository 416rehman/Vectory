import { describe, expect, it } from "vitest";
import type { VariableDeclaration } from "./api";
import { hostApprovalCommandsByDevice } from "./hostApprovalCommands";
import { hostApprovalsByDevice } from "./hostApprovalVariables";

const declarations: VariableDeclaration[] = [
  { name: "listener", path: "/sources/incoming/address", type: "string" },
];
const config = {
  sources: {
    incoming: { type: "http_server", address: "0.0.0.0:8000" },
  },
  sinks: { out: { type: "console", inputs: ["incoming"], target: "stderr" } },
};
const devices = [
  {
    id: "alpha",
    name: "alpha",
    os: "linux",
    state_dir: "/var/lib/vectory-agent",
    service_manager: "systemd" as const,
  },
  {
    id: "beta",
    name: "beta",
    os: "linux",
    state_dir: "/var/lib/vectory-agent",
    service_manager: "systemd" as const,
  },
];

describe("device-specific host approval commands", () => {
  it("uses each selected device's typed listener instead of the published base", () => {
    const original = structuredClone(config);
    const approvals = hostApprovalsByDevice(
      config,
      declarations,
      {
        defaults: {},
        devices: {
          alpha: { listener: "0.0.0.0:1514" },
          beta: { listener: "0.0.0.0:2514" },
        },
      },
      devices,
    );
    expect(approvals?.get("alpha")?.listeners).toEqual(["0.0.0.0:1514"]);
    expect(approvals?.get("beta")?.listeners).toEqual(["0.0.0.0:2514"]);
    const blocks = hostApprovalCommandsByDevice(approvals!, devices);
    expect(blocks.map((block) => block.devices)).toEqual([["alpha"], ["beta"]]);
    expect(blocks[0].commands).toContain("--listener 0.0.0.0:1514");
    expect(blocks[0].commands).not.toContain("2514");
    expect(blocks[1].commands).toContain("--listener 0.0.0.0:2514");
    expect(blocks[1].commands).not.toContain("1514");
    expect(blocks.map((block) => block.commands).join("\n")).not.toContain(
      "0.0.0.0:8000",
    );
    expect(config).toEqual(original);
  });

  it("uses a typed default only where a device has no override and groups equal commands", () => {
    const approvals = hostApprovalsByDevice(
      config,
      declarations,
      {
        defaults: { listener: "0.0.0.0:1514" },
        devices: { beta: { listener: "0.0.0.0:1514" } },
      },
      devices,
    );
    expect(hostApprovalCommandsByDevice(approvals!, devices)).toHaveLength(1);
    expect(
      hostApprovalCommandsByDevice(approvals!, devices)[0].devices,
    ).toEqual(["alpha", "beta"]);
  });

  it("refuses incomplete, mistyped or non-scalar paths rather than falling back to base values", () => {
    expect(
      hostApprovalsByDevice(
        config,
        declarations,
        { defaults: {}, devices: { alpha: { listener: "0.0.0.0:1514" } } },
        devices,
      ),
    ).toBeNull();
    expect(
      hostApprovalsByDevice(
        config,
        declarations,
        { defaults: { listener: 1514 }, devices: {} },
        [devices[0]],
      ),
    ).toBeNull();
    expect(
      hostApprovalsByDevice(
        config,
        [{ name: "listener", path: "/sources/incoming", type: "string" }],
        { defaults: { listener: "0.0.0.0:1514" }, devices: {} },
        [devices[0]],
      ),
    ).toBeNull();
  });

  it("uses each device's path style for a declared file directory", () => {
    const pathConfig = {
      sources: {
        logs: { type: "file", data_dir: "/var/log/base" },
      },
      sinks: config.sinks,
    };
    const approvals = hostApprovalsByDevice(
      pathConfig,
      [{ name: "log_dir", path: "/sources/logs/data_dir", type: "string" }],
      {
        defaults: {},
        devices: {
          alpha: { log_dir: "C:\\VectorData\\logs\\" },
          beta: { log_dir: "/var/log/app" },
        },
      },
      [{ ...devices[0], os: "windows" }, devices[1]],
    );
    expect(approvals?.get("alpha")?.fileRoots).toEqual([
      "C:\\VectorData\\logs",
    ]);
    expect(approvals?.get("beta")?.fileRoots).toEqual(["/var/log/app"]);
    const blocks = hostApprovalCommandsByDevice(approvals!, [
      {
        ...devices[0],
        os: "windows",
        state_dir: "C:\\ProgramData\\Vectory",
        service_manager: "windows",
      },
      devices[1],
    ]);
    expect(blocks[0].commands).toContain("--file-root 'C:\\VectorData\\logs'");
    expect(blocks[1].commands).toContain("--file-root /var/log/app");
    expect(blocks[0].commands).not.toContain("/var/log/app");
  });

  it("calculates non-variable approvals separately for Windows and Unix hosts", () => {
    const approvals = hostApprovalsByDevice(
      {
        sources: {
          logs: { type: "file", data_dir: "C:\\VectorData\\logs" },
        },
      },
      [],
      { defaults: {}, devices: {} },
      [{ ...devices[0], os: "windows" }, devices[1]],
    );
    expect(approvals?.get("alpha")?.fileRoots).toEqual([
      "C:\\VectorData\\logs",
    ]);
    expect(approvals?.get("beta")?.fileRoots).toEqual([]);
    expect(
      hostApprovalCommandsByDevice(approvals!, [
        {
          ...devices[0],
          os: "windows",
          state_dir: "C:\\ProgramData\\Vectory\\agent",
          service_manager: "windows",
        },
      ])[0].commands,
    ).toContain("--file-root 'C:\\VectorData\\logs'");
  });
});
