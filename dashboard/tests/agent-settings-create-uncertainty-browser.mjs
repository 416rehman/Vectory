// Regression check: an agent-settings create whose reply is lost never becomes a
// second record by itself. Actual App, synthetic committed-response-loss transport.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_AGENT_SETTINGS_CREATE_UNCERTAINTY_OUTPUT ||
    ".local/agent-settings-create-uncertainty",
);
await mkdir(output, { recursive: true });
const sources = [
  "dashboard/src/AgentSettingsCreation.tsx",
  "dashboard/src/App.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "server/src/api.rs",
  "server/src/db.rs",
  "dashboard/tests/agent-settings-create-uncertainty-browser.mjs",
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
  actor = id(90),
  at = "2026-09-27T12:00:00Z",
  records = [],
  registry = new Map(),
  posts = [],
  lookups = [],
  requests = [],
  unexpected = [],
  errors = [];
let failure,
  loseReply = true;
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
          id: actor,
          name: "Synthetic operator",
          email: "fixture@example.test",
          role: "admin",
          enabled: true,
          revision: 1,
        },
        csrf_token: "synthetic",
      });
    if (path === "/settings")
      return reply({ instance_name: "Synthetic settings create check" });
    if (path === "/mfa") return reply({ enabled: false });
    // The page looks for settings applied without saving in the history.
    if (path === "/deployments/history")
      return reply({ items: [], total: 0, page: 1, page_size: 50 });
    if (path === "/policies")
      return reply(
        records.map(({ request_id, create_idempotency, ...rest }) => rest),
      );
    // The server remembers each create request by its key.
    const match = path.match(/^\/policies\/requests\/([^/]+)$/);
    if (match) {
      lookups.push(match[1]);
      const entry = registry.get(match[1]);
      return reply({
        create_idempotency: true,
        request_id: match[1],
        found: !!entry,
        ...(entry ? { policy: structuredClone(entry) } : {}),
      });
    }
    if (path === "/policies/requests")
      return reply({
        create_idempotency: true,
        items: [],
        total: 0,
        page: 1,
        page_size: 12,
      });
  }
  if (method === "POST" && path === "/policies") {
    expect(req.headers()["x-csrf-token"]).toBe("synthetic");
    posts.push(body);
    // The same key with the same request returns the record already created.
    let record = registry.get(body.request_id);
    if (!record) {
      record = {
        id: id(100 + records.length),
        name: body.name,
        policy: structuredClone(body.policy),
        created_at: at,
        request_id: body.request_id,
        create_idempotency: true,
      };
      records.push(record);
      registry.set(body.request_id, record);
    }
    if (loseReply) {
      loseReply = false;
      return route.abort("failed");
    }
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
const storage = () =>
  page.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage).filter(([k]) =>
        k.startsWith("vectory:agent-settings-operation:"),
      ),
    ),
  );
try {
  await page.goto(`${origin}/#/policies`);
  await expect(
    page.getByRole("heading", { name: "Agent settings", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^(New settings|Create settings)$/ })
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
    .getByRole("spinbutton", {
      name: "Check-in interval (seconds)",
      exact: true,
    })
    .fill("180");
  await dialog
    .getByRole("switch", { name: /Pause configuration sync/ })
    .check();
  await dialog
    .getByRole("switch", { name: /Collect operational metrics/ })
    .uncheck();
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  // The create was committed and its reply lost: the form says it can't tell
  // and holds the exact request instead of offering a blind resend.
  const review = page.getByRole("dialog", {
    name: "Review settings request",
    exact: true,
  });
  await expect(review.getByRole("alert")).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(records).toHaveLength(1);
  expect(posts[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.keys(await storage())).toHaveLength(1);
  await page.screenshot({
    path: resolve(output, "policy-create-response-lost.png"),
  });
  // The reminder survives a reload; reviewing it reads its status and finds the
  // one record the server made.
  await page.reload();
  await page
    .getByRole("button", { name: "Review settings requests", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Saved settings requests", exact: true })
    .getByRole("button")
    .filter({ hasText: /Synthetic/ })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Agent settings saved", exact: true }),
  ).toBeVisible();
  expect(lookups.length).toBeGreaterThanOrEqual(1);
  expect(posts).toHaveLength(1);
  expect(records).toHaveLength(1);
  expect(await storage()).toEqual({});
  expect(
    requests.filter((r) => r.method !== "GET" && r.path !== "/policies"),
  ).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: resolve(output, "policy-create-confirmed.png"),
  });
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
        scope:
          "Regression check on the actual App with a synthetic response-loss transport, not native server execution. A committed create's reply is lost; the form holds the exact keyed request, the browser keeps a reminder across a reload, and reviewing it reads the request's status and finds the one record, so no second record is created. Server idempotency is covered by the server tests, not established by this fixture. No credentials, fleet state, process activation, live preview or release changes.",
        observations: {
          committedSyntheticFirstReplyLost: true,
          keyedPosts: posts,
          statusLookups: lookups,
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
  console.log(
    failure
      ? "FAIL " + failure.message
      : "PASS a lost agent-settings create reply never creates a second record by itself",
  );
}
