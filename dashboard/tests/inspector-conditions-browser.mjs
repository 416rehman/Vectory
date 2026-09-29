// Actual shared controls, synthetic values, no preview/API requests.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import net from "node:net";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(dashboard, "..");
const output = resolve(
  repository,
  process.env.VECTORY_INSPECTOR_CONDITIONS_OUTPUT ||
    ".local/inspector-conditions",
);
const conditionsOnly =
  process.env.VECTORY_INSPECTOR_CONDITIONS_FOCUS === "conditions";
await mkdir(output, { recursive: true });
const reservation = net.createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: { host: "127.0.0.1", port, strictPort: true, hmr: false, proxy: {} },
});
await server.listen();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch(),
  context = await browser.newContext({
    viewport: { width: 899, height: 1000 },
    reducedMotion: "reduce",
  }),
  page = await context.newPage();
page.setDefaultTimeout(7000);
const rootText = await readFile(
    resolve(dashboard, "src/generated/vector-schema.json"),
    "utf8",
  ),
  root = JSON.parse(rootText);
const results = [],
  errors = [],
  requests = [],
  accessibility = [],
  measurements = [];
let failure;
page.on("pageerror", (error) => errors.push(error.message));
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== origin || url.pathname.startsWith("/api/")) {
    requests.push(route.request().method() + " " + url.pathname);
    return route.abort();
  }
  return route.continue();
});
const stored = () => page.evaluate(() => window.stored);
const pending = () => page.getByLabel("Pending edits", { exact: true });
async function fixture(test) {
  await page.evaluate((test) => window.renderControl(test), {
    ...test,
    root: test.root || root,
  });
  await page.waitForFunction(
    () => window.currentRevision === window.expectedRevision,
  );
  await page.locator("#root > div").evaluate((node) => {
    node.style.width = "350px";
    node.style.maxWidth = "100%";
    node.style.padding = "12px";
    node.style.margin = "0 auto";
  });
}
async function action(title, label) {
  await page
    .getByRole("button", { name: "Actions for " + title, exact: true })
    .click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}
