import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Passwords, reset links and MFA secrets must never enter traces or screenshots.
test.use({ trace: "off", screenshot: "off" });

// Every step here signs in, changes a password or issues a link, and each of
// those verifies an Argon2 hash in a development build of the server.
const afterPassword = { timeout: 20_000 };

type Account = {
  id: string;
  name: string;
  email: string;
  password: string;
  role: string;
};
const password = () => crypto.randomBytes(24).toString("base64url");

/**
 * The notification stack. Its cards are not live regions (the two hidden ones
 * that speak them are), so a message is found in the region, not by role.
 */
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications", exact: true });
async function session(request: APIRequestContext) {
  const response = await request.get("/api/v1/session");
  expect(response.status()).toBe(200);
  return response.json();
}

async function createAccount(
  request: APIRequestContext,
  role: string,
  currentPassword: string,
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
    data: { ...account, current_password: currentPassword },
  });
  expect(response.status()).toBe(200);
  return { ...account, id: (await response.json()).id };
}

async function fixture(
  seed: APIRequestContext,
  browser: Browser,
  baseURL: string,
) {
  const activeSeed = await session(seed);
  const credential = JSON.parse(
    await readFile(
      path.resolve(
        import.meta.dirname,
        "../..",
        process.env.VECTORY_PREVIEW_DIR || ".local/preview",
        "credentials.json",
      ),
      "utf8",
    ),
  );
  expect(credential.email).toBe(activeSeed.user.email);
  expect(
    typeof credential.password === "string" && credential.password.length > 0,
  ).toBe(true);
  const admin = await createAccount(seed, "admin", credential.password);
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
  await expect(
    administrator.getByRole("heading", {
      name: "People & security",
      exact: true,
    }),
  ).toBeVisible(afterPassword);
  return {
    admin,
    administrator,
    open,
    async account(role = "viewer") {
      const account = await createAccount(
        administrator.request,
        role,
        admin.password,
      );
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

const signInHeading = (page: Page) =>
  page.getByRole("heading", { name: /^Sign in to /, level: 1 });
const accountButton = (page: Page) =>
  page.getByRole("button", { name: "Your account", exact: true });
const loginResponse = (page: Page) =>
  page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/login") && r.request().method() === "POST",
  );

/** The full-page sign-in, for a browser with no session. */
async function login(
  page: Page,
  account: Account,
  value = account.password,
  expected = 200,
) {
  await page.getByLabel("Email address", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(value);
  const response = loginResponse(page);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await response).status()).toBe(expected);
  if (expected === 200) await expect(accountButton(page)).toBeVisible();
  else {
    await expect(signInHeading(page)).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      "That email and password don't match.",
    );
  }
}

/**
 * Cause a normal authenticated request in an already open tab. A raw request
 * probe alone would not exercise the app's session event: the workspace stays
 * mounted and a dialog explains why the sign-in ended.
 */
async function sessionEnded(page: Page, title: string) {
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  // Move to a page other than the current one, so the visit reads from the server.
  for (const name of ["Devices", "Pipelines", "Overview"]) {
    const link = navigation.getByRole("link", { name, exact: true });
    if ((await link.getAttribute("aria-current")) === "page") continue;
    await link.click();
    break;
  }
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog).toBeVisible(afterPassword);
  return dialog;
}

/** Sign in again over the workspace, as the same person. */
async function signInAgain(
  dialog: Locator,
  value: string,
  expected = 200,
): Promise<void> {
  await dialog.getByLabel("Password", { exact: true }).fill(value);
  const response = loginResponse(dialog.page());
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await response).status()).toBe(expected);
  if (expected === 200) await expect(dialog).not.toBeVisible(afterPassword);
  else {
    await expect(dialog).toContainText("That password didn't work.");
    await expect(dialog).toBeVisible();
  }
}

