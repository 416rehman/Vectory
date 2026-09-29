import {
  ConnectionLineType,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type GetBezierPathParams,
} from "@xyflow/react";

export type ConnectionStyle = "curved" | "orthogonal" | "straight";
export type ConnectionPathParams = Omit<GetBezierPathParams, "curvature">;

/** Older or invalid local preferences keep the established curved appearance. */
export function normalizeConnectionStyle(value: unknown): ConnectionStyle {
  return value === "orthogonal" || value === "straight" ? value : "curved";
}

/** Step uses square corners; SmoothStep would introduce rounded elbows. */
export const connectionLineTypes: Record<ConnectionStyle, ConnectionLineType> =
  {
    curved: ConnectionLineType.Bezier,
    orthogonal: ConnectionLineType.Step,
    straight: ConnectionLineType.Straight,
  };

/** Path and label coordinates stay paired so edge actions follow every style. */
export function getConnectionPath(
  style: ConnectionStyle,
  endpoints: ConnectionPathParams,
) {
  switch (style) {
    case "orthogonal":
      return getSmoothStepPath({ ...endpoints, borderRadius: 0 });
    case "straight":
      return getStraightPath(endpoints);
    default:
      return getBezierPath({ ...endpoints, curvature: 0.3 });
  }
}

/** Decorative reconnect grips follow diagonal straight lines without crossing. */
export function connectionEndpointPositions(
  style: ConnectionStyle,
  endpoints: ConnectionPathParams,
) {
  let offsetX = 12;
  let offsetY = 0;
  if (style === "straight") {
    const dx = endpoints.targetX - endpoints.sourceX;
    const dy = endpoints.targetY - endpoints.sourceY;
    const distance = Math.hypot(dx, dy);
    const fraction = distance ? Math.min(12, distance / 3) / distance : 0;
    offsetX = dx * fraction;
    offsetY = dy * fraction;
  }
  return {
    source: { x: endpoints.sourceX + offsetX, y: endpoints.sourceY + offsetY },
    target: { x: endpoints.targetX - offsetX, y: endpoints.targetY - offsetY },
  };
}
