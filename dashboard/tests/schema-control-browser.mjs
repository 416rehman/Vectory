import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "./axe.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import net from "node:net";
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Any free port: parallel runs never collide.
const reservation = net.createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const server = await createServer({
  root: dashboard,
  cacheDir: resolve(dashboard, "../.local/schema-controls-cache"),
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
});
await server.listen();
const browser = await chromium.launch(),
  context = await browser.newContext({
    viewport: { width: 1000, height: 1000 },
  }),
  page = await context.newPage();
page.setDefaultTimeout(6000);
// Chromium runs the zero-delay timers a click queues only after its next
// frame, while the next test step may already be running. A test can hold
// them, so the late case is tested on purpose rather than left to chance.
await page.addInitScript(() => {
  const set = window.setTimeout.bind(window),
    clear = window.clearTimeout.bind(window),
    held = new Map();
  let holding = false,
    next = 1e9;
  window.setTimeout = (run, delay, ...args) => {
    if (!holding || delay > 0 || typeof run !== "function")
      return set(run, delay, ...args);
    held.set(++next, () => run(...args));
    return next;
  };
  window.clearTimeout = (id) => {
    if (!held.delete(id)) clear(id);
  };
  window.holdZeroDelayTimers = () => (holding = true);
  window.releaseZeroDelayTimers = () => {
    holding = false;
    for (const [id, run] of [...held]) {
      held.delete(id);
      run();
    }
  };
});
const errors = [],
  results = [];
page.on("pageerror", (error) => errors.push(error.message));
const schemaText = await readFile(
    resolve(dashboard, "src/generated/vector-schema.json"),
    "utf8",
  ),
  root = JSON.parse(schemaText);
async function fixture(test) {
  await page.evaluate((test) => window.renderControl(test), {
    ...test,
    root: test.root || root,
  });
  await page.waitForFunction(
    () => window.currentRevision === window.expectedRevision,
  );
  if (test.mode === "globals")
    await expect(
      page.getByRole("dialog", { name: "Pipeline settings", exact: true }),
    ).toBeVisible();
  else
    await expect(
      page.getByRole("heading", { name: "Schema control verification" }),
    ).toBeVisible();
}
const stored = async () => {
  const text = await page.evaluate(() => JSON.stringify(window.stored));
  return text === undefined ? undefined : JSON.parse(text);
};
async function fieldAction(label) {
  const triggers = page.getByRole("button", { name: /^Actions for / });
  for (let i = 0; i < (await triggers.count()); i++) {
    const trigger = triggers.nth(i);
    if (!(await trigger.isVisible())) continue;
    await trigger.click();
    const action = page.getByRole("menuitem", { name: label, exact: true });
    if (await action.count()) {
      await action.click();
      // The menu hands focus back once it has left the page, a tick later.
      // Wait for that, or a fast machine's next step races the late move.
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
      return;
    }
    await page.keyboard.press("Escape");
  }
  throw Error(`Missing field action: ${label}`);
}

