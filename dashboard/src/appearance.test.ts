import { describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  observeAppearance,
  parseAppearance,
  resolveAppearance,
  THEME_COLORS,
} from "./appearance";

function systemTheme(initial: boolean) {
  const events = new EventTarget();
  const media = {
    matches: initial,
    addEventListener: vi.fn((type: string, listener: EventListener) =>
      events.addEventListener(type, listener),
    ),
    removeEventListener: vi.fn((type: string, listener: EventListener) =>
      events.removeEventListener(type, listener),
    ),
  };
  return {
    media: media as unknown as MediaQueryList,
    set(dark: boolean) {
      media.matches = dark;
      events.dispatchEvent(new Event("change"));
    },
  };
}

describe("appearance preference and system theme", () => {
  it("preserves existing explicit choices and treats missing or invalid storage as automatic", () => {
    expect(parseAppearance("light")).toBe("light");
    expect(parseAppearance("dark")).toBe("dark");
    for (const value of [
      "auto",
      null,
      undefined,
      "",
      "system",
      "DARK",
      false,
      {},
    ])
      expect(parseAppearance(value)).toBe("auto");
  });
  it("resolves automatic mode without changing the saved preference", () => {
    expect(resolveAppearance("auto", true)).toBe("dark");
    expect(resolveAppearance("auto", false)).toBe("light");
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
  });
  it("tracks live OS changes in automatic mode and removes its listener on cleanup", () => {
    const system = systemTheme(false),
      apply = vi.fn();
    const stop = observeAppearance("auto", apply, system.media);
    expect(apply).toHaveBeenLastCalledWith("light");
    system.set(true);
    expect(apply).toHaveBeenLastCalledWith("dark");
    system.set(false);
    expect(apply).toHaveBeenLastCalledWith("light");
    expect(apply).toHaveBeenCalledTimes(3);
    stop();
    system.set(true);
    expect(apply).toHaveBeenCalledTimes(3);
    expect(system.media.removeEventListener).toHaveBeenCalledOnce();
  });
  it.each(["light", "dark"] as const)(
    "never subscribes to or follows the OS for explicit %s",
    (preference) => {
      const system = systemTheme(preference === "light"),
        apply = vi.fn();
      const stop = observeAppearance(preference, apply, system.media);
      system.set(true);
      system.set(false);
      stop();
      expect(apply).toHaveBeenCalledExactlyOnceWith(preference);
      expect(system.media.addEventListener).not.toHaveBeenCalled();
    },
  );
  it("falls back to light only for automatic mode when media queries are unavailable", () => {
    const apply = vi.fn();
    observeAppearance("auto", apply)();
    expect(apply).toHaveBeenLastCalledWith("light");
    observeAppearance("dark", apply)();
    expect(apply).toHaveBeenLastCalledWith("dark");
  });
  it("supports and cleans up the older MediaQueryList listener API", () => {
    const apply = vi.fn();
    let listener: (() => void) | undefined;
    const media = {
      matches: true,
      addListener: vi.fn((fn: () => void) => {
        listener = fn;
      }),
      removeListener: vi.fn(),
    };
    const stop = observeAppearance(
      "auto",
      apply,
      media as unknown as MediaQueryList,
    );
    expect(apply).toHaveBeenLastCalledWith("dark");
    media.matches = false;
    listener!();
    expect(apply).toHaveBeenLastCalledWith("light");
    stop();
    expect(media.removeListener).toHaveBeenCalledWith(listener);
  });
});

describe("applying a resolved theme", () => {
  it("sets the theme, the UA color scheme and every theme-color meta", () => {
    const metas = [0, 1].map(() => {
      const attributes: Record<string, string> = {};
      return {
        attributes,
        setAttribute: (name: string, value: string) => {
          attributes[name] = value;
        },
      };
    });
    const root = {
      documentElement: {
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
      },
      querySelectorAll: () => metas,
    };
    applyTheme("dark", root as unknown as Document);
    expect(root.documentElement.dataset.theme).toBe("dark");
    expect(root.documentElement.style.colorScheme).toBe("dark");
    expect(metas.map((meta) => meta.attributes.content)).toEqual([
      THEME_COLORS.dark,
      THEME_COLORS.dark,
    ]);
    applyTheme("light", root as unknown as Document);
    expect(root.documentElement.style.colorScheme).toBe("light");
    expect(metas[1].attributes.content).toBe(THEME_COLORS.light);
  });
});
