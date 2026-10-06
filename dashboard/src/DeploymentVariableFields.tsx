import { useState } from "react";
import type { Device, VariableDeclaration } from "./api";
import DocLink from "./DocLink";
import { pastedValues, type BindingInputs } from "./deploymentVariables";
import "./deployment-variable-fields.css";

function ValueInput({
  declaration,
  value,
  onChange,
  label,
  placeholder,
}: {
  declaration: VariableDeclaration;
  value: string;
  onChange(value: string): void;
  label: string;
  placeholder?: string;
}) {
  return declaration.type === "boolean" ? (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder || "Choose true or false"}</option>
      <option value="true">True</option>
      <option value="false">False</option>
    </select>
  ) : (
    <input
      aria-label={label}
      type="text"
      inputMode={declaration.type === "integer" ? "numeric" : "text"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={
        placeholder ||
        (declaration.type === "integer" ? "Whole number" : "Nonsecret value")
      }
    />
  );
}

const PAGE = 50;

export default function DeploymentVariableFields({
  declarations,
  devices,
  inputs,
  persistent,
  onChange,
}: {
  declarations: VariableDeclaration[];
  devices: Device[];
  inputs: BindingInputs;
  persistent: boolean;
  onChange(next: BindingInputs): void;
}) {
  const [search, setSearch] = useState("");
  const [pasted, setPasted] = useState("");
  const [pasteResult, setPasteResult] = useState("");
  const matching = devices.filter((device) =>
    `${device.name} ${device.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  const shown = matching.slice(0, PAGE);
  const overridden = devices.filter((device) =>
    Object.keys(inputs.devices[device.id] || {}).some((name) =>
      declarations.some((declaration) => declaration.name === name),
    ),
  );
  const hasDefault = (name: string) =>
    Object.prototype.hasOwnProperty.call(inputs.defaults, name);

  function changeDefault(name: string, value: string | null) {
    const defaults = { ...inputs.defaults };
    if (value === null) delete defaults[name];
    else defaults[name] = value;
    onChange({ ...inputs, defaults });
  }
  /** An empty cell means "use the default" for that device. */
  function changeOverride(deviceId: string, name: string, value: string) {
    const devicesInput = { ...inputs.devices };
    const deviceValues = { ...(devicesInput[deviceId] || {}) };
    if (value === "") delete deviceValues[name];
    else deviceValues[name] = value;
    if (Object.keys(deviceValues).length) devicesInput[deviceId] = deviceValues;
    else delete devicesInput[deviceId];
    onChange({ ...inputs, devices: devicesInput });
  }
  function applyPaste() {
    const result = pastedValues(pasted, declarations, devices);
    if (result.applied) {
      const devicesInput = { ...inputs.devices };
      for (const [deviceId, values] of Object.entries(result.values))
        devicesInput[deviceId] = {
          ...(devicesInput[deviceId] || {}),
          ...values,
        };
      onChange({ ...inputs, devices: devicesInput });
      setPasted("");
    }
    setPasteResult(
      [
        result.applied
          ? `Filled values for ${result.applied} ${result.applied === 1 ? "device" : "devices"}.`
          : "Nothing was filled.",
        result.unknown.length
          ? `No selected device is named ${result.unknown
              .slice(0, 3)
              .map((name) => `"${name}"`)
              .join(
                ", ",
              )}${result.unknown.length > 3 ? ` and ${result.unknown.length - 3} more` : ""}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  return (
    <section
      className="deployment-variable-fields"
      aria-label="Values by device"
    >
      <div className="deployment-variable-heading">
        <h3>Values by device</h3>
        <p>
          Set a default for all selected devices, then give individual devices
          their own value where they differ.{" "}
          {persistent && "Future group members use the defaults."}
        </p>
      </div>
      <div className="deployment-variable-defaults">
        {declarations.map((declaration) => {
          const enabled = hasDefault(declaration.name);
          return (
            <div className="deployment-variable-card" key={declaration.name}>
              <div className="deployment-variable-card-heading">
                <strong>{declaration.name}</strong>
                <span>{declaration.type}</span>
              </div>
              <small>{declaration.path}</small>
              <label className="deployment-variable-toggle">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) =>
                    changeDefault(
                      declaration.name,
                      event.target.checked ? "" : null,
                    )
                  }
                />
                {persistent
                  ? "Set required default"
                  : "Set default for selected devices"}
              </label>
              {enabled && (
                <ValueInput
                  declaration={declaration}
                  label={`Default for ${declaration.name}`}
                  value={inputs.defaults[declaration.name]}
                  onChange={(value) => changeDefault(declaration.name, value)}
                />
              )}
            </div>
          );
        })}
      </div>
      {devices.length > 0 && (
        <div className="deployment-variable-overrides">
          <div className="deployment-variable-overrides-head">
            <h4>
              Each device
              {overridden.length
                ? ` · ${overridden.length} with ${overridden.length === 1 ? "its own value" : "their own values"}`
                : ""}
            </h4>
            {devices.length > 10 && (
              <label className="deployment-variable-device-search">
                <span className="sr-only">Find a selected device</span>
                <input
                  value={search}
                  placeholder="Find a selected device"
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            )}
          </div>
          <div className="deployment-variable-table-scroll">
            <table className="deployment-variable-table">
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  {declarations.map((declaration) => (
                    <th scope="col" key={declaration.name}>
                      {declaration.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((device) => {
                  const values = inputs.devices[device.id] || {};
                  return (
                    <tr key={device.id}>
                      <th scope="row">{device.name}</th>
                      {declarations.map((declaration) => {
                        const own = Object.prototype.hasOwnProperty.call(
                          values,
                          declaration.name,
                        );
                        const fallback = hasDefault(declaration.name)
                          ? inputs.defaults[declaration.name]
                          : "";
                        return (
                          <td
                            key={declaration.name}
                            data-own={own || undefined}
                          >
                            <ValueInput
                              declaration={declaration}
                              label={`${declaration.name} for ${device.name}`}
                              value={own ? values[declaration.name] : ""}
                              placeholder={
                                fallback !== ""
                                  ? `Default: ${fallback}`
                                  : hasDefault(declaration.name)
                                    ? "Default"
                                    : "Needs a value"
                              }
                              onChange={(value) =>
                                changeOverride(
                                  device.id,
                                  declaration.name,
                                  value,
                                )
                              }
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {matching.length > shown.length && (
            <p className="control-muted">
              Showing {shown.length} of {matching.length}. Search by name to
              find the others, or paste their values below.
            </p>
          )}
          {!matching.length && (
            <p className="control-muted">No selected device matches.</p>
          )}
          <details className="deployment-variable-paste">
            <summary>Paste values for many devices</summary>
            <p>
              One device per line: its name, then{" "}
              {declarations.length === 1
                ? `its ${declarations[0].name}`
                : `${declarations.map((declaration) => declaration.name).join(", ")} in that order`}
              , separated by commas or tabs. A spreadsheet copy works.
            </p>
            <textarea
              aria-label="Values to paste"
              rows={4}
              value={pasted}
              spellCheck={false}
              placeholder={`${devices[0]?.name || "edge-01"},${declarations
                .map((declaration) =>
                  declaration.type === "integer"
                    ? "9101"
                    : declaration.type === "boolean"
                      ? "true"
                      : "value",
                )
                .join(",")}`}
              onChange={(event) => {
                setPasted(event.target.value);
                setPasteResult("");
              }}
            />
            <div className="deployment-variable-paste-actions">
              <button
                type="button"
                className="button secondary compact"
                disabled={!pasted.trim()}
                onClick={applyPaste}
              >
                Fill these values
              </button>
              {pasteResult && (
                <span className="control-muted" role="status">
                  {pasteResult}
                </span>
              )}
            </div>
          </details>
        </div>
      )}
      <p className="deployment-variable-warning">
        Values entered here are stored with the deployment and visible to
        authorized users. For credentials, use a device secret instead:{" "}
        <code>vectory-secret:NAME</code>{" "}
        <DocLink topic="resources" section="keep-credentials-on-the-device">
          How device secrets work
        </DocLink>
      </p>
    </section>
  );
}
