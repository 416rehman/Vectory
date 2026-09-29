// Isolated shared action-menu checks; no API, graph mutations, or preview state.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dashboard, "..");
const output = resolve(
  root,
  process.env.VECTORY_CANVAS_ACTION_MENU_OUTPUT || ".local/canvas-action-menu",
);
await mkdir(output, { recursive: true });
const virtual = "\0virtual:canvas-actions";
const reservation = net.createServer();
await new Promise((yes, no) => {
  reservation.once("error", no);
  reservation.listen(0, "127.0.0.1", yes);
});
const port = reservation.address().port;
await new Promise((yes) => reservation.close(yes));
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, proxy: {}, hmr: false },
  plugins: [
    {
      name: "canvas-action-fixture",
      resolveId: (id) =>
        id === "virtual:canvas-actions" ? virtual : undefined,
      load(id) {
        if (id !== virtual) return;
        return `import React,{useState,useRef}from'react';import{createRoot}from'react-dom/client';import{Pencil,Trash2}from'lucide-react';import CanvasActionMenu from'/src/CanvasActionMenu.tsx';import'/src/styles.css';
      function Fixture(){const[open,setOpen]=useState(false),[opts,setOpts]=useState({kind:'node',title:'Synthetic source',position:{x:890,y:670}}),opener=useRef(null);window.configure=setOpts;window.events??=[];
      const action=id=>()=>window.events.push('action:'+id);
      const actions=opts.disabled?[{id:'disabled',label:'Unavailable action',disabled:true,onSelect:action('disabled')}]:[{id:'edit',label:'Edit settings',icon:Pencil,shortcut:'Enter',onSelect:action('edit')},{id:'blocked',label:'Unavailable action',disabled:true,onSelect:action('blocked')},{id:'copy',label:'Duplicate component',onSelect:action('copy')},{id:'remove',label:'Remove component',danger:true,icon:Trash2,shortcut:'Delete',onSelect:action('remove')}];
      return React.createElement('main',{style:{padding:24}},React.createElement('h1',null,'Synthetic action-menu fixture'),React.createElement('button',{ref:opener,onClick:()=>setOpen(true)},'Open actions'),React.createElement('button',{onPointerDown:e=>e.stopPropagation()},'Outside target'),open&&React.createElement(CanvasActionMenu,{...opts,actions,returnFocus:opener.current,onClose:()=>{window.events.push('close');setOpen(false)}}))}createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Fixture)));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__canvas-actions") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic canvas actions</title></head><body><div id="root"></div><script type="module">import "virtual:canvas-actions";</script></body></html>',
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
const context = await browser.newContext({
  viewport: { width: 900, height: 700 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const results = [],
  accessibility = [],
  geometry = [],
  unexpected = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", (route) => {
  const request = route.request(),
    url = new URL(request.url());
  if (url.origin !== origin || url.pathname.startsWith("/api/")) {
    unexpected.push(request.url());
    return route.abort();
  }
  return route.continue();
});
const menu = () => page.getByRole("menu");
const item = (name) => page.getByRole("menuitem", { name, exact: true });
const opener = () =>
  page.getByRole("button", { name: "Open actions", exact: true });
async function open() {
  await opener().click();
  await expect(menu()).toBeVisible();
}
async function check(name, fn) {
  await fn();
  results.push({ name, passed: true });
  console.log("PASS", name);
}
let failure;
try {
  await page.goto(origin + "/__canvas-actions");
  await check(
    "keyboard navigation skips disabled items, wraps, restores focus, and invokes one selected action",
    async () => {
      await open();
      await expect(menu()).toHaveAccessibleName("Synthetic source");
      await expect(item("Edit settings")).toBeFocused();
      await expect(item("Unavailable action")).toBeDisabled();
      await page.keyboard.press("ArrowDown");
      await expect(item("Duplicate component")).toBeFocused();
      await page.keyboard.press("End");
      await expect(item("Remove component")).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(item("Edit settings")).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(item("Remove component")).toBeFocused();
      await page.keyboard.press("Home");
      await expect(item("Edit settings")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu()).toHaveCount(0);
      await expect(opener()).toBeFocused();
      await open();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(menu()).toHaveCount(0);
      expect(await page.evaluate(() => window.events)).toEqual([
        "close",
        "close",
        "action:copy",
      ]);
    },
  );
  await check(
    "capture outside dismissal does not steal pointer focus; Tab and focus exit dismiss",
    async () => {
      const outside = page.getByRole("button", {
        name: "Outside target",
        exact: true,
      });
      await open();
      await outside.click();
      await expect(menu()).toHaveCount(0);
      await expect(outside).toBeFocused();
      await open();
      await page.keyboard.press("Tab");
      await expect(menu()).toHaveCount(0);
      await expect(outside).toBeFocused();
      await open();
      await outside.focus();
      await expect(menu()).toHaveCount(0);
      await expect(outside).toBeFocused();
    },
  );
  await check(
    "desktop and mobile menus clamp to the viewport and remain accessible in both themes",
    async () => {
      for (const [width, height, theme] of [
        [900, 700, "light"],
        [375, 500, "dark"],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(
          ({ theme, width, height }) => {
            document.documentElement.dataset.theme = theme;
            window.configure({
              kind: "edge",
              title: "source.accepted → destination",
              position: { x: width + 100, y: height + 100 },
            });
          },
          { theme, width, height },
        );
        await open();
        const box = await menu().boundingBox();
        geometry.push({ width, height, theme, box });
        expect(box.x).toBeGreaterThanOrEqual(11);
        expect(box.y).toBeGreaterThanOrEqual(11);
        expect(box.x + box.width).toBeLessThanOrEqual(width - 11);
        expect(box.y + box.height).toBeLessThanOrEqual(height - 11);
        const scan = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        accessibility.push({
          theme,
          violations: scan.violations.map(({ id }) => id),
        });
        expect(scan.violations).toEqual([]);
        await page.screenshot({
          path: resolve(output, `canvas-action-menu-${theme}.png`),
        });
        await page.keyboard.press("Escape");
      }
    },
  );
  await check(
    "an all-disabled menu remains keyboard dismissible without invoking any action",
    async () => {
      await page.evaluate(() =>
        window.configure({
          kind: "node",
          title: "Read-only component",
          position: { x: -100, y: -100 },
          disabled: true,
        }),
      );
      await open();
      await expect(menu()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(menu()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(opener()).toBeFocused();
      expect(
        await page.evaluate(() =>
          window.events.filter((value) => value.startsWith("action:")),
        ),
      ).toEqual(["action:copy"]);
    },
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
} catch (error) {
  failure = error;
} finally {
  const source_sha256 = {};
  for (const file of ["src/CanvasActionMenu.tsx", "src/canvas-action-menu.css"])
    source_sha256[`dashboard/${file}`] = createHash("sha256")
      .update(await readFile(resolve(dashboard, file)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        scope:
          "Shared action-menu component with synthetic local callbacks. No graph integration, backend, or native operation.",
        passed: !failure,
        results,
        accessibility,
        geometry,
        errors,
        unexpected,
        source_sha256,
        failure: failure?.message || null,
      },
      null,
      2,
    ),
  );
  await context.close();
  await browser.close();
  await server.close();
}
if (failure) throw failure;
console.log(`Evidence: ${resolve(output, "report.json")}`);
