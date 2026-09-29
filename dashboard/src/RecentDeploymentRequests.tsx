import { useEffect, useState, type RefObject } from "react";
import { ArrowRight } from "lucide-react";
import {
  api,
  withRequestDeadline,
  type DeploymentRequestPage,
  type DeploymentRequestSummary,
} from "./api";
import { DataTable } from "./DataTable";
import { deploymentRoute } from "./deploymentRouting";
import {
  Button,
  DateCell,
  ErrorBox,
  Field,
  Modal,
  Pagination,
  RefreshButton,
  StatusBadge,
} from "./ui";
import "./deployment-recovery.css";

export default function RecentDeploymentRequests({
  onClose,
  returnFocusRef,
}: {
  onClose(): void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [operation, setOperation] = useState("all"),
    [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const path = `/deployments/requests?operation=${operation}&page=${page}&page_size=12`;
  const empty = { items: [], total: 0, page, page_size: 12 };
  const [result, setResult] = useState<{
    path: string;
    data: DeploymentRequestPage;
    loading: boolean;
    error: string;
  }>({ path, data: empty, loading: true, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setResult({ path, data: empty, loading: true, error: "" });
    void withRequestDeadline((deadline) => {
      deadline.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
      return api<DeploymentRequestPage>(path, { signal: controller.signal });
    })
      .then((data) => {
        if (current) setResult({ path, data, loading: false, error: "" });
      })
      .catch((failure) => {
        if (current)
          setResult({
            path,
            data: empty,
            loading: false,
            error: (failure as Error).message,
          });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [path, refresh]);
  const { data, error, loading } =
    result.path === path ? result : { data: empty, loading: true, error: "" };
  const reload = () => setRefresh((value) => value + 1);
  const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
  const correcting = !loading && !error && page > lastPage;
  useEffect(() => {
    if (correcting) setPage(lastPage);
  }, [correcting, lastPage]);
  const name = (row: DeploymentRequestSummary) =>
    row.deployment_name ||
    (row.resource === "policy"
      ? "Agent settings"
      : row.configuration_name || "Pipeline deployment");
  return (
    <Modal
      open
      title="Your recent requests"
      description="Find deployments and rollbacks saved for your account, including requests sent from another tab or device."
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      wide
    >
      <div className="modal-body deployment-request-history">
        <div className="deployment-request-history-toolbar">
          <Field label="Request type">
            <select
              value={operation}
              onChange={(event) => {
                setOperation(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All requests</option>
              <option value="create">Deployments</option>
              <option value="rollback">Rollbacks</option>
            </select>
          </Field>
          <RefreshButton busy={loading} onClick={reload}>
            Refresh
          </RefreshButton>
        </div>
        {error && <ErrorBox message={error} retry={reload} />}
        <DataTable<DeploymentRequestSummary>
          label="Your saved requests"
          data={error ? [] : data.items}
          rowKey={(row) => row.request_id}
          loading={loading || correcting}
          columns={[
            {
              id: "request",
              header: "Request",
              sortable: false,
              cell: (row) => (
                <>
                  <a
                    className="control-row-title"
                    href={`#/${deploymentRoute(!!row.scheduled_at, row.deployment_id, { search: "", status: "all", page: 1 })}`}
                    onClick={(event) => {
                      if (
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey &&
                        !event.altKey
                      )
                        onClose();
                    }}
                  >
                    {name(row)}
                    <ArrowRight size={14} aria-hidden="true" />
                  </a>
                  <small>
                    {row.operation === "rollback" ? "Rollback" : "Deployment"}
                    {row.version_number
                      ? ` · Version ${row.version_number}`
                      : ""}
                  </small>
                  {row.source_deployment_id && (
                    <a
                      className="deployment-request-source"
                      href={`#/${deploymentRoute(false, row.source_deployment_id, { search: "", status: "all", page: 1 })}`}
                      onClick={(event) => {
                        if (
                          !event.ctrlKey &&
                          !event.metaKey &&
                          !event.shiftKey &&
                          !event.altKey
                        )
                          onClose();
                      }}
                    >
                      Original rollout
                    </a>
                  )}
                </>
              ),
            },
            {
              id: "saved",
              header: "Saved",
              sortable: false,
              cell: (row) => <DateCell value={row.created_at} />,
            },
            {
              id: "status",
              header: "Deployment status",
              sortable: false,
              cell: (row) =>
                row.deployment_status ? (
                  <StatusBadge
                    domain="deployment"
                    value={row.deployment_status}
                  />
                ) : (
                  <span className="control-muted">Unavailable</span>
                ),
            },
          ]}
          empty={error ? "Requests unavailable." : "No saved requests found."}
        />
        {!loading && !error && !correcting && (
          <Pagination
            count={data.total}
            page={page}
            size={data.page_size}
            onPage={setPage}
          />
        )}
        <p className="control-muted deployment-request-history-note">
          Only requests saved by the server appear here. A missing request may
          still be in flight. Use a saved recovery reminder to retry the same
          request; check history before creating a replacement.
        </p>
      </div>
      <div className="modal-footer">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
