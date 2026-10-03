import { useId, useState, type RefObject } from "react";
import { KeyRound, Server } from "lucide-react";
import type { AgentUpdates, ReleaseKey } from "./agentUpdateModel";
import {
  clearStop,
  revokeKey,
  rotateKey,
  stopAll,
  turnOff,
  turnOn,
  uploadRollover,
} from "./agentUpdateApi";
import {
  custodyChoices,
  otherCustodyWarning,
  readReason,
  readRolloverFile,
  REASON_LIMIT,
  turnOnBody,
  turnOnEffect,
  turnOnReady,
  type Custody,
} from "./agentUpdateSettings";
import { readKeyLine, shortKeyId } from "./releaseKey";
import { ChoiceCards } from "./ChoiceCards";
import { Fingerprint, KeyShortId } from "./AgentUpdateParts";
import DocLink from "./DocLink";
import RequestDialog from "./RequestDialog";
import { Field } from "./ui";

type Common = {
  email: string;
  /** The state at the moment the dialog opened. */
  updates: AgentUpdates;
  /** Reads the settings again: what a dialog checks after an unanswered request. */
  reload(): Promise<AgentUpdates | undefined>;
  onDone(message: string): void;
  onClose(): void;
  returnFocusRef: RefObject<HTMLElement | null>;
};

const unread = () => new Error("The current state couldn't be read.");

/* ---------- Turn on, or set a new key after the last was revoked ---------- */

export function TurnOnDialog({
  email,
  updates,
  reload,
  onDone,
  onClose,
  returnFocusRef,
}: Common) {
  const [opened] = useState(updates);
  const rekey = opened.enabled && !opened.current_key;
  const [choice, setChoice] = useState<Custody | "">("");
  const [keyLine, setKeyLine] = useState("");
  const [touched, setTouched] = useState(false);
  const keyId = useId();
  const effect = choice ? turnOnEffect(opened, choice) : null;
  const needsKey = choice === "offline" && effect !== "keep";
  const read = readKeyLine(keyLine.trim());
  const ready = turnOnReady(opened, choice, keyLine, "x");
  const typed = keyLine.trim().length > 0;
  const showKeyError = typed && !read.ok && (touched || keyLine.length > 60);
  const current = opened.current_key;
  return (
    <RequestDialog
      title={rekey ? "Set a release key" : "Turn on agent updates"}
      description={
        rekey
          ? "The release key was revoked. Choose who holds the new one. Hosts pin it when you add or upgrade them."
          : "A host takes updates only after someone adds or upgrades it with its consent. Who holds the release key can't change while updates are on."
      }
      confirmLabel={rekey ? "Set release key" : "Turn on agent updates"}
      email={email}
      valid={ready.ok}
      what={
        rekey
          ? "that the release key was set"
          : "that agent updates were turned on"
      }
      run={(password) =>
        turnOn(turnOnBody(opened, choice as Custody, keyLine, password))
      }
      check={async () => {
        const fresh = await reload();
        if (!fresh) throw unread();
        return rekey
          ? !!fresh.current_key && fresh.revision > opened.revision
          : fresh.enabled && fresh.revision > opened.revision;
      }}
      onDone={() =>
        onDone(
          rekey
            ? "Release key set. Hosts pin it when you add or upgrade them."
            : "Agent updates are on. Hosts pin the key when you add or upgrade them.",
        )
      }
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="lg"
    >
      {({ failure }) => (
        <>
          <ChoiceCards
            legend="Who holds the release key?"
            name="custody"
            value={choice}
            onChange={setChoice}
            choices={custodyChoices.map((option) => ({
              ...option,
              icon: option.value === "server" ? Server : KeyRound,
              note:
                current && opened.custody === option.value ? (
                  <>
                    Keeps the key you have,{" "}
                    <KeyShortId value={current.fingerprint} />. Hosts that pin
                    it need nothing.
                  </>
                ) : undefined,
            }))}
          />
          {needsKey && (
            <div className="update-key-field">
              <label htmlFor={keyId}>Public key</label>
              <textarea
                id={keyId}
                rows={3}
                value={keyLine}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                placeholder="vectory-release-key ed25519 … team"
                aria-invalid={showKeyError || failure?.field === "key"}
                aria-describedby={`${keyId}-hint ${keyId}-result`}
                onChange={(event) => setKeyLine(event.target.value)}
                onBlur={() => setTouched(true)}
              />
              <p id={`${keyId}-hint`} className="control-muted">
                Run <code>vectory release keygen</code> on the machine that will
                keep the private key. It prints the public key line: paste it
                here. The private key never comes to this server.
              </p>
              <div id={`${keyId}-result`} aria-live="polite">
                {read.ok && (
                  <div className="update-key-preview">
                    <span>
                      Fingerprint of this key
                      {read.name ? ` (named ${read.name})` : ""}
                    </span>
                    <Fingerprint value={read.fingerprint} copy={false} />
                    <small>
                      Computed here from the key you pasted. The server checks
                      that it is a valid key before it keeps it.
                    </small>
                  </div>
                )}
                {showKeyError && !read.ok && (
                  <p className="update-field-error" role="alert">
                    {read.message}
                  </p>
                )}
                {failure?.field === "key" && (
                  <p className="update-field-error" role="alert">
                    {failure.message}
                  </p>
                )}
              </div>
            </div>
          )}
          {effect === "replace" && (
            <p className="control-note update-warning" role="note">
              {otherCustodyWarning}
            </p>
          )}
        </>
      )}
    </RequestDialog>
  );
}

