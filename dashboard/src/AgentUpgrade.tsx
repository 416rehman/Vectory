import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
  api,
  can,
  withRequestDeadline,
  AgentInstallSchema,
  type AgentInstall,
  type Device,
  type Release,
  type User,
} from "./api";
import {
  agentUpgradeRelease,
  runningBuild,
  upgradeCommand,
  upgradeNotes,
} from "./agentUpgradeModel";
import { Button, CopyButton, ErrorBox, Modal, Spinner } from "./ui";
import DocLink from "./DocLink";
import { forkSentence, updatesLine } from "./agentUpdateModel";
import { consentFor } from "./agentUpdateCommands";
import {
  emptyConsent,
  readConsent,
  type ConsentForm,
} from "./agentUpdateConsent";
import { UpdateConsentFields } from "./UpdateConsentFields";
import { CommandBlock } from "./CommandBlock";
import DeviceRollout from "./DeviceRollout";
import { useAgentUpdates } from "./useAgentUpdates";
import "./agent-upgrade.css";

/** Text with `code` spans, which never break inside (a flag at its hyphen). */
function CodeText({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`]+`)/)
        .map((part, index) =>
          part.startsWith("`") ? (
            <code key={index}>{part.slice(1, -1)}</code>
          ) : (
            part
          ),
        )}
    </>
  );
}

/** The download, its checksum and the manual procedure. */
function ByHand({ device, release }: { device: Device; release: Release }) {
  return (
    <>
      <section
        className="agent-upgrade-download"
        aria-label="Available agent download"
      >
        <div className="agent-upgrade-download-heading">
          <div>
            <strong>Available download · {release.version}</strong>
            <p>
              {(release.size / 1048576).toFixed(1)} MB ·{" "}
              {release.signed ? "Signed release" : "Unsigned development build"}
              {release.source === "mirror"
                ? " · Operator mirror"
                : release.source === "bundled"
                  ? " · Bundled with this server"
                  : ""}
            </p>
          </div>
          <a
            className="button secondary compact"
            href={release.url}
            download={device.os === "windows" ? "vectory.exe" : "vectory"}
          >
            <Download size={16} aria-hidden="true" /> Download
          </a>
        </div>
        <div className="agent-upgrade-checksum">
          <span>SHA-256</span>
          <code>{release.sha256}</code>
          <CopyButton
            text={release.sha256}
            label="Copy checksum"
            copiedMessage="Checksum copied."
            failedMessage="Copy unavailable. Select the checksum above to copy it manually."
            variant="ghost compact"
          />
        </div>
        <p className="agent-upgrade-note">
          Verify the file against a checksum from your trusted release channel.
        </p>
      </section>
      <ol className="agent-upgrade-steps">
        <li>
          <strong>Prepare a maintenance window</strong>
          <p>
            Stopping the agent also stops its supervised Vector process. Record
            the existing executable, state directory and service account.
          </p>
        </li>
        <li>
          <strong>Stop and preserve</strong>
          <p>
            Stop the existing supervisor, then back up the protected state,
            managed configuration and Vector data. Keep credentials private.
          </p>
        </li>
        <li>
          <strong>Replace only the agent</strong>
          <p>
            Use the same executable path, permissions and account. Keep Vector
            and the state directory in place. Do not re-enroll or purge state.
          </p>
        </li>
        <li>
          <strong>Restart and verify</strong>
          <p>
            Use the existing service or run command. Check local status and
            diagnostics, a fresh heartbeat and the expected pipeline. Existing
            pauses stay in effect.
          </p>
        </li>
      </ol>
    </>
  );
}

