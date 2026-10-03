import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CircleCheck,
  ExternalLink,
  History,
  Info,
  KeyRound,
  LoaderCircle,
  RotateCw,
  Stethoscope,
  TriangleAlert,
} from "lucide-react";
import {
  readDeviceValidation,
  requestDeviceValidation,
  type DeploymentPreview,
  type Device,
  type DeviceValidationDevice,
} from "./api";
import { CopyButton, StatusBadge, useMediaQuery, useNow } from "./ui";
import DiagnosticList from "./DiagnosticList";
import DocLink from "./DocLink";
import { relativeTime } from "./time";
import {
  bindCommands,
  checkBody,
  checkKind,
  checkLook,
  explainCheckError,
  hasMore,
  hostHint,
  isRunning,
  isUnanswered,
  leadFinding,
  mergeRuns,
  nextPollDelay,
  retryBody,
  reviewIdentity,
  runsToRead,
  secretLineParts,
  summarize,
  testsLine,
  throttleMessage,
  tookText,
  truncationNote,
  type CheckKind,
  type Notice,
  type Run,
} from "./deviceCheckModel";
import "./device-check.css";

type ReviewedDevice = Pick<
  Device,
  | "id"
  | "name"
  | "os"
  | "last_seen"
  | "secret_names"
  | "state_dir"
  | "service_manager"
>;

