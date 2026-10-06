import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { Download, KeyRound, Printer, ShieldCheck } from "lucide-react";
import { z } from "zod";
import { APIError, api, download, withRequestDeadline, type User } from "./api";
import { isUncertainOutcome, retryDelay } from "./authRequests";
import {
  MfaConfirmSchema,
  MfaDisableSchema,
  MfaRecoveryCodesSchema,
  MfaSetupSchema,
  MfaStatusSchema,
  groupRecoveryCode,
  mfaOutcome,
  recoveryCodesText,
  type MfaFlow,
  type MfaStatus,
} from "./mfaActionModel";
import AuthenticatorSetup, {
  type AuthenticatorEnrollment,
} from "./AuthenticatorSetup";
import {
  useAccountAuthority,
  useLeaveGuard,
  type AccountContext,
} from "./accountAuthority";
import {
  AuthField,
  CopyButton,
  OtpInput,
  PasswordField,
  Unconfirmed,
} from "./authControls";
import { Button, Modal, Spinner } from "./ui";
import "./account.css";
import type { Notify } from "./toast";

type Flow = "setup" | "disable" | "codes";
type Fields = Partial<Record<"password" | "code" | "form", string>>;
type Sending = {
  flow: MfaFlow;
  context: AccountContext;
  controller: AbortController;
};
type Outcome = {
  flow: MfaFlow;
  context: AccountContext;
  kind: "checking" | "unconfirmed" | "restart" | "codes-lost" | "still-on";
};
type Codes = {
  list: string[];
  generatedAt: Date;
  owner: AccountContext;
  /** Codes from finishing setup, or a replacement set. */
  source: "setup" | "codes";
};
type Enrollment = { setup: AuthenticatorEnrollment; owner: AccountContext };

export type MfaActionsHandle = { setup: () => void };
export type MfaResource = {
  data: MfaStatus;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
};

const titles: Record<Flow, string> = {
  setup: "Set up two-factor authentication",
  disable: "Turn off two-factor authentication",
  codes: "Generate new recovery codes",
};
const descriptions: Record<Flow, string> = {
  setup:
    "Confirm your password to start. You'll need an authenticator app on your phone.",
  disable:
    "Your password alone will protect your account, and your other browsers are signed out.",
  codes: "Your current recovery codes stop working as soon as new ones exist.",
};

/**
 * The two-factor row of Your account, with setup, recovery codes and turning
 * it off. Setup keys and recovery codes exist only in this page's memory: a
 * lost response is never replayed, and a changed sign-in hides them.
 */
