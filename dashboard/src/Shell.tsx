import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import {
  Compass,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X,
} from "lucide-react";
import type { User } from "./api";
import { primaryNavigation, type NavigationItem } from "./navigation";
import {
  Button,
  EmptyState,
  IconButton,
  Kbd,
  Modal,
  PageHeader,
  Skeleton,
  Tooltip,
  shortcutLabel,
} from "./ui";
import "./shell.css";

function NavLink({
  item,
  current,
  collapsed,
  onNavigate,
}: {
  item: NavigationItem;
  current: boolean;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const link = (
    <a
      href={`#/${item.id}`}
      className="sidebar-item"
      aria-current={current ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      onClick={onNavigate}
    >
      <item.icon size={17} strokeWidth={1.8} aria-hidden="true" />
      <span className="sidebar-label">{item.label}</span>
    </a>
  );
  return (
    <Tooltip
      content={item.label}
      side="right"
      shortcut={item.key ? ["G", item.key.toUpperCase()] : undefined}
      disabled={!collapsed}
    >
      {link}
    </Tooltip>
  );
}

export function Sidebar({
  brand,
  section,
  collapsed,
  mobile,
  mobileOpen,
  navigationRef,
  accountMenu,
  onSearch,
  onToggleCollapsed,
  onClose,
}: {
  brand: ReactNode;
  section: string;
  collapsed: boolean;
  mobile: boolean;
  mobileOpen: boolean;
  navigationRef: RefObject<HTMLElement | null>;
  accountMenu: ReactNode;
  onSearch: (opener: HTMLElement) => void;
  onToggleCollapsed: () => void;
  onClose: () => void;
}) {
  const rail = collapsed && !mobile;
  const search = (
    <button
      type="button"
      className="sidebar-search"
      aria-label="Search"
      aria-keyshortcuts={
        shortcutLabel(["mod", "K"]).includes("⌘") ? "Meta+K" : "Control+K"
      }
      onClick={(event) => onSearch(event.currentTarget)}
    >
      <Search size={15} aria-hidden="true" />
      <span>Search…</span>
      <Kbd keys={["mod", "K"]} />
    </button>
  );
  return (
    <aside
      id="main-navigation"
      ref={navigationRef}
      className="sidebar"
      role={mobileOpen ? "dialog" : undefined}
      aria-modal={mobileOpen ? true : undefined}
      aria-label="Navigation"
    >
      <div className="sidebar-heading">
        <a
          className="brand-link"
          href="#/overview"
          aria-label="Vectory overview"
        >
          {brand}
        </a>
        <IconButton
          className="sidebar-close"
          icon={X}
          label="Close navigation"
          onClick={onClose}
        />
      </div>
      <Tooltip
        content="Search"
        side="right"
        shortcut={["mod", "K"]}
        disabled={!rail}
      >
        {search}
      </Tooltip>
      <nav aria-label="Main navigation">
        {primaryNavigation.map((item) => (
          <NavLink
            key={item.id}
            item={item}
            current={section === item.id}
            collapsed={rail}
            onNavigate={() => {
              if (mobile) onClose();
            }}
          />
        ))}
      </nav>
      <div className="sidebar-bottom">
        {!mobile && (
          <Tooltip
            content={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            side="right"
            shortcut={["["]}
          >
            <button
              type="button"
              className="sidebar-item sidebar-collapse"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              aria-controls="main-navigation"
              aria-keyshortcuts="["
              onClick={onToggleCollapsed}
            >
              {collapsed ? (
                <PanelLeftOpen size={17} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <PanelLeftClose
                  size={17}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              )}
              <span className="sidebar-label">Collapse</span>
              <Kbd keys="[" />
            </button>
          </Tooltip>
        )}
        {accountMenu}
      </div>
    </aside>
  );
}

export function MobileHeader({
  title,
  expanded,
  toggleRef,
  initials,
  onToggle,
  onSearch,
  onAccount,
}: {
  title: string;
  expanded: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
  initials: string;
  onToggle: () => void;
  onSearch: (opener: HTMLElement) => void;
  onAccount: () => void;
}) {
  return (
    <header className="mobile-header">
      <button
        ref={toggleRef}
        type="button"
        className="icon-button"
        aria-label="Open navigation"
        aria-expanded={expanded}
        aria-controls="main-navigation"
        onClick={onToggle}
      >
        <Menu size={19} aria-hidden="true" />
      </button>
      <span className="mobile-header-title" aria-hidden="true">
        {title}
      </span>
      <IconButton
        icon={Search}
        label="Search"
        onClick={(event) => onSearch(event.currentTarget)}
      />
      <button
        type="button"
        className="mobile-avatar"
        aria-label="Your account"
        onClick={onAccount}
      >
        <span className="account-initial" aria-hidden="true">
          {initials}
        </span>
      </button>
    </header>
  );
}

export function initialsFor(user: User) {
  return (user.name.trim() || user.email)
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase();
}

export function NotFound({ onSearch }: { onSearch: () => void }) {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        variant="first-run"
        icon={Compass}
        title="This link doesn’t lead anywhere"
        action={
          <a className="button" href="#/overview">
            Go to Overview
          </a>
        }
        secondaryAction={
          <Button variant="secondary" onClick={onSearch}>
            Search <Kbd keys={["mod", "K"]} />
          </Button>
        }
      >
        It may be outdated or mistyped. Search for the page, device or pipeline
        you need.
      </EmptyState>
    </>
  );
}

/** The page frame while a lazy page loads, so the header doesn't jump. */
export function PageSkeleton({
  title,
  editor,
}: {
  title: string;
  editor?: boolean;
}) {
  if (editor)
    return (
      <div
        className="page-skeleton-editor"
        role="status"
        aria-label="Loading pipeline"
      >
        <Skeleton width="100%" height="100%" radius={0} />
      </div>
    );
  return (
    <div role="status" aria-label={`Loading ${title}`}>
      <PageHeader title={title} />
      <div className="page-skeleton-toolbar">
        <Skeleton width={320} height={32} radius={6} />
      </div>
      <div className="table-card page-skeleton-card">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="page-skeleton-row">
            <Skeleton width={`${34 - (index % 3) * 6}%`} height={12} />
            <Skeleton width="18%" height={12} />
            <Skeleton width="12%" height={12} />
          </div>
        ))}
      </div>
    </div>
  );
}

