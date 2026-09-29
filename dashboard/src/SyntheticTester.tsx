import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";
import { post } from "./api";
import { Button, ErrorBox, Modal } from "./ui";
import "./control.css";
import ConfigurationCodeEditor from "./ConfigurationCodeEditor";
import { diagnoseJSONValue } from "./SchemaValueEditor";

export default function SyntheticTester({ program }: { program: string }) {
  const [open, setOpen] = useState(false),
    [sample, setSample] = useState(
      '{\n  "message": "Hello, Vector",\n  "level": "info"\n}',
    ),
    [result, setResult] = useState<{
      valid: boolean;
      output: unknown;
      errors: string[];
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const requestId = useRef(0),
    feedbackId = useId();
  const sampleCheck = useMemo(() => {
    const checked = diagnoseJSONValue(sample, {
      label: "Example event",
      protectCredentials: false,
    });
    const diagnostics = [...checked.diagnostics];
    if (new TextEncoder().encode(sample).length > 65536)
      diagnostics.unshift({
        from: 0,
        to: 1,
        severity: "error" as const,
        message: "The example event must be no larger than 65,536 bytes.",
      });
    if (
      checked.parseValid &&
      (!checked.value ||
        typeof checked.value !== "object" ||
        Array.isArray(checked.value))
    )
      diagnostics.push({
        from: 0,
        to: Math.min(1, sample.length),
        severity: "error" as const,
        message: "Enter a JSON object as the example event.",
      });
    return { ...checked, diagnostics };
  }, [sample]);
  function formatSample() {
    if (!sampleCheck.parseValid) return;
    clear();
    setSample(JSON.stringify(sampleCheck.value, null, 2));
  }
  useEffect(() => {
    requestId.current++;
    setResult(null);
    setError("");
    setBusy(false);
  }, [program]);
  useEffect(
    () => () => {
      requestId.current++;
    },
    [],
  );
  function clear() {
    requestId.current++;
    setResult(null);
    setError("");
    setBusy(false);
  }
  async function run() {
    const id = ++requestId.current;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!sampleCheck.parseValid || sampleCheck.diagnostics.length)
        throw Error(
          sampleCheck.diagnostics[0]?.message ||
            "Enter valid JSON before running the sample.",
        );
      const parsed = sampleCheck.value;
      const response = await post<{
        valid: boolean;
        output: unknown;
        errors: string[];
      }>("/vrl/test", { program, sample: parsed });
      if (id === requestId.current) setResult(response);
    } catch (e) {
      if (id === requestId.current) setError((e as Error).message);
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="secondary compact"
        icon={Play}
        onClick={() => {
          clear();
          setOpen(true);
        }}
      >
        Test with a sample
      </Button>
      <Modal
        open={open}
        onClose={() => {
          clear();
          setOpen(false);
        }}
        title="Test transform"
        description="Run the current VRL program on an example event. This does not read events from your devices."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <div className="pipeline-json-field">
            <div className="schema-json-toolbar">
              <span>Example event (JSON)</span>
              <Button
                variant="ghost compact"
                disabled={!sampleCheck.parseValid}
                onClick={formatSample}
              >
                Format JSON
              </Button>
            </div>
            <ConfigurationCodeEditor
              label="Example event (JSON)"
              describedBy={
                sampleCheck.diagnostics.length ? feedbackId : undefined
              }
              value={sample}
              format="json"
              diagnostics={sampleCheck.diagnostics}
              onFormat={formatSample}
              onChange={(next) => {
                clear();
                setSample(next);
              }}
            />
            {!!sampleCheck.diagnostics.length && (
              <ul id={feedbackId} className="schema-json-errors" role="status">
                {sampleCheck.diagnostics
                  .slice(0, 5)
                  .map((diagnostic, index) => (
                    <li key={index}>{diagnostic.message}</li>
                  ))}
              </ul>
            )}
          </div>
          <details className="control-disclosure">
            <summary>View the VRL program</summary>
            <div className="control-disclosure-content control-command">
              <code>{program || "No program entered."}</code>
            </div>
          </details>
          {result && (
            <div role="status" className="control-vrl-output">
              <h3>
                {result.valid
                  ? "Transformed event"
                  : "Transform needs attention"}
              </h3>
              {result.errors.length ? (
                <ErrorBox message={result.errors.join("\n")} />
              ) : (
                <div className="control-command">
                  <code>{JSON.stringify(result.output, null, 2)}</code>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            onClick={() => {
              clear();
              setOpen(false);
            }}
          >
            Close
          </Button>
          <Button
            icon={Play}
            busy={busy}
            disabled={
              !program.trim() ||
              !sample.trim() ||
              !!sampleCheck.diagnostics.length
            }
            onClick={run}
          >
            Run sample
          </Button>
        </div>
      </Modal>
    </>
  );
}
