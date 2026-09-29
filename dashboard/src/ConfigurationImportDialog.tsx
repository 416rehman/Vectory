import { useMemo, useState } from "react";
import { FileDiff } from "lucide-react";
import { structuredPatch } from "diff";
import type { Config } from "./api";
import { configurationDiff } from "./configurationDiff";
import { stringifyConfiguration } from "./configurationFormats";
import type { ConfigurationFormat } from "./configurationSource";
import { Button, ErrorBox, Field, Modal } from "./ui";
import "./configuration-import.css";

export type ConfigurationImport = {
  name: string;
  format: ConfigurationFormat;
  text: string;
  config: Config;
  before: Config;
};

function ordered(value: unknown): any {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, ordered(child)]),
    );
  return value;
}

function sourcePair(candidate: ConfigurationImport, format: string) {
  return {
    before: stringifyConfiguration(ordered(candidate.before), format),
    after: stringifyConfiguration(ordered(candidate.config), format),
  };
}

export default function ConfigurationImportDialog({
  candidate,
  onCancel,
  onConfirm,
}: {
  candidate: ConfigurationImport;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const initial = useMemo(() => {
    try {
      sourcePair(candidate, candidate.format);
      return { format: candidate.format, note: "" };
    } catch {
      return {
        format: "json" as ConfigurationFormat,
        note: "Showing JSON because TOML cannot represent every value in the current draft.",
      };
    }
  }, [candidate]);
  const [format, setFormat] = useState(initial.format);
  const [error, setError] = useState("");
  const differences = useMemo(
    () => configurationDiff(candidate.before, candidate.config),
    [candidate],
  );
  const preview = useMemo(() => {
    const pair = sourcePair(candidate, format);
    return {
      ...pair,
      patch: structuredPatch(
        "Current draft",
        candidate.name,
        pair.before + "\n",
        pair.after + "\n",
        undefined,
        undefined,
        { context: 3, timeout: 150, maxEditLength: 5000 },
      ),
    };
  }, [candidate, format]);
  return (
    <Modal
      open
      wide
      title="Replace pipeline from file?"
      description={`Review ${candidate.name} before replacing the current draft. You can undo this change.`}
      onClose={onCancel}
    >
      <div className="modal-body configuration-import-body">
        <div className="configuration-import-toolbar">
          <p>
            <FileDiff size={17} aria-hidden="true" />
            {differences.length} configuration{" "}
            {differences.length === 1 ? "change" : "changes"}
          </p>
          <Field label="Diff format">
            <select
              value={format}
              onChange={(event) => {
                try {
                  const next = event.target.value as ConfigurationFormat;
                  sourcePair(candidate, next);
                  setFormat(next);
                  setError("");
                } catch (failure) {
                  setError((failure as Error).message);
                }
              }}
            >
              <option value="yaml">YAML</option>
              <option value="json">JSON</option>
              <option value="toml">TOML</option>
            </select>
          </Field>
        </div>
        {initial.note && (
          <p className="configuration-import-note">{initial.note}</p>
        )}
        {error && <ErrorBox message={error} />}
        <div className="configuration-import-legend">
          <span className="removed">− Current draft</span>
          <span className="added">+ {candidate.name}</span>
        </div>
        {preview.patch ? (
          <div
            className="configuration-import-diff"
            role="region"
            aria-label="Configuration changes"
            tabIndex={0}
          >
            {preview.patch.hunks.map((hunk, index) => {
              let beforeLine = hunk.oldStart,
                afterLine = hunk.newStart;
              return (
                <div key={index} className="configuration-import-hunk">
                  <div className="configuration-import-context">
                    @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},
                    {hunk.newLines} @@
                  </div>
                  {hunk.lines
                    .filter((line) => !line.startsWith("\\"))
                    .map((line, row) => {
                      const added = line[0] === "+",
                        removed = line[0] === "-";
                      const oldNumber = added ? "" : beforeLine++,
                        newNumber = removed ? "" : afterLine++;
                      return (
                        <div
                          key={row}
                          className={`configuration-import-line ${added ? "added" : removed ? "removed" : ""}`}
                        >
                          <span aria-hidden="true">{oldNumber}</span>
                          <span aria-hidden="true">{newNumber}</span>
                          <code>{line}</code>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="configuration-import-full"
            role="region"
            aria-label="Configuration changes"
            tabIndex={0}
          >
            <p>
              The files differ extensively. Review both complete configurations.
            </p>
            <h3>Current draft</h3>
            <pre>{preview.before}</pre>
            <h3>{candidate.name}</h3>
            <pre>{preview.after}</pre>
          </div>
        )}
        <p className="configuration-import-note">
          Only configuration values are compared. Comments and layout are
          normalized. Runtime checks remain available through Check pipeline.
        </p>
      </div>
      <div className="modal-footer">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm}>Replace pipeline</Button>
      </div>
    </Modal>
  );
}
