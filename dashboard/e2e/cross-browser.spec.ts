import { expect, test, type Page } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";

// What a person does first on a new instance, in whichever browser Playwright
// runs it (VECTORY_E2E_BROWSERS, see playwright.config.ts): create the first
// administrator, sign in, create and publish a pipeline, and open Devices. The
// instance must be fresh and VECTORY_BOOTSTRAP_SECRET_FILE must name its
// bootstrap secret. The tests run in order and share one account.
test.describe.configure({ mode: "serial" });

const account = {
  name: "Cross-browser operator",
  email: "cross-browser@vectory.local",
  password: crypto.randomBytes(24).toString("base64url"),
};

/** A signed-in session without the form: the form has its own test. */
async function signedIn(page: Page) {
  const login = await page.request.post("/api/v1/login", {
    data: { email: account.email, password: account.password },
  });
  expect(login.ok()).toBeTruthy();
}

test("first administrator: the setup screen creates the account and signs in", async ({
  page,
}) => {
  const file = process.env.VECTORY_BOOTSTRAP_SECRET_FILE;
  if (!file) throw new Error("Set VECTORY_BOOTSTRAP_SECRET_FILE.");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Set up Vectory", level: 1 }),
  ).toBeVisible();
  await page
    .getByLabel("Setup secret", { exact: true })
    .fill(fs.readFileSync(file, "utf8").trim());
  await page.getByLabel("Your name", { exact: true }).fill(account.name);
  await page.getByLabel("Email address", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill(account.password);
  await page
    .getByRole("button", { name: "Create administrator account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Vectory is ready", level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Go to Overview", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Overview", level: 1, exact: true }),
  ).toBeVisible();
  const status = await page.request.get("/api/v1/status");
  expect((await status.json()).initialized).toBe(true);
});

test("sign-in: the form signs the administrator in from a browser with no session", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /^Sign in to /, level: 1 }),
  ).toBeVisible();
  await page.getByLabel("Email address", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", level: 1, exact: true }),
  ).toBeVisible();
  const session = await page.request.get("/api/v1/session");
  expect((await session.json()).user.email).toBe(account.email);
});

test("create and publish a pipeline: the synthetic example becomes version 1", async ({
  page,
}) => {
  await signedIn(page);
  const name = `Cross-browser pipeline ${Date.now()}`;
  await page.goto("/#/configurations");
  await page.getByRole("button", { name: "Create pipeline" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create pipeline" });
  await dialog.getByText("Try a synthetic example", { exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: /Try a synthetic example/ }),
  ).toBeChecked();
  await dialog.getByRole("textbox", { name: "Pipeline name" }).fill(name);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/configurations",
  );
  await dialog.getByRole("button", { name: "Create pipeline" }).click();
  const id = (await (await created).json()).id;
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Review & publish", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Publish version", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Choose devices", exact: true }),
  ).toBeVisible();
  const versions = await (
    await page.request.get(`/api/v1/configurations/${id}/versions`)
  ).json();
  expect(versions).toHaveLength(1);
  expect(versions[0].config.sources.demo.type).toBe("demo_logs");
});

test("the Devices page of an instance with no devices offers Add device", async ({
  page,
}) => {
  await signedIn(page);
  await page.goto("/#/devices");
  await expect(
    page.getByRole("heading", { name: "Devices", level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No devices yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add device" }).first().click();
  await expect(page).toHaveURL(/#\/enrollment/);
});
