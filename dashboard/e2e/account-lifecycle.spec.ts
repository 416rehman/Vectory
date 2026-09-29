import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import crypto from "node:crypto";

// Passwords, reset codes and MFA secrets must never enter traces or screenshots.
test.use({ trace: "off", screenshot: "off" });

type Account = {
  id: string;
  name: string;
  email: string;
  password: string;
  role: string;
};
const password = () => crypto.randomBytes(24).toString("base64url");

async function session(request: APIRequestContext) {
  const response = await request.get("/api/v1/session");
  expect(response.status()).toBe(200);
  return response.json();
}

async function createAccount(
  request: APIRequestContext,
  role: string,
): Promise<Account> {
  const active = await session(request);
  const suffix = crypto.randomBytes(8).toString("hex");
  const account = {
    name: `Synthetic lifecycle ${role} ${suffix}`,
    email: `lifecycle-${suffix}@vectory.local`,
    password: password(),
    role,
  };
  const response = await request.post("/api/v1/users", {
    headers: { "X-CSRF-Token": active.csrf_token },
    data: account,
  });
  expect(response.status()).toBe(200);
  return { ...account, id: (await response.json()).id };
}

async function fixture(
  seed: APIRequestContext,
  browser: Browser,
  baseURL: string,
) {
  const admin = await createAccount(seed, "admin");
  const contexts: BrowserContext[] = [];
  const accounts: Account[] = [];
  async function open(account?: Account) {
    const context = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    contexts.push(context);
    if (account) {
      const response = await context.request.post("/api/v1/login", {
        data: { email: account.email, password: account.password },
      });
      expect(response.status()).toBe(200);
    }
    const page = await context.newPage();
    await page.goto("/#/users");
    return page;
  }
  const administrator = await open(admin);
  return {
    admin,
    administrator,
    open,
    async account(role = "viewer") {
      const account = await createAccount(administrator.request, role);
      accounts.push(account);
      return account;
    },
    async close() {
      try {
        // Disable only these fresh fixtures, using the synthetic administrator.
        // The shared preview administrator is used solely to create that account.
        const active = await session(administrator.request);
        const response = await administrator.request.get("/api/v1/users");
        expect(response.status()).toBe(200);
        const people = await response.json();
        for (const account of [...accounts, admin]) {
          const current = people.find(
            (person: { id: string }) => person.id === account.id,
          );
          if (!current?.enabled) continue;
          const disabled = await administrator.request.put(
            `/api/v1/users/${account.id}`,
            {
              headers: { "X-CSRF-Token": active.csrf_token },
              data: {
                name: current.name,
                role: current.role,
                enabled: false,
                revision: current.revision,
                current_password: admin.password,
              },
            },
          );
          expect(disabled.status(), "Synthetic account cleanup").toBe(200);
        }
      } finally {
        await Promise.all(contexts.map((context) => context.close()));
      }
    },
  };
}

async function login(
  page: Page,
  account: Account,
  value = account.password,
  expected = 200,
) {
  await page.getByLabel("Email address", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(value);
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await response).status()).toBe(expected);
  if (expected === 200)
    await expect(
      page.getByRole("button", { name: "Your account", exact: true }),
    ).toBeVisible();
  else
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
}

async function revokedBanner(page: Page) {
  // Cause a normal authenticated application request in an already open victim
  // tab. A raw request probe alone would not exercise the UI's session event.
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Your session ended." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sign in again", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
}

