import { useId, useRef, useState } from "react";
import { ClipboardPaste, FileUp } from "lucide-react";
import type { Config } from "./api";
import { Button } from "./ui";
import {
  assertValidPipelineSource,
  ConfigurationSourceError,
  detectConfigurationFormat,
  guessConfigurationFormat,
  MAX_CONFIGURATION_BYTES,
  type ConfigurationFormat,
} from "./configurationSource";
import { pipelineTemplates } from "./pipelineTemplates";
import "./pipeline-templates.css";

export type StartImport = {
  name: string;
  config?: Config;
  summary?: string;
  error?: string;
};

const count = (config: Config) =>
  ["sources", "transforms", "sinks"]
    .map((section) => Object.keys(config[section] || {}).length)
    .reduce((total, value) => total + value, 0);

/** "Line 4:3: message" for the first problem, so a parse error is findable. */
export function sourceErrorMessage(text: string, error: unknown) {
  const first =
    error instanceof ConfigurationSourceError ? error.diagnostics[0] : null;
  const message = first?.message || (error as Error)?.message || "";
  if (!message) return "This configuration could not be read.";
  if (!first || (first.from === 0 && !text.trim())) return message;
  const before = text.slice(0, first.from).split("\n");
  const line = before.length,
    column = before.at(-1)!.length + 1;
  return /^Line \d+/i.test(message)
    ? message
    : `Line ${line}:${column}: ${message.replace(/ at line \d+, column \d+:?$/, "")}`;
}

/** Check configuration text for a new pipeline. */
export function readStartText(
  name: string,
  text: string,
  format: ConfigurationFormat,
): StartImport {
  try {
    if (new TextEncoder().encode(text).length > MAX_CONFIGURATION_BYTES)
      throw Error("Configurations must be 1 MiB or smaller.");
    const config = assertValidPipelineSource(text, format);
    const steps = count(config);
    return {
      name,
      config,
      summary: `${steps} ${steps === 1 ? "step" : "steps"}, checked locally. Vector checks it in the editor.`,
    };
  } catch (error) {
    return { name, error: sourceErrorMessage(text, error) };
  }
}

/** Read a Vector configuration file for a new pipeline. */
export async function readStartImport(file: File): Promise<StartImport> {
  try {
    if (file.size > MAX_CONFIGURATION_BYTES)
      throw Error("Configuration files must be 1 MiB or smaller.");
    const format = detectConfigurationFormat(file.name);
    return readStartText(file.name, await file.text(), format);
  } catch (error) {
    return {
      name: file.name,
      error: (error as Error).message || "This file could not be read.",
    };
  }
}

const others = pipelineTemplates.filter(
  (template) => template.id !== "synthetic-demo",
);

/**
 * How a new pipeline starts: blank, the synthetic example, an imported
 * Vector configuration, or a template. The chosen template lists what a
 * device still needs.
 */
export default function PipelineStartChoice({
  value,
  disabled,
  imported,
  onChange,
  onImport,
}: {
  value: string;
  disabled: boolean;
  imported: StartImport | null;
  onChange: (value: string) => void;
  onImport: (value: StartImport | null) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const needsId = useId();
  const pasteId = useId();
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const chosen = pipelineTemplates.find((template) => template.id === value);
  const option = (
    id: string,
    title: string,
    detail: string,
    extra?: React.ReactNode,
  ) => (
    <label
      className="pipeline-start-option"
      data-selected={value === id || undefined}
    >
      <input
        type="radio"
        name="pipeline-start"
        disabled={disabled}
        checked={value === id}
        onChange={() => onChange(id)}
        aria-describedby={value === id && chosen ? needsId : undefined}
      />
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
        {extra}
      </span>
    </label>
  );
  return (
    <fieldset className="pipeline-library-templates pipeline-start">
      <legend>How would you like to start?</legend>
      <div className="pipeline-start-primary">
        {option(
          "empty",
          "Build a pipeline",
          "Choose a source and destination step by step.",
        )}
        {option(
          "synthetic-demo",
          "Try a synthetic example",
          "Generated logs → edit fields → console. No application files or external destinations.",
        )}
        {option(
          "import",
          "Import a Vector config",
          "Start from a YAML, JSON or TOML file, or paste one.",
        )}
      </div>
      {value === "import" && (
        <div className="pipeline-start-import">
          <input
            ref={file}
            type="file"
            hidden
            accept=".json,.yaml,.yml,.toml"
            onChange={async (event) => {
              const chosenFile = event.target.files?.[0];
              event.target.value = "";
              if (chosenFile) onImport(await readStartImport(chosenFile));
            }}
          />
          <Button
            type="button"
            variant="secondary compact"
            icon={FileUp}
            disabled={disabled}
            onClick={() => file.current?.click()}
          >
            {imported ? "Choose another file" : "Choose file"}
          </Button>
          <Button
            type="button"
            variant="ghost compact"
            icon={ClipboardPaste}
            disabled={disabled}
            aria-expanded={pasting}
            aria-controls={pasteId}
            onClick={() => setPasting(!pasting)}
          >
            Paste instead
          </Button>
          {pasting && (
            <div className="pipeline-start-paste" id={pasteId}>
              <label className="sr-only" htmlFor={`${pasteId}-text`}>
                Vector configuration
              </label>
              <textarea
                id={`${pasteId}-text`}
                rows={8}
                spellCheck={false}
                disabled={disabled}
                placeholder={
                  "sources:\n  app_logs:\n    type: file\n    include: [/var/log/app/*.log]"
                }
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
              />
              <Button
                type="button"
                variant="secondary compact"
                disabled={disabled || !pasted.trim()}
                onClick={() => {
                  const format = guessConfigurationFormat(pasted);
                  onImport(
                    readStartText(
                      `Pasted ${format.toUpperCase()}`,
                      pasted,
                      format,
                    ),
                  );
                }}
              >
                Use this configuration
              </Button>
            </div>
          )}
          {imported && (
            <p
              className="pipeline-start-import-result"
              role={imported.error ? "alert" : "status"}
              data-error={imported.error ? true : undefined}
            >
              <code>{imported.name}</code> {imported.error ?? imported.summary}
            </p>
          )}
        </div>
      )}
      <p className="pipeline-start-heading">Templates</p>
      <div className="pipeline-start-templates">
        {others.map((template) =>
          option(template.id, template.title, template.summary),
        )}
      </div>
      {chosen && (
        <div className="pipeline-start-needs" id={needsId}>
          <strong>You&apos;ll need</strong>
          <ul>
            {chosen.needs.map((need) => (
              <li key={need}>{need}</li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}
