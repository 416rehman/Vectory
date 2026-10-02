import { formatRate, type LiveTable as LiveTableData } from "./liveGraph";

/**
 * What the canvas draws as widths, chips and cards, as two plain tables:
 * every step's reading and every connection's rate. A person who cannot see
 * the lines, or wants the exact numbers, finds them here.
 */
export default function LiveTable({ table }: { table: LiveTableData }) {
  const flow = (
    value: number | null,
    applies: boolean,
    unit = "/s",
  ): React.ReactNode =>
    applies ? (
      formatRate(value, unit)
    ) : (
      <>
        <span aria-hidden="true">–</span>
        <span className="sr-only">does not apply</span>
      </>
    );
  return (
    <details className="editor-live-table">
      <summary>Show as table</summary>
      <div
        className="editor-live-table-scroll"
        role="region"
        aria-label="Live numbers as tables"
        tabIndex={0}
      >
        <table>
          <caption>Steps</caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">In</th>
              <th scope="col">Out</th>
              <th scope="col">Errors</th>
              <th scope="col">Dropped</th>
              <th scope="col">Buffer</th>
            </tr>
          </thead>
          <tbody>
            {table.steps.map((step) => (
              <tr key={step.id}>
                <th scope="row">
                  <code>{step.id}</code>
                  <small>{step.title}</small>
                </th>
                {step.reading ? (
                  <>
                    <td>
                      {flow(step.reading.received, step.kind !== "sources")}
                    </td>
                    <td>{flow(step.reading.sent, step.kind !== "sinks")}</td>
                    <td>{formatRate(step.reading.errors, "/min")}</td>
                    <td>{formatRate(step.reading.dropped, "/min")}</td>
                    <td>
                      {step.reading.buffer === null
                        ? "—"
                        : `${Math.round(step.reading.buffer * 100)}%`}
                    </td>
                  </>
                ) : (
                  <td colSpan={5}>No device reports this step</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <table>
          <caption>Connections</caption>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Events</th>
            </tr>
          </thead>
          <tbody>
            {table.connections.map((connection) => (
              <tr key={connection.id}>
                <th scope="row">
                  <code>{connection.from}</code>
                </th>
                <td>
                  <code>{connection.to}</code>
                </td>
                <td>
                  {connection.rate === null
                    ? "no data"
                    : formatRate(connection.rate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
