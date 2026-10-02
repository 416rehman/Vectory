import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Copy,
  History,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { DataTable } from "./DataTable";
import {
  can,
  api,
  APIError,
  withRequestDeadline,
  PipelineRequestLookupSchema,
  PipelineCreateReceiptSchema,
  when,
  type Config,
  type Configuration,
  type PipelineLibraryPage,
  type PipelineSummary,
  type User,
} from "./api";
import {
  Button,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  IconButton,
  SearchBox,
  Skeleton,
  useResource,
} from "./ui";
import type { StartImport } from "./PipelineStartChoice";
import PipelineStatus, { libraryStatus } from "./PipelineStatus";
import PipelineCreationRecovery, {
  type PipelineCreationRecoveryHandle,
} from "./PipelineCreationRecovery";
import {
  beginPipelineCreationOperation,
  finishPipelineCreationOperation,
  pipelineCreationOperationAvailable,
  usePipelineCreationOperations,
  type PipelineCreationOperation,
} from "./pipelineCreationRequests";
import PipelineActions, { type PipelineAction } from "./PipelineActions";
import SelectedDevice, { pipelineRoute } from "./SelectedDevice";
import {
  pipelineDestinationLabel,
  type PipelineDestination,
} from "./pipelineDestination";
import { useCommand } from "./commands";
import { ChunkBoundary } from "./PageBoundary";
import { loadPage } from "./pageLoading";
import "./pipeline-library.css";
import type { Notify } from "./toast";

// The create dialog's start options (templates, import) download when the
// dialog is about to open: on hover or focus of Create, or when it opens.
const loadStartChoice = () => import("./PipelineStartChoice");
const PipelineStartChoice = lazy(() => loadPage(loadStartChoice));
const prefetchStartChoice = () => void loadStartChoice().catch(() => {});

export type PipelineLibraryQuery = {
  search: string;
  state: string;
  sort: string;
  direction?: "asc" | "desc";
  page: number;
};

function summary(counts: PipelineSummary["component_counts"]) {
  return (
    [
      ["sources", "source"],
      ["transforms", "transformation"],
      ["sinks", "destination"],
    ] as const
  )
    .map(([kind, label]) => {
      const count = counts[kind];
      return `${count} ${label}${count === 1 ? "" : "s"}`;
    })
    .join(" · ");
}

