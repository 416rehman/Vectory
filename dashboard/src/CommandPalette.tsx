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
  Ban,
  BookOpen,
  CircleAlert,
  CopyPlus,
  CornerDownLeft,
  History,
  Keyboard,
  Layers,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Plus,
  Rocket,
  Search,
  Server,
  ShieldCheck,
  Sun,
  Undo2,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  can,
  changeCount,
  withRequestDeadline,
  type DeploymentPage,
  type DeviceInventoryPage,
  type GroupSummary,
  type PipelineLibraryPage,
  type User,
} from "./api";
import { helpHref } from "./DocLink";
import { runCommand } from "./commands";
import {
  addRecent,
  deviceSubtitle,
  highlightParts,
  kindLabels,
  parseRecents,
  rankEntries,
  recentStorageKey,
  type PaletteEntry,
  type PaletteKind,
  type RecentItem,
} from "./commandPaletteModel";
import { directoryAnswers } from "./directoryCache";
import { searchText } from "./deviceInventory";
import type { ListDevice } from "./deviceModel";
import { pageEntries } from "./navigation";
import {
  askedVerbs,
  deviceVerbs,
  pipelineVerbs,
  rolloutVerbs,
  wordsNamingThings,
  type Verb,
  type VerbEntry,
} from "./paletteVerbs";
import { deviceDisplayStatus, type StatusDomain } from "./status";
import { deploymentCounts, describeDeployment } from "./deploymentStatus";
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

/** What the palette knows without a query: small lists, never the fleet. */
type Directory = {
  groups: GroupSummary[];
  pipelines: PipelineLibraryPage["items"];
  deployments: DeploymentPage["items"];
  people: User[];
};
const emptyDirectory: Directory = {
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
/**
 * A directory read that opening the palette again within thirty seconds
 * reuses, unless something was changed from this browser in between. What a
 * person read is kept for that person (`userId`) only.
 */
async function readDirectory<T>(
  userId: string,
  path: string,
  signal: AbortSignal,
) {
  const key = `${userId} ${path}`;
  const known = directoryAnswers.recall<T>(key, Date.now(), changeCount());
  if (known !== undefined) return known;
  const changes = changeCount();
  const value = await read<T>(path, signal);
  directoryAnswers.remember(key, value, Date.now(), changes);
  return value;
}
/** Devices are found by the server, five at a time. */
const DEVICES_SHOWN = 5;

/**
 * Load the entities the palette can find: the small lists once per opening
 * (reused for 30 seconds), then the server's answers for each query. Devices
 * are never listed here; the server searches them.
 */
function useDirectory(open: boolean, query: string, user: User) {
  const [directory, setDirectory] = useState<Directory>(emptyDirectory);
  const [loading, setLoading] = useState(false);
  // The devices the server found for the text it was last asked about.
  const [found, setFound] = useState<{ text: string; devices: ListDevice[] }>({
    text: "",
    devices: [],
  });
  const admin = can(user, "admin");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setFound({ text: "", devices: [] });
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
      settle(
        "groups",
        readDirectory<GroupSummary[]>(
          user.id,
          "/groups?slim=1",
          controller.signal,
        ),
      ),
      settle(
        "pipelines",
        readDirectory<PipelineLibraryPage>(
          user.id,
          "/configurations/library?state=active&page_size=50",
          controller.signal,
        ).then((page) => page.items),
      ),
      settle(
        "deployments",
        readDirectory<DeploymentPage>(
          user.id,
          "/deployments/history?page_size=20",
          controller.signal,
        ).then((page) => page.items),
      ),
      admin
        ? settle(
            "people",
            readDirectory<User[]>(user.id, "/users", controller.signal),
          )
        : Promise.resolve(),
    ]).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open, admin, user.id]);
  const text = query.trim();
  // Devices: the server searches its inventory and answers with a few rows.
  useEffect(() => {
    if (!open || text.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // The server is asked about what is named: "show issues edge-1" looks
      // for "edge-1".
      read<DeviceInventoryPage>(
        `/devices/inventory?q=${encodeURIComponent(searchText(wordsNamingThings(text)))}&page_size=${DEVICES_SHOWN}`,
        controller.signal,
      )
        .then((page) =>
          setFound({ text, devices: page.items as unknown as ListDevice[] }),
        )
        .catch(() => {
          // The palette still works for everything else.
          if (!controller.signal.aborted) setFound({ text, devices: [] });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, text]);
  // Server-side search reaches pipelines and deployments beyond the first page.
  useEffect(() => {
    if (!open || text.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const search = encodeURIComponent(wordsNamingThings(text).slice(0, 200));
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
  }, [open, text]);
  // Waiting for the server's answer about the text now typed.
  const searching = open && text.length >= 2 && found.text !== text;
  return { directory, found, searching, loading };
}

const kindIcons: Record<RecentItem["kind"], LucideIcon> = {
  page: Search,
  device: Server,
  pipeline: Workflow,
  group: Layers,
  deployment: Rocket,
};
const verbIcons: Record<Verb, LucideIcon> = {
  pause: Pause,
  cancel: Ban,
  rollback: Undo2,
  deploy: Rocket,
  duplicate: CopyPlus,
  issues: CircleAlert,
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
  const { directory, found, searching, loading } = useDirectory(
    open,
    query,
    user,
  );
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
      ...found.devices.map((device): Item => ({
        key: `device:${device.id}`,
        kind: "device",
        title: device.name,
        subtitle: deviceSubtitle(device),
        keywords: Object.entries(device.labels || {})
          .flat()
          .join(" "),
        // Rows the server found for these very words stay; rows found for
        // earlier words stay only while they still match.
        matched: found.text === text,
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
        subtitle: `${group.member_count} ${group.member_count === 1 ? "device" : "devices"}`,
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
        // The same sentence and status as the Deployments list and its page.
        subtitle: `${deploymentCounts(deployment).sentence} · ${relativeTime(deployment.created_at)}`,
        keywords: `${deployment.configuration_name || ""} ${deployment.name || ""} deployment rollout`,
        icon: Rocket,
        href: `#/deployments/${deployment.id}`,
        status: {
          domain: "deployment",
          value: describeDeployment(deployment).state,
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
    // Verbs on what was found appear when the words typed ask for one ("pause
    // edge"); each opens what its page opens, and none acts on its own.
    const roles = { operate: can(user, "operate"), edit: can(user, "edit") };
    const verbs: Item[] = askedVerbs(text, [
      ...directory.deployments.flatMap((deployment) =>
        rolloutVerbs(deployment, deploymentTitle(deployment), roles),
      ),
      ...directory.pipelines.flatMap((pipeline) =>
        pipelineVerbs(pipeline, roles),
      ),
      ...found.devices.flatMap((device) => deviceVerbs(device)),
    ]).map((entry: VerbEntry): Item => {
      const { command, href } = entry;
      return {
        key: entry.key,
        kind: entry.kind,
        title: entry.title,
        subtitle: entry.subtitle,
        keywords: entry.keywords,
        icon: verbIcons[entry.verb],
        ...(command
          ? { run: () => runCommand(command.name, command.route) }
          : { href }),
      };
    });
    return [...pages, ...actions, ...verbs, ...entities];
  }, [
    query,
    recents,
    directory,
    found,
    user,
    currentPage,
    theme,
    sidebarCollapsed,
  ]);

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
  // Not "no results" while the server is still looking for devices.
  const noResults = query.trim() && !flat.length && !searching;
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
            {(loading || searching) && (
              <Spinner size={15} label="Loading results" />
            )}
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
