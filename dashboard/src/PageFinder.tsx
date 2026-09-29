import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  CircleAlert,
  Home,
  Layers,
  Plus,
  Rocket,
  ScrollText,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  UsersRound,
  Workflow,
} from "lucide-react";
import { can, type User } from "./api";
import "./page-finder.css";

const pages = [
  {
    id: "overview",
    name: "Overview",
    description: "Health and recent activity",
    icon: Home,
    keywords: "home dashboard status",
  },
  {
    id: "configurations",
    name: "Pipelines",
    description: "Build, check and publish Vector configurations",
    icon: Workflow,
    keywords: "configuration editor source transform sink draft",
  },
  {
    id: "devices",
    name: "Devices",
    description: "Device health, telemetry and assigned pipelines",
    icon: Server,
    keywords: "fleet metrics agent",
  },
  {
    id: "groups",
    name: "Device groups",
    description: "Organize devices and manage membership",
    icon: Layers,
    keywords: "fleet targets membership",
  },
  {
    id: "policies",
    name: "Agent settings",
    description: "Heartbeat and configuration sync policies",
    icon: SlidersHorizontal,
    keywords: "policy pause resume interval",
  },
  {
    id: "enrollment",
    name: "Add a device",
    description: "Download, install and enroll an agent",
    icon: Plus,
    keywords: "installation onboarding token enrollment",
  },
  {
    id: "deployments",
    name: "Deployments",
    description: "Rollout progress, assignments and rollback",
    icon: Rocket,
    keywords: "activity deploy release canary",
  },
  {
    id: "schedules",
    name: "Scheduled",
    description: "Upcoming and past scheduled deployments",
    icon: CalendarClock,
    keywords: "activity schedule deployment",
  },
  {
    id: "issues",
    name: "Issues",
    description: "Device problems and recovery actions",
    icon: CircleAlert,
    keywords: "activity errors failures drift troubleshoot",
  },
  {
    id: "audit",
    name: "Audit log",
    description: "Who changed what and when",
    icon: ScrollText,
    keywords: "activity history audit events",
  },
  {
    id: "settings",
    name: "Settings",
    description: "Instance information and general settings",
    icon: Settings,
    keywords: "server general version",
  },
  {
    id: "users",
    name: "People & security",
    description: "Account access, passwords and authenticators",
    icon: UsersRound,
    keywords: "users roles MFA two factor recovery code sessions",
  },
  {
    id: "docs/",
    name: "Help center",
    description: "Guides and reference · opens in a new tab",
    icon: BookOpen,
    keywords: "documentation support vector help",
  },
];

export default function PageFinder({
  user,
  currentPage,
  navigate,
}: {
  user: User;
  currentPage: string;
  navigate(path: string): void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const hintId = useId();
  const list = useRef<HTMLDivElement>(null);
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = pages.filter(
    (page) =>
      (page.id !== "enrollment" || can(user, "operate")) &&
      words.every((word) =>
        `${page.name} ${page.description} ${page.keywords}`
          .toLocaleLowerCase()
          .includes(word),
      ),
  );
  const index = Math.min(activeIndex, Math.max(0, matches.length - 1));
  const active = matches[index];
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);
  return (
    <div className="modal-body page-finder">
      <div className="search-field">
        <Search size={17} aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-label="Find a page"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search pages…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey
            )
              return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (matches.length)
                setActiveIndex(
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    matches.length) %
                    matches.length,
                );
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (active) navigate(active.id);
            }
          }}
        />
      </div>
      <div
        id={listId}
        ref={list}
        role="listbox"
        aria-label="Pages"
        className="page-finder-results"
      >
        {matches.map((item, itemIndex) => (
          <button
            key={item.id}
            id={`${listId}-${item.id}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={itemIndex === index}
            aria-label={`${item.name}${item.id === currentPage ? ", current page" : ""}`}
            aria-describedby={`${listId}-${item.id}-description`}
            onMouseMove={() => setActiveIndex(itemIndex)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => navigate(item.id)}
          >
            <item.icon size={18} aria-hidden="true" />
            <span>
              <strong>{item.name}</strong>
              <small id={`${listId}-${item.id}-description`}>
                {item.description}
              </small>
            </span>
            {item.id === currentPage ? (
              <small className="page-finder-current">Current</small>
            ) : (
              <ArrowRight size={15} aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
      {!matches.length && (
        <p className="page-finder-empty" role="status">
          No matching pages. Try “devices”, “pipelines” or “security”.
        </p>
      )}
      <p id={hintId} className="page-finder-hint">
        ↑ ↓ to browse <span>Enter to open</span>
        <span>Esc to close</span>
      </p>
    </div>
  );
}
