import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  GitCompareArrows,
  Tag,
  History,
  FileJson2,
} from "lucide-react";
import {
  api,
  can,
  when,
  withRequestDeadline,
  type Config,
  type Configuration,
  type User,
  type Version,
} from "./api";
import { configurationDiff } from "./configurationDiff";
import HistoryChange from "./HistoryChange";
import { stringifyConfiguration } from "./configurationFormats";
import { HelpLink } from "./DocLink";
import {
  Button,
  ErrorBox,
  Modal,
  Pagination,
  RefreshButton,
  Spinner,
} from "./ui";
import TabLabel from "./TabLabel";
import "./pipeline-history.css";

type HistoryKind = "versions" | "revisions";
type Summary = {
  id: string;
  number?: number;
  revision?: number;
  created_at: string;
  message?: string;
  author?: string | { name?: string };
  author_id?: string;
  source_revision?: number;
  source?: {
    kind: "draft" | "revision" | "version";
    id: string;
    revision?: number;
  };
};
type HistoryPage = {
  items: Summary[];
  total: number;
  page: number;
  page_size: number;
};
type Selection = { kind: HistoryKind; item: Summary };
type Snapshot = Summary & {
  configuration_id?: string;
  config: Config;
  graph?: Configuration["graph"];
};
type Props = {
  initialVersion?: Version | null;
  saveIndicator?: ReactNode;
  configuration: Configuration & { archived?: boolean };
  draft: Config;
  hasPendingFields: boolean;
  user: User;
  onClose: () => void;
  onRestore: (source: {
    revision_id?: string;
    version_id?: string;
  }) => Promise<boolean>;
  onDeploy: (version: Version) => void;
};

const PAGE_SIZE = 12;
const CHANGE_PAGE_SIZE = 25;
const label = (selection: Selection) =>
  `${selection.kind === "versions" ? "Version" : "Revision"} ${selection.item.number ?? selection.item.revision ?? ""}`.trim();
const selectionKey = (selection: Selection | null) =>
  selection ? `${selection.kind}/${selection.item.id}` : "draft";

function useRead<T>(
  path: string | null,
  revision = 0,
  expectedParent?: string,
) {
  const key = `${path ?? ""}:${revision}:${expectedParent || ""}`;
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    loading: boolean;
    error: string;
  }>({ key, data: null, loading: !!path, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ key, data: null, loading: !!path, error: "" });
    if (path)
      void withRequestDeadline(
        (signal) => api<T>(path, { signal }),
        30000,
        controller.signal,
      )
        .then((data) => {
          if (expectedParent) {
            const snapshot = data as Record<string, unknown> | null;
            if (
              !snapshot ||
              snapshot.id !== decodeURIComponent(path.split("/").pop()!) ||
              snapshot.configuration_id !== expectedParent
            )
              throw Error(
                "The server returned a different snapshot. Refresh before reviewing or deploying this version.",
              );
          }
          if (current) setState({ key, data, loading: false, error: "" });
        })
        .catch((error) => {
          if (current)
            setState({
              key,
              data: null,
              loading: false,
              error: (error as Error).message,
            });
        });
    return () => {
      current = false;
      controller.abort();
    };
  }, [path, revision, key, expectedParent]);
  return state.key === key
    ? state
    : { key, data: null, loading: !!path, error: "" };
}

