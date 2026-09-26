import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const root = path.resolve(import.meta.dirname, "../..");
const credentials = JSON.parse(
  fs.readFileSync(path.join(root, ".local/preview/credentials.json"), "utf8"),
);
test.use({ trace: "off", screenshot: "off" });
function totp(secret: string) {
  let bits = "";
  for (const c of secret)
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(c)
      .toString(2)
      .padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((s) => parseInt(s, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac("sha1", key).update(counter).digest(),
    offset = h.at(-1)! & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
test("MFA setup and one-use recovery login through real UI", async ({
  page,
}) => {
  const admin = await page.request.get("/api/v1/session").then((r) => r.json());
  const unique = Date.now().toString(36),
    account = {
      name: "MFA browser verification",
      email: `mfa-${unique}@vectory.local`,
      password: crypto.randomBytes(24).toString("base64url"),
      role: "viewer",
    };
  expect(
    (
      await page.request.post("/api/v1/users", {
        headers: { "X-CSRF-Token": admin.csrf_token },
        data: account,
      })
    ).ok(),
  ).toBeTruthy();
  await page.context().clearCookies();
  await page.request.post("/api/v1/login", { data: account });
  await page.goto("/#/users");
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  await page.getByLabel("Current password").fill(account.password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const setup = page.getByRole("dialog");
  await expect(
    setup.getByText("Connect your authenticator", { exact: true }),
  ).toBeVisible();
  const secret = await setup.locator("code").textContent();
  await setup.getByLabel("Authenticator code").fill(totp(secret!));
  await setup
    .getByRole("button", { name: "Enable multi-factor authentication" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Save your recovery codes" }),
  ).toBeVisible();
  const recovery = (await page
    .getByRole("dialog")
    .locator("pre")
    .textContent())!
    .trim()
    .split("\n")[0];
  await page
    .getByRole("button", { name: "I’ve saved my recovery codes" })
    .click();
  const session = await page.request
    .get("/api/v1/session")
    .then((r) => r.json());
  await page.request.post("/api/v1/logout", {
    headers: { "X-CSRF-Token": session.csrf_token },
  });
  await page.reload();
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page
    .getByRole("button", { name: "Use a recovery code instead" })
    .click();
  await page.getByLabel("Recovery code", { exact: true }).fill(recovery);
  await page
    .getByRole("button", { name: "Sign in to Vectory", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Users & security", exact: true }),
  ).toBeVisible();
  expect(
    (
      await page.request.post("/api/v1/login", {
        data: { ...account, recovery_code: recovery },
      })
    ).status(),
  ).toBe(401);
});
test("review recovery authorization, refresh schedule, and remove assignment", async ({
  page,
}) => {
  const session = await page.request
      .get("/api/v1/session")
      .then((r) => r.json()),
    headers = { "X-CSRF-Token": session.csrf_token };
  const devices = await page.request
      .get("/api/v1/devices")
      .then((r) => r.json()),
    device = devices.find(
      (d: any) => d.status === "offline" && d.name.startsWith("local-win-"),
    );
  expect(device).toBeTruthy();
  await page.goto("/#/devices/" + device.id);
  await page
    .getByRole("button", { name: "Authorize device recovery", exact: true })
    .click();
  const tokenResponse = page.waitForResponse(
    (r) => r.url().endsWith("/recover") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Authorize recovery", exact: true })
    .click();
  const token = await (await tokenResponse).json();
  await expect(
    page.getByRole("heading", { name: "Save this one-time recovery token" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "I’ve saved the token" }).click();
  expect(
    (
      await page.request.post(`/api/v1/tokens/${token.record.id}/revoke`, {
        headers,
      })
    ).ok(),
  ).toBeTruthy();
  const existing = await page.request
    .get("/api/v1/deployments")
    .then((r) => r.json());
  const policy = existing.find((d: any) => d.policy)?.policy;
  expect(policy).toBeTruthy();
  const request = {
    name: "Browser schedule " + Date.now(),
    policy,
    selector: { device_ids: [device.id], group_ids: [], exclude_ids: [] },
    priority: Math.max(300, ...existing.map((d: any) => d.priority)) + 1,
    target_mode: "snapshot",
    scheduled_at: new Date(Date.now() + 3600000).toISOString(),
    rollout: {
      kind: "all",
      canary_size: 1,
      batch_size: 10,
      observation_seconds: 10,
      failure_threshold: 0,
    },
  };
  const response = await page.request.post("/api/v1/deployments", {
    headers,
    data: request,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const deployment = await response.json();
  try {
    await page.goto("/#/schedules");
    await page
      .locator(".deployment-card")
      .filter({ hasText: request.name })
      .click();
    await page
      .getByRole("button", { name: "Refresh scheduled targets" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Review refreshed schedule targets" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm new snapshot" }).click();
    await expect(
      page.getByRole("heading", { name: "Review refreshed schedule targets" }),
    ).not.toBeVisible();
  } finally {
    await page.request.post(`/api/v1/deployments/${deployment.id}/cancel`, {
      headers,
    });
  }
  const assignment = await page.request
    .post("/api/v1/deployments", {
      headers,
      data: {
        ...request,
        name: "Browser removal " + Date.now(),
        scheduled_at: null,
      },
    })
    .then((r) => r.json());
  await page.goto("/#/deployments");
  await page
    .locator(".deployment-card")
    .filter({ hasText: assignment.name })
    .click();
  await page.getByRole("button", { name: "Remove assignment" }).click();
  await expect(
    page.getByRole("heading", { name: "Review assignment removal" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm removal" }).click();
  await expect
    .poll(async () =>
      page.request
        .get(`/api/v1/deployments/${assignment.id}`)
        .then((r) => r.json())
        .then((d) => d.status),
    )
    .toBe("unassigned");
});
