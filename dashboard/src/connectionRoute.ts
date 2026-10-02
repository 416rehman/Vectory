/**
 * Routing a connection around the cards in the columns it crosses.
 *
 * A line that skips a column would draw over its cards, and its rate label
 * would sit behind one. Such a line is routed instead: it leaves the source,
 * changes height in the gap before each crossed column, runs level through the
 * column between the cards, and arrives at the target. A line that is clear
 * keeps its ordinary shape. Nothing here is saved with the pipeline.
 */

export type Point = { x: number; y: number };
export type Card = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type Link = { id: string; source: string; target: string } & {
  from: Point;
  to: Point;
};
/** One crossed column: the level run through it. */
export type Lane = {
  left: number;
  right: number;
  y: number;
  /** Where along the run a rate label sits, from 0 to 1. */
  label: number;
};
export type RouteStyle = "curved" | "orthogonal";

/** How far a level run extends past the column into the gaps. */
const PAD = 20;
/** The least space between a level run and a card. */
export const CLEARANCE = 40;
/** The least space between two level runs in one column. */
export const LANE_SPACING = 34;
/** A line this close to a card counts as running behind it (labels need room). */
const MARGIN = 22;
/** Where successive labels in one column sit along their runs. */
const LABEL_SLOTS = [0.5, 0.2, 0.8];

/**
 * The point `share` of the way across a curve (0 is the source, 1 the target),
 * on the curve itself. A rate label sits a little before the middle, clear of
 * the arrowhead in a narrow gap.
 */
export function curvePoint(from: Point, to: Point, share: number): Point {
  const middle = (from.x + to.x) / 2;
  const x = (t: number) => {
    const u = 1 - t;
    return u ** 3 * from.x + 3 * u * t * middle + t ** 3 * to.x;
  };
  // Bisection: x grows with t for a curve that runs forward.
  let low = 0,
    high = 1;
  const wanted = from.x + (to.x - from.x) * share;
  for (let step = 0; step < 24; step++) {
    const t = (low + high) / 2;
    if (x(t) < wanted === to.x >= from.x) low = t;
    else high = t;
  }
  const t = (low + high) / 2,
    u = 1 - t;
  return {
    x: x(t),
    y:
      u ** 3 * from.y +
      3 * u * u * t * from.y +
      3 * u * t * t * to.y +
      t ** 3 * to.y,
  };
}

/** A curve with level tangents at both ends, as the canvas draws one. */
function bezier(from: Point, to: Point, steps = 40): Point[] {
  const middle = (from.x + to.x) / 2;
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps,
      u = 1 - t;
    return {
      x:
        u ** 3 * from.x +
        3 * u * t * u * middle +
        3 * u * t * t * middle +
        t ** 3 * to.x,
      y:
        u ** 3 * from.y +
        3 * u * t * u * from.y +
        3 * u * t * t * to.y +
        t ** 3 * to.y,
    };
  });
}
/** Points along a polyline, at most `spacing` apart. */
function along(points: Point[], spacing = 8): Point[] {
  const out: Point[] = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1],
      b = points[index];
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing),
    );
    for (let step = 1; step <= steps; step++)
      out.push({
        x: a.x + ((b.x - a.x) * step) / steps,
        y: a.y + ((b.y - a.y) * step) / steps,
      });
  }
  return out;
}
/** The line as the canvas draws it when nothing is in the way. */
export function plainPoints(style: RouteStyle, from: Point, to: Point) {
  if (style === "curved") return bezier(from, to);
  const middle = (from.x + to.x) / 2;
  return along([from, { x: middle, y: from.y }, { x: middle, y: to.y }, to]);
}

const covers = (points: Point[], card: Card, margin: number) =>
  points.some(
    (point) =>
      point.x > card.x - margin &&
      point.x < card.x + card.width + margin &&
      point.y > card.y - margin &&
      point.y < card.y + card.height + margin,
  );

/** Overlapping spans, merged, left to right. */
function bands(spans: [number, number][]) {
  const merged: [number, number][] = [];
  for (const [left, right] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && left <= last[1] + 2 * PAD) last[1] = Math.max(last[1], right);
    else merged.push([left, right]);
  }
  return merged;
}

/** The free height nearest `wanted`, given spans that are not free. */
function nearestFree(
  wanted: number,
  blocked: [number, number][],
  prefer: number,
) {
  const merged: [number, number][] = [];
  for (const [low, high] of [...blocked].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && low <= last[1]) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  const inside = merged.find(([low, high]) => wanted > low && wanted < high);
  if (!inside) return wanted;
  const [low, high] = inside;
  const up = wanted - low,
    down = high - wanted;
  if (Math.abs(up - down) < 1)
    return Math.abs(low - prefer) <= Math.abs(high - prefer) ? low : high;
  return up < down ? low : high;
}

/**
 * Lanes for every connection that would run behind a card, by connection id.
 * Connections that are clear are left out. Two lanes never share a height in
 * one column, and each connection is handled in the order of its ideal height
 * so the lanes keep their order.
 */
