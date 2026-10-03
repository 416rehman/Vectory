// "Roll out to this device": the review of an update rollout with this one
// device chosen, once a release is ready to start from. Without one it says
// where a release is prepared and signed.
import { lazy, Suspense } from "react";
import type { AgentRelease, AgentUpdates } from "./agentUpdateModel";
import { releaseStartable } from "./agentUpdateModel";
import type { Device, User } from "./api";
import { Button, Modal, Spinner, useResource } from "./ui";

const Review = lazy(() => import("./AgentUpdateReview"));

export default function DeviceRollout({
  device,
  user,
  updates,
  returnFocusRef,
  onClose,
}: {
  device: Pick<Device, "id" | "name">;
  user: User;
  updates: AgentUpdates;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const releases = useResource<AgentRelease[]>("/agent-releases", []);
  const startable = releases.data.filter(releaseStartable);
  if (releases.loading && !releases.updatedAt)
    return (
      <Modal
        open
        title={`Roll out to ${device.name}`}
        description="Reading the releases this server has prepared."
        onClose={onClose}
        returnFocusRef={returnFocusRef}
      >
        <div className="modal-body" role="status">
          <Spinner /> Reading the releases…
        </div>
      </Modal>
    );
  if (!startable.length || updates.stopped)
    return (
      <Modal
        open
        title={`Roll out to ${device.name}`}
        description={
          updates.stopped
            ? "All agent updates are stopped."
            : "No release is ready to roll out."
        }
        onClose={onClose}
        returnFocusRef={returnFocusRef}
      >
        <div className="modal-body">
          <p className="modal-copy">
            {releases.error
              ? `The releases couldn't be read: ${releases.error}`
              : updates.stopped
                ? "An administrator clears the stop in Settings, Agent updates, before a rollout can start."
                : "An administrator prepares a release from this server's catalog, and signs it when its key is kept offline, under Devices, Agent updates. Then it can be rolled out here."}
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <a className="button" href="#/agent-updates" onClick={onClose}>
            Open Agent updates
          </a>
        </div>
      </Modal>
    );
  return (
    <Suspense fallback={null}>
      <Review
        user={user}
        releases={startable}
        initialReleaseId={startable[0].id}
        initialDeviceIds={[device.id]}
        updates={updates}
        returnFocusRef={returnFocusRef}
        onClose={onClose}
        onStarted={(rollout) => {
          onClose();
          location.hash = `#/agent-updates/${encodeURIComponent(rollout.id)}`;
        }}
      />
    </Suspense>
  );
}