/** What is said under a device's result, and the one thing it can do next. */
function RowDetail({
  row,
  device,
}: {
  row: DeviceValidationDevice;
  device?: ReviewedDevice;
}) {
  const kind = checkKind(row);
  const tests = testsLine(row.tests);
  const took = tookText(row.duration_ms);
  if (kind === "pending")
    return (
      <p className="device-check-quiet">Waiting for the device to answer.</p>
    );
  if (kind === "passed")
    return (
      <>
        <p>Validation found no error on this host.</p>
        {(tests || took) && (
          <p className="device-check-quiet">
            {[tests, took && `Took ${took}`].filter(Boolean).join(" · ")}
          </p>
        )}
      </>
    );
  if (kind === "offline")
    return (
      <p>
        It hasn&apos;t checked in recently, so it wasn&apos;t asked.
        {device?.last_seen && (
          <span className="device-check-quiet">
            {" "}
            Last seen {relativeTime(device.last_seen)}.
          </span>
        )}
      </p>
    );
  if (kind === "expired")
    return (
      <p>
        It didn&apos;t answer in time. A check lasts 10 minutes, and a newer
        check for the same device replaces it.
      </p>
    );
  if (kind === "unsupported")
    return (
      <p>
        This agent can&apos;t run checks yet. Choose{" "}
        <strong>Upgrade agent</strong> on its device page, then check again.{" "}
        <a
          className="target-assignment-link"
          href={`#/devices/${encodeURIComponent(row.id)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open {row.name}
          <ExternalLink size={12} aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </p>
    );
  if (kind === "needs_secret") return <SecretFix row={row} device={device} />;
  const lead = leadFinding(row);
  const rest = row.diagnostics.filter((finding) => finding !== lead);
  // A fix that names a command names it for this host's state directory.
  const forHost = (findings: typeof row.diagnostics) =>
    findings.map((finding) =>
      finding.hint
        ? { ...finding, hint: hostHint(finding.hint, device) }
        : finding,
    );
  return (
    <>
      {lead ? (
        <DiagnosticList
          diagnostics={forHost([lead])}
          label={`Finding on ${row.name}`}
        />
      ) : (
        <p>The device reported no reason.</p>
      )}
      {hasMore(row) && (
        <details className="device-check-more">
          <summary>
            {[
              rest.length
                ? `${rest.length} more ${rest.length === 1 ? "finding" : "findings"}`
                : "",
              tests,
            ]
              .filter(Boolean)
              .join(" · ")}
          </summary>
          <DiagnosticList
            diagnostics={forHost(rest)}
            label={`More findings on ${row.name}`}
          />
          {row.tests.length > 0 && (
            <ul
              className="device-check-tests"
              aria-label={`Tests on ${row.name}`}
            >
              {row.tests.map((test, index) => (
                <li
                  key={`${index}:${test.name}`}
                  data-result={
                    test.not_run ? "not_run" : test.passed ? "passed" : "failed"
                  }
                >
                  <strong>{test.name}</strong>
                  <span>
                    {test.not_run
                      ? "Didn't run"
                      : test.passed
                        ? "Passed"
                        : "Failed"}
                    {test.message ? `: ${test.message}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </>
  );
}

/**
 * A device that hasn't bound a secret the version names: which ones, and the
 * commands that bind them on the host. Names only, never a value.
 */
function SecretFix({
  row,
  device,
}: {
  row: DeviceValidationDevice;
  device?: ReviewedDevice;
}) {
  const steps = bindCommands(row.secrets_missing, device);
  const many = row.secrets_missing.length > 1;
  return (
    <div className="device-check-secret">
      <ul className="device-check-secrets">
        {row.secrets_missing.map((name) => (
          <li key={name}>
            <KeyRound size={14} aria-hidden="true" />
            <span>
              {secretLineParts(name)[0]}
              <code>{name}</code>
              {secretLineParts(name)[2]}.
            </span>
          </li>
        ))}
      </ul>
      <div className="device-check-command">
        <div className="device-check-command-head">
          <p>
            Bind {many ? "them" : "it"} on the host, with the agent stopped:
          </p>
          <CopyButton
            text={steps.commands}
            ariaLabel={`Copy the commands for ${row.name}`}
            copiedMessage={`Commands for ${row.name} copied.`}
          />
        </div>
        <pre
          tabIndex={0}
          aria-label={`Commands that bind ${row.secrets_missing.join(", ")} on ${row.name}`}
        >
          <code>{steps.commands}</code>
        </pre>
      </div>
      <details className="device-check-more">
        <summary>Bindings file</summary>
        <div className="device-check-command">
          <div className="device-check-command-head">
            <p>
              This file replaces the host&apos;s bindings, so it lists every
              secret the device needs. Values stay on the device.
            </p>
            <CopyButton
              text={steps.bindings}
              ariaLabel={`Copy the bindings file for ${row.name}`}
              copiedMessage={`Bindings file for ${row.name} copied.`}
            />
          </div>
          <pre tabIndex={0} aria-label={`Bindings file for ${row.name}`}>
            <code>{steps.bindings}</code>
          </pre>
        </div>
        <p>
          <DocLink topic="resources" section="keep-credentials-on-the-device">
            Device secrets guide
          </DocLink>
        </p>
      </details>
    </div>
  );
}

function ResultBadge({ kind }: { kind: CheckKind }) {
  const look = checkLook[kind];
  return <StatusBadge tone={look.tone} icon={look.icon} label={look.label} />;
}

/** The action a row offers: ask this device again. */
function RowAction({
  kind,
  name,
  blocked,
  onRetry,
}: {
  kind: CheckKind;
  name: string;
  blocked: boolean;
  onRetry: () => void;
}) {
  if (kind === "pending" || kind === "passed") return null;
  const again = kind === "needs_fix" || kind === "needs_secret";
  return (
    <button
      type="button"
      className="button secondary compact device-check-retry"
      aria-disabled={blocked || undefined}
      aria-label={`${again ? "Check" : "Retry"} ${name}${again ? " again" : ""}`}
      onClick={() => !blocked && onRetry()}
    >
      <RotateCw size={14} aria-hidden="true" />
      {again ? "Check again" : "Retry"}
    </button>
  );
}

/** Every device's result, as a table or, on a phone, as cards. */
export function DeviceCheckResults({
  rows,
  devices,
  layout,
  blocked,
  onRetry,
}: {
  rows: readonly DeviceValidationDevice[];
  devices: ReadonlyMap<string, ReviewedDevice>;
  layout: "table" | "cards";
  blocked: boolean;
  onRetry: (id: string) => void;
}) {
  if (layout === "cards")
    return (
      <ul className="device-check-cards" aria-label="Check results by device">
        {rows.map((row) => {
          const kind = checkKind(row);
          return (
            <li
              key={row.id}
              className="device-check-card"
              data-kind={kind}
              data-device-check-row={row.id}
              tabIndex={-1}
            >
              <div className="device-check-card-head">
                <strong>{row.name}</strong>
                <ResultBadge kind={kind} />
              </div>
              <div className="device-check-detail">
                <RowDetail row={row} device={devices.get(row.id)} />
                <RowAction
                  kind={kind}
                  name={row.name}
                  blocked={blocked}
                  onRetry={() => onRetry(row.id)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    );
  return (
    <div className="device-check-table-wrap">
      <table
        className="device-check-table"
        aria-label="Check results by device"
      >
        <thead>
          <tr>
            <th scope="col">Device</th>
            <th scope="col">Result</th>
            <th scope="col">What it found</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const kind = checkKind(row);
            return (
              <tr
                key={row.id}
                data-kind={kind}
                data-device-check-row={row.id}
                tabIndex={-1}
              >
                <th scope="row">{row.name}</th>
                <td>
                  <ResultBadge kind={kind} />
                </td>
                <td className="device-check-detail">
                  <RowDetail row={row} device={devices.get(row.id)} />
                  <RowAction
                    kind={kind}
                    name={row.name}
                    blocked={blocked}
                    onRetry={() => onRetry(row.id)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A calm inline message about the check itself, never about the deployment. */
function CheckNotice({ notice, seconds }: { notice: Notice; seconds: number }) {
  const Icon =
    notice.kind === "failed" || notice.kind === "refused"
      ? TriangleAlert
      : Info;
  return (
    <p
      className="device-check-note"
      data-kind={notice.kind}
      role={
        notice.kind === "failed" || notice.kind === "refused"
          ? "alert"
          : "status"
      }
    >
      <Icon size={15} aria-hidden="true" />
      <span>
        {notice.kind === "throttled" && notice.step === "start" && notice.code
          ? throttleMessage(notice.step, notice.code, seconds)
          : notice.message}
      </span>
    </p>
  );
}

/**
 * Check on devices: asks each reviewed device to validate the version on its
 * own host, without starting or changing anything, and shows who passes,
 * who needs what, and who didn't answer. Results are advisory. This never
 * changes the Deploy button, and it belongs to the review it was asked on: a
 * different selection or version is a different check.
 */
export default function DeviceCheck({
  request,
  devices,
  artifacts,
  testCount,
  onPassed,
}: {
  /** The request the review was computed from. */
  request: Record<string, any>;
  /** The reviewed devices. */
  devices: Device[];
  /** The candidate each reviewed device would be offered. */
  artifacts: DeploymentPreview["artifact_previews"];
  /** How many tests the pipeline holds. */
  testCount: number;
  /**
   * The devices whose host passed the check for this review, now. Empty while
   * nothing was asked, after the review changed and when this goes away.
   */
  onPassed?: (ids: ReadonlySet<string>) => void;
}) {
  const identity = useMemo(
    () => reviewIdentity(request, devices, artifacts),
    [request, devices, artifacts],
  );
  const known = useMemo(
    () => new Map(devices.map((device) => [device.id, device])),
    [devices],
  );
  const cards = useMediaQuery("(max-width: 767px)");
  const switchId = useId();
  const [runTests, setRunTests] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pausedUntil, setPausedUntil] = useState(0);
  const mounted = useRef(true);
  const asking = useRef(false);
  const abortAsk = useRef<AbortController | null>(null);
  const latest = useRef(runs);
  latest.current = runs;
  const focusRow = useRef<string | null>(null);

  // A check belongs to the review it was asked on.
  const stale =
    runs.length > 0 && runs.some((run) => run.identity !== identity);
  const rows = stale ? [] : mergeRuns(runs);
  const running = !stale && runs.length > 0 && isRunning(runs);
  const summary = summarize(rows);
  const now = useNow(runs[0]?.requestedAt ?? null, { active: runs.length > 0 });
  // The wait a 429 asks for, counted down each second while it lasts.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (pausedUntil <= Date.now()) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setClock(at);
      if (at >= pausedUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [pausedUntil]);
  const waiting = Math.max(0, Math.ceil((pausedUntil - clock) / 1000));
  const blocked = starting || waiting > 0;
  // A 429 on asking lasts as long as its wait; every other message stays
  // until the next try replaces it.
  const shownNotice =
    notice &&
    (notice.kind !== "throttled" || notice.step === "read" || waiting > 0)
      ? notice
      : null;
  const reviewed = devices.length;
  const truncated = !stale && !!runs[0]?.detail?.truncated;
  const unanswered = rows.filter((row) => isUnanswered(checkKind(row)));
  // Who passed is reported to the review, which words what a restricted host
  // still has to allow by it.
  const passedKey = rows
    .filter((row) => checkKind(row) === "passed")
    .map((row) => row.id)
    .sort()
    .join(",");
  const report = useRef(onPassed);
  report.current = onPassed;
  useEffect(() => {
    report.current?.(new Set(passedKey ? passedKey.split(",") : []));
  }, [passedKey]);
  useEffect(() => () => report.current?.(new Set()), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortAsk.current?.abort();
    };
  }, []);

  // Read a running check every two seconds, until it is complete, the review
  // changes or the dialog goes away.
  const pollKey =
    !stale && isRunning(runs) ? runs.map((run) => run.id).join() : "";
  useEffect(() => {
    if (!pollKey) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    async function read() {
      const reading = runsToRead(latest.current);
      if (!reading.length) return;
      const results = await Promise.allSettled(
        reading.map((run) => readDeviceValidation(run.id, controller.signal)),
      );
      if (controller.signal.aborted) return;
      setRuns((previous) =>
        previous.map((run) => {
          const result =
            results[reading.findIndex((item) => item.id === run.id)];
          return result?.status === "fulfilled"
            ? { ...run, detail: result.value }
            : run;
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed) {
        const problem = explainCheckError(
          (failed as PromiseRejectedResult).reason,
          "read",
        );
        failures += 1;
        setNotice(problem);
        if (problem.kind === "gone" || problem.kind === "role") {
          // Nothing more to read: the answers can't be shown as current.
          setRuns([]);
          return;
        }
        if (problem.kind === "session") return;
        timer = setTimeout(read, nextPollDelay(failures, problem.retryAfter));
        return;
      }
      failures = 0;
      setNotice((current) => (current?.step === "read" ? null : current));
      const open = results.some(
        (result) =>
          result.status === "fulfilled" && result.value.state === "running",
      );
      if (open) timer = setTimeout(read, nextPollDelay(0));
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pollKey]);

  // After a retry, the row keeps the keyboard's place.
  useEffect(() => {
    const id = focusRow.current;
    if (!id) return;
    focusRow.current = null;
    document
      .querySelector<HTMLElement>(`[data-device-check-row="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true });
  }, [runs]);

  async function start(scope: string[] | null) {
    if (asking.current || waiting > 0) return;
    asking.current = true;
    setStarting(true);
    setNotice(null);
    const controller = new AbortController();
    abortAsk.current = controller;
    const asked = identity;
    try {
      const started = await requestDeviceValidation(
        scope
          ? retryBody(request, scope, runTests)
          : checkBody(request, runTests),
        controller.signal,
      );
      if (!mounted.current) return;
      if (!started.id) {
        setNotice({
          kind: "refused",
          step: "start",
          message:
            "No device could be asked. A device that was revoked can't be checked.",
        });
        return;
      }
      const run: Run = {
        id: started.id,
        identity: asked,
        requestedAt: Date.now(),
        scope,
        detail: null,
      };
      // The button that asked may be gone by the time the answer comes: the
      // keyboard moves to the first device it asked about.
      if (scope) focusRow.current = scope[0];
      setRuns((previous) =>
        scope &&
        previous.length &&
        !previous.some((item) => item.identity !== asked)
          ? [...previous, run]
          : [run],
      );
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      const problem = explainCheckError(error, "start");
      setNotice(problem);
      if (problem.kind === "throttled") {
        const at = Date.now();
        setClock(at);
        setPausedUntil(at + (problem.retryAfter ?? 30) * 1000);
      }
    } finally {
      asking.current = false;
      if (mounted.current) setStarting(false);
    }
  }

  const label = starting
    ? "Starting…"
    : running
      ? "Checking…"
      : runs.length && !stale
        ? "Check again"
        : "Check on devices";
  const busy = starting || running;
  return (
    <section className="device-check" aria-label="Check on devices">
      <div className="device-check-head">
        <div className="device-check-intro">
          <p>
            Runs the check on each host. It doesn&apos;t start or change
            anything.
          </p>
          <label
            className="device-check-switch"
            htmlFor={switchId}
            data-disabled={testCount === 0 || undefined}
          >
            <input
              id={switchId}
              type="checkbox"
              role="switch"
              checked={runTests && testCount > 0}
              disabled={testCount === 0}
              onChange={(event) => setRunTests(event.currentTarget.checked)}
            />
            <span className="device-check-track" aria-hidden="true" />
            <span className="device-check-switch-text">
              <span>Also run the pipeline&apos;s tests</span>
              <small>
                {testCount === 0
                  ? "This pipeline has no tests."
                  : `${testCount.toLocaleString()} ${testCount === 1 ? "test" : "tests"}. Each host runs ${testCount === 1 ? "it" : "them"} too, which takes longer.`}
              </small>
            </span>
          </label>
        </div>
        <button
          type="button"
          className="button secondary device-check-button"
          aria-disabled={blocked || busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => !(blocked || busy) && void start(null)}
        >
          {busy ? (
            <LoaderCircle className="spin" size={15} aria-hidden="true" />
          ) : (
            <Stethoscope size={15} aria-hidden="true" />
          )}
          {label}
        </button>
      </div>
      {shownNotice && <CheckNotice notice={shownNotice} seconds={waiting} />}
      <div
        className="device-check-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {stale ? (
          <p className="device-check-stale">
            <History size={16} aria-hidden="true" />
            <span>
              <strong>These results are for the previous selection.</strong> The
              devices or their values changed. Check again to see how this
              selection does.
            </span>
          </p>
        ) : runs.length > 0 && !rows.length ? (
          <p className="device-check-summary" data-running="">
            <LoaderCircle className="spin" size={16} aria-hidden="true" />
            <span>Asking the devices…</span>
          </p>
        ) : rows.length > 0 ? (
          <>
            <p
              className="device-check-summary"
              data-running={running || undefined}
            >
              {running ? (
                <LoaderCircle className="spin" size={16} aria-hidden="true" />
              ) : (
                <CircleCheck size={16} aria-hidden="true" />
              )}
              <span>{summary.text}</span>
            </p>
            {truncated && (
              <p className="device-check-truncated">
                {truncationNote(rows.length, reviewed)}
              </p>
            )}
          </>
        ) : null}
      </div>
      {!stale && rows.length > 0 && (
        <>
          <div className="device-check-meta">
            <p>
              Results are advisory. Deploy doesn&apos;t wait for them.
              {runs[0] && ` Asked ${relativeTime(runs[0].requestedAt, now)}.`}
            </p>
            {!running && unanswered.length > 0 && (
              <button
                type="button"
                className="button secondary compact"
                aria-disabled={blocked || undefined}
                onClick={() =>
                  !blocked && void start(unanswered.map((row) => row.id))
                }
              >
                <RotateCw size={14} aria-hidden="true" />
                Retry {unanswered.length} unanswered
              </button>
            )}
          </div>
          {running && (
            <p className="device-check-quiet">
              Each device answers at its next check-in. A check expires after 10
              minutes.
            </p>
          )}
          <DeviceCheckResults
            rows={rows}
            devices={known}
            layout={cards ? "cards" : "table"}
            blocked={blocked}
            onRetry={(id) => void start([id])}
          />
        </>
      )}
    </section>
  );
}
