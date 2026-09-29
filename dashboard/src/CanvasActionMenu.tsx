import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import "./canvas-action-menu.css";

export type CanvasAction = {
  id: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export type CanvasActionMenuProps = {
  kind: "node" | "edge";
  title: string;
  position: { x: number; y: number };
  actions: readonly CanvasAction[];
  onClose: () => void;
  returnFocus?: HTMLElement | SVGElement | null;
};

/** A local action surface; all graph changes remain owned by the editor. */
export default function CanvasActionMenu({
  kind,
  title,
  position,
  actions,
  onClose,
  returnFocus,
}: CanvasActionMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(
    typeof document === "undefined" ? null : document.activeElement,
  );
  const callbacks = useRef({ onClose, returnFocus });
  callbacks.current = { onClose, returnFocus };
  const closed = useRef(false);
  const [placed, setPlaced] = useState(position);
  const [activeId, setActiveId] = useState<string | null>(null);
  const titleId = useId();

  function dismiss(restore: boolean) {
    if (closed.current) return;
    closed.current = true;
    if (restore) {
      const opener = callbacks.current.returnFocus ?? initialFocus.current;
      if (
        (opener instanceof HTMLElement || opener instanceof SVGElement) &&
        opener.isConnected &&
        opener.getClientRects().length &&
        getComputedStyle(opener).visibility !== "hidden"
      )
        opener.focus({ preventScroll: true });
    }
    callbacks.current.onClose();
  }

  useLayoutEffect(() => {
    closed.current = false;
    const element = menu.current;
    if (!element) return;
    const clamp = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      element.style.maxWidth = `${Math.max(24, width - 24)}px`;
      element.style.maxHeight = `${Math.max(24, height - 24)}px`;
      const bounds = element.getBoundingClientRect();
      const x = Math.max(
        left + 12,
        Math.min(
          Number.isFinite(position.x) ? position.x : left + 12,
          left + width - bounds.width - 12,
        ),
      );
      const y = Math.max(
        top + 12,
        Math.min(
          Number.isFinite(position.y) ? position.y : top + 12,
          top + height - bounds.height - 12,
        ),
      );
      setPlaced((previous) =>
        previous.x === x && previous.y === y ? previous : { x, y },
      );
    };
    clamp();
    const first = element.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    );
    (first ?? element).focus({ preventScroll: true });
    const resized = new ResizeObserver(clamp);
    resized.observe(element);
    window.addEventListener("resize", clamp);
    window.visualViewport?.addEventListener("resize", clamp);
    window.visualViewport?.addEventListener("scroll", clamp);
    const outside = (event: Event) => {
      const opener = callbacks.current.returnFocus;
      // An explicit menu button owns toggling and must survive pointerdown.
      if (
        event.target instanceof Node &&
        opener instanceof HTMLElement &&
        opener.matches('[aria-haspopup="menu"]') &&
        opener.contains(event.target)
      )
        return;
      if (event.target instanceof Node && !element.contains(event.target))
        dismiss(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => {
      resized.disconnect();
      window.removeEventListener("resize", clamp);
      window.visualViewport?.removeEventListener("resize", clamp);
      window.visualViewport?.removeEventListener("scroll", clamp);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
    };
  }, [position.x, position.y, kind, title]);

  const firstEnabled = actions.find((action) => !action.disabled)?.id;
  const activeExists = actions.some(
    (action) => action.id === activeId && !action.disabled,
  );

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-labelledby={titleId}
      aria-orientation="vertical"
      tabIndex={-1}
      className="canvas-action-menu nodrag nopan nowheel"
      data-kind={kind}
      style={{ left: placed.x, top: placed.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss(true);
          return;
        }
        if (event.key === "Tab") {
          // Return to the graph opener before the browser performs normal Tab traversal.
          dismiss(true);
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const buttons = Array.from(
          menu.current?.querySelectorAll<HTMLButtonElement>(
            'button[role="menuitem"]:not(:disabled)',
          ) ?? [],
        );
        if (!buttons.length) return;
        const current = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : current < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : buttons.length - 1
                : (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
        buttons[next].focus();
      }}
    >
      <div className="canvas-action-menu-heading" role="presentation">
        <span>{kind === "node" ? "Component" : "Connection"}</span>
        <strong id={titleId} title={title}>
          {title}
        </strong>
      </div>
      {actions.map(
        ({ id, label, icon: Icon, shortcut, danger, disabled, onSelect }) => (
          <button
            key={id}
            type="button"
            role="menuitem"
            data-action={id}
            className={danger ? "canvas-action-danger" : undefined}
            disabled={disabled}
            aria-disabled={disabled || undefined}
            tabIndex={
              !disabled && id === (activeExists ? activeId : firstEnabled)
                ? 0
                : -1
            }
            onFocus={() => setActiveId(id)}
            onClick={() => {
              if (disabled || closed.current) return;
              dismiss(true);
              onSelect();
            }}
          >
            {Icon ? (
              <Icon size={16} aria-hidden="true" />
            ) : (
              <span className="canvas-action-icon-space" aria-hidden="true" />
            )}
            <span className="canvas-action-label">{label}</span>
            {shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
