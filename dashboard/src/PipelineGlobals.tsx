import { useCallback, useEffect, useRef, useState } from "react";
import {
  Settings2,
  Database,
  KeyRound,
  FlaskConical,
  Plug,
  Braces,
} from "lucide-react";
import type { Config, VariableDeclaration } from "./api";
import { post } from "./api";
import { vectorSchema } from "./catalog";
import { resolveSchema, type Schema } from "./pipelineSchema";
import PipelineSchemaFields from "./PipelineSchemaFields";
import DocLink, { ExternalDocLink } from "./DocLink";
import { Button, ErrorBox, Modal } from "./ui";
import TabLabel from "./TabLabel";
import PipelineVariables from "./PipelineVariables";
import "./pipeline-globals.css";
import type { PipelineSection } from "./pipelineDestination";

const sections = [
  {
    id: "general",
    title: "General",
    icon: Settings2,
    description: "Settings shared by every component in this pipeline.",
    link: "global-options",
  },
  {
    id: "enrichment_tables",
    title: "Enrichment tables",
    icon: Database,
    description: "Define lookup tables to use from your transformations.",
    link: "pipeline-components",
  },
  {
    id: "secret",
    title: "Secrets",
    icon: KeyRound,
    description:
      "Configure secret backends on the device. Reference their values as SECRET[backend.key].",
    link: "secrets",
  },
  {
    id: "variables",
    title: "Variables",
    icon: Braces,
    description: "Choose fields that can have a different value on each device.",
    link: "",
  },
  {
    id: "tests",
    title: "Tests",
    icon: FlaskConical,
    description: "Describe sample inputs and expected transformation outputs.",
    link: "unit-tests",
  },
  {
    id: "provider",
    title: "Configuration provider",
    icon: Plug,
    description:
      "Load Vector configuration from a provider available to the device.",
    link: "global-options",
  },
];
export default function PipelineGlobals({
  config,
  variables,
  onChange,
  onVariablesChange,
  onClose,
  editable,
  initialSection = "general",
}: {
  config: Config;
  variables: VariableDeclaration[];
  onChange: (next: Config) => void;
  onVariablesChange: (next: VariableDeclaration[]) => void;
  onClose: () => void;
  editable: boolean;
  initialSection?: PipelineSection;
}) {
  const [section, setSection] = useState<string>(initialSection),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<{
      valid: boolean;
      errors: string[];
      output?: string;
      deferred?: boolean;
    } | null>(null);
  const pending = useRef(new Set<string>()),
    request = useRef(0);
  const pendingChange = useCallback((id: string, dirty: boolean) => {
    if (dirty) pending.current.add(id);
    else pending.current.delete(id);
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending.current.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const beforeNavigate = (event: Event) => {
      if (pending.current.size && !confirm("Discard unapplied field changes?"))
        event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("vectory:before-navigate", beforeNavigate);
    return () => {
      request.current++;
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("vectory:before-navigate", beforeNavigate);
    };
  }, []);
  function discardPending() {
    return !pending.current.size || confirm("Discard unapplied field changes?");
  }
  function close() {
    if (discardPending()) {
      request.current++;
      onClose();
    }
  }
  const root = resolveSchema(vectorSchema, vectorSchema, config);
  const details = sections.find((item) => item.id === section)!;
  const names =
    section === "general"
      ? Object.keys(root.properties || {}).filter(
          (key) =>
            ![
              "sources",
              "transforms",
              "sinks",
              "enrichment_tables",
              "secret",
              "variables",
              "tests",
              "provider",
            ].includes(key),
        )
      : [section];
  const schema: Schema = {
    type: "object",
    required: section === "general" ? [] : [section],
    properties: Object.fromEntries(
      names.map((name) => [
        name,
        {
          ...root.properties[name],
          _metadata: {
            ...root.properties[name]?._metadata,
            "docs::hidden": false,
            "vectory::entry_label":
              name === "secret"
                ? "Backend"
                : name === "enrichment_tables"
                  ? "Table"
                  : name === "tests"
                    ? "Test"
                    : undefined,
          },
        },
      ]),
    ),
  };
  function update(next: Config) {
    request.current++;
    setBusy(false);
    setResult(null);
    setError("");
    onChange(next);
  }
  async function runTests() {
    if (pending.current.size) {
      setError("Resolve or apply pending field edits before running tests.");
      return;
    }
    const current = ++request.current;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await post<{
        valid: boolean;
        errors: string[];
        output?: string;
        deferred?: boolean;
      }>("/configurations/test", { config });
      if (current === request.current) setResult(response);
    } catch (failure) {
      if (current === request.current) setError((failure as Error).message);
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={close}
      title="Pipeline settings"
      description="Global configuration for this pipeline. Use Save draft to keep your changes."
      wide
    >
      <div className="pipeline-global-layout">
        <nav
          className="pipeline-global-nav"
          aria-label="Pipeline settings sections"
        >
          {sections.map((item) => (
            <button
              key={item.id}
              aria-current={item.id === section ? "page" : undefined}
              onClick={() => {
                if (discardPending()) {
                  pending.current.clear();
                  setSection(item.id);
                }
              }}
            >
              <TabLabel icon={item.icon}>{item.title}</TabLabel>
            </button>
          ))}
        </nav>
        <div
          className={`pipeline-global-body ${section !== "general" ? "global-specific" : ""}`}
        >
          <h3>{details.title}</h3>
          <p>
            {details.description}{" "}
            {section !== "variables" && <DocLink
              topic={section === "general" ? "pipelines" : "resources"}
              section={
                {
                  general: "global-settings",
                  enrichment_tables: "enrich-events-with-local-data",
                  secret: "use-native-vector-secret-providers",
                  tests: "test-transformations",
                  provider: "configuration-providers",
                }[section]
              }
            >
              How this works
            </DocLink>}
          </p>
          {section === "variables" ? <PipelineVariables
            config={config}
            variables={variables}
            editable={editable}
            onChange={onVariablesChange}
          /> : <PipelineSchemaFields
            key={section}
            schema={schema}
            root={vectorSchema}
            component={config}
            exclude={Object.keys(config).filter((key) => !names.includes(key))}
            onChange={update}
            editable={editable}
            onPendingChange={pendingChange}
          />}
          {section === "tests" && (
            <div className="pipeline-test-run">
              <Button
                variant="secondary"
                busy={busy}
                disabled={
                  !Array.isArray(config.tests) || config.tests.length === 0
                }
                onClick={runTests}
              >
                Run pipeline tests
              </Button>
              {error && <ErrorBox message={error} />}
              {result && (
                <div role="status">
                  <strong>
                    {result.deferred
                      ? "These tests need the device environment"
                      : result.valid
                        ? "Pipeline tests passed"
                        : "Pipeline tests failed"}
                  </strong>
                  {result.errors?.length > 0 && (
                    <ErrorBox message={result.errors.join("\n")} />
                  )}{" "}
                  {result.output && (
                    <pre className="code-preview">{result.output}</pre>
                  )}
                </div>
              )}
            </div>
          )}
          {section !== "variables" && <ExternalDocLink
            className="pipeline-global-docs"
            href={`https://vector.dev/docs/reference/configuration/${details.link}/`}
          >
            Vector reference for {details.title.toLowerCase()}
          </ExternalDocLink>}
        </div>
      </div>
      <div className="modal-footer">
        <Button onClick={close}>Done</Button>
      </div>
    </Modal>
  );
}