export default function AgentUpgrade({
  device,
  user,
}: {
  device: Device;
  user?: User;
}) {
  const [open, setOpen] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Agent updates: a host that reports them off or not at all is opted in by
  // one run of this command, with the choice made here; a host that takes them
  // from the dashboard is rolled out to. While updates are off none of it is
  // here and the command is what it always was.
  const settings = useAgentUpdates(0, 60000, open || rolling);
  const key = settings.updates?.current_key ?? null;
  const report = device.agent_update ?? null;
  const optedIn = settings.on && !!report && report.consent !== "off";
  const canOptIn =
    settings.on &&
    !optedIn &&
    device.status !== "revoked" &&
    (device.os === "linux" || device.os === "darwin");
  const noService = device.service_manager === "none";
  const [consent, setConsent] = useState<ConsentForm>(emptyConsent);
  const consentRead = readConsent(consent, key?.fingerprint ?? null);
  const [result, setResult] = useState<{
    loading: boolean;
    install: AgentInstall | null;
    releases: Release[];
    error: string;
  }>({ loading: true, install: null, releases: [], error: "" });
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    const controller = new AbortController();
    setResult({ loading: true, install: null, releases: [], error: "" });
    void withRequestDeadline((deadline) => {
      deadline.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
      return api("/agent-install", { signal: controller.signal });
    })
      .then((details) => {
        if (!current) return;
        // The builds are checked one by one (agentUpgradeRelease), so one
        // bad catalog entry never hides this device's download.
        const raw = (details || {}) as { releases?: unknown };
        const parsed = AgentInstallSchema.safeParse({ ...raw, releases: [] });
        setResult(
          parsed.success && Array.isArray(raw.releases)
            ? {
                loading: false,
                install: parsed.data,
                releases: raw.releases as Release[],
                error: "",
              }
            : {
                loading: false,
                install: null,
                releases: [],
                error: "The server's agent downloads couldn't be read.",
              },
        );
      })
      .catch((error) => {
        if (current)
          setResult({
            loading: false,
            install: null,
            releases: [],
            error: error.message,
          });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [open, refresh]);
  const install = result.install;
  const { release, reason } = agentUpgradeRelease(
    result.releases,
    device.os,
    device.arch,
  );
  const build = release ? runningBuild(device, release) : null;
  const optIn = canOptIn && !noService ? consentRead.consent : undefined;
  // A build that is already current needs no run, unless the run is how the
  // host is opted in to updates.
  const command =
    install && release && (!build?.current || !!optIn)
      ? upgradeCommand(install, device, optIn)
      : null;
  // What the host already allows, with the key this server signs with now.
  const kept =
    optedIn && report && key ? consentFor(report, key.fingerprint) : null;
  const pinAgain =
    install && release && kept ? upgradeCommand(install, device, kept) : null;
  return (
    <>
      <button
        ref={opener}
        className="agent-upgrade-trigger"
        type="button"
        onClick={() => setOpen(true)}
      >
        Upgrade agent
      </button>
      {open && (
        <Modal
          open
          title="Upgrade agent"
          description={`Upgrade Vectory on ${device.name} in place, keeping its identity, configuration and Vector.`}
          onClose={() => setOpen(false)}
          returnFocusRef={opener}
        >
          <div className="modal-body agent-upgrade-body">
            <dl className="agent-upgrade-versions">
              <div>
                <dt>Last reported agent</dt>
                <dd>{device.agent_version || "Not reported"}</dd>
              </div>
              <div>
                <dt>Device platform</dt>
                <dd>
                  {device.os} · {device.arch}
                </dd>
              </div>
            </dl>
            {optedIn && report && (
              <section
                className="update-upgrade-opted"
                aria-labelledby="agent-upgrade-opted-title"
              >
                <h3 id="agent-upgrade-opted-title">
                  This device takes updates from the dashboard
                </h3>
                <p>{updatesLine(report)}</p>
                {report.rollover_conflict && (
                  <p
                    className="update-device-note"
                    data-tone="danger"
                    role="note"
                  >
                    {forkSentence(report.rollover_conflict)}
                  </p>
                )}
                {user && can(user, "operate") && !settings.updates?.stopped && (
                  <Button
                    onClick={() => {
                      setOpen(false);
                      setRolling(true);
                    }}
                  >
                    Roll out to this device
                  </Button>
                )}
                {pinAgain && (
                  <details
                    className="agent-upgrade-manual"
                    open={!!report.rollover_conflict}
                  >
                    <summary>Pin this server&apos;s current key again</summary>
                    <p className="agent-upgrade-note">
                      The same command, keeping what this host already allows,
                      with the key this server signs with now. It is how a host
                      takes a new key, or leaves a fork.
                    </p>
                    <CommandBlock
                      command={pinAgain}
                      label={`Command to pin the current key on ${device.name}`}
                    />
                  </details>
                )}
              </section>
            )}
            {result.loading ? (
              <p role="status">
                <Spinner /> Checking available downloads…
              </p>
            ) : result.error ? (
              <ErrorBox
                message={result.error}
                retry={() => setRefresh((n) => n + 1)}
              />
            ) : !release ? (
              <p className="agent-upgrade-note" role="status">
                {reason} Ask your administrator for a verified package.
              </p>
            ) : build?.current && !canOptIn ? (
              <p className="agent-upgrade-current" role="status">
                {build.line}
              </p>
            ) : (
              <>
                {build &&
                  (build.current ? (
                    <p className="agent-upgrade-current" role="status">
                      {build.line}
                    </p>
                  ) : (
                    <p className="agent-upgrade-note agent-upgrade-build">
                      {build.line}
                    </p>
                  ))}
                {canOptIn && (
                  <section
                    className="update-upgrade-step"
                    aria-labelledby="agent-upgrade-updates-title"
                  >
                    <h3 id="agent-upgrade-updates-title">Agent updates</h3>
                    {noService ? (
                      <p className="agent-upgrade-note">
                        {device.name}&apos;s agent isn&apos;t kept running by a
                        service, so it can&apos;t take agent updates. Run it
                        under a service first.
                      </p>
                    ) : (
                      <>
                        <p className="agent-upgrade-note">
                          {report
                            ? "Updates are off on this host."
                            : "Its last check-in carried no update report."}{" "}
                          One run of the command below, with a choice made here,
                          lets the dashboard update it.
                        </p>
                        <UpdateConsentFields
                          value={consent}
                          onChange={(patch) =>
                            setConsent((previous) => ({
                              ...previous,
                              ...patch,
                            }))
                          }
                          read={consentRead}
                          signingKey={key}
                          name="upgrade-update-level"
                        />
                        {!consentRead.chosen && (
                          <p className="agent-upgrade-note">
                            Without a choice the command only upgrades the
                            agent. It doesn&apos;t change how this host takes
                            updates.
                          </p>
                        )}
                      </>
                    )}
                  </section>
                )}
                {command && install ? (
                  <>
                    <section
                      className="agent-upgrade-run"
                      aria-labelledby="agent-upgrade-run-title"
                    >
                      <h3 id="agent-upgrade-run-title">
                        Run this on {device.name}
                      </h3>
                      <p>
                        The installer checks and replaces the agent, and setup
                        restarts it on {release.version} and waits for its first
                        check-in. No token: the device keeps its identity.
                      </p>
                      <div className="agent-upgrade-command">
                        <pre tabIndex={0} aria-label="Upgrade command">
                          <code>{command}</code>
                        </pre>
                        <CopyButton
                          text={command}
                          label="Copy"
                          ariaLabel="Copy upgrade command"
                          copiedMessage="Upgrade command copied."
                        />
                      </div>
                      <ul className="agent-upgrade-notes">
                        {upgradeNotes(install, device).map((note) => (
                          <li key={note}>
                            <CodeText text={note} />
                          </li>
                        ))}
                      </ul>
                    </section>
                    <details className="agent-upgrade-manual">
                      <summary>By hand</summary>
                      <ByHand device={device} release={release} />
                    </details>
                  </>
                ) : build?.current ? null : (
                  <ByHand device={device} release={release} />
                )}
              </>
            )}
            {device.status === "revoked" && (
              <p className="agent-upgrade-note">
                An upgrade does not restore revoked access. Use the device
                recovery flow if a new identity is needed.
              </p>
            )}
            <DocLink topic="installation" section="upgrade-an-existing-agent">
              Full upgrade instructions
            </DocLink>
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </Modal>
      )}
      {rolling && settings.updates && user && (
        <DeviceRollout
          device={device}
          user={user}
          updates={settings.updates}
          returnFocusRef={opener}
          onClose={() => setRolling(false)}
        />
      )}
    </>
  );
}
