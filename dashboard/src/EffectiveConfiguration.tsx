import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CircleCheck,
  CircleHelp,
  Download,
  Info,
  TriangleAlert,
  WrapText,
} from "lucide-react";
import {
  download,
  type Device,
  type DeviceConfiguration,
  type DeviceConfigurationDiff,
} from "./api";
import DocLink from "./DocLink";
import {
  Button,
  CopyButton,
  Disclosure,
  EmptyState,
  InlineError,
  SegmentedControl,
  Select,
  Skeleton,
  StatusBadge,
  TimeAgo,
  useMediaQuery,
  useResource,
} from "./ui";
import type { StatusTone } from "./status";
import { ChunkBoundary } from "./PageBoundary";
import { loadPage, type PageFailureKind } from "./pageLoading";
import EffectiveConfigurationDiff from "./EffectiveConfigurationDiff";
import {
  configurationPath,
  diffPath,
  downloadName,
  driftLine,
  evidenceKey,
  generationOptions,
  shortDigest,
  sizeText,
  variableRows,
  versionName,
} from "./effectiveConfiguration";
import "./effective-configuration.css";

// The viewer (CodeMirror) loads when a configuration is first shown, not with the page.
const Viewer = lazy(() =>
  loadPage(() => import("./EffectiveConfigurationViewer")),
);

type View = "configuration" | "changes" | "variables";

const toneIcons: Record<StatusTone, typeof Info> = {
  success: CircleCheck,
  warning: TriangleAlert,
  danger: TriangleAlert,
  info: Info,
  neutral: CircleHelp,
};

/** The viewer is the only part that can fail to load; the rest of the card stays. */
function ViewerRecovery({ kind }: { kind: PageFailureKind }) {
  return (
    <p className="effective-config-note" role="alert">
      {kind === "timeout"
        ? "The code viewer is taking too long to load."
        : kind === "load"
          ? "The code viewer couldn't load."
          : "The code viewer stopped working."}{" "}
      Copy and Download still give you the exact text. Reload the page to try
      the viewer again.
    </p>
  );
}

/** Lines as the viewer numbers them: a final newline starts one more, empty line. */
const lineCount = (text: string) => {
  let lines = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    lines++;
  return lines;
};

function ViewerSkeleton() {
  return (
    <div
      className="effective-config-viewer-skeleton"
      aria-hidden="true"
      data-testid="effective-config-skeleton"
    >
      <Skeleton width="42%" height={12} />
      <Skeleton width="68%" height={12} />
      <Skeleton width="55%" height={12} />
      <Skeleton width="76%" height={12} />
      <Skeleton width="34%" height={12} />
    </div>
  );
}

/**
 * What this device was offered, as the server stores it: the version, the
 * exact text with this device's values applied (secrets stay references), the
 * values themselves, what changed since the previous offer, and whether the
 * file the agent reports is the offer. Read-only: nothing here applies,
 * restores or verifies anything, and a copy or download is not evidence that a
 * device runs it.
 *
 * One read per generation chosen. The text of a generation never changes, so
 * nothing polls; the page reads again only when the device reports a
 * different file or generation (see `evidenceKey`), and the comparison is read
 * only when it is opened.
 */
