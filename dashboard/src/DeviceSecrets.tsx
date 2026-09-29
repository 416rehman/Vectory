import { useMemo, type ReactNode } from "react";
import type { Device, Version } from "./api";
import { SecretBindingSteps } from "./SecretReferenceField";
import { Disclosure, Skeleton, StatusBadge } from "./ui";
import type { StatusIcon, StatusTone } from "./status";
import { deviceSecretStates, type DeviceSecretState } from "./secretFields";
import "./secret-reference.css";

type Badge = { tone: StatusTone; icon?: StatusIcon; label: string };

const nameList = (names: readonly string[]): ReactNode =>
  names.map((name, index) => (
    <span key={name}>
      {index > 0 && ", "}
      <code>{name}</code>
    </span>
  ));

function bindingBadge(bound: DeviceSecretState["bound"]): Badge {
  if (bound === null)
    return { tone: "neutral", icon: "question", label: "Not reported" };
  return bound
    ? { tone: "success", label: "Bound" }
    : { tone: "warning", label: "Not bound" };
}

/**
 * The device secrets the desired version reads, and whether this device has
 * each one bound. The agent reports names only, at each check-in; values
 * never leave the device.
 */
export default function DeviceSecrets({
  device,
  version,
  loading,
  failed,
}: {
  device: Device;
  version: Version | null;
  loading: boolean;
  failed: boolean;
}) {
  const bound = device.secret_names;
  const states = useMemo(
    () => deviceSecretStates(version?.config, bound),
    [version, bound],
  );
  const assigned = !!device.desired_version_id;
  const known = assigned && !!version && !loading;
  const needed = new Set(states.map((state) => state.name));
  const others = (bound ?? []).filter((name) => !needed.has(name));
  const waiting = assigned && !known && !!device.uses_local_secrets;
  if (!waiting && !states.length && !others.length) return null;
  const reported = Array.isArray(bound);
  const missing = states.filter((state) => state.bound === false).length;
  const label =
    version?.number !== undefined
      ? `v${version.number}`
      : "The desired version";
  const summary: Badge = !reported
    ? { tone: "neutral", icon: "question", label: "Not reported" }
    : missing
      ? { tone: "warning", label: `${missing} not bound` }
      : { tone: "success", label: "All bound" };
  let body: ReactNode = null;
  if (waiting)
    body = failed ? (
      <p className="device-card-text">
        The secrets this version reads couldn't be loaded.
      </p>
    ) : (
      <div className="device-skeleton-lines" aria-busy="true">
        <Skeleton width="60%" height={12} />
        <Skeleton width="45%" height={12} />
      </div>
    );
  else if (states.length)
    body = (
      <>
        <p className="device-card-text">
          {label} reads{" "}
          {states.length === 1 ? "1 secret" : `${states.length} secrets`} from
          this device.
          {missing > 0 &&
            " A missing binding stops the device from applying it."}
          {!reported &&
            " This device hasn't reported which secrets it has bound, so only its apply status shows whether they resolved."}
        </p>
        <ul
          className="device-secret-list"
          aria-label={`Secrets ${label} reads`}
        >
          {states.map((state) => (
            <li key={state.name}>
              <code className="device-secret-name">{state.name}</code>
              <StatusBadge appearance="text" {...bindingBadge(state.bound)} />
              <span className="device-secret-uses">
                Used by {nameList(state.uses)}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  else if (assigned)
    body = (
      <p className="device-card-text">{label} doesn't read device secrets.</p>
    );
  return (
    <section
      className="device-card device-secrets"
      aria-labelledby="device-secrets-title"
    >
      <div className="device-card-head">
        <div>
          <h2 id="device-secrets-title">Device secrets</h2>
          <p className="device-card-subtitle">
            Values stay in files on this device and never reach Vectory.
          </p>
        </div>
        {states.length > 0 && <StatusBadge {...summary} />}
      </div>
      {body}
      {others.length > 0 && (
        <p className="device-card-text">
          {states.length ? "Also bound here: " : "Bound on this device: "}
          {nameList(others)}.
        </p>
      )}
      {states.length > 0 && (
        <Disclosure
          summary="How to bind secrets on this device"
          className="device-secret-binding"
          defaultOpen={missing > 0}
        >
          <SecretBindingSteps names={states.map((state) => state.name)} />
        </Disclosure>
      )}
    </section>
  );
}
