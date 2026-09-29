export type DeploymentSort =
  "name" | "status" | "verified" | "created_at" | "scheduled_at";
export type DeploymentQuery = {
  search: string;
  status: string;
  page: number;
  sort?: DeploymentSort;
  direction?: "asc" | "desc";
};
const sorts = new Set([
  "name",
  "status",
  "verified",
  "created_at",
  "scheduled_at",
]);

const statuses = new Set([
  "all",
  "active",
  "completed",
  "scheduled",
  "paused",
  "failed",
  "cancelled",
  "unassigned",
  "missed",
]);

export function isDeploymentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/** Only browse context is accepted. A URL can never request a deployment action. */
export function readDeploymentQuery(
  search: string,
): DeploymentQuery | undefined {
  const values = new URLSearchParams(search);
  if (
    !["search", "status", "page", "sort", "direction"].some((key) =>
      values.has(key),
    )
  )
    return undefined;
  const status = values.get("status") || "all";
  const rawPage = values.get("page") || "1";
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
  const direction = values.get("direction");
  const selectedSort =
    values.get("sort") ||
    (!values.has("sort") && (direction === "asc" || direction === "desc")
      ? "created_at"
      : "");
  return {
    search: Array.from((values.get("search") || "").trim())
      .slice(0, 200)
      .join(""),
    status: statuses.has(status) ? status : "all",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    ...(sorts.has(selectedSort)
      ? {
          sort: selectedSort as DeploymentSort,
          direction:
            values.get("direction") === "asc"
              ? ("asc" as const)
              : ("desc" as const),
        }
      : {}),
  };
}

export function deploymentRoute(
  scheduled: boolean,
  id: string | null,
  query: DeploymentQuery,
): string {
  const normalized = readDeploymentQuery(
    new URLSearchParams({
      search: query.search,
      status: query.status,
      page: String(query.page),
      ...(query.sort
        ? { sort: query.sort, direction: query.direction || "desc" }
        : {}),
    }).toString(),
  )!;
  const params = new URLSearchParams();
  if (normalized.search) params.set("search", normalized.search);
  if (normalized.status !== "all") params.set("status", normalized.status);
  // An explicit page distinguishes a default view from an absent saved context.
  params.set("page", String(normalized.page));
  if (normalized.sort) {
    params.set("sort", normalized.sort);
    params.set("direction", normalized.direction || "desc");
  }
  const normalizedId = id && isDeploymentId(id) ? id.toLowerCase() : id;
  return `${scheduled ? "schedules" : "deployments"}${normalizedId ? `/${encodeURIComponent(normalizedId)}` : ""}?${params}`;
}