async function check(name, run) {
  if (
    conditionsOnly &&
    !/^(actual event conditions|if-then|property dependencies|additional-map|inactive conditional|literal-union)/.test(
      name,
    )
  )
    return;
  try {
    await run();
    results.push({ name, passed: true });
    console.log("PASS", name);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error("FAIL", name, error.message);
    await page.screenshot({
      path: resolve(output, `failure-${results.length}.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape").catch(() => {});
  }
}
async function axe(label) {
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
const deepSchema = {
  type: "object",
  properties: {
    top_note: { type: "string", title: "Top note" },
    settings: {
      type: "object",
      properties: {
        stages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              options: {
                type: "object",
                properties: {
                  headers: {
                    type: "object",
                    additionalProperties: {
                      type: "object",
                      properties: {
                        value: { type: "string", title: "Nested value" },
                        limit: {
                          type: "integer",
                          minimum: 1,
                          title: "Nested limit",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
const deepValue = {
  top_note: "Synthetic width baseline",
  settings: {
    stages: [
      {
        options: {
          headers: { primary: { value: "Readable nested value", limit: 7 } },
        },
      },
    ],
  },
};
const conditionalSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["remote", "local"], title: "Mode" },
    port: { type: "integer", minimum: 1, title: "Port" },
    prefix: { type: "string", minLength: 1, title: "Prefix" },
  },
  required: ["mode"],
  if: { properties: { mode: { const: "remote" } }, required: ["mode"] },
  then: { required: ["port"] },
  else: { required: ["prefix"] },
};
try {
  await page.goto(origin + "/tests/schema-controls.html", { timeout: 30000 });
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    const viewport = document.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width,initial-scale=1";
    document.head.append(viewport);
    document.body.style.margin = "0";
  });
  await check(
    "actual event conditions use one kind picker and preserve each representation",
    async () => {
      const schema =
        root.definitions["vector::transforms::sample::config::SampleConfig"]
          .allOf[0].properties.exclude;
      const configured = { type: "vrl", source: "false" };
      await fixture({ name: "exclude", schema, value: configured });
      const kind = page.getByLabel("Condition kind", { exact: true });
      await expect(kind).toHaveCount(1);
      await expect(kind.locator("option")).toHaveText([
        "Choose a condition",
        "VRL expression",
        "Is Log",
        "Is Metric",
        "Is Trace",
        "VRL (structured)",
        "Datadog Search",
      ]);
      await expect(kind.locator("option:checked")).toHaveText(
        "VRL (structured)",
      );
      await expect(
        page.getByLabel("Condition format", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByLabel("Condition type", { exact: true }),
      ).toHaveCount(0);
      expect(await stored()).toEqual(configured);
      expect(await page.evaluate(() => window.testHistory)).toEqual([]);
      await page.screenshot({
        path: resolve(output, "inspector-event-condition.png"),
        fullPage: true,
        animations: "disabled",
      });
      await page.setViewportSize({ width: 375, height: 1000 });
      await axe("event condition format labels at 375px");
      await page.screenshot({
        path: resolve(output, "inspector-event-condition-375.png"),
        fullPage: true,
        animations: "disabled",
      });
      await page.setViewportSize({ width: 899, height: 1000 });
      await action("Exclude", "Edit Exclude as JSON");
      const raw = page.getByRole("textbox", {
        name: "Exclude (JSON)",
        exact: true,
      });
      await expect(raw).toBeVisible();
      await raw.fill('{"type":"vrl"');
      await expect(pending()).toHaveText("1");
      expect(await stored()).toEqual(configured);
      await page.getByRole("button", { name: "Discard changes" }).click();
      await expect(pending()).toHaveText("0");
      await action("Exclude", "Edit Exclude as fields");
      await kind.selectOption({ label: "Datadog Search" });
      expect(await stored()).toEqual({ type: "datadog_search" });
      expect(await page.evaluate(() => window.testHistory)).toEqual([
        { type: "datadog_search" },
      ]);
      await page.getByLabel("Source", { exact: true }).fill("ERROR");
      await page.getByLabel("Source", { exact: true }).blur();
      await expect
        .poll(stored)
        .toEqual({ type: "datadog_search", source: "ERROR" });
      await kind.selectOption({ label: "Is Log" });
      expect(await stored()).toEqual({ type: "is_log" });
      await kind.selectOption({ label: "Datadog Search" });
      expect(await stored()).toEqual({
        type: "datadog_search",
        source: "ERROR",
      });
      await kind.selectOption({ label: "VRL (structured)" });
      expect(await stored()).toEqual(configured);
      await fixture({ name: "exclude", schema, value: { type: "is_log" } });
      await expect(
        page
          .getByLabel("Condition kind", { exact: true })
          .locator("option:checked"),
      ).toHaveText("Is Log");
      await expect(
        page.getByLabel("Condition type", { exact: true }),
      ).toHaveCount(0);
      expect(await stored()).toEqual({ type: "is_log" });
      await fixture({ name: "exclude", schema, value: '.level == "debug"' });
      await expect(
        page
          .getByLabel("Condition kind", { exact: true })
          .locator("option:checked"),
      ).toHaveText("VRL expression");
      expect(await stored()).toBe('.level == "debug"');
      await page
        .getByLabel("Condition kind", { exact: true })
        .selectOption({ label: "VRL (structured)" });
      expect(await stored()).toEqual({
        type: "vrl",
        source: '.level == "debug"',
      });
      expect(await page.evaluate(() => window.testHistory)).toEqual([
        { type: "vrl", source: '.level == "debug"' },
      ]);
      await page.getByLabel("Source", { exact: true }).fill('.level == "info"');
      await expect.poll(stored).toEqual({
        type: "vrl",
        source: '.level == "info"',
      });
      await page
        .getByLabel("Condition kind", { exact: true })
        .selectOption({ label: "VRL expression" });
      expect(await stored()).toBe('.level == "info"');
      await page
        .getByRole("textbox", { name: "Exclude", exact: true })
        .fill('.level == "warn"');
      await expect.poll(stored).toBe('.level == "warn"');
      await page
        .getByLabel("Condition kind", { exact: true })
        .selectOption({ label: "VRL (structured)" });
      expect(await stored()).toEqual({
        type: "vrl",
        source: '.level == "warn"',
      });
      const unknown = { type: "custom_matcher", opaque: { keep: true } };
      await fixture({ name: "exclude", schema, value: unknown });
      await expect(
        page
          .getByLabel("Condition kind", { exact: true })
          .locator("option:checked"),
      ).toHaveText("Unknown condition: custom_matcher");
      await expect(
        page.getByRole("textbox", { name: "Exclude (JSON)", exact: true }),
      ).toBeVisible();
      expect(await stored()).toEqual(unknown);
      expect(await page.evaluate(() => window.testHistory)).toEqual([]);
      await axe("event condition format labels");
    },
  );
  await check(
    "actual Buffer has one storage Type selector per stage without duplicate discriminator controls",
    async () => {
      const schema =
        root.definitions["vectory::components::sinks::console"].allOf[0]
          .properties.buffer;
      await fixture({
        name: "buffer",
        schema,
        value: { type: "memory", max_events: 500, when_full: "block" },
      });
      const type = page.getByLabel("Type", { exact: true });
      await expect(type).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "Help for Type", exact: true }),
      ).toHaveCount(1);
      await page
        .getByLabel("Buffer mode", { exact: true })
        .selectOption({ label: "Max Size" });
      await page.getByLabel("Max Size", { exact: true }).fill("1048576");
      await expect(type).toHaveCount(1);
      await type.selectOption({ label: "Disk V2" });
      await page.getByLabel("Max Size", { exact: true }).fill("268435488");
      await expect(type).toHaveCount(1);
      await type.selectOption({ label: "Memory" });
      await expect(type).toHaveCount(1);
      expect((await stored()).when_full).toBe("block");
      await fixture({
        name: "buffer",
        schema,
        value: [
          { type: "memory", max_events: 500, when_full: "overflow" },
          { type: "disk", max_size: 268435488, when_full: "block" },
        ],
      });
      await expect(page.getByLabel("Type", { exact: true })).toHaveCount(2);
      await expect(
        page.getByRole("button", { name: "Help for Type", exact: true }),
      ).toHaveCount(2);
      const constant = {
        type: "object",
        properties: {
          engine: { const: "memory", title: "Engine" },
          note: { type: "string", title: "Note" },
        },
        required: ["engine"],
      };
      await fixture({
        mode: "fields",
        schema: constant,
        value: { engine: "memory", note: "preserve" },
        root: {},
      });
      await expect(page.getByLabel("Engine", { exact: true })).toHaveCount(0);
      expect(await stored()).toEqual({ engine: "memory", note: "preserve" });
      for (const value of [
        { note: "preserve" },
        { engine: "disk", note: "preserve" },
      ]) {
        await fixture({ mode: "fields", schema: constant, value, root: {} });
        expect(await stored()).toEqual(value);
        await page
          .getByRole("button", { name: "Use required value", exact: true })
          .click();
        expect(await stored()).toEqual({ engine: "memory", note: "preserve" });
      }
      await fixture({
        mode: "fields",
        schema: constant,
        value: { engine: "disk", note: "preserve" },
        editable: false,
        root: {},
      });
      await expect(
        page.getByRole("button", { name: "Use required value", exact: true }),
      ).toHaveCount(0);
      expect(await stored()).toEqual({ engine: "disk", note: "preserve" });
      await fixture({
        mode: "fields",
        schema: { ...constant, required: [] },
        value: { engine: "memory", note: "preserve" },
        root: {},
      });
      await action("Engine", "Remove engine");
      expect(await stored()).toEqual({ note: "preserve" });
    },
  );
  await check(
    "deep object-list-map fields stay wide and retain pending values through help interactions",
    async () => {
      await fixture({
        mode: "fields",
        schema: deepSchema,
        value: deepValue,
        root: {},
      });
      const leaf = page.getByLabel("Value", { exact: true }),
        limit = page.getByLabel("Limit", { exact: true }),
        baseline = page.getByLabel("Top note", { exact: true });
      await expect(leaf).toBeVisible();
      await expect(page.locator(".schema-field-path")).toHaveCount(0);
      await expect(
        page.locator(
          '[data-field-name="value"] > .schema-record-header .schema-parent-label',
        ),
      ).toHaveText("in Primary");
      const widths = {
        top: (await baseline.boundingBox()).width,
        nested: (await leaf.boundingBox()).width,
        limit: (await limit.boundingBox()).width,
      };
      measurements.push({ label: "350px nested control width", ...widths });
      expect(widths.nested).toBeGreaterThanOrEqual(widths.top * 0.75);
      expect(widths.nested).toBeGreaterThanOrEqual(210);
      expect(widths.limit).toBeGreaterThanOrEqual(210);
      await limit.fill("-");
      await expect(pending()).not.toHaveText("0");
      expect(await stored()).toEqual(deepValue);
      await page
        .getByRole("button", { name: "Help for Limit", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", {
          name: "Help for Limit",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(limit).toHaveValue("-");
      await limit.fill("11");
      expect(
        (await stored()).settings.stages[0].options.headers.primary.limit,
      ).toBe(11);
      await expect(pending()).toHaveText("0");
    },
  );
  await check(
    "if-then-else changes requiredness while preserving inactive values and unfinished child edits",
    async () => {
      const initial = {
        mode: "remote",
        port: 443,
        opaque: { nullable: null, ordered: [false, 0, "kept"] },
      };
      await fixture({
        mode: "fields",
        schema: conditionalSchema,
        value: initial,
        root: {},
      });
      const mode = page.getByLabel("Mode", { exact: true }),
        portInput = page.getByLabel("Port", { exact: true });
      await expect(portInput).toHaveAttribute("aria-required", "true");
      await expect(
        page.locator('[data-field-name="port"] > .schema-condition-note'),
      ).toHaveText('Required when Mode is "remote".');
      await expect(page.getByLabel("Prefix", { exact: true })).toHaveCount(0);
      await portInput.fill("-");
      await mode.selectOption({ label: "local" });
      await expect(portInput).toHaveValue("-");
      await expect(pending()).not.toHaveText("0");
      expect((await stored()).port).toBe(443);
      await portInput.fill("8443");
      await mode.selectOption({ label: "local" });
      const prefix = page.getByLabel("Prefix", { exact: true });
      await expect(prefix).toBeVisible();
      await expect(prefix).toHaveAttribute("aria-required", "true");
      await expect(
        page.locator('[data-field-name="prefix"] > .schema-condition-note'),
      ).toHaveCount(0);
      await expect(portInput).not.toHaveAttribute("aria-required", "true");
      await prefix.fill("local-events");
      await mode.selectOption({ label: "remote" });
      await expect(portInput).toHaveAttribute("aria-required", "true");
      await expect(prefix).not.toHaveAttribute("aria-required", "true");
      expect(await stored()).toEqual({
        ...initial,
        port: 8443,
        prefix: "local-events",
      });
      await expect(pending()).toHaveText("0");
      await page.setViewportSize({ width: 375, height: 1000 });
      await axe("conditional requirements at 375px");
      await page.screenshot({
        path: resolve(output, "inspector-conditional-375-light.png"),
        fullPage: true,
        animations: "disabled",
      });
    },
  );
  await check(
    "property dependencies use presence including false, reveal requirements and preserve values when removed",
    async () => {
      const schema = {
        type: "object",
        properties: {
          flag: { type: "boolean", title: "Flag" },
          region: { type: "string", title: "Region" },
        },
        dependentRequired: { flag: ["region"] },
        dependentSchemas: {
          flag: {
            properties: {
              endpoint: { type: "string", title: "Endpoint", minLength: 1 },
            },
            required: ["endpoint"],
          },
        },
      };
      await fixture({
        mode: "fields",
        schema,
        value: { flag: false, opaque: { retained: true } },
        root: {},
      });
      await expect(page.getByLabel("Region", { exact: true })).toHaveAttribute(
        "aria-required",
        "true",
      );
      await expect(
        page.getByLabel("Endpoint", { exact: true }),
      ).toHaveAttribute("aria-required", "true");
      await page.getByLabel("Region", { exact: true }).fill("us-west-2");
      await page
        .getByLabel("Endpoint", { exact: true })
        .fill("https://collector.example.test");
      await action("Flag", "Remove flag");
      expect(await stored()).toEqual({
        region: "us-west-2",
        endpoint: "https://collector.example.test",
        opaque: { retained: true },
      });
      await expect(
        page.getByLabel("Region", { exact: true }),
      ).not.toHaveAttribute("aria-required", "true");
      await fixture({
        mode: "fields",
        schema: {
          type: "object",
          properties: {
            wrong: { type: "string" },
            correct: { type: "string" },
          },
          if: false,
          then: { required: ["wrong"] },
          else: { required: ["correct"] },
        },
        value: {},
        root: {},
      });
      await expect(page.getByLabel("Correct", { exact: true })).toHaveAttribute(
        "aria-required",
        "true",
      );
      await expect(page.getByLabel("Wrong", { exact: true })).toHaveCount(0);
      await fixture({
        mode: "fields",
        schema: {
          type: "object",
          properties: {
            wrong: { type: "string" },
            correct: { type: "string" },
          },
          if: { $ref: "#/definitions/not-present" },
          then: { required: ["wrong"] },
          else: { required: ["correct"] },
        },
        value: { opaque: [null, false, 0] },
        root: {},
      });
      await expect(page.getByLabel("Correct", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Wrong", { exact: true })).toHaveCount(0);
      expect(await stored()).toEqual({ opaque: [null, false, 0] });
    },
  );
  await check(
    "literal-union choices remain selectable including actual Buffer When Full",
    async () => {
      const buffer =
        root.definitions["vectory::components::sinks::console"].allOf[0]
          .properties.buffer;
      const initial = { type: "memory", max_events: 500, when_full: "block" };
      await fixture({ name: "buffer", schema: buffer, value: initial });
      const when = page.getByLabel("When Full", { exact: true });
      await expect(when).toHaveJSProperty("tagName", "SELECT");
      await when.selectOption({ label: "drop_newest" });
      expect(await stored()).toEqual({ ...initial, when_full: "drop_newest" });
      await when.selectOption({ label: "block" });
      expect(await stored()).toEqual(initial);
      await fixture({
        mode: "fields",
        schema: {
          type: "object",
          properties: {
            mode: { oneOf: [{ const: "memory" }, { const: "disk" }] },
            note: { type: "string" },
          },
          required: ["mode"],
        },
        value: { mode: "memory", note: "keep" },
        root: {},
      });
      const mode = page.getByLabel("Mode", { exact: true });
      await expect(mode).toHaveJSProperty("tagName", "SELECT");
      await mode.selectOption({ label: "disk" });
      expect(await stored()).toEqual({ mode: "disk", note: "keep" });
      await mode.selectOption({ label: "memory" });
      expect(await stored()).toEqual({ mode: "memory", note: "keep" });
    },
  );
  await check(
    "additional-map removal cannot bypass pending conditional-field protection",
    async () => {
      const settings = {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1 } },
        required: ["limit"],
      };
      for (const rule of [
        {
          dependentSchemas: {
            feature: { properties: { settings }, required: ["settings"] },
          },
        },
        {
          if: {
            properties: { feature: { const: true } },
            required: ["feature"],
          },
          then: { properties: { settings }, required: ["settings"] },
        },
      ]) {
        const initial = {
          note: "keep",
          feature: true,
          settings: { limit: 7 },
          opaque: { nullable: null },
        };
        await fixture({
          mode: "fields",
          schema: {
            type: "object",
            properties: { note: { type: "string" } },
            ...rule,
          },
          value: initial,
          root: {},
        });
        const limit = page.getByLabel("Limit", { exact: true });
        await limit.fill("-");
        await expect(pending()).not.toHaveText("0");
        await action("Feature", "Remove entry feature");
        await expect(limit).toHaveValue("-");
        await expect(pending()).not.toHaveText("0");
        expect(await stored()).toEqual(initial);
        await limit.fill("9");
        await action("Feature", "Remove entry feature");
        expect(await stored()).toEqual({
          note: "keep",
          settings: { limit: 9 },
          opaque: { nullable: null },
        });
        await expect(limit).toHaveValue("9");
        await expect(pending()).toHaveText("0");
      }
      // The inverse transition also must not replace a pending Additional
      // field with a newly declared control when its controller changes.
      await fixture({
        mode: "fields",
        schema: {
          type: "object",
          properties: { mode: { type: "string", enum: ["local", "remote"] } },
          additionalProperties: {
            type: "object",
            properties: { limit: { type: "integer" } },
          },
          if: { properties: { mode: { const: "remote" } }, required: ["mode"] },
          then: {
            properties: { settings },
            required: ["settings"],
          },
        },
        value: { mode: "local", settings: { limit: 7 } },
        root: {},
      });
      const limit = page.getByLabel("Limit", { exact: true });
      await limit.fill("-");
      await expect(pending()).not.toHaveText("0");
      await page
        .getByLabel("Mode", { exact: true })
        .selectOption({ label: "remote" });
      await expect(limit).toHaveValue("-");
      await expect(pending()).not.toHaveText("0");
      expect(await stored()).toEqual({ mode: "local", settings: { limit: 7 } });
      await limit.fill("9");
      await page
        .getByLabel("Mode", { exact: true })
        .selectOption({ label: "remote" });
      expect(await stored()).toEqual({
        mode: "remote",
        settings: { limit: 9 },
      });
      await expect(limit).toHaveValue("9");
      await expect(pending()).toHaveText("0");
    },
  );
  await check(
    "inactive conditional fields preserve sensitive and read-only editing boundaries",
    async () => {
      const settings = {
        type: "object",
        properties: {
          token: { type: "string", _metadata: { sensitive: true } },
          locked: { type: "string", readOnly: true },
        },
        required: ["token", "locked"],
      };
      const value = {
        feature: true,
        settings: { token: "${TOKEN}", locked: "read-only-value" },
        note: "keep",
      };
      await fixture({
        mode: "fields",
        schema: {
          type: "object",
          properties: { note: { type: "string" } },
          dependentSchemas: {
            feature: { properties: { settings }, required: ["settings"] },
          },
        },
        value,
        root: {},
      });
      await action("Feature", "Remove entry feature");
      const retained = page.getByRole("region", {
        name: "Kept from another selection",
      });
      await expect(retained).toBeVisible();
      await expect(
        retained.locator('[data-field-name="settings"]'),
      ).toHaveCount(1);
      const token = page.getByLabel("Token reference", { exact: true });
      await expect(token).toHaveValue("${TOKEN}");
      await expect(page.getByLabel("Locked", { exact: true })).toHaveAttribute(
        "readonly",
        "",
      );
      await token.fill("must-never-be-stored");
      expect(await stored()).toEqual({
        settings: { token: "${TOKEN}", locked: "read-only-value" },
        note: "keep",
      });
      await expect(pending()).not.toHaveText("0");
      await token.fill("${ROTATED_TOKEN}");
      expect((await stored()).settings.token).toBe("${ROTATED_TOKEN}");
      await expect(pending()).toHaveText("0");
      await page.setViewportSize({ width: 375, height: 1000 });
      await axe("retained conditional settings at 375px");
      await page.screenshot({
        path: resolve(output, "inspector-retained-375-light.png"),
        fullPage: true,
        animations: "disabled",
      });
    },
  );
  await check(
    "350px nested inspector at899/375 light and dark remains contained and accessible",
    async () => {
      for (const width of [899, 375])
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          await fixture({
            mode: "fields",
            schema: deepSchema,
            value: deepValue,
            root: {},
          });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          const box = await page
            .getByLabel("Value", { exact: true })
            .boundingBox();
          expect(box.width).toBeGreaterThanOrEqual(210);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          measurements.push({
            label: `nested inspector ${width} ${theme}`,
            leaf: box,
          });
          await axe(`nested inspector ${width} ${theme}`);
          await page.screenshot({
            path: resolve(output, `inspector-nested-${width}-${theme}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
    },
  );
  expect(results.filter((result) => !result.passed)).toEqual([]);
  expect(results).toHaveLength(conditionsOnly ? 6 : 9);
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const source_sha256 = {};
  for (const name of [
    "PipelineSchemaFields.tsx",
    "SchemaValueEditor.tsx",
    "SchemaFieldChrome.tsx",
    "pipelineSchema.ts",
    "schema-controls.css",
    "inspector.css",
  ]) {
    source_sha256["dashboard/src/" + name] = createHash("sha256")
      .update(await readFile(resolve(dashboard, "src", name)))
      .digest("hex");
  }
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope: conditionsOnly
          ? "Focused actual-control follow-up for ordinary and additional-map conditional changes, pending input protection, inactive sensitive/read-only metadata and literal-union choices including actual Buffer When Full. Five groups only; prior general Buffer/width/accessibility groups were not rerun. No native validation or live API writes."
          : "Actual shared schema controls in an isolated 350px synthetic fixture, including pinned Buffer schema and synthetic conditional/deep schemas. No native configuration validation or live API writes.",
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
  await browser.close();
  await server.close();
  console.log(
    "Evidence:",
    relative(repository, resolve(output, "report.json")),
  );
}
