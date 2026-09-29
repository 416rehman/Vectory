import { CircleX, TriangleAlert } from "lucide-react";
import type { Diagnostic } from "./runtimeModel";
import "./diagnostics.css";

const kinds = { source: "Source", transform: "Transform", sink: "Sink" };

/**
 * Redacted findings from Vector's own output, errors first. Every text field
 * was redacted on the device and validated by the server; render as text only.
 */
export default function DiagnosticList({
  diagnostics,
  label = "Vector findings",
}: {
  diagnostics: Diagnostic[];
  label?: string;
}) {
  if (!diagnostics.length) return null;
  return (
    <ul className="diagnostic-list" aria-label={label}>
      {diagnostics.map((diagnostic, index) => {
        const Icon = diagnostic.severity === "error" ? CircleX : TriangleAlert;
        return (
          <li
            key={`${index}:${diagnostic.code}`}
            className={`diagnostic ${diagnostic.severity}`}
          >
            <Icon className="diagnostic-icon" size={16} aria-hidden="true" />
            <div className="diagnostic-body">
              <p className="diagnostic-message">
                <span className="sr-only">
                  {diagnostic.severity === "error" ? "Error: " : "Warning: "}
                </span>
                {diagnostic.message}
              </p>
              {(diagnostic.component_id ||
                diagnostic.field ||
                diagnostic.line) && (
                <dl className="diagnostic-place">
                  {diagnostic.component_id && (
                    <div>
                      <dt>
                        {diagnostic.component_kind
                          ? kinds[diagnostic.component_kind]
                          : "Component"}
                      </dt>
                      <dd>
                        <code>
                          {diagnostic.route_output
                            ? `${diagnostic.component_id}.${diagnostic.route_output}`
                            : diagnostic.component_id}
                        </code>
                      </dd>
                    </div>
                  )}
                  {diagnostic.field && (
                    <div>
                      <dt>Field</dt>
                      <dd>
                        <code>{diagnostic.field}</code>
                      </dd>
                    </div>
                  )}
                  {diagnostic.line && (
                    <div>
                      <dt>Position</dt>
                      <dd>
                        {diagnostic.column
                          ? `Line ${diagnostic.line}, column ${diagnostic.column}`
                          : `Line ${diagnostic.line}`}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
              {diagnostic.hint && (
                <p className="diagnostic-hint">
                  <strong>Fix</strong> {diagnostic.hint}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