function historyPath(id: string, kind: HistoryKind, page: number) {
  return `/configurations/${encodeURIComponent(id)}/history?kind=${kind}&page=${page}&page_size=${PAGE_SIZE}`;
}
function snapshotPath(id: string, selected: Selection | null) {
  if (!selected) return null;
  return selected.kind === "versions"
    ? `/versions/${encodeURIComponent(selected.item.id)}`
    : `/configurations/${encodeURIComponent(id)}/revisions/${encodeURIComponent(selected.item.id)}`;
}
function author(item: Summary) {
  if (typeof item.author === "object") return item.author?.name || "";
  // An opaque identity is available in the full snapshot, but is not useful as
  // the primary author label. Prefer a server-supplied human name when present.
  return item.author && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(item.author)
    ? item.author
    : "";
}
function sourceDescription(item: Summary) {
  if (item.source_revision != null)
    return `Published from draft revision ${item.source_revision}.`;
  if (item.source?.kind === "version")
    return "Restored from a published version.";
  if (item.source?.kind === "revision")
    return "Restored from a saved revision.";
  if (item.source?.kind === "draft")
    return item.source.revision != null
      ? `Copied from draft revision ${item.source.revision}.`
      : "Copied from another pipeline's saved draft.";
  return "";
}
function KindSwitch({
  value,
  onChange,
  name,
}: {
  value: HistoryKind;
  onChange: (kind: HistoryKind) => void;
  name: string;
}) {
  return (
    <div className="history-kind-switch" role="group" aria-label={name}>
      <button
        aria-pressed={value === "versions"}
        onClick={() => onChange("versions")}
      >
        <TabLabel icon={Tag}>Published versions</TabLabel>
      </button>
      <button
        aria-pressed={value === "revisions"}
        onClick={() => onChange("revisions")}
      >
        <TabLabel icon={History}>Draft revisions</TabLabel>
      </button>
    </div>
  );
}
function HistoryRows({
  items,
  kind,
  selected,
  onSelect,
  action = "View",
}: {
  items: Summary[];
  kind: HistoryKind;
  selected: string;
  onSelect: (selection: Selection) => void;
  action?: string;
}) {
  return (
    <ol className="history-list">
      {items.map((item) => {
        const selection = { kind, item },
          name = label(selection),
          by = author(item);
        return (
          <li key={item.id}>
            <button
              className="history-row"
              aria-label={`${action} ${name.toLowerCase()}`}
              aria-pressed={selected === selectionKey(selection)}
              onClick={() => onSelect(selection)}
            >
              <span className="history-row-title">
                <strong>{name}</strong>
                <time dateTime={item.created_at}>{when(item.created_at)}</time>
              </span>
              {item.message && (
                <span className="history-row-message">{item.message}</span>
              )}
              {by && <span className="history-row-author">{by}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
export default function PipelineHistory({
  initialVersion,
  saveIndicator,
  configuration,
  draft,
  hasPendingFields,
  user,
  onClose,
  onRestore,
  onDeploy,
}: Props) {
  const [kind, setKind] = useState<HistoryKind>("versions"),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<Selection | null>(
      initialVersion?.configuration_id === configuration.id
        ? { kind: "versions", item: initialVersion }
        : null,
    );
  const [comparison, setComparison] = useState<Selection | null>(null),
    [compareOpen, setCompareOpen] = useState(false),
    [pickerKind, setPickerKind] = useState<HistoryKind>("versions"),
    [pickerPage, setPickerPage] = useState(1);
  const [view, setView] = useState<"changes" | "configuration">("changes"),
    [changePage, setChangePage] = useState(1),
    [refresh, setRefresh] = useState(0);
  const [restoreOpen, setRestoreOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const preview = useRef<HTMLDivElement>(null);
  const history = useRead<HistoryPage>(
    historyPath(configuration.id, kind, page),
    refresh,
  );
  const snapshot = useRead<Snapshot>(
    snapshotPath(configuration.id, selected),
    refresh,
    configuration.id,
  );
  const compared = useRead<Snapshot>(
    snapshotPath(configuration.id, comparison),
    refresh,
    configuration.id,
  );
  const picker = useRead<HistoryPage>(
    compareOpen ? historyPath(configuration.id, pickerKind, pickerPage) : null,
    refresh,
  );
  const beforeLabel = selected ? label(selected) : "Snapshot",
    afterLabel = comparison ? label(comparison) : "Current draft";
  const metadata = snapshot.data || selected?.item;
  const before = snapshot.data?.config,
    after = comparison ? compared.data?.config : draft;
  const differences = useMemo(
    () => (before && after ? configurationDiff(before, after) : []),
    [before, after],
  );
  const changes = differences.slice(
    (changePage - 1) * CHANGE_PAGE_SIZE,
    changePage * CHANGE_PAGE_SIZE,
  );
  const changeCounts = useMemo(
    () =>
      differences.reduce(
        (counts, difference) => {
          counts[difference.kind]++;
          return counts;
        },
        { added: 0, removed: 0, changed: 0 },
      ),
    [differences],
  );
  const editable = can(user, "edit") && !configuration.archived;
  const restoreDisabled =
    !editable || hasPendingFields || !snapshot.data || snapshot.loading || busy;

  useEffect(() => {
    setSelected(
      initialVersion?.configuration_id === configuration.id
        ? { kind: "versions", item: initialVersion }
        : null,
    );
    setComparison(null);
    setPage(1);
    setChangePage(1);
    setRestoreOpen(false);
    setActionError("");
  }, [configuration.id]);
  useEffect(() => {
    if (
      !history.loading &&
      history.data &&
      !selected &&
      history.data.items.length
    )
      setSelected({ kind, item: history.data.items[0] });
  }, [history.loading, history.data, selected, kind]);
  useEffect(() => setChangePage(1), [before, after]);
  useEffect(() => {
    if (
      history.data &&
      page > Math.max(1, Math.ceil(history.data.total / PAGE_SIZE))
    )
      setPage(Math.max(1, Math.ceil(history.data.total / PAGE_SIZE)));
  }, [history.data, page]);

  function choose(selection: Selection) {
    setSelected(selection);
    setActionError("");
    setRestoreOpen(false);
    if (window.matchMedia("(max-width: 760px)").matches)
      preview.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function switchKind(next: HistoryKind) {
    setKind(next);
    setPage(1);
    setSelected(null);
    setActionError("");
  }
  function movePage(next: number) {
    setPage(next);
    setSelected(null);
  }
  async function restore() {
    if (!selected || restoreDisabled) return;
    setBusy(true);
    setActionError("");
    try {
      const restored = await onRestore(
        selected.kind === "versions"
          ? { version_id: selected.item.id }
          : { revision_id: selected.item.id },
      );
      if (restored) {
        setRestoreOpen(false);
        onClose();
      } else
        setActionError(
          "The snapshot could not be restored. Your current draft is still here.",
        );
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pipeline-history" aria-label="Pipeline history">
      <header className="history-heading">
        <div>
          <div className="page-title-row">
            <h2>History</h2>
            <HelpLink
              topic="pipelines"
              section="compare-saved-history"
              label="Help for pipeline history"
            />
          </div>
          <p>Review saved drafts and immutable published versions.</p>
        </div>
        <div className="history-heading-actions">
          {saveIndicator}
          <RefreshButton
            onClick={() => setRefresh((value) => value + 1)}
            disabled={busy}
          >
            Refresh history
          </RefreshButton>
        </div>
      </header>
      {configuration.archived && (
        <p className="history-note">
          This pipeline is archived. Its draft is read-only. Published versions
          remain available to deploy, including rollback to an earlier version.
        </p>
      )}
      {hasPendingFields && (
        <p className="history-note">
          Some editor fields have unapplied changes. They are preserved in the
          editor and excluded from this comparison. Finish or discard those
          field changes before restoring a snapshot.
        </p>
      )}
      <div className="history-workspace">
        <aside className="history-sidebar" aria-label="Saved snapshots">
          <KindSwitch name="History type" value={kind} onChange={switchKind} />
          {history.error && (
            <ErrorBox
              message={history.error}
              retry={() => setRefresh((value) => value + 1)}
            />
          )}
          {history.loading ? (
            <p className="history-loading" role="status">
              <Spinner />
              Loading history…
            </p>
          ) : history.data?.items.length ? (
            <>
              <HistoryRows
                items={history.data.items}
                kind={kind}
                selected={selectionKey(selected)}
                onSelect={choose}
              />
              <Pagination
                count={history.data.total}
                page={page}
                size={PAGE_SIZE}
                onPage={movePage}
              />
            </>
          ) : (
            !history.error && (
              <div className="history-empty">
                <h3>
                  {kind === "versions"
                    ? "No published versions"
                    : "No saved revisions"}
                </h3>
                <p>
                  {kind === "versions"
                    ? "Publish a saved draft to create a version that can be deployed."
                    : "Save a change in the editor to create a draft revision."}
                </p>
                {kind === "versions" && (
                  <Button
                    variant="secondary"
                    onClick={() => switchKind("revisions")}
                  >
                    View draft revisions
                  </Button>
                )}
              </div>
            )
          )}
        </aside>
        <div className="history-preview" ref={preview}>
          {!selected ? (
            <div className="history-empty">
              <h3>Choose a snapshot</h3>
              <p>
                Select a published version or saved revision to inspect its
                configuration.
              </p>
            </div>
          ) : (
            <>
              <div className="history-snapshot-heading">
                <div>
                  <h3>{beforeLabel}</h3>
                  <p>
                    <time dateTime={selected.item.created_at}>
                      {when(selected.item.created_at)}
                    </time>
                    {author(selected.item) && <> · {author(selected.item)}</>}
                  </p>
                  {selected.item.message && (
                    <p className="history-message">{selected.item.message}</p>
                  )}
                  {metadata && sourceDescription(metadata) && (
                    <p className="history-source">
                      {sourceDescription(metadata)}
                    </p>
                  )}
                  {metadata && (
                    <details className="history-provenance">
                      <summary>Snapshot details</summary>
                      <dl>
                        <div>
                          <dt>Snapshot ID</dt>
                          <dd>{metadata.id}</dd>
                        </div>
                        {author(metadata) && (
                          <div>
                            <dt>Author</dt>
                            <dd>{author(metadata)}</dd>
                          </div>
                        )}
                        {metadata.author_id && (
                          <div>
                            <dt>Author ID</dt>
                            <dd>{metadata.author_id}</dd>
                          </div>
                        )}
                        {metadata.source_revision != null && (
                          <div>
                            <dt>Source draft revision</dt>
                            <dd>{metadata.source_revision}</dd>
                          </div>
                        )}
                        {metadata.source && (
                          <>
                            <div>
                              <dt>Source</dt>
                              <dd>
                                {metadata.source.kind === "version"
                                  ? "Published version"
                                  : metadata.source.kind === "revision"
                                    ? "Saved revision"
                                    : "Pipeline draft"}
                              </dd>
                            </div>
                            <div>
                              <dt>Source ID</dt>
                              <dd>{metadata.source.id}</dd>
                            </div>
                            {metadata.source.revision != null && (
                              <div>
                                <dt>Source draft revision</dt>
                                <dd>{metadata.source.revision}</dd>
                              </div>
                            )}
                          </>
                        )}
                      </dl>
                    </details>
                  )}
                </div>
                <div className="history-snapshot-actions">
                  {can(user, "edit") && (
                    <Button
                      variant="secondary"
                      disabled={restoreDisabled}
                      onClick={() => {
                        setActionError("");
                        setRestoreOpen(true);
                      }}
                    >
                      Restore as draft
                    </Button>
                  )}
                  {selected.kind === "versions" && can(user, "operate") && (
                    <Button
                      disabled={snapshot.loading || !snapshot.data || busy}
                      onClick={() =>
                        snapshot.data && onDeploy(snapshot.data as Version)
                      }
                    >
                      Deploy this version
                    </Button>
                  )}
                </div>
              </div>
              <div
                className="history-view-switch"
                role="group"
                aria-label="Snapshot view"
              >
                <button
                  aria-pressed={view === "changes"}
                  onClick={() => setView("changes")}
                >
                  <TabLabel icon={GitCompareArrows}>Compare changes</TabLabel>
                </button>
                <button
                  aria-pressed={view === "configuration"}
                  onClick={() => setView("configuration")}
                >
                  <TabLabel icon={FileJson2}>Configuration</TabLabel>
                </button>
              </div>
              {snapshot.error && (
                <ErrorBox
                  message={snapshot.error}
                  retry={() => setRefresh((value) => value + 1)}
                />
              )}
              {snapshot.loading ? (
                <p className="history-loading" role="status">
                  <Spinner />
                  Loading snapshot…
                </p>
              ) : (
                snapshot.data &&
                (view === "configuration" ? (
                  <>
                    <p className="history-caption">
                      Read-only configuration from {beforeLabel.toLowerCase()}.
                      All configuration fields are included.
                    </p>
                    <textarea
                      className="history-json"
                      aria-label={`${beforeLabel} configuration JSON`}
                      value={stringifyConfiguration(
                        snapshot.data.config,
                        "json",
                      )}
                      readOnly
                      spellCheck={false}
                    />
                  </>
                ) : (
                  <>
                    <div className="history-comparison">
                      <span>
                        <strong>{beforeLabel}</strong>
                        <ArrowRight size={15} aria-hidden="true" />
                        <strong>{afterLabel}</strong>
                      </span>
                      <Button
                        variant="secondary compact"
                        icon={GitCompareArrows}
                        onClick={() => {
                          setPickerPage(1);
                          setCompareOpen(true);
                        }}
                      >
                        Choose comparison
                      </Button>
                    </div>
                    <p className="history-caption">
                      Configuration values only. Canvas layout, names and
                      descriptions are not compared. Array order matters.
                    </p>
                    {compared.error && (
                      <ErrorBox
                        message={compared.error}
                        retry={() => setRefresh((value) => value + 1)}
                      />
                    )}
                    {comparison && compared.loading ? (
                      <p className="history-loading" role="status">
                        <Spinner />
                        Loading comparison…
                      </p>
                    ) : (
                      after && (
                        <>
                          <p className="history-difference-count" role="status">
                            {differences.length === 0
                              ? "No configuration differences."
                              : `${differences.length.toLocaleString()} configuration ${differences.length === 1 ? "change" : "changes"}`}
                          </p>
                          {!!differences.length && (
                            <>
                              <div
                                className="history-change-counts"
                                role="group"
                                aria-label="Change summary"
                              >
                                <span className="history-added">
                                  + {changeCounts.added} added
                                </span>
                                <span className="history-removed">
                                  − {changeCounts.removed} removed
                                </span>
                                <span className="history-modified">
                                  ~ {changeCounts.changed} modified
                                </span>
                              </div>
                              <ol
                                className="history-changes"
                                aria-label="Configuration differences"
                              >
                                {changes.map((difference) => (
                                  <HistoryChange
                                    key={`${difference.kind}:${JSON.stringify(difference.path)}`}
                                    difference={difference}
                                    before={beforeLabel}
                                    after={afterLabel}
                                  />
                                ))}
                              </ol>
                              <Pagination
                                count={differences.length}
                                page={changePage}
                                size={CHANGE_PAGE_SIZE}
                                onPage={setChangePage}
                              />
                            </>
                          )}
                        </>
                      )
                    )}
                  </>
                ))
              )}
            </>
          )}
        </div>
      </div>

      <Modal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        title="Choose comparison"
        description={`Compare configuration from ${beforeLabel.toLowerCase()} with another snapshot or your current draft.`}
      >
        <div className="modal-body history-comparison-picker">
          <Button
            variant="secondary"
            onClick={() => {
              setComparison(null);
              setCompareOpen(false);
            }}
          >
            Compare with current draft
          </Button>
          <KindSwitch
            name="Comparison history type"
            value={pickerKind}
            onChange={(next) => {
              setPickerKind(next);
              setPickerPage(1);
            }}
          />
          {picker.error && (
            <ErrorBox
              message={picker.error}
              retry={() => setRefresh((value) => value + 1)}
            />
          )}
          {picker.loading ? (
            <p className="history-loading" role="status">
              <Spinner />
              Loading snapshots…
            </p>
          ) : picker.data?.items.length ? (
            <>
              <HistoryRows
                items={picker.data.items}
                kind={pickerKind}
                selected={selectionKey(comparison)}
                action="Compare with"
                onSelect={(selection) => {
                  setComparison(selection);
                  setCompareOpen(false);
                }}
              />
              <Pagination
                count={picker.data.total}
                page={pickerPage}
                size={PAGE_SIZE}
                onPage={setPickerPage}
              />
            </>
          ) : (
            !picker.error && (
              <p className="history-caption">
                No{" "}
                {pickerKind === "versions"
                  ? "published versions"
                  : "saved revisions"}{" "}
                yet.
              </p>
            )
          )}
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setCompareOpen(false)}>
            Cancel
          </Button>
        </div>
      </Modal>
      <Modal
        open={restoreOpen}
        onClose={() => !busy && setRestoreOpen(false)}
        title={`Restore ${beforeLabel.toLowerCase()} as draft?`}
        description="This creates a new draft revision. Published versions and running devices stay unchanged."
      >
        <div className="modal-body">
          <p>
            The current draft configuration and canvas will be replaced with
            this snapshot. The pipeline name and description are kept. Review
            and publish the restored draft before deploying it.
          </p>
          {hasPendingFields && (
            <p className="history-note">
              Finish or discard the unapplied editor fields before restoring.
            </p>
          )}
          {actionError && <ErrorBox message={actionError} />}
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setRestoreOpen(false)}
          >
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={restoreDisabled}
            onClick={() => void restore()}
          >
            Restore draft
          </Button>
        </div>
      </Modal>
    </section>
  );
}
