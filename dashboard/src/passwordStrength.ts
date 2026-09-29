// Password guidance for every new-password field. The floor mirrors the
// server's check (server/src/auth.rs check_new_password); the meter adds
// guidance above it. Nothing here is sent anywhere.

/** Frequently breached passwords that meet the length rule (same list as the server). */
const COMMON_PASSWORDS = new Set([
  "000000000000",
  "111111111111",
  "123123123123",
  "123456123456",
  "123456789012",
  "1234567890123",
  "12345678901234",
  "123456789123",
  "1234567891011",
  "123456789abc",
  "1q2w3e4r5t6y",
  "1qaz2wsx3edc",
  "abc123abc123",
  "abcd1234abcd",
  "admin1234567",
  "administrator",
  "asdfghjkl123",
  "baseball1234",
  "changeme1234",
  "changemenow!",
  "correcthorsebatterystaple",
  "dragon123456",
  "football1234",
  "iloveyou1234",
  "letmein12345",
  "master123456",
  "monkey123456",
  "mypassword123",
  "p@ssw0rd1234",
  "p@ssword1234",
  "passw0rd1234",
  "password1234",
  "password123!",
  "password12345",
  "passwordpassword",
  "princess1234",
  "qazwsxedcrfv",
  "qwerty123456",
  "qwertyuiop12",
  "qwertyuiop123",
  "qwertyuiopas",
  "secretpassword",
  "starwars1234",
  "sunshine1234",
  "superman1234",
  "trustno11234",
  "vectory12345",
  "vectory123456",
  "vectorypassword",
  "welcome12345",
  "welcome123456",
  "whatever1234",
  "zaq12wsxcde3",
  "zxcvbnm12345",
]);
const SEQUENCES = [
  "abcdefghijklmnopqrstuvwxyz",
  "01234567890123456789",
  "qwertyuiopasdfghjklzxcvbnm",
];
export const MIN_PASSWORD_LENGTH = 12;

const compact = (value: string) => value.toLowerCase().replace(/\s+/g, "");
const characters = (value: string) => Array.from(value);

function isRun(value: string) {
  const reversed = characters(value).reverse().join("");
  return SEQUENCES.some(
    (sequence) => sequence.includes(value) || sequence.includes(reversed),
  );
}
function isRepetition(value: string) {
  const chars = characters(value);
  return [1, 2, 3, 4].some(
    (unit) =>
      chars.length >= unit * 3 &&
      chars.every((character, index) => character === chars[index % unit]),
  );
}

/**
 * Why the server would refuse this new password, or null. `identity` holds the
 * account's own email and name.
 */
export function passwordIssue(
  password: string,
  identity: string[] = [],
): string | null {
  if (characters(password).length < MIN_PASSWORD_LENGTH)
    return "Use at least 12 characters. A short phrase of 3–4 words works well.";
  if (new TextEncoder().encode(password).length > 256)
    return "Use at most 256 characters.";
  const value = compact(password);
  if (COMMON_PASSWORDS.has(value) || isRun(value) || isRepetition(value))
    return "That password is easy to guess. Try a short phrase of 3–4 unrelated words.";
  const base = value.replace(/[^\p{L}]+$/u, "");
  const own = identity.some((part) => {
    const whole = compact(part);
    const local = whole.split("@")[0] || "";
    return (
      !!whole &&
      (value === whole ||
        base === whole ||
        (characters(local).length >= 4 && base === local))
    );
  });
  return own ? "Don't use your name or email address as your password." : null;
}

export type PasswordStrength = {
  /** 0 too short, 1 easy to guess, 2 fair, 3 good, 4 strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
  /** Meets the server's floor. */
  acceptable: boolean;
};

export function passwordStrength(
  password: string,
  identity: string[] = [],
): PasswordStrength {
  const issue = passwordIssue(password, identity);
  if (characters(password).length < MIN_PASSWORD_LENGTH)
    return {
      score: 0,
      label: "Too short",
      hint: "Use at least 12 characters.",
      acceptable: false,
    };
  if (issue)
    return {
      score: 1,
      label: "Easy to guess",
      hint: issue.startsWith("Don't")
        ? "Don't use your name or email."
        : "Try a short phrase of 3–4 unrelated words.",
      acceptable: false,
    };
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  const length = characters(password).length;
  let bits = length * Math.log2(Math.max(pool, 10));
  const distinct = new Set(characters(password.toLowerCase())).size;
  if (distinct / length < 0.5) bits *= 0.7;
  const words = password
    .split(/[\s\-_.,+]+/)
    .filter((word) => /\p{L}{3,}/u.test(word)).length;
  let score: 2 | 3 | 4 = bits < 60 ? 2 : bits < 80 ? 3 : 4;
  if (words >= 3 && length >= 16) score = Math.max(score, 3) as 3 | 4;
  if (words >= 4 && length >= 20) score = 4;
  return score === 2
    ? {
        score,
        label: "Fair",
        hint: "Add another word to make it stronger.",
        acceptable: true,
      }
    : score === 3
      ? { score, label: "Good", hint: "", acceptable: true }
      : { score, label: "Strong", hint: "", acceptable: true };
}

// Unambiguous characters for passwords people may read aloud or retype.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A random 23-character password in four readable groups (about 115 bits). */
export function generatePassword(
  random: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
) {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  let chosen = "";
  while (chosen.length < 20)
    for (const byte of random(new Uint8Array(32)))
      if (byte < limit && chosen.length < 20)
        chosen += ALPHABET[byte % ALPHABET.length];
  return chosen.match(/.{5}/g)!.join("-");
}
