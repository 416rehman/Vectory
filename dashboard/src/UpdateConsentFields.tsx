import { useId } from "react";
import { Ban, CircleArrowUp, Hand } from "lucide-react";
import type { AgentUpdates } from "./agentUpdateModel";
import { pinsText } from "./agentUpdateModel";
import {
  consentChoices,
  trackChoices,
  type UpdateLevel,
} from "./agentUpdateCommands";
import type { ConsentForm, ConsentRead } from "./agentUpdateConsent";
import { ChoiceCards } from "./ChoiceCards";
import { WINDOW_LIMIT } from "./updateWindow";
import "./agent-updates.css";

const icons = { auto: CircleArrowUp, ask: Hand, off: Ban } as const;

/**
 * How one host takes agent updates, as the Add device and Upgrade agent steps
 * and the review's fixes ask for it: a level (nothing chosen until the person
 * chooses), the releases it takes, an optional window, and the key the command
 * will make the host pin, said so the person who runs it sees what the host
 * will trust.
 */
export function UpdateConsentFields({
  value,
  onChange,
  read,
  signingKey: current,
  levels = ["auto", "ask", "off"],
  disabled = false,
  legend = "How should this host take agent updates?",
  name = "update-level",
}: {
  value: ConsentForm;
  onChange(patch: Partial<ConsentForm>): void;
  read: ConsentRead;
  /** The key this server signs with now, from the settings. */
  signingKey: AgentUpdates["current_key"];
  levels?: readonly UpdateLevel[];
  disabled?: boolean;
  legend?: string;
  name?: string;
}) {
  const id = useId();
  const taking = value.level === "auto" || value.level === "ask";
  return (
    <div className="update-consent">
      <ChoiceCards
        legend={legend}
        name={name}
        disabled={disabled}
        value={value.level}
        onChange={(level) => onChange({ level })}
        columns={levels.length >= 3 ? 3 : 2}
        choices={consentChoices
          .filter((choice) => levels.includes(choice.value))
          .map((choice) => ({
            value: choice.value,
            label: choice.label,
            summary: choice.description,
            icon: icons[choice.value],
          }))}
      />
      {taking && (
        <>
          <fieldset className="enroll-trust update-track" disabled={disabled}>
            <legend>Which releases?</legend>
            <div className="enroll-trust-options">
              {trackChoices.map((choice) => (
                <label key={choice.value} className="enroll-trust-option">
                  <input
                    type="radio"
                    name={`${id}-track`}
                    value={choice.value}
                    checked={value.track === choice.value}
                    onChange={() => onChange({ track: choice.value })}
                  />
                  <span>
                    <strong>
                      {choice.label}
                      {choice.value === "patch" && (
                        <span className="enroll-default"> · default</span>
                      )}
                    </strong>
                    <small>{choice.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="update-window-field">
            <label htmlFor={`${id}-windows`}>Update windows (optional)</label>
            <textarea
              id={`${id}-windows`}
              rows={2}
              value={value.windowsText}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              placeholder={"Mon-Fri 02:00-04:00\nSat,Sun 01:00-03:00 UTC"}
              aria-invalid={read.field === "windows"}
              aria-describedby={`${id}-windows-note`}
              onChange={(event) =>
                onChange({ windowsText: event.target.value })
              }
            />
            <small
              id={`${id}-windows-note`}
              className={read.field === "windows" ? "update-field-error" : ""}
              role={read.field === "windows" ? "alert" : undefined}
            >
              {read.field === "windows"
                ? read.problem
                : `One window per line, at most ${WINDOW_LIMIT}. Times are the host's own unless UTC follows. Empty means any time.`}
            </small>
          </div>
          {current ? (
            <p className="update-pins" role="status">
              <strong>{pinsText(current)}</strong>
              <span>
                The host installs, as root, only builds this key signs. Whoever
                holds the key can install software on it.
              </span>
            </p>
          ) : (
            <p className="control-note" role="status">
              {read.problem ||
                "This server has no release key yet, so a host can't pin one."}
            </p>
          )}
        </>
      )}
      {value.level === "off" && (
        <p className="update-pins" role="status">
          <strong>Updates off</strong>
          <span>
            This host updates only by hand. The command writes no key, and the
            dashboard offers it nothing.
          </span>
        </p>
      )}
    </div>
  );
}
