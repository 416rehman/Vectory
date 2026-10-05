import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

const base = () => ({
  sources: { input: { type: "demo_logs", format: "json", interval: 1 } },
  transforms: {
    process: { type: "remap", inputs: ["input"], source: '.marker = "base"' },
  },
  sinks: { output: { type: "blackhole", inputs: ["process"] } },
});

async function create(page: Page) {
  const session = await page.request.get("/api/v1/session");
  expect(session.ok()).toBeTruthy();
  const headers = { "X-CSRF-Token": (await session.json()).csrf_token };
  const response = await page.request.post("/api/v1/configurations", {
    headers,
    data: {
      name: `Synthetic stale draft ${Date.now()}`,
      description: "Browser recovery regression; never deployed.",
      config: base(),
      graph: { nodes: [], edges: [] },
    },
  });
  expect(response.ok()).toBeTruthy();
  return { doc: await response.json(), headers };
}

async function archive(
  page: Page,
  id: string,
  headers: Record<string, string>,
) {
  const result = await page.request.get(`/api/v1/configurations/${id}`);
  if (!result.ok()) return;
  const doc = await result.json();
  if (!doc.archived)
    expect(
      (
        await page.request.post(`/api/v1/configurations/${id}/archive`, {
          headers,
          data: { revision: doc.revision },
        })
      ).ok(),
    ).toBeTruthy();
}

test("a stale save keeps my edits, compares copies and requires explicit discard", async ({
  page,
}) => {
  const { doc, headers } = await create(page);
  try {
    await page.goto(`/#/configurations/${doc.id}`);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const code = page.getByLabel("Vector configuration code");
    const local = base();
    local.transforms.process.source = '.marker = "local"';
    await code.fill(JSON.stringify(local));
    await page.getByRole("button", { name: "Apply code changes" }).click();

    const server = base();
    server.transforms.process.source = '.marker = "server"';
    const advanced = await page.request.put(
      `/api/v1/configurations/${doc.id}/draft`,
      {
        headers,
        data: {
          revision: doc.revision,
          config: server,
          graph: doc.graph,
          variables: doc.variables || [],
          message: "A second editor changed this draft",
        },
      },
    );
    expect(advanced.ok()).toBeTruthy();

    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Compare drafts" }),
    ).toBeVisible();
    await expect(code).toContainText("local");
    await page.getByRole("button", { name: "Compare drafts" }).click();
    const comparison = page.getByRole("dialog", {
      name: "Compare draft copies",
    });
    await expect(comparison).toContainText("transforms.process.source");
    await expect(comparison).toContainText("server");
    await expect(comparison).toContainText("local");
    await comparison
      .getByRole("button", { name: "Keep editing my copy" })
      .click();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download my draft" }).click();
    const downloaded = await downloadPromise;
    const backup = JSON.parse(fs.readFileSync(await downloaded.path(), "utf8"));
    expect(backup.base_revision).toBe(doc.revision);
    expect(backup.config.transforms.process.source).toBe('.marker = "local"');

    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Restore changes" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Restore changes" }).click();
    await expect(
      page.getByRole("button", { name: "Compare drafts" }),
    ).toBeVisible();
    let stalePut = false;
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        request.url().endsWith(`/configurations/${doc.id}/draft`)
      )
        stalePut = true;
    });
    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    expect(stalePut).toBe(false);

    await page.locator(".editor-tools-menu > summary").click();
    await page
      .getByRole("button", { name: "Pipeline details", exact: true })
      .click();
    const details = page.getByRole("dialog", { name: "Pipeline details" });
    await details
      .getByLabel("Pipeline name", { exact: true })
      .fill(`${doc.name} local rename`);
    await details.getByRole("button", { name: "Save details" }).click();
    await expect(details).toContainText(
      "Details could not be saved. Your changes are still here.",
    );
    expect(stalePut).toBe(false);
    const stillServer = await page.request
      .get(`/api/v1/configurations/${doc.id}`)
      .then((response) => response.json());
    expect(stillServer.name).toBe(doc.name);
    expect(stillServer.config.transforms.process.source).toBe(
      '.marker = "server"',
    );
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Discard the new details");
      await dialog.accept();
    });
    await details.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(code).toContainText("local");

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Discard my local edits");
      await dialog.dismiss();
    });
    await page
      .getByRole("button", { name: "Discard my edits and load server draft" })
      .click();
    await expect(code).toContainText("local");
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page
      .getByRole("button", { name: "Discard my edits and load server draft" })
      .click();
    await expect(code).toContainText("server");
    await expect(
      page.getByRole("button", { name: "Compare drafts" }),
    ).toHaveCount(0);
  } finally {
    await archive(page, doc.id, headers);
  }
});