export const shortcutGroups: {
  title: string;
  items: [string[][], string][];
}[] = [
  {
    title: "Anywhere",
    items: [
      [[["mod", "K"]], "Search and run commands"],
      [[["?"]], "Show keyboard shortcuts"],
      [[["/"]], "Search this page"],
      [[["R"]], "Refresh this page’s data"],
      [[["["]], "Collapse or expand the sidebar"],
      [[["Esc"]], "Close a dialog or menu"],
    ],
  },
  {
    title: "Go to",
    items: primaryNavigation.map(
      (item) =>
        [[["G"], [item.key!.toUpperCase()]], item.label] as [
          string[][],
          string,
        ],
    ),
  },
  {
    title: "In search",
    items: [
      [[["up"], ["down"]], "Move between results"],
      [[["enter"]], "Open the result"],
      [[["mod", "enter"]], "Open in a new tab"],
    ],
  },
];

export function KeyboardShortcuts({
  open,
  onClose,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Keyboard shortcuts"
      description="Shortcuts work when you aren’t typing in a field."
      size="sm"
      className="shortcut-sheet"
      initialFocus="none"
    >
      <div className="modal-body">
        {shortcutGroups.map((group) => (
          <section key={group.title} className="shortcut-group">
            <h3>{group.title}</h3>
            <dl>
              {group.items.map(([keys, label]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {keys.map((combo, index) => (
                      <span key={index} className="shortcut-keys">
                        {index > 0 && (
                          <span className="shortcut-then">then</span>
                        )}
                        <Kbd keys={combo} />
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    !!target.closest(
      "input, textarea, select, [contenteditable='true'], .cm-editor, .react-flow, [role='combobox'], [role='menu'], [role='listbox']",
    ));

/**
 * Single-key shortcuts: ? sheet, / search, R refresh, [ sidebar, g + key to go.
 * They never fire while typing, inside the canvas, or while a dialog is open.
 */
export function useGlobalShortcuts({
  enabled,
  onPalette,
  onShortcuts,
  onToggleSidebar,
  navigate,
}: {
  enabled: boolean;
  onPalette: () => void;
  onShortcuts: () => void;
  onToggleSidebar: () => void;
  navigate: (path: string) => void;
}) {
  const handlers = useRef({
    onPalette,
    onShortcuts,
    onToggleSidebar,
    navigate,
  });
  handlers.current = { onPalette, onShortcuts, onToggleSidebar, navigate };
  useEffect(() => {
    if (!enabled) return;
    let goPending = 0;
    const key = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        handlers.current.onPalette();
        return;
      }
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        typing(event.target) ||
        document.querySelector('[role="dialog"], [role="menu"]')
      )
        return;
      const now = Date.now();
      if (goPending && now - goPending < 1200) {
        goPending = 0;
        const item = primaryNavigation.find(
          (entry) => entry.key === event.key.toLowerCase(),
        );
        if (item) {
          event.preventDefault();
          handlers.current.navigate(item.id);
        }
        return;
      }
      if (event.key === "g" || event.key === "G") {
        goPending = now;
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        handlers.current.onShortcuts();
      } else if (event.key === "[") {
        event.preventDefault();
        handlers.current.onToggleSidebar();
      } else if (event.key === "/") {
        const search = document.querySelector<HTMLInputElement>(
          "#main-content [data-page-search], #main-content .page-toolbar .search-field input",
        );
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
      } else if (event.key === "r" || event.key === "R") {
        const refresh = document.querySelector<HTMLButtonElement>(
          "#main-content [data-live-refresh]:not(:disabled)",
        );
        if (refresh) {
          event.preventDefault();
          refresh.click();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled]);
}
