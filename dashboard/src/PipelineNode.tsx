import { memo, useEffect, type CSSProperties } from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowRight,
  CircleX,
  Ellipsis,
  Unplug,
} from "lucide-react";
import type { Config } from "./api";
import type { Kind } from "./catalog";
import ComponentIcon from "./ComponentIcon";
import { formatRate, type NodeLive } from "./liveGraph";
import "./pipeline-categories.css";
import {
  componentSummary,
  componentTitle,
  nodeOutputPorts,
  PIPELINE_NODE_WIDTH,
  PIPELINE_NODE_BODY_HEIGHT,
  PIPELINE_NODE_HEADER_HEIGHT,
} from "./pipelineNodeModel";

export { ComponentIcon } from "./ComponentIcon";
export { componentSummary, componentTitle } from "./pipelineNodeModel";

const kindLabels: Record<Kind, string> = {
  sources: "Source",
  transforms: "Transform",
  sinks: "Destination",
};

/**
 * Events in and out per second, with errors, drops and buffer fill spelled
 * out (never color alone). Null: no device reports this step.
 */
function LiveReading({
  kind,
  reading,
}: {
  kind: Kind;
  reading: NodeLive | null;
}) {
  if (!reading)
    return (
      <p className="pipeline-node-live" data-empty>
        No device reports this step
      </p>
    );
  const flow = [
    kind !== "sources" && `in ${formatRate(reading.received)}`,
    kind !== "sinks" && `out ${formatRate(reading.sent)}`,
  ].filter(Boolean);
  const devices = `${reading.devices} ${reading.devices === 1 ? "device" : "devices"}`;
  return (
    <p
      className="pipeline-node-live"
      title={`${flow.join(", ")} across ${devices}${reading.filtered ? `; ${formatRate(reading.filtered, "/min")} filtered` : ""}`}
    >
      <span className="pipeline-node-live-flow">{flow.join(" · ")}</span>
      {!!reading.errors && (
        <span className="pipeline-node-live-badge" data-tone="error">
          <CircleX size={12} aria-hidden="true" />
          {formatRate(reading.errors, "/min")} errors
        </span>
      )}
      {!!reading.dropped && (
        <span className="pipeline-node-live-badge" data-tone="warning">
          {formatRate(reading.dropped, "/min")} dropped
        </span>
      )}
      {reading.buffer !== null && reading.buffer >= 0.01 && (
        <span
          className="pipeline-node-live-badge"
          data-tone={reading.buffer >= 0.8 ? "warning" : undefined}
        >
          buffer {Math.round(reading.buffer * 100)}%
        </span>
      )}
    </p>
  );
}

