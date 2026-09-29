import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Config, VariableDeclaration } from "./api";
import { Button, ErrorBox, Field } from "./ui";
import { variableErrors, variableFields } from "./variableFields";
import "./pipeline-variables.css";

export default function PipelineVariables({
  config,
  variables,
  editable,
  onChange,
}: {
  config: Config;
  variables: VariableDeclaration[];
  editable: boolean;
  onChange(next: VariableDeclaration[]): void;
}) {
  const [fieldPath, setFieldPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const fields = useMemo(() => variableFields(config), [config]);
  const available = fields.filter(
    (field) => !variables.some((variable) => variable.path === field.path),
  );
  const chosen = available.find((field) => field.path === fieldPath);
  const existing = variableErrors(config, variables);

  function add() {
    const trimmed = name.trim();
    if (variables.length >= 64) {
      setError("A pipeline can declare at most 64 device-specific variables.");
      return;
    }
    if (!chosen) {
      setError("Choose a field from the current pipeline first.");
      return;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(trimmed)) {
      setError("Use a letter-led name with letters, numbers, or underscores.");
      return;
    }
    if (variables.some((variable) => variable.name === trimmed)) {
      setError("This variable name is already in use.");
      return;
    }
    onChange([
      ...variables,
      { name: trimmed, path: chosen.path, type: chosen.type },
    ]);
    setFieldPath("");
    setName("");
    setError("");
  }

  return (
    <div className="pipeline-variables">
      <p className="control-muted">
        Choose a field whose value can differ by device. You will enter values
        when deploying a published version. These are Vectory deployment values,
        separate from Vector environment variables and native secret providers.
      </p>
      {existing.length > 0 && <ErrorBox message={existing.join("\n")} />}
      {variables.length > 0 && (
        <ul className="pipeline-variable-list" aria-label="Pipeline variables">
          {variables.map((variable) => {
            const field = fields.find((item) => item.path === variable.path);
            return (
              <li key={`${variable.name}:${variable.path}`}>
                <div>
                  <strong>{variable.name}</strong>
                  <span>{field?.label || variable.path}</span>
                  <small>{variable.type}</small>
                </div>
                {editable && (
                  <Button
                    variant="ghost compact"
                    icon={Trash2}
                    aria-label={`Remove variable ${variable.name}`}
                    onClick={() =>
                      onChange(variables.filter((item) => item !== variable))
                    }
                  >
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!variables.length && (
        <p className="pipeline-variable-empty">
          No device-specific fields yet.
        </p>
      )}
      {editable && (
        <div className="pipeline-variable-add">
          <h4>Add a device-specific field</h4>
          {error && <ErrorBox message={error} />}
          <Field label="Pipeline field">
            <select
              value={fieldPath}
              onChange={(event) => {
                setFieldPath(event.target.value);
                setError("");
              }}
            >
              <option value="">Choose a field</option>
              {available.map((field) => (
                <option key={field.path} value={field.path}>
                  {field.label} ({field.type})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Variable name">
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
              placeholder="site_name"
              maxLength={64}
            />
          </Field>
          <Button
            variant="secondary"
            icon={Plus}
            onClick={add}
            disabled={!available.length || variables.length >= 64}
          >
            Add variable
          </Button>
          {!available.length && (
            <p className="control-muted">
              Add an eligible scalar field in Graph or Code to make it available
              here.
            </p>
          )}
        </div>
      )}
      <p className="pipeline-variable-note">
        Deployment values are stored with the deployment and visible to
        authorized users. Do not enter credentials here; use a device-local
        Vector secret provider for those.
      </p>
    </div>
  );
}
