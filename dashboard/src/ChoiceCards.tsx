import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import "./enrollment-connection.css";
import "./agent-updates.css";

export type Choice<T extends string> = {
  value: T;
  label: string;
  summary: string;
  icon: LucideIcon;
  /** Set apart under the summary, such as "The key now in use". */
  note?: ReactNode;
};

/**
 * A choice among a few descriptive options as cards, one radio group. Nothing
 * is chosen until the person picks one: `value` is empty until then. The cards
 * are the Add device mode cards' own, so the choices of one product read alike.
 */
export function ChoiceCards<T extends string>({
  legend,
  name,
  choices,
  value,
  onChange,
  disabled = false,
  columns = choices.length >= 3 ? 3 : 2,
  hint,
}: {
  legend: string;
  name: string;
  choices: Choice<T>[];
  value: T | "";
  onChange: (value: T) => void;
  disabled?: boolean;
  columns?: 1 | 2 | 3;
  hint?: ReactNode;
}) {
  return (
    <fieldset className="enroll-modes choice-cards" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="enroll-mode-options" data-columns={columns}>
        {choices.map(({ value: option, label, summary, icon: Icon, note }) => (
          <label className="enroll-mode" key={option}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <Icon size={18} aria-hidden="true" />
            <span>
              <strong>{label}</strong>
              <small>{summary}</small>
              {note && <span className="choice-note">{note}</span>}
            </span>
          </label>
        ))}
      </div>
      {hint && <p className="choice-hint">{hint}</p>}
    </fieldset>
  );
}
