import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
  Filter,
  Search,
  X,
} from "lucide-react";
import { InlineError, Pagination, Skeleton, useMediaQuery } from "./ui";
import {
  clampPage,
  matchesTableFilter,
  nextSort,
  sortTableRows,
  type TableSort,
  type TableValue,
} from "./dataTableModel";
import "./data-table.css";

export type { TableSort, TableValue } from "./dataTableModel";
export type TableFilterOption = {
  value: string;
  label: string;
  /** Rows this option keeps; zero-count options stay selectable but quiet. */
  count?: number;
};
export type TableFilter = {
  options?: TableFilterOption[];
  placeholder?: string;
  allLabel?: string;
  emptyValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  manual?: boolean;
  content?: ReactNode;
  active?: boolean;
  onClear?: () => void;
};
export type TableColumn<T> = {
  id: string;
  header: ReactNode;
  label?: string;
  cell: (row: T) => ReactNode;
  value?: (row: T) => TableValue;
  sortValue?: (row: T) => TableValue;
  sortable?: boolean;
  /** First sort direction; use "desc" for times so newest comes first. */
  defaultDirection?: "asc" | "desc";
  /** Fixed column width, so loading and loaded layouts line up. */
  width?: number | string;
  className?: string;
  headerClassName?: string;
  filter?: TableFilter;
};
type TablePagination = {
  page: number;
  size: number;
  onPage: (page: number) => void;
  total?: number;
  /** Offer a page-size choice. */
  sizeOptions?: number[];
  onSize?: (size: number) => void;
  /** Keep controls visible when everything fits on one page. */
  alwaysShow?: boolean;
  noun?: string;
};
/** A failed read: one message in the card, the last rows kept but dimmed. */
export type TableError = {
  title: string;
  message: string;
  updatedAt?: number | null;
  retry?: () => void;
  retrying?: boolean;
};
export type MobileCard = {
  title: ReactNode;
  href?: string | null;
  status?: ReactNode;
  meta?: ReactNode[];
  leading?: ReactNode;
  /** The row's own buttons, under its details. */
  actions?: ReactNode;
};
const interactiveSelector =
  "a, button, input, select, textarea, label, summary, [role='button'], [role='menuitem'], [role='checkbox'], [data-row-ignore]";

