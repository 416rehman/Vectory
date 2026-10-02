import { describe, expect, it } from "vitest";
import {
  CLEARANCE,
  curvePoint,
  LANE_SPACING,
  plainPoints,
  routeConnections,
  routedPath,
  routedPoints,
  type Card,
  type Link,
} from "./connectionRoute";

const card = (id: string, x: number, y: number, height = 184): Card => ({
  id,
  x,
  y,
  width: 300,
  height,
});
/** Three columns: a source, one card between, a destination. */
const columns = {
  source: card("source", 70, 300),
  between: card("between", 482, 300),
  target: card("target", 894, 300),
};
const link = (id: string, from: number, to: number): Link => ({
  id,
  source: "source",
  target: "target",
  from: { x: 370, y: from },
  to: { x: 894, y: to },
});
const cards = Object.values(columns);
const clearOf = (
  points: { x: number; y: number }[],
  list: Card[],
  margin = 10,
) =>
  list.every((item) =>
    points.every(
      (point) =>
        !(
          point.x > item.x - margin &&
          point.x < item.x + item.width + margin &&
          point.y > item.y - margin &&
          point.y < item.y + item.height + margin
        ),
    ),
  );

describe("a point on a curve", () => {
  it("is where the curve is, a share of the way across", () => {
    const from = { x: 100, y: 50 },
      to = { x: 512, y: 400 };
    const start = curvePoint(from, to, 0);
    expect(start.x).toBeCloseTo(100, 3);
    expect(start.y).toBeCloseTo(50, 3);
    const end = curvePoint(from, to, 1);
    expect(end.x).toBeCloseTo(512, 3);
    expect(end.y).toBeCloseTo(400, 3);
    const middle = curvePoint(from, to, 0.5);
    expect(middle.x).toBeCloseTo(306, 3);
    expect(middle.y).toBeCloseTo(225, 3);
    // A point before the middle has not turned as far.
    const before = curvePoint(from, to, 0.45);
    expect(before.x).toBeCloseTo(100 + 412 * 0.45, 3);
    expect(before.y).toBeGreaterThan(50);
    expect(before.y).toBeLessThan(225);
    // It lies on the curve the canvas draws.
    const nearest = Math.min(
      ...plainPoints("curved", from, to).map((point) =>
        Math.hypot(point.x - before.x, point.y - before.y),
      ),
    );
    expect(nearest).toBeLessThan(15);
  });
});

describe("routing a connection around cards", () => {
  it("leaves a clear connection in its ordinary shape", () => {
    const routes = routeConnections([link("clear", 100, 100)], cards);
    expect(routes.size).toBe(0);
    expect(routeConnections([link("far", 800, 800)], cards).size).toBe(0);
  });

  it("gives a connection that would run behind a card a level run past it", () => {
    const blocked = link("blocked", 390, 390);
    const routes = routeConnections([blocked], cards);
    const [lane] = routes.get("blocked")!;
    expect(routes.get("blocked")).toHaveLength(1);
    // The run covers the column and clears the card above or below it.
    expect(lane.left).toBe(482);
    expect(lane.right).toBe(782);
    const clear =
      lane.y <= columns.between.y - CLEARANCE ||
      lane.y >= columns.between.y + columns.between.height + CLEARANCE;
    expect(clear).toBe(true);
    expect(
      clearOf(
        routedPoints(
          "curved",
          blocked.from,
          blocked.to,
          routes.get("blocked")!,
        ),
        [columns.between],
      ),
    ).toBe(true);
  });

  it("chooses the side of the card nearer to where the line was going", () => {
    const [above] = routeConnections([link("a", 330, 330)], cards).get("a")!;
    const [below] = routeConnections([link("b", 450, 450)], cards).get("b")!;
    expect(above.y).toBeLessThan(columns.between.y);
    expect(below.y).toBeGreaterThan(columns.between.y + columns.between.height);
  });

  it("keeps two connections through one column apart", () => {
    const routes = routeConnections(
      [link("one", 380, 380), link("two", 392, 392), link("three", 404, 404)],
      cards,
    );
    const heights = ["one", "two", "three"].map((id) => routes.get(id)![0].y);
    for (let a = 0; a < heights.length; a++)
      for (let b = a + 1; b < heights.length; b++)
        expect(Math.abs(heights[a] - heights[b])).toBeGreaterThanOrEqual(
          LANE_SPACING,
        );
    // Their labels do not sit on top of each other along the run.
    const labels = ["one", "two", "three"].map(
      (id) => routes.get(id)![0].label,
    );
    expect(new Set(labels).size).toBe(3);
  });

  it("is the same every time", () => {
    const links = [link("one", 380, 380), link("two", 392, 392)];
    expect([...routeConnections(links, cards)]).toEqual([
      ...routeConnections([...links].reverse(), cards),
    ]);
  });

  it("passes every crossed column and keeps its label on a run", () => {
    const wide = [
      card("source", 70, 300),
      card("first", 482, 300),
      card("second", 894, 300),
      card("target", 1306, 300),
    ];
    const long: Link = {
      id: "long",
      source: "source",
      target: "target",
      from: { x: 370, y: 390 },
      to: { x: 1306, y: 390 },
    };
    const routes = routeConnections([long], wide);
    const lanes = routes.get("long")!;
    expect(lanes.map((lane) => lane.left)).toEqual([482, 894]);
    for (const style of ["curved", "orthogonal"] as const) {
      expect(
        clearOf(
          routedPoints(style, long.from, long.to, lanes),
          wide.filter((item) => !["source", "target"].includes(item.id)),
        ),
      ).toBe(true);
    }
    const { d, label } = routedPath("curved", long.from, long.to, lanes);
    expect(d.startsWith("M370,390")).toBe(true);
    expect(d.endsWith("1306,390")).toBe(true);
    const lane = lanes[0];
    expect(label.y).toBe(lane.y);
    expect(label.x).toBeGreaterThanOrEqual(lane.left - 20);
    expect(label.x).toBeLessThanOrEqual(lane.right + 20);
  });

  it("draws square corners for the right-angle style", () => {
    const blocked = link("blocked", 390, 390);
    const lanes = routeConnections([blocked], cards, "orthogonal").get(
      "blocked",
    )!;
    const { d } = routedPath("orthogonal", blocked.from, blocked.to, lanes);
    expect(d).not.toContain("C");
    expect(d.startsWith("M370,390L")).toBe(true);
  });

  it("does not route a connection that runs backwards or sits flush", () => {
    const backwards: Link = {
      id: "back",
      source: "source",
      target: "target",
      from: { x: 900, y: 390 },
      to: { x: 100, y: 390 },
    };
    expect(routeConnections([backwards], cards).size).toBe(0);
    expect(
      plainPoints("curved", { x: 0, y: 0 }, { x: 100, y: 0 }).length,
    ).toBeGreaterThan(2);
  });
});
