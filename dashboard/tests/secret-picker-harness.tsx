// Real device-secret UI with synthetic pipelines and devices; no server,
// fleet or deployment state.
import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import PipelineSettings from "../src/PipelineSettings";
import DeviceSecrets from "../src/DeviceSecrets";
import PublishReview from "../src/PublishReview";
import { pipelineIssues, type Kind } from "../src/catalog";
import { secretNamesOf } from "../src/secretFields";
import type { Config, Device, Version } from "../src/api";
import "../src/styles.css";
import "../src/editor.css";
import "../src/devices.css";

type PickerTest = {
  id: string;
  kind: Kind;
  component: Config;
  config: Config;
  editable?: boolean;
};

function Picker({ test }: { test: PickerTest }) {
  const [component, setComponent] = useState(test.component),
    [pending, setPending] = useState<string[]>([]);
  const onPending = useCallback(
    (id: string, dirty: boolean) =>
      setPending((previous) =>
        dirty
          ? previous.includes(id)
            ? previous
            : [...previous, id]
          : previous.filter((key) => key !== id),
      ),
    [],
  );
  (window as any).stored = component;
  const config = {
    ...test.config,
    [test.kind]: { ...test.config[test.kind], [test.id]: component },
  };
  return (
    <section
      className="secret-harness-inspector"
      aria-label="Component settings"
    >
      <PipelineSettings
        id={test.id}
        kind={test.kind}
        component={component}
        editable={test.editable !== false}
        issues={pipelineIssues(config)
          .filter((issue) => issue.id === test.id)
          .map((issue) => issue.message)}
        onChange={setComponent}
        onPendingChange={onPending}
        onRouteRename={() => {}}
        onRouteRemove={() => {}}
        secretNames={secretNamesOf(config)}
      />
      <output aria-label="Pending edits" hidden>
        {pending.length}
      </output>
    </section>
  );
}

const root = createRoot(document.getElementById("root")!);
let revision = 0;
function render(node: React.ReactNode) {
  const next = ++revision;
  root.render(
    <div className="secret-harness" key={next}>
      <h1>Device secret verification</h1>
      {node}
    </div>,
  );
  (window as any).expectedRevision = next;
  requestAnimationFrame(() => ((window as any).currentRevision = next));
}
(window as any).renderPicker = (test: PickerTest) =>
  render(<Picker test={test} />);
(window as any).renderDevice = (props: {
  device: Device;
  version: Version | null;
  loading?: boolean;
  failed?: boolean;
}) =>
  render(
    <div className="device-page secret-harness-device">
      <DeviceSecrets loading={false} failed={false} {...props} />
    </div>,
  );
(window as any).renderReview = (props: {
  config: Config;
  published: Version | null;
}) =>
  render(
    <div className="secret-harness-review" role="dialog" aria-label="Publish">
      <PublishReview
        {...props}
        reach="Assigned to 3 devices (v3) · all verified running."
        status="device"
        statusLabel="Checked"
        verdict="Vector 0.58 accepted this pipeline. Each device checks secrets before applying it."
        problems={[]}
        rejection={null}
        onGoToProblem={() => {}}
      />
    </div>,
  );
const style = document.createElement("style");
style.textContent = `
body { margin: 0; background: var(--bg); color: var(--text); }
.secret-harness { padding: 22px; }
.secret-harness h1 { margin: 0 0 16px; font-size: 18px; }
.secret-harness-inspector { width: 400px; max-width: 100%; padding: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-sizing: border-box; }
.secret-harness-device { max-width: 720px; }
.secret-harness-review { width: 560px; max-width: 100%; padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-sizing: border-box; }
`;
document.head.append(style);
(window as any).ready = true;
