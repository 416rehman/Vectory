import { CircleX, TriangleAlert } from "lucide-react";
import { ago, when } from "./api";
import type { VectorLogGroup, VectorLogSummary } from "./runtimeModel";
import "./vector-log.css";

const order = (a: VectorLogGroup, b: VectorLogGroup) =>
  (a.level === b.level ? 0 : a.level === "error" ? -1 : 1) ||
  Date.parse(b.last_seen) - Date.parse(a.last_seen);

/**
 * Recent Vector WARN/ERROR log lines grouped on the device (redacted there).
 * Presentational: pass the device's `vector_log_summary`; undefined means the
 * agent does not report summaries.
 */
export default function VectorLogSummaryView({
  summary,
  heading = "Recent Vector warnings and errors",
}: {
  summary?: VectorLogSummary | null;
  heading?: string;
}) {
  const items = [...(summary?.items ?? [])].sort(order);
  const errors = items.filter((item) => item.level === "error").length;
  return (
    <section className="vector-log" aria-label={heading}>
      <div className="vector-log-heading">
        <h3>{heading}</h3>
        {summary && (
          <span>
            {items.length
              ? `${errors} ${errors === 1 ? "error" : "errors"}, ${items.length - errors} ${items.length - errors === 1 ? "warning" : "warnings"}`
              : "None"}{" "}
            · reported {ago(summary.reported_at).toLowerCase()}
          </span>
        )}
      </div>
      {!summary ? (
        <p className="vector-log-note">
          This agent does not report Vector log summaries. Run{" "}
          <code>vectory logs</code> on the device to read Vector's output.
        </p>
      ) : !items.length ? (
        <p className="vector-log-note">
          Vector has logged no warnings or errors in the last hour.
        </p>
      ) : (
        <ul className="vector-log-list">
          {items.map((item) => {
            const Icon = item.level === "error" ? CircleX : TriangleAlert;
            return (
              <li
                key={item.fingerprint}
                className={`vector-log-item ${item.level}`}
              >
                <Icon
                  className="vector-log-icon"
                  size={16}
                  aria-hidden="true"
                />
                <div>
                  <p className="vector-log-message">
                    <span className="sr-only">
                      {item.level === "error" ? "Error: " : "Warning: "}
                    </span>
                    {item.message}
                  </p>
                  <p className="vector-log-meta">
                    {item.component_id && (
                      <>
                        <code>{item.component_id}</code>
                        {item.component_type && (
                          <> {item.component_type.replaceAll("_", " ")}</>
                        )}
                        {" · "}
                      </>
                    )}
                    <strong>
                      {item.count.toLocaleString()}{" "}
                      {item.count === 1 ? "time" : "times"}
                    </strong>
                    {" · last "}
                    <time
                      dateTime={item.last_seen}
                      title={when(item.last_seen)}
                    >
                      {ago(item.last_seen).toLowerCase()}
                    </time>
                    {item.count > 1 && (
                      <>
                        {" · first "}
                        <time dateTime={item.first_seen}>
                          {when(item.first_seen)}
                        </time>
                      </>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {summary && items.length > 0 && (
        <p className="vector-log-note">
          Warnings and errors from the last hour, grouped by component and
          message; counts start when the agent starts. Messages are redacted on
          the device. Run <code>vectory logs</code> there for Vector's full
          output.
        </p>
      )}
    </section>
  );
}