test("separate edits merge on the current server revision and remain unsaved until Save", async ({
  page,
}) => {
  const { doc, headers } = await create(page);
  try {
    await page.goto(`/#/configurations/${doc.id}`);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const code = page.getByLabel("Vector configuration code");
    const local = base();
    local.transforms.process.source = '.marker = "mine"';
    await code.fill(JSON.stringify(local));
    await page.getByRole("button", { name: "Apply code changes" }).click();

    const server = base();
    server.sources.input.interval = 2;
    expect(
      (
        await page.request.put(`/api/v1/configurations/${doc.id}/draft`, {
          headers,
          data: {
            revision: doc.revision,
            config: server,
            graph: doc.graph,
            variables: [],
            message: "Peer changed the source interval",
          },
        })
      ).ok(),
    ).toBeTruthy();

    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    await page.getByRole("button", { name: "Compare drafts" }).click();
    const comparison = page.getByRole("dialog", {
      name: "Compare draft copies",
    });
    await expect(
      comparison.getByRole("button", { name: "Apply combined draft" }),
    ).toBeEnabled();
    await comparison
      .getByRole("button", { name: "Apply combined draft" })
      .click();
    await expect(comparison).toHaveCount(0);

    const beforeSave = await page.request
      .get(`/api/v1/configurations/${doc.id}`)
      .then((response) => response.json());
    expect(beforeSave.config.transforms.process.source).toBe(
      '.marker = "base"',
    );
    expect(beforeSave.config.sources.input.interval).toBe(2);
    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    await expect
      .poll(async () =>
        page.request
          .get(`/api/v1/configurations/${doc.id}`)
          .then(async (response) => (await response.json()).config),
      )
      .toMatchObject({
        sources: { input: { interval: 2 } },
        transforms: { process: { source: '.marker = "mine"' } },
      });
  } finally {
    await archive(page, doc.id, headers);
  }
});

test("same-field conflict requires an explicit choice and survives a page reload", async ({
  page,
}) => {
  const { doc, headers } = await create(page);
  try {
    await page.goto(`/#/configurations/${doc.id}`);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const code = page.getByLabel("Vector configuration code");
    const local = base();
    local.transforms.process.source = '.marker = "mine"';
    await code.fill(JSON.stringify(local));
    await page.getByRole("button", { name: "Apply code changes" }).click();
    const server = base();
    server.transforms.process.source = '.marker = "theirs"';
    expect(
      (
        await page.request.put(`/api/v1/configurations/${doc.id}/draft`, {
          headers,
          data: {
            revision: doc.revision,
            config: server,
            graph: doc.graph,
            variables: [],
            message: "Peer changed the same VRL",
          },
        })
      ).ok(),
    ).toBeTruthy();
    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Compare drafts" }),
    ).toBeVisible();
    page.once("dialog", async (dialog) => dialog.accept());
    await page.reload();
    await page.getByRole("button", { name: "Restore changes" }).click();
    await page.getByRole("button", { name: "Compare drafts" }).click();
    const comparison = page.getByRole("dialog", {
      name: "Compare draft copies",
    });
    await expect(comparison).toContainText("transforms.process.source");
    await expect(
      comparison.getByRole("button", { name: "Apply combined draft" }),
    ).toBeDisabled();
    await comparison.getByRole("radio", { name: /Keep mine/ }).check();
    await comparison
      .getByRole("button", { name: "Apply combined draft" })
      .click();
    await expect(comparison).toHaveCount(0);
    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    await expect
      .poll(async () =>
        page.request
          .get(`/api/v1/configurations/${doc.id}`)
          .then(
            async (response) =>
              (await response.json()).config.transforms.process.source,
          ),
      )
      .toBe('.marker = "mine"');
  } finally {
    await archive(page, doc.id, headers);
  }
});

