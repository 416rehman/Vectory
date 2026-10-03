// What one device says about agent updates, as it last reported it: whether it
// takes them and how, what it is doing about one now, how the last one ended,
// and why it can't take one. Nothing here is inferred: a device that sent no
// report is "Not reported", and a staged or downloaded build is never called an
// update.
import type { ReactNode } from "react";
import type { Device } from "./api";
import {
  currentUpdate,
  forkSentence,
  lastResultText,
  updatesLine,
} from "./agentUpdateModel";
import { codeText } from "./agentUpdateCodes";
import { updateVerbCommand } from "./agentUpdateCommands";
import { windowsText } from "./updateWindow";
import { CommandBlock } from "./CommandBlock";
import DocLink from "./DocLink";
import { shortDigest } from "./enrollmentCommands";
import { StatusBadge, TimeAgo } from "./ui";
import { useAgentUpdates } from "./useAgentUpdates";
import "./agent-updates.css";

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

const shortTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function DeviceAgentUpdates({ device }: { device: Device }) {
  const settings = useAgentUpdates();
  // Updates off, or not read yet: the feature isn't there to talk about.
  if (!settings.on || device.status === "revoked") return null;
  const report = device.agent_update ?? null;
  const now = report ? currentUpdate(report, device.name) : null;
  const fork = report ? forkSentence(report.rollover_conflict) : null;
  const eligibility =
    report && report.eligibility !== "eligible"
      ? codeText(report.eligibility)
      : null;
  const apply =
    now?.command === "apply" ? updateVerbCommand("apply", device) : null;
  const resume = report?.paused ? updateVerbCommand("resume", device) : null;
  return (
    <section className="device-card" aria-labelledby="device-updates-title">
      <div className="device-card-head">
        <h2 id="device-updates-title">Agent updates</h2>
        {report && <StatusBadge domain="updateHost" value={report.state} />}
      </div>
      <dl className="device-facts">
        <Row label="Running">
          Agent {device.agent_version || "not reported"}
          {device.agent_sha256 && (
            <small className="update-fact-note">
              build {shortDigest(device.agent_sha256)}
            </small>
          )}
        </Row>
        <Row label="Updates">
          {report ? (
            updatesLine(report)
          ) : (
            <>
              <span className="device-muted">Not reported</span>
              <small className="update-fact-note">
                Its last check-in carried no update report, so nothing is said
                about updates on this device.
              </small>
            </>
          )}
        </Row>
        {report && report.consent !== "off" && report.windows.length > 0 && (
          <Row label="Window">
            {report.window_open
              ? "Open now"
              : report.next_window_at
                ? `Next opens ${shortTime(report.next_window_at)}`
                : "No window opens"}
            <small className="update-fact-note">
              {windowsText(report.windows)}
            </small>
          </Row>
        )}
        {now && <Row label="Now">{now.text}</Row>}
        {report?.last && (
          <Row label="Last result">
            {lastResultText(report.last, shortTime)}
            {report.last.outcome !== "committed" && (
              <small className="update-fact-note">
                <TimeAgo value={report.last.at} />
                {report.last.outcome === "rolled_back" && (
                  <>
                    {" · "}
                    <DocLink
                      topic="agent-updates"
                      section="when-a-host-rolls-back"
                    >
                      What a rollback means
                    </DocLink>
                  </>
                )}
              </small>
            )}
          </Row>
        )}
      </dl>
      {apply && (
        <CommandBlock
          command={apply}
          label={`Apply command for ${device.name}`}
          heading="On this host, to install the staged build now"
        />
      )}
      {fork && (
        <p className="update-device-note" data-tone="danger" role="note">
          {fork}{" "}
          <DocLink topic="agent-updates" section="if-a-key-is-stolen">
            What a fork means
          </DocLink>
        </p>
      )}
      {report?.paused && (
        <>
          <p className="update-device-note" data-tone="warning" role="note">
            Paused on this host. Nothing downloads or applies until someone
            resumes updates there.
          </p>
          {resume && (
            <CommandBlock
              command={resume}
              label={`Resume command for ${device.name}`}
              heading="On this host"
            />
          )}
        </>
      )}
      {eligibility && (
        <p className="update-device-note" data-tone="warning" role="note">
          {eligibility.reason}
          {eligibility.fix ? ` ${eligibility.fix}` : ""}{" "}
          <DocLink
            topic="agent-updates"
            section="what-a-host-needs-to-take-an-update"
          >
            What a host needs
          </DocLink>
        </p>
      )}
      {report && (
        <p className="device-card-text update-reported">
          As this device reported it <TimeAgo value={report.reported_at} />.
        </p>
      )}
    </section>
  );
}
