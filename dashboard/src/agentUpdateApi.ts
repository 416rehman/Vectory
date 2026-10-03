// The requests of agent updates, each with the deadline every change has and
// the reply checked against its schema (see agentUpdateResponseSchema). A
// deadline stops the wait; it never says whether the server applied the
// change. Nothing here sends a request twice.
import { api, boundedPost, put, withRequestDeadline } from "./api";
import type {
  AgentRelease,
  AgentUpdates,
  ReleaseKey,
  UpdatePreview,
  UpdateRollout,
  UpdateRolloutSettings,
} from "./agentUpdateModel";
import type { TurnOnBody } from "./agentUpdateSettings";

const settings = (body: unknown) =>
  withRequestDeadline((signal) =>
    put<AgentUpdates>("/agent-updates/settings", body, signal),
  );

/** Turns agent updates on, choosing who holds the key when none is kept yet. */
export const turnOn = (body: TurnOnBody) => settings(body);
/** Turns them off; refused while an update rollout is running. */
export const turnOff = (revision: number, currentPassword: string) =>
  settings({
    enabled: false,
    current_password: currentPassword,
    revision,
  });
export const stopAll = (reason: string) =>
  boundedPost<AgentUpdates>("/agent-updates/stop", { reason });
export const clearStop = (revision: number) =>
  boundedPost<AgentUpdates>("/agent-updates/stop/clear", { revision });

export const rotateKey = (currentPassword: string) =>
  boundedPost<ReleaseKey>("/agent-release-keys/rotate", {
    current_password: currentPassword,
  });
export const uploadRollover = (
  statement: string,
  signature: string,
  currentPassword: string,
) =>
  boundedPost<ReleaseKey>("/agent-release-keys/rollover", {
    statement,
    signature,
    current_password: currentPassword,
  });
export const revokeKey = (
  fingerprint: string,
  reason: string,
  currentPassword: string,
) =>
  boundedPost<ReleaseKey>(`/agent-release-keys/${fingerprint}/revoke`, {
    reason,
    current_password: currentPassword,
  });

export const prepareRelease = (version: string) =>
  boundedPost<AgentRelease>("/agent-releases", { version });
/** The signature file's own bytes, as chosen: never re-written. */
export const uploadSignature = (id: string, bytes: Uint8Array) =>
  withRequestDeadline((signal) =>
    api<AgentRelease>(`/agent-releases/${encodeURIComponent(id)}/signature`, {
      method: "PUT",
      body: bytes as BodyInit,
      headers: { "Content-Type": "application/octet-stream" },
      signal,
    }),
  );
export const withdrawRelease = (id: string, reason: string) =>
  boundedPost<AgentRelease>(
    `/agent-releases/${encodeURIComponent(id)}/withdraw`,
    { reason },
  );
/** Where the stored manifest bytes are downloaded from, exactly as stored. */
export const manifestHref = (id: string) =>
  `/api/v1/agent-releases/${encodeURIComponent(id)}/manifest`;

export type RolloutSelector = {
  device_ids: string[];
  group_ids: string[];
  exclude_ids: string[];
};
export type PreviewRequest = {
  release_id: string;
  selector: RolloutSelector;
  rollout: UpdateRolloutSettings;
};
export const previewRollout = (body: PreviewRequest) =>
  boundedPost<UpdatePreview>("/agent-update-rollouts/preview", body);
export type StartRequest = PreviewRequest & {
  name?: string;
  review_token: string;
  request_id: string;
};
export const startRollout = (body: StartRequest) =>
  boundedPost<UpdateRollout>("/agent-update-rollouts", body);
/** Pause, resume or cancel: the contract gives these routes an empty body. */
export const rolloutAction = (
  id: string,
  verb: "pause" | "resume" | "cancel",
) =>
  withRequestDeadline((signal) =>
    api<UpdateRollout>(
      `/agent-update-rollouts/${encodeURIComponent(id)}/${verb}`,
      { method: "POST", signal },
    ),
  );
