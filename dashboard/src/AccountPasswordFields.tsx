import { Field } from "./ui";

export function CurrentPassword({
  value,
  onChange,
  autoFocus = false,
  hint = "Confirm it’s you before changing account access.",
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  hint?: string;
}) {
  return (
    <Field label="Your current password" hint={hint}>
      <input
        type="password"
        autoFocus={autoFocus}
        autoComplete="current-password"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function NewPassword({
  password,
  confirm,
  setPassword,
  setConfirm,
}: {
  password: string;
  confirm: string;
  setPassword: (v: string) => void;
  setConfirm: (v: string) => void;
}) {
  return (
    <>
      <Field label="New password" hint="At least 12 characters.">
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Confirm new password">
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
    </>
  );
}