/* ---------- Turn off ---------- */

export function TurnOffDialog({
  email,
  updates,
  reload,
  onDone,
  onClose,
  returnFocusRef,
}: Common) {
  const [opened] = useState(updates);
  const running = opened.active_rollouts;
  return (
    <RequestDialog
      title="Turn off agent updates"
      description="No update is offered to any host while they are off."
      confirmLabel="Turn off agent updates"
      tone="danger"
      email={email}
      valid={running === 0}
      what="that agent updates were turned off"
      run={(password) => turnOff(opened.revision, password)}
      check={async () => {
        const fresh = await reload();
        if (!fresh) throw unread();
        return !fresh.enabled && fresh.revision > opened.revision;
      }}
      onDone={() =>
        onDone(
          "Agent updates are off. The release key and the stop are kept for when they are turned on again.",
        )
      }
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {() => (
        <>
          <p className="modal-copy">
            Hosts keep the consent they gave and the build they run. The key,
            who holds it and a stop are kept, so turning updates on again with
            the same key needs no re-pinning.
          </p>
          {running > 0 && (
            <p className="control-note update-warning" role="note">
              {running === 1
                ? "An update rollout is running."
                : `${running} update rollouts are running.`}{" "}
              Cancel {running === 1 ? "it" : "them"}, or stop all updates, then
              turn updates off.
            </p>
          )}
        </>
      )}
    </RequestDialog>
  );
}

/* ---------- Rotate (server custody) ---------- */

export function RotateDialog({
  email,
  updates,
  reload,
  onDone,
  onClose,
  returnFocusRef,
}: Common) {
  const [before] = useState(updates.current_key?.fingerprint ?? null);
  return (
    <RequestDialog
      title="Rotate the release key"
      description="The server makes a new key and retires the current one."
      confirmLabel="Rotate key"
      email={email}
      what="that the release key was rotated"
      run={(password) => rotateKey(password)}
      check={async () => {
        const fresh = await reload();
        if (!fresh) throw unread();
        return !!fresh.current_key && fresh.current_key.fingerprint !== before;
      }}
      onDone={() =>
        onDone(
          "Release key rotated. Hosts follow the statement to the new key by themselves.",
        )
      }
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {() => (
        <p className="modal-copy">
          The server signs a statement from the current key to the new one.
          Hosts follow it the next time they are offered a release, so no host
          needs a command. The old key stays on record as retired.
        </p>
      )}
    </RequestDialog>
  );
}

/* ---------- Upload a rollover (offline custody) ---------- */

