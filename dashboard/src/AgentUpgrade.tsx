import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { api, withRequestDeadline, type Device, type Release } from "./api";
import { agentUpgradeRelease } from "./agentUpgradeModel";
import { Button, CopyButton, ErrorBox, Modal, Spinner } from "./ui";
import DocLink from "./DocLink";
import "./agent-upgrade.css";

export default function AgentUpgrade({ device }: { device: Device }) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    loading: boolean;
    releases: Release[];
    error: string;
  }>({ loading: true, releases: [], error: "" });
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    const controller = new AbortController();
    setResult({ loading: true, releases: [], error: "" });
    void withRequestDeadline((deadline) => {
      deadline.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
      return api<Release[]>("/releases", { signal: controller.signal });
    })
      .then((releases) => {
        if (current) setResult({ loading: false, releases, error: "" });
      })
      .catch((error) => {
        if (current)
          setResult({ loading: false, releases: [], error: error.message });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [open, refresh]);
  const { release, reason } = agentUpgradeRelease(
    result.releases,
    device.os,
    device.arch,
  );
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
          description={`Upgrade Vectory locally on ${device.name}, keeping its existing identity and configuration.`}
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
            ) : release ? (
              <section
                className="agent-upgrade-download"
                aria-label="Available agent download"
              >
                <div className="agent-upgrade-download-heading">
                  <div>
                    <strong>Available download · {release.version}</strong>
                    <p>
                      {(release.size / 1048576).toFixed(1)} MB ·{" "}
                      {release.signed
                        ? "Signed release"
                        : "Unsigned development build"}
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
                    download={
                      device.os === "windows" ? "vectory.exe" : "vectory"
                    }
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
                  Verify the file against a checksum from your trusted release
                  channel. Development builds can share a version label; this
                  page cannot verify the running executable.
                </p>
              </section>
            ) : (
              <p className="agent-upgrade-note" role="status">
                {reason} Ask your administrator for a verified package.
              </p>
            )}
            <ol className="agent-upgrade-steps">
              <li>
                <strong>Prepare a maintenance window</strong>
                <p>
                  Stopping the agent also stops its supervised Vector process.
                  Record the existing executable, state directory and service
                  account.
                </p>
              </li>
              <li>
                <strong>Stop and preserve</strong>
                <p>
                  Stop the existing supervisor, then back up the protected
                  state, managed configuration and Vector data. Keep credentials
                  private.
                </p>
              </li>
              <li>
                <strong>Replace only the agent</strong>
                <p>
                  Use the same executable path, permissions and account. Keep
                  Vector and the state directory in place. Do not re-enroll or
                  purge state.
                </p>
              </li>
              <li>
                <strong>Restart and verify</strong>
                <p>
                  Use the existing service or run command. Check local status
                  and diagnostics, a fresh heartbeat and the expected pipeline.
                  Existing pauses stay in effect.
                </p>
              </li>
            </ol>
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
