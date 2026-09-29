import { describe, expect, it } from "vitest";
import { ConnectionLineType, Position } from "@xyflow/react";
import {
  connectionEndpointPositions,
  connectionLineTypes,
  getConnectionPath,
  normalizeConnectionStyle,
  type ConnectionStyle,
} from "./connectionStyle";

const endpoints = {
  sourceX: 20,
  sourceY: 35,
  sourcePosition: Position.Right,
  targetX: 320,
  targetY: 195,
  targetPosition: Position.Left,
};

describe("canvas connection styles", () => {
  it("aligns straight-line grips with diagonal edges, including very short connections", () => {
    const diagonal = { sourceX: 0, sourceY: 0, targetX: 60, targetY: 80 };
    const grips = connectionEndpointPositions("straight", diagonal);
    expect(grips.source.x).toBeCloseTo(7.2);
    expect(grips.source.y).toBeCloseTo(9.6);
    expect(grips.target.x).toBeCloseTo(52.8);
    expect(grips.target.y).toBeCloseTo(70.4);
    expect(
      connectionEndpointPositions("straight", {
        ...diagonal,
        targetX: 3,
        targetY: 0,
      }),
    ).toEqual({
      source: { x: 1, y: 0 },
      target: { x: 2, y: 0 },
    });
    expect(
      connectionEndpointPositions("straight", {
        ...diagonal,
        targetX: 0,
        targetY: 0,
      }),
    ).toEqual({
      source: { x: 0, y: 0 },
      target: { x: 0, y: 0 },
    });
  });
  it("accepts only supported preference values and defaults old preferences safely", () => {
    for (const style of ["curved", "orthogonal", "straight"])
      expect(normalizeConnectionStyle(style)).toBe(style);
    for (const invalid of [null, undefined, "step", "ORTHOGONAL", {}, 1])
      expect(normalizeConnectionStyle(invalid)).toBe("curved");
  });

  it("uses the matching ReactFlow preview, including sharp rather than rounded elbows", () => {
    expect(connectionLineTypes).toEqual({
      curved: ConnectionLineType.Bezier,
      orthogonal: ConnectionLineType.Step,
      straight: ConnectionLineType.Straight,
    });
  });

  it("draws a direct line and places actions halfway between both handles", () => {
    const [path, x, y] = getConnectionPath("straight", endpoints);
    expect(path).toBe("M 20,35L 320,195");
    expect([x, y]).toEqual([170, 115]);
  });

  it("draws only axis-aligned sharp-corner segments for the electronic style", () => {
    const [path, x, y] = getConnectionPath("orthogonal", endpoints);
    expect(path).not.toMatch(/[CAS]/i);
    const commands = [...path.matchAll(/([MLQ])([^MLQ]+)/g)];
    let previous: number[] | undefined;
    for (const [, command, numbers] of commands) {
      const values = numbers
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      for (let index = 0; index < values.length; index += 2) {
        const point = values.slice(index, index + 2);
        if (previous && command !== "M")
          expect(point[0] === previous[0] || point[1] === previous[1]).toBe(
            true,
          );
        previous = point;
      }
      // At a zero-radius elbow, the quadratic control and end points coincide.
      if (command === "Q") expect(values.slice(0, 2)).toEqual(values.slice(2));
    }
    expect(previous).toEqual([endpoints.targetX, endpoints.targetY]);
    expect(x).toBeGreaterThanOrEqual(endpoints.sourceX);
    expect(x).toBeLessThanOrEqual(endpoints.targetX);
    expect(y).toBeGreaterThanOrEqual(endpoints.sourceY);
    expect(y).toBeLessThanOrEqual(endpoints.targetY);
  });

  it("keeps the established cubic curvature for backward-facing connections", () => {
    const [path, x, y] = getConnectionPath("curved", {
      ...endpoints,
      sourceX: 320,
      targetX: 20,
    });
    expect(path).toContain("C");
    const coordinates = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(coordinates.slice(0, 2)).toEqual([320, 35]);
    expect(coordinates.slice(-2)).toEqual([20, 195]);
    expect(coordinates[2]).toBeCloseTo(320 + 0.3 * 25 * Math.sqrt(300));
    expect([x, y].every(Number.isFinite)).toBe(true);
  });

  it("keeps coincident and reversed handles finite without mutating graph positions", () => {
    for (const style of Object.keys(connectionLineTypes) as ConnectionStyle[]) {
      for (const target of [
        { targetX: 20, targetY: 35 },
        { targetX: -90, targetY: -50 },
      ]) {
        const input = Object.freeze({ ...endpoints, ...target });
        const [path, ...position] = getConnectionPath(style, input);
        expect(path).not.toMatch(/NaN|Infinity/);
        expect(position.every(Number.isFinite)).toBe(true);
        expect(input.sourceX).toBe(20);
        expect(input.targetX).toBe(target.targetX);
      }
    }
  });
});
