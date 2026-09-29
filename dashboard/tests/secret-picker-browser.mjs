// Device secrets in the real credential picker, device card and publish
// review. Synthetic pipelines and devices only; no server, fleet or deployment
// state. Screenshots land in .local/secret-picker (light, dark and 390 px).
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import AxeBuilder, { settleTransitions } from "./axe.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(
  dashboard,
  "..",
  process.env.VECTORY_SECRET_PICKER_OUTPUT || ".local/secret-picker",
);
await mkdir(output, { recursive: true });
// An OS-assigned port unless one is given: never claim a port another run may use.
const fixedPort = Number(process.env.VECTORY_SECRET_PICKER_PORT) || 0;
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  cacheDir: resolve(output, "vite-cache"),
  server: {
    host: "127.0.0.1",
    port: fixedPort,
    strictPort: !!fixedPort,
    hmr: false,
  },
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1000, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [],
  results = [],
  screenshots = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error")
    errors.push(`${message.text()} ${message.location()?.url ?? ""}`.trim());
});

const seed = {
  sources: { seed: { type: "demo_logs", format: "json" } },
  transforms: {},
  sinks: {},
};
const datadog = (key) => ({
  type: "datadog_logs",
  inputs: ["seed"],
  default_api_key: key,
});
const kafka = (password) => ({
  type: "kafka",
  inputs: ["seed"],
  bootstrap_servers: "kafka.example.internal:9092",
  topic: "logs",
  encoding: { codec: "json" },
  sasl: { enabled: true, mechanism: "PLAIN", username: "vector", password },
});
const pipeline = {
  ...seed,
  sinks: {
    dd: datadog("vectory-secret:DD_API_KEY"),
    kafka: kafka("vectory-secret:KAFKA_PASSWORD"),
  },
};

