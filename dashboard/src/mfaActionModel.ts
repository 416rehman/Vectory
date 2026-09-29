import { z } from "zod";
import {
  canUseAccountActionContext,
  sameAccountActionContext,
  type AccountActionContext,
} from "./accountActionSession";

export type MfaContext = AccountActionContext & {
  role: "viewer" | "editor" | "operator" | "admin";
};

export const MfaStatusSchema = z.object({ enabled: z.boolean() }).strict();

const setupShape = z
  .object({
    secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
    otpauth_url: z.string().min(1).max(2048),
  })
  .strict();

type MfaSetup = z.infer<typeof setupShape>;

/** A one-time setup key may be handed only to its matching TOTP app URI. */
export function mfaSetupUri(setup: MfaSetup): string | null {
  try {
    if (!setupShape.safeParse(setup).success) return null;
    if (
      setup.otpauth_url !== setup.otpauth_url.trim() ||
      /[\u0000-\u001f\u007f]/.test(setup.otpauth_url)
    )
      return null;
    const url = new URL(setup.otpauth_url);
    if (
      url.protocol !== "otpauth:" ||
      url.hostname !== "totp" ||
      !url.pathname.startsWith("/") ||
      url.pathname.length <= 1 ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;
    const allowed = new Set([
      "secret",
      "issuer",
      "algorithm",
      "digits",
      "period",
    ]);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
        return null;
    }
    if (
      url.searchParams.get("secret") !== setup.secret ||
      (url.searchParams.has("digits") &&
        url.searchParams.get("digits") !== "6") ||
      (url.searchParams.has("period") &&
        url.searchParams.get("period") !== "30") ||
      (url.searchParams.has("algorithm") &&
        url.searchParams.get("algorithm")?.toUpperCase() !== "SHA1")
    )
      return null;
    return setup.otpauth_url;
  } catch {
    return null;
  }
}

export const MfaSetupSchema = setupShape.refine(
  (setup) => mfaSetupUri(setup) !== null,
  "The authenticator setup response is not usable.",
);

const recoveryCode = z.string().regex(/^(?:[0-9a-f]{8}-){3}[0-9a-f]{8}$/);
export const MfaConfirmSchema = z
  .object({
    enabled: z.literal(true),
    recovery_codes: z.array(recoveryCode).length(8),
  })
  .strict()
  .refine(
    ({ recovery_codes }) => new Set(recovery_codes).size === 8,
    "Recovery codes must be distinct.",
  );

export const MfaDisableSchema = z
  .object({ enabled: z.literal(false) })
  .strict();

export type MfaFlow = "setup" | "confirm" | "disable";

/** /mfa describes current state, never which earlier request committed. */
export function mfaStatusMeaning(flow: MfaFlow, enabled: boolean): string {
  if (flow === "setup")
    return enabled
      ? "An authenticator is enabled now. This does not identify which setup enabled it."
      : "An authenticator is not enabled now. This does not reveal whether a setup key is pending. A new setup can invalidate an earlier QR code.";
  if (flow === "confirm")
    return enabled
      ? "An authenticator is enabled now. Recovery codes from an unread response cannot be recovered. If you did not save them, use a working authenticator to disable and set up again."
      : "An authenticator is not enabled now. This does not prove the earlier confirmation failed or cannot still finish.";
  return enabled
    ? "An authenticator is enabled now. This does not prove the earlier disable request failed or cannot still finish."
    : "An authenticator is not enabled now. This does not identify which request disabled it.";
}

export function mfaSameContext(original: MfaContext, current: MfaContext) {
  return (
    original.role === current.role &&
    sameAccountActionContext(original, current)
  );
}

export function mfaCanUseContext(original: MfaContext, current: MfaContext) {
  return (
    original.role === current.role &&
    canUseAccountActionContext(original, current)
  );
}
