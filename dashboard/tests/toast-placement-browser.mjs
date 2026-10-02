// The real notification stack in a browser, beside stand-ins for what holds the
// bottom of the screen: the editor's problems bar and the buttons at the foot of
// an open dialog. Notifications rest in the corner, rise above those while they
// are there, and settle back when they go. Nothing here contacts a server.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_TOAST_PLACEMENT_OUTPUT || ".local/toast-placement",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:toast-placement";
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "isolated-toast-placement",
      resolveId(id) {
        if (id === "virtual:toast-placement") return virtual;
      },
      load(id) {
        if (id === virtual)
          return `import React from 'react';import{createRoot}from'react-dom/client';import{ToastViewport,toast}from'/src/toast.tsx';import'/src/styles.css';window.toast=toast;createRoot(document.getElementById('root')).render(React.createElement(ToastViewport));window.ready=true;`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__toast-placement") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic notification placement</title></head><body><main id="main-content"><h1>Synthetic page</h1></main><div id="root"></div><script type="module">import "virtual:toast-placement";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const results = [],
  measurements = [],
  errors = [];
let context, page, failure;

async function load({ width = 1440, height = 900, theme = "light" } = {}) {
  if (context) await context.close();
  context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("vectory-theme", theme);
  }, theme);
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/__toast-placement`);
  await page.waitForFunction(() => window.ready);
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, theme);
}
/** A fixed box that stands in for something at the screen's edge. */
async function put(name, { left, right, bottom, top, height, dialog = false }) {
  await page.evaluate(
    ({ name, left, right, bottom, top, height, dialog }) => {
      const box = document.createElement("div");
      box.dataset.standIn = name;
      Object.assign(box.style, {
        position: "fixed",
        left: left === undefined ? "" : `${left}px`,
        right: right === undefined ? "" : `${right}px`,
        bottom: bottom === undefined ? "" : `${bottom}px`,
        top: top === undefined ? "" : `${top}px`,
        height: `${height}px`,
        background: "#d8dcea",
        border: "1px solid #7a83a6",
        zIndex: "10",
      });
      if (dialog) {
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "Stand-in dialog");
        Object.assign(box.style, { left: "0px", right: "0px", top: "0px" });
        box.style.height = "100%";
        box.style.background = "transparent";
        box.style.border = "0";
        const footer = document.createElement("div");
        footer.className = "modal-footer";
        footer.textContent = "Deploy to devices";
        Object.assign(footer.style, {
          position: "absolute",
          left: left === undefined ? "" : `${left}px`,
          right: right === undefined ? "" : `${right}px`,
          bottom: bottom === undefined ? "" : `${bottom}px`,
          height: `${height}px`,
          background: "#eef0f8",
          border: "1px solid #7a83a6",
        });
        box.appendChild(footer);
      } else box.className = name === "bar" ? "problems-panel" : name;
      document.body.appendChild(box);
    },
    { name, left, right, bottom, top, height, dialog },
  );
}
const remove = (name) =>
  page.evaluate(
    (name) => document.querySelector(`[data-stand-in="${name}"]`)?.remove(),
    name,
  );
const stack = () => page.locator(".toast");
const box = async (locator) => locator.boundingBox();
const viewport = () => page.viewportSize();
async function gap() {
  const toast = await box(stack()),
    size = viewport();
  return { fromBottom: size.height - (toast.y + toast.height), toast };
}
async function check(name, run) {
  const began = Date.now();
  await run();
  results.push({ name, passed: true, milliseconds: Date.now() - began });
  console.log("PASS", name);
}

try {
  await check(
    "with nothing at the bottom, notifications rest in the corner as they always did",
    async () => {
      await load();
      await page.evaluate(() => window.toast.success("Draft revision saved."));
      await expect(stack()).toContainText("Draft revision saved.");
      const { fromBottom, toast } = await gap();
      measurements.push({ label: "resting", fromBottom, ...toast });
      expect(fromBottom).toBeCloseTo(24, 0);
      const size = viewport();
      expect(size.width - (toast.x + toast.width)).toBeCloseTo(24, 0);
      expect(
        await stack().evaluate((el) =>
          el.style.getPropertyValue("--toast-lift"),
        ),
      ).toBe("");
    },
  );
  await check(
    "a bar along the bottom lifts the stack above it, and the stack settles back when the bar goes",
    async () => {
      await load();
      await page.evaluate(() => window.toast.success("Draft revision saved."));
      await expect(stack()).toContainText("Draft revision saved.");
      await put("bar", { left: 0, right: 0, bottom: 0, height: 40 });
      const size = viewport();
      await expect
        .poll(async () => {
          const toast = await box(stack());
          return toast.y + toast.height;
        })
        .toBeLessThanOrEqual(size.height - 40);
      const lifted = await gap();
      measurements.push({ label: "above the bar", ...lifted });
      // It clears the bar by a small gap, and no more than that.
      expect(lifted.fromBottom).toBeGreaterThanOrEqual(40 + 8 - 1);
      expect(lifted.fromBottom).toBeLessThanOrEqual(40 + 8 + 1);
      // A taller bar (the problems list open) lifts it further.
      await page.evaluate(() => {
        document.querySelector('[data-stand-in="bar"]').style.height = "180px";
      });
      await expect
        .poll(async () => (await gap()).fromBottom)
        .toBeGreaterThanOrEqual(180 + 8 - 1);
      await remove("bar");
      await expect
        .poll(async () => (await gap()).fromBottom)
        .toBeCloseTo(24, 0);
    },
  );
  await check(
    "the stack stays above the buttons at the foot of an open dialog, and returns when it closes",
    async () => {
      await load();
      await put("dialog", {
        left: 700,
        right: 220,
        bottom: 60,
        height: 64,
        dialog: true,
      });
      await page.evaluate(() => {
        window.toast.success("Rollout started.");
        window.toast.info("Another notice.");
      });
      await expect(stack()).toContainText("Rollout started.");
      const footer = await box(page.locator(".modal-footer"));
      await expect
        .poll(async () => {
          const toast = await box(stack());
          return toast.y + toast.height;
        })
        .toBeLessThanOrEqual(footer.y - 8 + 1);
      const toast = await box(stack());
      measurements.push({ label: "above the dialog footer", toast, footer });
      expect(toast.y + toast.height).toBeLessThanOrEqual(footer.y);
      await remove("dialog");
      await expect
        .poll(async () => (await gap()).fromBottom)
        .toBeCloseTo(24, 0);
    },
  );
  await check(
    "both at once: above the dialog's footer and the bar under it",
    async () => {
      await load();
      await put("bar", { left: 0, right: 0, bottom: 0, height: 40 });
      await put("dialog", {
        left: 640,
        right: 200,
        bottom: 80,
        height: 64,
        dialog: true,
      });
      await page.evaluate(() => window.toast.success("Saved."));
      await expect(stack()).toContainText("Saved.");
      const footer = await box(page.locator(".modal-footer"));
      await expect
        .poll(async () => {
          const toast = await box(stack());
          return toast.y + toast.height;
        })
        .toBeLessThanOrEqual(footer.y);
    },
  );
  await check(
    "what is not under the stack does not move it: a bar at the top, or a footer on the far side",
    async () => {
      await load();
      await put("header", { left: 0, right: 0, top: 0, height: 56 });
      await put("dialog", {
        left: 40,
        right: 1000,
        bottom: 24,
        height: 64,
        dialog: true,
      });
      await page.evaluate(() => window.toast.success("Saved."));
      await expect(stack()).toContainText("Saved.");
      await page.waitForTimeout(300);
      expect((await gap()).fromBottom).toBeCloseTo(24, 0);
    },
  );
  await check(
    "on a phone the full-width footer is cleared and the toast keeps its side margins",
    async () => {
      await load({ width: 390, height: 844 });
      await put("dialog", {
        left: 0,
        right: 0,
        bottom: 0,
        height: 84,
        dialog: true,
      });
      await page.evaluate(() => window.toast.success("Settings saved."));
      await expect(stack()).toContainText("Settings saved.");
      const footer = await box(page.locator(".modal-footer"));
      await expect
        .poll(async () => {
          const toast = await box(stack());
          return toast.y + toast.height;
        })
        .toBeLessThanOrEqual(footer.y);
      const toast = await box(stack());
      measurements.push({ label: "phone", toast, footer });
      expect(toast.x).toBeGreaterThanOrEqual(0);
      expect(toast.x + toast.width).toBeLessThanOrEqual(390);
      await page.screenshot({
        path: resolve(output, "toast-above-footer-390.png"),
        animations: "disabled",
      });
    },
  );
  await check(
    "a new bar that appears after the notification is cleared too, in both themes",
    async () => {
      for (const theme of ["light", "dark"]) {
        await load({ theme });
        await page.evaluate(() => window.toast.error("Couldn't save."));
        await expect(stack()).toContainText("Couldn't save.");
        await page.waitForTimeout(100);
        await put("bar", { left: 0, right: 0, bottom: 0, height: 40 });
        await expect
          .poll(async () => (await gap()).fromBottom)
          .toBeGreaterThanOrEqual(40 + 8 - 1);
        await page.screenshot({
          path: resolve(output, `toast-above-bar-${theme}.png`),
          animations: "disabled",
        });
      }
    },
  );
  expect(errors).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (failure && page && !page.isClosed())
    await page
      .screenshot({
        path: resolve(output, "failure.png"),
        animations: "disabled",
      })
      .catch(() => {});
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "The notification stack with stand-ins for the problems bar and a dialog footer. No server, preview or device.",
        passed: !failure,
        results,
        measurements,
        errors,
        ...(failure ? { failure: failure.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await context?.close();
  await browser.close();
  await server.close();
  console.log("Evidence:", relative(root, resolve(output, "report.json")));
}
