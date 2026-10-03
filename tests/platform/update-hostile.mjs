// Running tests/platform/hostile-update-server on the runner: building it,
// putting it in the place of the instance's agent listener, steering it, and
// putting the instance back. The program itself says what each scenario is; this
// file only runs it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { agentPort, previewDir } from "./instance.mjs";
import { outputRoot, root, run, sleep, until } from "./lib.mjs";

export const controlPort = process.env.VECTORY_HOSTILE_CONTROL_PORT || "8665";
const sourceDir = path.join(root, "tests", "platform", "hostile-update-server");

/** Builds the program into `directory` and returns its path. */
export function buildHostileServer(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, "hostile-update-server");
  run("go", ["build", "-o", binary, "."], {
    cwd: sourceDir,
    timeoutMs: 300000,
  });
  return binary;
}

/** The instance's own files the program borrows: its keys and its listener's TLS chain. */
export function instanceFiles() {
  return {
    keys: path.join(previewDir, "state", "keys"),
    chain: path.join(previewDir, "agent-chain.pem"),
    key: path.join(root, ".local", "pki", "server-key.pem"),
    ca: path.join(root, ".local", "pki", "ca.pem"),
  };
}

/** Stops the instance (its agent listener and its validator) and starts it again. */
export const instance = {
  stop() {
    run(path.join(root, "scripts", "preview.sh"), ["stop"], { cwd: root });
  },
  start() {
    run(path.join(root, "scripts", "preview.sh"), ["start"], {
      cwd: root,
      timeoutMs: 180000,
    });
  },
};

/**
 * Starts the program as root with the arguments `serve` takes, in place of the
 * instance's agent listener (which must be stopped), and returns a handle: call
 * the control with `ask`, read what it says with `state`, end it with `stop`.
 */
export async function startHostile({ binary, args, logName }) {
  const token = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(outputRoot, { recursive: true });
  const logFile = path.join(outputRoot, logName);
  const log = fs.openSync(logFile, "w");
  const files = instanceFiles();
  const serveArgs = [
    "serve",
    "--listen",
    `127.0.0.1:${agentPort}`,
    "--control",
    `127.0.0.1:${controlPort}`,
    "--token",
    token,
    "--keys",
    files.keys,
    "--tls-chain",
    files.chain,
    "--tls-key",
    files.key,
    ...args,
  ];
  // It reads the instance's private keys and the agent's private state, so it runs as root.
  const asRoot = process.getuid?.() === 0;
  const child = spawn(
    asRoot ? binary : "sudo",
    asRoot ? serveArgs : ["-n", binary, ...serveArgs],
    { stdio: ["ignore", log, log], detached: true },
  );
  child.unref();
  let exited = null;
  child.on("exit", (code) => {
    exited = code ?? "a signal";
  });
  await until(
    "the stand-in listener is up",
    () => {
      if (exited !== null)
        throw new Error(
          `The stand-in listener exited (${exited}):\n${fs.readFileSync(logFile, "utf8")}`,
        );
      return fs.readFileSync(logFile, "utf8").includes("control ");
    },
    { timeoutMs: 30000, intervalMs: 250 },
  );

  const ask = async (method, endpoint, body) => {
    const response = await fetch(`http://127.0.0.1:${controlPort}${endpoint}`, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: { "X-Hostile-Token": token, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    return { status: response.status, value };
  };
  return {
    log: logFile,
    ask,
    scenario: async (name) => {
      const answer = await ask("POST", "/scenario", { name });
      if (answer.status !== 200)
        throw new Error(
          `The stand-in listener refused the scenario ${name}: ${answer.status} ${JSON.stringify(answer.value)}`,
        );
    },
    bundle: async (mode) => {
      const answer = await ask("POST", "/bundle", { mode });
      if (answer.status !== 200)
        throw new Error(`The key bundle mode ${mode}: ${answer.status}`);
    },
    state: async () => (await ask("GET", "/state")).value,
    async stop() {
      await ask("POST", "/stop").catch(() => {});
      for (let i = 0; i < 50 && exited === null; i += 1) await sleep(200);
      if (exited === null) child.kill();
      fs.closeSync(log);
    },
  };
}

/**
 * What the agent said about a scenario's offer: the `agent_update` member of the
 * newest check-in answered with it, from the second on. A check-in reports what
 * the agent made of the answer to the one before, so the first one answered with an
 * offer still describes the scenario that came earlier.
 */
export function verdictOn(state, scenario) {
  const beats = (state.recent ?? []).filter(
    (beat) => beat.scenario === scenario && beat.answered_with_offer,
  );
  return beats.length >= 2
    ? (beats[beats.length - 1].agent_update ?? null)
    : null;
}