test("a pipeline-details conflict preserves the local name and merges a peer description", async ({
  page,
}) => {
  const { doc, headers } = await create(page);
  try {
    await page.goto(`/#/configurations/${doc.id}`);
    await page.getByRole("button", { name: /Edit pipeline details:/ }).click();
    const details = page.getByRole("dialog", { name: "Pipeline details" });
    const localName = `${doc.name} local`;
    await details
      .getByRole("textbox", { name: "Pipeline name" })
      .fill(localName);

    const peerDescription = "Peer changed the description; never deployed.";
    expect(
      (
        await page.request.put(`/api/v1/configurations/${doc.id}/draft`, {
          headers,
          data: {
            revision: doc.revision,
            name: doc.name,
            description: peerDescription,
            config: doc.config,
            graph: doc.graph,
            variables: doc.variables || [],
            message: "Peer changed pipeline details",
          },
        })
      ).ok(),
    ).toBeTruthy();
    await details.getByRole("button", { name: "Save details" }).click();
    await expect(details).toHaveCount(0);
    await page.getByRole("button", { name: "Compare drafts" }).click();
    const comparison = page.getByRole("dialog", {
      name: "Compare draft copies",
    });
    await expect(comparison).toContainText("Pipeline name");
    await expect(
      comparison.getByRole("button", { name: "Apply combined draft" }),
    ).toBeEnabled();
    await comparison
      .getByRole("button", { name: "Apply combined draft" })
      .click();
    await expect(comparison).toHaveCount(0);
    await expect(page.getByRole("heading", { name: localName })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit pipeline description" }),
    ).toHaveText(peerDescription);
    const beforeSave = await page.request
      .get(`/api/v1/configurations/${doc.id}`)
      .then((response) => response.json());
    expect(beforeSave.name).toBe(doc.name);
    expect(beforeSave.description).toBe(peerDescription);

    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    await expect
      .poll(async () =>
        page.request
          .get(`/api/v1/configurations/${doc.id}`)
          .then(async (response) => (await response.json()).name),
      )
      .toBe(localName);
  } finally {
    await archive(page, doc.id, headers);
  }
});

test("an archived pipeline still offers a stored local draft for download", async ({
  page,
}) => {
  const { doc, headers } = await create(page);
  try {
    await page.goto(`/#/configurations/${doc.id}`);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const local = base();
    local.transforms.process.source = '.marker = "before archive"';
    await page
      .getByLabel("Vector configuration code")
      .fill(JSON.stringify(local));
    await page.getByRole("button", { name: "Apply code changes" }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some((key) =>
            key.startsWith("vectory.draft.v2:"),
          ),
        ),
      )
      .toBe(true);
    await archive(page, doc.id, headers);
    page.once("dialog", async (dialog) => dialog.accept());
    await page.reload();
    await expect(
      page.getByText(/This pipeline is read-only now/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Restore changes" }),
    ).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download my draft" }).click();
    expect((await download).suggestedFilename()).toContain("-local-draft.json");
  } finally {
    await archive(page, doc.id, headers);
  }
});

test("two open tabs keep distinct browser copies and an active copy cannot be discarded", async ({
  page,
}) => {
  const { doc, headers } = await create(page);
  const second = await page.context().newPage();
  try {
    await page.goto(`/#/configurations/${doc.id}`);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const firstCode = base();
    firstCode.transforms.process.source = '.marker = "first tab"';
    await page
      .getByLabel("Vector configuration code")
      .fill(JSON.stringify(firstCode));
    await page.getByRole("button", { name: "Apply code changes" }).click();
    const copySources = () =>
      second.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith("vectory.draft.v2:"))
          .map(
            (key) =>
              JSON.parse(localStorage.getItem(key) || "{}").config?.transforms
                ?.process?.source,
          )
          .sort(),
      );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Object.keys(localStorage).filter((key) =>
              key.startsWith("vectory.draft.v2:"),
            ).length,
        ),
      )
      .toBe(1);

    await second.goto(`/#/configurations/${doc.id}`);
    await expect(
      second.getByRole("button", { name: "Restore changes" }),
    ).toBeVisible();
    await second.getByRole("button", { name: "Code", exact: true }).click();
    const secondCode = base();
    secondCode.transforms.process.source = '.marker = "second tab"';
    await second
      .getByLabel("Vector configuration code")
      .fill(JSON.stringify(secondCode));
    await second.getByRole("button", { name: "Apply code changes" }).click();
    await expect
      .poll(copySources)
      .toEqual(['.marker = "first tab"', '.marker = "second tab"']);
    await expect(
      second.getByRole("button", { name: "Discard copy" }),
    ).toBeDisabled();
    second.once("dialog", async (dialog) => dialog.accept());
    await second.reload();
    const picker = second.getByLabel("Saved browser copy");
    await expect(picker).toBeVisible();
    await expect(picker.locator("option")).toHaveCount(2);
    expect(await copySources()).toContain('.marker = "first tab"');
    expect(await copySources()).toContain('.marker = "second tab"');
  } finally {
    await second.close();
    await archive(page, doc.id, headers);
  }
});

