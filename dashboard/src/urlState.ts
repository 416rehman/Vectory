import { useCallback, useEffect, useRef, useState } from "react";

export type QueryValues = Record<string, string | number>;

/** Read `?a=1&b=x` against typed defaults; invalid or missing values fall back. */
export function parseQuery<T extends QueryValues>(
  search: string,
  defaults: T,
): T {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  const next = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const raw = params.get(key);
    if (raw === null) continue;
    const fallback = defaults[key];
    if (typeof fallback === "number") {
      const value = Number(raw);
      if (/^\d{1,9}$/.test(raw) && Number.isSafeInteger(value) && value > 0)
        next[key] = value as T[typeof key];
    } else next[key] = Array.from(raw).slice(0, 200).join("") as T[typeof key];
  }
  return next;
}

/** Serialize only non-default values, in a stable key order. */
export function serializeQuery<T extends QueryValues>(
  values: T,
  defaults: T,
  extra?: URLSearchParams,
): string {
  const params = new URLSearchParams(extra);
  for (const key of Object.keys(defaults)) {
    params.delete(key);
    const value = values[key];
    if (value !== defaults[key] && value !== "" && value !== undefined)
      params.set(key, String(value));
  }
  return params.toString();
}

const hashParts = () => {
  const hash = typeof location === "undefined" ? "" : location.hash.slice(1);
  const index = hash.indexOf("?");
  return {
    path: index < 0 ? hash : hash.slice(0, index),
    search: index < 0 ? "" : hash.slice(index + 1),
  };
};

/**
 * Keep a page's filters in its hash route (`#/devices?status=offline`) so views
 * can be shared and survive reloads. Updates replace history instead of adding
 * entries, and never trigger route navigation or remount the page.
 * `enabled: false` keeps the values in memory only, for a view the URL
 * doesn't name (a rollout opened in place rather than by its route).
 */
export function useHashQuery<T extends QueryValues>(
  defaults: T,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const defaultsRef = useRef(defaults);
  const path = useRef(hashParts().path);
  const [values, setValues] = useState<T>(() =>
    enabled ? parseQuery(hashParts().search, defaults) : defaults,
  );
  useEffect(() => {
    if (!enabled) return;
    const changed = () => {
      const current = hashParts();
      if (current.path !== path.current) return;
      setValues(parseQuery(current.search, defaultsRef.current));
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [enabled]);
  const update = useCallback(
    (patch: Partial<T>) => {
      setValues((previous) => {
        const next = { ...previous, ...patch };
        const current = hashParts();
        if (enabled && current.path === path.current) {
          const extra = new URLSearchParams(current.search);
          const query = serializeQuery(next, defaultsRef.current, extra);
          const target = `#${current.path}${query ? `?${query}` : ""}`;
          if (target !== location.hash)
            history.replaceState(history.state, "", target);
        }
        return next;
      });
    },
    [enabled],
  );
  const reset = useCallback(() => update(defaultsRef.current), [update]);
  return [values, update, reset] as const;
}
