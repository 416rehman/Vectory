// Actual recovery component; all transport and device state are isolated synthetic fixtures.
import { createServer, transformWithEsbuild } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_DEVICE_RETRY_OUTPUT || ".local/device-retry",
);
const before = process.env.VECTORY_DEVICE_RETRY_BEFORE === "1";
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const virtual = "\0virtual:device-retry";
const fixture = [
  "import React,{useState,useRef}from'react';import{createRoot}from'react-dom/client';",
  "import{DeviceRecoveryActions}from'/src/RecoveryActions.tsx';import{api}from'/src/api.ts';import'/src/styles.css';",
  "const root=createRoot(document.getElementById('root'));let sequence=0;",
  "function Fixture({initial,user}){const[device,setDevice]=useState(initial),[currentUser,setCurrentUser]=useState(user),[refreshError,setRefreshError]=useState('');const latest=useRef(device.id);latest.current=device.id;",
  "window.changeDevice=next=>setDevice(next);window.changeUser=next=>setCurrentUser(next);window.currentDevice=device;",
  "async function refresh(){window.refreshes++;const id=device.id;try{const next=await api('/devices/'+id);if(latest.current===id){setDevice(next);setRefreshError('');}}catch(e){setRefreshError(e.message);throw e;}}",
  "return <main style={{maxWidth:650,margin:'0 auto',padding:20}}><h1>Device application</h1><p>Isolated synthetic fixture</p><p aria-label='Shown assignment'>{device.desired_version_id||'Unassigned'} / {device.desired_generation}</p><p aria-label='Shown state'>{device.apply_state}</p><DeviceRecoveryActions device={device} user={currentUser} onRefresh={refresh} onDone={message=>{window.messages.push(message);void refresh().catch(()=>{});}}/>{refreshError&&<p role='alert'>{refreshError}</p>}</main>}",
  "window.renderRetry=(initial,user)=>{window.messages=[];window.refreshes=0;root.render(<Fixture key={++sequence} initial={initial} user={user}/>);};window.unmountRetry=()=>root.render(null);window.ready=true;",
].join("\n");
const sourceFiles = [
  "dashboard/src/RecoveryActions.tsx",
  "dashboard/src/Fleet.tsx",
  "dashboard/src/api.ts",
  "dashboard/src/ui.tsx",
  "dashboard/src/DeviceRecoveryAuthorization.tsx",
  "dashboard/src/deviceRecoveryRequests.ts",
  "dashboard/tests/device-retry-browser.mjs",
  "docs/user/telemetry.md",
];
async function sourceHashes() {
  return Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(repository, file)))
          .digest("hex"),
      ]),
    ),
  );
}
const sourceStart = await sourceHashes();
const vite = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "device-retry-fixture",
      resolveId(id) {
        if (id === "virtual:device-retry") return virtual;
      },
      async load(id) {
        if (id === virtual)
          return (
            await transformWithEsbuild(fixture, "device-retry.tsx", {
              loader: "tsx",
              jsx: "automatic",
            })
          ).code;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__device-retry") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic retry check</title></head><body><div id="root"></div><script type="module">import "virtual:device-retry";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const origin = "http://127.0.0.1:" + port;
const browser = await chromium.launch();
const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const device = (overrides = {}) => ({
  id: id(1),
  name: "Synthetic edge",
  status: "online",
  apply_state: "failed",
  desired_version_id: id(11),
  desired_generation: 8,
  reported_generation: 7,
  sync_paused: false,
  local_paused: false,
  retry_preconditions: true,
  ...overrides,
});
const user = (role) => ({
  id: id(100),
  name: "Synthetic operator",
  email: "fixture@example.invalid",
  role,
  enabled: true,
  revision: 1,
});
const results = [],
  requests = [],
  unexpected = [],
  errors = [],
  accessibility = [],
  screenshots = [];
let page, context, state, failure;
async function load({
  shown = device(),
  current = shown,
  role = "operator",
  mode = "success",
  width = 899,
  theme = "light",
} = {}) {
  if (context) await context.close();
  state = { current, mode, held: null, reads: 0, posts: 0 };
  const local = state;
  context = await browser.newContext({
    viewport: { width, height: 850 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
  }, theme);
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice(7),
      method = request.method(),
      body = request.postDataJSON();
    requests.push({ method, path, body });
    const json = (status, value) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (method === "GET" && path === "/devices/" + id(1)) {
      local.reads++;
      if (local.holdReads) {
        local.heldRead = route;
        return;
      }
      if (local.failRead)
        return json(503, {
          error: { code: "UNAVAILABLE", message: "Status refresh unavailable" },
        });
      return json(200, local.current);
    }
    if (method === "POST" && path === "/devices/" + id(1) + "/retry") {
      local.posts++;
      if (local.mode === "hold") {
        local.held = route;
        (local.heldRequests ||= []).push(route);
        return;
      }
      if (local.mode === "lost") {
        local.current = device({
          desired_generation: 9,
          apply_state: "desired",
        });
        return route.abort("connectionreset");
      }
      if (local.mode === "malformed")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{",
        });
      if (local.mode === "wrong-scope")
        return json(200, device({ id: id(2), desired_generation: 9 }));
      if (local.mode === "denied")
        return json(403, {
          error: { code: "FORBIDDEN", message: "Access changed" },
        });
      if (local.mode === "error")
        return json(503, {
          error: { code: "UNAVAILABLE", message: "Retry outcome unavailable" },
        });
      if (
        body?.expected_version_id !== local.current.desired_version_id ||
        body?.expected_generation !== local.current.desired_generation
      )
        return json(409, {
          error: {
            code: "STALE_DEVICE_REVIEW",
            message: "The assignment changed. Review current device state.",
          },
        });
      local.current = {
        ...local.current,
        desired_generation: local.current.desired_generation + 1,
        apply_state: "desired",
      };
      return json(200, local.current);
    }
    if (method === "POST" && path === "/devices/" + id(1) + "/recover")
      return json(200, { token: "synthetic-one-time-token" });
    unexpected.push(method + " " + path);
    return json(500, {
      error: { code: "UNEXPECTED", message: "Unexpected fixture request" },
    });
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/__device-retry");
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, theme);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(({ shown, user }) => window.renderRetry(shown, user), {
    shown,
    user: user(role),
  });
  await expect(
    page.getByRole("heading", { name: "Device application" }),
  ).toBeVisible();
}
const retry = () => page.getByRole("button", { name: /Retry application$/ });
// Observe the real API's AbortSignal. Optional body holding deliberately ignores
// abort in text(), proving the owner cancels even when a body promise hangs.
async function observeTransport(holdBody = false, kind = "retry") {
  await page.evaluate(
    ({ holdBody, kind }) => {
      const original = window.fetch.bind(window);
      window.retryTransport = { calls: 0, aborted: 0, bodyHeld: false };
      window.fetch = async (input, options) => {
        const watched =
          kind === "retry"
            ? String(input).endsWith("/retry") && options?.method === "POST"
            : /\/devices\/[^/?]+$/.test(String(input)) &&
              (options?.method || "GET") === "GET";
        if (watched) {
          window.retryTransport.calls++;
          options.signal.addEventListener(
            "abort",
            () => window.retryTransport.aborted++,
            { once: true },
          );
        }
        const response = await original(input, options);
        if (!watched || !holdBody) return response;
        const body = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          text: () => {
            window.retryTransport.bodyHeld = true;
            return new Promise((resolve) => {
              window.releaseRetryBody = () => resolve(body);
            });
          },
        };
      };
    },
    { holdBody, kind },
  );
}
const acceptedRetry = (generation) =>
  device({ desired_generation: generation, apply_state: "desired" });