async function show(fixture, props) {
  await page.evaluate(
    ([fixture, props]) => window[fixture](props),
    [fixture, props],
  );
  await page.waitForFunction(
    () => window.currentRevision === window.expectedRevision,
  );
}
const stored = () =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.stored)));
async function reveal(field) {
  for (let i = 0; i < 12 && !(await field.isVisible()); i++) {
    let opened = false;
    for (const details of await field
      .locator("xpath=ancestor::details[not(@open)]")
      .all()) {
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
async function theme(name) {
  await page.evaluate((name) => {
    document.documentElement.dataset.theme = name;
  }, name);
}
async function snap(name) {
  const path = resolve(output, `${name}.png`);
  // A theme or state change fades colors; capture what people see after it.
  await settleTransitions(page);
  await page.screenshot({ path, fullPage: true });
  screenshots.push(path);
}
async function accessible() {
  const analysis = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    analysis.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
}
/** Light, dark and 390 px, each checked with Axe and without sideways scroll. */
async function everyLook(name) {
  await page.setViewportSize({ width: 1000, height: 1000 });
  await theme("light");
  await accessible();
  await snap(`${name}-light`);
  await theme("dark");
  await accessible();
  await snap(`${name}-dark`);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await accessible();
  await snap(`${name}-390-dark`);
  await theme("light");
  await snap(`${name}-390-light`);
  await page.setViewportSize({ width: 1000, height: 1000 });
}
async function test(name, run) {
  if (
    process.env.VECTORY_SECRET_PICKER_FILTER &&
    !name.includes(process.env.VECTORY_SECRET_PICKER_FILTER)
  )
    return;
  try {
    await theme("light");
    await page.setViewportSize({ width: 1000, height: 1000 });
    await run();
    results.push({ name, passed: true });
    console.log("PASS", name);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error("FAIL", name, error.message);
    await page.screenshot({
      path: resolve(output, "failure.png"),
      fullPage: true,
    });
    throw error;
  }
}

try {
  await page.goto(`${origin}/tests/secret-picker.html`, { timeout: 30000 });
  await page.waitForFunction(() => window.ready);

  await test("a credential field takes a device secret by name, checked as you type", async () => {
    await show("renderPicker", {
      id: "dd",
      kind: "sinks",
      component: datadog("vectory-secret:DD_API_KEY"),
      config: seed,
    });
    const key = page.getByLabel(/API key reference$/i);
    const picker = page.locator(".secret-picker").filter({ has: key });
    await expect(key).toHaveValue("DD_API_KEY");
    // A name field with suggestions from the pipeline, never a password box.
    await expect(key).toHaveAttribute("type", "text");
    await expect(
      page.getByRole("combobox", { name: /API key reference$/i }),
    ).toHaveCount(1);
    await expect(picker.locator(".secret-picker-prefix")).toHaveText(
      "vectory-secret:",
    );
    await expect(picker.getByRole("status")).toHaveText(
      "Each device fills this in from its own DD_API_KEY file.",
    );
    // The inspector explains device secrets once and names what this step reads.
    await expect(page.locator(".pipeline-secret-note")).toHaveCount(1);
    await expect(page.locator(".pipeline-secret-note")).toContainText(
      "DD_API_KEY",
    );
    await key.fill("dd key");
    await expect(key).toHaveAttribute("aria-invalid", "true");
    await expect(picker.getByRole("status")).toHaveText(
      "Use only letters, digits, dots, dashes and underscores.",
    );
    // A pasted key is the credential, not a name: it is never saved.
    await key.fill("3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c");
    await expect(picker.getByRole("status")).toContainText(
      "That looks like the credential itself.",
    );
    await snap("picker-pasted-credential-light");
    expect((await stored()).default_api_key).toBe("vectory-secret:DD_API_KEY");
    // A pasted reference keeps only its name.
    await key.fill("vectory-secret:DD_EU_API_KEY");
    await expect(key).toHaveValue("DD_EU_API_KEY");
    expect((await stored()).default_api_key).toBe(
      "vectory-secret:DD_EU_API_KEY",
    );
    await expect(picker.getByRole("status")).toHaveText(
      "Each device fills this in from its own DD_EU_API_KEY file.",
    );
    await picker
      .getByText("How to bind it on a device", { exact: true })
      .click();
    const [bindings, commands] = [
      picker.locator(".secret-binding-steps pre").nth(0),
      picker.locator(".secret-binding-steps pre").nth(1),
    ];
    await expect(bindings).toContainText(
      '"DD_EU_API_KEY": "/etc/vectory/secrets/DD_EU_API_KEY"',
    );
    await expect(commands).toHaveText(
      [
        "sudo vectory service-stop",
        "sudo vectory configure-secrets --secret-files /etc/vectory/secret-bindings.json",
        "sudo vectory service-start",
      ].join("\n"),
    );
    await everyLook("picker-device-secret");
    await picker.getByRole("radio", { name: "Windows", exact: true }).click();
    await expect(bindings).toContainText(
      '"DD_EU_API_KEY": "C:\\\\ProgramData\\\\Vectory\\\\secrets\\\\DD_EU_API_KEY"',
    );
    await expect(commands).toContainText(
      "vectory configure-secrets --secret-files C:\\ProgramData\\Vectory\\secret-bindings.json",
    );
    await expect(commands).not.toContainText("sudo");
    await snap("picker-binding-windows-light");
  });

  await test("a plain-text credential is never shown, and one click replaces it", async () => {
    const plain = "plain-credential-9f8e7d6c";
    await show("renderPicker", {
      id: "dd",
      kind: "sinks",
      component: datadog(plain),
      config: seed,
    });
    const key = page.getByLabel(/API key reference$/i);
    const picker = page.locator(".secret-picker").filter({ has: key });
    await expect(key).toHaveValue("");
    expect(await page.locator(".secret-harness").innerHTML()).not.toContain(
      plain,
    );
    await expect(picker.getByRole("status")).toHaveText(
      "This field holds a plain-text credential, which can't be saved or published. Replace it with a device secret.",
    );
    // The step's own issue names the field and the fix, formatted as code.
    const issue = page.locator(".pipeline-field-errors li");
    await expect(issue).toHaveText(
      "Plaintext credentials cannot be stored in default_api_key. Use a device secret: vectory-secret:NAME, then bind it on each device with vectory configure-secrets.",
    );
    await expect(issue.locator("code")).toHaveText([
      "default_api_key",
      "vectory configure-secrets",
    ]);
    await snap("picker-plain-text-light");
    await picker
      .getByRole("button", { name: "Use DD_DEFAULT_API_KEY", exact: true })
      .click();
    expect((await stored()).default_api_key).toBe(
      "vectory-secret:DD_DEFAULT_API_KEY",
    );
    await expect(key).toHaveValue("DD_DEFAULT_API_KEY");
    await expect(issue).toHaveCount(0);
  });

  await test("Vector references and device secrets switch in place on a nested credential", async () => {
    await show("renderPicker", {
      id: "kafka",
      kind: "sinks",
      component: kafka("${KAFKA_PASSWORD}"),
      config: seed,
    });
    const password = await reveal(
      page.getByLabel("Password reference", { exact: true }),
    );
    const picker = page.locator(".secret-picker").filter({ has: password });
    await expect(password).toHaveValue("${KAFKA_PASSWORD}");
    await expect(picker).toHaveAttribute("data-mode", "native");
    await expect(picker.getByRole("status")).toHaveText(
      "Vector resolves this on each device. It needs full mode.",
    );
    await picker
      .getByRole("button", { name: "Use a device secret", exact: true })
      .click();
    await expect(picker).toHaveAttribute("data-mode", "device");
    await expect(password).toHaveValue("");
    await expect(password).toBeFocused();
    await password.fill("KAFKA_PASSWORD");
    expect((await stored()).sasl.password).toBe(
      "vectory-secret:KAFKA_PASSWORD",
    );
    // The SASL user name is not a credential field and stays as typed.
    expect((await stored()).sasl.username).toBe("vector");
    await password.fill("SECRET[vault.kafka_password]");
    await expect(picker).toHaveAttribute("data-mode", "native");
    expect((await stored()).sasl.password).toBe("SECRET[vault.kafka_password]");
    await password.fill("hunter2");
    expect((await stored()).sasl.password).toBe("SECRET[vault.kafka_password]");
    await expect(picker.getByRole("status")).toContainText(
      "Plain-text credentials are never saved.",
    );
    await password.fill("vectory-secret:KAFKA_PASSWORD");
    await expect(picker).toHaveAttribute("data-mode", "device");
    expect((await stored()).sasl.password).toBe(
      "vectory-secret:KAFKA_PASSWORD",
    );
    await everyLook("picker-nested-kafka");
  });

  await test("the device page lists the names a version reads and which are bound", async () => {
    await show("renderDevice", {
      device: {
        id: "device-1",
        name: "edge-01",
        status: "failed",
        desired_version_id: "version-4",
        uses_local_secrets: true,
        secret_names: ["DD_API_KEY", "OLD_TOKEN"],
      },
      version: { id: "version-4", number: 4, config: pipeline },
    });
    await expect(
      page.getByRole("heading", { name: "Device secrets", exact: true }),
    ).toBeVisible();
    const list = page.getByRole("list", { name: "Secrets v4 reads" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(
      list.getByRole("listitem").filter({ hasText: "DD_API_KEY" }),
    ).toContainText("Bound");
    await expect(
      list.getByRole("listitem").filter({ hasText: "KAFKA_PASSWORD" }),
    ).toContainText("Not bound");
    await expect(page.getByText("1 not bound", { exact: true })).toBeVisible();
    await expect(page.getByText("Also bound here:")).toContainText("OLD_TOKEN");
    // A missing binding opens the steps, listing every name the version reads.
    const bindings = page.locator(".device-secret-binding pre").first();
    await expect(bindings).toBeVisible();
    await expect(bindings).toContainText('"KAFKA_PASSWORD"');
    await expect(bindings).toContainText('"DD_API_KEY"');
    await everyLook("device-secrets");
    await show("renderDevice", {
      device: {
        id: "device-2",
        name: "edge-02",
        status: "verified",
        desired_version_id: "version-4",
        uses_local_secrets: true,
      },
      version: { id: "version-4", number: 4, config: pipeline },
    });
    await expect(page.getByText("Not reported").first()).toBeVisible();
    await expect(
      page.getByText(/hasn't reported which secrets it has bound/),
    ).toBeVisible();
    await snap("device-secrets-not-reported-light");
  });

  await test("the publish review lists the names a version reads and marks new ones", async () => {
    await show("renderReview", {
      config: pipeline,
      published: {
        id: "version-3",
        number: 3,
        config: { ...seed, sinks: { dd: pipeline.sinks.dd } },
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
      },
    });
    const section = page.getByRole("region", { name: "Device secrets" });
    await expect(section.getByRole("listitem")).toHaveCount(2);
    await expect(
      section.getByRole("listitem").filter({ hasText: "KAFKA_PASSWORD" }),
    ).toContainText("New");
    await expect(
      section.getByRole("listitem").filter({ hasText: "DD_API_KEY" }),
    ).not.toContainText("New");
    await expect(section).toContainText("One is new since v3.");
    await expect(section).toContainText("in kafka.sasl.password");
    await section
      .getByText("How to bind them on a device", { exact: true })
      .click();
    await expect(
      section.locator(".secret-binding-steps pre").first(),
    ).toContainText('"KAFKA_PASSWORD"');
    await everyLook("publish-review-secrets");
  });

  if (errors.length) throw Error(errors.join("\n"));
} finally {
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        scope:
          "Isolated browser tests of the real device-secret picker, device card and publish review with synthetic data; no server or fleet state.",
        results,
        errors,
        screenshots,
      },
      null,
      2,
    ) + "\n",
  );
  await browser.close();
  await server.close();
}
