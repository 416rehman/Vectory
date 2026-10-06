import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Device, DeviceInventoryIds } from "./api";
import { DataTable, type TableColumn } from "./DataTable";
import { Button, StatusBadge } from "./ui";
import { deviceDisplayStatus } from "./status";
import { readMatchingIds, selectionNote } from "./deviceInventory";
import { useInventory } from "./useInventory";
import "./device-picker.css";

const PAGE_SIZE = 25;
const platform = (device: Device) =>
  [device.os, device.arch].filter(Boolean).join(" / ") ||
  "Platform not reported";

/**
 * Choose devices from a fleet of any size: one page at a time, searched on
 * the server, with "Select all N matching" for everything a search finds.
 * The caller owns what is selected; the picker only reads and reports.
 */
export default function DevicePicker({
  label,
  search,
  isChecked,
  disabled = false,
  onToggle,
  onRows,
  onMatching,
  note,
  extra,
  actions,
}: {
  /** The table's accessible name. */
  label: string;
  /** What the person typed; the picker asks a moment after they stop. */
  search: string;
  isChecked: (device: Device) => boolean;
  disabled?: boolean;
  onToggle: (device: Device) => void;
  /** The rows on screen, so a caller can keep the ones it needs by name. */
  onRows?: (rows: Device[]) => void;
  /** Everything the current search matches; the caller adds it to its selection. */
  onMatching: (found: DeviceInventoryIds, rowsOnPage: Device[]) => void;
  /** A detail after the platform, such as the device's mode. */
  note?: (device: Device) => string | null;
  /** One more column, such as what each device runs now. */
  extra?: { id: string; header: string; cell: (device: Device) => ReactNode };
  /** More buttons beside "Select all", such as "Remove all". */
  actions?: ReactNode;
}) {
  const [query, setQuery] = useState(search.trim());
  const [page, setPage] = useState(1);
  // A search settles for a moment before it is read.
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, query]);
  const { resource, data, loaded, settling } = useInventory(
    { q: query, sort: "name", dir: "asc", page, size: PAGE_SIZE },
    30000,
  );
  const rows = data.items;
  // A page past the end moves back.
  const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  useEffect(() => {
    if (!resource.loading && !resource.error && page > lastPage)
      setPage(lastPage);
  }, [resource.loading, resource.error, page, lastPage]);
  useEffect(() => {
    if (resource.updatedAt && onRows) onRows(resource.data.items);
    // The caller's callback is for each page read, not for its own changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.updatedAt, resource.data]);
  const [matching, setMatching] = useState({
    busy: false,
    note: "",
    error: "",
  });
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  // What the note describes goes stale as soon as the search changes.
  useEffect(() => setMatching({ busy: false, note: "", error: "" }), [query]);
  async function selectMatching() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setMatching({ busy: true, note: "", error: "" });
    try {
      const found = await readMatchingIds({ q: query }, controller.signal);
      if (controller.signal.aborted) return;
      onMatching(found, rows);
      setMatching({ busy: false, note: selectionNote(found), error: "" });
    } catch (failure) {
      if (controller.signal.aborted) return;
      setMatching({
        busy: false,
        note: "",
        error: `Couldn't select the matching devices. ${(failure as Error).message}`,
      });
    }
  }
  const stale = !!resource.error;
  const frozen = disabled || stale || settling;
  const details = (device: Device) =>
    [platform(device), note?.(device)].filter(Boolean).join(" · ");
  const checkbox = (device: Device) => (
    <input
      type="checkbox"
      aria-label={`Select ${device.name}`}
      disabled={frozen}
      checked={isChecked(device)}
      onChange={() => onToggle(device)}
    />
  );
  const columns: TableColumn<Device>[] = [
    {
      id: "select",
      label: "Select devices",
      className: "device-check",
      headerClassName: "device-check",
      width: 44,
      header: (
        <input
          type="checkbox"
          aria-label="Select devices on this page"
          checked={rows.length > 0 && rows.every((device) => isChecked(device))}
          disabled={frozen || rows.length === 0}
          onChange={(event) => {
            for (const device of rows)
              if (isChecked(device) !== event.target.checked) onToggle(device);
          }}
        />
      ),
      cell: checkbox,
    },
    {
      id: "name",
      header: "Device",
      cell: (device) => (
        <span className="device-picker-name">
          <strong>{device.name}</strong>
          <small>{details(device)}</small>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: 150,
      cell: (device) => (
        <StatusBadge domain="device" value={deviceDisplayStatus(device)} />
      ),
    },
    ...(extra
      ? [{ id: extra.id, header: extra.header, cell: extra.cell }]
      : []),
  ];
  const total = data.total;
  return (
    <div className="device-picker">
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(device) => device.id}
        label={label}
        className="device-picker-table"
        loading={resource.loading}
        error={
          resource.error
            ? {
                title: resource.updatedAt
                  ? "Couldn't refresh devices."
                  : "Couldn't load devices.",
                message: resource.error,
                updatedAt: resource.updatedAt,
                retry: () => void resource.reload(),
                retrying: resource.refreshing,
              }
            : null
        }
        manualSorting
        pagination={
          resource.error && !loaded
            ? undefined
            : {
                page,
                size: PAGE_SIZE,
                total,
                onPage: setPage,
                noun: "devices",
              }
        }
        mobileCard={(device) => ({
          title: device.name,
          leading: checkbox(device),
          status: (
            <StatusBadge domain="device" value={deviceDisplayStatus(device)} />
          ),
          meta: [details(device), extra?.cell(device)],
        })}
        empty={
          query ? (
            "No devices match your search."
          ) : (
            <>
              No enrolled devices to choose from.{" "}
              <a href="#/enrollment">Add device</a>
            </>
          )
        }
      />
      <div className="device-picker-actions">
        {total > 1 && (
          <Button
            variant="secondary compact"
            busy={matching.busy}
            disabled={frozen}
            onClick={() => void selectMatching()}
          >
            Select all {total.toLocaleString()} matching
          </Button>
        )}
        {actions}
      </div>
      {matching.error ? (
        <p className="device-picker-note" role="alert">
          {matching.error}
        </p>
      ) : (
        <p className="device-picker-note" role="status">
          {matching.note}
        </p>
      )}
    </div>
  );
}
