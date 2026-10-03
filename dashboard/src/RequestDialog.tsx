import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button, ErrorBox, Modal } from "./ui";
import { PasswordField, Unconfirmed } from "./authControls";
import {
  describeFailure,
  unconfirmedText,
  type Failure,
} from "./agentUpdateRequests";

export type DialogState = {
  /** What the last attempt was refused for, when it was. */
  failure: Failure | null;
  /** A request is out: nothing in the form changes now. */
  busy: boolean;
};

/**
 * A change that needs a person's say-so: its fields, the administrator's
 * password when the server asks for it, one send. The password is sent once
 * and forgotten; a request that got no answer is never sent again by itself:
 * the dialog says it may have been applied and offers to read the current
 * state, which decides whether the change took.
 */
export default function RequestDialog({
  title,
  description,
  confirmLabel,
  tone = "primary",
  needsPassword = true,
  email,
  valid = true,
  run,
  check,
  what,
  onDone,
  onClose,
  returnFocusRef,
  size,
  children,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  tone?: "primary" | "danger";
  needsPassword?: boolean;
  /** The signed-in account, so a password manager files the password under it. */
  email?: string;
  /** Every field but the password is filled in. */
  valid?: boolean;
  /** Sends the request. Throws what the server refused, or the lack of an answer. */
  run(password: string): Promise<unknown>;
  /** After an unanswered request: whether the change shows in the state now. */
  check?(): Promise<boolean>;
  /** What was tried, for "We couldn't confirm that …". */
  what: string;
  onDone(): void;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  size?: "sm" | "md" | "lg" | "xl";
  children?: (state: DialogState) => ReactNode;
}) {
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<
    "form" | "sending" | "unconfirmed" | "checking"
  >("form");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [note, setNote] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const waiting = phase === "sending" || phase === "checking";
  const busy = phase !== "form";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (phase !== "form" || !valid || (needsPassword && !password)) return;
    const secret = password;
    // Sent once: a failed or unanswered attempt asks for it again.
    setPassword("");
    setPhase("sending");
    setFailure(null);
    setNote("");
    try {
      await run(secret);
      if (mounted.current) onDone();
    } catch (error) {
      if (!mounted.current) return;
      const found = describeFailure(error);
      setFailure(found);
      setPhase(found.definite ? "form" : "unconfirmed");
    }
  }
  async function checkNow() {
    if (!check || phase !== "unconfirmed") return;
    setPhase("checking");
    try {
      const applied = await check();
      if (!mounted.current) return;
      if (applied) {
        onDone();
        return;
      }
      setFailure(null);
      setNote("It wasn't applied, so nothing changed. You can try again.");
      setPhase("form");
    } catch {
      if (!mounted.current) return;
      setPhase("unconfirmed");
      setNote(
        "The current state couldn't be read either. Check your connection, then check again.",
      );
    }
  }
  const close = () => {
    if (waiting) return;
    setPassword("");
    onClose();
  };
  const passwordProblem =
    failure?.field === "password" ? failure.message : undefined;
  const generalProblem =
    failure && !failure.field && phase === "form" ? failure.message : "";

  return (
    <Modal
      open
      title={title}
      description={description}
      onClose={close}
      returnFocusRef={returnFocusRef}
      size={size}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="modal-body request-dialog">
          {phase === "unconfirmed" || phase === "checking" ? (
            <Unconfirmed>
              <p>{unconfirmedText(what)}</p>
              {note && <p>{note}</p>}
            </Unconfirmed>
          ) : (
            <fieldset disabled={busy} className="request-fields">
              {note && (
                <p className="signin-notice" role="status">
                  {note}
                </p>
              )}
              {generalProblem && <ErrorBox message={generalProblem} />}
              {children?.({ failure, busy })}
              {needsPassword && (
                <>
                  {email !== undefined && (
                    <input
                      type="text"
                      name="username"
                      autoComplete="username"
                      value={email}
                      readOnly
                      hidden
                    />
                  )}
                  <PasswordField
                    label="Your password"
                    name="current-password"
                    autoComplete="current-password"
                    value={password}
                    onChange={setPassword}
                    error={passwordProblem}
                    hint="Confirm it's you."
                  />
                </>
              )}
            </fieldset>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" disabled={waiting} onClick={close}>
            {phase === "unconfirmed" || phase === "checking"
              ? "Close"
              : "Cancel"}
          </Button>
          {phase === "unconfirmed" || phase === "checking" ? (
            check && (
              <Button
                busy={phase === "checking"}
                onClick={() => void checkNow()}
              >
                Check current state
              </Button>
            )
          ) : (
            <Button
              type="submit"
              variant={tone === "danger" ? "danger" : ""}
              busy={phase === "sending"}
              disabled={!valid || (needsPassword && !password)}
            >
              {confirmLabel}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
