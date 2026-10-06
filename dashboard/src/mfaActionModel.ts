import { z } from "zod";
import {
  canUseAccountActionContext,
  sameAccountActionContext,
  type AccountActionContext,
} from "./accountActionSession";

export type MfaContext = AccountActionContext & {
  role: "viewer" | "editor" | "operator" | "admin";
};

export const MfaStatusSchema = z
  .object({
    enabled: z.boolean(),
    /** Unused recovery codes while two-factor is on; absent from older servers. */
    recovery_codes_remaining: z
      .number()
      .int()
      .min(0)
      .max(8)
      .nullable()
      .optional(),
  })
  .strict();
export type MfaStatus = z.infer<typeof MfaStatusSchema>;

const setupShape = z
  .object({
    secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
    otpauth_url: z.string().min(1).max(2048),
    /** When this pending setup stops accepting codes; absent from older servers. */
    expires_at: z.string().optional(),
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

/** `POST /mfa/recovery-codes` replaces every code and returns the new set. */
export const MfaRecoveryCodesSchema = MfaConfirmSchema;

export const MfaDisableSchema = z
  .object({ enabled: z.literal(false) })
  .strict();

export type MfaFlow = "setup" | "confirm" | "disable" | "codes";

/**
 * What a fresh `/mfa` read lets the page say after a request whose response
 * never arrived. The read describes current state only; it never proves which
 * request changed it, so nothing is resent automatically.
 * - `restart`: a setup key from a lost response can't be shown again.
 * - `codes-lost`: two-factor is on, but these recovery codes were never shown.
 * - `retry-code`: the pending setup can take the next code from the app.
 * - `off`: two-factor is off now, which is what the person asked for.
 * - `still-on`: two-factor is still on; turning it off needs a new request.
 * - `codes-unknown`: the old recovery codes may already be replaced.
 */
export type MfaOutcome =
  | "restart"
  | "codes-lost"
  | "retry-code"
  | "off"
  | "still-on"
  | "codes-unknown";
export function mfaOutcome(flow: MfaFlow, enabled: boolean): MfaOutcome {
  if (flow === "setup") return enabled ? "codes-lost" : "restart";
  if (flow === "confirm") return enabled ? "codes-lost" : "retry-code";
  if (flow === "disable") return enabled ? "still-on" : "off";
  return enabled ? "codes-unknown" : "off";
}

/** "ABCD EFGH IJKL …" so a setup key can be typed without losing place. */
export function groupSetupKey(secret: string) {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

/**
 * "0f3a 91c2 …": a recovery code in groups of four, to type from paper
 * without losing place. Sign-in ignores the spaces (and dashes), so the
 * grouped form works as typed; anything unexpected is shown as it came.
 */
export function groupRecoveryCode(code: string) {
  const plain = code.replace(/[\s-]/g, "");
  return /^[0-9a-f]{32}$/i.test(plain) ? plain.match(/.{4}/g)!.join(" ") : code;
}

/** The recovery-code file: what the codes are for, then one code per line. */
export function recoveryCodesText({
  codes,
  email,
  workspace,
  generatedAt,
}: {
  codes: string[];
  email: string;
  workspace: string;
  generatedAt: Date;
}) {
  const date = generatedAt.toISOString().slice(0, 10);
  return [
    `Vectory recovery codes for ${email} on ${workspace}, generated ${date}.`,
    "Each code works once. Generating new codes replaces all of these.",
    "Type a code with or without its spaces.",
    "",
    ...codes.map(
      (code, index) =>
        `${String(index + 1).padStart(2, " ")}. ${groupRecoveryCode(code)}`,
    ),
    "",
  ].join("\n");
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
