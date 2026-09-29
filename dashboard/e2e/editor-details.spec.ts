import { test, expect } from "@playwright/test";
import { readConfigurationCode } from "./code-editor";

async function create(page: any, config: any, name: string) {
  const session = await page.request
    .get("/api/v1/session")
    .then((response: any) => response.json());
  const response = await page.request.post("/api/v1/configurations", {
    headers: { "X-CSRF-Token": session.csrf_token },
    data: {
      name: `${name} ${Date.now()}`,
      description: "Synthetic editor verification. Never deployed.",
      config,
      graph: { nodes: [], edges: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
  const doc = await response.json();
  await page.goto(`/#/configurations/${doc.id}`);
  await expect(page.getByRole("heading", { name: doc.name })).toBeVisible();
  return doc;
}

test("component and pipeline renames preserve graph, tests, revisions and undo", async ({
  page,
}) => {
  const config = {
    sources: { sample: { type: "demo_logs", format: "json" } },
    transforms: {
      branch: { type: "route", inputs: ["sample"], route: { accept: "true" } },
    },
    sinks: { out: { type: "blackhole", inputs: ["branch.accept"] } },
    tests: [
      {
        name: "Accepted events",
        inputs: [
          { insert_at: "branch", type: "raw", value: "Synthetic event" },
        ],
        outputs: [{ extract_from: "branch.accept" }],
      },
    ],
  };
  const doc = await create(page, config, "Synthetic naming check");
  const panel = page.locator(".editor-inspector");
  await page.locator('.react-flow__node[data-id="branch"]').click();
  await panel
    .getByRole("button", { name: "Rename component", exact: true })
    .click();
  await panel
    .getByLabel("Component name", { exact: true })
    .fill("request_routes");
  await panel.getByLabel("Component name", { exact: true }).press("Enter");
  await expect(
    page.locator('.react-flow__node[data-id="request_routes"]'),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Close component settings", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
  let saved = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((response) => response.json());
  expect(saved.config.sinks.out.inputs).toEqual(["request_routes.accept"]);
  expect(saved.config.tests[0].inputs[0].insert_at).toBe("request_routes");
  expect(saved.config.tests[0].outputs[0].extract_from).toBe(
    "request_routes.accept",
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.locator('.react-flow__node[data-id="branch"]'),
  ).toBeVisible();
  await page.locator(".editor-tools-menu > summary").click();
  await page
    .getByRole("button", { name: "Pipeline details", exact: true })
    .click();
  const name = `Synthetic renamed pipeline ${Date.now()}`;
  await page
    .getByRole("dialog")
    .getByLabel("Pipeline name", { exact: true })
    .fill(name);
  await page
    .getByRole("dialog")
    .getByLabel("Description", { exact: true })
    .fill("A renamed pipeline with preserved component tests.");
  await page.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  saved = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((response) => response.json());
  expect(saved.config).toEqual(config);
  expect(saved.description).toBe(
    "A renamed pipeline with preserved component tests.",
  );
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
});

test("memory enrichment exports are visible, editable and connected on the graph", async ({
  page,
}) => {
  const doc = await create(
    page,
    {
      sources: { seed: { type: "demo_logs", format: "json" } },
      enrichment_tables: {
        lookup: {
          type: "memory",
          inputs: ["seed"],
          source_config: { source_key: "cache_events", export_interval: 1 },
        },
      },
      sinks: { out: { type: "blackhole", inputs: ["cache_events"] } },
    },
    "Synthetic memory table graph",
  );
  await expect(page.locator(".pipeline-node")).toHaveCount(4);
  await page.locator('.react-flow__node[data-id="cache_events"]').click();
  await expect(page.locator(".editor-inspector")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Memory enrichment table", exact: true }),
  ).toBeVisible();
  const sourceKey = page
    .locator(".editor-inspector")
    .getByLabel("Source Key", { exact: true });
  await expect(sourceKey).toHaveValue("cache_events");
  await sourceKey.fill("seed");
  await expect(
    page.locator(".editor-inspector").getByRole("alert"),
  ).toContainText("already exists");
  await expect(
    page.locator('.react-flow__node[data-id="cache_events"]'),
  ).toBeVisible();
  await sourceKey.fill("lookup_events");
  await expect(
    page.locator('.react-flow__node[data-id="lookup_events"]'),
  ).toBeVisible();
  await page
    .locator(".editor-inspector")
    .getByRole("button", { name: "Close component settings", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
  const saved = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((response) => response.json());
  expect(saved.config.sinks.out.inputs).toEqual(["lookup_events"]);
  expect(saved.config.enrichment_tables.lookup.source_config.source_key).toBe(
    "lookup_events",
  );
  expect(saved.config.enrichment_tables.lookup.inputs).toEqual(["seed"]);
  expect(saved.config.sources).toEqual({
    seed: { type: "demo_logs", format: "json" },
  });
});

test("unfinished field input stays visible and unsafe integers never replace the saved draft", async ({
  page,
}) => {
  const doc = await create(
    page,
    {
      sources: { seed: { type: "demo_logs", format: "json" } },
      transforms: { sample: { type: "sample", inputs: ["seed"], rate: 10 } },
      sinks: { out: { type: "blackhole", inputs: ["sample"] } },
    },
    "Synthetic pending field check",
  );
  await page.locator('.react-flow__node[data-id="sample"]').click();
  const inspector = page.locator(".editor-inspector");
  const rate = inspector.getByLabel("One in every", { exact: true });
  await rate.fill("-");
  await expect(
    page.locator(".pipeline-save-status[data-save-state='unapplied']:visible"),
  ).toContainText("Unapplied field changes");
  const validations: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`/configurations/${doc.id}/validate`))
      validations.push(request.url());
  });
  await page
    .getByRole("button", { name: /^Check pipeline/ })
    .click();
  await expect(inspector.getByRole("alert")).toContainText(
    "Resolve or apply pending field changes",
  );
  expect(validations).toEqual([]);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Discard unapplied field changes?");
    await dialog.dismiss();
  });
  await inspector
    .getByRole("button", { name: "Close component settings", exact: true })
    .click();
  await expect(rate).toHaveValue("-");
  await rate.fill("20");
  await inspector
    .getByRole("button", { name: "Close component settings", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
  const stored = async () =>
    page.request
      .get(`/api/v1/configurations/${doc.id}`)
      .then((response) => response.json());
  const before = await stored();
  expect(before.config.transforms.sample.rate).toBe(20);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("Format", { exact: true }).selectOption("json");
  const code = page.getByLabel("Vector configuration code", { exact: true });
  const validCode = await readConfigurationCode(page);
  await code.fill(
    validCode.replace('"rate": 20', '"rate": 9223372036854775807'),
  );
  await page
    .getByRole("button", { name: "Apply code changes", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "cannot be represented exactly by the editor",
  );
  const after = await stored();
  expect(after.revision).toBe(before.revision);
  expect(after.config).toEqual(before.config);
  await code.fill(validCode);
  await page
    .getByRole("button", { name: "Apply code changes", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("curated forms expose source authentication and accept file-based remap programs", async ({
  page,
}) => {
  const doc = await create(
    page,
    {
      sources: {
        receiver: {
          type: "http_server",
          address: "127.0.0.1:8088",
          encoding: "json",
          auth: {
            strategy: "basic",
            username: "${HTTP_USER}",
            password: "${HTTP_PASSWORD}",
          },
        },
      },
      transforms: {
        normalize: {
          type: "remap",
          inputs: ["receiver"],
          file: "relative.vrl",
        },
      },
      sinks: { out: { type: "blackhole", inputs: ["normalize"] } },
    },
    "Synthetic native alternatives",
  );
  await page.locator('.react-flow__node[data-id="receiver"]').click();
  const panel = page.locator(".editor-inspector");
  const username = panel.getByLabel(/^Username(?: reference)?$/);
  const password = panel.getByLabel(/^Password(?: reference)?$/);
  await expect(username).toHaveValue("${HTTP_USER}");
  await username.fill("${INGEST_USER}");
  await password.fill("${INGEST_PASSWORD}");
  await panel
    .getByRole("button", { name: "Close component settings", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="normalize"]').click();
  await expect(panel.locator(".pipeline-field-errors")).toHaveCount(0);
  const file = panel.getByLabel("File", { exact: true });
  await expect(file).toHaveValue("relative.vrl");
  await file.fill("transforms/normalize.vrl");
  await panel
    .getByRole("button", { name: "Close component settings", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
  const saved = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((response) => response.json());
  expect(saved.config.sources.receiver.auth).toEqual({
    strategy: "basic",
    username: "${INGEST_USER}",
    password: "${INGEST_PASSWORD}",
  });
  expect(saved.config.transforms.normalize.file).toBe(
    "transforms/normalize.vrl",
  );
  expect(saved.config.transforms.normalize).not.toHaveProperty("source");
});

test("root transport choices show their own fields and preserve connections and cached values", async ({
  page,
}) => {
  const doc = await create(
    page,
    {
      sources: {
        receiver: {
          type: "syslog",
          mode: "tcp",
          address: "127.0.0.1:15140",
          max_length: 1024,
        },
      },
      sinks: { out: { type: "blackhole", inputs: ["receiver"] } },
    },
    "Synthetic transport choices",
  );
  await page.locator('.react-flow__node[data-id="receiver"]').click();
  const panel = page.locator(".editor-inspector");
  const mode = panel.getByLabel("Mode", { exact: true });
  const address = panel.getByLabel("Address", { exact: true });
  await expect(address).toHaveValue("127.0.0.1:15140");
  await mode.selectOption({ label: "UDP" });
  await expect(address).toHaveValue("127.0.0.1:15140");
  await panel.getByLabel("Max Length", { exact: true }).fill("2048");
  await mode.selectOption({ label: "Unix socket" });
  await expect(address).toHaveCount(0);
  const pathInput = panel.getByLabel("Path", { exact: true });
  await pathInput.fill("/run/vector/syslog.sock");
  await mode.selectOption({ label: "TCP" });
  await expect(address).toHaveValue("127.0.0.1:15140");
  await expect(panel.getByLabel("Max Length", { exact: true })).toHaveValue(
    "2048",
  );
  await mode.selectOption({ label: "Unix socket" });
  await expect(pathInput).toHaveValue("/run/vector/syslog.sock");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await panel
    .getByRole("button", { name: "Close component settings", exact: true })
    .click();
  await expect(
    page.locator(".pipeline-save-status[data-save-state='saved']:visible"),
  ).toBeVisible({
    timeout: 15000,
  });
  const saved = await page.request
    .get(`/api/v1/configurations/${doc.id}`)
    .then((response) => response.json());
  expect(saved.config.sources.receiver).toMatchObject({
    type: "syslog",
    mode: "unix",
    path: "/run/vector/syslog.sock",
    max_length: 2048,
  });
  expect(saved.config.sources.receiver).not.toHaveProperty("address");
  expect(saved.config.sinks.out.inputs).toEqual(["receiver"]);
  await page.reload();
  await page.locator('.react-flow__node[data-id="receiver"]').click();
  await expect(pathInput).toHaveValue("/run/vector/syslog.sock");
  await expect(panel.locator(".pipeline-field-errors")).toHaveCount(0);
});