async function accessibleMobile(page: Page) {
  // Scan the settled page, not a dialog that is still fading in.
  await page.emulateMedia({ reducedMotion: "reduce" });
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

async function personRow(page: Page, account: Account) {
  // The search box appears once the workspace has more than five people.
  await expect(
    page.getByRole("row").filter({ hasText: "@" }).first(),
  ).toBeVisible(afterPassword);
  const search = page.getByRole("textbox", {
    name: "Find a person",
    exact: true,
  });
  if (await search.count()) await search.fill(account.email);
  const row = page.getByRole("row").filter({ hasText: account.email });
  await expect(row).toBeVisible();
  return row;
}

const editAccess = (row: Locator) =>
  row.getByRole("button", { name: /^Edit access for / });
const moreActions = (row: Locator) =>
  row.getByRole("button", { name: /^More actions for / });

const roleButton = (dialog: Locator) =>
  dialog.getByRole("button", { name: "Role", exact: true });
async function chooseRole(dialog: Locator, label: string) {
  await roleButton(dialog).click();
  await dialog
    .page()
    .getByRole("menuitemradio", { name: new RegExp(`^${label}\\b`) })
    .click();
}

/**
 * Issue a password reset link through the People page and return it. The link
 * is the only place its single-use code is shown, and it works for 15 minutes.
 */
async function issueResetLink(page: Page, admin: Account, target: Account) {
  const row = await personRow(page, target);
  await moreActions(row).click();
  await page
    .getByRole("menuitem", { name: "Reset password", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /^Reset .+'s password$/ });
  await expect(dialog).toContainText("It works for 15 minutes");
  await dialog
    .getByLabel("Your password", { exact: true })
    .fill(admin.password);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/users/${target.id}/password-reset`) &&
      r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Create reset link", exact: true })
    .click();
  const issued = await response;
  expect(issued.status()).toBe(200);
  const result = await issued.json();
  expect(result.purpose).toBe("reset");
  expect(/^[0-9a-f]{64}$/.test(result.code)).toBeTruthy();
  const remaining = Date.parse(result.expires_at) - Date.now();
  expect(remaining).toBeGreaterThan(14 * 60 * 1000);
  expect(remaining).toBeLessThanOrEqual(15 * 60 * 1000);
  const shown = page.getByRole("dialog", { name: /^Reset link for / });
  const link = (await shown
    .locator('code[aria-label="reset link"]')
    .textContent())!.trim();
  // The code travels in the fragment, so it never reaches a server log.
  expect(new URL(link).hash).toBe(`#/reset?code=${result.code}`);
  await shown.getByRole("button", { name: "Done", exact: true }).click();
  await expect(shown).not.toBeVisible();
  return link;
}

/** Open a reset link in a fresh page load, as its recipient would. */
async function openLink(page: Page, link: string) {
  await page.goto("about:blank");
  await page.goto(link);
}

async function setNewPassword(
  page: Page,
  next: string,
  expected = 200,
): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Reset your password", exact: true }),
  ).toBeVisible(afterPassword);
  await page.getByLabel("New password", { exact: true }).fill(next);
  await page.getByLabel("Confirm new password", { exact: true }).fill(next);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/password-reset") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Save new password", exact: true })
    .click();
  expect((await response).status()).toBe(expected);
  if (expected === 200) {
    await expect(
      page.getByRole("heading", { name: "Password updated", exact: true }),
    ).toBeVisible();
  } else {
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "invalid, expired or already used" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Reset your password", exact: true }),
    ).toBeVisible();
  }
  // A reset link proves control of the account; it never signs anyone in.
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
  test.setTimeout(240_000);
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
    ).toBeVisible({ timeout: 30_000 });
    await draft.locator('.react-flow__node[data-id="sample"]').click();
    const inspector = draft.locator(".editor-inspector");
    const rate = inspector.getByLabel("One in every", { exact: true });
    const unapplied = draft.locator(
      ".pipeline-save-status[data-save-state='unapplied']:visible",
    );
    let navigations = 0;
    draft.on("framenavigated", (frame) => {
      if (frame === draft.mainFrame()) navigations++;
    });
    const saveDraft = draft.getByRole("button", { name: "Save", exact: true });

    for (const [index, mode] of ["notification", "focus fallback"].entries()) {
      await rate.fill("-");
      await expect(unapplied).toContainText("Unapplied field changes");
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
        .getByLabel("Current password", { exact: true })
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
      await expect(dialog).not.toBeVisible(afterPassword);
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
      await expect(unapplied).toContainText("Unapplied field changes");
      expect(navigations, mode).toBe(0);
      const stored = await draft.request
        .get(`/api/v1/configurations/${document.id}`)
        .then((response) => response.json());
      expect(stored.config.transforms.sample.rate).toBe(10 + index);

      const attempts: number[] = [];
      const observe = (response: Response) => {
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
      await saveDraft.click();
      expect((await saved).status(), mode).toBe(200);
      await expect(
        draft.locator(".pipeline-save-status[data-save-state='saved']:visible"),
      ).toBeVisible();
      // One deliberate save reached the server once, with the rotated token.
      expect(attempts, mode).toEqual([200]);
      draft.off("response", observe);
      const applied = await draft.request
        .get(`/api/v1/configurations/${document.id}`)
        .then((response) => response.json());
      expect(applied.config.transforms.sample.rate).toBe(11 + index);
    }

    // A different account signing in through this browser must not silently
    // adopt another editor's pending work. The workspace stays as it was and a
    // dialog asks for the original account's password.
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
    const ended = draft.getByRole("dialog", {
      name: "Your session ended",
      exact: true,
    });
    await expect(ended).toBeVisible({ timeout: 10_000 });
    await expect(ended).toContainText(
      `This browser is now signed in as ${other.email} in another tab.`,
    );
    await expect(ended).toContainText(
      "Your unsaved work on this page is still here.",
    );
    await expect(rate).toHaveValue("13");

    // While the session belongs to someone else the editor keeps the typed
    // text but offers no Save, and nothing is sent, not even by the shortcut.
    await expect(draft.locator("button.editor-save-button")).toHaveCount(0);
    const sent: string[] = [];
    const observeAttempt = (request: Request) => {
      if (
        request.url().endsWith(`/configurations/${document.id}/draft`) &&
        request.method() === "PUT"
      )
        sent.push(request.url());
    };
    draft.on("request", observeAttempt);
    await draft.keyboard.press("Control+s");
    // Give any focus-triggered automatic work a turn to issue a mutation.
    await draft.waitForTimeout(500);
    expect(sent).toEqual([]);
    draft.off("request", observeAttempt);
    await expect(rate).toHaveValue("13");
    expect(navigations).toBe(0);
    const unchanged = await draft.request
      .get(`/api/v1/configurations/${document.id}`)
      .then((response) => response.json());
    expect(unchanged.config.transforms.sample.rate).toBe(12);

    // Signing in again as the original account resumes the same work: the
    // typed value survives, the tab never reloads, and a deliberate save now
    // reaches the server exactly once.
    await signInAgain(ended, account.password);
    expect((await session(draft.request)).user.id).toBe(
      (await session(owner.request)).user.id,
    );
    await expect(rate).toHaveValue("13");
    expect(navigations).toBe(0);
    const resumed: number[] = [];
    draft.on("response", (response) => {
      if (
        response.url().endsWith(`/configurations/${document.id}/draft`) &&
        response.request().method() === "PUT"
      )
        resumed.push(response.status());
    });
    const finalSave = draft.waitForResponse(
      (response) =>
        response.url().endsWith(`/configurations/${document.id}/draft`) &&
        response.request().method() === "PUT",
    );
    await saveDraft.click();
    expect((await finalSave).status()).toBe(200);
    await expect(
      draft.locator(".pipeline-save-status[data-save-state='saved']:visible"),
    ).toBeVisible();
    expect(resumed).toEqual([200]);
    const final = await draft.request
      .get(`/api/v1/configurations/${document.id}`)
      .then((response) => response.json());
    expect(final.config.transforms.sample.rate).toBe(13);
  } finally {
    await f.close();
  }
});

