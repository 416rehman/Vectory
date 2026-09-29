/** Search, ranking and recents for the command palette (no React). */
export type PaletteKind =
  | "recent"
  | "page"
  | "action"
  | "device"
  | "pipeline"
  | "group"
  | "deployment"
  | "person";
export type PaletteEntry = {
  /** Stable identity such as "device:<uuid>" or "page:overview". */
  key: string;
  kind: PaletteKind;
  title: string;
  subtitle?: string;
  keywords?: string;
};
export type Range = [start: number, end: number];
export type Match = { score: number; ranges: Range[] };
export type RankedEntry<T extends PaletteEntry> = T & {
  score: number;
  ranges: Range[];
};

const boundary = (text: string, index: number) =>
  index === 0 || /[\s\-_./:·(]/.test(text[index - 1]);

/**
 * Score how well `query` matches `text`: prefix > word start > substring >
 * in-order characters. Returns highlight ranges, or null when it doesn't match.
 */
export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.trim().toLocaleLowerCase();
  const t = text.toLocaleLowerCase();
  if (!q) return { score: 0, ranges: [] };
  if (t.startsWith(q))
    return { score: 1000 - Math.min(t.length, 200), ranges: [[0, q.length]] };
  let index = t.indexOf(q);
  let best = -1;
  while (index >= 0) {
    if (boundary(t, index)) {
      best = index;
      break;
    }
    if (best < 0) best = index;
    index = t.indexOf(q, index + 1);
  }
  if (best >= 0)
    return {
      score: (boundary(t, best) ? 850 : 700) - Math.min(best, 100),
      ranges: [[best, best + q.length]],
    };
  // In-order characters, preferring word starts; gaps cost points.
  const ranges: Range[] = [];
  let position = 0,
    score = 500,
    previous = -2;
  for (const character of q) {
    if (character === " ") continue;
    let found = -1;
    for (let i = position; i < t.length; i++)
      if (t[i] === character && boundary(t, i)) {
        found = i;
        break;
      }
    if (found < 0) found = t.indexOf(character, position);
    if (found < 0) return null;
    score -= found === previous + 1 ? 0 : boundary(t, found) ? 4 : 12;
    if (ranges.length && ranges[ranges.length - 1][1] === found)
      ranges[ranges.length - 1][1] = found + 1;
    else ranges.push([found, found + 1]);
    previous = found;
    position = found + 1;
  }
  return score > 200 ? { score, ranges } : null;
}

/** Every query word must match the title or keywords; the title carries highlights. */
export function matchEntry(query: string, entry: PaletteEntry): Match | null {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, ranges: [] };
  const whole = fuzzyMatch(query, entry.title);
  if (whole && whole.score >= 700) return whole;
  const haystack =
    `${entry.subtitle || ""} ${entry.keywords || ""}`.toLocaleLowerCase();
  let score = 0;
  const ranges: Range[] = [];
  for (const word of words) {
    const inTitle = fuzzyMatch(word, entry.title);
    if (inTitle && inTitle.score >= 600) {
      score += inTitle.score;
      ranges.push(...inTitle.ranges);
    } else if (haystack.includes(word)) score += 300;
    else if (inTitle) {
      score += inTitle.score;
      ranges.push(...inTitle.ranges);
    } else return null;
  }
  return {
    score: score / words.length,
    ranges: mergeRanges(ranges),
  };
}

export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

const kindOrder: PaletteKind[] = [
  "recent",
  "page",
  "action",
  "device",
  "pipeline",
  "group",
  "deployment",
  "person",
];
export const kindLabels: Record<PaletteKind, string> = {
  recent: "Recent",
  page: "Pages",
  action: "Actions",
  device: "Devices",
  pipeline: "Pipelines",
  group: "Groups",
  deployment: "Deployments",
  person: "People",
};

/**
 * Rank entries for a query and group them in a fixed section order, keeping
 * at most `perKind` results per section. An empty query keeps input order.
 */
export function rankEntries<T extends PaletteEntry>(
  entries: T[],
  query: string,
  perKind = 5,
): { kind: PaletteKind; items: RankedEntry<T>[] }[] {
  const groups = new Map<PaletteKind, RankedEntry<T>[]>();
  entries.forEach((entry, index) => {
    const match = matchEntry(query, entry);
    if (!match) return;
    const list = groups.get(entry.kind) || [];
    list.push({
      ...entry,
      score: query.trim() ? match.score : -index,
      ranges: match.ranges,
    });
    groups.set(entry.kind, list);
  });
  return kindOrder
    .filter((kind) => groups.has(kind))
    .map((kind) => ({
      kind,
      items: groups
        .get(kind)!
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
        .slice(0, perKind),
    }));
}

/** Split a title into plain and highlighted parts for rendering. */
export function highlightParts(text: string, ranges: Range[]) {
  const parts: { text: string; match: boolean }[] = [];
  let position = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    if (start > position)
      parts.push({ text: text.slice(position, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    position = end;
  }
  if (position < text.length)
    parts.push({ text: text.slice(position), match: false });
  return parts;
}

export type RecentItem = {
  key: string;
  kind: Exclude<PaletteKind, "recent" | "action" | "person">;
  title: string;
  href: string;
};
const RECENT_LIMIT = 6;
export const recentStorageKey = (userId: string) =>
  `vectory-palette-recent:${userId}`;

/** Most recent first, unique by key, bounded, tolerant of damaged storage. */
export function addRecent(list: RecentItem[], item: RecentItem): RecentItem[] {
  return [item, ...list.filter((old) => old.key !== item.key)].slice(
    0,
    RECENT_LIMIT,
  );
}
export function parseRecents(raw: string | null): RecentItem[] {
  try {
    const value = JSON.parse(raw || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is RecentItem =>
          !!item &&
          typeof item.key === "string" &&
          typeof item.title === "string" &&
          typeof item.href === "string" &&
          /^#\/[A-Za-z0-9/?&=_.%-]*$/.test(item.href) &&
          ["page", "device", "pipeline", "group", "deployment"].includes(
            item.kind,
          ),
      )
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}
