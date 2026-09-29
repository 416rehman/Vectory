import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  BookOpen,
  CornerDownLeft,
  History,
  Keyboard,
  Layers,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Search,
  Server,
  ShieldCheck,
  Sun,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  can,
  withRequestDeadline,
  type DeploymentPage,
  type Device,
  type Group,
  type PipelineLibraryPage,
  type User,
} from "./api";
import { helpHref } from "./DocLink";
import { runCommand } from "./commands";
import {
  addRecent,
  highlightParts,
  kindLabels,
  parseRecents,
  rankEntries,
  recentStorageKey,
  type PaletteEntry,
  type PaletteKind,
  type RecentItem,
} from "./commandPaletteModel";
import { pageEntries } from "./navigation";
import { deviceDisplayStatus, type StatusDomain } from "./status";
import { describeDeployment } from "./deploymentStatus";
import { relativeTime } from "./time";
import { Kbd, Spinner, StatusBadge, useMediaQuery } from "./ui";
import "./command-palette.css";

type Item = PaletteEntry & {
  icon: LucideIcon;
  href?: string;
  external?: boolean;
  run?: () => void;
  status?: { domain: StatusDomain; value: string; label?: string };
  shortcut?: string[];
  current?: boolean;
  recent?: RecentItem;
};

export function readRecents(userId: string): RecentItem[] {
  try {
    return parseRecents(localStorage.getItem(recentStorageKey(userId)));
  } catch {
    return [];
  }
}
/** Remember a visited entity for the palette's Recent section. */
export function rememberRecent(userId: string, item: RecentItem) {
  try {
    localStorage.setItem(
      recentStorageKey(userId),
      JSON.stringify(addRecent(readRecents(userId), item)),
    );
  } catch {
    /* Recents are a convenience; storage may be unavailable. */
  }
}

type Directory = {
  devices: Device[];
  groups: Group[];
  pipelines: PipelineLibraryPage["items"];
  deployments: DeploymentPage["items"];
  people: User[];
};
const emptyDirectory: Directory = {
  devices: [],
  groups: [],
  pipelines: [],
  deployments: [],
  people: [],
};
const read = <T,>(path: string, signal: AbortSignal) =>
  withRequestDeadline(
    (inner) => api<T>(path, { signal: inner }),
    15000,
    signal,
  );