function PipelineNode({ id, data, selected, isConnectable }: NodeProps) {
  const kind: Kind =
    data.kind === "sources" || data.kind === "sinks" ? data.kind : "transforms";
  const component: Config =
    data.component &&
    typeof data.component === "object" &&
    !Array.isArray(data.component)
      ? data.component
      : {};
  const type = typeof component.type === "string" ? component.type : "";
  const label = typeof data.label === "string" ? data.label : id;
  const openMenu =
    typeof data.openMenu === "function"
      ? (data.openMenu as (
          position: { x: number; y: number },
          opener: HTMLElement,
        ) => void)
      : undefined;
  const context = {
    enrichmentTable:
      typeof data.enrichmentTable === "string"
        ? data.enrichmentTable
        : undefined,
    implicitSource: data.implicitSource === true,
  };
  const title = componentTitle(type, kind, context);
  const summary = componentSummary(component, kind, context);
  const ports = nodeOutputPorts(component, kind);
  const simpleOutput = ports.length === 1 && ports[0] === "output";
  const connectionActive = data.connectionActive === true && isConnectable;
  const validOutputs = new Set(
    Array.isArray(data.validOutputTargets)
      ? data.validOutputTargets.filter(
          (port): port is string => typeof port === "string",
        )
      : [],
  );
  function portState(valid: boolean): "idle" | "valid" | "invalid" {
    return connectionActive ? (valid ? "valid" : "invalid") : "idle";
  }
  const inputState = portState(data.validInputTarget === true);
  function portDescription(
    direction: "input" | "output",
    state: ReturnType<typeof portState>,
  ) {
    if (!isConnectable) return `Read-only ${direction} port.`;
    if (state === "valid")
      return `Valid connection target. Drop here or press Enter to connect.`;
    if (state === "invalid")
      return `This ${direction} cannot connect to the selected port.`;
    return `Drag to connect, or press Enter then choose another port.`;
  }
  const refresh = useUpdateNodeInternals();
  const portKey = JSON.stringify(ports);
  useEffect(() => {
    refresh(id);
  }, [id, portKey, refresh]);
  function activateHandle(event: React.KeyboardEvent<HTMLDivElement>) {
    if (isConnectable && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.click();
    }
  }
  const handleProps = {
    role: "button",
    tabIndex: isConnectable ? 0 : -1,
    onKeyDown: activateHandle,
    isConnectable,
    "aria-disabled": !isConnectable,
  };
  const issue =
    typeof data.issueMessage === "string"
      ? data.issueMessage
      : "Settings need attention";
  const issueCount =
    typeof data.issueCount === "number" && data.issueCount > 1
      ? data.issueCount
      : 0;
  const warning =
    !data.hasIssue && typeof data.warningMessage === "string"
      ? data.warningMessage
      : undefined;
  const connectivityWarning =
    typeof data.connectivityWarning === "string"
      ? data.connectivityWarning
      : undefined;
  const live = data.live as NodeLive | null | undefined;
  return (
    <div
      className={`pipeline-node pipeline-node-v2 pipeline-node-${kind}${connectivityWarning ? " pipeline-node-unconnected" : ""}${selected ? " pipeline-node-selected" : ""}${data.hasIssue ? " pipeline-node-issue" : ""}`}
      data-pipeline-category={kind}
      data-connectivity={connectivityWarning ? "no-destination" : undefined}
      data-connection-active={connectionActive || undefined}
      style={
        {
          width: PIPELINE_NODE_WIDTH,
          "--pipeline-node-body-height": `${PIPELINE_NODE_BODY_HEIGHT - 2}px`,
          "--pipeline-node-header-height": `${PIPELINE_NODE_HEADER_HEIGHT - 1}px`,
        } as CSSProperties
      }
    >
      {kind !== "sources" && (
        <Handle
          {...handleProps}
          type="target"
          position={Position.Left}
          id="input"
          className="pipeline-node-input"
          style={{ top: PIPELINE_NODE_HEADER_HEIGHT }}
          aria-label={`Input for ${label}`}
          data-port-state={inputState}
          aria-description={portDescription("input", inputState)}
          title={`Input for ${label}. ${portDescription("input", inputState)}`}
        />
      )}
      <div className="pipeline-node-body">
        <div className="pipeline-node-title-row">
          <span className="pipeline-node-icon-frame">
            <ComponentIcon type={type} kind={kind} size={28} />
          </span>
          <div className="pipeline-node-title-text">
            <span className="pipeline-node-kind">
              {context.enrichmentTable
                ? context.implicitSource
                  ? "Table source"
                  : "Enrichment table"
                : kindLabels[kind]}
            </span>
            <strong title={title}>{title}</strong>
          </div>
          {openMenu && (
            <button
              type="button"
              className="pipeline-node-menu nodrag nopan"
              data-node-action="menu"
              aria-label={`Actions for ${label}`}
              aria-haspopup="menu"
              aria-expanded={data.menuOpen === true}
              title={`Actions for ${label}`}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.currentTarget.click();
                }
              }}
              onClick={(event) => {
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                openMenu(
                  { x: bounds.left, y: bounds.bottom + 6 },
                  event.currentTarget,
                );
              }}
            >
              <Ellipsis size={18} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="pipeline-node-summary">
          <p
            className={summary.code ? "pipeline-node-summary-code" : undefined}
            title={summary.primary}
          >
            {summary.primary}
          </p>
          {live !== undefined ? (
            <LiveReading kind={kind} reading={live} />
          ) : (
            summary.secondary && (
              <p
                className="pipeline-node-summary-secondary"
                title={summary.secondary}
              >
                {summary.secondary}
              </p>
            )
          )}
        </div>
        <div className="pipeline-node-footer">
          <code
            className="pipeline-node-identity"
            title={`Component ID: ${label}`}
          >
            {label}
          </code>
          {connectivityWarning && (
            <span
              className="pipeline-node-connectivity"
              role="img"
              aria-label={`${label}: ${connectivityWarning}`}
              title={connectivityWarning}
            >
              <Unplug size={13} aria-hidden="true" />
              <span>No destination</span>
            </span>
          )}
          {!!data.hasIssue && (
            <span
              className="pipeline-node-attention"
              role="img"
              aria-label={
                issueCount ? `${issueCount} problems. First: ${issue}` : issue
              }
              title={
                issueCount ? `${issueCount} problems. First: ${issue}` : issue
              }
            >
              <CircleX size={15} aria-hidden="true" />
              {issueCount > 0 && <span>{issueCount}</span>}
            </span>
          )}
          {warning && (
            <span
              className="pipeline-node-caution"
              role="img"
              aria-label={`Warning: ${warning}`}
              title={warning}
            >
              <AlertTriangle size={14} aria-hidden="true" />
            </span>
          )}
        </div>
      </div>
      {simpleOutput && (
        <Handle
          {...handleProps}
          type="source"
          position={Position.Right}
          id="output"
          className="pipeline-node-output"
          style={{ top: PIPELINE_NODE_HEADER_HEIGHT }}
          aria-label={`${label} output`}
          data-port-state={portState(validOutputs.has("output"))}
          aria-description={portDescription(
            "output",
            portState(validOutputs.has("output")),
          )}
          title={`${label} output. ${portDescription("output", portState(validOutputs.has("output")))}`}
        />
      )}
      {ports.length > 0 && !simpleOutput && (
        <div
          className="pipeline-node-port-list"
          aria-label={`${label} outputs`}
        >
          {ports.map((port) => (
            <div
              className="pipeline-node-output-row"
              key={port}
              data-port-state={portState(validOutputs.has(port))}
            >
              <span title={port}>
                {port === "output"
                  ? "Events"
                  : port === "_unmatched"
                    ? "Unmatched"
                    : port}
              </span>
              <ArrowRight size={12} aria-hidden="true" />
              <Handle
                {...handleProps}
                type="source"
                position={Position.Right}
                id={port}
                aria-label={`${label} ${port} output`}
                data-port-state={portState(validOutputs.has(port))}
                aria-description={portDescription(
                  "output",
                  portState(validOutputs.has(port)),
                )}
                title={`${label}.${port}. ${portDescription("output", portState(validOutputs.has(port)))}`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export default memo(PipelineNode);
