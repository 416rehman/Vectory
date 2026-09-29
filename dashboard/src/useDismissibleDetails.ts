import { useEffect, type RefObject } from "react";

/** Popup menus dismiss on outside interaction; ordinary disclosure panels do not. */
export function useDismissibleDetails(
  ref: RefObject<HTMLElement | null>,
  selector?: string,
) {
  useEffect(() => {
    const openMenus = () => {
      const root = ref.current;
      const menus = selector
        ? Array.from(root?.querySelectorAll<HTMLDetailsElement>(selector) || [])
        : root instanceof HTMLDetailsElement
          ? [root]
          : [];
      return menus.filter((menu) => menu.open);
    };
    const outside = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      for (const menu of openMenus())
        if (!menu.contains(event.target)) menu.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const menus = openMenus();
      if (!menus.length) return;
      event.preventDefault();
      event.stopPropagation();
      for (const menu of menus) menu.open = false;
      menus.at(-1)?.querySelector("summary")?.focus({ preventScroll: true });
    };
    // Canvas libraries stop bubbling pointer events, so dismissal uses capture.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [ref, selector]);
}