/** Load the entities the palette can find, once per opening, then per query. */
function useDirectory(open: boolean, query: string, user: User) {
  const [directory, setDirectory] = useState<Directory>(emptyDirectory);
  const [loading, setLoading] = useState(false);
  const admin = can(user, "admin");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    const settle = <K extends keyof Directory>(
      key: K,
      promise: Promise<Directory[K]>,
    ) =>
      promise
        .then((value) => {
          if (!controller.signal.aborted)
            setDirectory((old) => ({ ...old, [key]: value }));
        })
        .catch(() => {
          /* The palette still works for pages and actions. */
        });
    void Promise.all([
      settle("devices", read<Device[]>("/devices", controller.signal)),
      settle("groups", read<Group[]>("/groups", controller.signal)),
      settle(
        "pipelines",
        read<PipelineLibraryPage>(
          "/configurations/library?state=active&page_size=50",
          controller.signal,
        ).then((page) => page.items),
      ),
      settle(
        "deployments",
        read<DeploymentPage>(
          "/deployments/history?page_size=20",
          controller.signal,
        ).then((page) => page.items),
      ),
      admin
        ? settle("people", read<User[]>("/users", controller.signal))
        : Promise.resolve(),
    ]).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open, admin]);
  // Server-side search reaches pipelines and deployments beyond the first page.
  useEffect(() => {
    const text = query.trim();
    if (!open || text.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const search = encodeURIComponent(text.slice(0, 200));
      const merge = <K extends "pipelines" | "deployments">(
        key: K,
        items: Directory[K],
      ) =>
        setDirectory((old) => {
          const known = new Set(old[key].map((item) => item.id));
          return {
            ...old,
            [key]: [
              ...old[key],
              ...items.filter((item) => !known.has(item.id)),
            ],
          };
        });
      read<PipelineLibraryPage>(
        `/configurations/library?state=active&search=${search}&page_size=10`,
        controller.signal,
      )
        .then((page) => merge("pipelines", page.items))
        .catch(() => {});
      read<DeploymentPage>(
        `/deployments/history?search=${search}&page_size=10`,
        controller.signal,
      )
        .then((page) => merge("deployments", page.items))
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);
  return { directory, loading };
}

const kindIcons: Record<RecentItem["kind"], LucideIcon> = {
  page: Search,
  device: Server,
  pipeline: Workflow,
  group: Layers,
  deployment: Rocket,
};
const deploymentTitle = (item: DeploymentPage["items"][number]) =>
  item.policy
    ? item.name || "Agent settings"
    : `${item.configuration_name || item.name || "Pipeline deployment"}${
        item.version_number ? ` v${item.version_number}` : ""
      }`;

export default function CommandPalette({
  open,
  onOpenChange,
  user,
  currentPage,
  navigate,
  theme,
  onToggleTheme,
  onShowShortcuts,
  sidebarCollapsed,
  onToggleSidebar,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User;
  currentPage: string;
  navigate: (path: string) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onShowShortcuts: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<RecentItem[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const coarse = useMediaQuery("(pointer: coarse)");
  const { directory, loading } = useDirectory(open, query, user);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setRecents(readRecents(user.id));
  }, [open, user.id]);

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = pageEntries
      .filter((page) => !page.operate || can(user, "operate"))
      .map((page) => ({
        key: `page:${page.id}`,
        kind: "page",
        title: page.name,
        subtitle: page.description,
        keywords: page.keywords,
        icon: page.icon,
        href: page.id === "docs/" ? helpHref() : `#/${page.id}`,
        external: page.id === "docs/",
        current: page.id === currentPage,
      }));
    const actions: Item[] = [
      can(user, "edit") && {
        key: "action:create-pipeline",
        kind: "action",
        title: "Create pipeline",
        subtitle:
          "Start from a template, a blank canvas or an existing Vector config",
        keywords: "new pipeline configuration draft",
        icon: Plus,
        run: () => runCommand("pipeline.create", "configurations"),
      },
      can(user, "operate") && {
        key: "action:add-device",
        kind: "action",
        title: "Add device",
        subtitle: "Install and enroll an agent",
        keywords: "enroll install agent token new",
        icon: Plus,
        run: () => navigate("enrollment"),
      },
      can(user, "operate") && {
        key: "action:deploy",
        kind: "action",
        title: "Deploy a pipeline",
        subtitle: "Choose a pipeline, then its devices",
        keywords: "deploy release rollout ship version",
        icon: Rocket,
        run: () => navigate("configurations"),
      },
      can(user, "operate") && {
        key: "action:create-group",
        kind: "action",
        title: "Create group",
        subtitle: "Group devices for shared deployments",
        keywords: "new group devices",
        icon: Layers,
        run: () => runCommand("group.create", "groups"),
      },
      {
        key: "action:theme",
        kind: "action",
        title:
          theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        subtitle: "Appearance",
        keywords: "theme dark light appearance mode toggle",
        icon: theme === "dark" ? Sun : Moon,
        run: onToggleTheme,
      },
      onToggleSidebar && {
        key: "action:sidebar",
        kind: "action",
        title: sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar",
        subtitle: "Navigation",
        keywords: "sidebar navigation rail collapse expand",
        icon: sidebarCollapsed ? PanelLeftOpen : PanelLeftClose,
        shortcut: ["["],
        run: onToggleSidebar,
      },
      {
        key: "action:security",
        kind: "action",
        title: "View security activity",
        subtitle: "Sign-ins, account and access changes",
        keywords: "security sign-in login audit mfa password",
        icon: ShieldCheck,
        run: () => navigate("audit?scope=security"),
      },
      {
        key: "action:shortcuts",
        kind: "action",
        title: "Keyboard shortcuts",
        subtitle: "Every shortcut in one sheet",
        keywords: "keys hotkeys help keyboard",
        icon: Keyboard,
        shortcut: ["?"],
        run: onShowShortcuts,
      },
      {
        key: "action:help",
        kind: "action",
        title: "Open help center",
        subtitle: "Guides and reference, in a new tab",
        keywords: "docs documentation help support",
        icon: BookOpen,
        href: helpHref(),
        external: true,
      },
    ].filter(Boolean) as Item[];
    const text = query.trim();
    if (!text) {
      const recent: Item[] = recents.map((item) => ({
        key: `recent:${item.key}`,
        kind: "recent",
        title: item.title,
        subtitle: kindLabels[item.kind === "page" ? "page" : item.kind].replace(
          /s$/,
          "",
        ),
        icon: kindIcons[item.kind] || History,
        href: item.href,
        recent: item,
      }));
      return [...recent, ...pages, ...actions];
    }
    const entities: Item[] = [
      ...directory.devices.map((device): Item => ({
        key: `device:${device.id}`,
        kind: "device",
        title: device.name,
        subtitle:
          [device.os, device.arch].filter(Boolean).join(" / ") || "Device",
        keywords: Object.entries(device.labels || {})
          .flat()
          .join(" "),
        icon: Server,
        href: `#/devices/${device.id}`,
        status: { domain: "device", value: deviceDisplayStatus(device) },
        recent: {
          key: `device:${device.id}`,
          kind: "device",
          title: device.name,
          href: `#/devices/${device.id}`,
        },
      })),
      ...directory.pipelines.map((pipeline): Item => ({
        key: `pipeline:${pipeline.id}`,
        kind: "pipeline",
        title: pipeline.name,
        subtitle: pipeline.latest_version
          ? `Published v${pipeline.latest_version.number} · ${relativeTime(pipeline.latest_version.created_at)}`
          : "Draft only",
        keywords: pipeline.description,
        icon: Workflow,
        href: `#/configurations/${pipeline.id}`,
        recent: {
          key: `pipeline:${pipeline.id}`,
          kind: "pipeline",
          title: pipeline.name,
          href: `#/configurations/${pipeline.id}`,
        },
      })),
      ...directory.groups.map((group): Item => ({
        key: `group:${group.id}`,
        kind: "group",
        title: group.name,
        subtitle: `${group.device_ids.length} ${group.device_ids.length === 1 ? "device" : "devices"}`,
        keywords: group.description,
        icon: Layers,
        href: `#/groups?q=${encodeURIComponent(group.name)}`,
        recent: {
          key: `group:${group.id}`,
          kind: "group",
          title: group.name,
          href: `#/groups?q=${encodeURIComponent(group.name)}`,
        },
      })),
      ...directory.deployments.map((deployment): Item => ({
        key: `deployment:${deployment.id}`,
        kind: "deployment",
        title: deploymentTitle(deployment),
        subtitle: `${deployment.target_count} ${deployment.target_count === 1 ? "device" : "devices"} · ${relativeTime(deployment.created_at)}`,
        keywords: `${deployment.configuration_name || ""} ${deployment.name || ""} deployment rollout`,
        icon: Rocket,
        href: `#/deployments/${deployment.id}`,
        // The same words as the Deployments list ("Replaced", "Rolled back").
        status: {
          domain: "deployment",
          value: deployment.status,
          label: describeDeployment(deployment).label,
        },
        recent: {
          key: `deployment:${deployment.id}`,
          kind: "deployment",
          title: deploymentTitle(deployment),
          href: `#/deployments/${deployment.id}`,
        },
      })),
      ...directory.people.map((person): Item => ({
        key: `person:${person.id}`,
        kind: "person",
        title: person.name || person.email,
        subtitle: `${person.email} · ${person.role[0].toUpperCase()}${person.role.slice(1)}`,
        keywords: person.email,
        icon: UserRound,
        href: "#/users",
      })),
    ];
    return [...pages, ...actions, ...entities];
  }, [query, recents, directory, user, currentPage, theme, sidebarCollapsed]);

  const groups = useMemo(
    () => rankEntries(items, query, query.trim() ? 5 : 20),
    [items, query],
  );
  const flat = groups.flatMap((group) => group.items);
  const index = Math.min(active, Math.max(0, flat.length - 1));
  const current = flat[index];
  const optionId = (item: Item) =>
    `${listId}-${item.key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [current?.key]);

  function activate(item: Item | undefined, newTab = false) {
    if (!item) return;
    if (item.recent) rememberRecent(user.id, item.recent);
    else if (item.kind === "page" && item.href && !item.external)
      rememberRecent(user.id, {
        key: item.key,
        kind: "page",
        title: item.title,
        href: item.href,
      });
    if (item.href && (item.external || newTab)) {
      window.open(item.href, "_blank", "noopener,noreferrer");
      onOpenChange(false);
      return;
    }
    onOpenChange(false);
    if (item.run) item.run();
    else if (item.href) navigate(item.href.replace(/^#\//, ""));
  }
  const noResults = query.trim() && !flat.length;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="palette-overlay" />
        <Dialog.Content
          className="palette"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // A dialog opened from the palette (shortcut sheet) keeps focus.
            if (document.activeElement?.closest('[role="dialog"]')) return;
            const target = returnFocusRef.current;
            if (
              target &&
              target.isConnected &&
              !target.matches(":disabled") &&
              target.getClientRects().length > 0
            )
              target.focus();
            else if (document.activeElement === document.body)
              document.getElementById("main-content")?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Search Vectory</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search pages, devices, pipelines, groups and deployments, or run an
            action.
          </Dialog.Description>
          <div className="palette-search">
            <Search size={17} aria-hidden="true" />
            <input
              ref={input}
              role="combobox"
              aria-label="Search Vectory"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={current ? optionId(current) : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="Search pages, devices, pipelines, actions…"
              value={query}
              maxLength={200}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229 ||
                  event.altKey
                )
                  return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (flat.length)
                    setActive(
                      (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        flat.length) %
                        flat.length,
                    );
                } else if (event.key === "Home" && event.ctrlKey) {
                  event.preventDefault();
                  setActive(0);
                } else if (event.key === "End" && event.ctrlKey) {
                  event.preventDefault();
                  setActive(flat.length - 1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  activate(current, event.metaKey || event.ctrlKey);
                }
              }}
            />
            {loading && <Spinner size={15} label="Loading results" />}
            <kbd className="kbd palette-esc">Esc</kbd>
          </div>
          <div
            id={listId}
            ref={list}
            role="listbox"
            aria-label="Results"
            className="palette-results"
          >
            {groups.map((group) => (
              <div
                key={group.kind}
                role="group"
                aria-labelledby={`${listId}-${group.kind}`}
                className="palette-group"
              >
                <div
                  id={`${listId}-${group.kind}`}
                  className="palette-heading"
                  aria-hidden="true"
                >
                  {kindLabels[group.kind as PaletteKind]}
                </div>
                {group.items.map((item) => {
                  const position = flat.indexOf(item);
                  const selected = position === index;
                  return (
                    <button
                      key={item.key}
                      id={optionId(item)}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={selected}
                      aria-label={`${item.title}${item.current ? ", current page" : ""}`}
                      aria-describedby={
                        item.subtitle ? `${optionId(item)}-subtitle` : undefined
                      }
                      className="palette-item"
                      onMouseMove={() => {
                        if (!selected) setActive(position);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) =>
                        activate(item, event.metaKey || event.ctrlKey)
                      }
                    >
                      <span className="palette-item-icon" aria-hidden="true">
                        <item.icon size={16} />
                      </span>
                      <span className="palette-item-text">
                        <span className="palette-item-title">
                          {highlightParts(item.title, item.ranges).map(
                            (part, partIndex): ReactNode =>
                              part.match ? (
                                <mark key={partIndex}>{part.text}</mark>
                              ) : (
                                <span key={partIndex}>{part.text}</span>
                              ),
                          )}
                        </span>
                        {item.subtitle && (
                          <span
                            id={`${optionId(item)}-subtitle`}
                            className="palette-item-subtitle"
                          >
                            {item.subtitle}
                          </span>
                        )}
                      </span>
                      {item.status && (
                        <StatusBadge
                          domain={item.status.domain}
                          value={item.status.value}
                          label={item.status.label}
                        />
                      )}
                      {item.current && (
                        <span className="palette-item-current">Current</span>
                      )}
                      {item.shortcut && !coarse && <Kbd keys={item.shortcut} />}
                      {selected && !coarse && (
                        <CornerDownLeft
                          className="palette-item-enter"
                          size={14}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {noResults && (
              <div className="palette-empty">
                <strong>No results for “{query.trim()}”</strong>
                <span>Try a device name, a pipeline or a page.</span>
              </div>
            )}
          </div>
          <div className="sr-only" role="status" aria-live="polite">
            {query.trim()
              ? `${flat.length} ${flat.length === 1 ? "result" : "results"}`
              : ""}
          </div>
          {!coarse && (
            <div className="palette-footer" aria-hidden="true">
              <span>
                <Kbd keys="up" />
                <Kbd keys="down" /> Navigate
              </span>
              <span>
                <Kbd keys="enter" /> Open
              </span>
              <span>
                <Kbd keys={["mod", "enter"]} /> New tab
              </span>
              <span>
                <Kbd keys="esc" /> Close
              </span>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