function ColumnFilter({
  label,
  filter,
  value,
  onChange,
}: {
  label: string;
  filter: TableFilter;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const active = filter.active ?? value !== (filter.emptyValue ?? "");
  const options = filter.options?.filter((option) =>
    option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const clear = () => {
    filter.onClear ? filter.onClear() : onChange(filter.emptyValue ?? "");
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="data-table-filter"
          data-active={active || undefined}
          aria-label={`Filter ${label}${active ? " (active)" : ""}`}
          title={`Filter ${label}`}
        >
          <Filter size={13} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          className="data-table-filter-menu"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label={`Filter ${label}`}
          onOpenAutoFocus={(event) => {
            const target = content.current?.querySelector<HTMLElement>(
              'input, select, [role="radio"][aria-checked="true"]',
            );
            if (target) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
        >
          <div className="data-table-filter-heading">
            <strong>{label}</strong>
            <Popover.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={`Close ${label} filter`}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </Popover.Close>
          </div>
          {filter.content ??
            (options ? (
              <>
                {(filter.options?.length || 0) > 8 && (
                  <label className="data-table-filter-search">
                    <Search size={15} aria-hidden="true" />
                    <input
                      aria-label={`Search ${label} options`}
                      placeholder="Find an option…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                )}
                <div
                  className="data-table-filter-options"
                  role="radiogroup"
                  aria-label={label}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    const buttons = [
                      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        "button",
                      ),
                    ];
                    const index = buttons.indexOf(
                      event.target as HTMLButtonElement,
                    );
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? buttons.length - 1
                          : (index +
                              (event.key === "ArrowDown" ? 1 : -1) +
                              buttons.length) %
                            buttons.length;
                    buttons[next]?.focus();
                    if (buttons[next])
                      onChange(buttons[next].dataset.value || "");
                  }}
                >
                  {[
                    {
                      value: filter.emptyValue ?? "",
                      label: filter.allLabel || "All values",
                      count: undefined,
                    },
                    ...options,
                  ].map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      role="radio"
                      aria-checked={value === option.value}
                      data-value={option.value}
                      data-empty={option.count === 0 || undefined}
                      tabIndex={
                        value === option.value ||
                        (option.value === (filter.emptyValue ?? "") &&
                          !options.some((item) => item.value === value))
                          ? 0
                          : -1
                      }
                      onClick={() => {
                        onChange(option.value);
                        setOpen(false);
                      }}
                    >
                      <span>{option.label}</span>
                      {option.count !== undefined && " "}
                      {option.count !== undefined && (
                        <span className="data-table-filter-count">
                          {option.count.toLocaleString()}
                        </span>
                      )}
                      {value === option.value && (
                        <Check size={15} aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <label className="data-table-filter-search">
                <Search size={15} aria-hidden="true" />
                <input
                  autoFocus
                  aria-label={`Filter ${label}`}
                  placeholder={
                    filter.placeholder || `Find ${label.toLocaleLowerCase()}…`
                  }
                  value={value}
                  onChange={(event) => onChange(event.target.value)}
                />
              </label>
            ))}
          {active && (
            <button
              type="button"
              className="data-table-filter-clear"
              onClick={clear}
            >
              <X size={13} aria-hidden="true" />
              Clear filter
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Wraps a table (and its pagination) in the one shared card container. */
export function TableCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`table-card ${className}`.trim()}>{children}</div>;
}

export function DataTable<T>({
  data,
  columns,
  rowKey,
  label,
  className = "",
  empty = "No matching results.",
  loading = false,
  sort: controlledSort,
  defaultSort = null,
  onSortChange,
  manualSorting = false,
  pagination,
  onRowClick,
  rowHref,
  rowClassName,
  rowAttributes,
  variant = "default",
  scrollClassName = "",
  mobileCard,
  skeletonRows = 5,
  error,
}: {
  data: T[];
  columns: TableColumn<T>[];
  rowKey: (row: T, index: number) => string;
  label: string;
  className?: string;
  empty?: ReactNode;
  loading?: boolean;
  sort?: TableSort | null;
  defaultSort?: TableSort | null;
  onSortChange?: (sort: TableSort | null) => void;
  manualSorting?: boolean;
  pagination?: TablePagination;
  /** Rows (and mobile cards) run this when clicked outside their own controls. */
  onRowClick?: (row: T, event: React.MouseEvent<HTMLElement>) => void;
  /** Rows open this route when clicked outside their own controls. */
  rowHref?: (row: T) => string | null | undefined;
  rowClassName?: string | ((row: T) => string);
  rowAttributes?: (
    row: T,
    index: number,
  ) => HTMLAttributes<HTMLTableRowElement> & Record<string, unknown>;
  variant?: "default" | "code";
  scrollClassName?: string;
  /** Below 640px, render rows as a stacked list with this mapping. */
  mobileCard?: (row: T) => MobileCard;
  skeletonRows?: number;
  /** Replaces the empty state; never shows "no results" for a failed read. */
  error?: TableError | null;
}) {
  const [localSort, setLocalSort] = useState<TableSort | null>(defaultSort);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [overflow, setOverflow] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const narrow = useMediaQuery("(max-width: 639px)");
  const cards = !!mobileCard && narrow && variant === "default";
  const sort = controlledSort === undefined ? localSort : controlledSort;
  const filterValue = (column: TableColumn<T>) =>
    column.filter?.value ??
    filters[column.id] ??
    column.filter?.emptyValue ??
    "";
  const filtered = data.filter((row) =>
    columns.every((column) => {
      const filter = column.filter;
      const value = filterValue(column);
      return (
        !filter ||
        filter.manual ||
        filter.content ||
        !column.value ||
        value === (filter.emptyValue ?? "") ||
        matchesTableFilter(column.value(row), value, !!filter.options)
      );
    }),
  );
  const ordered = manualSorting
    ? filtered
    : sortTableRows(filtered, columns, sort);
  const count = pagination?.total ?? ordered.length;
  const page = pagination
    ? pagination.total !== undefined
      ? pagination.page
      : clampPage(pagination.page, count, pagination.size)
    : 1;
  const rows =
    pagination && pagination.total === undefined
      ? ordered.slice((page - 1) * pagination.size, page * pagination.size)
      : ordered;
  const skeleton = loading && rows.length === 0 && !error;
  useEffect(() => {
    if (
      pagination &&
      pagination.total === undefined &&
      !loading &&
      page !== pagination.page
    )
      pagination.onPage(page);
  }, [page, pagination, loading]);
  // Only a region that actually scrolls sideways is a keyboard stop.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setOverflow(node.scrollWidth > node.clientWidth + 1);
    measure();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    return () => observer?.disconnect();
  }, [cards, rows.length, columns.length]);
  function changeSort(column: TableColumn<T>) {
    const next = nextSort(sort, column.id, column.defaultDirection);
    if (controlledSort === undefined) setLocalSort(next);
    onSortChange?.(next);
    if (pagination && pagination.page !== 1) pagination.onPage(1);
  }
  const interactive = !!(onRowClick || rowHref);
  function rowClick(row: T, event: React.MouseEvent<HTMLTableRowElement>) {
    if ((event.target as Element).closest(interactiveSelector)) return;
    if (window.getSelection()?.toString()) return;
    if (onRowClick) return onRowClick(row, event);
    const href = rowHref?.(row);
    if (!href) return;
    if (event.metaKey || event.ctrlKey) window.open(href, "_blank", "noopener");
    else window.location.hash = href.replace(/^#/, "");
  }
  const showPagination =
    !!pagination &&
    !skeleton &&
    !(error && !rows.length) &&
    (pagination.alwaysShow || count > pagination.size || page > 1);
  const errorBanner = error && (
    <InlineError
      title={error.title}
      error={error.message}
      updatedAt={error.updatedAt}
      retry={error.retry}
      retrying={error.retrying}
    />
  );
  // Nothing loaded: the message is the whole table. No headers, no "0 results".
  if (errorBanner && !rows.length) return errorBanner;
  const loadingStatus = loading && (
    <span className="sr-only" role="status">
      Loading…
    </span>
  );
  if (cards)
    return (
      <>
        {loadingStatus}
        {errorBanner}
        <ul
          className="data-list"
          aria-label={label}
          aria-busy={loading || undefined}
          data-stale={error ? "" : undefined}
        >
          {skeleton ? (
            Array.from({ length: Math.min(skeletonRows, 4) }, (_, index) => (
              <li key={index} className="data-list-item" aria-hidden="true">
                <div className="data-list-main">
                  <Skeleton width="45%" height={13} />
                  <Skeleton width="70%" height={11} />
                </div>
                <Skeleton width={64} height={20} radius={999} />
              </li>
            ))
          ) : rows.length ? (
            rows.map((row, index) => {
              const card = mobileCard!(row);
              return (
                <li
                  key={rowKey(row, index)}
                  className="data-list-item"
                  data-interactive={card.href || onRowClick ? "" : undefined}
                  onClick={(event) => {
                    if ((event.target as Element).closest(interactiveSelector))
                      return;
                    if (onRowClick) return onRowClick(row, event);
                    if (card.href)
                      window.location.hash = card.href.replace(/^#/, "");
                  }}
                >
                  {card.leading}
                  <div className="data-list-main">
                    <div className="data-list-title">
                      {card.href ? (
                        <a href={card.href}>{card.title}</a>
                      ) : (
                        card.title
                      )}
                    </div>
                    {card.meta && card.meta.length > 0 && (
                      <div className="data-list-meta">
                        {card.meta.filter(Boolean).map((item, metaIndex) => (
                          <span key={metaIndex}>{item}</span>
                        ))}
                      </div>
                    )}
                    {card.actions && (
                      <div className="data-list-actions">{card.actions}</div>
                    )}
                  </div>
                  {card.status && (
                    <div className="data-list-status">{card.status}</div>
                  )}
                  {(card.href || onRowClick) && (
                    <ChevronRight
                      className="data-list-chevron"
                      size={16}
                      aria-hidden="true"
                    />
                  )}
                </li>
              );
            })
          ) : (
            <li className="data-list-empty">{empty}</li>
          )}
        </ul>
        {showPagination && (
          <Pagination
            count={count}
            page={page}
            size={pagination!.size}
            onPage={pagination!.onPage}
            sizeOptions={pagination!.sizeOptions}
            onSize={pagination!.onSize}
            noun={pagination!.noun}
            alwaysShow={pagination!.alwaysShow}
          />
        )}
      </>
    );
  return (
    <>
      {loadingStatus}
      {errorBanner}
      <div
        ref={scroller}
        className={`${variant === "code" ? "data-table-code-scroll" : "data-table-scroll"} ${scrollClassName}`}
        role="region"
        aria-label={variant === "code" ? label : `${label} table`}
        tabIndex={overflow ? 0 : undefined}
        data-overflow={overflow || undefined}
      >
        <table
          className={`${variant === "code" ? "data-table-code" : "data-table"} ${className}`}
          aria-label={label}
          aria-busy={loading || undefined}
          data-interactive={interactive || undefined}
          data-stale={error ? "" : undefined}
        >
          {columns.some((column) => column.width !== undefined) && (
            <colgroup>
              {columns.map((column) => (
                <col
                  key={column.id}
                  style={
                    column.width !== undefined
                      ? { width: column.width }
                      : undefined
                  }
                />
              ))}
            </colgroup>
          )}
          <thead>
            <tr>
              {columns.map((column) => {
                const name =
                  column.label ||
                  (typeof column.header === "string"
                    ? column.header
                    : column.id);
                const sortable =
                  column.sortable ?? !!(column.value || column.sortValue);
                const direction =
                  sort?.column === column.id ? sort.direction : undefined;
                const SortIcon =
                  direction === "asc"
                    ? ArrowUp
                    : direction === "desc"
                      ? ArrowDown
                      : ArrowUpDown;
                const firstDirection = column.defaultDirection ?? "asc";
                const nextDirection = direction
                  ? direction === "asc"
                    ? "descending"
                    : "ascending"
                  : firstDirection === "asc"
                    ? "ascending"
                    : "descending";
                return (
                  <th
                    key={column.id}
                    scope="col"
                    className={column.headerClassName || column.className}
                    aria-sort={
                      sortable
                        ? direction === "asc"
                          ? "ascending"
                          : direction === "desc"
                            ? "descending"
                            : "none"
                        : undefined
                    }
                  >
                    <div className="data-table-heading">
                      {sortable ? (
                        <button
                          type="button"
                          className="data-table-sort"
                          onClick={() => changeSort(column)}
                          aria-label={`Sort by ${name}${direction ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
                          title={`Sort ${nextDirection}`}
                        >
                          <span>{column.header}</span>
                          <SortIcon size={13} aria-hidden="true" />
                        </button>
                      ) : (
                        column.header
                      )}
                      {column.filter && (
                        <ColumnFilter
                          label={name}
                          filter={column.filter}
                          value={filterValue(column)}
                          onChange={(value) => {
                            if (column.filter?.onChange)
                              column.filter.onChange(value);
                            else
                              setFilters((old) => ({
                                ...old,
                                [column.id]: value,
                              }));
                            if (pagination && pagination.page !== 1)
                              pagination.onPage(1);
                          }}
                        />
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {skeleton ? (
              Array.from({ length: skeletonRows }, (_, index) => (
                <tr
                  key={`skeleton-${index}`}
                  className="data-table-skeleton"
                  aria-hidden="true"
                >
                  {columns.map((column, columnIndex) => (
                    <td key={column.id} className={column.className}>
                      <Skeleton
                        width={
                          columnIndex === 0
                            ? `${62 - (index % 3) * 9}%`
                            : `${48 + ((index + columnIndex) % 3) * 12}%`
                        }
                        height={12}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length ? (
              rows.map((row, index) => {
                const extra = rowAttributes?.(row, index);
                return (
                  <tr
                    key={rowKey(row, index)}
                    {...extra}
                    className={
                      [
                        typeof rowClassName === "function"
                          ? rowClassName(row)
                          : rowClassName,
                        extra?.className,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    data-interactive={interactive || undefined}
                    onClick={
                      interactive
                        ? (event) => {
                            (
                              extra?.onClick as
                                | ((
                                    event: React.MouseEvent<HTMLTableRowElement>,
                                  ) => void)
                                | undefined
                            )?.(event);
                            rowClick(row, event);
                          }
                        : (extra?.onClick as
                            | ((
                                event: React.MouseEvent<HTMLTableRowElement>,
                              ) => void)
                            | undefined)
                    }
                  >
                    {columns.map((column) => (
                      <td key={column.id} className={column.className}>
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={columns.length} className="data-table-empty">
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {showPagination && (
        <Pagination
          count={count}
          page={page}
          size={pagination!.size}
          onPage={pagination!.onPage}
          sizeOptions={pagination!.sizeOptions}
          onSize={pagination!.onSize}
          noun={pagination!.noun}
          alwaysShow={pagination!.alwaysShow}
        />
      )}
    </>
  );
}

export default DataTable;
