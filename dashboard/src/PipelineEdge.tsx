import { memo, useEffect } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  useStoreApi,
} from "@xyflow/react";
import { MoreHorizontal, Plus } from "lucide-react";
import {
  connectionEndpointPositions,
  getConnectionPath,
  normalizeConnectionStyle,
} from "./connectionStyle";
import { edgeWidth, formatRate } from "./liveGraph";
import "./pipeline-edge.css";
import "./live-graph.css";

function PipelineEdge(props: EdgeProps) {
  const connectionStyle = normalizeConnectionStyle(props.data?.connectionStyle);
  const [path, x, y] = getConnectionPath(connectionStyle, props);
  const endpoints = connectionEndpointPositions(connectionStyle, props);
  const onHoverChange = props.data?.onHoverChange as
    ((hovered: boolean) => void) | undefined;
  const openMenu = props.data?.openMenu as
    | ((position: { x: number; y: number }, opener: HTMLElement) => void)
    | undefined;
  const insertStep = props.data?.insertStep as
    ((position: { x: number; y: number }) => void) | undefined;
  // Live: undefined when off, null when no device reports this output.
  const rate = props.data?.liveRate as number | null | undefined;
  const live = rate !== undefined;
  // A wildcard input: a dashed, read-only line for each output it matches,
  // named by the pattern.
  const pattern = props.data?.pattern as string | undefined;
  const more = Number(props.data?.patternMore) || 0;
  if (pattern !== undefined)
    return (
      <>
        <BaseEdge
          id={props.id}
          path={path}
          data-connection-style={connectionStyle}
          className={`pipeline-edge-pattern${live && rate ? " pipeline-edge-flowing" : ""}`}
          markerEnd={props.markerEnd}
          style={props.style}
          interactionWidth={0}
        />
        <EdgeLabelRenderer>
          <span
            className="pipeline-edge-pattern-chip"
            title={`Wildcard input ${pattern}. Vector resolves it on each device.`}
            style={{
              transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
            }}
          >
            <code>{pattern}</code>
            {live && rate !== null && ` · ${formatRate(rate)}`}
            {more > 0 && ` · +${more} more`}
          </span>
        </EdgeLabelRenderer>
      </>
    );
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        data-connection-style={connectionStyle}
        className={
          live ? (rate ? "pipeline-edge-flowing" : "pipeline-edge-idle") : ""
        }
        markerEnd={props.markerEnd}
        style={
          live ? { ...props.style, strokeWidth: edgeWidth(rate) } : props.style
        }
        interactionWidth={26}
      />
      {live && !props.selected && (
        <EdgeLabelRenderer>
          <span
            className="pipeline-edge-rate"
            data-empty={rate === null || undefined}
            aria-hidden="true"
            style={{
              transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
            }}
          >
            {rate === null ? "no data" : formatRate(rate)}
          </span>
        </EdgeLabelRenderer>
      )}
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
          {insertStep && (
            <button
              type="button"
              className="pipeline-edge-insert nodrag nopan"
              style={{
                transform: `translate(-50%, -50%) translate(${x - 30}px, ${y}px)`,
              }}
              aria-label={`Insert a step between ${props.source} and ${props.target}`}
              title="Insert a step"
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                insertStep({ x: bounds.left, y: bounds.bottom + 6 });
              }}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          )}
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
