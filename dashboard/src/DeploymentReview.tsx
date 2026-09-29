import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Bird,
  CalendarClock,
  Check,
  CircleMinus,
  CirclePlus,
  Clock,
  Copy,
  ExternalLink,
  Repeat2,
  Rocket,
  TriangleAlert,
} from "lucide-react";
import type { AssignmentDescription } from "./api";
import { Button } from "./ui";
import { deploymentRoute } from "./deploymentRouting";
import type { StatusTone } from "./deploymentStatus";
import {
  assignmentName,
  localInputValue,
  startsIn,
  usesCanary,
  type ConflictRow,
  type ReleaseErrors,
  type ReleaseSettings,
} from "./deploymentReview";
import "./deployment-rollout.css";
import "./target-dialog.css";

const outcomeIcons: Record<StatusTone, typeof Repeat2> = {
  info: Repeat2,
  success: CirclePlus,
  warning: CircleMinus,
  danger: TriangleAlert,
  neutral: CircleMinus,
};
/** What a request does on one device: an icon and a word, never color alone. */
export function OutcomeChip({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  const Icon = outcomeIcons[tone];
  return (
    <span className="rollout-chip" data-tone={tone}>
      <Icon size={14} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

const strategies: {
  value: ReleaseSettings["strategy"];
  label: string;
  hint: string;
  icon: typeof Rocket;
}[] = [
  {
    value: "all",
    label: "All at once",
    hint: "Every device takes it on its next check-in.",
    icon: Rocket,
  },
  {
    value: "canary",
    label: "Canary",
    hint: "A few devices first, then batches.",
    icon: Bird,
  },
  {
    value: "scheduled",
    label: "Scheduled",
    hint: "Starts at a time you choose.",
    icon: CalendarClock,
  },
];

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  error,
  suffix,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  error?: string;
  suffix?: string;
  onChange(value: number): void;
}) {
  const id = useId();
  return (
    <div className="release-field" data-invalid={error ? "true" : undefined}>
      <label htmlFor={id}>{label}</label>
      <span className="release-input">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={Number.isNaN(value) ? "" : value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-note` : undefined}
          onChange={(event) =>
            onChange(
              event.target.value === "" ? NaN : Number(event.target.value),
            )
          }
        />
        {suffix && <span aria-hidden="true">{suffix}</span>}
      </span>
      {(error || hint) && (
        <small
          id={`${id}-note`}
          className={error ? "release-error" : undefined}
        >
          {error || hint}
        </small>
      )}
    </div>
  );
}

/** Release strategy as a visible choice, with the plan it produces. */
export function ReleaseStrategyFields({
  value,
  errors,
  plan,
  onChange,
}: {
  value: ReleaseSettings;
  errors: ReleaseErrors;
  plan: string;
  onChange(patch: Partial<ReleaseSettings>): void;
}) {
  const name = useId();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (value.strategy !== "scheduled") return;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [value.strategy]);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const start = value.schedule ? startsIn(value.schedule, now) : null;
  return (
    <section className="release-strategy" aria-labelledby={`${name}-heading`}>
      <h3 id={`${name}-heading`}>Release</h3>
      <div
        className="release-options"
        role="radiogroup"
        aria-labelledby={`${name}-heading`}
      >
        {strategies.map((option) => {
          const Icon = option.icon;
          return (
            <label
              key={option.value}
              className="release-option"
              data-checked={value.strategy === option.value || undefined}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={value.strategy === option.value}
                onChange={() =>
                  onChange({
                    strategy: option.value,
                    ...(option.value === "scheduled" && !value.schedule
                      ? {
                          schedule: localInputValue(
                            Math.ceil((Date.now() + 3600000) / 900000) * 900000,
                          ),
                        }
                      : {}),
                  })
                }
              />
              <Icon size={17} aria-hidden="true" />
              <span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
            </label>
          );
        })}
      </div>
      {value.strategy === "scheduled" && (
        <div className="release-schedule">
          <div
            className="release-field"
            data-invalid={errors.schedule ? "true" : undefined}
          >
            <label htmlFor={`${name}-start`}>Start at</label>
            <input
              id={`${name}-start`}
              type="datetime-local"
              value={value.schedule}
              min={localInputValue(Date.now() + 60000)}
              aria-invalid={errors.schedule ? true : undefined}
              aria-describedby={`${name}-start-note`}
              onChange={(event) => onChange({ schedule: event.target.value })}
            />
            <small
              id={`${name}-start-note`}
              className={errors.schedule ? "release-error" : undefined}
            >
              {errors.schedule ||
                `${start ? `Starts ${start}. ` : ""}Your time zone: ${zone}.`}
            </small>
          </div>
          <div className="release-field">
            <label htmlFor={`${name}-kind`}>When it starts</label>
            <select
              id={`${name}-kind`}
              value={value.scheduledKind}
              onChange={(event) =>
                onChange({
                  scheduledKind: event.target
                    .value as ReleaseSettings["scheduledKind"],
                })
              }
            >
              <option value="all">Release to all at once</option>
              <option value="canary">Start with a canary</option>
            </select>
            <small>The devices are fixed when you schedule.</small>
          </div>
        </div>
      )}
      {usesCanary(value) && (
        <div className="release-canary">
          <NumberField
            label="Canary devices"
            value={value.canary}
            min={1}
            max={10000}
            error={errors.canary}
            onChange={(canary) => onChange({ canary })}
          />
          <NumberField
            label="Then batches of"
            value={value.batch}
            min={1}
            max={10000}
            error={errors.batch}
            onChange={(batch) => onChange({ batch })}
          />
          <NumberField
            label="Watch each stage for"
            value={value.observe}
            min={0}
            max={86400}
            suffix="s"
            error={errors.observe}
            hint="After every device in a stage verifies."
            onChange={(observe) => onChange({ observe })}
          />
          <NumberField
            label="Stop if more than"
            value={value.threshold}
            min={0}
            max={10000}
            suffix="fail"
            error={errors.threshold}
            hint={
              value.threshold === 0
                ? "0 stops at the first failed device."
                : `Stops when ${Number.isInteger(value.threshold) ? value.threshold + 1 : "more"} devices fail.`
            }
            onChange={(threshold) => onChange({ threshold })}
          />
        </div>
      )}
      <p className="release-plan" aria-live="polite">
        <Clock size={15} aria-hidden="true" />
        <span>{plan}</span>
      </p>
    </section>
  );
}

function AssignmentLink({
  assignment,
  label,
  disabled,
}: {
  assignment: AssignmentDescription;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <a
      className="target-assignment-link"
      href={`#/${deploymentRoute(false, assignment.id, { search: "", status: "all", page: 1 })}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (disabled) event.preventDefault();
      }}
    >
      {label || assignmentName(assignment)}
      <ExternalLink size={12} aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
export { AssignmentLink };

/**
 * Devices that would not take this request, the assignment in the way, and
 * the two deterministic ways out: outrank it, or replace it.
 */
export function ConflictTable({
  rows,
  requestLabel,
  priority,
  winningPriority,
  busy,
  onUsePriority,
  onReplace,
}: {
  rows: ConflictRow[];
  requestLabel: string;
  priority: number;
  winningPriority: number | null;
  busy: boolean;
  onUsePriority(priority: number): void;
  onReplace(assignmentIds: string[]): void;
}) {
  if (!rows.length) return null;
  const conflicts = rows.filter((row) => row.kind === "conflict").length;
  const outranked = rows.length - conflicts;
  const all = [
    ...new Set(rows.flatMap((row) => row.assignments.map((a) => a.id))),
  ];
  return (
    <section
      className="target-conflicts"
      aria-labelledby="target-conflicts-heading"
    >
      <div className="target-conflicts-head">
        <div>
          <h4 id="target-conflicts-heading">
            {rows.length === 1
              ? "1 device won't take this change yet"
              : `${rows.length} devices won't take this change yet`}
          </h4>
          <p>
            {[
              conflicts
                ? `${conflicts === 1 ? "One has" : `${conflicts} have`} another assignment at the same priority.`
                : "",
              outranked
                ? `${outranked === 1 ? "One follows" : `${outranked} follow`} a higher priority.`
                : "",
            ]
              .filter(Boolean)
              .join(" ")}{" "}
            Choose how to resolve it. Nothing changes until you send.
          </p>
        </div>
        <div className="target-conflicts-actions">
          {winningPriority !== null && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => onUsePriority(winningPriority)}
            >
              Use priority {winningPriority} (wins)
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onReplace(all)}
          >
            Replace existing
          </Button>
        </div>
      </div>
      <div className="target-conflicts-table">
        <table aria-label="Devices with a conflicting assignment">
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">Current winner</th>
              <th scope="col">Your request</th>
              <th scope="col">Resolution</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.device_id}>
                <th scope="row">{row.device_name}</th>
                <td>
                  {row.assignments.length ? (
                    row.assignments.map((assignment) => (
                      <span
                        key={assignment.id}
                        className="target-conflict-winner"
                      >
                        <AssignmentLink
                          assignment={assignment}
                          disabled={busy}
                        />
                        <small>
                          Priority {assignment.priority}
                          {row.kind === "conflict"
                            ? " · same as yours"
                            : " · higher"}
                        </small>
                      </span>
                    ))
                  ) : (
                    <span className="control-muted">Another assignment</span>
                  )}
                </td>
                <td>
                  {requestLabel}
                  <small>Priority {priority}</small>
                </td>
                <td>
                  <span className="target-conflict-resolve">
                    {winningPriority !== null && (
                      <button
                        type="button"
                        className="target-link-button"
                        disabled={busy}
                        onClick={() => onUsePriority(winningPriority)}
                      >
                        Use priority {winningPriority}
                      </button>
                    )}
                    {row.assignments.length > 0 && (
                      <button
                        type="button"
                        className="target-link-button"
                        disabled={busy}
                        onClick={() =>
                          onReplace(row.assignments.map((a) => a.id))
                        }
                      >
                        Replace{" "}
                        {row.assignments.length === 1
                          ? assignmentName(row.assignments[0])
                          : "them"}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="target-conflicts-rule">
        Higher priority always wins. Equal priorities must send the same thing,
        so they never break ties silently.
      </p>
    </section>
  );
}

/** Copies details for support; the page never shows raw JSON. */
export function CopyDetails({ text }: { text: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      variant="ghost compact"
      icon={state === "copied" ? Check : Copy}
      onClick={async () => {
        try {
          if (!navigator.clipboard?.writeText)
            throw Error("Clipboard unavailable");
          await navigator.clipboard.writeText(text());
          setState("copied");
          setTimeout(() => setState("idle"), 2000);
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy unavailable in this browser"
          : "Copy technical details"}
    </Button>
  );
}
