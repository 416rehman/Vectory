import { useState } from "react";
import type { Device, VariableDeclaration } from "./api";
import type { BindingInputs } from "./deploymentVariables";
import "./deployment-variable-fields.css";

function ValueInput({
  declaration,
  value,
  onChange,
  label,
}: {
  declaration: VariableDeclaration;
  value: string;
  onChange(value: string): void;
  label: string;
}) {
  return declaration.type === "boolean" ? (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Choose true or false</option>
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
      placeholder={declaration.type === "integer" ? "Whole number" : "Nonsecret value"}
    />
  );
}

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
  const [selectedId, setSelectedId] = useState("");
  const current = devices.find((device) => device.id === selectedId);
  const matching = devices.filter((device) =>
    `${device.name} ${device.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  const choices = matching.slice(0, 100);
  if (current && !choices.some((device) => device.id === current.id))
    choices.unshift(current);
  const overridden = devices.filter((device) =>
    Object.keys(inputs.devices[device.id] || {}).some((name) =>
      declarations.some((declaration) => declaration.name === name),
    ),
  );

  function changeDefault(name: string, value: string | null) {
    const defaults = { ...inputs.defaults };
    if (value === null) delete defaults[name];
    else defaults[name] = value;
    onChange({ ...inputs, defaults });
  }
  function changeOverride(deviceId: string, name: string, value: string | null) {
    const devicesInput = { ...inputs.devices };
    const deviceValues = { ...(devicesInput[deviceId] || {}) };
    if (value === null) delete deviceValues[name];
    else deviceValues[name] = value;
    if (Object.keys(deviceValues).length) devicesInput[deviceId] = deviceValues;
    else delete devicesInput[deviceId];
    onChange({ ...inputs, devices: devicesInput });
  }

  return (
    <section className="deployment-variable-fields" aria-label="Values by device">
      <div className="deployment-variable-heading">
        <h3>Values by device</h3>
        <p>
          Set each value for all selected devices, then customize individual
          devices where needed. {persistent && "Future group members use the defaults."}
        </p>
      </div>
      <div className="deployment-variable-defaults">
        {declarations.map((declaration) => {
          const enabled = Object.prototype.hasOwnProperty.call(inputs.defaults, declaration.name);
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
                    changeDefault(declaration.name, event.target.checked ? "" : null)
                  }
                />
                {persistent ? "Set required default" : "Set default for selected devices"}
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
      <details className="control-disclosure deployment-variable-overrides">
        <summary>Device overrides{overridden.length ? ` (${overridden.length})` : ""}</summary>
        <p>Only selected devices appear here. Overrides replace the default for that device.</p>
        <label className="deployment-variable-device-search">
          Find a selected device
          <input value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label className="deployment-variable-device-select">
          Device to customize
          <select value={current?.id || ""} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">Choose a device</option>
            {choices.map((device) => (
              <option key={device.id} value={device.id}>{device.name}</option>
            ))}
          </select>
        </label>
        {matching.length > 100 && (
          <p className="control-muted">Showing 100 matches. Search by name or device ID to narrow the list.</p>
        )}
        {current && (
          <div className="deployment-variable-device-values">
            <h4>{current.name}</h4>
            {declarations.map((declaration) => {
              const values = inputs.devices[current.id] || {};
              const enabled = Object.prototype.hasOwnProperty.call(values, declaration.name);
              return (
                <div key={declaration.name}>
                  <label className="deployment-variable-toggle">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(event) =>
                        changeOverride(current.id, declaration.name, event.target.checked ? "" : null)
                      }
                    />
                    Override {declaration.name}
                  </label>
                  {enabled && (
                    <ValueInput
                      declaration={declaration}
                      label={`${declaration.name} for ${current.name}`}
                      value={values[declaration.name]}
                      onChange={(value) => changeOverride(current.id, declaration.name, value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
        {overridden.length > 0 && (
          <p className="control-muted">
            Customized: {overridden.slice(0, 5).map((device) => device.name).join(", ")}
            {overridden.length > 5 ? ` and ${overridden.length - 5} more` : ""}
          </p>
        )}
      </details>
      <p className="deployment-variable-warning">
        Values entered here are stored with the deployment and visible to
        authorized users. For credentials, use a device-local Vector secret
        provider instead.
      </p>
    </section>
  );
}