async function accessibleMobile(page: Page) {
  await page.setViewportSize({ width: 375, height: 812 });
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  // Keep any failure output free of rendered credential-bearing HTML.
  expect(
    result.violations.map((item) => ({ id: item.id, impact: item.impact })),
  ).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function selectPerson(page: Page, account: Account) {
  await page
    .getByRole("textbox", { name: "Find a person", exact: true })
    .fill(account.email);
  const row = page.getByRole("row").filter({ hasText: account.email });
  await expect(row).toBeVisible();
  return row;
}

async function issueReset(page: Page, admin: Account, target: Account) {
  const row = await selectPerson(page, target);
  await row.getByRole("button", { name: /^Reset password for / }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create a password reset code",
    exact: true,
  });
  await dialog
    .getByLabel("Your current password", { exact: true })
    .fill(admin.password);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/users/${target.id}/password-reset`) &&
      r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create reset code", exact: true })
    .click();
  const issued = await response;
  expect(issued.status()).toBe(200);
  const result = await issued.json();
  const codeDialog = page.getByRole("dialog", { name: /^Password reset for / });
  const code = (await codeDialog
    .getByLabel("Password reset code", { exact: true })
    .textContent())!.trim();
  expect(/^[0-9a-f]{64}$/.test(code)).toBeTruthy();
  expect(code === result.code).toBeTruthy();
  const remaining = Date.parse(result.expires_at) - Date.now();
  expect(remaining).toBeGreaterThan(14 * 60 * 1000);
  expect(remaining).toBeLessThanOrEqual(15 * 60 * 1000);
  await codeDialog
    .getByRole("button", { name: "I've shared the code", exact: true })
    .click();
  await expect(codeDialog).not.toBeVisible();
  return code;
}

async function resetPublic(
  page: Page,
  code: string,
  next: string,
  expected = 200,
) {
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reset your password", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Password reset code", { exact: true }).fill(code);
  await page.getByLabel("New password", { exact: true }).fill(next);
  await page.getByLabel("Confirm new password", { exact: true }).fill(next);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/password-reset") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Set new password", exact: true })
    .click();
  expect((await response).status()).toBe(expected);
  if (expected === 200) {
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Password reset." }),
    ).toBeVisible();
  } else {
    await expect(page.getByRole("alert")).toContainText(
      "invalid, expired or already used",
    );
    await expect(
      page.getByRole("heading", { name: "Reset your password", exact: true }),
    ).toBeVisible();
  }
  expect((await page.request.get("/api/v1/session")).status()).toBe(401);
}

function totp(secret: string) {
  const bits = [...secret]
    .map((c) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(c)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac("sha1", key).update(counter).digest();
  return String(
    (digest.readUInt32BE(digest.at(-1)! & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
}

test("same-browser password rotation refreshes other tabs without losing draft input or retrying mutations", async ({
  page: seed,
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const f = await fixture(seed.request, browser, baseURL!);
  try {
    const account = await f.account("editor");
    const owner = await f.open(account);
    const active = await session(owner.request);
    const created = await owner.request.post("/api/v1/configurations", {
      headers: { "X-CSRF-Token": active.csrf_token },
      data: {
        name: `Synthetic account tab preservation ${crypto.randomBytes(6).toString("hex")}`,
        description: "Browser verification; never deployed.",
        graph: { nodes: [], edges: [] },
        config: {
          sources: { example: { type: "demo_logs", format: "json" } },
          transforms: {
            sample: { type: "sample", inputs: ["example"], rate: 10 },
          },
          sinks: { discard: { type: "blackhole", inputs: ["sample"] } },
        },
      },
    });
    expect(created.status()).toBe(200);
    const document = await created.json();
    const draft = await owner.context().newPage();
    await draft.goto(`/#/configurations/${document.id}`);
    await expect(
      draft.locator('.react-flow__node[data-id="sample"]'),
    ).toBeVisible({ timeout: 10_000 });
    await draft.locator('.react-flow__node[data-id="sample"]').click();
    const inspector = draft.locator(".editor-inspector");
    const rate = inspector.getByLabel("One in every", { exact: true });
    let navigations = 0;
    draft.on("framenavigated", (frame) => {
      if (frame === draft.mainFrame()) navigations++;
    });

    for (const [index, mode] of ["notification", "focus fallback"].entries()) {
      await rate.fill("-");
      await expect(
        draft.locator(
          ".pipeline-save-status[data-save-state='unapplied']:visible",
        ),
      ).toContainText("Unapplied field changes");
      if (mode === "focus fallback") {
        // Simulate a missed/unavailable cross-tab signal. A later real focus
        // must refresh session state without unloading this pending editor.
        await draft.evaluate(() =>
          window.addEventListener(
            "storage",
            (event) => event.stopImmediatePropagation(),
            { capture: true },
          ),
        );
      }
      await owner.bringToFront();
      await owner
        .getByRole("button", { name: "Change password", exact: true })
        .click();
      const dialog = owner.getByRole("dialog", {
        name: "Change your password",
        exact: true,
      });
      const next = password();
      await dialog
        .getByLabel("Your current password", { exact: true })
        .fill(account.password);
      await dialog.getByLabel("New password", { exact: true }).fill(next);
      await dialog
        .getByLabel("Confirm new password", { exact: true })
        .fill(next);
      const refreshed = draft.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/session") &&
          response.request().method() === "GET",
      );
      await dialog
        .getByRole("button", { name: "Change password", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      account.password = next;
      if (mode === "focus fallback") {
        await draft.bringToFront();
        // Headless tab foreground changes do not consistently emit a window
        // focus event. Exercise the actual fallback handler deterministically.
        await draft.evaluate(() => window.dispatchEvent(new Event("focus")));
      }
      expect((await refreshed).status(), mode).toBe(200);
      await draft.bringToFront();
      await expect(rate).toHaveValue("-");
      await expect(
        draft.locator(
          ".pipeline-save-status[data-save-state='unapplied']:visible",
        ),
      ).toContainText("Unapplied field changes");
      expect(navigations, mode).toBe(0);
      const stored = await draft.request
        .get(`/api/v1/configurations/${document.id}`)
        .then((response) => response.json());
      expect(stored.config.transforms.sample.rate).toBe(10 + index);

      const attempts: number[] = [];
      const observe = (response: import("@playwright/test").Response) => {
        if (
          response.url().endsWith(`/configurations/${document.id}/draft`) &&
          response.request().method() === "PUT"
        )
          attempts.push(response.status());
      };
      draft.on("response", observe);
      const saved = draft.waitForResponse(
        (response) =>
          response.url().endsWith(`/configurations/${document.id}/draft`) &&
          response.request().method() === "PUT",
      );
      await rate.fill(String(11 + index));
      await rate.blur();
      await draft
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      expect((await saved).status(), mode).toBe(200);
      await expect(
        draft.locator(".pipeline-save-status[data-save-state='saved']:visible"),
      ).toBeVisible();
      expect(attempts, mode).toEqual([200]);
      draft.off("response", observe);
      const applied = await draft.request
        .get(`/api/v1/configurations/${document.id}`)
        .then((response) => response.json());
      expect(applied.config.transforms.sample.rate).toBe(11 + index);
    }

    // A different account signing in through this browser must not silently
    // adopt another editor's pending work or replace the user shown in that tab.
    const other = await f.account("editor");
    await expect(rate).toBeVisible();
    await rate.fill("13");
    await rate.blur();
    await expect(rate).toHaveValue("13");
    await owner.bringToFront();
    const replacement = await owner.request.post("/api/v1/login", {
      data: { email: other.email, password: other.password },
    });
    expect(replacement.status()).toBe(200);
    const rechecked = draft.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/session") &&
        response.request().method() === "GET",
      { timeout: 10_000 },
    );
    await draft.bringToFront();
    await draft.evaluate(() => window.dispatchEvent(new Event("focus")));
    const recheckedResponse = await rechecked;
    expect(recheckedResponse.status()).toBe(200);
    expect((await recheckedResponse.json()).user.id).toBe(other.id);
    await expect(
      draft.getByRole("alert").filter({ hasText: "Your session ended." }),
    ).toBeVisible({ timeout: 8_000 });
    await expect(rate).toHaveValue("13");
    const attemptedSaves: string[] = [];
    const observeAttempt = (request: import("@playwright/test").Request) => {
      if (
        request.url().endsWith(`/configurations/${document.id}/draft`) &&
        request.method() === "PUT"
      )
        attemptedSaves.push(request.url());
    };
    draft.on("request", observeAttempt);
    // The editor preserves its local field text but removes Save draft when
    // the session belongs to a different account.
    await expect(
      draft.getByRole("button", { name: "Save draft", exact: true }),
    ).toHaveCount(0);
    // Give any focus-triggered automatic work a turn to issue a mutation.
    await draft.waitForTimeout(250);
    expect(attemptedSaves).toEqual([]);
    draft.off("request", observeAttempt);
    await expect(rate).toHaveValue("13");
    expect(navigations).toBe(0);
    const unchanged = await draft.request
      .get(`/api/v1/configurations/${document.id}`)
      .then((response) => response.json());
    expect(unchanged.config.transforms.sample.rate).toBe(12);
  } finally {
    await f.close();
  }
});

