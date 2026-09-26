import { useState } from "react";
import { Play } from "lucide-react";
import { post } from "./api";
import { Button, ErrorBox, Field, Modal } from "./ui";

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
  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const parsed = JSON.parse(sample);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw Error("Enter a JSON object as the synthetic event.");
      setResult(await post("/vrl/test", { program, sample: parsed }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="secondary compact"
        icon={Play}
        onClick={() => {
          setOpen(true);
          setResult(null);
          setError("");
        }}
      >
        Test with a sample
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Test your VRL program"
        description="Run a synthetic event in the isolated validation worker. This test cannot read events from your devices."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <Field label="Synthetic event (JSON)">
            <textarea
              rows={7}
              spellCheck={false}
              value={sample}
              maxLength={65536}
              onChange={(e) => setSample(e.target.value)}
            />
          </Field>
          <Field label="Program">
            <textarea rows={5} readOnly value={program} spellCheck={false} />
          </Field>
          {result && (
            <div role="status">
              <h3>
                {result.valid ? "Transformed event" : "Program needs attention"}
              </h3>
              {result.errors.length > 0 ? (
                <ErrorBox message={result.errors.join("\n")} />
              ) : (
                <pre className="code-preview">
                  {JSON.stringify(result.output, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button icon={Play} busy={busy} onClick={run}>
            Run sample
          </Button>
        </div>
      </Modal>
    </>
  );
}
