import { test, expect, request, type Locator } from "@playwright/test";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import jsQR from "jsqr";
test.use({ trace: "off", screenshot: "off", video: "off" });
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});
function totp(secret: string, stepOffset = 0) {
  let bits = "";
  for (const c of secret)
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(c)
      .toString(2)
      .padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((s) => parseInt(s, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + stepOffset));
  const h = crypto.createHmac("sha1", key).update(counter).digest(),
    offset = h.at(-1)! & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
// Decode locally in memory; never attach QR pixels or secret-bearing assertions.
async function decodeAuthenticatorQR(qr: Locator): Promise<string | undefined> {
  const raster = await qr.evaluate(async (element) => {
    let image: CanvasImageSource;
    let dimension = 512;
    if (element instanceof SVGSVGElement) {
      dimension = Math.max(
        256,
        Math.min(2048, Math.ceil(element.viewBox.baseVal.width || 64) * 8),
      );
      const bitmap = new Image();
      bitmap.src =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(new XMLSerializer().serializeToString(element));
      await bitmap.decode();
      image = bitmap;
    } else if (element instanceof HTMLImageElement) {
      await element.decode();
      image = element;
    } else {
      throw new Error("Authenticator QR must be an SVG or image");
    }
    const canvas = document.createElement("canvas");
    canvas.width = dimension;
    canvas.height = dimension;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("QR verification canvas unavailable");
    context.fillStyle = "white";
    context.fillRect(0, 0, dimension, dimension);
    context.drawImage(image, 0, 0, dimension, dimension);
    return {
      dimension,
      pixels: Array.from(context.getImageData(0, 0, dimension, dimension).data),
    };
  });
  return jsQR(
    new Uint8ClampedArray(raster.pixels),
    raster.dimension,
    raster.dimension,
  )?.data;
}

test("MFA setup, staged authenticator verification and one-use recovery login through real UI", async ({
  page,
  baseURL,
}) => {
  const admin = await page.request.get("/api/v1/session").then((r) => r.json());
  const cleanupCredential = JSON.parse(
    await readFile(
      path.resolve(
        import.meta.dirname,
        "../../.local/preview/credentials.json",
      ),
      "utf8",
    ),
  );
  expect(
    typeof cleanupCredential.password === "string" &&
      cleanupCredential.password.length > 0,
  ).toBe(true);
  expect(cleanupCredential.email === admin.user.email).toBe(true);
  const administrator = await request.newContext({
    baseURL,
    storageState: await page.context().storageState(),
  });
  const unique = Date.now().toString(36),
    account = {
      name: "MFA browser verification",
      email: `mfa-${unique}@vectory.local`,
      password: crypto.randomBytes(24).toString("base64url"),
      role: "viewer",
    };
  let syntheticId: string | undefined;
  try {
    const created = await administrator.post("/api/v1/users", {
      headers: { "X-CSRF-Token": admin.csrf_token },
      data: account,
    });
    expect(created.status()).toBe(200);
    syntheticId = (await created.json()).id;
    expect(typeof syntheticId === "string").toBe(true);
    await page.context().clearCookies();
    expect(
      (await page.request.post("/api/v1/login", { data: account })).ok(),
    ).toBeTruthy();
    await page.goto("/#/users");
    await page.getByRole("button", { name: "Set up authenticator" }).click();
    await page.getByLabel("Current password").fill(account.password);
    const setupResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/mfa/setup") &&
        response.request().method() === "POST",
    );
    const externalSetupRequests: string[] = [];
    const applicationOrigin = new URL(page.url()).origin;
    const watchRequest = (outgoing: import("@playwright/test").Request) => {
      if (
        /^https?:/.test(outgoing.url()) &&
        new URL(outgoing.url()).origin !== applicationOrigin
      )
        externalSetupRequests.push("external request");
    };
    page.on("request", watchRequest);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const setupResult = await setupResponse;
    expect(setupResult.status()).toBe(200);
    expect(setupResult.headers()["cache-control"]).toBe("no-store");
    const setupCredentials = await setupResult.json();
    const setup = page.getByRole("dialog");
    await expect(
      setup.getByText("Connect your authenticator", { exact: true }),
    ).toBeVisible();
    const qr = setup.getByRole("img", {
      name: "Authenticator setup QR code",
      exact: true,
    });
    await expect(qr).toBeVisible();
    const decoded = await decodeAuthenticatorQR(qr);
    expect(
      typeof decoded === "string" && decoded === setupCredentials.otpauth_url,
    ).toBe(true);
    const authenticatorURI = new URL(setupCredentials.otpauth_url);
    expect(authenticatorURI.protocol).toBe("otpauth:");
    expect(authenticatorURI.hostname).toBe("totp");
    expect(authenticatorURI.searchParams.get("issuer")).toBe("Vectory");
    expect(
      authenticatorURI.searchParams.get("secret") === setupCredentials.secret,
    ).toBe(true);
    const appLink = setup.locator('a[href^="otpauth:"]');
    await expect(appLink).toBeVisible();
    expect(
      (await appLink.getAttribute("href")) === setupCredentials.otpauth_url,
    ).toBe(true);
    await setup.locator(".authenticator-manual summary").click();
    const keyField = setup.getByLabel("Setup key", { exact: true });
    await expect(keyField).toBeVisible();
    const secret = await keyField.inputValue();
    expect(
      secret === setupCredentials.secret && /^[A-Z2-7]{32}$/.test(secret),
    ).toBe(true);
    expect(externalSetupRequests.length).toBe(0);
    page.off("request", watchRequest);
    await setup.getByLabel("Authenticator code").fill(totp(secret));
    await setup
      .getByRole("button", {
        name: "Enable two-factor authentication",
        exact: true,
      })
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
    await expect(
      page.getByLabel("Authenticator code", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Recovery code", { exact: true })).toHaveCount(
      0,
    );
    await page.getByLabel("Email address").fill(account.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill("definitely-incorrect");
    const rejectedPassword = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/login") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect((await rejectedPassword).status()).toBe(401);
    await expect(
      page.getByRole("heading", { name: "Verify your identity", exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get("/api/v1/session")).status()).toBe(401);

    async function startVerification() {
      await page.getByLabel("Password", { exact: true }).fill(account.password);
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/v1/login") && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const first = await response;
      expect(first.status()).toBe(200);
      const challenge = await first.json();
      expect(challenge.mfa_required).toBe(true);
      expect(/^[0-9a-f]{64}$/.test(challenge.challenge_token)).toBe(true);
      expect(challenge).not.toHaveProperty("user");
      expect(challenge).not.toHaveProperty("csrf_token");
      expect(first.headers()["set-cookie"]).toBeUndefined();
      await expect(
        page.getByRole("heading", {
          name: "Verify your identity",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Authenticator code", { exact: true }),
      ).toBeFocused();
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
      expect((await page.request.get("/api/v1/session")).status()).toBe(401);
      expect((await page.request.get("/api/v1/devices")).status()).toBe(401);
      return challenge.challenge_token as string;
    }
    const abandoned = await startVerification();
    await page.getByLabel("Authenticator code", { exact: true }).fill("123456");
    await page
      .getByRole("button", { name: "Back to sign in", exact: true })
      .click();
    await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
      account.email,
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await expect(
      page.getByLabel("Authenticator code", { exact: true }),
    ).toHaveCount(0);
    const challenge = await startVerification();
    expect(challenge === abandoned).toBe(false);
    const stale = await page.request.post("/api/v1/login/mfa", {
      data: { challenge_token: abandoned, recovery_code: recovery },
    });
    expect(stale.status()).toBe(401);
    expect((await stale.json()).error.code).toBe("MFA_CHALLENGE_EXPIRED");

    // Confirmation consumed the current TOTP counter. The supported next window
    // provides an independent authenticator code without sleeping across a boundary.
    await page
      .getByLabel("Authenticator code", { exact: true })
      .fill(totp(secret!, 1));
    const verified = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/login/mfa") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
    const verifiedResponse = await verified;
    expect(verifiedResponse.status()).toBe(200);
    expect(
      Object.keys(verifiedResponse.request().postDataJSON()).sort(),
    ).toEqual(["challenge_token", "totp_code"]);
    await expect(
      page.getByRole("heading", { name: "People & security", exact: true }),
    ).toBeVisible();
    const signedIn = await page.request
      .get("/api/v1/session")
      .then((r) => r.json());
    await page.request.post("/api/v1/logout", {
      headers: { "X-CSRF-Token": signedIn.csrf_token },
    });
    await page.reload();
    await page.getByLabel("Email address").fill(account.email);
    const recoveryChallenge = await startVerification();
    await page
      .getByRole("button", { name: "Use a recovery code instead" })
      .click();
    await expect(
      page.getByLabel("Recovery code", { exact: true }),
    ).toBeFocused();
    await expect(page.getByLabel("Recovery code", { exact: true })).toHaveValue(
      "",
    );
    await page
      .getByLabel("Recovery code", { exact: true })
      .fill("not-a-recovery-code");
    const rejectedFactor = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/login/mfa") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
    const invalid = await rejectedFactor;
    expect(invalid.status()).toBe(401);
    expect((await invalid.json()).error.code).toBe("INVALID_MFA_CODE");
    await expect(
      page.getByRole("heading", { name: "Verify your identity", exact: true }),
    ).toBeVisible();
    expect((await page.request.get("/api/v1/session")).status()).toBe(401);
    await page.getByLabel("Recovery code", { exact: true }).fill(recovery);
    const recoveryVerified = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/login/mfa") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
    const recoveryResponse = await recoveryVerified;
    expect(recoveryResponse.status()).toBe(200);
    expect(
      Object.keys(recoveryResponse.request().postDataJSON()).sort(),
    ).toEqual(["challenge_token", "recovery_code"]);
    expect(
      recoveryResponse.request().postDataJSON().challenge_token ===
        recoveryChallenge,
    ).toBe(true);
    await expect(
      page.getByRole("heading", { name: "People & security", exact: true }),
    ).toBeVisible();
    const freshSession = await page.request
      .get("/api/v1/session")
      .then((r) => r.json());
    await page.request.post("/api/v1/logout", {
      headers: { "X-CSRF-Token": freshSession.csrf_token },
    });
    const nextChallenge = await page.request
      .post("/api/v1/login", {
        data: { email: account.email, password: account.password },
      })
      .then((r) => r.json());
    const reused = await page.request.post("/api/v1/login/mfa", {
      data: {
        challenge_token: nextChallenge.challenge_token,
        recovery_code: recovery,
      },
    });
    expect(reused.status()).toBe(401);
    expect((await reused.json()).error.code).toBe("INVALID_MFA_CODE");
    expect((await page.request.get("/api/v1/session")).status()).toBe(401);
  } finally {
    try {
      if (syntheticId) {
        const active = await administrator.get("/api/v1/session");
        expect(active.status(), "Fixture cleanup administrator session").toBe(
          200,
        );
        const activeSession = await active.json();
        const peopleResponse = await administrator.get("/api/v1/users");
        expect(peopleResponse.status()).toBe(200);
        const people = await peopleResponse.json();
        const current = people.find(
          (person: { id: string }) => person.id === syntheticId,
        );
        // Match both server-returned UUID and fresh fixture email, never a name.
        expect(
          !!current &&
            current.email === account.email &&
            current.id !== admin.user.id,
        ).toBe(true);
        if (current.enabled) {
          const disabled = await administrator.put(
            `/api/v1/users/${syntheticId}`,
            {
              headers: { "X-CSRF-Token": activeSession.csrf_token },
              data: {
                name: current.name,
                role: current.role,
                enabled: false,
                revision: current.revision,
                current_password: cleanupCredential.password,
              },
            },
          );
          expect(
            disabled.status(),
            "Disable only the new synthetic MFA account",
          ).toBe(200);
        }
      }
    } finally {
      // A failed test must not leave enrollment/recovery content available for
      // Playwright's automatic failure-context snapshot after teardown.
      await page.goto("about:blank").catch(() => {});
      await administrator.dispose();
    }
  }
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
  await page.getByText("Sync, recovery and access", { exact: true }).click();
  await page.getByText("Device recovery", { exact: true }).click();
  await page
    .getByRole("button", { name: "Authorize device recovery", exact: true })
    .click();
  const tokenResponse = page.waitForResponse(
    (r) => r.url().endsWith("/recover") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Create recovery token", exact: true })
    .click();
  const token = await (await tokenResponse).json();
  await expect(
    page.getByRole("heading", { name: "Save the recovery token" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "I've saved the token" }).click();
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
      .getByRole("textbox", { name: "Search schedules" })
      .fill(request.name);
    await page.getByRole("link", { name: request.name, exact: true }).click();
    await page.getByText("Update scheduled devices", { exact: true }).click();
    await page
      .getByRole("button", { name: "Review scheduled devices" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Update scheduled devices" }),
    ).toBeVisible();
    const refreshRequest = page.waitForRequest(
      (r) =>
        r.url().endsWith(`/deployments/${deployment.id}/refresh`) &&
        r.method() === "POST",
    );
    await page
      .getByRole("button", { name: "Update scheduled devices", exact: true })
      .click();
    expect((await refreshRequest).postDataJSON().expected_device_ids).toEqual([
      device.id,
    ]);
    await expect(
      page.getByRole("heading", { name: "Update scheduled devices" }),
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
    .getByRole("textbox", { name: "Search deployments" })
    .fill(assignment.name);
  await page.getByRole("link", { name: assignment.name, exact: true }).click();
  await page.getByText("Remove this assignment", { exact: true }).click();
  await page.getByRole("button", { name: "Review assignment removal" }).click();
  await expect(
    page.getByRole("heading", { name: "Remove assignment", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove assignment", exact: true })
    .click();
  await expect
    .poll(async () =>
      page.request
        .get(`/api/v1/deployments/${assignment.id}`)
        .then((r) => r.json())
        .then((d) => d.status),
    )
    .toBe("unassigned");
});