async function reveal(field) {
  for (let i = 0; i < 12 && !(await field.isVisible()); i++) {
    const closed = await field
      .locator("xpath=ancestor::details[not(@open)]")
      .all();
    let opened = false;
    for (const details of closed) {
      const summary = details.locator(":scope > summary");
      if (await summary.isVisible()) {
        await summary.click();
        opened = true;
        break;
      }
    }
    if (!opened) break;
  }
  return field;
}
async function test(name, run) {
  if (
    process.env.VECTORY_SCHEMA_TEST_FILTER &&
    !name.includes(process.env.VECTORY_SCHEMA_TEST_FILTER)
  )
    return;
  // With the filter, VECTORY_SCHEMA_TEST_REPEAT=N runs the matching test N
  // times in one browser session, to reproduce a rare timing failure.
  const repeat = Number(process.env.VECTORY_SCHEMA_TEST_REPEAT) || 1;
  try {
    for (let round = 1; round <= repeat; round++) {
      await run();
      if (repeat > 1 && round % 25 === 0)
        console.log(`  ${name}: ${round} of ${repeat} rounds passed`);
    }
    results.push({ name, passed: true });
    console.log("PASS", name);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error("FAIL", name, error.message);
    console.error((await page.locator("body").innerText()).slice(0, 12000));
    await page.screenshot({
      path: resolve(dashboard, "../.local/schema-control-failure.png"),
      fullPage: true,
    });
    throw error;
  }
}
try {
  await page.goto(`http://127.0.0.1:${port}/tests/schema-controls.html`, {
    timeout: 30000,
  });
  await page.waitForFunction(() => window.ready);
  await test("numeric drafts enforce bounds without saving partial text", async () => {
    await fixture({
      name: "batch_limit",
      schema: { type: "integer", minimum: 1, maximum: 100 },
      value: 20,
    });
    const input = page.getByLabel("Batch limit", { exact: true });
    await input.fill("-");
    expect(await stored()).toBe(20);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.fill("101");
    expect(await stored()).toBe(20);
    await input.fill("34");
    expect(await stored()).toBe(34);
    await expect(page.getByLabel("Pending edits")).toHaveText("0");
  });
  await test("duration and bytes display units preserve numeric wire value", async () => {
    await fixture({
      name: "timeout",
      schema: {
        type: "number",
        minimum: 0,
        _metadata: { "docs::type_unit": "seconds" },
      },
      value: 60,
    });
    await page
      .getByLabel("Timeout display unit")
      .selectOption({ label: "minutes" });
    await expect(page.getByLabel("Timeout", { exact: true })).toHaveValue("1");
    expect(await stored()).toBe(60);
    await page.getByLabel("Timeout", { exact: true }).fill("2");
    expect(await stored()).toBe(120);
    await fixture({
      name: "max_size",
      schema: {
        type: "integer",
        minimum: 1,
        _metadata: { "docs::type_unit": "bytes" },
      },
      value: 1048576,
    });
    await page
      .getByLabel("Max size display unit")
      .selectOption({ label: "MiB" });
    await page.getByLabel("Max size", { exact: true }).fill("2");
    expect(await stored()).toBe(2097152);
  });
  await test("ordered primitive arrays retain empty strings and reorder exact values", async () => {
    await fixture({
      name: "values",
      schema: { type: "array", items: { type: "string" } },
      value: ["a", "", "c"],
    });
    await expect(page.getByLabel("Item 2", { exact: true })).toHaveValue("");
    await page.getByLabel("Item 2", { exact: true }).fill("b");
    await fieldAction("Move item 3 up");
    expect(await stored()).toEqual(["a", "c", "b"]);
    await fieldAction("Duplicate item 1");
    expect(await stored()).toEqual(["a", "c", "b", "a"]);
  });
  await test("staged invalid array entries stay local until valid", async () => {
    await fixture({
      name: "topics",
      schema: { type: "array", items: { type: "string", minLength: 1 } },
      value: ["logs"],
    });
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    expect(await stored()).toEqual(["logs"]);
    await page.getByLabel("Item 2", { exact: true }).fill("metrics");
    expect(await stored()).toEqual(["logs", "metrics"]);
  });
  await test("list constraints and cleared numeric items stay pending without corrupting values", async () => {
    await fixture({
      name: "values",
      schema: { type: "array", uniqueItems: true, items: { type: "string" } },
      value: ["a", "b"],
    });
    await page.getByLabel("Item 2", { exact: true }).fill("a");
    expect(await stored()).toEqual(["a", "b"]);
    await expect(page.getByLabel("Pending edits")).not.toHaveText("0");
    await page.getByLabel("Item 2", { exact: true }).fill("c");
    expect(await stored()).toEqual(["a", "c"]);
    await fixture({
      name: "counts",
      schema: { type: "array", items: { type: "integer" } },
      value: [1, 2],
    });
    await page.getByLabel("Item 1", { exact: true }).fill("");
    expect(await stored()).toEqual([1, 2]);
    await page.getByLabel("Item 1", { exact: true }).fill("5");
    expect(await stored()).toEqual([5, 2]);
  });
  await test("typed maps rename and reject duplicate keys", async () => {
    await fixture({
      name: "headers",
      schema: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } },
      },
      value: { a: ["one"], b: ["two"] },
    });
    await fieldAction("Rename a");
    await page.getByLabel("Rename a", { exact: true }).fill("b");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(
      page.getByText("An entry with this name already exists."),
    ).toBeVisible();
    expect(await stored()).toEqual({ a: ["one"], b: ["two"] });
    await page.getByLabel("Rename a", { exact: true }).fill("c");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    expect(await stored()).toEqual({ c: ["one"], b: ["two"] });
  });
  await test("null remains distinct from absence and configured values", async () => {
    await fixture({
      name: "namespace",
      schema: { type: ["string", "null"], default: null },
      value: null,
    });
    expect(await stored()).toBe(null);
    await expect(
      page.getByLabel("Namespace format", { exact: true }),
    ).toHaveCount(0);
    await fieldAction("Enter Namespace value");
    await page.getByLabel("Namespace", { exact: true }).fill("events");
    expect(await stored()).toBe("events");
  });
  await test("adding optional Region opens text entry and retains explicit null support", async () => {
    const region =
      root.definitions["vector::aws::region::RegionOrEndpoint"].properties
        .region;
    await fixture({
      name: "aws",
      schema: {
        type: "object",
        properties: { region: { ...region, default: null } },
      },
      value: {},
    });
    await (
      await reveal(
        page.getByRole("button", {
          name: "Add field",
          exact: true,
          includeHidden: true,
        }),
      )
    ).click();
    await page.getByRole("button", { name: /^Region / }).click();
    const input = page.getByLabel("Region", { exact: true });
    await expect(input).toHaveValue("");
    expect(await stored()).toEqual({ region: "" });
    await input.fill("us-west-2");
    expect(await stored()).toEqual({ region: "us-west-2" });
    await page.screenshot({
      path: resolve(dashboard, "../.local/schema-region-compact.png"),
      fullPage: true,
    });
    await expect(page.getByLabel("Region format", { exact: true })).toHaveCount(
      0,
    );
    await fieldAction("Set Region to null");
    expect(await stored()).toEqual({ region: null });
    await fieldAction("Enter Region value");
    await expect(input).toHaveValue("us-west-2");
    await fixture({
      name: "aws",
      schema: {
        type: "object",
        properties: { region: { ...region, default: null } },
      },
      value: { region: null },
    });
    expect(await stored()).toEqual({ region: null });
    await expect(
      page.getByLabel("Region: null", { exact: true }),
    ).toBeVisible();
    await fieldAction("Remove region");
    expect(await stored()).toEqual({});
  });
  await test("nested Timezone keeps its mode and identity with compact nullable actions", async () => {
    const timezone = root.allOf.find((part) => part.properties?.timezone)
      .properties.timezone;
    await fixture({ name: "timezone", schema: timezone, value: null });
    await expect(
      page.getByLabel("Timezone format", { exact: true }),
    ).toHaveCount(0);
    await fieldAction("Enter Timezone value");
    const mode = page.getByLabel("Timezone mode", { exact: true });
    await mode.selectOption({ label: "Named" });
    const input = page.getByLabel("Timezone", { exact: true });
    await expect(input).toBeVisible();
    await input.fill("America/Edmonton");
    expect(await stored()).toBe("America/Edmonton");
    await mode.selectOption({ label: "Local" });
    expect(await stored()).toBe("local");
    await mode.selectOption({ label: "Named" });
    await expect(input).toHaveValue("America/Edmonton");
    await expect(page.getByLabel("Named", { exact: true })).toHaveCount(0);
    await fieldAction("Set Timezone to null");
    expect(await stored()).toBe(null);
    await fieldAction("Enter Timezone value");
    await expect(input).toHaveValue("America/Edmonton");
    await expect(mode).toBeVisible();
    await page.screenshot({
      path: resolve(dashboard, "../.local/schema-timezone-compact.png"),
      fullPage: true,
    });
  });
  await test("nullable actions preserve pending drafts and nested values and respect read-only fields", async () => {
    await fixture({
      name: "count",
      schema: { type: ["integer", "null"], minimum: 0 },
      value: 12,
    });
    const input = page.getByLabel("Count", { exact: true });
    await input.fill("-");
    await fieldAction("Set Count to null");
    await expect(input).toHaveValue("-");
    expect(await stored()).toBe(12);
    await expect(page.getByLabel("Pending edits")).not.toHaveText("0");
    await expect(
      page.getByText(
        "Apply or discard pending field changes before changing this field.",
      ),
    ).toBeVisible();
    await input.fill("14");
    // Applying what was pending ends the refusal; it doesn't linger in red.
    await expect(
      page.getByText(
        "Apply or discard pending field changes before changing this field.",
      ),
    ).toHaveCount(0);
    await fieldAction("Set Count to null");
    expect(await stored()).toBe(null);
    await fieldAction("Enter Count value");
    await expect(input).toHaveValue("14");
    const shape = {
      type: ["object", "null"],
      properties: { count: { type: "integer" } },
    };
    await fixture({ name: "settings", schema: shape, value: { count: 8 } });
    await (await reveal(page.getByLabel("Count", { exact: true }))).fill("-");
    await fieldAction("Set Settings to null");
    expect(await stored()).toEqual({ count: 8 });
    await expect(page.getByLabel("Count", { exact: true })).toHaveValue("-");
    await page.getByLabel("Count", { exact: true }).fill("9");
    await fieldAction("Set Settings to null");
    expect(await stored()).toBe(null);
    await fieldAction("Enter Settings value");
    expect(await stored()).toEqual({ count: 9 });
    await fixture({
      name: "values",
      schema: { type: ["array", "null"], items: { type: "string" } },
      value: ["a", "", "b"],
    });
    await fieldAction("Set Values to null");
    await fieldAction("Enter Values value");
    expect(await stored()).toEqual(["a", "", "b"]);
    await fixture({
      name: "count",
      schema: { type: ["integer", "null"] },
      value: null,
      editable: false,
    });
    await expect(page.getByLabel("Count: null", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Actions for Count", exact: true }),
    ).toHaveCount(0);
    await fixture({
      name: "count",
      schema: { type: ["integer", "null"], readOnly: true },
      value: 12,
    });
    await expect(
      page.getByRole("button", { name: "Actions for Count", exact: true }),
    ).toHaveCount(0);
    expect(await stored()).toBe(12);
    await fixture({
      name: "settings",
      schema: {
        type: "object",
        properties: { count: { type: ["integer", "null"] } },
      },
      value: { count: null },
    });
    await fieldAction("Enter Count value");
    await expect(page.getByLabel("Count", { exact: true })).toBeVisible();
    expect(await stored()).toEqual({ count: null });
    expect(await page.evaluate(() => window.testHistory)).toEqual([]);
    await expect(page.getByLabel("Pending edits")).not.toHaveText("0");
    await page.getByLabel("Count", { exact: true }).fill("7");
    expect(await stored()).toEqual({ count: 7 });
    await fieldAction("Remove count");
    expect(await stored()).toEqual({});
    await expect(page.getByLabel("Count", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Pending edits")).toHaveText("0");
    await expect(
      page.getByRole("button", { name: "Add field", exact: true }),
    ).toBeFocused();
  });
  await test("actual nullable integer without a default opens pending blank entry and preserves round trips", async () => {
    const schema =
      root.definitions[
        "codecs::decoding::framing::character_delimited::CharacterDelimitedDecoderOptions"
      ];
    await fixture({
      name: "framing",
      schema,
      value: { delimiter: 10, max_length: null },
    });
    await fieldAction("Enter Max Length value");
    const input = page.getByLabel("Max Length", { exact: true });
    await expect(input).toHaveValue("");
    expect(await stored()).toEqual({ delimiter: 10, max_length: null });
    expect(await page.evaluate(() => window.testHistory)).toEqual([]);
    await expect(page.getByLabel("Pending edits")).not.toHaveText("0");
    await input.fill("-");
    await fieldAction("Cancel Max Length value edit");
    expect(await stored()).toEqual({ delimiter: 10, max_length: null });
    expect(await page.evaluate(() => window.testHistory)).toEqual([]);
    await expect(page.getByLabel("Pending edits")).toHaveText("0");
    await fieldAction("Enter Max Length value");
    await input.fill("2048");
    expect(await stored()).toEqual({ delimiter: 10, max_length: 2048 });
    await expect(page.getByLabel("Pending edits")).toHaveText("0");
    await fieldAction("Set Max Length to null");
    expect(await stored()).toEqual({ delimiter: 10, max_length: null });
    await fieldAction("Enter Max Length value");
    await expect(input).toHaveValue("2048");
    await fixture({
      name: "framing",
      schema,
      value: { delimiter: 10, max_length: null },
    });
    await fieldAction("Enter Max Length value");
    await input.fill("-");
    await page.evaluate(() =>
      window.setExternalValue({ delimiter: 10, max_length: 4096 }),
    );
    await expect(input).toHaveValue("4096");
    expect(await stored()).toEqual({ delimiter: 10, max_length: 4096 });
    expect(await page.evaluate(() => window.testHistory)).toEqual([]);
    await expect(page.getByLabel("Pending edits")).toHaveText("0");
    await expect(
      page.getByRole("button", {
        name: "Cancel Max Length value edit",
        exact: true,
      }),
    ).toHaveCount(0);
    await fixture({
      name: "value",
      schema: { oneOf: [{ type: "integer" }, { type: "string" }] },
    });
    await page
      .getByLabel("Value format", { exact: true })
      .selectOption({ label: "Integer" });
    expect(await stored()).toBe(undefined);
    expect(await page.evaluate(() => window.testHistory)).toEqual([]);
    await expect(page.getByLabel("Pending edits")).not.toHaveText("0");
    await fieldAction("Cancel Value value edit");
    expect(await stored()).toBe(undefined);
    await expect(page.getByLabel("Pending edits")).toHaveText("0");
  });
  await test("untagged string-object union switches explicitly and restores values", async () => {
    await fixture({
      name: "condition",
      schema: {
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              source: { type: "string" },
              type: { const: "vrl", type: "string" },
            },
            required: ["source", "type"],
          },
        ],
      },
      value: ".status == 500",
    });
    const select = page.getByLabel("Condition format", { exact: true });
    const opts = await select.locator("option").allTextContents();
    await select.selectOption({
      label: opts.find((label) => label.toLowerCase().includes("object")),
    });
    await page.getByLabel("Source", { exact: true }).fill(".status >= 400");
    expect((await stored()).source).toBe(".status >= 400");
    await select.selectOption({
      label: opts.find((label) => label.toLowerCase() === "text"),
    });
    expect(await stored()).toBe(".status == 500");
  });
  await test("credential drafts never save plaintext including sensitive arrays", async () => {
    await fixture({
      name: "password",
      schema: { type: "string", _metadata: { sensitive: true } },
      value: "${TOKEN}",
    });
    await page
      .getByLabel("Password reference", { exact: true })
      .fill("not-a-reference");
    expect(await stored()).toBe("${TOKEN}");
    await page
      .getByLabel("Password reference", { exact: true })
      .fill("SECRET[local.password]");
    expect(await stored()).toBe("SECRET[local.password]");
    await fixture({
      name: "valid_tokens",
      schema: {
        type: "array",
        _metadata: { sensitive: true },
        items: { type: "string" },
      },
      value: ["${TOKEN}"],
    });
    await page
      .getByLabel("Item 1 reference", { exact: true })
      .fill("plaintext");
    expect(await stored()).toEqual(["${TOKEN}"]);
  });
  await test("nested object array follows actual chained buffer schema", async () => {
    const buffer =
      root.definitions["vectory::components::sinks::console"].allOf[0]
        .properties.buffer;
    if (!buffer) throw Error("Pinned buffer schema missing");
    await fixture({
      name: "buffer",
      schema: buffer,
      value: [
        { type: "memory", max_events: 500 },
        { type: "disk", max_size: 268435488 },
      ],
    });
    await (
      await reveal(page.getByLabel("Max Events", { exact: true }))
    ).fill("750");
    const value = await stored();
    expect(Array.isArray(value)).toBe(true);
    expect(value[0].max_events).toBe(750);
    expect(value[1].type).toBe("disk");
  });
  await test("actual Buffer variants preserve shared settings and remove inactive storage limits", async () => {
    const buffer =
      root.definitions["vectory::components::sinks::console"].allOf[0]
        .properties.buffer;
    await fixture({
      name: "buffer",
      schema: buffer,
      value: { type: "memory", max_events: 321, when_full: "overflow" },
    });
    await page.evaluate(() =>
      window.setExternalValue(
        JSON.parse(
          '{"type":"memory","max_events":321,"when_full":"overflow","__proto__":{"retained":true},"constructor":"opaque"}',
        ),
      ),
    );
    await expect
      .poll(async () => Object.hasOwn(await stored(), "__proto__"))
      .toBe(true);
    await expect(page.getByLabel("Type", { exact: true })).toHaveCount(1);
    const mode = page.getByLabel("Buffer mode", { exact: true });
    await expect(mode).toBeVisible();
    const labels = await mode.locator("option").allTextContents();
    await mode.selectOption({
      label: labels.find((label) => /size/i.test(label)),
    });
    expect((await stored()).when_full).toBe("overflow");
    expect((await stored()).type).toBe("memory");
    expect((await stored()).max_events).toBeUndefined();
    expect(Object.hasOwn(await stored(), "__proto__")).toBe(true);
    expect((await stored()).__proto__).toEqual({ retained: true });
    expect((await stored()).constructor).toBe("opaque");
    await page.getByLabel("Max Size", { exact: true }).fill("1024");
    await mode.selectOption({ label: "Max Events" });
    expect((await stored()).max_events).toBe(321);
    await page.getByLabel("Max Events", { exact: true }).fill("750");
    await page
      .getByLabel("Type", { exact: true })
      .selectOption({ label: "Disk V2" });
    expect((await stored()).max_events).toBeUndefined();
    expect((await stored()).when_full).toBe("overflow");
    await page.getByLabel("Max Size", { exact: true }).fill("536870912");
    await page
      .getByLabel("Type", { exact: true })
      .selectOption({ label: "Memory" });
    await expect(page.getByLabel("Max Events", { exact: true })).toHaveValue(
      "750",
    );
    expect((await stored()).when_full).toBe("overflow");
    expect((await stored()).max_size).toBeUndefined();
  });
  await test("actual nested nullable HTTP auth permits safe strategy changes", async () => {
    await fixture({
      name: "auth",
      schema: {
        $ref: "#/definitions/core::option::Option<vector::http::Auth>",
      },
      value: { strategy: "basic", user: "${USER}", password: "${PASSWORD}" },
    });
    await page
      .getByLabel("Strategy", { exact: true })
      .selectOption({ label: "Bearer" });
    await page.getByLabel("Token reference", { exact: true }).fill("${TOKEN}");
    expect(await stored()).toEqual({ strategy: "bearer", token: "${TOKEN}" });
    await page
      .getByLabel("Strategy", { exact: true })
      .selectOption({ label: "Basic" });
    expect(await stored()).toEqual({
      strategy: "basic",
      user: "${USER}",
      password: "${PASSWORD}",
    });
  });
  await test("raw JSON draft survives collapse and structured edits", async () => {
    await fixture({
      name: "settings",
      schema: { type: "object", properties: { amount: { type: "number" } } },
      value: { amount: 4 },
    });
    await page.getByLabel("Amount", { exact: true }).fill("-");
    await fieldAction("Edit Settings as JSON");
    await expect(
      page.getByRole("textbox", { name: "Settings (JSON)", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("-");
    expect(await stored()).toEqual({ amount: 4 });
    await page.getByLabel("Amount", { exact: true }).fill("4");
    await fieldAction("Edit Settings as JSON");
    const raw = page.getByRole("textbox", {
      name: "Settings (JSON)",
      exact: true,
    });
    await raw.fill('{"amount":12,"retained":true}');
    await fieldAction("Edit Settings as fields");
    await page.getByLabel("Amount", { exact: true }).fill("8");
    await fieldAction("Edit Settings as JSON");
    await expect(raw).toHaveText('{"amount":12,"retained":true}');
    expect(await stored()).toEqual({ amount: 8 });
    await expect(page.getByLabel("Pending edits")).not.toHaveText("0");
  });
  await test("completed required fields and variant settings have no generic disclosure", async () => {
    await fixture({
      name: "config",
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      value: { name: "configured" },
    });
    await expect(page.getByLabel("Name", { exact: true })).toHaveAttribute(
      "aria-required",
      "true",
    );
    await expect(
      page.locator(".schema-record-label > .schema-required"),
    ).toHaveCount(1);
    const variants = {
      oneOf: [
        {
          type: "object",
          _metadata: { "docs::human_name": "JSON" },
          properties: { codec: { const: "json" }, pretty: { type: "boolean" } },
          required: ["codec"],
        },
        {
          type: "object",
          _metadata: { "docs::human_name": "Text" },
          properties: { codec: { const: "text" }, prefix: { type: "string" } },
          required: ["codec"],
        },
      ],
    };
    await fixture({
      name: "encoding",
      schema: variants,
      value: { codec: "json" },
    });
    await expect(page.locator("details.schema-object-optional")).toHaveCount(0);
    await expect(page.getByLabel("Codec", { exact: true })).toHaveCount(1);
    expect(await stored()).toEqual({ codec: "json" });
    await expect(
      page.getByRole("button", { name: "Add field", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".schema-record-header").filter({
        has: page.getByRole("button", { name: "Add field", exact: true }),
      }),
    ).toHaveCount(1);
    await fixture({ name: "encoding", schema: variants, value: {} });
    await expect(
      page.getByText("More than one format matches this value.", {
        exact: false,
      }),
    ).toHaveCount(0);
  });
  await test("JSON controls format locally and block invalid or secret-bearing values", async () => {
    await fixture({
      name: "settings",
      schema: {
        type: "object",
        properties: {
          amount: { type: "integer", minimum: 1 },
          auth: {
            type: "object",
            properties: {
              password: { type: "string", _metadata: { sensitive: true } },
            },
          },
        },
      },
      value: { amount: 4 },
    });
    await fieldAction("Edit Settings as JSON");
    const raw = page.getByRole("textbox", {
        name: "Settings (JSON)",
        exact: true,
      }),
      apply = page.getByRole("button", { name: "Apply settings", exact: true });
    await raw.fill('{"amount":12}');
    await page
      .getByRole("button", { name: "Format JSON", exact: true })
      .click();
    expect(await stored()).toEqual({ amount: 4 });
    await expect(raw).toContainText("12");
    await expect(page.getByLabel("Pending edits")).not.toHaveText("0");
    for (const text of [
      '{"amount":',
      '{"amount":-1}',
      '{"amount":9007199254740993}',
      '{"amount":12,"auth":{"password":"plaintext"}}',
    ]) {
      await raw.fill(text);
      await expect(apply).toBeDisabled();
      expect(await stored()).toEqual({ amount: 4 });
    }
    await raw.fill('{"amount":12,"auth":{"password":"${PASSWORD}"}}');
    await expect(apply).toBeEnabled();
    await apply.click();
    expect(await stored()).toEqual({
      amount: 12,
      auth: { password: "${PASSWORD}" },
    });
    await expect(page.getByLabel("Pending edits")).toHaveText("0");
    await raw.fill('{"amount":13}');
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    expect(await stored()).toEqual({
      amount: 12,
      auth: { password: "${PASSWORD}" },
    });
    await expect(page.getByLabel("Pending edits")).toHaveText("0");
  });
  await test("actual curated Syslog settings switch transport branches and restore their fields", async () => {
    const initial = {
      type: "syslog",
      mode: "tcp",
      address: "127.0.0.1:1514",
      connection_limit: 25,
      max_length: 1000,
      opaque_extension: { preserved: true },
    };
    await fixture({
      mode: "settings",
      kind: "sources",
      value: initial,
      config: {
        sources: {},
        transforms: {},
        sinks: { destination: { type: "blackhole", inputs: ["reviewed"] } },
      },
    });
    const mode = page.getByLabel("Mode", { exact: true }),
      address = page.getByLabel("Address", { exact: true });
    await expect(mode).toHaveCount(1);
    await expect(address).toHaveValue(initial.address);
    await expect(
      page.getByRole("checkbox", {
        name: "destination Destination",
        exact: true,
      }),
    ).toHaveCount(0);
    await mode.selectOption({ label: "UDP" });
    expect((await stored()).mode).toBe("udp");
    await address.fill("127.0.0.1:2514");
    await page.getByLabel("Max Length", { exact: true }).fill("2048");
    expect((await stored()).connection_limit).toBeUndefined();
    await mode.selectOption({ label: "Unix socket" });
    await expect(address).toHaveCount(0);
    await page
      .getByLabel("Path", { exact: true })
      .fill("/tmp/vectory-syslog.sock");
    expect((await stored()).address).toBeUndefined();
    await mode.selectOption({ label: "TCP" });
    await expect(address).toHaveValue(initial.address);
    expect((await stored()).connection_limit).toBe(25);
    expect((await stored()).max_length).toBe(2048);
    expect((await stored()).opaque_extension).toEqual({ preserved: true });
    await expect(
      page.getByRole("checkbox", {
        name: "destination Destination",
        exact: true,
      }),
    ).toHaveCount(0);
    await mode.selectOption({ label: "Unix socket" });
    await expect(page.getByLabel("Path", { exact: true })).toHaveValue(
      "/tmp/vectory-syslog.sock",
    );
    await mode.selectOption({ label: "UDP" });
    await expect(address).toHaveValue("127.0.0.1:2514");
    await mode.selectOption({ label: "TCP" });
    const limit = page.getByLabel("Connection Limit", { exact: true });
    await (await reveal(limit)).fill("-");
    await mode.selectOption({ label: "UDP" });
    expect((await stored()).mode).toBe("tcp");
    await expect(limit).toHaveValue("-");
    await expect(
      page.getByText(
        "Apply or discard pending field changes before changing formats.",
      ),
    ).toBeVisible();
    await limit.fill("30");
    await expect(
      page.getByText(
        "Apply or discard pending field changes before changing formats.",
      ),
    ).toHaveCount(0);
    await fieldAction("Remove max length");
    await mode.selectOption({ label: "UDP" });
    expect((await stored()).mode).toBe("udp");
    expect((await stored()).max_length).toBeUndefined();
    await mode.selectOption({ label: "TCP" });
    expect((await stored()).max_length).toBeUndefined();
    await page.screenshot({
      path: resolve(dashboard, "../.local/schema-syslog-mode.png"),
      fullPage: true,
    });
  });
  await test("noncurated Socket root form preserves connection fields and opaque edits across cached modes", async () => {
    const schema = root.definitions["vectory::components::sources::socket"];
    await fixture({
      mode: "fields",
      schema,
      value: {
        type: "socket",
        mode: "tcp",
        address: "127.0.0.1:7000",
        inputs: ["upstream"],
        opaque_extension: { revision: 1 },
      },
    });
    const mode = page.getByLabel("Mode", { exact: true }),
      address = page.getByLabel("Address", { exact: true });
    await mode.selectOption({ label: "UDP" });
    await address.fill("127.0.0.1:7001");
    const options = await mode.locator("option").allTextContents();
    const unix = options.find((label) => /unix/i.test(label));
    expect(unix).toBeTruthy();
    await mode.selectOption({ label: unix });
    await expect(address).toHaveCount(0);
    await page
      .getByLabel("Path", { exact: true })
      .fill("/tmp/vectory-socket.sock");
    await page.evaluate(() =>
      window.setExternalValue({
        ...window.stored,
        inputs: ["changed_upstream"],
        opaque_extension: { revision: 2 },
      }),
    );
    await mode.selectOption({ label: "TCP" });
    await expect(address).toHaveValue("127.0.0.1:7000");
    expect((await stored()).inputs).toEqual(["changed_upstream"]);
    expect((await stored()).opaque_extension).toEqual({ revision: 2 });
    await expect(page.getByLabel("Inputs", { exact: true })).toHaveCount(0);
    await mode.selectOption({ label: unix });
    await expect(page.getByLabel("Path", { exact: true })).toHaveValue(
      "/tmp/vectory-socket.sock",
    );
    await fixture({
      mode: "settings",
      kind: "sources",
      value: { type: "socket", mode: "tcp", address: "127.0.0.1:7000" },
      config: { sources: {}, transforms: {}, sinks: {} },
    });
    await page
      .getByLabel("Mode", { exact: true })
      .selectOption({ label: "UDP" });
    await page
      .getByLabel("Mode", { exact: true })
      .selectOption({ label: "TCP" });
    await expect(page.getByLabel("Address", { exact: true })).toHaveValue(
      "127.0.0.1:7000",
    );
  });
  await test("required-one-of groups keep real Remap and Sample settings instead of object format pickers", async () => {
    const config = {
      sources: { seed: { type: "demo_logs", format: "json" } },
      transforms: {},
      sinks: { destination: { type: "blackhole", inputs: ["reviewed"] } },
    };
    await fixture({
      mode: "settings",
      kind: "transforms",
      computeIssues: true,
      value: { type: "remap", inputs: ["seed"], source: ".reviewed = true" },
      config,
    });
    await expect(page.getByLabel("VRL program", { exact: true })).toHaveText(
      ".reviewed = true",
    );
    await expect(page.getByLabel(/^(Remap|Component) format$/)).toHaveCount(0);
    await page
      .getByLabel("VRL program", { exact: true })
      .fill(".reviewed = false");
    expect((await stored()).source).toBe(".reviewed = false");
    await fixture({
      mode: "settings",
      kind: "transforms",
      computeIssues: true,
      value: {
        type: "remap",
        inputs: ["seed"],
        file: "/etc/vector/program.vrl",
      },
      config,
    });
    await expect(
      page.getByText("Finish this step", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("VRL program", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByLabel("File", { exact: true })).toHaveValue(
      "/etc/vector/program.vrl",
    );
    await expect(page.getByText(/^Set one of:/)).toHaveCount(0);
    await expect(page.getByLabel(/^(Remap|Component) format$/)).toHaveCount(0);
    expect((await stored()).source).toBeUndefined();
    await fixture({
      mode: "settings",
      kind: "transforms",
      computeIssues: true,
      value: { type: "sample", inputs: ["seed"], rate: 10 },
      config,
    });
    await expect(page.getByLabel("One in every", { exact: true })).toHaveValue(
      "10",
    );
    await expect(page.getByLabel(/^(Sample|Component) format$/)).toHaveCount(0);
    await page.getByLabel("One in every", { exact: true }).fill("20");
    expect((await stored()).rate).toBe(20);
  });
  await test("rich controls pass accessibility checks", async () => {
    await fixture({
      name: "timeout",
      schema: {
        type: "number",
        minimum: 0,
        _metadata: { "docs::type_unit": "seconds" },
      },
      value: 60,
    });
    const analysis = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(analysis.violations).toEqual([]);
  });
  await test("owning action menus protect pending values and return focus after removal", async () => {
    await fixture({
      mode: "fields",
      schema: {
        type: "object",
        properties: {
          amount: {
            type: "integer",
            minimum: 0,
            description: "Maximum events in a batch.",
            default: 10,
            examples: [25],
          },
          note: { type: "string" },
        },
      },
      value: { amount: 4, note: "keep" },
    });
    const amount = page.getByLabel("Amount", { exact: true });
    await amount.fill("-");
    await fieldAction("Remove amount");
    // The menu hands focus back to its button once its closing animation ends.
    // Wait for that: a faster machine reached the help below first, and the
    // late focus move then dismissed it.
    await expect(
      page.getByRole("button", { name: "Actions for Amount", exact: true }),
    ).toBeFocused();
    expect(await stored()).toEqual({ amount: 4, note: "keep" });
    await expect(amount).toHaveValue("-");
    await expect(
      page.getByText(
        "Apply or discard pending field changes before removing or copying this value.",
      ),
    ).toBeVisible();
    await amount.fill("4");
    const help = page.getByRole("button", {
      name: "Help for Amount",
      exact: true,
    });
    await help.focus();
    const popup = page.getByRole("dialog", {
      name: "Help for Amount",
      exact: true,
    });
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Maximum events in a batch.");
    await expect(popup).toContainText("Vector default");
    await expect(popup).toContainText("Minimum");
    expect(
      await popup.evaluate(
        (el) => el.closest(".schema-field-control") === null,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(help).toBeFocused();
    await amount.focus();
    await help.focus();
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await fieldAction("Remove amount");
    expect(await stored()).toEqual({ note: "keep" });
    await expect(page.getByLabel("Note", { exact: true })).toBeFocused();
    const add = page.getByRole("button", { name: "Add field", exact: true });
    await add.click();
    const picker = page.getByRole("dialog", {
      name: "Add a field",
      exact: true,
    });
    await expect(picker).toBeVisible();
    expect(
      await picker.evaluate((el) => el.closest(".schema-fields") === null),
    ).toBe(true);
    await page
      .getByLabel("Find optional fields", { exact: true })
      .fill("amount");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Amount", { exact: true })).toBeFocused();
    expect(await stored()).toEqual({ note: "keep", amount: 10 });
  });
  await test("help pointer hover and clicks close on departure and reopen without losing focus behavior", async () => {
    await fixture({
      mode: "settings",
      kind: "transforms",
      value: { type: "sample", inputs: ["seed"], rate: 10 },
      config: {
        sources: { seed: { type: "demo_logs" } },
        transforms: {},
        sinks: {},
      },
    });
    const help = page.getByRole("button", {
        name: "Help for One in every",
        exact: true,
      }),
      popup = page.getByRole("dialog", {
        name: "Help for One in every",
        exact: true,
      });
    await help.hover();
    await expect(popup).toBeVisible();
    await help.click();
    await expect(help).toBeFocused();
    await page.mouse.move(950, 900);
    await expect(popup).toHaveCount(0);
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await expect(help).toBeFocused();
    await help.click();
    await expect(popup).toBeVisible();
    await popup.hover();
    await page.waitForTimeout(220);
    await expect(popup).toBeVisible();
    await page.mouse.move(950, 900);
    await expect(popup).toHaveCount(0);
    await help.click();
    await expect(popup).toBeVisible();
    await page
      .getByRole("button", { name: "Close help for One in every", exact: true })
      .click();
    await expect(popup).toHaveCount(0);
    await expect(help).toBeFocused();
    await page.getByLabel("One in every", { exact: true }).focus();
    await help.focus();
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(help).toBeFocused();
    expect((await stored()).rate).toBe(10);
  });
  const sampleRate = {
    mode: "settings",
    kind: "transforms",
    value: { type: "sample", inputs: ["seed"], rate: 10 },
    config: {
      sources: { seed: { type: "demo_logs" } },
      transforms: {},
      sinks: {},
    },
  };
  await test("keyboard focus reopens help after its Close button even when the click's timers run late", async () => {
    await fixture(sampleRate);
    const help = page.getByRole("button", {
        name: "Help for One in every",
        exact: true,
      }),
      popup = page.getByRole("dialog", {
        name: "Help for One in every",
        exact: true,
      });
    await help.hover();
    await help.click();
    await expect(popup).toBeVisible();
    await page.evaluate(() => window.holdZeroDelayTimers());
    try {
      await page
        .getByRole("button", {
          name: "Close help for One in every",
          exact: true,
        })
        .click();
      await expect(popup).toHaveCount(0);
      await expect(help).toBeFocused();
      await page.getByLabel("One in every", { exact: true }).focus();
      await help.focus();
      await expect(popup).toBeVisible();
    } finally {
      await page.evaluate(() => window.releaseZeroDelayTimers());
    }
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(help).toBeFocused();
  });
  await test("help opened by keyboard under a resting pointer stays open when the pointer moves away", async () => {
    await fixture(sampleRate);
    const help = page.getByRole("button", {
        name: "Help for One in every",
        exact: true,
      }),
      popup = page.getByRole("dialog", {
        name: "Help for One in every",
        exact: true,
      }),
      close = page.getByRole("button", {
        name: "Close help for One in every",
        exact: true,
      });
    await help.hover();
    await expect(popup).toBeVisible();
    const box = await close.boundingBox();
    await page.mouse.move(950, 900);
    await expect(popup).toHaveCount(0);
    // Rest the pointer where the help opens, then open it from the keyboard.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByLabel("One in every", { exact: true }).focus();
    await help.focus();
    await expect(popup).toBeVisible();
    // The browser reports the pointer over the help it opened under it.
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.querySelector(".schema-help-popover")?.matches(":hover"),
        ),
      )
      .toBe(true);
    await page.mouse.move(950, 900);
    await page.waitForTimeout(400);
    await expect(popup).toBeVisible();
    await expect(help).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(help).toBeFocused();
  });
  await test("general settings offer expire_metrics_secs, not the option Vector replaced, unless the draft still sets it", async () => {
    const dialog = page.getByRole("dialog", {
      name: "Pipeline settings",
      exact: true,
    });
    const offered = async (config) => {
      await fixture({ mode: "globals", value: config });
      await dialog
        .getByRole("button", { name: "Add field", exact: true })
        .last()
        .click();
      await page
        .getByLabel("Find optional fields", { exact: true })
        .fill("expire");
      const titles = await page
        .locator(".schema-field-picker-results button strong")
        .allInnerTexts();
      await page.keyboard.press("Escape");
      return titles;
    };
    const bare = { sources: {}, transforms: {}, sinks: {} };
    const titles = await offered(bare);
    expect(titles).toContain("Expire Metrics Secs");
    expect(titles).not.toContain("Expire Metrics");
    // A draft that still sets it keeps seeing it: its value is not dropped.
    await fixture({
      mode: "globals",
      value: { ...bare, expire_metrics: { secs: 60, nsecs: 0 } },
    });
    await expect(
      dialog.locator(".schema-record-label strong", {
        hasText: /^Expire Metrics$/,
      }),
    ).toHaveCount(1);
  });
  await test("global API and secret records keep attached actions and fit narrow settings", async () => {
    const config = {
      api: { enabled: true, address: "127.0.0.1:8686" },
      secret: { local: { type: "directory", path: "/etc/vector/secrets" } },
      sources: {},
      transforms: {},
      sinks: {},
    };
    await page.setViewportSize({ width: 1050, height: 850 });
    await fixture({ mode: "globals", value: config });
    const dialog = page.getByRole("dialog", {
      name: "Pipeline settings",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Actions for API", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Remove api", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Edit API as JSON", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    const apiHelp = dialog.getByRole("button", {
      name: "Help for API",
      exact: true,
    });
    await apiHelp.click();
    await expect(
      page.getByRole("dialog", { name: "Help for API", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(apiHelp).toBeFocused();
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "Add field", exact: true })
      .last()
      .click();
    await expect(
      page.getByRole("dialog", { name: "Add a field", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.screenshot({
      path: resolve(dashboard, "../.local/schema-globals-api.png"),
    });
    await dialog.screenshot({
      path: resolve(dashboard, "../docs/screenshots/shared-fields-api.png"),
    });
    await dialog.getByRole("button", { name: "Secrets", exact: true }).click();
    await expect(
      await reveal(dialog.getByLabel("Path", { exact: true })),
    ).toHaveValue("/etc/vector/secrets");
    await dialog.screenshot({
      path: resolve(dashboard, "../.local/schema-globals-secrets.png"),
    });
    await dialog.screenshot({
      path: resolve(dashboard, "../docs/screenshots/shared-fields-secrets.png"),
    });
    await page.setViewportSize({ width: 390, height: 850 });
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "dark"),
    );
    await dialog.screenshot({
      path: resolve(
        dashboard,
        "../.local/schema-globals-secrets-mobile-dark.png",
      ),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const analysis = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(analysis.violations).toEqual([]);
    expect(await stored()).toEqual(config);
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "light"),
    );
  });
  if (errors.length) throw Error(errors.join("\n"));
} finally {
  const evidence = {
    recorded_at: new Date().toISOString(),
    scope:
      "Isolated browser tests of actual React schema controls; no fleet or deployment writes.",
    schema_file: "dashboard/src/generated/vector-schema.json",
    schema_sha256: createHash("sha256").update(schemaText).digest("hex"),
    results,
    errors,
  };
  await writeFile(
    resolve(dashboard, "../.local/schema-control-browser-results.json"),
    JSON.stringify(evidence, null, 2),
  );
  await writeFile(
    resolve(
      dashboard,
      process.env.VECTORY_SCHEMA_TEST_FILTER
        ? "../docs/evidence/schema-controls-browser-focused.json"
        : "../docs/evidence/schema-controls-browser.json",
    ),
    JSON.stringify(evidence, null, 2),
  );
  await browser.close();
  await server.close();
}
