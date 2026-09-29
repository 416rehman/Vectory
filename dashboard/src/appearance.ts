import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export type Appearance = "light" | "dark" | "auto";
export type ResolvedAppearance = Exclude<Appearance, "auto">;
export const APPEARANCE_STORAGE_KEY = "vectory-theme";
export const APPEARANCE_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function parseAppearance(value: unknown): Appearance {
  return value === "light" || value === "dark" ? value : "auto";
}

export function resolveAppearance(
  appearance: Appearance,
  systemDark: boolean,
): ResolvedAppearance {
  return appearance === "auto" ? (systemDark ? "dark" : "light") : appearance;
}

function readAppearance(): Appearance {
  try {
    return parseAppearance(window.localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
    return "auto";
  }
}

/** Apply an explicit preference once, or observe the OS only in automatic mode. */
export function observeAppearance(
  appearance: Appearance,
  apply: (theme: ResolvedAppearance) => void,
  media?: MediaQueryList,
): () => void {
  const update = () =>
    apply(resolveAppearance(appearance, media?.matches ?? false));
  update();
  if (appearance !== "auto" || !media) return () => {};
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }
  // Older browsers expose the legacy MediaQueryList listener methods.
  if (typeof media.addListener === "function") {
    media.addListener(update);
    return () => media.removeListener(update);
  }
  return () => {};
}

export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const [appearance, setAppearanceState] = useState<Appearance>(readAppearance);

  useLayoutEffect(() => {
    let media: MediaQueryList | undefined;
    try {
      if (appearance === "auto" && typeof window.matchMedia === "function")
        media = window.matchMedia(APPEARANCE_MEDIA_QUERY);
    } catch {
      // Automatic mode remains usable with a light fallback if media queries fail.
    }
    return observeAppearance(
      appearance,
      (theme) => {
        document.documentElement.dataset.theme = theme;
      },
      media,
    );
  }, [appearance]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return;
      try {
        const storage = window.localStorage;
        if (event.storageArea && event.storageArea !== storage) return;
        // Read the current value instead of replaying an older queued event over
        // a more recent choice. A storage clear/removal restores automatic mode.
        setAppearanceState(
          parseAppearance(storage.getItem(APPEARANCE_STORAGE_KEY)),
        );
      } catch {
        setAppearanceState(parseAppearance(event.newValue));
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);

  const setAppearance = useCallback((next: Appearance) => {
    const preference = parseAppearance(next);
    setAppearanceState(preference);
    try {
      // Persist the preference, never the OS-resolved result of automatic mode.
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, preference);
    } catch {
      // The current tab still applies the user's choice when persistence fails.
    }
  }, []);

  return [appearance, setAppearance];
}
