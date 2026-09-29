import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  CircleAlert,
  CircleCheck,
  KeyRound,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { CopyButton, SegmentedControl } from "./ui";
import DocLink from "./DocLink";
import { usePendingField } from "./SchemaValueEditor";
import { SecretNamesContext } from "./secretFieldContext";
import {
  SECRET_PREFIX,
  bindingInstructions,
  pickerState,
  pickerValue,
  readPickerInput,
  secretFile,
  suggestedSecretName,
  type BindingPlatform,
  type PickerMode,
  type SecretPath,
} from "./secretFields";
import "./secret-reference.css";

/**
 * How to give devices the secrets a pipeline needs: the private files, the
 * bindings file that lists them all, and the commands, for Linux and macOS or
 * Windows. The bindings file replaces a device's bindings, so it names every
 * secret, not just a new one.
 */
export function SecretBindingSteps({
  names,
  idPrefix,
}: {
  names: readonly string[];
  idPrefix?: string;
}) {
  const [platform, setPlatform] = useState<BindingPlatform>("unix");
  const steps = bindingInstructions(names.length ? names : ["NAME"], platform);
  const first = names[0] || "NAME";
  const generated = useId();
  const id = idPrefix || generated;
  return (
    <div className="secret-binding">
      <SegmentedControl
        label="Device platform"
        value={platform}
        onChange={setPlatform}
        options={[
          { value: "unix", label: "Linux & macOS" },
          { value: "windows", label: "Windows" },
        ]}
      />
      <ol className="secret-binding-steps">
        <li>
          <p>
            Save each value in a file only the agent's account can read, such as{" "}
            <code>{secretFile(first, platform)}</code>.
          </p>
        </li>
        <li>
          <div className="secret-binding-step-head">
            <p id={`${id}-bindings`}>
              List every secret the device needs. This file replaces its
              bindings.
            </p>
            <CopyButton
              text={steps.bindings}
              ariaLabel="Copy the bindings file"
            />
          </div>
          <pre aria-labelledby={`${id}-bindings`}>{steps.bindings}</pre>
        </li>
        <li>
          <div className="secret-binding-step-head">
            <p id={`${id}-commands`}>
              {platform === "windows"
                ? "In an administrator PowerShell, register it with the agent stopped:"
                : "Register it with the agent stopped:"}
            </p>
            <CopyButton text={steps.commands} ariaLabel="Copy the commands" />
          </div>
          <pre aria-labelledby={`${id}-commands`}>{steps.commands}</pre>
        </li>
      </ol>
      <p className="secret-binding-note">
        Values never leave the device. Its next check-in applies them.{" "}
        <DocLink topic="resources" section="keep-credentials-on-the-device">
          Device secrets guide
        </DocLink>
      </p>
    </div>
  );
}

/**
 * The control for every credential field: a device secret by name
 * (`vectory-secret:NAME`, checked as you type) or, in full mode, a Vector
 * secret or variable reference. It never shows or saves a plain-text value.
 */
