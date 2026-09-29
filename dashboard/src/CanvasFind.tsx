import { useId, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { Config } from "./api";
import type { Kind } from "./catalog";
import { componentTitle } from "./pipelineNodeModel";

type FindNode = {
  id: string;
  data: {
    kind: Kind;
    component?: Config;
    enrichmentTable?: string;
    implicitSource?: boolean;
  };
};

/** Steps whose ID, name or Vector type contains the query, best first. */
export function findSteps(nodes: readonly FindNode[], query: string) {
  const needle = query.trim().toLowerCase();
  const scored = nodes.flatMap((node) => {
    const type = String(node.data.component?.type || "");
    const title = componentTitle(type, node.data.kind, {
      enrichmentTable: node.data.enrichmentTable,
      implicitSource: node.data.implicitSource,
    });
    const id = node.id.toLowerCase();
    const score = !needle
      ? 3
      : id === needle
        ? 0
        : id.startsWith(needle)
          ? 1
          : id.includes(needle)
            ? 2
            : `${title} ${type}`.toLowerCase().includes(needle)
              ? 3
              : -1;
    return score < 0 ? [] : [{ id: node.id, title, type, score }];
  });
  return scored
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, 8);
}

/** Ctrl/⌘ F on the canvas: jump to a step by ID, name or type. */
export default function CanvasFind({
  nodes,
  onFind,
  onClose,
}: {
  nodes: readonly FindNode[];
  onFind: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const results = useMemo(() => findSteps(nodes, query), [nodes, query]);
  const current = Math.min(active, Math.max(0, results.length - 1));
  return (
    <div className="canvas-find" role="search">
      <div className="canvas-find-field">
        <Search size={15} aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-label="Find a step"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={
            results[current] ? `${listId}-${current}` : undefined
          }
          placeholder="Find a step by ID, name or type"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (results.length)
                setActive(
                  (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    results.length) %
                    results.length,
                );
            } else if (event.key === "Enter" && results[current]) {
              event.preventDefault();
              onFind(results[current].id);
            }
          }}
        />
        <button type="button" aria-label="Close find" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <ul id={listId} role="listbox" aria-label="Matching steps">
        {results.map((result, index) => (
          <li
            key={result.id}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === current}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onFind(result.id)}
            onMouseEnter={() => setActive(index)}
          >
            <code>{result.id}</code>
            <span>{result.title}</span>
          </li>
        ))}
        {!results.length && (
          <li className="canvas-find-empty" role="presentation">
            No step matches “{query}”.
          </li>
        )}
      </ul>
    </div>
  );
}