export default function EffectiveConfiguration({ device }: { device: Device }) {
  const titleId = useId();
  const [chosen, setChosen] = useState<number | null>(null);
  const [view, setView] = useState<View>("configuration");
  const phone = useMediaQuery("(max-width: 639px)");
  const [wrapChoice, setWrapChoice] = useState<boolean | null>(null);
  const wrap = wrapChoice ?? phone;
  const [saved, setSaved] = useState("");

  // Read again when the device reports something that changes the answer.
  const key = evidenceKey(device);
  const lastKey = useRef(key);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    setAgain((count) => count + 1);
  }, [key]);

  const read = useResource<DeviceConfiguration | null>(
    configurationPath(device.id, chosen),
    null,
    again,
    { interval: 0 },
  );
  const config = read.data;
  // The picker keeps its options while another generation loads.
  const [known, setKnown] = useState<DeviceConfiguration | null>(null);
  useEffect(() => {
    if (config) setKnown(config);
  }, [config]);

  const previous = config?.previous ?? null;
  const comparing =
    view === "changes" && config?.content != null && previous !== null;
  // Two stored generations never change, so a comparison is read once, when
  // Changes is first opened for it, and kept while this page is open.
  const [compared, setCompared] = useState<
    Record<string, DeviceConfigurationDiff>
  >({});
  const comparePath =
    comparing && previous && config
      ? diffPath(device.id, previous.generation, config.generation)
      : null;
  const kept = comparePath ? compared[comparePath] : undefined;
  const diff = useResource<DeviceConfigurationDiff | null>(
    kept ? null : comparePath,
    null,
    0,
    { interval: 0 },
  );
  const fetched = diff.data;
  useEffect(() => {
    if (comparePath && fetched)
      setCompared((all) =>
        comparePath in all ? all : { ...all, [comparePath]: fetched },
      );
  }, [comparePath, fetched]);
  const shownDiff = kept ?? fetched;

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(""), 10_000);
    return () => clearTimeout(timer);
  }, [saved]);

  const assigned = !!device.desired_version_id;
  const drift = config ? driftLine(config, device) : null;
  const neverOffered =
    !!config && config.content === null && config.generations.total === 0;

  function picker() {
    if (!known || known.generations.items.length === 0) return null;
    const options = generationOptions(
      known,
      device.desired_generation,
      assigned,
    );
    const value =
      chosen === null
        ? assigned
          ? String(device.desired_generation)
          : "current"
        : String(chosen);
    return (
      <div className="effective-config-picker">
        <label htmlFor={`${titleId}-generation`}>Generation</label>
        <Select
          id={`${titleId}-generation`}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            const generation = Number(next);
            // The current generation is followed, not pinned.
            setChosen(
              next === "current" ||
                (assigned && generation === device.desired_generation)
                ? null
                : generation,
            );
          }}
        >
          {!assigned && <option value="current">Nothing offered now</option>}
          {options.map((option) => (
            <option key={option.generation} value={option.generation}>
              {option.label}
            </option>
          ))}
        </Select>
        {chosen !== null && assigned && (
          <Button variant="ghost compact" onClick={() => setChosen(null)}>
            Show current
          </Button>
        )}
      </div>
    );
  }

  let body: ReactNode;
  if (!config && read.loading) {
    // The picker stays while another generation loads, so the control just
    // used doesn't vanish.
    body = (
      <>
        {picker()}
        <div className="effective-config-loading" aria-hidden="true">
          <Skeleton width="60%" height={14} />
          <Skeleton width="45%" height={12} />
          <ViewerSkeleton />
        </div>
      </>
    );
  } else if (!config) {
    const forbidden = read.errorStatus === 403;
    const missing = read.errorStatus === 404 && chosen !== null;
    body = (
      <>
        {picker()}
        {forbidden ? (
          <EmptyState variant="error" title="You can't view this configuration">
            Your role doesn't include this device's configuration. Ask an
            administrator for access.
          </EmptyState>
        ) : missing ? (
          <EmptyState
            variant="error"
            title={`This device was never offered generation ${chosen}`}
            action={
              <Button variant="secondary" onClick={() => setChosen(null)}>
                Show the current configuration
              </Button>
            }
          />
        ) : (
          <InlineError
            title="The effective configuration couldn't be loaded."
            error={read.error}
            retry={() => void read.reload()}
            retrying={read.refreshing}
          />
        )}
      </>
    );
  } else if (neverOffered) {
    body = (
      <EmptyState variant="quiet" title="Nothing offered yet">
        {device.status === "revoked"
          ? "No configuration was offered to this device before its access was revoked."
          : "Deploy a pipeline to this device to see the configuration it receives."}
      </EmptyState>
    );
  } else {
    const run = config.running;
    const DriftIcon = toneIcons[drift!.tone];
    const content = config.content;
    const version = config.version;
    const format = config.format ?? "json";
    const rows = variableRows(config.variables);
    const label = `Configuration offered at generation ${config.generation}`;
    body = (
      <>
        {read.error && (
          <InlineError
            title="Couldn't refresh this configuration."
            error={read.error}
            updatedAt={read.updatedAt}
            retry={() => void read.reload()}
            retrying={read.refreshing}
          />
        )}
        <div
          className="effective-config-drift"
          data-tone={drift!.tone}
          role="status"
        >
          <DriftIcon size={16} aria-hidden="true" />
          <div>
            <p className="effective-config-drift-headline">{drift!.headline}</p>
            {(drift!.detail || drift!.showReportedAt) && (
              <p className="effective-config-drift-detail">
                {drift!.detail}
                {drift!.showReportedAt && run.reported_at && (
                  <>
                    {drift!.detail ? " " : ""}
                    Reported <TimeAgo value={run.reported_at} />.
                  </>
                )}
              </p>
            )}
            <DocLink
              topic="deployments"
              section="read-what-a-device-was-offered"
            >
              How Vectory compares them
            </DocLink>
          </div>
        </div>
        {picker()}
        {content === null ? (
          <p className="effective-config-note">
            {previous
              ? `The last offer was generation ${previous.generation} (${versionName(previous.version)}). Choose it above to read it.`
              : "Nothing was offered."}
          </p>
        ) : (
          <>
            <p className="effective-config-summary">
              {version?.configuration_id ? (
                <a
                  href={`#/configurations/${encodeURIComponent(version.configuration_id)}?panel=history`}
                  title="Open this pipeline's version history"
                >
                  {versionName(version)}
                </a>
              ) : (
                <span>{versionName(version)}</span>
              )}
              <span>generation {config.generation}</span>
              {config.offered_at && (
                <span>
                  offered <TimeAgo value={config.offered_at} />
                </span>
              )}
              <span>{sizeText(config.size ?? content.length)}</span>
              <span>{format.toUpperCase()}</span>
              {config.sha256 && (
                <code title={config.sha256}>{shortDigest(config.sha256)}</code>
              )}
            </p>
            <div className="effective-config-tabs">
              <SegmentedControl<View>
                label="Show"
                value={view}
                onChange={setView}
                options={[
                  { value: "configuration", label: "Configuration" },
                  { value: "changes", label: "Changes" },
                  {
                    value: "variables",
                    label: "Variables",
                    count: rows.length || undefined,
                  },
                ]}
              />
            </div>
            {view === "configuration" && (
              <div className="effective-config-panel">
                <div className="effective-config-toolbar">
                  <span className="effective-config-measure">
                    {lineCount(content).toLocaleString()} lines
                  </span>
                  <div>
                    <Button
                      variant="ghost compact"
                      icon={WrapText}
                      aria-pressed={wrap}
                      onClick={() => setWrapChoice(!wrap)}
                    >
                      Wrap lines
                    </Button>
                    <CopyButton
                      text={() => content}
                      label="Copy"
                      variant="ghost compact"
                      ariaLabel={`Copy the ${format.toUpperCase()} offered at generation ${config.generation}`}
                      copiedMessage={`Copied generation ${config.generation}.`}
                    />
                    <Button
                      variant="ghost compact"
                      icon={Download}
                      aria-label={`Download the ${format.toUpperCase()} offered at generation ${config.generation}`}
                      onClick={() => {
                        const name = downloadName(
                          device.name,
                          config.generation,
                          config.format,
                        );
                        download(
                          name,
                          content,
                          format === "yaml" ? "text/yaml" : "application/json",
                        );
                        setSaved(
                          `Download started: ${name}. It's a copy of what was offered; it doesn't change what the device runs.`,
                        );
                      }}
                    >
                      Download
                    </Button>
                  </div>
                </div>
                <ChunkBoundary
                  fallback={(kind) => <ViewerRecovery kind={kind} />}
                >
                  <Suspense fallback={<ViewerSkeleton />}>
                    <Viewer
                      value={content}
                      format={format}
                      label={label}
                      wrap={wrap}
                    />
                  </Suspense>
                </ChunkBoundary>
                <p className="effective-config-saved" role="status">
                  {saved}
                </p>
              </div>
            )}
            {view === "changes" && (
              <div className="effective-config-panel">
                {previous === null ? (
                  <p className="effective-config-note">
                    This is the first configuration offered to this device.
                    There is nothing earlier to compare it with.
                  </p>
                ) : shownDiff ? (
                  <EffectiveConfigurationDiff
                    key={`${shownDiff.from?.generation ?? 0}:${shownDiff.to.generation}`}
                    diff={shownDiff}
                  />
                ) : diff.error ? (
                  <InlineError
                    title="The changes couldn't be loaded."
                    error={diff.error}
                    retry={() => void diff.reload()}
                    retrying={diff.refreshing}
                  />
                ) : (
                  <div className="effective-config-loading" aria-busy="true">
                    <Skeleton width="48%" height={14} />
                    <Skeleton width="80%" height={12} />
                    <Skeleton width="64%" height={12} />
                  </div>
                )}
              </div>
            )}
            {view === "variables" && (
              <div className="effective-config-panel">
                {rows.length === 0 ? (
                  <p className="effective-config-note">
                    This version has no device-specific values: every device
                    gets the same text.
                  </p>
                ) : (
                  <ul
                    className="effective-config-variables"
                    aria-label={`Values this device was offered at generation ${config.generation}`}
                  >
                    {rows.map((row) => (
                      <li key={row.name}>
                        <div className="effective-config-variable-name">
                          <strong>{row.name}</strong>
                          <span title={row.field}>{row.field}</span>
                        </div>
                        <div className="effective-config-variable-value">
                          {row.value === null ? (
                            <span title="Vectory never shows the value of a field that can hold a credential.">
                              Not shown
                            </span>
                          ) : (
                            <code>
                              {row.value === "" ? "(empty)" : row.value}
                            </code>
                          )}
                        </div>
                        <span className="effective-config-source">
                          {row.source}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {config.uses_local_secrets && (
                  <p className="effective-config-note">
                    This version also reads device secrets. They stay on the
                    device: the text above holds only their names.{" "}
                    <DocLink
                      topic="resources"
                      section="keep-credentials-on-the-device"
                    >
                      How device secrets work
                    </DocLink>
                  </p>
                )}
              </div>
            )}
            <Disclosure summary="Digests" className="effective-config-digests">
              <dl>
                <div>
                  <dt>Offered</dt>
                  <dd>
                    <code>{config.sha256}</code>
                  </dd>
                </div>
                <div>
                  <dt>Reported by the agent</dt>
                  <dd>
                    {run.sha256 ? (
                      <code>{run.sha256}</code>
                    ) : (
                      <span className="device-muted">Not reported</span>
                    )}
                  </dd>
                </div>
                {run.template_sha256 && (
                  <div>
                    <dt>Template the agent applied</dt>
                    <dd>
                      <code>{run.template_sha256}</code>
                    </dd>
                  </div>
                )}
              </dl>
              <p>
                {config.uses_local_secrets
                  ? "This version reads device secrets, so the file on the host holds the host's own values and its digest never equals the offered one. "
                  : ""}
                On the host, <code>sudo vectory status --json</code> prints the
                digest of its managed file as <code>actual_sha256</code>.
              </p>
            </Disclosure>
          </>
        )}
      </>
    );
  }

  return (
    <section
      className="device-card effective-config"
      aria-labelledby={titleId}
      aria-busy={(read.loading && !config) || undefined}
    >
      <div className="device-card-head">
        <div>
          <h2 id={titleId}>Effective configuration</h2>
          <p className="device-card-subtitle">
            What Vectory offered this device, with its values applied.
            Read-only.
          </p>
        </div>
        {drift && !neverOffered && (
          <StatusBadge tone={drift.tone} label={drift.badge} />
        )}
      </div>
      {body}
    </section>
  );
}