export function RolloverDialog({
  email,
  updates,
  reload,
  onDone,
  onClose,
  returnFocusRef,
}: Common) {
  const [current] = useState(updates.current_key);
  const [file, setFile] = useState<{
    name: string;
    read: ReturnType<typeof readRolloverFile>;
  } | null>(null);
  const read = file?.read;
  const wrongKey =
    read?.ok && current && read.from !== current.fingerprint
      ? `This statement replaces key ${shortKeyId(read.from)}, but the current key is ${shortKeyId(current.fingerprint)}. Sign a statement from the current key.`
      : "";
  return (
    <RequestDialog
      title="Upload a rollover"
      description="Replace the offline key with a new one, signed by the key it replaces."
      confirmLabel="Upload rollover"
      email={email}
      valid={!!read?.ok && !wrongKey}
      what="that the rollover was applied"
      run={(password) => {
        if (!read?.ok) throw new Error("Choose a rollover file first.");
        return uploadRollover(read.statement, read.signature, password);
      }}
      check={async () => {
        const fresh = await reload();
        if (!fresh) throw unread();
        return (
          !!read?.ok && fresh.current_key?.fingerprint === read.to.fingerprint
        );
      }}
      onDone={() =>
        onDone(
          "Rollover applied. Hosts follow the statement to the new key by themselves.",
        )
      }
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="lg"
    >
      {({ failure }) => (
        <>
          <p className="modal-copy">
            Run <code>vectory release rollover</code> where the private key is
            kept. It writes a file holding the statement and its signature.
            Choose that file here.
          </p>
          <Field
            label="Rollover file"
            hint="The server checks the signature against the current key before it changes anything."
          >
            <input
              type="file"
              accept=".json,application/json"
              onChange={async (event) => {
                const chosen = event.target.files?.[0];
                if (!chosen) {
                  setFile(null);
                  return;
                }
                if (chosen.size > 4096) {
                  setFile({
                    name: chosen.name,
                    read: {
                      ok: false,
                      message:
                        "That file is too large to be a rollover statement.",
                    },
                  });
                  return;
                }
                setFile({
                  name: chosen.name,
                  read: readRolloverFile(await chosen.text()),
                });
              }}
            />
          </Field>
          {read && !read.ok && (
            <p className="update-field-error" role="alert">
              {read.message}
            </p>
          )}
          {read?.ok && (
            <div className="update-key-preview" aria-live="polite">
              <span>
                Makes <KeyShortId value={read.to.fingerprint} />
                {read.to.name ? ` (named ${read.to.name})` : ""} the current key
              </span>
              <Fingerprint value={read.to.fingerprint} copy={false} />
              <small>
                Replaces <KeyShortId value={read.from} />, written{" "}
                {read.issuedAt.replace("T", " ").replace("Z", " UTC")}.
              </small>
            </div>
          )}
          {wrongKey && (
            <p className="update-field-error" role="alert">
              {wrongKey}
            </p>
          )}
          {(failure?.field === "file" || failure?.field === "key") && (
            <p className="update-field-error" role="alert">
              {failure.message}
            </p>
          )}
        </>
      )}
    </RequestDialog>
  );
}

/* ---------- Revoke a key ---------- */

export function RevokeDialog({
  email,
  target,
  readKeys,
  onDone,
  onClose,
  returnFocusRef,
}: Omit<Common, "updates" | "reload"> & {
  target: ReleaseKey;
  readKeys(): Promise<ReleaseKey[] | undefined>;
}) {
  const [reasonText, setReasonText] = useState("");
  const reason = readReason(reasonText);
  return (
    <RequestDialog
      title={`Revoke key ${shortKeyId(target.fingerprint)}`}
      description="Revoking can't be undone."
      confirmLabel="Revoke key"
      tone="danger"
      email={email}
      valid={reason.ok}
      what="that the key was revoked"
      run={(password) =>
        revokeKey(target.fingerprint, reason.ok ? reason.reason : "", password)
      }
      check={async () => {
        const keys = await readKeys();
        if (!keys) throw unread();
        return (
          keys.find((key) => key.fingerprint === target.fingerprint)?.state ===
          "revoked"
        );
      }}
      onDone={() =>
        onDone(
          `Key ${shortKeyId(target.fingerprint)} revoked. Releases only it signed were withdrawn.`,
        )
      }
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {() => (
        <>
          <p className="modal-copy">
            Releases only this key signed are withdrawn, update rollouts that
            offer them end, and the key leaves the bundle hosts read.{" "}
            {target.devices_pinning > 0
              ? `${target.devices_pinning} ${target.devices_pinning === 1 ? "host pins" : "hosts pin"} it: they keep running, and accept no new build until you run their Upgrade agent command with a key they should trust.`
              : "No host that reported pins it."}{" "}
            <DocLink topic="agent-updates" section="if-a-key-is-stolen">
              If a key is stolen
            </DocLink>
          </p>
          {target.state === "current" && (
            <p className="control-note update-warning" role="note">
              This is the current key. Updates stay on without a key, and no
              release can be prepared, until an administrator sets a new one.
            </p>
          )}
          <Field
            label="Reason"
            hint={`Recorded in the audit log. At most ${REASON_LIMIT} characters, one line.`}
          >
            <input
              value={reasonText}
              maxLength={REASON_LIMIT}
              autoComplete="off"
              aria-invalid={!!reasonText && !reason.ok}
              onChange={(event) => setReasonText(event.target.value)}
            />
          </Field>
        </>
      )}
    </RequestDialog>
  );
}

