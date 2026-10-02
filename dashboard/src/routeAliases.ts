/**
 * Other names for pages, so an address typed or remembered from another
 * product still opens the page. Each leads to the page's own address and keeps
 * what follows it: an id, a query. This module is read before sign-in, so it
 * imports nothing.
 */
const aliases: Readonly<Record<string, string>> = {
  pipelines: "configurations",
  // Activity opens on its first tab, Deployments.
  activity: "deployments",
  rollouts: "deployments",
};

/** `route` is the address after "#/", such as "rollouts/abc?status=failed". */
export function resolveRouteAlias(route: string): string {
  const match = /^([^/?#]+)([\s\S]*)$/.exec(route);
  if (!match) return route;
  const name = match[1].toLowerCase();
  return Object.hasOwn(aliases, name) ? `${aliases[name]}${match[2]}` : route;
}

/**
 * The page the address names, with another name for it resolved. The address
 * is rewritten to the page's own, so Back does not return to the alias.
 */
export function currentRoute(): string {
  const written = location.hash.slice(2) || "overview";
  const route = resolveRouteAlias(written);
  if (route !== written) history.replaceState(history.state, "", `#/${route}`);
  return route;
}
