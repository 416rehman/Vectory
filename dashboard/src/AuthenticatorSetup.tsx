import { useEffect, useRef, useState } from "react";
import { Clock, RotateCcw, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button, Modal } from "./ui";
import { groupSetupKey, mfaSetupUri } from "./mfaActionModel";
import {
  CopyButton,
  OtpInput,
  formatCountdown,
  useCountdown,
} from "./authControls";
import "./authenticator-setup.css";

export type AuthenticatorEnrollment = {
  secret: string;
  otpauth_url: string;
  /** When the server stops accepting codes for this setup (10 minutes). */
  expires_at?: string;
};

/**
 * Connect an authenticator app: QR code (or deep link and grouped key on a
 * phone), a live expiry countdown, and a six-digit code that submits itself.
 */
export default function AuthenticatorSetup({
  setup,
  email,
  busy,
  open = true,
  error,
  failures,
  attempt,
  ended: serverEnded,
  onClose,
  onRestart,
  onConfirm,
}: {
  setup: AuthenticatorEnrollment;
  email: string;
  busy: boolean;
  open?: boolean;
  /** Why the last code wasn't accepted. */
  error: string;
  /** Wrong codes entered for this setup so far. */
  failures: number;
  /** Changes whenever the last code was used up, so the field clears. */
  attempt: number;
  /** The server stopped accepting codes for this setup. */
  ended: "expired" | "replaced" | null;
  onClose: () => void;
  onRestart: () => void;
  onConfirm: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  const uri = mfaSetupUri(setup);
  const remaining = useCountdown(setup.expires_at);
  const ended = serverEnded ?? (remaining === 0 ? "expired" : null);
  const usable = !!uri && !ended;
  // With a keyboard the code comes next; a phone needs the app first.
  const keyboard = !!window.matchMedia?.("(pointer: fine)").matches;

  // A used code is cleared so the next one can be typed straight away.
  useEffect(() => {
    if (!attempt) return;
    setCode("");
    requestAnimationFrame(() => codeInput.current?.focus());
  }, [attempt]);

  function submit(value = code) {
    if (usable && !busy && /^[0-9]{6}$/.test(value)) onConfirm(value);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect your authenticator app"
      description={
        usable
          ? "Scan the QR code with an app like 1Password, Google Authenticator or Authy, then enter the 6-digit code it shows."
          : "Start a new setup to get a fresh QR code."
      }
      className="authenticator-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        noValidate
      >
        <div className="modal-body authenticator-setup">
          {usable ? (
            <>
              <div className="authenticator-scan">
                <QRCodeSVG
                  value={uri!}
                  size={184}
                  level="M"
                  marginSize={3}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  role="img"
                  aria-label="Authenticator setup QR code"
                />
                <p className="authenticator-account">
                  Vectory <span aria-hidden="true">·</span> {email}
                </p>
              </div>
              <div className="authenticator-manual">
                <a
                  className="button secondary authenticator-app-link"
                  href={uri!}
                >
                  <Smartphone size={16} aria-hidden="true" />
                  Open authenticator app
                </a>
                <p className="authenticator-key-label">
                  Or enter this setup key:
                </p>
                <div className="authenticator-key-row">
                  <code translate="no">{groupSetupKey(setup.secret)}</code>
                  <CopyButton
                    text={setup.secret}
                    label="Copy key"
                    copiedLabel="Key copied"
                  />
                </div>
              </div>
              <div className="authenticator-confirm">
                <OtpInput
                  label="6-digit code from your app"
                  value={code}
                  onChange={setCode}
                  onComplete={(value) => submit(value)}
                  disabled={busy}
                  inputRef={codeInput}
                  error={error}
                  autoFocus={keyboard}
                />
                {failures >= 2 && (
                  <p className="authenticator-hint">
                    Codes change every 30 seconds. Check that your phone sets
                    its time automatically.
                  </p>
                )}
                {remaining !== null && (
                  <p
                    className={`authenticator-expiry ${remaining < 60 ? "soon" : ""}`}
                  >
                    <Clock size={13} aria-hidden="true" />
                    This QR code expires in{" "}
                    <span className="tabular">
                      {formatCountdown(remaining)}
                    </span>
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="authenticator-expired" role="status">
              <Clock size={20} aria-hidden="true" />
              <div>
                <strong>
                  {ended === "expired"
                    ? "This QR code expired"
                    : ended === "replaced"
                      ? "This setup was replaced"
                      : "This setup can't be shown"}
                </strong>
                <p>
                  {ended === "expired"
                    ? "A QR code works for 10 minutes. If you already added it to your app, remove that entry, then start again."
                    : ended === "replaced"
                      ? "Another window started a new setup or changed two-factor. Remove this entry from your app if you added it, then start again."
                      : "Start again to get a new QR code."}
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {usable && failures >= 3 && (
            <Button
              variant="ghost"
              icon={RotateCcw}
              className="authenticator-restart"
              disabled={busy}
              onClick={onRestart}
            >
              Start a new setup
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {busy ? "Stop waiting" : "Not now"}
          </Button>
          {usable ? (
            <Button
              type="submit"
              busy={busy}
              disabled={!/^[0-9]{6}$/.test(code)}
            >
              Turn on two-factor
            </Button>
          ) : (
            <Button disabled={busy} onClick={onRestart}>
              Start a new setup
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
