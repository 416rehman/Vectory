import { useId, useRef } from "react";
import { FileUp } from "lucide-react";
import type { Config } from "./api";
import { Button } from "./ui";
import {
  assertValidPipelineSource,
  detectConfigurationFormat,
  MAX_CONFIGURATION_BYTES,
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

/** Read a Vector configuration file for a new pipeline. */
export async function readStartImport(file: File): Promise<StartImport> {
  try {
    if (file.size > MAX_CONFIGURATION_BYTES)
      throw Error("Configuration files must be 1 MiB or smaller.");
    const config = assertValidPipelineSource(
      await file.text(),
      detectConfigurationFormat(file.name),
    );
    const steps = count(config);
    return {
      name: file.name,
      config,
      summary: `${steps} ${steps === 1 ? "step" : "steps"}, checked locally. Vector checks it in the editor.`,
    };
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
          "Start from a YAML, JSON or TOML file.",
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
