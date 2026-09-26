import { useState } from "react";
import { Download, KeyRound, RefreshCw, RotateCcw, Unplug } from "lucide-react";
import {
  can,
  download,
  post,
  type Deployment,
  type Device,
  type User,
} from "./api";
import { Button, ErrorBox, Modal } from "./ui";

export function DeviceRecoveryActions({
  device,
  user,
  onDone,
}: {
  device: Device;
  user: User;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function recover() {
    setBusy(true);
    setError("");
    try {
      const result = await post<{ token: string }>(
        `/devices/${device.id}/recover`,
      );
      setSecret(result.token);
      onDone("Recovery authorized. The one-use token is shown once.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    setError("");
    try {
      await post(`/devices/${device.id}/retry`);
      onDone("A new desired generation was released for a bounded retry.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="action-row">
        {can(user, "operate") && (
          <Button
            variant="secondary"
            icon={RotateCcw}
            busy={busy}
            disabled={!device.desired_version_id || device.status === "revoked"}
            onClick={retry}
          >
            Retry application
          </Button>
        )}
        {can(user, "admin") && (
          <Button
            variant="secondary"
            icon={KeyRound}
            onClick={() => {
              setError("");
              setOpen(true);
            }}
          >
            Authorize device recovery
          </Button>
        )}
      </div>
      {error && !open && <ErrorBox message={error} />}
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setSecret("");
        }}
        title={
          secret
            ? "Save this one-time recovery token"
            : "Authorize device recovery"
        }
        description="For an expired or lost identity. The host operator must explicitly complete recovery."
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <p>
            Recovery is restricted to <strong>{device.name}</strong> and expires
            after one hour. Using the token revokes the old credential and
            creates a new device UUID with no inherited groups or assignments.
          </p>
          {secret ? (
            <>
              <code className="block-code wrap">{secret}</code>
              <Button
                variant="secondary"
                icon={Download}
                onClick={() => download("vectory-recovery-token.txt", secret)}
              >
                Download token file
              </Button>
              <p className="muted section-space">
                Use the local agent’s{" "}
                <code>recover-enrollment --token-stdin</code> command, then
                review and explicitly target the new device. Store the
                downloaded file privately and delete it after use.
              </p>
            </>
          ) : (
            <p className="muted">
              A regular enrollment token cannot take over an existing name. This
              action creates a one-use recovery authorization and an audit
              event.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(false);
              setSecret("");
            }}
          >
            {secret ? "I’ve saved the token" : "Cancel"}
          </Button>
          {!secret && (
            <Button busy={busy} icon={KeyRound} onClick={recover}>
              Authorize recovery
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}

export function AssignmentActions({
  deployment,
  onDone,
}: {
  deployment: Deployment;
  onDone: (message: string) => void;
}) {
  const [action, setAction] = useState<"refresh" | "unassign" | null>(null),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function review(name: "refresh" | "unassign") {
    setAction(name);
    setPreview(null);
    setBusy(true);
    setError("");
    try {
      setPreview(
        await post(
          `/deployments/${deployment.id}/${name === "refresh" ? "refresh-preview" : "unassign-preview"}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    setBusy(true);
    setError("");
    try {
      await post(
        `/deployments/${deployment.id}/${action}`,
        action === "refresh"
          ? { expected_device_ids: preview.devices.map((d: Device) => d.id) }
          : {},
      );
      setAction(null);
      onDone(
        action === "refresh"
          ? "Schedule target snapshot refreshed."
          : "Assignment removed. Last working local configuration is retained where no assignment remains.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="action-row">
        {deployment.status === "scheduled" ? (
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={() => void review("refresh")}
          >
            Refresh scheduled targets
          </Button>
        ) : (
          !["missed", "unassigned"].includes(deployment.status) && (
            <Button
              variant="secondary"
              icon={Unplug}
              onClick={() => void review("unassign")}
            >
              Remove assignment
            </Button>
          )
        )}
      </div>
      <Modal
        open={!!action}
        onClose={() => setAction(null)}
        title={
          action === "refresh"
            ? "Review refreshed schedule targets"
            : "Review assignment removal"
        }
        description={
          action === "refresh"
            ? "Confirm a new concrete membership snapshot before activation. Membership is checked again at commit."
            : "Re-resolve each affected device. Without another assignment, the device keeps its working Vector workload and becomes unmanaged."
        }
        wide
      >
        <div className="modal-body">
          {error && <ErrorBox message={error} />}
          <p>{preview?.devices?.length ?? 0} affected devices</p>
          {preview?.warnings?.map((w: string) => (
            <p className="muted" key={w}>
              {w}
            </p>
          ))}
          {preview?.conflicts?.map((c: any, i: number) => (
            <ErrorBox
              key={i}
              message={typeof c === "string" ? c : JSON.stringify(c)}
            />
          ))}
          <div className="preview-devices">
            {preview?.devices?.map((d: Device) => (
              <span key={d.id}>
                {d.name} · generation {d.desired_generation}
              </span>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={() => setAction(null)}>
            Keep current assignment
          </Button>
          <Button
            busy={busy}
            disabled={!preview || !!preview.conflicts?.length}
            onClick={commit}
          >
            Confirm {action === "refresh" ? "new snapshot" : "removal"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
