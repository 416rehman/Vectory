import React, { useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import PipelineSchemaFields, {
  PipelineSchemaControl,
} from "../src/PipelineSchemaFields";
import PipelineSettings from "../src/PipelineSettings";
import PipelineGlobals from "../src/PipelineGlobals";
import { pipelineIssues } from "../src/catalog";
import "../src/styles.css";
import "../src/editor.css";
import "../src/schema-controls.css";
function Harness({ test }: any) {
  const [value, setValue] = useState(test.value),
    [pending, setPending] = useState<string[]>([]);
  const onPending = useCallback(
    (id: string, dirty: boolean) =>
      setPending((previous) =>
        dirty
          ? previous.includes(id)
            ? previous
            : [...previous, id]
          : previous.includes(id)
            ? previous.filter((key) => key !== id)
            : previous,
      ),
    [],
  );
  (window as any).stored = value;
  (window as any).setExternalValue = setValue;
  (window as any).currentRevision = test.revision;
  const change = (next: any) => {
    (window as any).testHistory.push(next);
    setValue(next);
  };
  const config = {
    ...test.config,
    [test.kind || "sources"]: {
      ...test.config?.[test.kind || "sources"],
      reviewed: value,
    },
  };
  return (
    <div
      style={{
        width: 400,
        maxWidth: "100%",
        padding: 22,
        background: "var(--surface)",
      }}
    >
      <h1 style={{ fontSize: 18 }}>Schema control verification</h1>
      {test.mode === "globals" ? (
        <PipelineGlobals
          config={value}
          onChange={change}
          onClose={() => {}}
          editable={test.editable !== false}
          initialSection={test.section || "general"}
        />
      ) : test.mode === "settings" ? (
        <PipelineSettings
          id="reviewed"
          kind={test.kind || "sources"}
          component={value}
          config={config}
          editable={test.editable !== false}
          issues={
            test.computeIssues
              ? pipelineIssues(config)
                  .filter((issue) => issue.id === "reviewed")
                  .map((issue) => issue.message)
              : []
          }
          raw={JSON.stringify(value, null, 2)}
          setRaw={() => {}}
          onChange={change}
          onPendingChange={onPending}
          onInput={() => {}}
          onOutput={() => {}}
          onRouteRename={() => {}}
          onRouteRemove={() => {}}
          onRaw={() => {}}
          onRemove={() => {}}
          onDuplicate={() => {}}
        />
      ) : test.mode === "fields" ? (
        <PipelineSchemaFields
          schema={test.schema}
          root={test.root || {}}
          component={value}
          onChange={change}
          editable={test.editable !== false}
          exclude={test.exclude}
          onPendingChange={onPending}
        />
      ) : (
        <PipelineSchemaControl
          name={test.name || "value"}
          label={test.label}
          schema={test.schema}
          root={test.root || {}}
          value={value}
          onChange={change}
          editable={test.editable !== false}
          required={test.required}
          onPendingChange={onPending}
        />
      )}
      <output aria-label="Pending edits">{pending.length}</output>
      <pre aria-label="Stored value" style={{ overflow: "auto" }}>
        {value === undefined ? "__UNSET__" : JSON.stringify(value)}
      </pre>
    </div>
  );
}
const root = createRoot(document.getElementById("root")!);
let revision = 0;
(window as any).renderControl = (test: any) => {
  (window as any).testHistory = [];
  const next = ++revision;
  (window as any).expectedRevision = next;
  root.render(<Harness key={next} test={{ ...test, revision: next }} />);
};
(window as any).ready = true;