test("viewer password change and session revocation preserve the current browser and recover the victim tab", async ({
  page: seed,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const f = await fixture(seed.request, browser, baseURL!);
  try {
    const account = await f.account();
    const owner = await f.open(account);
    const victim = await f.open(account);
    await expect(
      owner.getByRole("heading", { name: "People & security", exact: true }),
    ).toBeVisible(afterPassword);
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
      .getByLabel("Current password", { exact: true })
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
    await expect(dialog).toContainText(
      "Your current password didn't match.",
      afterPassword,
    );
    // A wrong password is a rejection, not a session ending.
    await expect(
      owner.getByRole("dialog", { name: /^Your (session|password|access)/ }),
    ).toHaveCount(0);
    expect((await owner.request.get("/api/v1/session")).status()).toBe(200);
    await dialog
      .getByLabel("Current password", { exact: true })
      .fill(account.password);
    // The rejected request clears all secret inputs, including the proposed
    // password, so the retry must deliberately enter the same new value.
    await expect(
      dialog.getByLabel("New password", { exact: true }),
    ).toHaveValue("");
    await dialog.getByLabel("New password", { exact: true }).fill(next);
    await dialog.getByLabel("Confirm new password", { exact: true }).fill(next);
    await dialog
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(dialog).not.toBeVisible(afterPassword);
    await expect(
      notifications(owner).filter({ hasText: "Password changed." }),
    ).toBeVisible();
    expect((await owner.request.get("/api/v1/session")).status()).toBe(200);
    expect((await victim.request.get("/api/v1/session")).status()).toBe(401);

    // The other tab explains why, keeps the page, and recovers with the new
    // password only.
    const changed = await sessionEnded(victim, "Your password was changed");
    await expect(changed).toContainText(
      "Your unsaved work on this page is still here.",
    );
    await signInAgain(changed, account.password, 401);
    await signInAgain(changed, next);
    account.password = next;
    await expect(victim).toHaveURL(/#\/devices$/);
    expect((await victim.request.get("/api/v1/session")).status()).toBe(200);

    // The sessions list shows both browsers; signing one out needs no password.
    await owner.reload();
    const sessions = owner.getByRole("list", { name: "Your sessions" });
    await expect(
      sessions.getByText("This browser", { exact: true }),
    ).toBeVisible(afterPassword);
    const signOutOne = sessions.getByRole("button", { name: /^Sign out / });
    await expect(signOutOne).toHaveCount(1);
    await signOutOne.click();
    await expect(
      notifications(owner).filter({ hasText: /^Signed out / }),
    ).toBeVisible();
    expect((await owner.request.get("/api/v1/session")).status()).toBe(200);
    expect((await victim.request.get("/api/v1/session")).status()).toBe(401);
    await signInAgain(
      await sessionEnded(victim, "You were signed out from another browser"),
      account.password,
    );

    // Signing out every other session asks for the password and leaves this
    // browser signed in. The owner reads the list again to see the new session.
    await owner.reload();
    await owner
      .getByRole("button", { name: "Sign out other sessions", exact: true })
      .click();
    const revoke = owner.getByRole("dialog", {
      name: "Sign out other sessions",
      exact: true,
    });
    await revoke.getByLabel("Current password", { exact: true }).fill(next);
    await revoke
      .getByRole("button", { name: "Sign out other sessions", exact: true })
      .click();
    await expect(revoke).not.toBeVisible(afterPassword);
    await expect(
      notifications(owner).filter({
        hasText: "Signed out of every other browser.",
      }),
    ).toBeVisible();
    expect((await owner.request.get("/api/v1/session")).status()).toBe(200);
    expect((await victim.request.get("/api/v1/session")).status()).toBe(401);
    await signInAgain(
      await sessionEnded(victim, "You were signed out from another browser"),
      account.password,
    );
    expect((await victim.request.get("/api/v1/session")).status()).toBe(200);
  } finally {
    await f.close();
  }
});

test("administrator access changes use current revisions and public password reset links work once", async ({
  page: seed,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const f = await fixture(seed.request, browser, baseURL!);
  try {
    const target = await f.account();
    const victim = await f.open(target);
    const admin = f.administrator;
    await admin.reload();
    const row = await personRow(admin, target);
    await editAccess(row).click();
    const edit = admin.getByRole("dialog", {
      name: "Edit workspace access",
      exact: true,
    });
    await expect(edit).toBeVisible();

    // Hold the page's own refresh of the people list at what it showed when
    // the dialog opened, so the save below is the first to meet the new
    // revision. The hold ends when that save is sent.
    const before = await admin.request
      .get("/api/v1/users")
      .then((r) => r.json());
    let holding = true;
    await admin.route("**/api/v1/users", async (route) => {
      if (holding && route.request().method() === "GET")
        await route.fulfill({ json: before });
      else await route.continue();
    });
    admin.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        request.url().endsWith(`/users/${target.id}`)
      )
        holding = false;
    });

    // Another administrator's name edit must not be silently overwritten.
    const active = await session(admin.request);
    const current = before.find(
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
      .getByLabel("Name", { exact: true })
      .fill(`Renamed ${target.name}`);
    await edit
      .getByLabel("Your password", { exact: true })
      .fill(f.admin.password);
    const stale = admin.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        r.url().endsWith(`/users/${target.id}`),
    );
    await edit
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    // The server refuses the older revision, so the rename never applied.
    const refused = await stale;
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe("STALE_REVISION");
    await expect(edit.getByRole("alert")).toContainText(
      "Someone else changed this account just now.",
      afterPassword,
    );
    const stored = await admin.request
      .get("/api/v1/users")
      .then((r) => r.json());
    expect(
      stored.find((person: { id: string }) => person.id === target.id).name,
    ).toBe(`Updated ${target.name}`);
    // The dialog notices the newer revision and offers it; saving waits for it.
    await expect(edit).toContainText("account changed while you were editing.");
    await expect(
      edit.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeDisabled();
    await edit
      .getByRole("button", { name: "Load latest", exact: true })
      .click();
    await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(
      `Updated ${target.name}`,
    );
    const renamed = `Renamed ${target.name}`;
    await edit.getByLabel("Name", { exact: true }).fill(renamed);
    await chooseRole(edit, "Editor");
    await expect(edit).toContainText("Change the role from Viewer to Editor");
    await expect(edit).toContainText("out of every browser");
    await edit
      .getByLabel("Your password", { exact: true })
      .fill(f.admin.password);
    await edit
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(edit).not.toBeVisible(afterPassword);
    await expect(row).toContainText("Editor");
    await expect(row).toContainText(renamed);
    target.name = renamed;

    // The signed-in tab of the person whose access changed says so and
    // recovers with the same password.
    const changed = await sessionEnded(victim, "Your access changed");
    await signInAgain(changed, target.password);
    await victim.goto("/#/users");

    // Turning off sign-in ends their sessions and refuses their password.
    await editAccess(row).click();
    await edit.getByLabel("Sign-in", { exact: true }).selectOption("disabled");
    await expect(edit).toContainText("Turn off sign-in");
    await edit
      .getByLabel("Your password", { exact: true })
      .fill(f.admin.password);
    await edit
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(edit).not.toBeVisible(afterPassword);
    await expect(row.getByText("Disabled", { exact: true })).toBeVisible();
    // A disabled account has no link to hand out.
    await expect(moreActions(row)).toHaveCount(0);
    const disabled = await sessionEnded(victim, "Your access changed");
    await signInAgain(disabled, target.password, 401);

    // Turning it back on lets them in again.
    await editAccess(row).click();
    await edit.getByLabel("Sign-in", { exact: true }).selectOption("active");
    await edit
      .getByLabel("Your password", { exact: true })
      .fill(f.admin.password);
    await edit
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(edit).not.toBeVisible(afterPassword);
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await signInAgain(disabled, target.password);

    // A reset link changes nothing until its recipient uses it, once.
    const link = await issueResetLink(admin, f.admin, target);
    await victim.goto("/#/users");
    await expect(
      victim.getByRole("heading", { name: "People & security", exact: true }),
    ).toBeVisible(afterPassword);
    expect((await victim.request.get("/api/v1/session")).status()).toBe(200);
    const publicPage = await f.open();
    const next = password();
    await openLink(publicPage, link);
    await setNewPassword(publicPage, next);
    // Using it signs the person out everywhere.
    expect((await victim.request.get("/api/v1/session")).status()).toBe(401);
    await openLink(publicPage, link);
    await setNewPassword(publicPage, password(), 401);
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
  test.setTimeout(240_000);
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
    // The person's row says two-factor is on, and the reset says it stays on.
    const row = await personRow(f.administrator, target);
    await expect(row).toContainText("On");
    await moreActions(row).click();
    await expect(
      f.administrator.getByRole("menuitem", {
        name: "Reset two-factor",
        exact: true,
      }),
    ).toBeVisible();
    await f.administrator.keyboard.press("Escape");
    await moreActions(row).click();
    await f.administrator
      .getByRole("menuitem", { name: "Reset password", exact: true })
      .click();
    await expect(
      f.administrator.getByRole("dialog", { name: /^Reset .+'s password$/ }),
    ).toContainText("Two-factor stays on.");
    await f.administrator.keyboard.press("Escape");
    const link = await issueResetLink(f.administrator, f.admin, target);
    await openLink(publicPage, link);
    await accessibleMobile(publicPage);
    const next = password();
    await setNewPassword(publicPage, next);
    const invalidated = await publicPage.request.post("/api/v1/login/mfa", {
      data: {
        challenge_token: oldChallenge.challenge_token,
        recovery_code: recovery,
      },
    });
    expect(invalidated.status()).toBe(401);
    expect((await invalidated.json()).error.code).toBe("MFA_CHALLENGE_EXPIRED");
    await publicPage
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await login(publicPage, target, target.password, 401);
    await publicPage.getByLabel("Password", { exact: true }).fill(next);
    const challengeResponse = loginResponse(publicPage);
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
        name: "Two-factor authentication",
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
      .getByRole("button", { name: "Use a recovery code", exact: true })
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
      .getByRole("button", { name: "Verify", exact: true })
      .click();
    const verified = await verifiedResponse;
    expect(verified.status()).toBe(200);
    expect(Object.keys(verified.request().postDataJSON()).sort()).toEqual([
      "challenge_token",
      "recovery_code",
    ]);
    await expect(accountButton(publicPage)).toBeVisible();
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
