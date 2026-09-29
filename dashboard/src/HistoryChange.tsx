import { useEffect, useMemo, useState } from "react";
import { differencePath, type Difference } from "./configurationDiff";
import {
  historyDifferenceLines,
  historyDifferenceTotals,
  isProgramDifference,
} from "./historyDiff";
import { Button, ErrorBox } from "./ui";
import { DataTable } from "./DataTable";

export default function HistoryChange({
  difference,
  before,
  after,
}: {
  difference: Difference;
  before: string;
  after: string;
}) {
  const path = differencePath(difference.path);
  const { lines, error } = useMemo(() => {
    try {
      return { lines: historyDifferenceLines(difference), error: "" };
    } catch (failure) {
      return { lines: [], error: (failure as Error).message };
    }
  }, [difference]);
  const totals = useMemo(() => historyDifferenceTotals(lines), [lines]);
  const [visible, setVisible] = useState(80);
  useEffect(() => setVisible(80), [difference]);
  const status = {
    added: { marker: "+", label: "Added" },
    removed: { marker: "−", label: "Removed" },
    changed: { marker: "~", label: "Modified" },
  }[difference.kind];

  if (error)
    return (
      <li className="history-change">
        <div className="history-change-heading">
          <code>{path}</code>
        </div>
        <div className="history-diff-error">
          <ErrorBox message={error} />
        </div>
      </li>
    );

  return (
    <li className={`history-change history-change-${difference.kind}`}>
      <div className="history-change-heading">
        <code>{path}</code>
        <span className="history-change-status">
          <span aria-hidden="true">{status.marker}</span> {status.label}
        </span>
      </div>
      <div className="history-diff-meta">
        <span className="history-diff-versions">
          <span>− {before}</span>
          <span>+ {after}</span>
        </span>
        <span className="history-diff-totals">
          <span
            className="history-added"
            aria-label={`${totals.added} added lines`}
          >
            +{totals.added}
          </span>
          <span
            className="history-removed"
            aria-label={`${totals.removed} removed lines`}
          >
            −{totals.removed}
          </span>
        </span>
      </div>
      <DataTable
        variant="code"
        className="history-diff-table"
        scrollClassName="history-diff-scroll"
        label={`${path} diff`}
        data={lines.slice(0, visible)}
        rowKey={(_, index) => String(index)}
        rowClassName="history-diff-line"
        rowAttributes={(line) => ({
          "data-kind": line.kind,
          "data-before-line": line.beforeLine,
          "data-after-line": line.afterLine,
        })}
        columns={[
          {
            id: "old",
            header: (
              <>
                Old<span className="sr-only"> line number</span>
              </>
            ),
            className: "history-line-number",
            cell: (line) => line.beforeLine,
          },
          {
            id: "new",
            header: (
              <>
                New<span className="sr-only"> line number</span>
              </>
            ),
            className: "history-line-number",
            cell: (line) => line.afterLine,
          },
          {
            id: "change",
            header: <span className="sr-only">Change</span>,
            className: "history-line-marker",
            cell: (line) => (
              <>
                <span aria-hidden="true">
                  {line.kind === "added"
                    ? "+"
                    : line.kind === "removed"
                      ? "−"
                      : " "}
                </span>
                <span className="sr-only">
                  {line.kind === "added"
                    ? "Added"
                    : line.kind === "removed"
                      ? "Removed"
                      : "Unchanged"}
                </span>
              </>
            ),
          },
          {
            id: "value",
            header: isProgramDifference(difference) ? "Program" : "JSON value",
            className: "history-diff-code",
            cell: (line) => <code>{line.text || " "}</code>,
          },
        ]}
      />
      {lines.length > 80 && (
        <div className="history-diff-more">
          <span>
            {Math.min(visible, lines.length).toLocaleString()} of{" "}
            {lines.length.toLocaleString()} lines
          </span>
          {visible < lines.length && (
            <Button
              variant="ghost compact"
              onClick={() => setVisible((value) => value + 100)}
            >
              Show next {Math.min(100, lines.length - visible)} lines
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
