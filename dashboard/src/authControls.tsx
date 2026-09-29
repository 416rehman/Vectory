import { useEffect, useId, useState, type ReactNode, type Ref } from "react";
import {
  AlertCircle,
  ArrowBigUp,
  CircleHelp,
  Copy,
  Eye,
  EyeOff,
} from "lucide-react";
import { CopyButton } from "./ui";
import { passwordStrength } from "./passwordStrength";
import "./auth.css";

export { CopyButton };

/** Label row, control, and either an inline error or a hint, wired for assistive tech. */
export function AuthField({
  label,
  labelAction,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  labelAction?: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: (ids: {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`auth-field ${className}`}>
      <div className="auth-field-label">
        <label htmlFor={id}>{label}</label>
        {labelAction}
      </div>
      {children({ id, describedBy: described, invalid: !!error })}
      {error ? (
        <p className="auth-field-error" id={`${id}-error`}>
          <AlertCircle size={14} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : (
        hint && (
          <p className="auth-field-hint" id={`${id}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Password entry with a reveal toggle and a Caps Lock hint. */
export function PasswordField({
  label,
  value,
  onChange,
  name,
  autoComplete,
  labelAction,
  hint,
  error,
  autoFocus,
  required = true,
  disabled,
  inputRef,
  identity,
  showStrength = false,
  onReveal,
  revealed: controlledReveal,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  name: string;
  /** "off" keeps password managers away from one-time secrets. */
  autoComplete: "current-password" | "new-password" | "off";
  labelAction?: ReactNode;
  hint?: ReactNode;
  error?: string;
  autoFocus?: boolean;
  required?: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** The account's own email and name, for the strength meter. */
  identity?: string[];
  showStrength?: boolean;
  /** Share one reveal state between a password and its confirmation. */
  revealed?: boolean;
  onReveal?: (revealed: boolean) => void;
  mono?: boolean;
}) {
  const [localReveal, setLocalReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const revealed = controlledReveal ?? localReveal;
  const setRevealed = onReveal ?? setLocalReveal;
  const caps = (event: React.KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(event.getModifierState?.("CapsLock") ?? false);
  return (
    <AuthField
      label={label}
      labelAction={labelAction}
      hint={hint}
      error={error}
    >
      {({ id, describedBy, invalid }) => (
        <>
          <div className="auth-input-wrap">
            <input
              ref={inputRef}
              id={id}
              name={name}
              type={revealed ? "text" : "password"}
              className={mono ? "auth-mono" : undefined}
              autoComplete={autoComplete}
              data-1p-ignore={autoComplete === "off" || undefined}
              data-lpignore={autoComplete === "off" || undefined}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required={required}
              disabled={disabled}
              autoFocus={autoFocus}
              value={value}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={caps}
              onKeyUp={caps}
              onBlur={() => setCapsLock(false)}
            />
            <button
              type="button"
              className="auth-reveal"
              aria-label={revealed ? "Hide password" : "Show password"}
              title={revealed ? "Hide password" : "Show password"}
              aria-pressed={revealed}
              aria-controls={id}
              disabled={disabled}
              onClick={() => setRevealed(!revealed)}
            >
              {revealed ? (
                <EyeOff size={17} aria-hidden="true" />
              ) : (
                <Eye size={17} aria-hidden="true" />
              )}
            </button>
          </div>
          {capsLock && (
            <p className="auth-caps" role="status">
              <ArrowBigUp size={14} aria-hidden="true" />
              Caps Lock is on
            </p>
          )}
          {showStrength && (
            <PasswordMeter password={value} identity={identity} />
          )}
        </>
      )}
    </AuthField>
  );
}

/** Four-segment strength meter with a one-line hint. Never announces keystrokes. */
export function PasswordMeter({
  password,
  identity = [],
}: {
  password: string;
  identity?: string[];
}) {
  if (!password) return null;
  const strength = passwordStrength(password, identity);
  return (
    <div className={`password-meter score-${strength.score}`}>
      <div className="password-meter-bars" aria-hidden="true">
        {[1, 2, 3, 4].map((segment) => (
          <span
            key={segment}
            className={segment <= strength.score ? "on" : ""}
          />
        ))}
      </div>
      <p>
        <strong>{strength.label}</strong>
        {strength.hint && <span> · {strength.hint}</span>}
      </p>
    </div>
  );
}

/**
 * A six-digit one-time code. Accepts pasted "123 456" or "123-456", ignores
 * other characters, and calls onComplete once the sixth digit arrives.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  label,
  disabled,
  autoFocus,
  inputRef,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (code: string) => void;
  label: string;
  disabled?: boolean;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  error?: string;
}) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const digits = value.replace(/\D/g, "").slice(0, 6);
  return (
    <div className="auth-field">
      <div className="auth-field-label">
        <label htmlFor={id}>{label}</label>
      </div>
      <div
        className={`otp ${focused ? "focused" : ""} ${error ? "invalid" : ""}`}
        data-disabled={disabled || undefined}
      >
        <input
          ref={inputRef}
          id={id}
          name="one-time-code"
          className="otp-native"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus={autoFocus}
          disabled={disabled}
          value={digits}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onFocus={(event) => {
            setFocused(true);
            event.target.select();
          }}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            const next = event.target.value.replace(/\D/g, "").slice(0, 6);
            onChange(next);
            if (next.length === 6 && digits.length < 6) onComplete?.(next);
          }}
          onPaste={(event) => {
            // A pasted code replaces what's there: "123 456" and "123-456" work.
            const pasted = event.clipboardData
              .getData("text")
              .replace(/\D/g, "")
              .slice(0, 6);
            if (!pasted) return;
            event.preventDefault();
            onChange(pasted);
            if (pasted.length === 6) onComplete?.(pasted);
          }}
        />
        <div className="otp-cells" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <span
              key={index}
              className={`otp-cell ${digits[index] ? "filled" : ""} ${
                focused &&
                index === Math.min(digits.length, 5) &&
                !(digits.length === 6)
                  ? "active"
                  : ""
              }`}
            >
              {digits[index] || ""}
            </span>
          ))}
        </div>
      </div>
      {error && (
        <p className="auth-field-error" id={`${id}-error`}>
          <AlertCircle size={14} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/** A command or secret-free value shown in monospace with a copy action. */
export function CopyLine({
  value,
  label,
  copyLabel = "Copy",
  wrap = false,
}: {
  value: string;
  label: string;
  copyLabel?: string;
  wrap?: boolean;
}) {
  return (
    <div className={`copy-line ${wrap ? "wrap" : ""}`}>
      <code aria-label={label}>{value}</code>
      <CopyButton text={value} label={copyLabel} />
    </div>
  );
}

/**
 * The one voice for outcomes the browser could not confirm. The primary
 * explanation stays short; identifiers live under Technical details.
 */
export function Unconfirmed({
  title = "We couldn't confirm that",
  children,
  actions,
  details,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
}) {
  return (
    <section className="unconfirmed" role="status">
      <CircleHelp size={19} aria-hidden="true" className="unconfirmed-icon" />
      <div>
        <h3>{title}</h3>
        <div className="unconfirmed-body">{children}</div>
        {actions && <div className="unconfirmed-actions">{actions}</div>}
        {details && (
          <details className="unconfirmed-details">
            <summary>Technical details</summary>
            <div>{details}</div>
          </details>
        )}
      </div>
    </section>
  );
}

/** Seconds until `until`, refreshed every second; null without a valid time. */
export function useCountdown(until: string | number | null | undefined) {
  const target =
    until === null || until === undefined
      ? NaN
      : typeof until === "number"
        ? until
        : Date.parse(until);
  const remaining = () =>
    Number.isFinite(target)
      ? Math.max(0, Math.ceil((target - Date.now()) / 1000))
      : null;
  const [seconds, setSeconds] = useState(remaining);
  useEffect(() => {
    setSeconds(remaining());
    if (!Number.isFinite(target)) return;
    const timer = setInterval(() => {
      const next = remaining();
      setSeconds(next);
      if (next === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [target]);
  return seconds;
}

/** "4:05" for a countdown. */
export function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "3:15 PM", "tomorrow at 3:15 PM" or "Oct 2 at 3:15 PM" for an expiry. */
export function formatExpiry(value: string, now = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const difference = Math.round((day(date) - day(now)) / 86400000);
  if (difference === 0) return time;
  if (difference === 1) return `tomorrow at ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

/** "in 23 h", "in 45 min", "expired". */
export function formatRemaining(
  value: string | null | undefined,
  now = Date.now(),
) {
  const target = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(target)) return "";
  const minutes = Math.round((target - now) / 60000);
  if (minutes <= 0) return "expired";
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.round(minutes / 60)} h`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date; "Never" when absent. */