export default function MfaActions({
  ref,
  user,
  status,
  notify,
}: {
  ref?: Ref<MfaActionsHandle>;
  user: User;
  status: MfaResource;
  notify: Notify;
}) {
  const [form, setForm] = useState<{ flow: Flow; fields: Fields } | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState<MfaFlow | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanFailures, setScanFailures] = useState(0);
  const [scanAttempt, setScanAttempt] = useState(0);
  const [scanEnded, setScanEnded] = useState<"expired" | "replaced" | null>(
    null,
  );
  const [codes, setCodes] = useState<Codes | null>(null);
  const [codesOpen, setCodesOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const sending = useRef<Sending | null>(null);
  const reading = useRef(0);
  const mounted = useRef(true);
  const opener = useRef<HTMLButtonElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const enrollmentRef = useRef(enrollment);
  enrollmentRef.current = enrollment;
  const codesRef = useRef(codes);
  codesRef.current = codes;
  const authority = useAccountAuthority(user, () => {
    // Secrets and pending results belong to the sign-in that asked for them.
    const hadSecrets = !!(enrollmentRef.current || codesRef.current);
    const request = sending.current;
    sending.current = null;
    request?.controller.abort();
    ++reading.current;
    setBusy(null);
    setForm(null);
    clearEntry();
    setEnrollment(null);
    setScanOpen(false);
    setCodes(null);
    setCodesOpen(false);
    setOutcome(null);
    setOutcomeOpen(false);
    if (hadSecrets)
      setNotice("Two-factor details were hidden because your sign-in changed.");
  });

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sending.current?.controller.abort();
      sending.current = null;
      ++reading.current;
    };
  }, []);
  useLeaveGuard(
    codes
      ? "Leave without saving your new recovery codes? You can generate new ones later."
      : enrollment
        ? "Leave two-factor setup? The QR code you scanned stops working."
        : null,
  );
  useImperativeHandle(ref, () => ({ setup: startSetup }));
  // After a rejection, continue where typing has to start again.
  useEffect(() => {
    const fields = form?.fields;
    if (!fields || busy || (!fields.password && !fields.code)) return;
    requestAnimationFrame(() =>
      (fields.password || !passwordInput.current?.value
        ? passwordInput.current
        : codeInput.current
      )?.focus(),
    );
  }, [form, busy]);

  function clearEntry() {
    setPassword("");
    setCode("");
  }
  function closeForm() {
    if (sending.current) stopWaiting();
    else {
      setForm(null);
      clearEntry();
    }
  }
  function openForm(flow: Flow) {
    if (sending.current) return;
    setNotice("");
    clearEntry();
    setUseRecovery(false);
    setOutcome(null);
    setOutcomeOpen(false);
    setForm({ flow, fields: {} });
  }
  function startSetup() {
    const held = enrollmentRef.current;
    if (held && authority.usable(held.owner)) {
      setScanOpen(true);
      return;
    }
    if (status.data.enabled) return;
    openForm("setup");
  }
  function owns(request: Sending) {
    return (
      mounted.current &&
      sending.current === request &&
      !request.controller.signal.aborted &&
      authority.usable(request.context)
    );
  }
  function begin(flow: MfaFlow, context: AccountContext): Sending {
    const request = { flow, context, controller: new AbortController() };
    sending.current = request;
    setBusy(flow);
    return request;
  }
  function finish(request: Sending) {
    if (sending.current !== request) return;
    sending.current = null;
    setBusy(null);
  }
  function stopWaiting() {
    const request = sending.current;
    if (!request) return;
    sending.current = null;
    request.controller.abort();
    setBusy(null);
    setForm(null);
    setScanOpen(false);
    void resolve(request.flow, request.context);
  }
  function post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    request: Sending,
  ) {
    return withRequestDeadline(
      (signal) =>
        api(
          path,
          {
            method: "POST",
            body: JSON.stringify(body),
            signal,
            headers: { "X-CSRF-Token": request.context.csrfToken },
          },
          schema,
        ),
      30000,
      request.controller.signal,
    );
  }
  function showCodes(
    list: string[],
    owner: AccountContext,
    source: Codes["source"],
  ) {
    setCodes({ list, generatedAt: new Date(), owner, source });
    setCodesOpen(true);
  }

  async function submitForm(event?: React.FormEvent, typed = code) {
    event?.preventDefault();
    if (!form || sending.current) return;
    const flow = form.flow;
    const original = authority.context();
    if (!authority.usable(original)) return;
    const factor = typed.trim();
    const fields: Fields = {};
    if (!password) fields.password = "Enter your password.";
    if (flow !== "setup") {
      if (useRecovery && !factor)
        fields.code = "Enter one of your unused recovery codes.";
      if (!useRecovery && !/^[0-9]{6}$/.test(factor))
        fields.code = "Enter the 6-digit code from your authenticator app.";
    }
    if (Object.keys(fields).length) {
      setForm({ flow, fields });
      return;
    }
    const body =
      flow === "setup"
        ? { password }
        : {
            password,
            ...(useRecovery ? { recovery_code: factor } : { code: factor }),
          };
    // Submitted secrets are never kept for a replay.
    clearEntry();
    setForm({ flow, fields: {} });
    const request = begin(flow, original);
    try {
      if (flow === "setup") {
        const setup = await post("/mfa/setup", body, MfaSetupSchema, request);
        if (!owns(request)) return;
        setForm(null);
        setEnrollment({ setup, owner: original });
        setScanError("");
        setScanFailures(0);
        setScanEnded(null);
        setScanOpen(true);
      } else if (flow === "disable") {
        await post("/mfa/disable", body, MfaDisableSchema, request);
        if (!owns(request)) return;
        setForm(null);
        notify(
          "Two-factor authentication is off. Other browsers were signed out.",
          { tone: "success" },
        );
        void status.reload();
      } else {
        const result = await post(
          "/mfa/recovery-codes",
          body,
          MfaRecoveryCodesSchema,
          request,
        );
        if (!owns(request)) return;
        setForm(null);
        showCodes(result.recovery_codes, original, "codes");
        void status.reload();
      }
    } catch (failure) {
      if (!owns(request)) return;
      finish(request);
      if (isUncertainOutcome(failure)) {
        setForm(null);
        void resolve(flow, original);
        return;
      }
      const error = failure instanceof APIError ? failure : null;
      const wait = retryDelay(failure);
      if (error?.code === "MFA_ALREADY_ENABLED") {
        setForm(null);
        notify("Two-factor authentication is already on.", { tone: "info" });
        void status.reload();
        return;
      }
      if (error?.code === "MFA_NOT_ENABLED") {
        setForm(null);
        notify("Two-factor authentication is already off.", { tone: "info" });
        void status.reload();
        return;
      }
      if (error?.code === "MFA_CHANGED") void status.reload();
      setForm({
        flow,
        fields:
          error?.code === "WRONG_PASSWORD"
            ? { password: "Your password didn't match." }
            : error?.code === "INVALID_MFA_CODE"
              ? {
                  code: useRecovery
                    ? "That recovery code didn't work. Check it, or use a code from your app. Enter your password again too."
                    : "That code didn't match. Enter the current code and your password again.",
                }
              : {
                  form: wait
                    ? `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`
                    : (failure as Error).message,
                },
      });
    } finally {
      finish(request);
    }
  }

  async function confirm(value: string) {
    const held = enrollmentRef.current;
    if (!held || sending.current) return;
    if (!authority.usable(held.owner)) return;
    setScanError("");
    const request = begin("confirm", held.owner);
    try {
      const result = await post(
        "/mfa/confirm",
        { code: value },
        MfaConfirmSchema,
        request,
      );
      if (!owns(request)) return;
      setEnrollment(null);
      setScanOpen(false);
      showCodes(result.recovery_codes, held.owner, "setup");
      void status.reload();
    } catch (failure) {
      if (!owns(request)) return;
      finish(request);
      if (isUncertainOutcome(failure)) {
        setScanOpen(false);
        void resolve("confirm", held.owner);
        return;
      }
      const error = failure instanceof APIError ? failure.code : "";
      const wait = retryDelay(failure);
      if (error === "INVALID_MFA_CODE") {
        setScanFailures((count) => count + 1);
        setScanAttempt((count) => count + 1);
        setScanError(
          "That code didn't match. Enter the current 6-digit code; they change every 30 seconds.",
        );
      } else if (error === "MFA_SETUP_EXPIRED") setScanEnded("expired");
      else if (error === "MFA_CHANGED") setScanEnded("replaced");
      else if (error === "MFA_ALREADY_ENABLED") {
        setEnrollment(null);
        setScanOpen(false);
        setOutcome({
          flow: "confirm",
          context: held.owner,
          kind: "codes-lost",
        });
        setOutcomeOpen(true);
        void status.reload();
      } else
        setScanError(
          wait
            ? `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`
            : (failure as Error).message,
        );
    } finally {
      finish(request);
    }
  }

  /**
   * After an unconfirmed request, read the current setting once. The read is
   * safe; it says what is true now, and nothing is resent automatically.
   */
  async function resolve(flow: MfaFlow, context: AccountContext) {
    const read = ++reading.current;
    setOutcome({ flow, context, kind: "checking" });
    setOutcomeOpen(true);
    const current = () =>
      mounted.current && reading.current === read && authority.usable(context);
    try {
      const now = await withRequestDeadline(
        (signal) => api("/mfa", { signal }, MfaStatusSchema),
        30000,
      );
      if (!current()) return;
      void status.reload();
      const kind = mfaOutcome(flow, now.enabled);
      if (kind === "off") {
        setOutcome(null);
        setOutcomeOpen(false);
        notify("Two-factor authentication is off.", { tone: "success" });
      } else if (kind === "retry-code") {
        setOutcome(null);
        setOutcomeOpen(false);
        setScanAttempt((count) => count + 1);
        setScanError(
          "We couldn't confirm that code. Enter the next code from your app.",
        );
        setScanOpen(true);
      } else {
        if (kind === "codes-lost") setEnrollment(null);
        setOutcome({
          flow,
          context,
          kind:
            kind === "codes-unknown" || kind === "codes-lost"
              ? "codes-lost"
              : kind === "still-on"
                ? "still-on"
                : "restart",
        });
      }
    } catch {
      if (current()) setOutcome({ flow, context, kind: "unconfirmed" });
    }
  }
  function dismissOutcome() {
    ++reading.current;
    if (outcome?.kind === "checking") setOutcome(null);
    setOutcomeOpen(false);
  }

  const enabled = status.data.enabled;
  const remaining = status.data.recovery_codes_remaining;
  const privileged = user.role === "admin" || user.role === "operator";
  const outcomeCopy: Record<
    Exclude<Outcome["kind"], "checking">,
    {
      title: string;
      body: string;
      note: string;
      action: string;
      next: () => void;
    }
  > = {
    unconfirmed: {
      title: "We couldn't confirm that",
      body: "Check your connection, then check again. Nothing is sent again until you choose to.",
      note: "We couldn't confirm your last change.",
      action: "Check again",
      next: () => outcome && void resolve(outcome.flow, outcome.context),
    },
    restart: {
      title: "Two-factor is still off",
      body: "The setup key may have been created, but its reply did not reach this page. Start again to get a new QR code.",
      note: "The setup key could not be shown. Start again to get a new one.",
      action: "Start again",
      next: () => openForm("setup"),
    },
    "codes-lost": {
      title: "Two-factor is on",
      body:
        outcome?.flow === "codes"
          ? "We couldn't show your new recovery codes, and your old ones may no longer work. Generate new codes to be sure."
          : "We couldn't show your recovery codes. Generate new ones now so you can still sign in if you lose your phone.",
      note: "Your recovery codes weren't shown. Generate new ones.",
      action: "Generate new codes",
      next: () => openForm("codes"),
    },
    "still-on": {
      title: "Two-factor is still on",
      body: "We couldn't confirm your request. Try again with your password and a new code.",
      note: "We couldn't confirm turning it off.",
      action: "Try again",
      next: () => openForm("disable"),
    },
  };
  const pending =
    outcome && outcome.kind !== "checking" ? { kind: outcome.kind } : null;

  return (
    <>
      <div className="account-row">
        <div className="account-row-copy">
          <h3>Two-factor authentication</h3>
          <div className="account-row-status">
            {status.loading && !status.error ? (
              <span className="status-dot">Checking…</span>
            ) : status.error ? (
              <span className="status-dot off">Couldn't check</span>
            ) : enabled ? (
              <>
                <span className="status-dot on">On</span>
                {remaining !== null && remaining !== undefined && (
                  <span className={remaining <= 2 ? "account-row-warning" : ""}>
                    {remaining === 0
                      ? "No recovery codes left"
                      : `${remaining} of 8 recovery codes left`}
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="status-dot off">Off</span>
                {privileged && (
                  <span className="account-row-warning">
                    Recommended for{" "}
                    {user.role === "admin" ? "administrators" : "operators"}
                  </span>
                )}
              </>
            )}
          </div>
          <p>
            {enabled
              ? "Signing in needs your password and a code from your authenticator app."
              : "Add a code from your phone to every sign-in, so a password alone can't open your account."}
          </p>
          {enrollment && !scanOpen && (
            <p className="account-row-note" role="status">
              Setup in progress. Enter a code from your app to finish.
            </p>
          )}
          {codes && !codesOpen && (
            <p className="account-row-warning" role="status">
              Your new recovery codes aren't saved yet.
            </p>
          )}
          {pending && !outcomeOpen && (
            <p className="account-row-warning" role="status">
              {outcomeCopy[pending.kind].note}
            </p>
          )}
          {notice && (
            <p className="account-row-note" role="status">
              {notice}
            </p>
          )}
        </div>
        <div className="account-row-actions">
          {status.error ? (
            <Button variant="secondary" onClick={() => void status.reload()}>
              Try again
            </Button>
          ) : codes ? (
            <Button
              ref={opener}
              icon={KeyRound}
              onClick={() => setCodesOpen(true)}
            >
              Show recovery codes
            </Button>
          ) : pending ? (
            <Button
              ref={opener}
              variant="secondary"
              onClick={() => setOutcomeOpen(true)}
            >
              Review
            </Button>
          ) : enrollment ? (
            <Button ref={opener} onClick={() => setScanOpen(true)}>
              Continue setup
            </Button>
          ) : enabled ? (
            <>
              <Button
                variant="secondary"
                disabled={status.loading}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  openForm("codes");
                }}
              >
                New recovery codes
              </Button>
              <Button
                variant="ghost"
                disabled={status.loading}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  openForm("disable");
                }}
              >
                Turn off
              </Button>
            </>
          ) : (
            <Button
              ref={opener}
              variant={privileged ? undefined : "secondary"}
              icon={ShieldCheck}
              disabled={status.loading}
              onClick={startSetup}
            >
              Set up
            </Button>
          )}
        </div>
      </div>

      <Modal
        open={!!form}
        title={form ? titles[form.flow] : ""}
        description={form ? descriptions[form.flow] : undefined}
        onClose={closeForm}
        returnFocusRef={opener}
      >
        <form onSubmit={(event) => void submitForm(event)} noValidate>
          <div className="modal-body">
            {form?.fields.form && (
              <p className="signin-alert" role="alert">
                {form.fields.form}
              </p>
            )}
            <fieldset className="plain-fieldset" disabled={!!busy}>
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={user.email}
                readOnly
                hidden
              />
              <PasswordField
                label="Password"
                name="current-password"
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
                error={form?.fields.password}
                inputRef={passwordInput}
                autoFocus
              />
              {form && form.flow !== "setup" && (
                <>
                  {useRecovery ? (
                    <AuthField
                      label="Recovery code"
                      error={form.fields.code}
                      hint="Each recovery code works once."
                    >
                      {({ id, describedBy, invalid }) => (
                        <input
                          ref={codeInput}
                          id={id}
                          name="recovery-code"
                          className="auth-mono"
                          autoComplete="off"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          maxLength={80}
                          value={code}
                          aria-invalid={invalid || undefined}
                          aria-describedby={describedBy}
                          onChange={(event) => setCode(event.target.value)}
                        />
                      )}
                    </AuthField>
                  ) : (
                    <OtpInput
                      label="Code from your authenticator app"
                      value={code}
                      onChange={setCode}
                      onComplete={(value) => {
                        if (password) void submitForm(undefined, value);
                      }}
                      inputRef={codeInput}
                      error={form.fields.code}
                    />
                  )}
                  <button
                    type="button"
                    className="text-link factor-toggle"
                    onClick={() => {
                      setUseRecovery((value) => !value);
                      setCode("");
                      setForm((current) =>
                        current ? { ...current, fields: {} } : current,
                      );
                      requestAnimationFrame(() => codeInput.current?.focus());
                    }}
                  >
                    {useRecovery
                      ? "Use your authenticator app instead"
                      : "Use a recovery code instead"}
                  </button>
                </>
              )}
            </fieldset>
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={closeForm}>
              {busy ? "Stop waiting" : "Cancel"}
            </Button>
            <Button
              type="submit"
              busy={!!busy}
              variant={form?.flow === "disable" ? "danger" : undefined}
            >
              {form?.flow === "disable"
                ? "Turn off two-factor"
                : form?.flow === "codes"
                  ? "Generate new codes"
                  : "Continue"}
            </Button>
          </div>
        </form>
      </Modal>

      {enrollment && (
        <AuthenticatorSetup
          setup={enrollment.setup}
          email={user.email}
          busy={busy === "confirm"}
          error={scanError}
          failures={scanFailures}
          attempt={scanAttempt}
          ended={scanEnded}
          open={scanOpen}
          onClose={() =>
            busy === "confirm" ? stopWaiting() : setScanOpen(false)
          }
          onRestart={() => {
            setEnrollment(null);
            setScanOpen(false);
            openForm("setup");
          }}
          onConfirm={(value) => void confirm(value)}
        />
      )}

      {codes && (
        <RecoveryCodesDialog
          open={codesOpen}
          codes={codes.list}
          email={user.email}
          generatedAt={codes.generatedAt}
          onHide={() => setCodesOpen(false)}
          onSaved={() => {
            setCodes(null);
            setCodesOpen(false);
            notify(
              codes.source === "setup"
                ? "Two-factor authentication is on. Other browsers were signed out."
                : "New recovery codes are ready. Your old codes no longer work.",
              { tone: "success" },
            );
          }}
        />
      )}

      <Modal
        open={outcomeOpen && !!outcome}
        title={
          outcome?.kind === "checking"
            ? "Checking two-factor authentication"
            : pending
              ? outcomeCopy[pending.kind].title
              : ""
        }
        onClose={dismissOutcome}
        returnFocusRef={opener}
      >
        <div className="modal-body">
          {outcome?.kind === "checking" ? (
            <p className="signin-loading" role="status">
              <Spinner /> Checking whether your change went through…
            </p>
          ) : (
            pending && (
              <Unconfirmed title={outcomeCopy[pending.kind].title}>
                <p>{outcomeCopy[pending.kind].body}</p>
              </Unconfirmed>
            )
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={dismissOutcome}>
            {outcome?.kind === "checking" ? "Stop checking" : "Not now"}
          </Button>
          {pending && (
            <Button
              autoFocus
              onClick={() => {
                setOutcomeOpen(false);
                outcomeCopy[pending.kind].next();
              }}
            >
              {outcomeCopy[pending.kind].action}
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}

const StatusNameSchema = z
  .object({ instance_name: z.string().optional() })
  .passthrough();

/** One-time recovery codes with Copy, Download and Print, labelled for later. */
function RecoveryCodesDialog({
  open,
  codes,
  email,
  generatedAt,
  onHide,
  onSaved,
}: {
  open: boolean;
  codes: string[];
  email: string;
  generatedAt: Date;
  onHide: () => void;
  onSaved: () => void;
}) {
  const [instance, setInstance] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api("/status", { signal: controller.signal }, StatusNameSchema)
      .then((status) => setInstance(status.instance_name?.trim() || ""))
      .catch(() => {
        /* The host alone still identifies the workspace. */
      });
    return () => controller.abort();
  }, []);
  const host = location.host;
  const workspace =
    instance && instance !== host ? `${instance} (${host})` : host;
  const text = recoveryCodesText({ codes, email, workspace, generatedAt });
  const file = `vectory-recovery-codes-${host.replace(/[^a-z0-9.-]+/gi, "-")}-${generatedAt.toISOString().slice(0, 10)}.txt`;
  return (
    <Modal
      open={open}
      title="Save your recovery codes"
      description="If you lose your phone, each code signs you in once."
      onClose={onHide}
      className="recovery-dialog"
    >
      <div className="modal-body">
        <ol className="recovery-codes" aria-label="Recovery codes">
          {codes.map((code) => (
            <li key={code}>
              <code translate="no">{groupRecoveryCode(code)}</code>
            </li>
          ))}
        </ol>
        <p className="recovery-context">
          For <strong className="auth-email">{email}</strong> on {workspace}.
          Keep them somewhere safe, like your password manager. They won't be
          shown again.
        </p>
        <div className="recovery-actions">
          <CopyButton text={text} label="Copy" copiedLabel="Copied" />
          <Button
            variant="secondary compact"
            icon={Download}
            onClick={() => download(file, text)}
          >
            Download
          </Button>
          <Button
            variant="secondary compact"
            icon={Printer}
            onClick={() => window.print()}
          >
            Print
          </Button>
        </div>
        {open &&
          createPortal(
            <pre className="recovery-print" aria-hidden="true">
              {text}
            </pre>,
            document.body,
          )}
      </div>
      <div className="modal-footer">
        <Button onClick={onSaved}>I've saved these codes</Button>
      </div>
    </Modal>
  );
}
