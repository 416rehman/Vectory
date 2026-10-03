// Releases: a build of the agent, prepared from this server's catalog, with
// the signature that lets hosts install it. With this server's key a release is
// ready at once; with a key kept offline it waits for the signature the team
// makes where the key is. Only a signed, unexpired release can start a rollout.
import { useRef, useState } from "react";
import { Download, FileKey, Upload } from "lucide-react";
import type { AgentRelease, AgentUpdates } from "./agentUpdateModel";
import {
  platformName,
  releaseDisplayState,
  releaseStartable,
  signCommand,
} from "./agentUpdateModel";
import {
  manifestHref,
  prepareRelease,
  uploadSignature,
  withdrawRelease,
} from "./agentUpdateApi";
import {
  readReason,
  readSignatureFile,
  REASON_LIMIT,
  SIGNATURE_LIMIT,
} from "./agentUpdateSettings";
import { describeFailure, type Failure } from "./agentUpdateRequests";
import { custodyName } from "./agentUpdateSettings";
import { shortKeyId } from "./releaseKey";
import { CommandBlock } from "./CommandBlock";
import { KeyShortId } from "./AgentUpdateParts";
import RequestDialog from "./RequestDialog";
import { Unconfirmed } from "./authControls";
import { Button, DateCell, ErrorBox, Field, StatusBadge } from "./ui";
import { statusOf } from "./status";
import "./agent-updates.css";

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

/* ---------- One release ---------- */