test("viewer password change and session revocation preserve the current browser and recover the victim tab", async ({
  page: seed,
  browser,
  baseURL,
}) => {
  const f = await fixture(seed.request, browser, baseURL!);
  try {
    const account = await f.account();
    const owner = await f.open(account);
    const victim = await f.open(account);
    await expect(
      owner.getByRole("button", { name: "Add person", exact: true }),
    ).toHaveCount(0);
    await owner
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    const dialog = owner.getByRole("dialog", {
      name: "Change your password",
      exact: true,
    });
    await accessibleMobile(owner);
    const next = password();
    await dialog
      .getByLabel("Your current password", { exact: true })
      .fill(password());
    await dialog.getByLabel("New password", { exact: true }).fill(next);
    await dialog.getByLabel("Confirm new password", { exact: true }).fill(next);
    const rejected = owner.waitForResponse(
      (r) =>
        r.url().endsWith("/account/password") &&
        r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    expect((await rejected).status()).toBe(403);
    await expect(dialog.getByRole("alert")).toContainText(
      "Current password is incorrect",
    );
    await expect(
      owner.getByText("Your session ended. Sign in again to continue.", {
        exact: true,
      }),
    ).toHaveCount(0);
    expect((await owner.request.get("/api/v1/session")).status()).toBe(200);
    await dialog
      .getByLabel("Your current password", { exact: true })
      .fill(account.password);
    // The rejected request clears all secret inputs, including the proposed
    // password, so the retry must deliberately enter the same new value.
    await dialog.getByLabel("New password", { exact: true }).fill(next);
    await dialog.getByLabel("Confirm new password", { exact: true }).fill(next);
    await dialog
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      owner.getByRole("status").filter({ hasText: "Password changed." }),
    ).toBeVisible();
    expect((await owner.request.get("/api/v1/session")).status()).toBe(200);
    expect((await victim.request.get("/api/v1/session")).status()).toBe(401);
    await revokedBanner(victim);
    await login(victim, account, account.password, 401);
    await login(victim, account, next);
    account.password = next;

    // The owner now needs its rotated CSRF token for a second real mutation.
    await victim.goto("/#/users");
    await owner
      .getByRole("button", { name: "Sign out other sessions", exact: true })
      .click();
    const revoke = owner.getByRole("dialog", {
      name: "Sign out other sessions",
      exact: true,
    });
    await revoke
      .getByLabel("Your current password", { exact: true })
      .fill(next);
    await revoke
      .getByRole("button", { name: "Sign out other sessions", exact: true })
      .click();
    await expect(revoke).not.toBeVisible();
    expect((await owner.request.get("/api/v1/session")).status()).toBe(200);
    expect((await victim.request.get("/api/v1/session")).status()).toBe(401);
    await revokedBanner(victim);
    await login(victim, account);
  } finally {
    await f.close();
  }
});

