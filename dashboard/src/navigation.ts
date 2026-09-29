import {
  Activity,
  Bell,
  BookOpen,
  CalendarClock,
  CircleAlert,
  Home,
  Layers,
  Plus,
  Rocket,
  ScrollText,
  Server,
  Settings,
  SlidersHorizontal,
  UsersRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ShellInfo } from "./ui";

export type NavigationItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Go-to shortcut key pressed after "g". */
  key?: string;
};
export const primaryNavigation: NavigationItem[] = [
  { id: "overview", label: "Overview", icon: Home, key: "o" },
  { id: "configurations", label: "Pipelines", icon: Workflow, key: "p" },
  { id: "devices", label: "Devices", icon: Server, key: "d" },
  { id: "deployments", label: "Activity", icon: Activity, key: "a" },
];
export const sectionTabs: Record<string, NavigationItem[]> = {
  devices: [
    { id: "devices", label: "Devices", icon: Server },
    { id: "groups", label: "Groups", icon: Layers },
    { id: "policies", label: "Agent settings", icon: SlidersHorizontal },
  ],
  deployments: [
    { id: "deployments", label: "Deployments", icon: Rocket },
    { id: "schedules", label: "Schedules", icon: CalendarClock },
    { id: "issues", label: "Issues", icon: CircleAlert },
    { id: "audit", label: "Audit log", icon: ScrollText },
  ],
  settings: [
    { id: "settings", label: "General", icon: Settings },
    { id: "users", label: "People & security", icon: UsersRound },
    { id: "notifications", label: "Notifications", icon: Bell },
  ],
};
const sectionLabels: Record<string, string> = {
  overview: "Overview",
  configurations: "Pipelines",
  devices: "Devices",
  deployments: "Activity",
  settings: "Settings",
};
export function sectionOf(page: string) {
  if (["devices", "groups", "policies", "enrollment"].includes(page))
    return "devices";
  if (sectionTabs.deployments.some((tab) => tab.id === page))
    return "deployments";
  if (sectionTabs.settings.some((tab) => tab.id === page)) return "settings";
  return page;
}

/** What PageHeader needs to place the breadcrumb and section tabs. */
export function shellInfo(page: string, id?: string): ShellInfo {
  const section = sectionOf(page);
  const tabs = id ? [] : sectionTabs[section] || [];
  return {
    sectionLabel: sectionLabels[section] || "",
    sectionHref: `#/${section === "settings" ? "settings" : section}`,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      icon: tab.icon,
      href: `#/${tab.id}`,
    })),
    currentTab: id ? undefined : page,
    tabsLabel:
      section === "devices"
        ? "Device sections"
        : section === "deployments"
          ? "Activity sections"
          : "Settings sections",
  };
}

/** Browser tab title for a route before its page names itself. */
export function routeTitle(page: string) {
  const tab = Object.values(sectionTabs)
    .flat()
    .find((item) => item.id === page);
  const label =
    page === "enrollment"
      ? "Add device"
      : tab?.label || sectionLabels[page] || "Page not found";
  const section = sectionLabels[sectionOf(page)];
  return [label, section && section !== label ? section : "", "Vectory"]
    .filter(Boolean)
    .join(" · ");
}

export type PageEntry = {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  keywords: string;
  /** Hidden unless the user may operate devices. */
  operate?: boolean;
};
export const pageEntries: PageEntry[] = [
  {
    id: "overview",
    name: "Overview",
    description: "Fleet health and what needs you",
    icon: Home,
    keywords: "home dashboard status health",
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
    description: "Device health, versions and telemetry",
    icon: Server,
    keywords: "fleet metrics agent hosts",
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
    description: "Check-in interval, metrics and sync pause",
    icon: SlidersHorizontal,
    keywords: "policy pause resume interval heartbeat",
  },
  {
    id: "enrollment",
    name: "Add device",
    description: "Download, install and enroll an agent",
    icon: Plus,
    keywords: "installation onboarding token enrollment",
    operate: true,
  },
  {
    id: "deployments",
    name: "Deployments",
    description: "Rollout progress, assignments and rollback",
    icon: Rocket,
    keywords: "activity deploy release canary rollout",
  },
  {
    id: "schedules",
    name: "Schedules",
    description: "Upcoming and past scheduled deployments",
    icon: CalendarClock,
    keywords: "activity schedule scheduled deployment",
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
    keywords: "activity history audit events security sign-in",
  },
  {
    id: "settings",
    name: "Settings",
    description: "Instance information and general settings",
    icon: Settings,
    keywords: "server general version instance",
  },
  {
    id: "users",
    name: "People & security",
    description: "Access, passwords, two-factor and sessions",
    icon: UsersRound,
    keywords: "users roles account MFA two factor recovery code sessions",
  },
  {
    id: "notifications",
    name: "Notifications",
    description: "Slack, webhook and email alerts, and detection thresholds",
    icon: Bell,
    keywords:
      "alerts alerting slack webhook email smtp channel quiet hours delivery log detection thresholds",
  },
  {
    id: "docs/",
    name: "Help center",
    description: "Guides and reference, in a new tab",
    icon: BookOpen,
    keywords: "documentation support vector help docs",
  },
];
