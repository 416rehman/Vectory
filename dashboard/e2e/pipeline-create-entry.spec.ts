import { expect, test } from "@playwright/test";

test("an empty or whitespace-only name gets inline feedback without a request", async ({
  page,
}) => {
  let posted = false;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/configurations"
    )
      posted = true;
  });
  await page.goto("/#/configurations");
  await page.getByRole("button", { name: "Create pipeline" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create pipeline" });
  const name = dialog.getByRole("textbox", { name: "Pipeline name" });
  const submit = dialog.getByRole("button", { name: "Create pipeline" });
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Enter a pipeline name to create a draft.",
  );
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAttribute("aria-describedby", /pipeline-name-error/);
  expect(posted).toBe(false);

  await name.fill("  ");
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Enter a pipeline name to create a draft.",
  );
  expect(posted).toBe(false);

  await name.fill("Ready to create");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(submit).toBeEnabled();
});

test("a named pipeline is created from the frontend and opens its draft", async ({
  page,
}) => {
  const name = `Synthetic frontend creation ${Date.now()}`;
  const session = await page.request.get("/api/v1/session");
  expect(session.ok()).toBeTruthy();
  const { csrf_token: csrfToken } = await session.json();
  let id: string | undefined;
  try {
    await page.goto("/#/configurations");
    await page.getByRole("button", { name: "Create pipeline" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create pipeline" });
    await dialog.getByRole("textbox", { name: "Pipeline name" }).fill(name);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/configurations",
    );
    await dialog.getByRole("button", { name: "Create pipeline" }).click();
    const created = await createdResponse;
    expect(created.ok()).toBeTruthy();
    id = (await created.json()).id;
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    expect(page.url()).toContain(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const response = await page.request.get(`/api/v1/configurations/${id}`);
    expect(response.ok()).toBeTruthy();
    const saved = await response.json();
    expect(saved.name).toBe(name);
    expect(saved.archived).toBe(false);
  } finally {
    if (id) {
      const response = await page.request.get(`/api/v1/configurations/${id}`);
      if (response.ok()) {
        const saved = await response.json();
        if (!saved.archived) {
          const archive = await page.request.post(
            `/api/v1/configurations/${id}/archive`,
            {
              headers: { "X-CSRF-Token": csrfToken },
              data: { revision: saved.revision },
            },
          );
          expect(archive.ok()).toBeTruthy();
        }
      }
    }
  }
});

test("a saved creation reminder leads directly to recovery from the create action", async ({
  page,
}) => {
  const session = await page.request.get("/api/v1/session");
  expect(session.ok()).toBeTruthy();
  const { user } = await session.json();
  const requestId = crypto.randomUUID();
  await page.addInitScript(
    ({ actorId, requestId }) => {
      localStorage.setItem(
        `vectory:pipeline-creation:${encodeURIComponent(actorId)}:${requestId}`,
        JSON.stringify({
          actor_id: actorId,
          id: requestId,
          recorded_at: new Date().toISOString(),
          operation: "create",
          source_configuration_id: null,
          request: {
            request_id: requestId,
            name: "Synthetic interrupted pipeline",
            description: "Browser regression only. Never submitted.",
            config: { sources: {}, transforms: {}, sinks: {} },
            graph: { nodes: [], edges: [] },
          },
        }),
      );
    },
    { actorId: user.id, requestId },
  );

  let posted = false;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/configurations"
    )
      posted = true;
  });
  await page.goto("/#/configurations");
  await expect(
    page.getByText(
      "1 pipeline request needs confirmation before creating or duplicating another.",
    ),
  ).toBeVisible();
  const action = page
    .getByRole("button", { name: "Review saved requests" })
    .first();
  await expect(action).toBeEnabled();
  await action.click();
  const dialog = page.getByRole("dialog", { name: "Saved pipeline requests" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Synthetic interrupted pipeline/ }),
  ).toBeVisible();
  expect(posted).toBe(false);

  await dialog
    .getByRole("button", { name: /Synthetic interrupted pipeline/ })
    .click();
  const requestDialog = page.getByRole("dialog", {
    name: "Review pipeline request",
  });
  await expect(
    requestDialog.getByText(
      "No completed request was found yet. It may still be in flight.",
    ),
  ).toBeVisible();
  await requestDialog.getByRole("button", { name: "Dismiss reminder" }).click();
  await page
    .getByRole("dialog", { name: "Dismiss this pipeline reminder?" })
    .getByRole("button", { name: "Dismiss reminder" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create pipeline" }).first(),
  ).toBeEnabled();
  expect(posted).toBe(false);
});