export function routeConnections(
  links: readonly Link[],
  cards: readonly Card[],
  style: RouteStyle = "curved",
) {
  const routes = new Map<string, Lane[]>();
  const pending: { link: Link; between: Card[]; ideal: number }[] = [];
  for (const link of links) {
    if (link.to.x <= link.from.x + 2 * PAD) continue;
    // The line is drawn once per connection, and only the cards near its
    // box are looked at: a pipeline of hundreds of steps is routed on every
    // keystroke.
    const line = plainPoints(style, link.from, link.to);
    const top = Math.min(link.from.y, link.to.y) - MARGIN,
      bottom = Math.max(link.from.y, link.to.y) + MARGIN;
    const near = cards.filter(
      (card) =>
        card.id !== link.source &&
        card.id !== link.target &&
        card.x + card.width + MARGIN > link.from.x &&
        card.x - MARGIN < link.to.x &&
        card.y + card.height + MARGIN > top &&
        card.y - MARGIN < bottom,
    );
    if (!near.some((card) => covers(line, card, MARGIN))) continue;
    // A level run may be moved up or down to a free height, so every card in
    // the columns between is avoided, not only the ones near the first line.
    const between = cards.filter(
      (card) =>
        card.id !== link.source &&
        card.id !== link.target &&
        card.x + card.width > link.from.x &&
        card.x < link.to.x,
    );
    if (between.length)
      pending.push({ link, between, ideal: (link.from.y + link.to.y) / 2 });
  }
  pending.sort(
    (a, b) => a.ideal - b.ideal || a.link.id.localeCompare(b.link.id),
  );
  const used = new Map<string, number[]>();
  for (const { link, between } of pending) {
    const lanes: Lane[] = [];
    let previous = link.from.y;
    for (const [left, right] of bands(
      between.map((card) => [card.x, card.x + card.width]),
    )) {
      const key = `${left}:${right}`,
        taken = used.get(key) ?? [];
      const wanted =
        link.from.y +
        ((link.to.y - link.from.y) * ((left + right) / 2 - link.from.x)) /
          (link.to.x - link.from.x);
      const y = nearestFree(
        wanted,
        [
          ...between
            .filter((card) => card.x < right && card.x + card.width > left)
            .map((card): [number, number] => [
              card.y - CLEARANCE,
              card.y + card.height + CLEARANCE,
            ]),
          ...taken.map((other): [number, number] => [
            other - LANE_SPACING,
            other + LANE_SPACING,
          ]),
        ],
        previous,
      );
      used.set(key, [...taken, y]);
      lanes.push({
        left,
        right,
        y,
        label: LABEL_SLOTS[taken.length % LABEL_SLOTS.length],
      });
      previous = y;
    }
    routes.set(link.id, lanes);
  }
  return routes;
}

/** The path through the lanes and where its rate label sits. */
export function routedPath(
  style: RouteStyle,
  from: Point,
  to: Point,
  lanes: readonly Lane[],
) {
  const ends = lanes.flatMap((lane) => [
    { x: lane.left - PAD, y: lane.y },
    { x: lane.right + PAD, y: lane.y },
  ]);
  const points = [from, ...ends, to];
  let d = `M${from.x},${from.y}`;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1],
      b = points[index];
    const level = index % 2 === 0 && index < points.length - 1;
    if (level || a.y === b.y) d += `L${b.x},${b.y}`;
    else if (style === "curved") {
      const reach = (b.x - a.x) / 2;
      d +=
        reach > 0
          ? `C${a.x + reach},${a.y} ${b.x - reach},${b.y} ${b.x},${b.y}`
          : `L${b.x},${b.y}`;
    } else {
      const middle = (a.x + b.x) / 2;
      d += `L${middle},${a.y}L${middle},${b.y}L${b.x},${b.y}`;
    }
  }
  const lane = lanes[Math.floor((lanes.length - 1) / 2)];
  const start = lane.left - PAD,
    run = lane.right + PAD - start;
  return { d, label: { x: start + run * lane.label, y: lane.y } };
}

/** The routed line as points, for checking what it passes. */
export function routedPoints(
  style: RouteStyle,
  from: Point,
  to: Point,
  lanes: readonly Lane[],
) {
  const stops = [
    from,
    ...lanes.flatMap((lane) => [
      { x: lane.left - PAD, y: lane.y },
      { x: lane.right + PAD, y: lane.y },
    ]),
    to,
  ];
  const out: Point[] = [stops[0]];
  for (let index = 1; index < stops.length; index++) {
    const a = stops[index - 1],
      b = stops[index];
    const level = index % 2 === 0 && index < stops.length - 1;
    out.push(
      ...(level || a.y === b.y
        ? along([a, b]).slice(1)
        : style === "curved"
          ? bezier(a, b, 24).slice(1)
          : along([
              a,
              { x: (a.x + b.x) / 2, y: a.y },
              { x: (a.x + b.x) / 2, y: b.y },
              b,
            ]).slice(1)),
    );
  }
  return out;
}
