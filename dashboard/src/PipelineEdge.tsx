import { memo, useEffect } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  useStoreApi,
} from "@xyflow/react";
import { MoreHorizontal } from "lucide-react";
import {
  connectionEndpointPositions,
  getConnectionPath,
  normalizeConnectionStyle,
} from "./connectionStyle";
import "./pipeline-edge.css";

function PipelineEdge(props: EdgeProps) {
  const connectionStyle = normalizeConnectionStyle(props.data?.connectionStyle);
  const [path, x, y] = getConnectionPath(connectionStyle, props);
  const endpoints = connectionEndpointPositions(connectionStyle, props);
  const onHoverChange = props.data?.onHoverChange as
    ((hovered: boolean) => void) | undefined;
  const openMenu = props.data?.openMenu as
    | ((position: { x: number; y: number }, opener: HTMLElement) => void)
    | undefined;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        data-connection-style={connectionStyle}
        markerEnd={props.markerEnd}
        style={props.style}
        interactionWidth={26}
      />
      {props.selected && props.data?.editable === true && (
        <g
          className="pipeline-edge-endpoints"
          pointerEvents="none"
          aria-hidden="true"
        >
          <circle cx={endpoints.source.x} cy={endpoints.source.y} r={5} />
          <circle cx={endpoints.target.x} cy={endpoints.target.y} r={5} />
        </g>
      )}
      {props.selected && openMenu && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="pipeline-edge-actions nodrag nopan"
            data-connection-edge-id={props.id}
            data-connection-highlight={
              props.data?.connectionHighlight as string | undefined
            }
            onMouseEnter={() => onHoverChange?.(true)}
            onMouseLeave={() => onHoverChange?.(false)}
            style={{
              transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
            }}
            aria-label={`Connection actions for ${props.source} to ${props.target}`}
            title={
              props.data?.editable
                ? "Connection actions · Delete to disconnect"
                : "Connection properties"
            }
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              openMenu(
                { x: bounds.left, y: bounds.bottom + 6 },
                event.currentTarget,
              );
            }}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
export default memo(PipelineEdge);

/** Escape also works when starting an endpoint drag did not move keyboard focus. */
export function ConnectionCancellation({
  active,
  onCancel,
}: {
  active: boolean;
  onCancel: () => void;
}) {
  const store = useStoreApi();
  useEffect(() => {
    if (!active) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      store.getState().cancelConnection();
      store.setState({ connectionClickStartHandle: null });
      onCancel();
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [active, onCancel, store]);
  return null;
}
