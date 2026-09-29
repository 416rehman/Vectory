import { describe, expect, it } from "vitest";
import {
  MfaConfirmSchema,
  MfaDisableSchema,
  MfaSetupSchema,
  MfaStatusSchema,
  mfaCanUseContext,
  mfaSameContext,
  mfaSetupUri,
  mfaStatusMeaning,
  type MfaContext,
} from "./mfaActionModel";

const secret = "JBSWY3DPEHPK3PXP";
const valid = {
  secret,
  otpauth_url: `otpauth://totp/Vectory%3Aadmin%40example.test?secret=${secret}&issuer=Vectory&algorithm=SHA1&digits=6&period=30`,
};
const codes = Array.from(
  { length: 8 },
  (_, index) =>
    `${index.toString(16).padStart(8, "0")}-00000001-00000002-00000003`,
);
const context: MfaContext = {
  userId: "actor-a",
  role: "admin",
  enabled: true,
  csrfToken: "original-csrf",
  csrfVersion: 3,
  epoch: 7,
  valid: true,
};

describe("MFA response and context model", () => {
  it("accepts only an exact enabled status and the intended fixed action receipts", () => {
    expect(MfaStatusSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(MfaStatusSchema.safeParse({ enabled: "true" }).success).toBe(false);
    expect(
      MfaStatusSchema.safeParse({ enabled: true, token: "extra" }).success,
    ).toBe(false);
    expect(
      MfaConfirmSchema.parse({ enabled: true, recovery_codes: codes }),
    ).toMatchObject({ enabled: true, recovery_codes: codes });
    expect(MfaDisableSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(
      MfaConfirmSchema.safeParse({ enabled: false, recovery_codes: codes })
        .success,
    ).toBe(false);
    expect(MfaDisableSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(
      MfaDisableSchema.safeParse({ enabled: false, recovery_codes: codes })
        .success,
    ).toBe(false);
  });

  it("requires eight distinct native-format recovery codes and no extra receipt fields", () => {
    for (const bad of [
      codes.slice(0, 7),
      [...codes, codes[0]],
      [codes[0], codes[0], ...codes.slice(2)],
      ["ABCDEFAB-00000001-00000002-00000003", ...codes.slice(1)],
      ["not-a-code", ...codes.slice(1)],
    ])
      expect(
        MfaConfirmSchema.safeParse({ enabled: true, recovery_codes: bad })
          .success,
      ).toBe(false);
    expect(
      MfaConfirmSchema.safeParse({
        enabled: true,
        recovery_codes: codes,
        secret,
      }).success,
    ).toBe(false);
  });

  it("accepts a matching bounded TOTP URI and returns its original spelling", () => {
    expect(MfaSetupSchema.safeParse(valid).success).toBe(true);
    expect(mfaSetupUri(valid)).toBe(valid.otpauth_url);
    const optionalDefaults = {
      secret,
      otpauth_url: `otpauth://totp/Vectory%3Aadmin?secret=${secret}`,
    };
    expect(MfaSetupSchema.safeParse(optionalDefaults).success).toBe(true);
  });

  it("rejects a foreign, mismatched, duplicate or unsafe authenticator URI", () => {
    const alternatives = [
      `https://example.test/?secret=${secret}`,
      `otpauth://evil/Vectory?secret=${secret}`,
      `otpauth://totp/Vectory?secret=DIFFERENTSECRET2`,
      `otpauth://totp/Vectory?secret=${secret}&secret=${secret}`,
      `otpauth://totp/Vectory?secret=${secret}&period=60`,
      `otpauth://totp/Vectory?secret=${secret}&period=`,
      `otpauth://totp/Vectory?secret=${secret}&algorithm=SHA256`,
      `otpauth://totp/Vectory?secret=${secret}&callback=https%3A%2F%2Fevil.test`,
      `otpauth://totp/Vectory?secret=${secret}#fragment`,
      `otpauth://user@totp/Vectory?secret=${secret}`,
      `otpauth://totp/?secret=${secret}`,
      ` otpauth://totp/Vectory?secret=${secret}`,
      `otpauth://totp/Vectory?secret=${secret}\n`,
    ];
    for (const otpauth_url of alternatives) {
      expect(mfaSetupUri({ secret, otpauth_url })).toBeNull();
      expect(MfaSetupSchema.safeParse({ secret, otpauth_url }).success).toBe(
        false,
      );
    }
    expect(
      MfaSetupSchema.safeParse({ ...valid, secret: "not-base32" }).success,
    ).toBe(false);
    expect(MfaSetupSchema.safeParse({ ...valid, extra: true }).success).toBe(
      false,
    );
  });

  it("describes a fresh status as current state without attributing a prior write", () => {
    for (const flow of ["setup", "confirm", "disable"] as const) {
      for (const enabled of [true, false]) {
        const message = mfaStatusMeaning(flow, enabled);
        expect(message).toContain(enabled ? "enabled now" : "not enabled now");
        expect(message).not.toMatch(
          /your request succeeded|your request failed/i,
        );
      }
    }
    expect(mfaStatusMeaning("confirm", true)).toContain("cannot be recovered");
    expect(mfaStatusMeaning("setup", false)).toContain("setup key is pending");
    expect(mfaStatusMeaning("setup", false)).toContain("can invalidate");
  });

  it("requires the original usable actor, role and session binding", () => {
    expect(mfaCanUseContext(context, { ...context })).toBe(true);
    expect(mfaSameContext(context, { ...context })).toBe(true);
    for (const changed of [
      { ...context, userId: "actor-b" },
      { ...context, role: "viewer" as const },
      { ...context, csrfToken: "new-csrf" },
      { ...context, csrfVersion: 4 },
      { ...context, epoch: 8 },
      { ...context, valid: false },
      { ...context, enabled: false },
    ]) {
      expect(mfaCanUseContext(context, changed)).toBe(false);
      expect(mfaSameContext(context, changed)).toBe(false);
    }
    expect(mfaSameContext(context, { ...context, valid: false })).toBe(false);
    const invalid = { ...context, valid: false };
    expect(mfaSameContext(invalid, { ...invalid })).toBe(true);
    expect(mfaCanUseContext(invalid, { ...invalid })).toBe(false);
    const benignMetadata = {
      ...context,
      name: "Updated display name",
      revision: 99,
    };
    expect(mfaCanUseContext(context, benignMetadata)).toBe(true);
    expect(
      mfaCanUseContext(
        { ...context, csrfToken: "" },
        { ...context, csrfToken: "" },
      ),
    ).toBe(false);
  });
});
