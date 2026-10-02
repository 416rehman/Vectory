import { describe, expect, it } from "vitest";
import {
  pageEntries,
  primaryNavigation,
  routeTitle,
  sectionOf,
  sectionTabs,
  shellInfo,
} from "./navigation";
import { resolveRouteAlias } from "./routeAliases";

const tabs = Object.values(sectionTabs).flat();

describe("navigation", () => {
  it("gives every sidebar entry and section tab a real title", () => {
    for (const item of [...primaryNavigation, ...tabs]) {
      const title = routeTitle(item.id);
      expect(title, item.id).not.toMatch(/^Page not found/);
      expect(title.endsWith(" · Vectory"), item.id).toBe(true);
    }
  });

  it("titles a section tab by its own label, then its section", () => {
    for (const [section, items] of Object.entries(sectionTabs))
      for (const tab of items) {
        const [label, ...rest] = routeTitle(tab.id).split(" · ");
        expect(label, tab.id).toBe(tab.label);
        expect(sectionOf(tab.id), tab.id).toBe(section);
        // "Deployments · Activity": the section's label follows the tab's.
        if (rest.length > 1)
          expect(rest[0], tab.id).toBe(shellInfo(tab.id).sectionLabel);
      }
    expect(routeTitle("groups")).toBe("Groups · Devices · Vectory");
    expect(routeTitle("issues")).toBe("Issues · Activity · Vectory");
    expect(routeTitle("users")).toBe("People & security · Settings · Vectory");
  });

  it("names pages outside the tabs and unknown routes", () => {
    expect(routeTitle("overview")).toBe("Overview · Vectory");
    expect(routeTitle("configurations")).toBe("Pipelines · Vectory");
    expect(routeTitle("enrollment")).toBe("Add device · Devices · Vectory");
    expect(routeTitle("nowhere")).toBe("Page not found · Vectory");
  });

  it("places every tab's page in a section whose shell lists it", () => {
    for (const tab of tabs) {
      const shell = shellInfo(tab.id);
      expect(shell.currentTab).toBe(tab.id);
      expect(shell.tabs.map((item) => item.id)).toContain(tab.id);
      expect(shell.tabs.find((item) => item.id === tab.id)?.href).toBe(
        `#/${tab.id}`,
      );
    }
    // A drill-down (a device, a rollout) shows a breadcrumb, not tabs.
    expect(shellInfo("devices", "a-device").tabs).toEqual([]);
  });

  it("lists every navigable page in the command palette", () => {
    const ids = new Set(pageEntries.map((entry) => entry.id));
    for (const item of [...primaryNavigation, ...tabs])
      expect(ids.has(item.id), item.id).toBe(true);
  });
});

describe("other names for pages", () => {
  it("lead to the page's own address and keep what follows", () => {
    for (const [written, page] of [
      ["pipelines", "configurations"],
      [
        "pipelines?search=syslog&state=archived",
        "configurations?search=syslog&state=archived",
      ],
      ["pipelines/abc", "configurations/abc"],
      ["pipelines/abc?panel=history", "configurations/abc?panel=history"],
      ["activity", "deployments"],
      ["activity?status=failed", "deployments?status=failed"],
      ["rollouts", "deployments"],
      ["rollouts/abc", "deployments/abc"],
      ["rollouts/abc?x=1", "deployments/abc?x=1"],
      ["Rollouts", "deployments"],
    ])
      expect(resolveRouteAlias(written), written).toBe(page);
  });

  it("leave real pages, unknown routes and look-alikes alone", () => {
    for (const route of [
      "overview",
      "configurations",
      "deployments/abc",
      "devices?q=pipelines",
      "pipelinesx",
      "my-pipelines",
      "docs/pipelines",
      "constructor",
      "__proto__",
      "toString",
      "",
    ])
      expect(resolveRouteAlias(route), route).toBe(route);
  });

  it("send Activity to the first tab of the Activity tab set, and every other name to a page that exists", () => {
    expect(resolveRouteAlias("activity")).toBe(sectionTabs.deployments[0].id);
    const pages = new Set([
      ...primaryNavigation.map((item) => item.id),
      ...tabs.map((tab) => tab.id),
    ]);
    for (const name of ["pipelines", "activity", "rollouts"])
      expect(pages.has(resolveRouteAlias(name)), name).toBe(true);
  });
});