test("administrator access changes use current revisions and public password reset codes work once", async ({
  page: seed,
  browser,
  baseURL,
}) => {
  const f = await fixture(seed.request, browser, baseURL!);
  try {
    const target = await f.account();
    const victim = await f.open(target);
    const admin = f.administrator;
    await admin.reload();
    const row = await selectPerson(admin, target);
    await row.getByRole("button", { name: /^Edit access for / }).click();
    const edit = admin.getByRole("dialog", {
      name: "Edit workspace access",
      exact: true,
    });

    // Another administrator's name edit must not be silently overwritten.
    const active = await session(admin.request);
    const people = await admin.request
      .get("/api/v1/users")
      .then((r) => r.json());
    const current = people.find(
      (person: { id: string }) => person.id === target.id,
    );
    const concurrent = await admin.request.put(`/api/v1/users/${target.id}`, {
      headers: { "X-CSRF-Token": active.csrf_token },
      data: {
        ...current,
        name: `Updated ${target.name}`,
        current_password: f.admin.password,
      },
    });
    expect(concurrent.status()).toBe(200);
    await edit
      .getByLabel("Full name", { exact: true })
      .fill(`Renamed ${target.name}`);
    await edit
      .getByLabel("Your current password", { exact: true })
      .fill(f.admin.password);
    await edit
      .getByRole("button", { name: "Save access", exact: true })
      .click();
    // A stale-revision response cannot prove that a sent access request did
    // not apply. Resolve that exact request before trying the newer revision.
    const review = admin.getByRole("dialog", {
      name: "Access change needs review",
      exact: true,
    });
    await expect(review).toBeVisible();
    await review
      .getByRole("button", { name: "Check request status", exact: true })
      .click();
    await expect(review).toContainText("No committed result is visible yet");
    await review
      .getByRole("button", { name: "Cancel this request", exact: true })
      .click();
    await expect(review).toContainText("This request cannot apply now");
    await review
      .getByRole("button", { name: "Finish review", exact: true })
      .click();
    await expect(review).not.toBeVisible();
    await row.getByRole("button", { name: /^Edit access for / }).click();
    await expect(edit.getByLabel("Full name", { exact: true })).toHaveValue(
      `Updated ${target.name}`,
    );
    const renamed = `Renamed ${target.name}`;
    await edit.getByLabel("Full name", { exact: true }).fill(renamed);
    await edit.getByRole("button", { name: "Role", exact: true }).click();
    await admin
      .getByRole("menuitemradio", { name: "Editor", exact: true })
      .click();
    await edit
      .getByLabel("Your current password", { exact: true })
      .fill(f.admin.password);
    await edit
      .getByRole("button", { name: "Save access", exact: true })
      .click();
    await expect(edit).not.toBeVisible();
    await expect(row).toContainText("Editor");
    target.name = renamed;
    await revokedBanner(victim);
    await login(victim, target);
    await victim.goto("/#/users");
    await row.getByRole("button", { name: /^Edit access for / }).click();
    await edit
      .getByLabel("Workspace access", { exact: true })
      .selectOption("disabled");
    await edit
      .getByLabel("Your current password", { exact: true })
      .fill(f.admin.password);
    await edit
      .getByRole("button", { name: "Save access", exact: true })
      .click();
    await expect(edit).not.toBeVisible();
    await expect(row.getByText("Disabled", { exact: true })).toBeVisible();
    await expect(
      row.getByRole("button", { name: /^Reset password for / }),
    ).toHaveCount(0);
    await revokedBanner(victim);
    await login(victim, target, target.password, 401);
    await row.getByRole("button", { name: /^Edit access for / }).click();
    await edit
      .getByLabel("Workspace access", { exact: true })
      .selectOption("active");
    await edit
      .getByLabel("Your current password", { exact: true })
      .fill(f.admin.password);
    await edit
      .getByRole("button", { name: "Save access", exact: true })
      .click();
    await expect(edit).not.toBeVisible();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await login(victim, target);
    const code = await issueReset(admin, f.admin, target);
    // Issuance alone changes neither the password nor an existing session.
    expect((await victim.request.get("/api/v1/session")).status()).toBe(200);
    const publicPage = await f.open();
    const next = password();
    await resetPublic(publicPage, code, next);
    expect((await victim.request.get("/api/v1/session")).status()).toBe(401);
    await resetPublic(publicPage, code, password(), 401);
    await publicPage
      .getByRole("button", { name: "Back to sign in", exact: true })
      .click();
    await login(publicPage, target, target.password, 401);
    await login(publicPage, target, next);
  } finally {
    await f.close();
  }
});