async function deliverRetry(route, result) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(result),
  });
}
async function group(name, run) {
  const start = Date.now();
  try {
    await run();
    results.push({ name, passed: true, milliseconds: Date.now() - start });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    throw error;
  }
}
try {
  await group(
    "stale displayed version/generation is submitted exactly; rejection refreshes without retrying the replacement",
    async () => {
      await load({
        current: device({ desired_version_id: id(12), desired_generation: 9 }),
      });
      const begin = requests.length;
      await retry().click();
      await expect
        .poll(
          () => requests.slice(begin).filter((x) => x.method === "POST").length,
        )
        .toBe(1);
      expect(
        requests.slice(begin).find((x) => x.method === "POST").body,
      ).toEqual({ expected_version_id: id(11), expected_generation: 8 });
      await expect(page.getByLabel("Shown assignment")).toContainText(
        id(12) + " / 9",
      );
      expect(state.posts).toBe(1);
      expect(await page.evaluate(() => window.messages)).toEqual([]);
    },
  );
  if (!before) {
    await group(
      "synchronous duplicate activation is latched and real failed-update semantics remain retryable",
      async () => {
        await load({ mode: "hold" });
        await retry().evaluate((button) => {
          button.click();
          button.click();
        });
        await expect.poll(() => state.posts).toBe(1);
        expect(requests.at(-1).body).toEqual({
          expected_version_id: id(11),
          expected_generation: 8,
        });
        await expect(retry()).toBeDisabled();
        state.current = device({
          desired_generation: 9,
          apply_state: "desired",
        });
        await state.held.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(state.current),
        });
        await expect(page.getByLabel("Shown assignment")).toContainText("/ 9");
        await expect
          .poll(() => page.evaluate(() => window.messages.length))
          .toBe(1);
        expect((await page.evaluate(() => window.messages))[0]).not.toMatch(
          /applied|succeeded/i,
        );
        expect(state.posts).toBe(1);
      },
    );
    await group(
      "lost response and unreadable success refresh status without assuming failure or resubmitting",
      async () => {
        for (const mode of ["lost", "malformed", "wrong-scope", "error"]) {
          await load({ mode });
          await retry().click();
          await expect.poll(() => state.reads).toBeGreaterThan(0);
          expect(state.posts).toBe(1);
          expect(await page.evaluate(() => window.messages)).toEqual([]);
          if (mode === "lost") {
            await expect(page.getByLabel("Shown state")).toHaveText("desired");
            await expect(page.getByRole("status")).toHaveCount(0);
          } else {
            await expect(page.getByRole("status")).toContainText(
              "Status refreshed. The reviewed assignment is still eligible",
            );
            await expect(page.getByRole("status")).not.toContainText(
              "Checking current device status",
            );
          }
        }
      },
    );
    await group(
      "pause, access and changed-device state remain truthful; recovery authorization stays separate",
      async () => {
        await load({ shown: device({ retry_preconditions: undefined }) });
        await expect(retry()).toBeDisabled();
        await expect(
          page.getByText(/Retry requires a newer server/),
        ).toBeVisible();
        expect(state.posts).toBe(0);
        for (const patch of [{ local_paused: true }, { sync_paused: true }]) {
          await load({ shown: device(patch) });
          await expect(retry()).toBeDisabled();
          await expect(page.getByText(/Resume .*sync/)).toBeVisible();
          expect(state.posts).toBe(0);
        }
        await load({ role: "viewer" });
        await expect(retry()).toHaveCount(0);
        await load({ role: "operator", mode: "denied" });
        await retry().click();
        await expect(
          page.getByText("Access changed", { exact: true }),
        ).toBeVisible();
        await page.evaluate(
          (next) => window.changeDevice(next),
          device({
            id: id(2),
            name: "Other device",
            desired_version_id: id(12),
            desired_generation: 4,
          }),
        );
        await expect(
          page.getByText("Access changed", { exact: true }),
        ).toHaveCount(0);
        await load({ role: "admin" });
        await page.getByText("Device recovery", { exact: true }).click();
        await page
          .getByRole("button", { name: "Authorize device recovery" })
          .click();
        await expect(
          page.getByRole("dialog", { name: "Recover Synthetic edge" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(state.posts).toBe(0);
      },
    );
    await group(
      "a held retry deadline becomes uncertain and checks status without a second mutation",
      async () => {
        await load({ mode: "hold" });
        await page.clock.install();
        await retry().click();
        await expect.poll(() => !!state.held).toBe(true);
        await page.clock.fastForward(31000);
        await expect(page.getByRole("status")).toContainText(
          "Status refreshed.",
        );
        await expect.poll(() => state.reads).toBeGreaterThan(0);
        await expect(retry()).toBeEnabled();
        expect(state.posts).toBe(1);
        expect(await page.evaluate(() => window.messages)).toEqual([]);
      },
    );
    await group(
      "a stalled status read cannot hold the UI forever and cannot enable retry without a fresh snapshot",
      async () => {
        await load({ mode: "error" });
        state.holdReads = true;
        await page.clock.install();
        await retry().click();
        await expect.poll(() => state.reads).toBe(1);
        await page.clock.fastForward(31000);
        await expect(
          page.getByRole("button", { name: "Check status", exact: true }),
        ).toBeEnabled();
        await expect(retry()).toBeDisabled();
        await expect(
          page.getByText(/Current device status could not be refreshed/),
        ).toBeVisible();
        await expect(page.getByRole("status")).toContainText(
          "Status could not be refreshed. No further retry was sent.",
        );
        expect(state.posts).toBe(1);
        state.holdReads = false;
        await page
          .getByRole("button", { name: "Check status", exact: true })
          .click();
        await expect(retry()).toBeEnabled();
        expect(state.posts).toBe(1);
      },
    );
    await group(
      "a delayed response cannot report success for another shown assignment and refresh errors remain visible",
      async () => {
        await load({ mode: "hold" });
        await retry().click();
        await expect.poll(() => !!state.held).toBe(true);
        await page.evaluate(
          (next) => window.changeDevice(next),
          device({ desired_version_id: id(12), desired_generation: 12 }),
        );
        await state.held.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            device({ desired_generation: 9, apply_state: "desired" }),
          ),
        });
        await expect(retry()).toBeEnabled();
        expect(await page.evaluate(() => window.messages)).toEqual([]);
        await load({ mode: "error" });
        state.failRead = true;
        await retry().click();
        await expect(
          page.getByText("Status refresh unavailable", { exact: true }),
        ).toBeVisible();
        expect(state.posts).toBe(1);
      },
    );
    await group(
      "unmount aborts held retry headers and bodies without late completion feedback",
      async () => {
        for (const holdBody of [false, true]) {
          await load({ mode: holdBody ? "success" : "hold" });
          await observeTransport(holdBody);
          await retry().click();
          if (holdBody)
            await expect
              .poll(() => page.evaluate(() => window.retryTransport.bodyHeld))
              .toBe(true);
          else await expect.poll(() => !!state.held).toBe(true);
          await page.evaluate(() => window.unmountRetry());
          await expect
            .poll(() => page.evaluate(() => window.retryTransport.aborted))
            .toBe(1);
          if (holdBody) await page.evaluate(() => window.releaseRetryBody());
          else await deliverRetry(state.held, acceptedRetry(9));
          await page.waitForTimeout(60);
          expect(await page.evaluate(() => window.messages)).toEqual([]);
          expect(await page.evaluate(() => window.refreshes)).toBe(0);
          expect(state.posts).toBe(1);
          expect(state.reads).toBe(0);
        }
      },
    );
    await group(
      "a new assignment is immediately usable and an old result cannot release its new retry latch",
      async () => {
        await load({ mode: "hold" });
        await observeTransport();
        await retry().click();
        await expect.poll(() => state.posts).toBe(1);
        const old = state.held;
        const next = device({
          desired_version_id: id(12),
          desired_generation: 12,
        });
        state.current = next;
        await page.evaluate((next) => window.changeDevice(next), next);
        await expect(retry()).toBeEnabled();
        await expect
          .poll(() => page.evaluate(() => window.retryTransport.aborted))
          .toBe(1);
        await retry().click();
        await expect.poll(() => state.posts).toBe(2);
        const current = state.held;
        await deliverRetry(old, acceptedRetry(9));
        await page.waitForTimeout(60);
        await expect(retry()).toBeDisabled();
        expect(await page.evaluate(() => window.messages)).toEqual([]);
        state.current = {
          ...next,
          desired_generation: 13,
          apply_state: "desired",
        };
        await deliverRetry(current, state.current);
        await expect
          .poll(() => page.evaluate(() => window.messages.length))
          .toBe(1);
        await expect(page.getByLabel("Shown assignment")).toContainText("/ 13");
        expect(state.posts).toBe(2);
      },
    );
    await group(
      "pause, revocation, eligibility and support changes cannot revive an old same-assignment request",
      async () => {
        for (const patch of [
          { local_paused: true },
          { sync_paused: true },
          { status: "revoked" },
          { apply_state: "applied" },
          { retry_preconditions: false },
        ]) {
          await load({ mode: "hold" });
          await observeTransport();
          await retry().click();
          await expect.poll(() => !!state.held).toBe(true);
          await page.evaluate(
            (next) => window.changeDevice(next),
            device(patch),
          );
          await expect
            .poll(() => page.evaluate(() => window.retryTransport.aborted))
            .toBe(1);
          await page.evaluate((next) => window.changeDevice(next), device());
          await expect(retry()).toBeEnabled();
          await deliverRetry(state.held, acceptedRetry(9));
          await page.waitForTimeout(60);
          expect(await page.evaluate(() => window.messages)).toEqual([]);
          expect(await page.evaluate(() => window.refreshes)).toBe(0);
          await expect(page.getByLabel("Shown assignment")).toContainText(
            "/ 8",
          );
          expect(state.posts).toBe(1);
        }
      },
    );
    await group(
      "the directly mounted retry controller retires old work across role loss and restoration",
      async () => {
        await load({ mode: "hold" });
        await observeTransport();
        await retry().click();
        await expect.poll(() => !!state.held).toBe(true);
        await page.evaluate((next) => window.changeUser(next), user("viewer"));
        await expect(retry()).toHaveCount(0);
        await expect
          .poll(() => page.evaluate(() => window.retryTransport.aborted))
          .toBe(1);
        await page.evaluate(
          (next) => window.changeUser(next),
          user("operator"),
        );
        await expect(retry()).toBeEnabled();
        await deliverRetry(state.held, acceptedRetry(9));
        await page.waitForTimeout(60);
        expect(await page.evaluate(() => window.messages)).toEqual([]);
        expect(state.posts).toBe(1);
        expect(state.reads).toBe(0);
      },
    );
    await group(
      "an uncertain retry's held status read cannot revive eligibility after pause and resume",
      async () => {
        for (const holdBody of [false, true]) {
          await load({ mode: "error" });
          state.holdReads = !holdBody;
          await observeTransport(holdBody, "status");
          await retry().click();
          if (holdBody)
            await expect
              .poll(() => page.evaluate(() => window.retryTransport.bodyHeld))
              .toBe(true);
          else await expect.poll(() => !!state.heldRead).toBe(true);
          await page.evaluate(
            (next) => window.changeDevice(next),
            device({ sync_paused: true }),
          );
          await expect
            .poll(() => page.evaluate(() => window.retryTransport.aborted))
            .toBe(1);
          await page.evaluate((next) => window.changeDevice(next), device());
          await expect(retry()).toBeEnabled();
          if (holdBody) await page.evaluate(() => window.releaseRetryBody());
          else await deliverRetry(state.heldRead, device());
          await page.waitForTimeout(60);
          await expect(page.getByRole("status")).toHaveCount(0);
          expect(await page.evaluate(() => window.messages)).toEqual([]);
          expect(await page.evaluate(() => window.refreshes)).toBe(0);
          expect(state.posts).toBe(1);
          expect(state.reads).toBe(1);
        }
      },
    );
    await group(
      "session invalidation retires a held body without status reads or late success",
      async () => {
        await load({ mode: "success" });
        await observeTransport(true);
        await retry().click();
        await expect
          .poll(() => page.evaluate(() => window.retryTransport.bodyHeld))
          .toBe(true);
        await page.evaluate(async () => {
          const { invalidateSession } = await import("/src/api.ts");
          invalidateSession();
        });
        await expect
          .poll(() => page.evaluate(() => window.retryTransport.aborted))
          .toBe(1);
        await page.evaluate(() => window.releaseRetryBody());
        await page.waitForTimeout(60);
        expect(await page.evaluate(() => window.messages)).toEqual([]);
        expect(await page.evaluate(() => window.refreshes)).toBe(0);
        expect(state.posts).toBe(1);
        expect(state.reads).toBe(0);
      },
    );
    await group(
      "an independent recovery authorization review survives retry-context changes",
      async () => {
        await load({ role: "admin" });
        await page.getByText("Device recovery", { exact: true }).click();
        await page
          .getByRole("button", { name: "Authorize device recovery" })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Recover Synthetic edge",
        });
        await expect(dialog).toBeVisible();
        for (const next of [
          device({ desired_version_id: id(12), desired_generation: 12 }),
          device({
            desired_version_id: id(12),
            desired_generation: 12,
            local_paused: true,
          }),
        ]) {
          await page.evaluate((next) => window.changeDevice(next), next);
          await expect(dialog).toBeVisible();
          await expect(page.getByRole("dialog")).toHaveCount(1);
        }
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(state.posts).toBe(0);
        expect(state.reads).toBe(0);
        expect(await page.evaluate(() => window.messages)).toEqual([]);
      },
    );
    await group(
      "retry notices fit mobile/light/dark and remain keyboard and screen-reader accessible",
      async () => {
        for (const width of [899, 375])
          for (const theme of ["light", "dark"]) {
            await load({ mode: "error", width, theme });
            await retry().click();
            await expect(page.getByRole("status")).toContainText(
              "Status refreshed. The reviewed assignment is still eligible",
            );
            const result = await new AxeBuilder({ page }).analyze();
            accessibility.push({ width, theme, violations: result.violations });
            expect(result.violations).toEqual([]);
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(width);
            const path = resolve(
              output,
              "device-retry-" + width + "-" + theme + ".png",
            );
            await page.screenshot({ path, fullPage: true });
            screenshots.push(relative(repository, path));
          }
      },
    );
  }
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  console.error(error.message);
} finally {
  const source_sha256 = await sourceHashes();
  const source_changes = sourceFiles.filter(
    (file) => sourceStart[file] !== source_sha256[file],
  );
  if (source_changes.length && !failure)
    failure = new Error("Reviewed sources changed during the browser run");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual DeviceRecoveryActions React component, isolated synthetic transport and a host simulating parent refresh. No live API, native agent, real token or activation.",
        passed: !failure,
        results,
        requests,
        unexpected,
        errors,
        accessibility,
        screenshots,
        source_start_sha256: sourceStart,
        source_sha256,
        source_changes,
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await vite.close();
}
if (failure) process.exitCode = 1;