export default function SecretReferenceField({
  title,
  value,
  onChange,
  editable,
  required = false,
  device,
  header,
  className = "",
}: {
  title: string;
  value: unknown;
  onChange: (next: string) => void;
  editable: boolean;
  required?: boolean;
  /** Set when this field can hold a device secret: its step and place. */
  device: { componentId: string; path: SecretPath } | null;
  /** The field header when the picker stands alone. */
  header?: ReactNode;
  className?: string;
}) {
  const allowed = !!device;
  const initial = useMemo(() => pickerState(value, allowed), [value, allowed]);
  const [mode, setMode] = useState<PickerMode>(initial.mode),
    [text, setText] = useState(initial.text),
    [touched, setTouched] = useState(false);
  useEffect(() => {
    setMode(initial.mode);
    setText(initial.text);
    setTouched(false);
  }, [initial]);
  usePendingField(mode !== initial.mode || text !== initial.text);
  const names = useContext(SecretNamesContext);
  const suggestion = device
    ? suggestedSecretName(device.componentId, device.path)
    : "";
  const labelId = useId(),
    statusId = useId(),
    listId = useId(),
    describeId = useId();
  const result = pickerValue(mode, text);
  function input(next: string) {
    const read = readPickerInput(mode, next, allowed);
    setMode(read.mode);
    setText(read.text);
    setTouched(true);
    const saved = pickerValue(read.mode, read.text);
    if (saved.value !== null && saved.value !== value) onChange(saved.value);
  }
  function switchTo(next: PickerMode) {
    setMode(next);
    setText(next === initial.mode ? initial.text : "");
    setTouched(false);
  }
  const deviceName = mode === "device" && !result.problem ? text : "";
  const showProblem =
    !!result.problem && (touched || (!!text && text !== initial.text));
  let status: { tone: string; icon: typeof CircleCheck; text: string } | null;
  if (initial.plainText && !touched)
    status = {
      tone: "warning",
      icon: TriangleAlert,
      text: allowed
        ? "This field holds a plain-text credential, which can't be saved or published. Replace it with a device secret."
        : "This field holds a plain-text credential, which can't be saved or published. Replace it with a Vector secret reference.",
    };
  else if (initial.refused && !touched)
    status = {
      tone: "warning",
      icon: TriangleAlert,
      text: "A device secret can't fill this field. Use a Vector secret or variable reference.",
    };
  else if (showProblem)
    status = { tone: "error", icon: CircleAlert, text: result.problem! };
  else if (mode === "device" && deviceName)
    status = {
      tone: "success",
      icon: ShieldCheck,
      text: `Each device fills this in from its own ${deviceName} file.`,
    };
  else if (mode === "native" && result.value)
    status = {
      tone: "neutral",
      icon: CircleCheck,
      text: "Vector resolves this on each device. It needs full mode.",
    };
  else
    status = {
      tone: "neutral",
      icon: KeyRound,
      text:
        mode === "device"
          ? "Name the secret. Its value stays on each device."
          : "A Vector secret or environment variable, resolved on each device in full mode.",
    };
  const StatusIcon = status.icon;
  const known = names.filter((name) => name !== text);
  return (
    <div
      className={`schema-value schema-value-secret secret-picker ${className}`.trim()}
      data-semantic="secret"
      data-mode={mode}
    >
      {header}
      <div className="field">
        <span id={labelId}>
          {title + (/reference$/i.test(title) ? "" : " reference")}
        </span>
        <div
          className="secret-picker-input"
          data-invalid={showProblem || undefined}
          data-readonly={!editable || undefined}
        >
          <KeyRound size={15} aria-hidden="true" />
          {mode === "device" && (
            <span className="secret-picker-prefix" aria-hidden="true">
              {SECRET_PREFIX}
            </span>
          )}
          <input
            aria-labelledby={labelId}
            aria-describedby={`${describeId} ${statusId}`}
            aria-invalid={showProblem || undefined}
            aria-required={required || undefined}
            type="text"
            value={text}
            readOnly={!editable}
            list={mode === "device" && known.length ? listId : undefined}
            placeholder={
              mode === "device"
                ? suggestion || "SECRET_NAME"
                : "SECRET[backend.key] or ${VARIABLE}"
            }
            onChange={(event) => input(event.target.value)}
            onBlur={() => setTouched(true)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
      </div>
      <span id={describeId} className="sr-only">
        {mode === "device"
          ? "Device secret name. Saved as vectory-secret:NAME."
          : "Vector secret or variable reference."}
      </span>
      {mode === "device" && known.length > 0 && (
        <datalist id={listId}>
          {known.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      <div className="secret-picker-status" data-tone={status.tone}>
        <p id={statusId} role="status">
          <StatusIcon size={14} aria-hidden="true" />
          <span>{status.text}</span>
        </p>
        {editable && (
          <div className="secret-picker-actions">
            {mode === "device" && !text && suggestion && (
              <button
                type="button"
                className="secret-picker-link"
                onClick={() => input(suggestion)}
              >
                Use <code>{suggestion}</code>
              </button>
            )}
            {allowed && (
              <button
                type="button"
                className="secret-picker-link"
                onClick={() =>
                  switchTo(mode === "device" ? "native" : "device")
                }
              >
                {mode === "device"
                  ? "Use a Vector reference"
                  : "Use a device secret"}
              </button>
            )}
          </div>
        )}
      </div>
      {mode === "device" && allowed && (
        <details className="secret-picker-help">
          <summary>How to bind it on a device</summary>
          <SecretBindingSteps
            names={[
              ...new Set([
                ...(deviceName ? [deviceName] : []),
                ...names.filter((name) => name !== deviceName),
              ]),
            ]}
          />
        </details>
      )}
    </div>
  );
}
