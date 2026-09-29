import { useRef, useState } from "react";
import { Check, Copy, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button, ErrorBox, Field, Modal } from "./ui";
import { mfaSetupUri } from "./mfaActionModel";
import "./authenticator-setup.css";

export type AuthenticatorEnrollment = {
  secret: string;
  otpauth_url: string;
};

export default function AuthenticatorSetup({
  setup,
  email,
  busy,
  open = true,
  error,
  expired,
  onClose,
  onRestart,
  onConfirm,
}: {
  setup: AuthenticatorEnrollment;
  email: string;
  busy: boolean;
  open?: boolean;
  error: string;
  expired: boolean;
  onClose: () => void;
  onRestart: () => void;
  onConfirm: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  const uri = mfaSetupUri(setup);
  const usable = !!uri && !expired;

  async function copyKey() {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
    } catch {
      keyInput.current?.focus();
      keyInput.current?.select();
      setCopyError("Copy wasn’t available. Select and copy the key above.");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect your authenticator"
      description={
        usable
          ? "Scan the QR code with your authenticator app, then enter its six-digit code."
          : "Start a new setup to connect your authenticator."
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (usable && !busy && /^[0-9]{6}$/.test(code)) {
            onConfirm(code);
            setCode("");
          }
        }}
      >
        <div className="modal-body authenticator-setup">
          {usable ? (
            <>
              <div className="authenticator-scan">
                <QRCodeSVG
                  value={uri!}
                  size={208}
                  level="M"
                  marginSize={4}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  role="img"
                  aria-label="Authenticator setup QR code"
                />
                <p>
                  Vectory <span aria-hidden="true">·</span> {email}
                </p>
                <a className="authenticator-app-link" href={uri!}>
                  <Smartphone size={15} aria-hidden="true" />
                  Open authenticator app
                </a>
                <span className="authenticator-app-hint">
                  For an app installed on this device
                </span>
              </div>
              <details className="authenticator-manual">
                <summary>Can’t scan the code?</summary>
                <p>
                  Add a time-based account in your app using this setup key.
                </p>
                <Field label="Setup key">
                  <input
                    ref={keyInput}
                    className="authenticator-key"
                    readOnly
                    value={setup.secret}
                    spellCheck={false}
                    onFocus={(event) => event.target.select()}
                  />
                </Field>
                <Button
                  variant="secondary compact"
                  icon={copied ? Check : Copy}
                  onClick={() => void copyKey()}
                >
                  {copied ? "Key copied" : "Copy setup key"}
                </Button>
                <span className="sr-only" role="status">
                  {copied ? "Setup key copied." : ""}
                </span>
                {copyError && (
                  <p className="authenticator-copy-error" role="status">
                    {copyError}
                  </p>
                )}
              </details>
              <div className="authenticator-confirm">
                <Field
                  label="Authenticator code"
                  hint="Enter the 6-digit code shown in your app."
                >
                  <input
                    className="authenticator-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    required
                    value={code}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    onPaste={(event) => {
                      event.preventDefault();
                      setCode(
                        event.clipboardData
                          .getData("text")
                          .replace(/\D/g, "")
                          .slice(0, 6),
                      );
                    }}
                    maxLength={6}
                    disabled={busy}
                  />
                </Field>
                {error && (
                  <>
                    <ErrorBox message={error} />
                    <Button variant="ghost compact" onClick={onRestart}>
                      Start a new setup
                    </Button>
                  </>
                )}
              </div>
            </>
          ) : (
            <ErrorBox
              message={
                expired
                  ? "This setup has expired. Start again to get a new QR code."
                  : "The setup details could not be read. Start again to get a new QR code."
              }
            />
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>
            {busy ? "Stop waiting" : "Hide setup"}
          </Button>
          {usable ? (
            <Button
              busy={busy}
              disabled={!/^[0-9]{6}$/.test(code)}
              type="submit"
            >
              Enable two-factor authentication
            </Button>
          ) : (
            <Button disabled={busy} onClick={onRestart}>
              Start again
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