export default function PipelineLibrary({
  user,
  notify,
  navigate,
  initialDeviceId,
  initialQuery,
  onQueryChange,
  destination,
}: {
  user: User;
  notify: Notify;
  navigate(path: string): void;
  initialDeviceId?: string;
  initialQuery?: PipelineLibraryQuery;
  onQueryChange?(query: PipelineLibraryQuery): void;
  destination?: PipelineDestination;
}) {
  const recovery = usePipelineCreationOperations(user.id),
    recoveryRef = useRef<PipelineCreationRecoveryHandle>(null),
    createOpener = useRef<HTMLButtonElement | null>(null),
    createButton = useRef<HTMLButtonElement | null>(null),
    nameInput = useRef<HTMLInputElement | null>(null);
  const unresolved =
    recovery.operations.length > 0 || recovery.errors.length > 0;
  const active = useRef<AbortController | null>(null),
    mounted = useRef(false);
  const [notice, setNotice] = useState<"confirmed" | "uncertain" | null>(null);
  useEffect(() => {
    mounted.current = true;
    const guard = (e: Event) => {
      if (active.current) e.preventDefault();
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (active.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("vectory:before-navigate", guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      mounted.current = false;
      active.current?.abort();
      window.removeEventListener("vectory:before-navigate", guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  const [search, setSearch] = useState(initialQuery?.search || "");
  const [query, setQuery] = useState(
    initialQuery || {
      search: "",
      state: "active",
      sort: "updated",
      page: 1,
    },
  );
  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);
  const parameters = new URLSearchParams({
    search: query.search,
    state: query.state,
    sort: query.sort,
    page: String(query.page),
    page_size: "12",
  });
  if (query.direction) parameters.set("direction", query.direction);
  const { data, loading, error, reload, refreshing, updatedAt } =
    useResource<PipelineLibraryPage>(`/configurations/library?${parameters}`, {
      items: [],
      total: 0,
      page: query.page,
      page_size: 12,
    });
  const searching = search.trim() !== query.search;
  const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
  const correctingPage = !loading && !error && query.page > lastPage;
  useEffect(() => {
    const timeout = setTimeout(
      () =>
        setQuery((current) =>
          current.search === search.trim()
            ? current
            : { ...current, search: search.trim(), page: 1 },
        ),
      250,
    );
    return () => clearTimeout(timeout);
  }, [search]);
  // An archive (including in another tab) can remove the final row of a page.
  useEffect(() => {
    if (correctingPage) setQuery((current) => ({ ...current, page: lastPage }));
  }, [correctingPage, lastPage]);
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [nameEdited, setNameEdited] = useState(false),
    [description, setDescription] = useState(""),
    [template, setTemplate] = useState("empty"),
    [imported, setImported] = useState<StartImport | null>(null),
    [busy, setBusy] = useState(false),
    [nameError, setNameError] = useState(""),
    [formError, setFormError] = useState("");
  const [action, setAction] = useState<{
    configuration: PipelineSummary;
    action: PipelineAction;
  } | null>(null);
  // ⌘K and the Overview checklist open the create dialog through this command.
  // It runs after a route change, when nothing on this page has focus yet, so
  // the header's Create button stands in as the opener focus returns to.
  useCommand(
    "pipeline.create",
    () => beginCreate(createButton.current),
    can(user, "edit"),
  );
  function beginCreate(trigger: HTMLButtonElement | null) {
    if (active.current) return;
    prefetchStartChoice();
    createOpener.current = trigger;
    if (unresolved) {
      recoveryRef.current?.openSaved(
        trigger || document.getElementById("main-content")!,
      );
      return;
    }
    setNotice(null);
    setName("");
    setNameEdited(false);
    setDescription("");
    setTemplate("empty");
    setImported(null);
    setNameError("");
    setFormError("");
    setOpen(true);
  }
  // The name follows what you start from until you type your own.
  function chooseStart(id: string, templateName: string) {
    setTemplate(id);
    if (!nameEdited) setName(templateName);
  }
  function importStart(value: StartImport | null) {
    setImported(value);
    if (!nameEdited && value?.config && !value.name.startsWith("Pasted "))
      setName(value.name.replace(/\.(?:ya?ml|json|toml)$/i, ""));
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (active.current || busy || unresolved || notice || !can(user, "edit"))
      return;
    if (!name.trim()) {
      setNameError("Enter a pipeline name to create a draft.");
      nameInput.current?.focus();
      return;
    }
    setNameError("");
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setFormError("");
    const current = () => mounted.current && active.current === controller;
    let operation: PipelineCreationOperation | null = null,
      sent = false;
    try {
      let config: Config = { sources: {}, transforms: {}, sinks: {} },
        graph = { nodes: [], edges: [] } as Configuration["graph"];
      if (template === "import" && !imported?.config) {
        setFormError("Choose a Vector configuration file to import.");
        return;
      }
      if (template !== "empty") {
        const [{ toGraph }, { arrangeGraph }, { pipelineTemplate }] =
          await Promise.all([
            import("./catalog"),
            import("./pipelineEditing"),
            import("./pipelineTemplates"),
          ]);
        if (!current()) return;
        config = structuredClone(
          template === "import"
            ? imported!.config!
            : pipelineTemplate(template)!.config,
        );
        graph = arrangeGraph(toGraph(config));
      }
      operation = beginPipelineCreationOperation(user.id, {
        operation: "create",
        request: { name: name.trim(), description, config, graph },
      });
      const lookup = await withRequestDeadline(
        (signal) =>
          api(
            "/configurations/requests/" + operation!.id,
            { signal },
            PipelineRequestLookupSchema,
          ),
        30000,
        controller.signal,
      );
      if (!current()) return;
      if (lookup.request_id !== operation.id || lookup.found) {
        throw Error(
          "The saved request needs review before creating a pipeline.",
        );
      }
      if (!pipelineCreationOperationAvailable(operation))
        throw Error(
          "The saved request changed in another tab. Review it before continuing.",
        );
      sent = true;
      const result = await withRequestDeadline(
        (signal) =>
          api(
            "/configurations",
            {
              method: "POST",
              body: JSON.stringify(operation!.request),
              signal,
            },
            PipelineCreateReceiptSchema,
          ),
        30000,
        controller.signal,
      );
      if (!current()) return;
      if (result.request_id !== operation.id)
        throw Error("The server returned a different request identity.");
      try {
        finishPipelineCreationOperation(operation);
      } catch {
        setNotice("confirmed");
        setFormError(
          "The pipeline is saved, but this browser could not clear its reminder. Close this form and review the saved request.",
        );
        return;
      }
      active.current = null;
      setOpen(false);
      notify("Pipeline created.", { tone: "success" });
      navigate(pipelineRoute(result.id, initialDeviceId, destination));
    } catch (failure) {
      if (!current()) return;
      if (operation) {
        setNotice("uncertain");
        const message =
          failure instanceof APIError &&
          [404, 405].includes(failure.status) &&
          !sent
            ? "This tab did not send a creation request. Update the server to enable recovery, then review or dismiss this saved request."
            : (failure as Error).message;
        setFormError(
          message +
            " Review the saved pipeline request before trying again. A request in another tab may still complete.",
        );
        return;
      }
      setFormError((failure as Error).message);
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="pipeline-library">
      <PageHeader
        title="Pipelines"
        help={{ topic: "pipelines", section: "find-and-organize-pipelines" }}
        description="Build, publish, and maintain your event pipelines."
        live={{
          updatedAt,
          error,
          loading,
          refreshing,
          onRefresh: () => void reload(),
        }}
      >
        {can(user, "edit") && (
          <Button
            ref={createButton}
            icon={Plus}
            onPointerEnter={prefetchStartChoice}
            onFocus={prefetchStartChoice}
            onClick={(event) => beginCreate(event.currentTarget)}
          >
            {unresolved ? "Review saved requests" : "Create pipeline"}
          </Button>
        )}
      </PageHeader>
      {can(user, "edit") && (
        <PipelineCreationRecovery
          ref={recoveryRef}
          user={user}
          showRecent={false}
          onRecovered={() => {
            void reload();
          }}
          onReview={(result) => {
            navigate(pipelineRoute(result.id, initialDeviceId, destination));
            return false;
          }}
        />
      )}
      {initialDeviceId && (
        <SelectedDevice
          id={initialDeviceId}
          onClear={() => navigate(pipelineRoute())}
        />
      )}
      {destination && (
        <aside
          className="pipeline-device-context"
          aria-label="Pipeline destination"
        >
          <div>
            <strong>
              Choose a pipeline to open {pipelineDestinationLabel(destination)}.
            </strong>
            <p>
              Select an existing pipeline below, or create one to get started.
            </p>
          </div>
          <Button
            variant="ghost compact"
            onClick={() => navigate(pipelineRoute(undefined, initialDeviceId))}
          >
            Cancel
          </Button>
        </aside>
      )}
      <div className="pipeline-library-toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search pipelines"
          maxLength={200}
          shortcut
        />
        {can(user, "edit") && (
          <div className="pipeline-library-toolbar-tools">
            <IconButton
              icon={History}
              label="Your pipeline requests"
              onClick={(event) =>
                recoveryRef.current?.openRecent(event.currentTarget)
              }
            />
          </div>
        )}
      </div>
      <div className="pipeline-library-list">
        <DataTable
          label="Pipeline library"
          className="pipeline-library-table"
          data={data.items}
          rowKey={(pipeline) => pipeline.id}
          loading={loading || searching || correctingPage}
          error={
            error
              ? {
                  title: updatedAt
                    ? "Couldn't refresh pipelines."
                    : "Couldn't load pipelines.",
                  message: error,
                  updatedAt,
                  retry: () => void reload(),
                  retrying: refreshing,
                }
              : null
          }
          mobileCard={(pipeline) => {
            const status = libraryStatus(pipeline);
            return {
              title: pipeline.name,
              href: `#/${pipelineRoute(pipeline.id, initialDeviceId, destination)}`,
              status: status.changed ? (
                <span className="pipeline-status-chip">
                  Unpublished changes
                </span>
              ) : undefined,
              meta: [status.primary, status.detail],
            };
          }}
          manualSorting
          sort={{
            column: query.sort,
            direction:
              query.direction || (query.sort === "name" ? "asc" : "desc"),
          }}
          onSortChange={(sort) => {
            if (sort)
              setQuery({
                ...query,
                search: search.trim(),
                sort: sort.column,
                direction: sort.direction,
                page: 1,
              });
          }}
          pagination={
            loading || searching || correctingPage
              ? undefined
              : {
                  total: data.total,
                  page: query.page,
                  size: data.page_size,
                  onPage: (page) => setQuery((old) => ({ ...old, page })),
                }
          }
          empty={
            <section className="pipeline-library-empty">
              <h2>
                {query.search
                  ? "No matching pipelines"
                  : query.state === "archived"
                    ? "No archived pipelines"
                    : "Create your first pipeline"}
              </h2>
              <p>
                {query.search
                  ? "Try a different name or change the Status column filter."
                  : query.state === "archived"
                    ? "Archived pipelines stay available here with their history and published versions."
                    : "Start with a source and a destination. Add transformations when you need to filter or change events."}
              </p>
              {query.search ? (
                <Button variant="secondary" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              ) : query.state === "active" && can(user, "edit") ? (
                <Button
                  onPointerEnter={prefetchStartChoice}
                  onFocus={prefetchStartChoice}
                  onClick={(event) => beginCreate(event.currentTarget)}
                >
                  {unresolved ? "Review saved requests" : "Create pipeline"}
                </Button>
              ) : null}
            </section>
          }
          columns={[
            {
              id: "name",
              header: "Pipeline",
              sortable: true,
              cell: (c) => (
                <button
                  className="pipeline-list-item"
                  onClick={() =>
                    navigate(pipelineRoute(c.id, initialDeviceId, destination))
                  }
                >
                  <div>
                    <strong>{c.name}</strong>
                    {c.description && <p>{c.description}</p>}
                    <span className="pipeline-library-summary">
                      {summary(c.component_counts)}
                    </span>
                  </div>
                </button>
              ),
            },
            {
              id: "status",
              header: "Status",
              filter: {
                value: query.state,
                emptyValue: "active",
                allLabel: "Active pipelines",
                options: [{ value: "archived", label: "Archived pipelines" }],
                manual: true,
                onChange: (state) =>
                  setQuery({ ...query, search: search.trim(), state, page: 1 }),
              },
              cell: (c) => <PipelineStatus pipeline={c} />,
            },
            {
              id: "updated",
              header: "Updated",
              sortable: true,
              cell: (c) => when(c.updated_at),
            },
            {
              id: "actions",
              header: <span className="sr-only">Actions</span>,
              cell: (c) =>
                can(user, "edit") && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Actions for ${c.name}`}
                      >
                        <MoreHorizontal size={18} aria-hidden="true" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="pipeline-table-menu"
                        align="end"
                        sideOffset={6}
                        collisionPadding={12}
                      >
                        {(
                          [
                            "duplicate",
                            c.archived ? "unarchive" : "archive",
                          ] as PipelineAction[]
                        ).map((value) => {
                          const Icon =
                            value === "duplicate"
                              ? Copy
                              : value === "archive"
                                ? Archive
                                : ArchiveRestore;
                          return (
                            <DropdownMenu.Item
                              key={value}
                              disabled={value === "duplicate" && unresolved}
                              onSelect={() =>
                                setAction({ configuration: c, action: value })
                              }
                            >
                              <Icon size={15} aria-hidden="true" />
                              {value === "duplicate"
                                ? "Duplicate pipeline"
                                : value === "archive"
                                  ? "Archive pipeline"
                                  : "Unarchive pipeline"}
                            </DropdownMenu.Item>
                          );
                        })}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                ),
            },
          ]}
        />
      </div>
      {action && (
        <PipelineActions
          {...action}
          user={user}
          onRecovery={() => {
            setAction(null);
            recoveryRef.current?.openSaved(
              createOpener.current || document.getElementById("main-content")!,
            );
          }}
          onClose={() => setAction(null)}
          onReloaded={reload}
          onSaved={(result) => {
            const completed = action.action;
            setAction(null);
            if (completed === "duplicate") {
              notify("Pipeline duplicated.", { tone: "success" });
              navigate(pipelineRoute(result.id, initialDeviceId, destination));
            } else {
              notify(
                completed === "archive"
                  ? "Pipeline archived. Running deployments are unchanged."
                  : "Pipeline unarchived.",
                { tone: "success" },
              );
              reload();
            }
          }}
        />
      )}
      <Modal
        open={open}
        onClose={() => !active.current && !busy && setOpen(false)}
        returnFocusRef={createOpener}
        title="Create pipeline"
        description="Create a draft first. Review devices after publishing."
      >
        <form onSubmit={create} noValidate>
          <div className="modal-body">
            {formError && <ErrorBox message={formError} />}
            {notice && (
              <section role="status">
                <h3>
                  {notice === "confirmed"
                    ? "Pipeline saved"
                    : "Creation result needs confirmation"}
                </h3>
                <p>
                  {notice === "confirmed"
                    ? "The pipeline was created successfully. Its browser reminder still needs review."
                    : "Your exact request is saved in this browser, including after closing or reloading this tab."}
                </p>
              </section>
            )}
            {unresolved && !notice && !busy && (
              <ErrorBox message="Review the saved pipeline requests before creating another pipeline." />
            )}
            <Field label="Pipeline name" hint="You can rename it later.">
              <input
                ref={nameInput}
                required
                autoFocus
                disabled={busy || !!notice || unresolved}
                maxLength={120}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                  setNameError("");
                }}
                aria-invalid={!!nameError}
                aria-describedby={nameError ? "pipeline-name-error" : undefined}
                placeholder="Application logs"
              />
            </Field>
            {nameError && (
              <p
                id="pipeline-name-error"
                className="pipeline-library-name-error"
                role="alert"
              >
                {nameError}
              </p>
            )}
            <ChunkBoundary
              fallback={() => (
                <ErrorBox message="The ways to start didn’t load. Check your connection, then reload the page." />
              )}
            >
              <Suspense fallback={<StartChoiceSkeleton />}>
                <PipelineStartChoice
                  value={template}
                  disabled={busy || !!notice || unresolved}
                  imported={imported}
                  onChange={chooseStart}
                  onImport={importStart}
                />
              </Suspense>
            </ChunkBoundary>
            <Field label="Description (optional)">
              <textarea
                rows={2}
                disabled={busy || !!notice || unresolved}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this pipeline for?"
              />
            </Field>
          </div>
          <div className="modal-footer">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (active.current) return;
                setOpen(false);
                if (notice)
                  recoveryRef.current?.openSaved(
                    createOpener.current ||
                      document.getElementById("main-content")!,
                  );
              }}
            >
              {notice ? "Close and review request" : "Cancel"}
            </Button>
            <Button type="submit" busy={busy} disabled={!!notice || unresolved}>
              Create pipeline
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** The start options' shape while their file downloads. */
function StartChoiceSkeleton() {
  return (
    <div className="pipeline-start-loading" aria-busy="true">
      <span className="sr-only" role="status">
        Loading the ways to start…
      </span>
      <Skeleton width={180} height={14} />
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} width="100%" height={52} radius={10} />
      ))}
    </div>
  );
}