test("a delayed comparison cannot reopen an obsolete draft after reload and another conflict", async ({
  page,
}) => {
  const { doc, headers } = await create(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const comparing = new Promise<void>((resolve) => (started = resolve));
  try {
    await page.goto(`/#/configurations/${doc.id}`);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const code = page.getByLabel("Vector configuration code");
    const local = base();
    local.transforms.process.source = '.marker = "first local"';
    await code.fill(JSON.stringify(local));
    await page.getByRole("button", { name: "Apply code changes" }).click();
    const server = base();
    server.transforms.process.source = '.marker = "first server"';
    expect(
      (
        await page.request.put(`/api/v1/configurations/${doc.id}/draft`, {
          headers,
          data: {
            revision: doc.revision,
            config: server,
            graph: doc.graph,
            variables: [],
            message: "First peer edit",
          },
        })
      ).ok(),
    ).toBeTruthy();
    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Compare drafts" }),
    ).toBeVisible();

    let intercepted = false;
    await page.route(`**/api/v1/configurations/${doc.id}`, async (route) => {
      if (route.request().method() !== "GET" || intercepted) {
        await route.continue();
        return;
      }
      intercepted = true;
      const snapshot = await page.request.get(
        `/api/v1/configurations/${doc.id}`,
      );
      const body = await snapshot.text();
      started();
      await hold;
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body,
        });
      } catch {
        // The editor aborts this obsolete request when the operator reloads.
      }
    });
    await page.getByRole("button", { name: "Compare drafts" }).click();
    await comparing;
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page
      .getByRole("button", { name: "Discard my edits and load server draft" })
      .click();
    await expect(code).toContainText("first server");

    local.transforms.process.source = '.marker = "second local"';
    await code.fill(JSON.stringify(local));
    await page.getByRole("button", { name: "Apply code changes" }).click();
    const latest = await page.request
      .get(`/api/v1/configurations/${doc.id}`)
      .then((response) => response.json());
    server.transforms.process.source = '.marker = "second server"';
    expect(
      (
        await page.request.put(`/api/v1/configurations/${doc.id}/draft`, {
          headers,
          data: {
            revision: latest.revision,
            config: server,
            graph: latest.graph,
            variables: [],
            message: "Second peer edit",
          },
        })
      ).ok(),
    ).toBeTruthy();
    await page.getByRole("button", { name: "Save options" }).click();
    await page
      .getByRole("menuitem", { name: "Save draft", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Compare drafts" }),
    ).toBeVisible();

    release();
    await expect(
      page.getByRole("dialog", { name: "Compare draft copies" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Compare drafts" }).click();
    const comparison = page.getByRole("dialog", {
      name: "Compare draft copies",
    });
    await expect(comparison).toContainText("second server");
    await expect(comparison).toContainText("second local");
    // The prior server value is now the merge base, not an obsolete comparison.
    await expect(comparison).toContainText(/Original:.*first server/);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await archive(page, doc.id, headers);
  }
});

test("Code Apply names a plaintext credential field and keeps the code unapplied", async ({
  page,
}) => {
  const { doc, headers } = await create(page);
  try {
    await page.goto(`/#/configurations/${doc.id}`);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    const code = page.getByLabel("Vector configuration code");
    const candidate = {
      ...base(),
      sinks: {
        output: {
          type: "http",
          inputs: ["process"],
          uri: "https://collector.example/ingest",
          request: {
            headers: { Authorization: "Bearer test-credential-do-not-save" },
          },
        },
      },
    };
    await code.fill(JSON.stringify(candidate));
    await page.getByRole("button", { name: "Apply code changes" }).click();
    await expect(
      page.getByText(
        /Likely plaintext credential at (?:Line \d+: )?sinks.output.request.headers.Authorization/,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Apply code changes" }),
    ).toBeEnabled();
    candidate.sinks.output.request.headers.Authorization =
      "vectory-secret:INGEST_KEY";
    await code.fill(JSON.stringify(candidate));
    await page.getByRole("button", { name: "Apply code changes" }).click();
    await expect(
      page.getByText(
        /Device secret reference at (?:Line \d+: )?sinks.output.request.headers.Authorization is not supported in this field/,
      ),
    ).toBeVisible();
    expect(
      (
        await page.request
          .get(`/api/v1/configurations/${doc.id}`)
          .then((r) => r.json())
      ).config,
    ).toEqual(base());
  } finally {
    await archive(page, doc.id, headers);
  }
});
