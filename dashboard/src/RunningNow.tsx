import type { OverviewRunning } from "./api";
import {
  countLabel,
  runningGroups,
  runningNotes,
  runningRate,
} from "./overviewModel";
import { Card, CardLink } from "./OverviewCard";

/**
 * What runs where: one row per pipeline version that devices report running,
 * with how many devices, the groups they are in, what flows through it and
 * what it is doing right now. It answers the first question anyone asks of a
 * fleet before any other page opens.
 */
export default function RunningNow({
  running,
  total,
  canDeploy,
}: {
  running: OverviewRunning[];
  /** How many versions run in all; the list is the busiest few. */
  total: number;
  canDeploy: boolean;
}) {
  return (
    <Card
      title="Running now"
      subtitle={
        running.length
          ? "Pipeline versions and the devices that run them"
          : undefined
      }
      className="running-now"
      action={<CardLink href="#/configurations">All pipelines</CardLink>}
    >
      {running.length ? (
        <>
          <ul className="overview-running-list">
            {running.map((row) => (
              <RunningRow key={row.version_id} row={row} />
            ))}
          </ul>
          {total > running.length && (
            <p className="overview-running-more">
              Showing {running.length} of{" "}
              {countLabel(total, "pipeline version")}.
            </p>
          )}
        </>
      ) : (
        <div className="overview-empty-row">
          <p>Nothing is running yet. Deploy a pipeline to a device.</p>
          {canDeploy && (
            <a className="button secondary compact" href="#/configurations">
              Deploy a pipeline
            </a>
          )}
        </div>
      )}
    </Card>
  );
}

function RunningRow({ row }: { row: OverviewRunning }) {
  const rate = runningRate(row);
  const groups = runningGroups(row);
  return (
    <li className="overview-running-item" data-state={row.state}>
      <div className="overview-running-head">
        <a
          className="overview-running-name"
          href={`#/configurations/${encodeURIComponent(row.configuration_id)}`}
        >
          {row.configuration_name || "Unnamed pipeline"}
        </a>
        {row.version !== null && (
          <span className="overview-running-version">v{row.version}</span>
        )}
        <span
          className="overview-running-rate"
          data-missing={rate ? undefined : ""}
          title="Events in and out per second, summed over the devices that report"
        >
          {rate ? (
            <>
              <span className="sr-only">Events per second, in then out: </span>
              {rate}
            </>
          ) : (
            "No metrics yet"
          )}
        </span>
      </div>
      <p className="overview-running-where">
        <a href={`#/devices?running=${encodeURIComponent(row.version_id)}`}>
          {countLabel(row.device_count, "device")}
        </a>
        {groups.chips.length > 0 && (
          <span className="overview-running-groups">
            <span className="sr-only"> in the groups </span>
            {groups.chips.map((group) => (
              <a
                key={group.id}
                className="overview-running-group"
                href={group.href}
                title={`${countLabel(group.count, "device")} of this version in ${group.name}`}
              >
                {group.name}
                <span className="overview-running-group-count">
                  {group.count.toLocaleString()}
                </span>
              </a>
            ))}
            {groups.more > 0 && (
              <span className="overview-running-group" data-more="">
                and {groups.more.toLocaleString()} more
              </span>
            )}
          </span>
        )}
      </p>
      {runningNotes(row).map((note) => (
        <p
          key={note.text}
          className="overview-running-note"
          data-tone={note.tone}
        >
          <a href={note.href}>{note.text}</a>
        </p>
      ))}
    </li>
  );
}
