import { useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Search, X } from "lucide-react";
import type { CanaryPlan, Device } from "./api";
import { Button } from "./ui";
import { nameList } from "./canaryWatch";
import { deviceDisplayStatus, statusLabel } from "./status";
import type { TableColumn } from "./DataTable";
import "./canary-picker.css";

/** Most devices the list shows at once; the search narrows the rest. */
const LISTED = 100;
const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

/** Why these canary devices, in a sentence for the review. */
export function canaryExplanation(plan: CanaryPlan, scheduled: boolean) {
  const named = plan.devices.filter((device) => device.chosen);
  const picked = plan.devices.filter((device) => !device.chosen);
  const parts: string[] = [];
  if (named.length)
    parts.push(
      `You chose ${nameList(
        named.map((device) => device.device_name || "an unnamed device"),
        named.length,
      )}.`,
    );
  if (picked.length) {
    const reasons = [...new Set(picked.map((device) => device.reason))];
    parts.push(
      `${named.length ? "The rest were chosen" : "Chosen"} for you: ${
        reasons.length === 1
          ? lowerFirst(reasons[0])
          : "the most ready devices first"
      }.`,
    );
    if (scheduled)
      parts.push(
        "The choice is made again when the schedule starts, from the devices that are ready then.",
      );
  }
  return parts.join(" ");
}

/** A short line on how ready a reviewed device is, for the list. */
function readiness(device: Device) {
  const status = statusLabel("device", deviceDisplayStatus(device));
  return device.telemetry ? status : `${status} · no metrics yet`;
}

/**
 * "Canary devices: edge-nyc-02 ▾": who a canary rollout releases first, and a
 * searchable choice among the reviewed devices, by name. A choice is only made
 * on Apply, which reviews the request again. Devices the person does not name
 * are filled in by readiness, as when nothing is chosen.
 */
export function CanaryPicker({
  devices,
  plan,
  chosen,
  scheduled,
  busy,
  onChoose,
}: {
  /** The reviewed devices. */
  devices: Device[];
  plan: CanaryPlan;
  /** Devices the person named for this review; empty when Vectory chooses. */
  chosen: string[];
  scheduled: boolean;
  busy: boolean;
  /** Reviews again with these canary devices; empty lets Vectory choose. */
  onChoose(ids: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const heading = useId();
  const capacity = Math.max(1, Math.min(plan.size, devices.length));
  const single = capacity === 1;
  const names = plan.devices.map(
    (device) => device.device_name || "an unnamed device",
  );
  const shown = nameList(names, plan.device_ids.length) || "None";
  const visible = devices.filter((device) =>
    device.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  // Only devices the person names are a choice; the rest is Vectory's.
  const same =
    draft.length === chosen.length && draft.every((id) => chosen.includes(id));
  const current = new Set(plan.device_ids);
  function toggle(id: string) {
    setDraft((old) =>
      single
        ? [id]
        : old.includes(id)
          ? old.filter((item) => item !== id)
          : old.length < capacity
            ? [...old, id]
            : old,
    );
  }
  return (
    <div className="canary-picker">
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setSearch("");
          if (next) setDraft(chosen);
        }}
      >
        <Popover.Trigger asChild>
          <Button
            variant="secondary compact"
            className="canary-picker-trigger"
            disabled={busy}
          >
            <span>Canary devices:</span>
            <strong>{shown}</strong>
            <ChevronDown size={14} aria-hidden="true" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            ref={content}
            className="canary-picker-menu"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            aria-labelledby={heading}
            onOpenAutoFocus={(event) => {
              const target = content.current?.querySelector<HTMLElement>(
                "input[type=search], input:checked, input",
              );
              if (target) {
                event.preventDefault();
                target.focus({ preventScroll: true });
              }
            }}
          >
            <div className="canary-picker-heading">
              <strong id={heading}>Canary devices</strong>
              <Popover.Close asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close canary devices"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </Popover.Close>
            </div>
            <p className="canary-picker-hint">
              {single
                ? "Choose the device that gets this change first."
                : `Choose up to ${capacity} devices to get this change first. Vectory adds the most ready devices to make ${capacity}.`}
            </p>
            {devices.length > 8 && (
              <label className="canary-picker-search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Find a reviewed device"
                  placeholder="Find a reviewed device"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            )}
            <div
              className="canary-picker-options"
              role={single ? "radiogroup" : "group"}
              aria-labelledby={heading}
            >
              {visible.slice(0, LISTED).map((device) => {
                const on = draft.includes(device.id);
                return (
                  <label
                    key={device.id}
                    className="canary-picker-option"
                    data-disabled={
                      (!single && !on && draft.length >= capacity) || undefined
                    }
                  >
                    <input
                      type={single ? "radio" : "checkbox"}
                      name={single ? heading : undefined}
                      checked={on}
                      disabled={!single && !on && draft.length >= capacity}
                      onChange={() => toggle(device.id)}
                    />
                    <span>
                      <strong>{device.name}</strong>
                      <small>
                        {readiness(device)}
                        {current.has(device.id) && !on ? " · canary now" : ""}
                      </small>
                    </span>
                  </label>
                );
              })}
              {!visible.length && (
                <p className="canary-picker-hint">
                  No reviewed device matches.
                </p>
              )}
              {visible.length > LISTED && (
                <p className="canary-picker-hint">
                  Showing {LISTED} of {visible.length.toLocaleString()} devices.
                  Search to narrow the list.
                </p>
              )}
            </div>
            <div className="canary-picker-actions">
              {chosen.length > 0 ? (
                <button
                  type="button"
                  className="canary-picker-link"
                  onClick={() => {
                    setOpen(false);
                    onChoose([]);
                  }}
                >
                  Let Vectory choose
                </button>
              ) : (
                <span />
              )}
              <Button
                variant="compact"
                disabled={!draft.length || same}
                onClick={() => {
                  setOpen(false);
                  onChoose(draft);
                }}
              >
                Apply
              </Button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <p className="canary-picker-why">{canaryExplanation(plan, scheduled)}</p>
    </div>
  );
}

/**
 * The review table's Stage column: who goes first, and who follows. Absent
 * unless the request is a canary.
 */
export function canaryStageColumn(
  plan: CanaryPlan | null | undefined,
): TableColumn<Device>[] {
  if (!plan) return [];
  const first = new Set(plan.device_ids);
  const stage = (device: Device) => (first.has(device.id) ? "Canary" : "Then");
  return [
    {
      id: "stage",
      header: "Stage",
      value: stage,
      cell: (device) =>
        first.has(device.id) ? (
          <strong>Canary</strong>
        ) : (
          <span className="control-muted">Then</span>
        ),
      filter: {
        options: ["Canary", "Then"].map((value) => ({ value, label: value })),
      },
    },
  ];
}
