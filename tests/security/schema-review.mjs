// Isolated real React controls and pinned schema. No server/fleet is modified.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(root, "dashboard/package.json"));
const { build } = require("esbuild");
const { chromium } = require("@playwright/test");
const bundle = await build({
  stdin: {
    contents: `
  import React,{useState,useCallback} from 'react';import {createRoot} from 'react-dom/client';
  import {PipelineSchemaControl} from './src/PipelineSchemaFields';
  import schema from './src/generated/vector-schema.json';
  function App(){const [spec,setSpec]=useState(null),[value,setValue]=useState(undefined);const [pending,setPending]=useState({});
    const report=useCallback((id,dirty)=>setPending(old=>({...old,[id]:dirty})),[]);
    window.fixture={load(next){setValue(next.value);setPending({});setSpec(next)},value,pending:Object.values(pending).some(Boolean)};
    if(!spec)return <p>Ready</p>;
    const field=spec.schema||spec.path.slice(2).split('/').map(p=>p.replaceAll('~1','/').replaceAll('~0','~')).reduce((at,p)=>at[p],schema);
    return <main data-sequence={spec.sequence}><PipelineSchemaControl key={spec.sequence} name={spec.name} schema={field} root={schema} value={value} onChange={setValue} editable={spec.editable!==false} required={spec.required||false} onPendingChange={report}/></main>;
  }createRoot(document.getElementById('app')).render(<App/>);
`,
    resolveDir: path.join(root, "dashboard"),
    sourcefile: "isolated-schema-review.tsx",
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "empty" },
});
const server = http.createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/test.js" ? "application/javascript" : "text/html",
  );
  response.end(
    request.url === "/test.js"
      ? bundle.outputFiles[0].contents
      : '<!doctype html><title>Independent synthetic schema control review</title><div id="app"></div><script src="/test.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ref = (name, suffix = "") =>
  `#/definitions/${name.replaceAll("~", "~0").replaceAll("/", "~1")}${suffix}`;
let browser,
  sequence = 0;
const results = [],
  errors = [];
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(4500);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText("Ready", { exact: true }).waitFor();
  async function load(spec) {
    const input = { ...spec, sequence: ++sequence };
    await page.evaluate((next) => window.fixture.load(next), input);
    await page.locator(`main[data-sequence="${sequence}"]`).waitFor();
  }
  async function value() {
    return page.evaluate(() => window.fixture.value);
  }
  // A control commits its change after the click returns, and a slow runner
  // can read the value before that: compare until the value settles.
  async function settled(expected) {
    const deadline = Date.now() + 3000;
    let actual = await value();
    while (Date.now() < deadline) {
      try {
        assert.deepEqual(actual, expected);
        return;
      } catch {
        await page.waitForTimeout(50);
        actual = await value();
      }
    }
    assert.deepEqual(actual, expected);
  }
  // Rename, duplicate, move, remove and the null/value switch live in each
  // field's "Actions for ..." menu. Open the menus in turn until one offers it.
  async function fieldAction(label) {
    const triggers = page.getByRole("button", { name: /^Actions for / });
    for (let index = 0; index < (await triggers.count()); index++) {
      const trigger = triggers.nth(index);
      if (!(await trigger.isVisible())) continue;
      await trigger.click();
      const action = page.getByRole("menuitem", { name: label, exact: true });
      if (await action.count()) {
        await action.click();
        return;
      }
      await page.keyboard.press("Escape");
    }
    throw new Error(`Missing field action: ${label}`);
  }
  async function probe(name, run) {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({
        name,
        passed: false,
        error: String(error.message).slice(0, 1500),
      });
    }
  }

  await probe(
    "typed credential arrays retain references and reject plaintext drafts",
    async () => {
      const before = ["${TOKEN_A}", "SECRET[local.second]"];
      await load({
        name: "valid_tokens",
        path: ref(
          "vector::sources::splunk_hec::SplunkConfig",
          "/properties/valid_tokens",
        ),
        value: before,
      });
      const fields = page.getByRole("textbox");
      const first = fields.filter({ visible: true }).first();
      await first.fill("synthetic-plaintext-not-committed");
      await settled(before);
      assert.equal(await page.evaluate(() => window.fixture.pending), true);
      await first.fill("${TOKEN_REPLACED}");
      await settled([
        "${TOKEN_REPLACED}",
        "SECRET[local.second]",
      ]);
    },
  );
  await probe(
    "duration display conversion keeps fractional seconds numeric",
    async () => {
      await load({
        name: "duration",
        path: ref("serde_with::DurationFractionalSeconds"),
        value: 1.5,
      });
      await page
        .getByRole("combobox", { name: /display unit/ })
        .selectOption({ label: "milliseconds" });
      assert.equal(await value(), 1.5);
      await page.getByRole("textbox").fill("250");
      assert.equal(await value(), 0.25);
      await page.getByRole("textbox").fill("1e");
      assert.equal(await value(), 0.25);
      assert.equal(await page.evaluate(() => window.fixture.pending), true);
    },
  );
  await probe(
    "numeric-string enum remains distinct from numeric enum",
    async () => {
      await load({
        name: "level",
        path: ref("vector::sinks::util::buffer::compression::CompressionLevel"),
        value: "best",
      });
      await page
        .getByRole("combobox", { name: "Level", exact: true })
        .selectOption("3");
      assert.equal(await value(), 3);
      await page
        .getByRole("combobox", { name: "Level", exact: true })
        .selectOption('"best"');
      assert.equal(await value(), "best");
    },
  );
  await probe("template URL remains a literal event template", async () => {
    await load({
      name: "uri",
      path: ref(
        "vector::sinks::http::config::HttpSinkConfig",
        "/allOf/0/properties/uri",
      ),
      value: "https://example.test/{{ tenant }}",
    });
    await page.getByRole("textbox").fill("${ENDPOINT}/{{ tenant }}/%Y/%m/%d");
    assert.equal(await value(), "${ENDPOINT}/{{ tenant }}/%Y/%m/%d");
    assert.equal(await page.getByRole("textbox").getAttribute("type"), "text");
  });
  await probe(
    "typed maps rename and duplicate without value loss",
    async () => {
      await load({
        name: "headers",
        path: ref(
          "vector::sinks::util::http::RequestConfig",
          "/allOf/0/properties/headers",
        ),
        value: { "X-{{ tenant }}": "{{ timestamp }}" },
      });
      await fieldAction("Rename X-{{ tenant }}");
      await page
        .getByRole("textbox", { name: "Rename X-{{ tenant }}", exact: true })
        .fill("X-Event");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await settled({ "X-Event": "{{ timestamp }}" });
      await fieldAction("Duplicate X-Event");
      await settled({
        "X-Event": "{{ timestamp }}",
        "X-Event_copy": "{{ timestamp }}",
      });
    },
  );
  await probe("array reordering preserves element values", async () => {
    await load({
      name: "headers",
      schema: { type: "array", items: { type: "string" } },
      value: ["first", "second"],
    });
    await fieldAction("Move item 2 up");
    await settled(["second", "first"]);
    await fieldAction("Duplicate item 1");
    await settled(["second", "first", "second"]);
  });
  await probe(
    "invalid scalar draft follows its array element during reorder",
    async () => {
      await load({
        name: "amounts",
        schema: { type: "array", items: { type: "integer", minimum: 1 } },
        value: [20, 30],
      });
      await page
        .getByRole("textbox", { name: "Item 1", exact: true })
        .fill("-");
      await fieldAction("Move item 1 down");
      await settled([30, 20]);
      assert.equal(
        await page
          .getByRole("textbox", { name: "Item 2", exact: true })
          .inputValue(),
        "-",
      );
      assert.equal(await page.evaluate(() => window.fixture.pending), true);
      await page
        .getByRole("textbox", { name: "Item 2", exact: true })
        .fill("40");
      await settled([30, 40]);
    },
  );
  await probe(
    "map rename cannot silently discard a pending scalar draft",
    async () => {
      await load({
        name: "amounts",
        schema: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 1 },
        },
        value: { alpha: 20 },
      });
      await page.getByRole("textbox", { name: "Alpha", exact: true }).fill("-");
      await fieldAction("Rename alpha");
      await page
        .getByRole("textbox", { name: "Rename alpha", exact: true })
        .fill("beta");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await settled({ alpha: 20 });
      assert.equal(
        await page
          .getByRole("textbox", { name: "Alpha", exact: true })
          .inputValue(),
        "-",
      );
      await page
        .getByRole("textbox", { name: "Alpha", exact: true })
        .fill("21");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await settled({ beta: 21 });
    },
  );
  await probe(
    "actual nullable integer restores value across explicit null",
    async () => {
      await load({
        name: "max_length",
        path: ref(
          "codecs::decoding::framing::character_delimited::CharacterDelimitedDecoderOptions",
          "/properties/max_length",
        ),
        value: null,
      });
      await fieldAction("Enter Max Length value");
      await page.waitForFunction(() => window.fixture.pending, null, {
        timeout: 2000,
      });
      assert.equal(await value(), null);
      assert.equal(await page.evaluate(() => window.fixture.pending), true);
      await page.getByRole("textbox").fill("64");
      assert.equal(await value(), 64);
      await fieldAction("Set Max Length to null");
      assert.equal(await value(), null);
      await fieldAction("Enter Max Length value");
      assert.equal(await value(), 64);
    },
  );
  await probe(
    "HTTP auth branch changes preserve cached credentials and block pending plaintext",
    async () => {
      await load({
        name: "auth",
        path: ref("core::option::Option<vector::http::Auth>"),
        value: {
          strategy: "basic",
          user: "${USER}",
          password: "SECRET[local.password]",
        },
      });
      const strategy = page.getByRole("combobox", {
        name: "Strategy",
        exact: true,
      });
      await strategy.selectOption({ label: "Bearer" });
      await page
        .getByRole("textbox", { name: "Token reference", exact: true })
        .fill("not-a-reference");
      await strategy.selectOption({ label: "Basic" });
      assert.equal((await value()).strategy, "bearer");
      assert.equal(
        await page
          .getByRole("textbox", { name: "Token reference", exact: true })
          .inputValue(),
        "not-a-reference",
      );
      await page
        .getByRole("textbox", { name: "Token reference", exact: true })
        .fill("${TOKEN}");
      await strategy.selectOption({ label: "Basic" });
      await settled({
        strategy: "basic",
        user: "${USER}",
        password: "SECRET[local.password]",
      });
      await strategy.selectOption({ label: "Bearer" });
      await settled({
        strategy: "bearer",
        token: "${TOKEN}",
      });
    },
  );
  await probe(
    "arbitrary map keys remain own properties without prototype mutation",
    async () => {
      await load({
        name: "fields",
        schema: { type: "object", additionalProperties: { type: "string" } },
        value: { ordinary: "retained" },
      });
      await page
        .getByRole("textbox", { name: "New entry name", exact: true })
        .fill("__proto__");
      await page
        .getByRole("button", { name: "Add entry", exact: true })
        .click();
      // Serialize explicitly: the browser transport's object decoder may itself
      // discard the __proto__ property, outside the control under review.
      const after = JSON.parse(
        await page.evaluate(() => JSON.stringify(window.fixture.value)),
      );
      assert.equal(Object.hasOwn(after, "__proto__"), true);
      assert.equal(after.ordinary, "retained");
      assert.equal(
        await page.evaluate(
          () =>
            Object.getPrototypeOf({}) === Object.prototype &&
            !Object.hasOwn(Object.prototype, "ordinary"),
        ),
        true,
      );
    },
  );
  await probe(
    "key restrictions reject invalid or duplicate map names",
    async () => {
      await load({
        name: "mapping",
        schema: {
          type: "object",
          propertyNames: { pattern: "^[a-z]+$" },
          additionalProperties: { type: "string" },
        },
        value: { alpha: "one" },
      });
      await page
        .getByRole("textbox", { name: "New entry name", exact: true })
        .fill("Bad Key");
      await page
        .getByRole("button", { name: "Add entry", exact: true })
        .click();
      await settled({ alpha: "one" });
      await page
        .getByRole("textbox", { name: "New entry name", exact: true })
        .fill("alpha");
      await page
        .getByRole("button", { name: "Add entry", exact: true })
        .click();
      await settled({ alpha: "one" });
    },
  );
  await probe(
    "read-only controls do not expose mutating list operations",
    async () => {
      // Open every actions menu and list what it offers. Closed menus render
      // no items, so counting buttons alone could not fail.
      async function offered() {
        const names = [];
        const triggers = page.getByRole("button", { name: /^Actions for / });
        for (let index = 0; index < (await triggers.count()); index++) {
          await triggers.nth(index).click();
          for (const item of await page.getByRole("menuitem").all())
            names.push((await item.innerText()).trim());
          await page.keyboard.press("Escape");
        }
        return names;
      }
      const list = {
        name: "values",
        schema: { type: "array", items: { type: "string" } },
        value: ["first"],
      };
      await load(list);
      const editable = await offered();
      for (const action of [
        "Move item 1 up",
        "Move item 1 down",
        "Duplicate item 1",
        "Remove item 1",
      ])
        assert(editable.includes(action), `${action} in ${editable}`);
      await load({ ...list, editable: false });
      const readOnly = await offered();
      assert.deepEqual(
        readOnly.filter((name) => !/^View /.test(name)),
        [],
      );
      assert.equal(
        await page
          .getByRole("button", {
            name: /Add item|Remove item|Duplicate item|Move item/,
          })
          .count(),
        0,
      );
      assert.equal(
        await page.getByRole("textbox").first().getAttribute("readonly"),
        "",
      );
      await settled(["first"]);
    },
  );
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
const schemaBytes = await fs.readFile(
  path.join(root, "dashboard/src/generated/vector-schema.json"),
);
const report = {
  recorded_at: new Date().toISOString(),
  scope:
    "Real React controls, isolated synthetic state, pinned schema; no API, fleet or native activation simulated as production evidence.",
  schema_sha256: crypto.createHash("sha256").update(schemaBytes).digest("hex"),
  checks: results,
  page_errors: errors,
  limitations: [
    "Representative interaction probes, not every possible component, branch or field.",
    "Synthetic property-name and array tests complement real pinned field probes; the pinned schema currently has no propertyNames constraints.",
  ],
};
const output = path.resolve(
  process.env.VECTORY_SCHEMA_REVIEW_EVIDENCE ||
    path.join(root, "docs/evidence/schema-review.json"),
);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (results.some((result) => !result.passed) || errors.length)
  process.exitCode = 1;
