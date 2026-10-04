import { useEffect, useId, useRef, useState } from "react";
import { ClipboardPaste, FileUp } from "lucide-react";
import type { Config } from "./api";
import { Button } from "./ui";
import type { ConfigurationFormat } from "./configurationSource";
import { pipelineTemplates } from "./pipelineTemplates";
import { findPlainCredential } from "./credentialFields";
import "./pipeline-templates.css";

export type StartImport = {
  name: string;
  checking?: boolean;
  suggestedName?: string;
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
  const {
    assertValidPipelineSource,
    MAX_CONFIGURATION_BYTES,
    sourceErrorMessage,
  } = await loadSource();
  try {
    if (new TextEncoder().encode(text).length > MAX_CONFIGURATION_BYTES)
      throw Error("Configurations must be 1 MiB or smaller.");
    const config = assertValidPipelineSource(text, format);
    return checkedStartImport(name, config);
  } catch (error) {
    const message = sourceErrorMessage(text, error);
    return {
      name,
      error: message.includes("Only credential fields can hold a device secret")
        ? `${message} This preview does not support device secrets in headers or URLs. Use a native Vector secret or environment reference on a full-mode device, or remove this value.`
        : message,
    };
  }
}

function checkedStartImport(
  name: string,
  config: Config,
  fileCount = 0,
): StartImport {
  try {
    const credential = findPlainCredential(config);
    if (credential) {
      const outboundLocation =
        /(?:^|\.)(?:uri|endpoint|endpoints|headers)(?:\.|$)/i.test(
          credential.path,
        );
      throw Error(
        credential.kind === "scan_limit"
          ? `Configuration is nested too deeply at ${credential.path} to check for credentials. Simplify it before importing.`
          : credential.kind === "unsupported_reference"
            ? `${credential.path} uses a device secret outside a supported credential field. This preview does not support device secrets in headers or URLs. Use a native Vector secret or environment reference on a full-mode device, or remove this value.`
            : `${credential.path} looks like a plaintext credential. ${outboundLocation ? "This preview does not support device secrets in headers or URLs; remove the credential or use a native reference on a full-mode device." : "Replace it with a supported secret reference before importing."}`,
      );
    }
    const steps = count(config);
    return {
      name,
      config,
      ...(fileCount === 1
        ? { suggestedName: name.replace(/\.(?:ya?ml|json|toml)$/i, "") }
        : {}),
      summary: `${steps} ${steps === 1 ? "step" : "steps"}, checked locally. Vector checks it in the editor.`,
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      name,
      error: message.includes("Only credential fields can hold a device secret")
        ? `${message} This preview does not support device secrets in headers or URLs. Use a native Vector secret or environment reference on a full-mode device, or remove this value.`
        : message,
    };
  }
}

/** Read a set of Vector files as one new pipeline. */
export async function readStartFiles(
  files: readonly File[],
): Promise<StartImport> {
  const name =
    files.length === 1 ? files[0].name : `${files.length} configuration files`;
  try {
    const { readConfigurationFiles } = await loadSource();
    const result = await readConfigurationFiles(files);
    return checkedStartImport(result.name, result.config, files.length);
  } catch (error) {
    return {
      name,
      error: (error as Error).message || "These files could not be read.",
    };
  }
}

/** Keep the single-file API for callers that already have one File. */
export const readStartImport = (file: File) => readStartFiles([file]);

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
  const check = useRef(0);
  // A closed dialog must not let an old file read update a later one.
  useEffect(
    () => () => {
      check.current++;
    },
    [],
  );
  async function read(name: string, run: () => Promise<StartImport>) {
    const ticket = ++check.current;
    // Revoke the previous valid import before reading another file. Creating
    // during this check must never submit that previous configuration.
    onImport({ name, checking: true });
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
        onChange={() => {
          check.current++;
          onChange(
            id,
            pipelineTemplates.find((template) => template.id === id)?.title ??
              "",
          );
        }}
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
          "Choose one or several YAML, JSON or TOML files, or paste one.",
        )}
      </div>
      {value === "import" && (
        <div className="pipeline-start-import">
          <input
            ref={file}
            type="file"
            hidden
            multiple
            accept=".json,.yaml,.yml,.toml"
            onChange={(event) => {
              const chosenFiles = Array.from(event.target.files || []);
              event.target.value = "";
              if (chosenFiles.length)
                void read(
                  chosenFiles.length === 1
                    ? chosenFiles[0].name
                    : `${chosenFiles.length} configuration files`,
                  () => readStartFiles(chosenFiles),
                );
            }}
          />
          <Button
            type="button"
            variant="secondary compact"
            icon={FileUp}
            disabled={disabled}
            onClick={() => file.current?.click()}
          >
            {imported ? "Choose other files" : "Choose files"}
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
          {imported?.checking ? (
            <p className="pipeline-start-import-result" role="status">
              <code>{imported.name}</code> Checking…
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
