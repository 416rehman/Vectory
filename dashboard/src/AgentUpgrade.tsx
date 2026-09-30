import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
  api,
  withRequestDeadline,
  AgentInstallSchema,
  type AgentInstall,
  type Device,
  type Release,
} from "./api";
import {
  agentUpgradeRelease,
  runningBuild,
  upgradeCommand,
  upgradeNotes,
} from "./agentUpgradeModel";
import { Button, CopyButton, ErrorBox, Modal, Spinner } from "./ui";
import DocLink from "./DocLink";
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

export default function AgentUpgrade({ device }: { device: Device }) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
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
  const command =
    install && release && !build?.current
      ? upgradeCommand(install, device)
      : null;
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
            ) : build?.current ? (
              <p className="agent-upgrade-current" role="status">
                {build.line}
              </p>
            ) : (
              <>
                {build && (
                  <p className="agent-upgrade-note agent-upgrade-build">
                    {build.line}
                  </p>
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
                ) : (
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
    </>
  );
}
