import { describe, expect, it } from "vitest";
import { betweenKeys, pageSearch, shortcutGroups } from "./Shell";
import { primaryNavigation } from "./navigation";

describe("the keyboard shortcut sheet", () => {
  const items = shortcutGroups.flatMap((group) => group.items);

  it("lists / as the way to search a page", () => {
    const anywhere = shortcutGroups.find((group) => group.title === "Anywhere");
    expect(anywhere?.items).toContainEqual([[["/"]], "Search this page"]);
  });

  it("joins up and down as a choice, not a sequence", () => {
    const [keys, label, between] = items.find(
      ([, text]) => text === "Move between results",
    )!;
    expect(keys).toEqual([["up"], ["down"]]);
    expect(betweenKeys(between)).toBe("/");
    expect(betweenKeys("or")).toBe("/");
  });

  it("keeps G then a letter a sequence for every place it goes", () => {
    const places = shortcutGroups.find((group) => group.title === "Go to")!;
    expect(places.items).toHaveLength(primaryNavigation.length);
    for (const [keys, , between] of places.items) {
      expect(keys).toHaveLength(2);
      expect(keys[0]).toEqual(["G"]);
      expect(betweenKeys(between)).toBe("then");
    }
  });

  it("joins no other keys with a word that is not 'then' or '/'", () => {
    for (const [keys, label, between] of items)
      if (keys.length > 1)
        expect(["then", "/"], label).toContain(betweenKeys(between));
  });
});

type Box = { disabled: boolean; visible: boolean; name: string };
/** A page with these search boxes, listed by the selector that finds them. */
function page(found: Record<string, Box[]>) {
  return {
    querySelectorAll: (selector: string) =>
      (found[selector] ?? []).map((box) => ({
        ...box,
        getClientRects: () => (box.visible ? [{}] : []),
      })),
  } as unknown as ParentNode;
}
const marked = "#main-content [data-page-search]";
const toolbar = "#main-content .page-toolbar .search-field input";
const any = "#main-content .search-field input";
const open = (name: string): Box => ({ name, disabled: false, visible: true });

describe("the search box / goes to", () => {
  it("prefers the one the page marked, then a toolbar's, then any on the page", () => {
    expect(
      (
        pageSearch(
          page({
            [marked]: [open("a")],
            [toolbar]: [open("b")],
            [any]: [open("c")],
          }),
        ) as never as Box
      ).name,
    ).toBe("a");
    expect(
      (
        pageSearch(
          page({ [toolbar]: [open("b")], [any]: [open("c")] }),
        ) as never as Box
      ).name,
    ).toBe("b");
    expect(
      (pageSearch(page({ [any]: [open("c")] })) as never as Box).name,
    ).toBe("c");
  });

  it("skips boxes that are hidden or disabled, and is none on a page without one", () => {
    const hidden = { ...open("hidden"), visible: false };
    const disabled = { ...open("disabled"), disabled: true };
    expect(
      (
        pageSearch(
          page({ [any]: [hidden, disabled, open("shown")] }),
        ) as never as Box
      ).name,
    ).toBe("shown");
    expect(pageSearch(page({ [any]: [hidden, disabled] }))).toBeNull();
    expect(pageSearch(page({}))).toBeNull();
  });
});
