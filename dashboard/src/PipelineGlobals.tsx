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
import { FieldProblemsContext } from "./PipelineSchemaFields";
import { vectorApiExposure } from "./hostRequirements";
import DocLink, { ExternalDocLink } from "./DocLink";
import { Button, ErrorBox, Modal } from "./ui";
import TabLabel from "./TabLabel";
import PipelineVariables from "./PipelineVariables";
import PipelineTestResults, {
  type PipelineTestRun,
} from "./PipelineTestResults";
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
    description:
      "Choose fields that can have a different value on each device.",
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
  local = false,
  canRunTests = true,
  codeChangesPending = false,
  initialSection = "general",
  initialTest,
}: {
  config: Config;
  variables: VariableDeclaration[];
  onChange: (next: Config) => void;
  onVariablesChange: (next: VariableDeclaration[]) => void;
  onClose: () => void;
  editable: boolean;
  local?: boolean;
  canRunTests?: boolean;
  codeChangesPending?: boolean;
  initialSection?: PipelineSection;
  /** Opens the Tests section on this test (1-based), as a review found it failing. */
  initialTest?: number;
}) {
  const [section, setSection] = useState<string>(
      local && initialSection === "variables" ? "general" : initialSection,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<PipelineTestRun | null>(null);
  const pending = useRef(new Set<string>()),
    request = useRef(0);
  // Select the test a review sent you to: scroll to it and put the cursor in
  // it. The dialog focuses its first field as it opens, so wait for the list.
  useEffect(() => {
    if (!initialTest || initialSection !== "tests") return;
    let frames = 0,
      frame = 0;
    const seek = () => {
      // The first list in the section is the tests; the lists inside each
      // test come after it.
      const entry = document
        .querySelector(".pipeline-global-body .pipeline-schema-array")
        ?.querySelectorAll<HTMLElement>(":scope > .schema-array-entry")[
        initialTest - 1
      ];
      if (!entry) {
        if (++frames < 30) frame = requestAnimationFrame(seek);
        return;
      }
      entry.scrollIntoView({ block: "center" });
      entry
        .querySelector<HTMLElement>(
          'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)',
        )
        ?.focus({ preventScroll: true });
      entry.dataset.selected = "true";
      entry.addEventListener(
        "focusout",
        () => {
          delete entry.dataset.selected;
        },
        { once: true },
      );
    };
    frame = requestAnimationFrame(seek);
    return () => cancelAnimationFrame(frame);
  }, []);
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
  const apiExposure = vectorApiExposure(config);
  const fieldProblems = useCallback(
    (path: string) =>
      path === "api.enabled" && apiExposure
        ? [
            {
              key: "vector-api-exposure",
              severity: "warning" as const,
              message: apiExposure,
            },
          ]
        : [],
    [apiExposure],
  );
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
            // Show what Vector's reference hides because the section has a
            // page of its own here. An option Vector replaced (`expire_metrics`,
            // which reads the same as `expire_metrics_secs`) stays hidden
            // unless this draft still sets it.
            "docs::hidden":
              !!root.properties[name]?.deprecated &&
              !Object.hasOwn(config, name),
            "vectory::page": section !== "general",
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
    if (!canRunTests) return;
    if (codeChangesPending) return;
    if (pending.current.size) {
      setError("Resolve or apply pending field edits before running tests.");
      return;
    }
    const current = ++request.current;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await post<PipelineTestRun>("/configurations/test", {
        config,
      });
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
      description={
        local
          ? "Global configuration for this pipeline. Export configuration to keep your changes."
          : "Global configuration for this pipeline. Use Save draft to keep your changes."
      }
      wide
    >
      <div className="pipeline-global-layout">
        <nav
          className="pipeline-global-nav"
          aria-label="Pipeline settings sections"
        >
          {sections
            .filter((item) => !local || item.id !== "variables")
            .map((item) => (
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
          {codeChangesPending && (
            <p role="status">
              Apply or discard your Code changes before editing Pipeline
              settings.
            </p>
          )}
          <h3>{details.title}</h3>
          <p>
            {details.description}{" "}
            <DocLink
              topic={section === "general" ? "pipelines" : "resources"}
              section={
                {
                  general: "global-settings",
                  enrichment_tables: "enrich-events-with-local-data",
                  secret: "use-native-vector-secret-providers",
                  variables: "values-that-differ-by-device",
                  tests: "test-transformations",
                  provider: "configuration-providers",
                }[section]
              }
            >
              How this works
            </DocLink>
          </p>
          {section === "tests" && (
            <div className="pipeline-test-run">
              <div className="pipeline-test-run-bar">
                <strong>
                  {Array.isArray(config.tests) && config.tests.length
                    ? `${config.tests.length} ${config.tests.length === 1 ? "test" : "tests"}`
                    : "No tests yet"}
                </strong>
                <Button
                  variant="secondary compact"
                  busy={busy}
                  disabled={
                    !canRunTests ||
                    codeChangesPending ||
                    !Array.isArray(config.tests) ||
                    config.tests.length === 0
                  }
                  onClick={runTests}
                >
                  Run pipeline tests
                </Button>
              </div>
              {!canRunTests && (
                <p className="muted">
                  Tests stay in the configuration. Run them in your Vectory
                  server.
                </p>
              )}
              {error && <ErrorBox message={error} />}
              {result && (
                <PipelineTestResults
                  run={result}
                  expected={
                    Array.isArray(config.tests) ? config.tests.length : 0
                  }
                  steps={Object.keys(config.transforms || {})}
                />
              )}
            </div>
          )}
          {section === "variables" && !local ? (
            <PipelineVariables
              config={config}
              variables={variables}
              editable={editable}
              onChange={onVariablesChange}
            />
          ) : (
            <FieldProblemsContext.Provider value={fieldProblems}>
              <PipelineSchemaFields
                key={section}
                schema={schema}
                root={vectorSchema}
                component={config}
                exclude={Object.keys(config).filter(
                  (key) => !names.includes(key),
                )}
                onChange={update}
                editable={editable}
                onPendingChange={pendingChange}
              />
            </FieldProblemsContext.Provider>
          )}
          {section !== "variables" && (
            <ExternalDocLink
              className="pipeline-global-docs"
              href={`https://vector.dev/docs/reference/configuration/${details.link}/`}
            >
              Vector reference for {details.title.toLowerCase()}
            </ExternalDocLink>
          )}
        </div>
      </div>
      <div className="modal-footer">
        <Button onClick={close}>Done</Button>
      </div>
    </Modal>
  );
}
