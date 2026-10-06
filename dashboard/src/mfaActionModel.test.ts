import { describe, expect, it } from "vitest";
import {
  MfaConfirmSchema,
  MfaDisableSchema,
  MfaRecoveryCodesSchema,
  MfaSetupSchema,
  MfaStatusSchema,
  groupRecoveryCode,
  groupSetupKey,
  mfaCanUseContext,
  mfaOutcome,
  mfaSameContext,
  mfaSetupUri,
  recoveryCodesText,
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
    expect(
      MfaStatusSchema.parse({ enabled: true, recovery_codes_remaining: 7 }),
    ).toEqual({ enabled: true, recovery_codes_remaining: 7 });
    expect(
      MfaStatusSchema.parse({ enabled: false, recovery_codes_remaining: null }),
    ).toEqual({ enabled: false, recovery_codes_remaining: null });
    for (const remaining of [-1, 9, 1.5, "7"])
      expect(
        MfaStatusSchema.safeParse({
          enabled: true,
          recovery_codes_remaining: remaining,
        }).success,
      ).toBe(false);
    expect(MfaStatusSchema.safeParse({ enabled: "true" }).success).toBe(false);
    expect(
      MfaStatusSchema.safeParse({ enabled: true, token: "extra" }).success,
    ).toBe(false);
    expect(
      MfaRecoveryCodesSchema.parse({ enabled: true, recovery_codes: codes }),
    ).toMatchObject({ recovery_codes: codes });
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
    expect(
      MfaSetupSchema.safeParse({ ...valid, expires_at: "2026-09-29T14:13:00Z" })
        .success,
    ).toBe(true);
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

  it("maps a fresh status read to what can be said, never to a resend", () => {
    expect(mfaOutcome("setup", false)).toBe("restart");
    expect(mfaOutcome("setup", true)).toBe("codes-lost");
    expect(mfaOutcome("confirm", true)).toBe("codes-lost");
    expect(mfaOutcome("confirm", false)).toBe("retry-code");
    expect(mfaOutcome("disable", false)).toBe("off");
    expect(mfaOutcome("disable", true)).toBe("still-on");
    // A full set of codes can't prove whether this request replaced them.
    expect(mfaOutcome("codes", true)).toBe("codes-unknown");
    expect(mfaOutcome("codes", false)).toBe("off");
  });

  it("groups setup keys and labels recovery-code files with their account", () => {
    expect(groupSetupKey("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(groupSetupKey("ABCDEF")).toBe("ABCD EF");
    const text = recoveryCodesText({
      codes: codes.slice(0, 2),
      email: "jane@example.test",
      workspace: "Acme Production (vectory.example.test)",
      generatedAt: new Date("2026-09-29T14:03:00Z"),
    });
    expect(text.split("\n")[0]).toBe(
      "Vectory recovery codes for jane@example.test on Acme Production (vectory.example.test), generated 2026-09-29.",
    );
    // Grouped in fours for typing from paper; sign-in ignores the spaces.
    expect(text).toContain(" 1. 0000 0000 0000 0001 0000 0002 0000 0003");
    expect(text).toContain(" 2. 0000 0001 0000 0001 0000 0002 0000 0003");
    expect(text).toContain("Each code works once.");
    expect(text).toContain("Type a code with or without its spaces.");
  });

  it("groups a recovery code in fours and leaves anything unexpected as it came", () => {
    expect(groupRecoveryCode("0f3a91c2-5b7d8e10-aa00bb11-cc22dd33")).toBe(
      "0f3a 91c2 5b7d 8e10 aa00 bb11 cc22 dd33",
    );
    expect(groupRecoveryCode("0F3A91C25B7D8E10AA00BB11CC22DD33")).toBe(
      "0F3A 91C2 5B7D 8E10 AA00 BB11 CC22 DD33",
    );
    expect(groupRecoveryCode("not-a-recovery-code")).toBe(
      "not-a-recovery-code",
    );
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