export function ReleaseCard({
  release,
  updates,
  admin,
  operate,
  onReview,
  onWithdraw,
  onChanged,
  reload,
}: {
  release: AgentRelease;
  updates: AgentUpdates;
  admin: boolean;
  operate: boolean;
  onReview(release: AgentRelease): void;
  onWithdraw(release: AgentRelease, opener: HTMLElement): void;
  onChanged(message: string): void;
  /** Reads the releases again; the answer is the releases now. */
  reload(): Promise<AgentRelease[] | undefined>;
}) {
  const state = releaseDisplayState(release);
  return (
    <article
      className="update-release"
      id={`release-${release.id}`}
      data-state={state}
      aria-labelledby={`release-${release.id}-title`}
    >
      <header>
        <div>
          <h3 id={`release-${release.id}-title`}>Agent {release.version}</h3>
          <p className="control-muted">
            Counter {release.counter}
            {release.signer ? (
              <>
                {" · signed by key "}
                <KeyShortId value={release.signer.fingerprint} />
                {` (${custodyName(release.signer.custody).toLowerCase()})`}
              </>
            ) : (
              " · not signed yet"
            )}
          </p>
        </div>
        <StatusBadge domain="updateRelease" value={state} />
      </header>
      <dl className="update-release-facts">
        <div>
          <dt>Builds</dt>
          <dd>
            {release.artifacts
              .map(
                (artifact) =>
                  `${platformName(artifact)} (${megabytes(artifact.size)})`,
              )
              .join(", ")}
          </dd>
        </div>
        <div>
          <dt>{state === "expired" ? "Expired" : "Expires"}</dt>
          <dd>
            <DateCell value={release.expires_at} />
          </dd>
        </div>
        <div>
          <dt>Prepared</dt>
          <dd>
            <DateCell value={release.prepared_at} />
            {release.prepared_by_name ? ` by ${release.prepared_by_name}` : ""}
          </dd>
        </div>
        {release.state === "withdrawn" && (
          <div>
            <dt>Withdrawn</dt>
            <dd>
              <DateCell value={release.withdrawn_at} />
              {release.withdrawn_reason ? `: ${release.withdrawn_reason}` : ""}
            </dd>
          </div>
        )}
        {release.rollouts.length > 0 && (
          <div>
            <dt>Rollouts</dt>
            <dd className="update-release-rollouts">
              {release.rollouts.slice(0, 5).map((rollout) => (
                <a
                  key={rollout.id}
                  href={`#/agent-updates/${encodeURIComponent(rollout.id)}`}
                >
                  {statusOf("updateRollout", rollout.status).label}
                </a>
              ))}
              {release.rollouts.length > 5 &&
                ` and ${release.rollouts.length - 5} more`}
            </dd>
          </div>
        )}
      </dl>
      {release.state === "awaiting_signature" && (
        <SigningPanel
          release={release}
          updates={updates}
          admin={admin}
          onChanged={onChanged}
          reload={reload}
        />
      )}
      {(operate || admin) && release.state !== "withdrawn" && (
        <div className="update-actions">
          {operate && releaseStartable(release) && (
            <Button onClick={() => onReview(release)}>Update devices…</Button>
          )}
          {admin && (
            <Button
              variant="danger-ghost"
              onClick={(event) => onWithdraw(release, event.currentTarget)}
            >
              Withdraw…
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

/* ---------- Waiting for your signature ---------- */

function SigningPanel({
  release,
  updates,
  admin,
  onChanged,
  reload,
}: {
  release: AgentRelease;
  updates: AgentUpdates;
  admin: boolean;
  onChanged(message: string): void;
  reload(): Promise<AgentRelease[] | undefined>;
}) {
  const current = updates.current_key;
  const [file, setFile] = useState<{
    name: string;
    bytes: Uint8Array;
    read: ReturnType<typeof readSignatureFile>;
  } | null>(null);
  const [phase, setPhase] = useState<"form" | "sending" | "unconfirmed">(
    "form",
  );
  const [failure, setFailure] = useState<Failure | null>(null);
  const [note, setNote] = useState("");
  const chooser = useRef<HTMLInputElement>(null);

  async function upload() {
    if (!file?.read.ok || phase === "sending") return;
    setPhase("sending");
    setFailure(null);
    setNote("");
    try {
      await uploadSignature(release.id, file.bytes);
      onChanged(
        `Signature accepted. Agent ${release.version} is ready to roll out.`,
      );
    } catch (error) {
      const found = describeFailure(error);
      setFailure(found);
      setPhase(found.definite ? "form" : "unconfirmed");
    }
  }
  async function check() {
    setPhase("sending");
    try {
      const releases = await reload();
      const fresh = releases?.find((item) => item.id === release.id);
      if (!fresh) throw new Error("unread");
      if (fresh.state === "ready") {
        onChanged(
          `Signature accepted. Agent ${release.version} is ready to roll out.`,
        );
        return;
      }
      setNote("It wasn't applied, so nothing changed. You can upload again.");
      setFailure(null);
      setPhase("form");
    } catch {
      setNote("The release couldn't be read. Check your connection.");
      setPhase("unconfirmed");
    }
  }

  return (
    <section
      className="update-sign"
      aria-labelledby={`release-${release.id}-sign`}
    >
      <h4 id={`release-${release.id}-sign`}>
        <FileKey size={16} aria-hidden="true" /> Waiting for your signature
      </h4>
      <p>
        This release waits for a signature by the key you keep offline
        {current ? (
          <>
            , the one starting <KeyShortId value={current.fingerprint} />
          </>
        ) : (
          ""
        )}
        . No host is offered it until you sign it and upload the signature.
      </p>
      <ol className="update-sign-steps">
        <li>
          <strong>Download the manifest</strong>
          <p>
            It is the exact file to sign. Sign these bytes; nothing re-writes
            them.
          </p>
          <a
            className="button secondary compact"
            href={manifestHref(release.id)}
            download="release.json"
          >
            <Download size={15} aria-hidden="true" /> Download release.json
          </a>
          <small>
            SHA-256 <code>{release.manifest_sha256}</code>
          </small>
        </li>
        <li>
          <strong>Get SHA256SUMS</strong>
          <p>
            The checksums of this release&apos;s builds, from the project&apos;s
            release page or from your own build. Don&apos;t take them from this
            server: the signer checks the manifest against them, and a list from
            the server would only check the server against itself.
          </p>
        </li>
        <li>
          <strong>Sign it where the key is kept</strong>
          <p>Put release.json and SHA256SUMS beside the private key and run:</p>
          <CommandBlock
            command={signCommand}
            label="Sign command"
            heading="On the machine that holds the key"
          />
          <small>
            It signs only when every build in release.json matches SHA256SUMS,
            shows what it signs and asks first. It writes release.json.sig.
          </small>
        </li>
        <li>
          <strong>Upload release.json.sig</strong>
          {admin ? (
            <div className="update-sign-upload">
              {phase === "unconfirmed" ? (
                <Unconfirmed>
                  <p>
                    We couldn&apos;t confirm the signature was accepted. It may
                    have been. Check the release before you upload again.
                  </p>
                  {note && <p>{note}</p>}
                </Unconfirmed>
              ) : (
                <>
                  <Field
                    label="Signature file"
                    hint={`A release.json.sig, under ${SIGNATURE_LIMIT / 1024} KiB. The server checks it against the current key and keeps it only if it verifies.`}
                  >
                    <input
                      ref={chooser}
                      type="file"
                      accept=".sig,.json,application/json"
                      disabled={phase === "sending"}
                      onChange={async (event) => {
                        const chosen = event.target.files?.[0];
                        setFailure(null);
                        setNote("");
                        if (!chosen) {
                          setFile(null);
                          return;
                        }
                        const bytes = new Uint8Array(
                          await chosen
                            .slice(0, SIGNATURE_LIMIT + 1)
                            .arrayBuffer(),
                        );
                        setFile({
                          name: chosen.name,
                          bytes,
                          read: readSignatureFile(
                            bytes,
                            current?.fingerprint ?? null,
                          ),
                        });
                      }}
                    />
                  </Field>
                  {file && !file.read.ok && (
                    <p className="update-field-error" role="alert">
                      {file.read.message}
                    </p>
                  )}
                  {file?.read.ok && (
                    <p
                      className={
                        file.read.namesCurrent
                          ? "update-file-ok"
                          : "update-field-error"
                      }
                      role="status"
                    >
                      {file.read.namesCurrent
                        ? `${file.name} names key ${shortKeyId(current!.fingerprint)}, the current key, as its signer. The server verifies the signature when you upload it.`
                        : `None of its signatures names the current key${current ? ` (${shortKeyId(current.fingerprint)})` : ""}, so the server will refuse it.`}
                    </p>
                  )}
                  {note && <p className="control-muted">{note}</p>}
                  {failure && <ErrorBox message={failure.message} />}
                </>
              )}
              <div className="update-actions">
                {phase === "unconfirmed" ? (
                  <Button onClick={() => void check()}>
                    Check the release
                  </Button>
                ) : (
                  <Button
                    icon={Upload}
                    busy={phase === "sending"}
                    disabled={!file?.read.ok}
                    onClick={() => void upload()}
                  >
                    Upload signature
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="control-muted">
              Only an administrator can upload the signature.
            </p>
          )}
        </li>
      </ol>
    </section>
  );
}

/* ---------- Prepare, and withdraw ---------- */

export function PrepareDialog({
  version,
  updates,
  readReleases,
  onDone,
  onClose,
  returnFocusRef,
}: {
  version: string;
  updates: AgentUpdates;
  readReleases(): Promise<AgentRelease[] | undefined>;
  onDone(release: AgentRelease): void;
  onClose(): void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const made = useRef<AgentRelease | null>(null);
  const offline = updates.custody === "offline";
  return (
    <RequestDialog
      title={`Prepare agent ${version}`}
      description="The server turns a build of its catalog into a release hosts can verify."
      confirmLabel="Prepare release"
      needsPassword={false}
      what={`that agent ${version} was prepared`}
      run={async () => {
        made.current = await prepareRelease(version);
      }}
      check={async () => {
        const releases = await readReleases();
        if (!releases) throw new Error("unread");
        const found = releases.find(
          (item) => item.version === version && item.state !== "withdrawn",
        );
        made.current = found ?? null;
        return !!found;
      }}
      onDone={() => made.current && onDone(made.current)}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {() => (
        <p className="modal-copy">
          The server copies each platform&apos;s build of {version} into its
          release store, takes the next counter and writes the manifest hosts
          check. The release expires after 180 days.{" "}
          {offline
            ? "It then waits for your signature: nothing is offered until you sign it with the key you keep offline."
            : "It signs the manifest with its own key at once, and the release is ready."}
        </p>
      )}
    </RequestDialog>
  );
}

export function WithdrawDialog({
  release,
  readReleases,
  onDone,
  onClose,
  returnFocusRef,
}: {
  release: AgentRelease;
  readReleases(): Promise<AgentRelease[] | undefined>;
  onDone(): void;
  onClose(): void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const [text, setText] = useState("");
  const reason = readReason(text);
  const live = release.rollouts.filter(
    (rollout) => rollout.status === "active" || rollout.status === "paused",
  ).length;
  return (
    <RequestDialog
      title={`Withdraw agent ${release.version}`}
      description="No device is offered it after this. Its record stays."
      confirmLabel="Withdraw release"
      tone="danger"
      needsPassword={false}
      valid={reason.ok}
      what={`that agent ${release.version} was withdrawn`}
      run={() => withdrawRelease(release.id, reason.ok ? reason.reason : "")}
      check={async () => {
        const releases = await readReleases();
        if (!releases) throw new Error("unread");
        return (
          releases.find((item) => item.id === release.id)?.state === "withdrawn"
        );
      }}
      onDone={onDone}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {() => (
        <>
          <p className="modal-copy">
            {live > 0
              ? `${live} update ${live === 1 ? "rollout" : "rollouts"} of this release ${live === 1 ? "is" : "are"} running and will be cancelled. `
              : ""}
            Devices already applying it finish. A release can&apos;t be
            un-withdrawn: prepare it again for a new counter.
          </p>
          <Field
            label="Reason"
            hint={`Recorded in the audit log. At most ${REASON_LIMIT} characters, one line.`}
          >
            <input
              value={text}
              maxLength={REASON_LIMIT}
              autoComplete="off"
              aria-invalid={!!text && !reason.ok}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
        </>
      )}
    </RequestDialog>
  );
}