/* ---------- Stop all updates, and clear the stop ---------- */

export function StopAllDialog({
  updates,
  reload,
  onDone,
  onClose,
  returnFocusRef,
}: Omit<Common, "email">) {
  const [opened] = useState(updates);
  const [reasonText, setReasonText] = useState("");
  const reason = readReason(reasonText);
  return (
    <RequestDialog
      title="Stop all updates"
      description="Cancels every update rollout and withdraws every offer. Devices already trying a build finish, and a device that already downloaded it may still start within about a minute."
      confirmLabel="Stop all updates"
      tone="danger"
      needsPassword={false}
      valid={reason.ok}
      what="that all updates were stopped"
      run={() => stopAll(reason.ok ? reason.reason : "")}
      check={async () => {
        const fresh = await reload();
        if (!fresh) throw unread();
        return fresh.stopped !== null;
      }}
      onDone={() =>
        onDone(
          opened.active_rollouts
            ? "All agent updates are stopped. Every update rollout was cancelled."
            : "All agent updates are stopped.",
        )
      }
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {() => (
        <>
          <p className="modal-copy">
            {opened.active_rollouts === 0
              ? "No update rollout is running now. Stopping also refuses new ones until an administrator clears the stop."
              : `${opened.active_rollouts} update ${opened.active_rollouts === 1 ? "rollout is" : "rollouts are"} running. Stopping cancels ${opened.active_rollouts === 1 ? "it" : "them"} and refuses new ones until an administrator clears the stop.`}{" "}
            <DocLink topic="agent-updates" section="stop-all-updates">
              What stopping does
            </DocLink>
          </p>
          <Field
            label="Reason"
            hint={`Shown to everyone and recorded in the audit log. At most ${REASON_LIMIT} characters, one line.`}
          >
            <input
              value={reasonText}
              maxLength={REASON_LIMIT}
              autoComplete="off"
              aria-invalid={!!reasonText && !reason.ok}
              onChange={(event) => setReasonText(event.target.value)}
            />
          </Field>
        </>
      )}
    </RequestDialog>
  );
}

export function ClearStopDialog({
  updates,
  reload,
  onDone,
  onClose,
  returnFocusRef,
}: Omit<Common, "email">) {
  const [opened] = useState(updates);
  return (
    <RequestDialog
      title="Clear the stop"
      description="Update rollouts can start again."
      confirmLabel="Clear the stop"
      needsPassword={false}
      what="that the stop was cleared"
      run={() => clearStop(opened.revision)}
      check={async () => {
        const fresh = await reload();
        if (!fresh) throw unread();
        return fresh.stopped === null;
      }}
      onDone={() =>
        onDone(
          "The stop is cleared. Nothing was resumed: the rollouts it cancelled stay cancelled.",
        )
      }
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {() => (
        <p className="modal-copy">
          Clearing the stop resumes nothing. The rollouts it cancelled stay
          cancelled, and a new rollout is reviewed before it starts.
        </p>
      )}
    </RequestDialog>
  );
}
