// node --test scripts/capture-screenshots.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  editorTelemetryReady,
  overviewTelemetryReady,
} from "./capture-screenshots.mjs";

function element({
  text = "",
  attributes = {},
  children = {},
  visible = true,
} = {}) {
  return {
    textContent: text,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    querySelector: (selector) => children[selector]?.[0] ?? null,
    querySelectorAll: (selector) => children[selector] ?? [],
    getClientRects: () => (visible ? [{}] : []),
  };
}

function editor({
  nodeRate = "4.9/s",
  edgeRate = "4.9/s",
  emptyNodes = 0,
  emptyEdges = 1,
} = {}) {
  const nodes = Array.from({ length: 8 }, (_, index) =>
    element({
      attributes: index < emptyNodes ? { "data-empty": "" } : {},
      children: {
        ".pipeline-node-live-stat b": [
          element({ text: index < emptyNodes ? "—" : nodeRate }),
        ],
      },
    }),
  );
  const edges = Array.from({ length: 6 }, (_, index) =>
    element({
      text: index < emptyEdges ? "no data" : edgeRate,
      attributes: index < emptyEdges ? { "data-empty": "" } : {},
    }),
  );
  return element({
    children: {
      '.editor-live-toggle[aria-pressed="true"]': [element()],
      ".editor-live-status": [element({ attributes: { "data-tone": "live" } })],
      ".pipeline-node-live": nodes,
      ".pipeline-edge-rate": edges,
    },
  });
}

test("editor capture waits past the first scrape with unknown rates", () => {
  assert.equal(
    editorTelemetryReady(editor({ emptyNodes: 8, emptyEdges: 6 })),
    false,
  );
  assert.equal(
    editorTelemetryReady(editor({ nodeRate: "0/s", edgeRate: "0/s" })),
    false,
  );
  assert.equal(editorTelemetryReady(editor({ emptyEdges: 2 })), false);
  assert.equal(editorTelemetryReady(editor()), true);
});

function overview({
  missingRow = false,
  fleetRate = "34.9/s",
  chart = true,
} = {}) {
  const rows = Array.from({ length: 2 }, (_, index) =>
    element({
      children: {
        ".overview-running-rate": [
          element({
            attributes: missingRow && index === 1 ? { "data-missing": "" } : {},
          }),
        ],
      },
    }),
  );
  return element({
    children: {
      ".running-now .overview-running-item": rows,
      ".throughput .overview-throughput-stats > div:first-child dd": [
        element({ text: fleetRate }),
      ],
      ".throughput .fleet-chart-frame": chart ? [element()] : [],
    },
  });
}

test("Overview capture requires both running rates and completed fleet chart", () => {
  assert.equal(overviewTelemetryReady(overview({ missingRow: true })), false);
  assert.equal(overviewTelemetryReady(overview({ fleetRate: "0/s" })), false);
  assert.equal(overviewTelemetryReady(overview({ chart: false })), false);
  assert.equal(overviewTelemetryReady(overview()), true);
});
