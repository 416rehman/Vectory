// Separate expected observation: actual App, synthetic committed-response-loss transport.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(root, ".local/agent-settings-create-observation");
await mkdir(output, { recursive: true });
const sources = [
  "dashboard/src/Control.tsx",
  "dashboard/src/App.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "server/src/api.rs",
  "server/src/db.rs",
  "dashboard/tests/agent-settings-create-observation.mjs",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(resolve(root, p)))
          .digest("hex"),
      ]),
    ),
  );
const sourceStart = await hashes();
const socket = net.createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
});
await vite.listen();
const origin = `http://127.0.0.1:${port}`,
  browser = await chromium.launch(),
  context = await browser.newContext({ viewport: { width: 899, height: 920 } }),
  page = await context.newPage();
await context.addInitScript(() => {
  localStorage.setItem("vectory-theme", "light");
  localStorage.setItem("vectory-sidebar-collapsed", "true");
});
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  records = [],
  posts = [],
  requests = [],
  unexpected = [],
  errors = [];
let failure;
page.on("pageerror", (e) => errors.push(e.message));
await context.route("**/*", async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    method = req.method();
  if (url.origin !== origin) {
    unexpected.push(`External ${url.origin}`);
    return route.abort();
  }
  if (!url.pathname.startsWith("/api/v1/")) return route.continue();
  const path = url.pathname.slice(7),
    body = method === "POST" ? JSON.parse(req.postData() || "{}") : null;
  requests.push({ method, path, ...(body ? { body } : {}) });
  const reply = (json) => route.fulfill({ json });
  if (method === "GET") {
    if (path === "/status")
      return reply({ initialized: true, version: "synthetic" });
    if (path === "/session")
      return reply({
        user: {
          id: id(90),
          name: "Synthetic operator",
          email: "fixture@example.test",
          role: "admin",
          enabled: true,
          revision: 1,
        },
        csrf_token: "synthetic",
      });
    if (path === "/settings")
      return reply({ instance_name: "Synthetic policy observation" });
    if (path === "/mfa") return reply({ enabled: false });
    if (path === "/policies") return reply(records);
  }
  if (method === "POST" && path === "/policies") {
    expect(req.headers()["x-csrf-token"]).toBe("synthetic");
    posts.push(body);
    const record = {
      id: id(posts.length),
      ...body,
      created_at: "2026-09-27T12:00:00Z",
    };
    records.push(record);
    if (posts.length === 1) return route.abort("failed");
    return reply(record);
  }
  unexpected.push(`${method} ${path}`);
  return route.fulfill({
    status: 500,
    json: {
      error: {
        code: "UNEXPECTED_ROUTE",
        message: "Synthetic route not modeled",
      },
    },
  });
});
try {
  await page.goto(`${origin}/#/policies`);
  await expect(
    page.getByRole("heading", { name: "Agent settings", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create settings", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New agent settings",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Settings name", exact: true })
    .fill("Synthetic ambiguous saved settings");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled();
  expect(posts).toHaveLength(1);
  expect(records).toHaveLength(1);
  expect(posts[0]).not.toHaveProperty("request_id");
  await page.screenshot({
    path: resolve(output, "policy-create-response-lost.png"),
  });
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => records.length).toBe(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(records[0].id).not.toBe(records[1].id);
  expect(
    requests.filter((r) => r.method !== "GET" && r.path !== "/policies"),
  ).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
  await expect(
    page.getByRole("cell", {
      name: "Synthetic ambiguous saved settings",
      exact: true,
    }),
  ).toHaveCount(2);
  await page.screenshot({ path: resolve(output, "policy-create-retried.png") });
} catch (e) {
  failure = e;
  throw e;
} finally {
  const sourceEnd = await hashes();
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        passed: !failure,
        classification: "expected_defect_observation",
        correctness_acceptance: false,
        scope:
          "Actual App synthetic response-loss workflow, not native server execution. Server source inspection independently shows fresh UUID/audit per unkeyed POST; this fixture does not prove server behavior. No actual credentials, fleet state, process activation, live preview or release changes.",
        observations: {
          committedSyntheticFirstResponseLost: true,
          explicitResubmitAvailable: true,
          identicalUnkeyedPosts: posts,
          syntheticRecords: records,
          automaticDeployment: false,
        },
        requests,
        unexpected,
        errors,
        source_sha256_at_start: sourceStart,
        source_sha256: sourceEnd,
        source_changes_during_run: Object.keys(sourceStart).filter(
          (p) => sourceStart[p] !== sourceEnd[p],
        ),
        ...(failure
          ? {
              failure: failure.message,
              body_at_failure: await page.locator("body").innerText(),
            }
          : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await vite.close();
  console.log("Evidence: .local/agent-settings-create-observation/report.json");
}
