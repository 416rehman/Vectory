import { useEffect } from "react";
import { useStore } from "@xyflow/react";

/**
 * Publishes the canvas zoom as `--flow-zoom` on the canvas, so numbers drawn on
 * it can keep a readable size on screen as the graph is fitted into a window:
 * `font-size: calc(12px / var(--flow-zoom))`. Nothing is re-rendered when the
 * zoom changes; only this variable is written.
 */
export default function ZoomVariable() {
  const zoom = useStore((state) => state.transform[2]);
  const root = useStore((state) => state.domNode);
  useEffect(() => {
    root?.style.setProperty(
      "--flow-zoom",
      String(Math.round(zoom * 1000) / 1000),
    );
  }, [root, zoom]);
  return null;
}
