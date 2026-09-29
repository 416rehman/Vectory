import { describe, expect, it } from "vitest";
import {
  allowArguments,
  hostApprovalCommands,
  hostCommands,
  namedDevices,
} from "./hostApprovalCommands";

const approvals = {
  destinations: ["127.0.0.1:8239"],
  listeners: ["0.0.0.0:514"],
  fileRoots: ["/var/log/app logs"],
};
const host = {
  name: "web-01",
  os: "linux",
  state_dir: "/var/lib/vectory-agent",
  service_manager: "systemd" as const,
};

describe("host approval commands", () => {
  it("add allowances with vectory allow and never replace the host's file", () => {
    expect(hostCommands(approvals, host)).toBe(
      [
        "sudo vectory service-stop",
        "sudo vectory allow \\",
        "  --network 127.0.0.1:8239 \\",
        "  --listener 0.0.0.0:514 \\",
        "  --file-root '/var/log/app logs'",
        "sudo vectory service-start",
      ].join("\n"),
    );
    for (const device of [
      host,
      { ...host, service_manager: "none" as const },
      { ...host, os: "windows", service_manager: "windows" as const },
    ]) {
      const commands = hostCommands(approvals, device);
      expect(commands).not.toMatch(/allowances\.json|tee |capability-policy/);
    }
  });

  it("name a state directory that isn't the default, and stop and start the agent the way it runs", () => {
    expect(
      hostCommands(approvals, {
        ...host,
        state_dir: "/srv/vectory state",
        service_manager: "none",
      }),
    ).toBe(
      [
        "# First stop the agent: Ctrl-C where `vectory run` runs (`vectory status` shows its pid).",
        "sudo vectory allow \\",
        "  --state-dir '/srv/vectory state' \\",
        "  --network 127.0.0.1:8239 \\",
        "  --listener 0.0.0.0:514 \\",
        "  --file-root '/var/log/app logs'",
        "# Then start the agent again the way you started it.",
      ].join("\n"),
    );
    // macOS keeps its own default; launchd is a service like systemd.
    expect(
      hostCommands(approvals, {
        ...host,
        os: "darwin",
        state_dir: "/Library/Application Support/Vectory/agent",
        service_manager: "launchd",
      }).split("\n"),
    ).toEqual([
      "sudo vectory service-stop",
      "sudo vectory allow \\",
      "  --network 127.0.0.1:8239 \\",
      "  --listener 0.0.0.0:514 \\",
      "  --file-root '/var/log/app logs'",
      "sudo vectory service-start",
    ]);
    // An older agent that doesn't say what keeps it running.
    expect(
      hostCommands(approvals, { ...host, service_manager: undefined }).split(
        "\n",
      )[0],
    ).toBe(
      "# Without a service (`vectory run`), stop it with Ctrl-C instead, and start it again yourself.",
    );
  });

  it("write PowerShell for Windows hosts", () => {
    expect(
      hostCommands(approvals, {
        ...host,
        os: "windows",
        state_dir: "D:\\Vectory\\agent",
        service_manager: "windows",
      }),
    ).toBe(
      [
        "# In an elevated PowerShell:",
        "& 'C:\\Program Files\\Vectory\\vectory.exe' service-stop",
        "& 'C:\\Program Files\\Vectory\\vectory.exe' allow --state-dir 'D:\\Vectory\\agent' --network 127.0.0.1:8239 --listener 0.0.0.0:514 --file-root '/var/log/app logs'",
        "& 'C:\\Program Files\\Vectory\\vectory.exe' service-start",
      ].join("\n"),
    );
  });

  it("group devices that need the same commands", () => {
    const blocks = hostApprovalCommands(approvals, [
      host,
      { ...host, name: "edge-2" },
      { ...host, name: "edge-3", service_manager: "none" },
    ]);
    expect(blocks.map((block) => block.devices)).toEqual([
      ["web-01", "edge-2"],
      ["edge-3"],
    ]);
    expect(namedDevices(["a"])).toBe("a");
    expect(namedDevices(["a", "b"])).toBe("a and b");
    expect(namedDevices(["a", "b", "c", "d"])).toBe("a, b and 2 more");
    expect(allowArguments(approvals, "linux")).toEqual([
      "--network",
      "127.0.0.1:8239",
      "--listener",
      "0.0.0.0:514",
      "--file-root",
      "'/var/log/app logs'",
    ]);
  });
});
