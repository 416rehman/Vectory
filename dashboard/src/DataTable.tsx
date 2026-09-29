import {
  useEffect,
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
  Filter,
  Search,
  X,
} from "lucide-react";
import { Pagination, Spinner } from "./ui";
import {
  matchesTableFilter,
  sortTableRows,
  type TableSort,
  type TableValue,
} from "./dataTableModel";
import "./data-table.css";

export type { TableSort, TableValue } from "./dataTableModel";
export type TableFilter = {
  options?: { value: string; label: string }[];
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
  className?: string;
  headerClassName?: string;
  filter?: TableFilter;
};
type TablePagination = {
  page: number;
  size: number;
  onPage: (page: number) => void;
  total?: number;
};

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
          <Filter size={14} aria-hidden="true" />
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
                    },
                    ...options,
                  ].map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      role="radio"
                      aria-checked={value === option.value}
                      data-value={option.value}
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
  rowClassName,
  rowAttributes,
  variant = "default",
  scrollClassName = "",
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
  onRowClick?: (row: T, event: React.MouseEvent<HTMLTableRowElement>) => void;
  rowClassName?: string | ((row: T) => string);
  rowAttributes?: (
    row: T,
    index: number,
  ) => HTMLAttributes<HTMLTableRowElement> & Record<string, unknown>;
  variant?: "default" | "code";
  scrollClassName?: string;
}) {
  const [localSort, setLocalSort] = useState<TableSort | null>(defaultSort);
  const [filters, setFilters] = useState<Record<string, string>>({});
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
      : Math.min(
          pagination.page,
          Math.max(1, Math.ceil(count / pagination.size)),
        )
    : 1;
  const rows =
    pagination && pagination.total === undefined
      ? ordered.slice((page - 1) * pagination.size, page * pagination.size)
      : ordered;
  useEffect(() => {
    if (
      pagination &&
      pagination.total === undefined &&
      !loading &&
      page !== pagination.page
    )
      pagination.onPage(page);
  }, [page, pagination, loading]);
  function changeSort(column: TableColumn<T>) {
    const next: TableSort = {
      column: column.id,
      direction:
        sort?.column === column.id && sort.direction === "asc" ? "desc" : "asc",
    };
    if (controlledSort === undefined) setLocalSort(next);
    onSortChange?.(next);
    if (pagination && pagination.page !== 1) pagination.onPage(1);
  }
  return (
    <>
      <div
        className={`${variant === "code" ? "data-table-code-scroll" : "data-table-scroll"} ${scrollClassName}`}
        role="region"
        aria-label={variant === "code" ? label : `${label} table`}
        tabIndex={0}
      >
        <table
          className={`${variant === "code" ? "data-table-code" : "data-table"} ${className}`}
          aria-label={label}
          aria-busy={loading || undefined}
        >
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
                          title={`Sort ${direction === "asc" ? "descending" : "ascending"}`}
                        >
                          <span>{column.header}</span>
                          <SortIcon size={14} aria-hidden="true" />
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
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="data-table-empty">
                  <span role="status">
                    <Spinner />
                    Loading…
                  </span>
                </td>
              </tr>
            ) : rows.length ? (
              rows.map((row, index) => (
                <tr
                  key={rowKey(row, index)}
                  {...rowAttributes?.(row, index)}
                  className={
                    typeof rowClassName === "function"
                      ? rowClassName(row)
                      : rowClassName
                  }
                  onClick={
                    onRowClick ? (event) => onRowClick(row, event) : undefined
                  }
                >
                  {columns.map((column) => (
                    <td key={column.id} className={column.className}>
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
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
      {pagination && (
        <Pagination
          count={count}
          page={page}
          size={pagination.size}
          onPage={pagination.onPage}
        />
      )}
    </>
  );
}

export default DataTable;
