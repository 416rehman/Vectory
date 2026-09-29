import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSingleKey,
  parseSingleKeyShortcuts,
  setSingleKeyShortcuts,
  SINGLE_KEY_STORAGE_KEY,
  singleKeyShortcutsOn,
} from "./shortcutPreference";

afterEach(() => {
  setSingleKeyShortcuts(true);
  vi.unstubAllGlobals();
});

describe("single-key shortcuts preference", () => {
  it("stays on unless someone explicitly turned it off", () => {
    expect(parseSingleKeyShortcuts(null)).toBe(true);
    expect(parseSingleKeyShortcuts("on")).toBe(true);
    expect(parseSingleKeyShortcuts("garbage")).toBe(true);
    expect(parseSingleKeyShortcuts("off")).toBe(false);
  });

  it("remembers the choice in this browser", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    setSingleKeyShortcuts(false);
    expect(singleKeyShortcutsOn()).toBe(false);
    expect(stored.get(SINGLE_KEY_STORAGE_KEY)).toBe("off");
    setSingleKeyShortcuts(true);
    expect(stored.get(SINGLE_KEY_STORAGE_KEY)).toBe("on");
  });

  it("still applies when storage refuses to remember it", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("Storage disabled");
        },
      },
    });
    setSingleKeyShortcuts(false);
    expect(singleKeyShortcutsOn()).toBe(false);
  });

  it("treats only shortcuts without Ctrl or ⌘ as single-key ones", () => {
    expect(isSingleKey(["R"])).toBe(true);
    expect(isSingleKey(["G", "D"])).toBe(true);
    expect(isSingleKey(["mod", "K"])).toBe(false);
  });
});
