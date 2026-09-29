import { useEffect, useId, useRef, useState } from "react";
import { ClipboardPaste, FileUp } from "lucide-react";
import type { Config } from "./api";
import { Button } from "./ui";
import type { ConfigurationFormat } from "./configurationSource";
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

// Checking a configuration needs Vector's schema (about 1.4 MB), so it
// downloads when someone imports or pastes one, never with the dialog.
const loadSource = () => import("./configurationSource");

/** Check configuration text for a new pipeline. */
export async function readStartText(
  name: string,
  text: string,
  format: ConfigurationFormat,
): Promise<StartImport> {
  const { assertValidPipelineSource, MAX_CONFIGURATION_BYTES, sourceErrorMessage } =
    await loadSource();
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
    const { detectConfigurationFormat, MAX_CONFIGURATION_BYTES } =
      await loadSource();
    if (file.size > MAX_CONFIGURATION_BYTES)
      throw Error("Configuration files must be 1 MiB or smaller.");
    const format = detectConfigurationFormat(file.name);
    return await readStartText(file.name, await file.text(), format);
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
  /** The chosen start, with the template's name ("" for none). */
  onChange: (value: string, templateName: string) => void;
  onImport: (value: StartImport | null) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const needsId = useId();
  const needsBox = useRef<HTMLDivElement>(null);
  // Choosing a template brings what it needs into view, not below the fold.
  useEffect(() => {
    if (value !== "empty")
      needsBox.current?.scrollIntoView?.({ block: "nearest" });
  }, [value]);
  const pasteId = useId();
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  // The name being checked; only the newest check's answer is shown.
  const [checking, setChecking] = useState<string | null>(null);
  const check = useRef(0);
  async function read(name: string, run: () => Promise<StartImport>) {
    const ticket = ++check.current;
    setChecking(name);
    let result: StartImport;
    try {
      result = await run();
    } catch {
      result = {
        name,
        error:
          "The configuration checker didn't load. Check your connection, then try again.",
      };
    }
    if (ticket !== check.current) return;
    setChecking(null);
    onImport(result);
  }
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
        onChange={() =>
          onChange(
            id,
            pipelineTemplates.find((template) => template.id === id)?.title ??
              "",
          )
        }
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
            onChange={(event) => {
              const chosenFile = event.target.files?.[0];
              event.target.value = "";
              if (chosenFile)
                void read(chosenFile.name, () => readStartImport(chosenFile));
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
                  const text = pasted;
                  void read("Pasted configuration", async () => {
                    const { guessConfigurationFormat } = await loadSource();
                    const format = guessConfigurationFormat(text);
                    return readStartText(
                      `Pasted ${format.toUpperCase()}`,
                      text,
                      format,
                    );
                  });
                }}
              >
                Use this configuration
              </Button>
            </div>
          )}
          {checking ? (
            <p className="pipeline-start-import-result" role="status">
              <code>{checking}</code> Checking…
            </p>
          ) : (
            imported && (
              <p
                className="pipeline-start-import-result"
                role={imported.error ? "alert" : "status"}
                data-error={imported.error ? true : undefined}
              >
                <code>{imported.name}</code>{" "}
                {imported.error ?? imported.summary}
              </p>
            )
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
        <div className="pipeline-start-needs" id={needsId} ref={needsBox}>
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
