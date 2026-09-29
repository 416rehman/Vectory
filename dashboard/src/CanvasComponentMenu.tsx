import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  X,
  FileJson2,
  LayoutGrid,
  ArrowDownToLine,
  Workflow,
  ArrowUpFromLine,
  type LucideIcon,
} from "lucide-react";
import { catalog, inputMismatch, type Component, type Kind } from "./catalog";
import type { Config } from "./api";
import { ComponentIcon } from "./PipelineNode";
import { IconButton } from "./ui";
import TabLabel from "./TabLabel";
import "./pipeline-categories.css";

export type CanvasPickerLocation = {
  screen: { x: number; y: number };
  position: { x: number; y: number };
  input: string;
  kind?: Kind;
  /** Insert on a connection: these consumers of `input` read the new step. */
  insertBefore?: string[];
  /** Steps at or right of this x move one column right to make room. */
  shiftFrom?: number;
};
const kinds: { id: Kind | "all"; label: string; icon: LucideIcon }[] = [
  { id: "all", label: "All", icon: LayoutGrid },
  { id: "sources", label: "Sources", icon: ArrowDownToLine },
  { id: "transforms", label: "Transforms", icon: Workflow },
  { id: "sinks", label: "Destinations", icon: ArrowUpFromLine },
];

export default function CanvasComponentMenu({
  location,
  config,
  onAdd,
  onClose,
  onImport,
  error,
}: {
  location: CanvasPickerLocation;
  config: Config;
  /** `input`: the output the new step reads, or "" for none. */
  onAdd: (component: Component, input: string) => void;
  onClose: () => void;
  onImport: (kind: Kind) => void;
  error?: string;
}) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<Kind | "all">(location.kind || "all");
  const [position, setPosition] = useState(location.screen);
  // Offered from a selection, the connection is optional; from a dragged
  // output or a connection it is what the person asked for.
  const [from, setFrom] = useState(location.input);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Steps that can't read the chosen output stay listed, greyed with the
  // reason, after the ones that can.
  const available = useMemo(
    () =>
      catalog
        .filter(
          (item) =>
            (!from || item.kind !== "sources") &&
            (!location.insertBefore?.length || item.kind === "transforms"),
        )
        .map((item) => ({ item, reason: inputMismatch(config, from, item) }))
        .sort((a, b) => Number(!!a.reason) - Number(!!b.reason)),
    [config, from],
  );
  const matches = available.filter(
    ({ item }) =>
      (kind === "all" || item.kind === kind) &&
      `${item.label} ${item.type} ${item.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const firstMatch = matches.find((match) => !match.reason)?.item;
  useLayoutEffect(() => {
    const bounds = menu.current?.getBoundingClientRect();
    if (bounds)
      setPosition({
        x: Math.max(
          12,
          Math.min(location.screen.x, window.innerWidth - bounds.width - 12),
        ),
        y: Math.max(
          12,
          Math.min(location.screen.y, window.innerHeight - bounds.height - 12),
        ),
      });
    input.current?.focus();
  }, [location]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target))
        close.current();
    };
    const resize = () => close.current();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return createPortal(
    <div
      ref={menu}
      className="canvas-component-menu"
      role="dialog"
      aria-label="Add component"
      style={{ left: position.x, top: position.y }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const results = Array.from(
            menu.current?.querySelectorAll<HTMLButtonElement>(
              ".canvas-component-result",
            ) || [],
          );
          if (!results.length) return;
          event.preventDefault();
          const current = results.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            current < 0
              ? event.key === "ArrowDown"
                ? 0
                : results.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  results.length) %
                results.length;
          results[next]?.focus();
        }
      }}
    >
      <div className="canvas-component-search">
        <Search size={17} aria-hidden="true" />
        <input
          ref={input}
          aria-label="Search components"
          placeholder="Search components…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && firstMatch) {
              event.preventDefault();
              onAdd(firstMatch, from);
            }
          }}
        />
        <IconButton icon={X} label="Close component menu" onClick={onClose} />
      </div>
      {error && (
        <p className="canvas-component-error" role="alert">
          {error}
        </p>
      )}
      {from && (
        <p className="canvas-component-from">
          {location.insertBefore?.length ? "Insert after" : "Connect from"}{" "}
          <code>{from}</code>
          {!location.insertBefore?.length && (
            <button type="button" onClick={() => setFrom("")}>
              Don&apos;t connect
            </button>
          )}
        </p>
      )}
      <nav aria-label="Component category">
        {kinds
          .filter(
            (item) =>
              (!from || item.id !== "sources") &&
              (!location.insertBefore?.length ||
                item.id === "all" ||
                item.id === "transforms"),
          )
          .map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={item.id === kind}
              data-pipeline-category={item.id === "all" ? undefined : item.id}
              onClick={() => setKind(item.id)}
            >
              <TabLabel icon={item.icon}>{item.label}</TabLabel>
            </button>
          ))}
      </nav>
      <div className="canvas-component-results">
        {matches.map(({ item, reason }) => (
          <button
            type="button"
            className="canvas-component-result"
            key={`${item.kind}:${item.type}`}
            data-pipeline-category={item.kind}
            aria-disabled={reason ? true : undefined}
            aria-description={reason || undefined}
            onClick={() => !reason && onAdd(item, from)}
          >
            <ComponentIcon type={item.type} kind={item.kind} size={25} />
            <span>
              <strong>
                {item.label} <code>{item.type}</code>
              </strong>
              <small>{reason || item.description}</small>
            </span>
            <span className="canvas-component-kind">
              {item.kind === "sources"
                ? "Source"
                : item.kind === "sinks"
                  ? "Destination"
                  : "Transform"}
            </span>
          </button>
        ))}
        {!matches.length && (
          <p className="canvas-component-empty">No matching components.</p>
        )}
      </div>
      <button
        type="button"
        className="canvas-component-import"
        onClick={() =>
          onImport(kind === "all" ? (from ? "transforms" : "sources") : kind)
        }
      >
        <FileJson2 size={15} /> Import a component definition
      </button>
    </div>,
    document.body,
  );
}
