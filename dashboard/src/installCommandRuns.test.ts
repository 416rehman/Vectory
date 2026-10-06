// Runs the Add device install command under real shells, with stand-ins for
// curl and sudo on PATH, so what the command does is checked, not just what it
// says: it keeps its files in a directory only its user can enter, stops at the
// first failing step, never runs an installer that failed its check, and leaves
// nothing behind. TLS is curl's own job and is covered where a real server runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentInstallSchema } from "./api";
import { installerCommand, type SetupChoices } from "./enrollmentCommands";

const installerScript = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE/installer.args"
`;
const caPem = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBszCCAVmgAwIBAgIUU3ludGhldGljIGFnZW50IENBIGZvciB0ZXN0cy4wCgYI",
  "U3ludGhldGljU3ludGhldGljU3ludGhldGlj==",
  "-----END CERTIFICATE-----",
  "",
].join("\n");
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const install = (publiclyTrusted = false) =>
  AgentInstallSchema.parse({
    agent_url: "https://vectory.example.test:8443",
    agent_url_configured: false,
    listener_enabled: true,
    dashboard_url: null,
    certificate: {
      available: true,
      publicly_trusted: publiclyTrusted,
      ca_sha256: "ab".repeat(32),
      ca_pem: caPem,
      problem: null,
    },
    downloads_enabled: true,
    installer: {
      url: "https://vectory.example.test:8443/agent/v1/install.sh",
      sha256: sha256(installerScript),
      platforms: ["linux/amd64", "darwin/arm64"],
    },
    default_install_dir: "/usr/local/bin",
    releases: [],
    catalog_problems: [],
  });
const choices = (overrides: Partial<SetupChoices> = {}): SetupChoices => ({
  os: process.platform === "darwin" ? "darwin" : "linux",
  mode: "restricted",
  name: "",
  service: "auto",
  serviceUser: "",
  createUser: true,
  stateDir: "",
  managedConfig: "",
  capabilityPolicy: "",
  ...overrides,
});

// Stand-ins for curl and sudo. The curl one checks the options that keep the
// download on https, copies the CA file it was given, and writes the installer
// (or a different file, to play an altered download); the sudo one runs what it
// is given and says what it was asked to run.
const curlStandIn = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE/curl.args"
[ -z "$FAKE_CURL_FAIL" ] || exit 22
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --cacert) cp "$2" "$FAKE/ca.seen" 2>/dev/null || true ;;
  esac
  shift
done
ls -ld "$(dirname "$out")" | cut -c1-10 > "$FAKE/directory.mode"
dirname "$out" > "$FAKE/directory.path"
if [ -n "$FAKE_ALTERED" ]; then printf '#!/bin/sh\\necho altered\\n' > "$out"; else cp "$FAKE/installer.sh" "$out"; fi
`;
const sudoStandIn = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE/sudo.args"
cp "$2" "$FAKE/sudo.script"
exec "$@"
`;

const shells = ["sh", "bash", "zsh"].filter(
  (shell) => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0,
);
const check = process.platform === "darwin" ? "shasum" : "sha256sum";
const usable =
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", `command -v ${check}`]).status === 0;

describe.skipIf(!usable)("the install command, run", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "vectory-command-test-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Runs `command` in `shell`, in a fresh working directory and TMPDIR. */
  function run(
    shell: string,
    command: string,
    env: Record<string, string> = {},
  ) {
    const fake = mkdtempSync(join(root, "fake-"));
    const bin = join(fake, "bin");
    const work = join(fake, "work");
    const temp = join(fake, "tmp");
    for (const directory of [bin, work, temp]) mkdirSync(directory);
    writeFileSync(join(fake, "installer.sh"), installerScript);
    for (const [name, text] of [
      ["curl", curlStandIn],
      ["sudo", sudoStandIn],
    ]) {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    }
    const result = spawnSync(shell, ["-c", command], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: fake,
        TMPDIR: temp,
        FAKE: fake,
        ...env,
      },
    });
    const read = (name: string) =>
      existsSync(join(fake, name))
        ? readFileSync(join(fake, name), "utf8")
        : null;
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      work: readdirSync(work),
      temp: readdirSync(temp),
      curlArgs: read("curl.args"),
      sudoArgs: read("sudo.args"),
      sudoScript: read("sudo.script"),
      installerArgs: read("installer.args"),
      caSeen: read("ca.seen"),
      directoryMode: read("directory.mode"),
      directoryPath: read("directory.path")?.trim(),
      temporaryRoot: temp,
    };
  }

  describe.each(
    shells.flatMap((shell) =>
      (["readable", "one-line"] as const).map((presentation) => ({
        shell,
        presentation,
      })),
    ),
  )("in $shell ($presentation)", ({ shell, presentation }) => {
    it("downloads into a private directory, checks it, runs it and leaves nothing behind", () => {
      const command = installerCommand(install(), choices(), presentation)!;
      const result = run(shell, command);
      expect(result.output).toContain("OK");
      expect(result.status, result.output).toBe(0);
      // The installer ran from the directory the command made, once, with the
      // choices and nothing else.
      expect(result.installerArgs).toBe("--mode\nrestricted\n--create-user\n");
      expect(result.sudoScript).toBe(installerScript);
      expect(result.sudoArgs?.split("\n")[0]).toBe("sh");
      expect(result.directoryPath).not.toBeNull();
      expect(realpathSync(dirname(result.directoryPath!))).toBe(
        realpathSync(result.temporaryRoot),
      );
      expect(result.sudoArgs?.split("\n")[1]).toBe(
        `${result.directoryPath}/vectory-install.sh`,
      );
      // Only its user can enter that directory.
      expect(result.directoryMode).toBe("drwx------\n");
      // The files were never beside the person's own, and nothing is left.
      expect(result.work).toEqual([]);
      expect(result.temp).toEqual([]);
      // The download stays on https, even through a redirect, and trusts the
      // pinned CA certificate the command wrote, exactly.
      expect(result.curlArgs).toContain("--proto\n=https\n");
      expect(result.curlArgs).toContain("--proto-redir\n=https\n");
      expect(result.curlArgs).toContain(
        `--cacert\n${result.directoryPath}/vectory-ca.pem\n`,
      );
      expect(result.curlArgs).toContain(
        "https://vectory.example.test:8443/agent/v1/install.sh",
      );
      expect(result.caSeen).toBe(caPem);
    });

    it("never runs an installer that fails its check, and cleans up", () => {
      const command = installerCommand(install(), choices(), presentation)!;
      const result = run(shell, command, { FAKE_ALTERED: "1" });
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/FAILED|did NOT match/i);
      expect(result.sudoArgs).toBeNull();
      expect(result.installerArgs).toBeNull();
      expect(result.work).toEqual([]);
      expect(result.temp).toEqual([]);
    });

    it("stops when the download fails, and cleans up", () => {
      const command = installerCommand(install(), choices(), presentation)!;
      const result = run(shell, command, { FAKE_CURL_FAIL: "1" });
      expect(result.status).not.toBe(0);
      expect(result.sudoArgs).toBeNull();
      expect(result.work).toEqual([]);
      expect(result.temp).toEqual([]);
    });

    it("passes arguments with spaces and quotes through unchanged", () => {
      const command = installerCommand(
        install(),
        choices({
          name: "edge-01",
          managedConfig: "/srv/owner's data/vector.json",
          installDir: "/opt/vectory agent/bin",
          createUser: false,
          tokenFile: "/private/provisioning/owner's token.txt",
        }),
        presentation,
      )!;
      const result = run(shell, command);
      expect(result.status, result.output).toBe(0);
      expect(result.installerArgs).toBe(
        [
          "--mode",
          "restricted",
          "--install-dir",
          "/opt/vectory agent/bin",
          "--name",
          "edge-01",
          "--managed-config",
          "/srv/owner's data/vector.json",
          "--token-file",
          "/private/provisioning/owner's token.txt",
          "",
        ].join("\n"),
      );
    });

    it("trusts a CA file on the host, or the host's own store, without writing a certificate", () => {
      const withFile = run(
        shell,
        installerCommand(
          install(),
          choices({ trust: "file", caFile: "/etc/vectory/server ca.pem" }),
          presentation,
        )!,
        {},
      );
      // The stand-in reads --cacert, so give it a file at that path's place:
      // the check here is the argument, passed as one word.
      expect(withFile.curlArgs).toContain(
        "--cacert\n/etc/vectory/server ca.pem\n",
      );
      const system = run(
        shell,
        installerCommand(
          install(true),
          choices({ trust: "system" }),
          presentation,
        )!,
      );
      expect(system.status).toBe(0);
      expect(system.curlArgs).not.toContain("--cacert");
      expect(system.installerArgs).toBe(
        "--mode\nrestricted\n--ca-file=\n--create-user\n",
      );
      expect(system.work).toEqual([]);
      expect(system.temp).toEqual([]);
    });
  });
});
