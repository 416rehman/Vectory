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
import {
  catalog,
  acceptsComponentInput,
  type Component,
  type Kind,
} from "./catalog";
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
  onAdd: (component: Component) => void;
  onClose: () => void;
  onImport: (kind: Kind) => void;
  error?: string;
}) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<Kind | "all">(location.kind || "all");
  const [position, setPosition] = useState(location.screen);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const available = useMemo(
    () =>
      catalog.filter((item) =>
        acceptsComponentInput(config, location.input, item),
      ),
    [config, location.input],
  );
  const matches = available.filter(
    (item) =>
      (kind === "all" || item.kind === kind) &&
      `${item.label} ${item.type} ${item.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
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
            if (event.key === "Enter" && matches.length) {
              event.preventDefault();
              onAdd(matches[0]);
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
      {location.input && (
        <p className="canvas-component-from">
          Connect from <code>{location.input}</code>
        </p>
      )}
      <nav aria-label="Component category">
        {kinds
          .filter((item) => !location.input || item.id !== "sources")
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
        {matches.map((item) => (
          <button
            type="button"
            className="canvas-component-result"
            key={`${item.kind}:${item.type}`}
            data-pipeline-category={item.kind}
            onClick={() => onAdd(item)}
          >
            <ComponentIcon type={item.type} kind={item.kind} size={25} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
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
          <p className="canvas-component-empty">
            No matching {location.input ? "compatible " : ""}components.
          </p>
        )}
      </div>
      <button
        type="button"
        className="canvas-component-import"
        onClick={() =>
          onImport(
            kind === "all" ? (location.input ? "transforms" : "sources") : kind,
          )
        }
      >
        <FileJson2 size={15} /> Import a component definition
      </button>
    </div>,
    document.body,
  );
}