test("administrator password reset keeps MFA required and does not authenticate the public reset browser", async ({
  page: seed,
  browser,
  baseURL,
}) => {
  const f = await fixture(seed.request, browser, baseURL!);
  try {
    const target = await f.account();
    const owner = await f.open(target);
    const active = await session(owner.request);
    const headers = { "X-CSRF-Token": active.csrf_token };
    const setup = await owner.request.post("/api/v1/mfa/setup", {
      headers,
      data: { password: target.password },
    });
    expect(setup.status()).toBe(200);
    const secret = (await setup.json()).secret;
    const confirmation = await owner.request.post("/api/v1/mfa/confirm", {
      headers,
      data: { code: totp(secret) },
    });
    expect(confirmation.status()).toBe(200);
    const recovery = (await confirmation.json()).recovery_codes[0];
    const publicPage = await f.open();
    const pending = await publicPage.request.post("/api/v1/login", {
      data: { email: target.email, password: target.password },
    });
    expect(pending.status()).toBe(200);
    const oldChallenge = await pending.json();
    expect(oldChallenge.mfa_required).toBe(true);
    expect(oldChallenge).not.toHaveProperty("csrf_token");
    expect((await publicPage.request.get("/api/v1/session")).status()).toBe(
      401,
    );
    await f.administrator.reload();
    const code = await issueReset(f.administrator, f.admin, target);
    await publicPage
      .getByRole("button", { name: "Reset password", exact: true })
      .click();
    await accessibleMobile(publicPage);
    await publicPage
      .getByRole("button", { name: "Back to sign in", exact: true })
      .click();
    const next = password();
    await resetPublic(publicPage, code, next);
    const invalidated = await publicPage.request.post("/api/v1/login/mfa", {
      data: {
        challenge_token: oldChallenge.challenge_token,
        recovery_code: recovery,
      },
    });
    expect(invalidated.status()).toBe(401);
    expect((await invalidated.json()).error.code).toBe("MFA_CHALLENGE_EXPIRED");
    await login(publicPage, target, target.password, 401);
    await publicPage.getByLabel("Password", { exact: true }).fill(next);
    const challengeResponse = publicPage.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/login") && r.request().method() === "POST",
    );
    await publicPage
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    const start = await challengeResponse;
    expect(start.status()).toBe(200);
    const challenge = await start.json();
    expect(challenge.mfa_required).toBe(true);
    expect(challenge).not.toHaveProperty("user");
    expect(challenge).not.toHaveProperty("csrf_token");
    await expect(
      publicPage.getByRole("heading", {
        name: "Verify your identity",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      publicPage.getByLabel("Authenticator code", { exact: true }),
    ).toBeFocused();
    await expect(
      publicPage.getByLabel("Password", { exact: true }),
    ).toHaveCount(0);
    expect((await publicPage.request.get("/api/v1/session")).status()).toBe(
      401,
    );
    await accessibleMobile(publicPage);
    await publicPage
      .getByRole("button", { name: "Use a recovery code instead", exact: true })
      .click();
    await publicPage
      .getByLabel("Recovery code", { exact: true })
      .fill(recovery);
    const verifiedResponse = publicPage.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/login/mfa") &&
        r.request().method() === "POST",
    );
    await publicPage
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
    const verified = await verifiedResponse;
    expect(verified.status()).toBe(200);
    expect(Object.keys(verified.request().postDataJSON()).sort()).toEqual([
      "challenge_token",
      "recovery_code",
    ]);
    await expect(
      publicPage.getByRole("button", { name: "Your account", exact: true }),
    ).toBeVisible();
    expect(
      (await publicPage.request.get("/api/v1/mfa").then((r) => r.json()))
        .enabled,
    ).toBe(true);
    const anonymous = await f.open();
    const newChallenge = await anonymous.request
      .post("/api/v1/login", { data: { email: target.email, password: next } })
      .then((r) => r.json());
    const reused = await anonymous.request.post("/api/v1/login/mfa", {
      data: {
        challenge_token: newChallenge.challenge_token,
        recovery_code: recovery,
      },
    });
    expect(reused.status()).toBe(401);
    expect((await reused.json()).error.code).toBe("INVALID_MFA_CODE");
    expect((await anonymous.request.get("/api/v1/session")).status()).toBe(401);
  } finally {
    await f.close();
  }
});
