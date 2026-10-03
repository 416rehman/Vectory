// Actual component inspector with isolated local state. No preview or API writes.
import { createServer, transformWithEsbuild } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_INSPECTOR_OUTPUT || ".local/inspector-component",
);
const testFilter = process.env.VECTORY_INSPECTOR_TEST_FILTER || "";
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const virtual = "\0virtual:inspector-fixture";
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(output, "vite-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {},
    hmr: false,
  },
  plugins: [
    {
      name: "inspector-fixture",
      resolveId(id) {
        if (id === "virtual:inspector-fixture") return virtual;
      },
      async load(id) {
        if (id === virtual)
          return (
            await transformWithEsbuild(
              `

    import React,{useState,useCallback}from'react';import{createRoot}from'react-dom/client';import PipelineSettings from'/src/PipelineSettings.tsx';import'/src/styles.css';import'/src/editor.css';import'/src/editor-canvas.css';
    const root=createRoot(document.getElementById('root'));let revision=0;
    function Harness({test}){const[value,setValue]=useState(test.value),[pending,setPending]=useState([]),[target,setTarget]=useState(null);
      const onPending=useCallback((id,dirty)=>setPending(p=>dirty?p.includes(id)?p:[...p,id]:p.includes(id)?p.filter(i=>i!==id):p),[]);
      window.stored=value;window.pending=pending;window.revision=test.revision;
      const change=next=>{window.changes++;setValue(next);};
      const kind=test.kind||'transforms';
      return <main className="editor-redesigned" style={{width:400,maxWidth:'100%',height:'100dvh',margin:'0 auto'}}><aside className="editor-inspector" style={{height:'100%'}}><header><div><h1 style={{fontSize:18,margin:0}}>Component properties</h1><code>Synthetic inspector fixture</code></div></header><div className="editor-inspector-properties-toolbar"><span>Properties</span><div ref={setTarget} className="editor-inspector-field-picker"/></div><div className="editor-inspector-body"><PipelineSettings id="reviewed" kind={kind} component={value} editable={test.editable!==false} issues={[]} fieldPickerTarget={target} onChange={change} onPendingChange={onPending} onRouteRename={()=>{}} onRouteRemove={()=>{}}/></div><footer><span>Synthetic fixture · no server writes</span><output className="sr-only" aria-label="Pending edits">{pending.length}</output></footer></aside></main>;
    }
    window.renderInspector=test=>{window.changes=0;window.expectedRevision=++revision;root.render(<Harness key={revision} test={{...test,revision}}/>);};window.ready=true;
  
  `,
              "inspector-fixture.tsx",
              { loader: "tsx", jsx: "automatic" },
            )
          ).code;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__inspector") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic inspector verification</title></head><body><div id="root"></div><script type="module">import "virtual:inspector-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = "http://127.0.0.1:" + server.httpServer.address().port;
const browser = await chromium.launch(),
  context = await browser.newContext({
    viewport: { width: 899, height: 1000 },
    reducedMotion: "reduce",
  }),
  page = await context.newPage();
page.setDefaultTimeout(8000);
const results = [],
  errors = [],
  requests = [],
  accessibility = [],
  measurements = [];
let failure;
page.on("pageerror", (error) => errors.push(error.message));
await context.route("**/api/v1/**", async (route) => {
  requests.push(
    route.request().method() + " " + new URL(route.request().url()).pathname,
  );
  await route.abort();
});
const stored = () => page.evaluate(() => window.stored);
async function fixture(test) {
  await page.evaluate((test) => window.renderInspector(test), test);
  await page.waitForFunction(() => window.revision === window.expectedRevision);
}
async function check(name, run) {
  if (testFilter && !name.includes(testFilter)) return;
  try {
    await run();
    results.push({ name, passed: true });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    await page.screenshot({
      path: resolve(output, `failure-${results.length}.png`),
      fullPage: true,
    });
    console.error("FAIL " + name + "\n" + error.message);
    await page.keyboard.press("Escape").catch(() => {});
  }
}
const rootPicker = () =>
  page
    .locator(".editor-inspector-properties-toolbar")
    .getByRole("button", { name: "Add field", exact: true });
const help = (title) =>
  page.getByRole("button", { name: "Help for " + title, exact: true });
const helpDialog = (title) =>
  page.getByRole("dialog", { name: "Help for " + title, exact: true });
const consoleValue = (buffer) => ({
  type: "console",
  inputs: ["seed"],
  encoding: { codec: "json" },
  buffer,
  future_extension: { nullable: null, values: [false, 0, "retained"] },
});
async function action(title, label) {
  await page
    .getByRole("button", { name: "Actions for " + title, exact: true })
    .click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}
async function choice(pattern, index = 0) {
  const found = [];
  for (const select of await page.locator("select").all()) {
    const labels = await select.locator("option").allTextContents();
    const label = labels.find((value) => pattern.test(value));
    if (label) found.push({ select, label });
  }
  expect(found.length, "Choice " + pattern).toBeGreaterThan(index);
  await found[index].select.selectOption({ label: found[index].label });
}
async function noFieldsAccordion() {
  await expect(
    page.locator("summary").filter({ hasText: /^Fields(?:\s|$)/ }),
  ).toHaveCount(0);
}
async function axe(label) {
  await page.mouse.move(0, 0);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    label,
    violations: scan.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  });
  expect(scan.violations, label).toEqual([]);
}
try {
  await page.goto(origin + "/__inspector", { timeout: 30000 });
  await page.waitForFunction(() => window.ready);
  await check(
    "unified inspector omits old connection/raw/footer controls and exposes one owning help button per property",
    async () => {
      const value = { type: "sample", inputs: ["seed", "app_*"], rate: 10 };
      await fixture({ value });
      await noFieldsAccordion();
      for (const text of [
        "Advanced connections",
        "Component JSON",
        "More Vector settings",
      ])
        await expect(page.getByText(text, { exact: true })).toHaveCount(0);
      await expect(
        page.getByLabel("Input pattern", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: /^(Duplicate step|Remove step|Add pattern|Remove pattern)$/,
        }),
      ).toHaveCount(0);
      await expect(help("One in every")).toHaveCount(1);
      await expect(
        page.getByLabel("One in every", { exact: true }),
      ).toHaveValue("10");
      await expect(
        page.locator(".schema-control-hint").filter({
          hasText: /Maximum|Minimum|Required field|Optional field|Default:/,
        }),
      ).toHaveCount(0);
      expect(await stored()).toEqual(value);
      expect(await page.evaluate(() => window.changes)).toBe(0);
    },
  );
  await check(
    "small field help supports transient hover and click, keyboard entry and Escape without changing data",
    async () => {
      const value = { type: "sample", inputs: ["seed"], rate: 10 };
      await fixture({ value });
      const trigger = help("One in every"),
        popup = helpDialog("One in every");
      await trigger.hover();
      await expect(popup).toBeVisible();
      await trigger.click();
      await expect(trigger).toBeFocused();
      await popup.hover();
      await expect(popup).toBeVisible();
      await expect(popup).toContainText(/Required field|Optional field/);
      await expect(popup).toContainText(/Minimum|Maximum/);
      await page.mouse.move(0, 0);
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.getByLabel("One in every", { exact: true }).focus();
      await trigger.focus();
      await expect(popup).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() =>
          popup.evaluate((node) => node.contains(document.activeElement)),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(await stored()).toEqual(value);
      await expect(page.getByLabel("Pending edits")).toHaveText("0");
    },
  );
  await check(
    "single buffer exposes nested fields without accordion barriers and keeps sizing variants lossless",
    async () => {
      const initial = consoleValue({
        type: "memory",
        max_events: 500,
        when_full: "drop_newest",
      });
      await fixture({ kind: "sinks", value: initial });
      await noFieldsAccordion();
      await expect(help("Buffer")).toHaveCount(1);
      const events = page.getByLabel("Max Events", { exact: true });
      await expect(events).toBeVisible();
      await events.fill("750");
      expect((await stored()).buffer).toEqual({
        type: "memory",
        max_events: 750,
        when_full: "drop_newest",
      });
      await choice(/^Max Size$/i);
      await page.getByLabel("Max Size", { exact: true }).fill("1048576");
      expect((await stored()).buffer).toEqual({
        type: "memory",
        max_size: 1048576,
        when_full: "drop_newest",
      });
      await choice(/^Max Events$/i);
      await expect(events).toHaveValue("750");
      await choice(/^Disk/i);
      await page.getByLabel("Max Size", { exact: true }).fill("268435488");
      expect((await stored()).buffer).toEqual({
        type: "disk",
        max_size: 268435488,
        when_full: "drop_newest",
      });
      await choice(/^Memory$/i);
      await expect(events).toHaveValue("750");
      expect((await stored()).buffer.when_full).toBe("drop_newest");
      expect((await stored()).future_extension).toEqual(
        initial.future_extension,
      );
    },
  );
  await check(
    "chained buffers retain exact ordered stages and nullable sibling values through edits and variant changes",
    async () => {
      const chain = [
        { type: "memory", max_events: 321, when_full: "overflow" },
        { type: "disk", max_size: 536870912, when_full: "block" },
      ];
      const initial = {
        ...consoleValue(chain),
        healthcheck: { enabled: true, uri: null },
      };
      await fixture({ kind: "sinks", value: initial });
      await noFieldsAccordion();
      await page.getByLabel("Max Events", { exact: true }).fill("700");
      let next = await stored();
      expect(next.buffer).toEqual([{ ...chain[0], max_events: 700 }, chain[1]]);
      expect(next.healthcheck).toEqual(initial.healthcheck);
      await choice(/^Single$/i);
      await choice(/^Chained$/i);
      expect((await stored()).buffer).toEqual(next.buffer);
      await expect(page.getByLabel("Pending edits")).toHaveText("0");
    },
  );
  await check(
    "root Add field stays fixed while scrolling, supports search and protects invalid drafts and field JSON transitions",
    async () => {
      const initial = {
        type: "file",
        include: [
          "/var/log/a.log",
          "/var/log/b.log",
          "/var/log/c.log",
          "/var/log/d.log",
          "/var/log/e.log",
          "/var/log/f.log",
        ],
        exclude: ["/var/log/private.log"],
        read_from: "beginning",
        ignore_older_secs: 60,
        max_line_bytes: 4096,
        glob_minimum_cooldown_ms: 1000,
        rotate_wait_secs: 30,
        offset_key: "offset",
        host_key: "host",
      };
      await fixture({ kind: "sources", value: initial });
      // Both lists hold paths, and both say so: Path 1 and Add path.
      await expect(
        page.getByRole("button", { name: "Add path", exact: true }),
      ).toHaveCount(2);
      await expect(
        page.getByRole("button", { name: "Add item", exact: true }),
      ).toHaveCount(0);
      const scroller = page.locator(".editor-inspector-body");
      expect(
        await scroller.evaluate(
          (node) => node.scrollHeight > node.clientHeight,
        ),
      ).toBe(true);
      const before = await rootPicker().boundingBox();
      await scroller.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const after = await rootPicker().boundingBox();
      expect(Math.abs(before.y - after.y)).toBeLessThanOrEqual(1);
      await rootPicker().click();
      const panel = page.getByRole("dialog", {
        name: "Add a field",
        exact: true,
      });
      await expect(panel).toBeVisible();
      await page
        .getByLabel("Find optional fields", { exact: true })
        .fill("data_dir");
      await page
        .locator(".schema-field-picker-results button")
        .filter({ hasText: "Data Dir" })
        .click();
      await expect(panel).toHaveCount(0);
      const directory = page.getByLabel("Data Directory", { exact: true });
      await expect(directory).toBeFocused();
      await directory.fill("/var/lib/vector");
      expect((await stored()).data_dir).toBe("/var/lib/vector");
      const max = page.getByLabel("Max Line Bytes", { exact: true });
      await max.fill("-");
      await expect(page.getByLabel("Pending edits")).not.toHaveText("0");
      await action("Max Line Bytes", "Remove max line bytes");
      await expect(max).toHaveValue("-");
      expect((await stored()).max_line_bytes).toBe(4096);
      await max.fill("4097");
      await action("Max Line Bytes", "Remove max line bytes");
      expect((await stored()).max_line_bytes).toBeUndefined();
      expect((await stored()).include).toEqual(initial.include);
      await fixture({
        kind: "sinks",
        value: consoleValue({
          type: "memory",
          max_events: 500,
          when_full: "block",
        }),
      });
      await page.getByLabel("Max Events", { exact: true }).fill("-");
      await action("Buffer", "Edit Buffer as JSON");
      await expect(
        page.getByRole("textbox", { name: "Buffer (JSON)", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByLabel("Max Events", { exact: true })).toHaveValue(
        "-",
      );
      await page.getByLabel("Max Events", { exact: true }).fill("501");
      await action("Buffer", "Edit Buffer as JSON");
      const raw = page.getByRole("textbox", {
        name: "Buffer (JSON)",
        exact: true,
      });
      await raw.fill("{invalid");
      await expect(raw).toHaveAttribute("aria-invalid", "true");
      expect((await stored()).buffer.max_events).toBe(501);
      await action("Buffer", "Edit Buffer as fields");
      await action("Buffer", "Edit Buffer as JSON");
      await expect(raw).toHaveText("{invalid");
    },
  );
  await check(
    "credential variants retain local references and never commit invalid plaintext",
    async () => {
      const initial = {
        type: "http",
        inputs: ["seed"],
        uri: "https://collector.example.test/events",
        encoding: { codec: "json" },
        auth: { strategy: "basic", user: "${USER}", password: "${PASSWORD}" },
      };
      await fixture({ kind: "sinks", value: initial });
      await noFieldsAccordion();
      await page
        .getByLabel("Strategy", { exact: true })
        .selectOption({ label: "Bearer" });
      const token = page.getByLabel("Token reference", { exact: true });
      await token.fill("${TOKEN}");
      expect((await stored()).auth).toEqual({
        strategy: "bearer",
        token: "${TOKEN}",
      });
      await token.fill("never-commit-this-fixture");
      expect((await stored()).auth.token).toBe("${TOKEN}");
      await expect(page.getByLabel("Pending edits")).not.toHaveText("0");
      await token.fill("${TOKEN}");
      await page
        .getByLabel("Strategy", { exact: true })
        .selectOption({ label: "Basic" });
      expect((await stored()).auth).toEqual(initial.auth);
    },
  );
  await check(
    "read-only fields and 899px/375px light-dark inspector states remain accessible and contained",
    async () => {
      const value = {
        type: "console",
        inputs: ["seed"],
        encoding: { codec: "json" },
        buffer: { type: "memory", max_events: 500, when_full: "block" },
      };
      await fixture({ kind: "sinks", editable: false, value });
      await expect(rootPicker()).toHaveCount(0);
      await expect(
        page.getByLabel("Max Events", { exact: true }),
      ).toHaveAttribute("readonly", "");
      await help("Max Events").click();
      await expect(helpDialog("Max Events")).toBeVisible();
      await page.keyboard.press("Escape");
      expect(await stored()).toEqual(value);
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          await fixture({ kind: "sinks", value });
          await noFieldsAccordion();
          const encoding = page.getByRole("region", { name: "Encoding" });
          await expect(
            encoding.getByText("Encoding", { exact: true }),
          ).toHaveCount(1);
          await expect(
            encoding.locator(".schema-property-section-icon"),
          ).toHaveCount(1);
          await expect(help("Encoding")).toHaveCount(1);
          await expect(
            encoding.getByRole("button", { name: "Add field" }),
          ).toHaveCount(1);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await axe("inspector " + width + " " + theme);
          await page.screenshot({
            path: resolve(
              output,
              "inspector-clean-" + width + "-" + theme + ".png",
            ),
            animations: "disabled",
          });
          await help("Max Events").click();
          await expect(helpDialog("Max Events")).toBeVisible();
          await page.screenshot({
            path: resolve(
              output,
              "inspector-help-" + width + "-" + theme + ".png",
            ),
            animations: "disabled",
          });
          await page.keyboard.press("Escape");
          await rootPicker().click();
          await page
            .getByLabel("Find optional fields", { exact: true })
            .fill("healthcheck");
          await expect(
            page.getByRole("dialog", { name: "Add a field", exact: true }),
          ).toBeVisible();
          const box = await page
            .getByRole("dialog", { name: "Add a field", exact: true })
            .boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          measurements.push({ width, theme, fieldPicker: box });
          if (width === 375 && theme === "dark")
            await axe("mobile dark optional field picker");
          await page.screenshot({
            path: resolve(
              output,
              "inspector-add-" + width + "-" + theme + ".png",
            ),
            animations: "disabled",
          });
          await page.keyboard.press("Escape");
          expect(await stored()).toEqual(value);
        }
    },
  );
  if (testFilter) expect(results.length).toBeGreaterThan(0);
  else expect(results).toHaveLength(7);
  expect(results.filter((result) => !result.passed)).toEqual([]);
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
} catch (error) {
  failure = error;
  await page
    .screenshot({ path: resolve(output, "failure.png"), fullPage: true })
    .catch(() => {});
  console.error((await page.locator("body").innerText()).slice(0, 7000));
  throw error;
} finally {
  const source_sha256 = {};
  for (const file of [
    "Editor.tsx",
    "PipelineSettings.tsx",
    "PipelineSchemaFields.tsx",
    "SchemaValueEditor.tsx",
    "SchemaFieldChrome.tsx",
    "useHoverDisclosure.ts",
    "inspector.css",
    "schema-controls.css",
    "editor.css",
  ])
    source_sha256["dashboard/src/" + file] = createHash("sha256")
      .update(await readFile(resolve(dashboard, "src", file)))
      .digest("hex");
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Actual PipelineSettings and shared typed controls in synthetic inspector chrome using real CSS and isolated local state. No preview/server/API writes. Read-only full-mode/native configuration compatibility is not exercised here.",
        ...(testFilter
          ? { test_filter: testFilter, focused_subset: true }
          : {}),
        passed: !failure,
        results,
        accessibility,
        measurements,
        errors,
        requests,
        source_sha256,
        ...(failure ? { failure: failure.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  await context.close();
  await browser.close();
  await server.close();
  console.log(
    "Evidence: " + relative(repository, resolve(output, "report.json")),
  );
}
