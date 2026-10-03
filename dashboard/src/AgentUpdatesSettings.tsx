// Settings, Agent updates: whether the team lets the dashboard update agents,
// who holds the release key, and what hosts still trust. Everyone reads it;
// administrators change it, with their password. Every number and name comes
// from the server; nothing is inferred.
import { useRef, useState } from "react";
import { ArrowRight, CircleArrowUp, KeyRound, Server } from "lucide-react";
import { can, when, type User } from "./api";
import type { ReleaseKey } from "./agentUpdateModel";
import { custodyName, stalePins } from "./agentUpdateSettings";
import { KeyShortId, Fingerprint } from "./AgentUpdateParts";
import {
  ClearStopDialog,
  RevokeDialog,
  RolloverDialog,
  RotateDialog,
  TurnOffDialog,
  TurnOnDialog,
} from "./AgentUpdateSettingsDialogs";
import { DataTable, TableCard } from "./DataTable";
import {
  Button,
  DateCell,
  InlineError,
  PageHeader,
  Skeleton,
  StatusBadge,
  useResource,
} from "./ui";
import { useAgentUpdates } from "./useAgentUpdates";
import DocLink from "./DocLink";
import { exactLocal } from "./time";
import type { Notify } from "./toast";
import "./control.css";
import "./agent-updates.css";

type Dialog =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "rotate" }
  | { kind: "rollover" }
  | { kind: "clear" }
  | { kind: "revoke"; key: ReleaseKey };

const people = (count: number) => (count === 1 ? "host" : "hosts");

export default function AgentUpdatesSettings({
  user,
  notify,
  navigate,
}: {
  user: User;
  notify: Notify;
  navigate(path: string): void;
}) {
  const state = useAgentUpdates();
  const updates = state.updates;
  const on = updates?.enabled === true;
  const keys = useResource<ReleaseKey[]>(on ? "/agent-release-keys" : null, []);
  const admin = can(user, "admin");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = (next: Dialog) => (event: React.MouseEvent<HTMLElement>) => {
    returnFocus.current = event.currentTarget;
    setDialog(next);
  };
  const done = (message: string) => {
    setDialog(null);
    notify(message, { tone: "success" });
    void state.reload();
    void keys.reload();
  };
  const loadingFirst = state.loading && !updates;
  const stopped = updates?.stopped ?? null;
  const stale = on ? stalePins(keys.data) : [];
  const frozen = updates?.frozen_devices ?? null;
  const current = updates?.current_key ?? null;
  const rekey = on && !current;
  const common = updates && {
    email: user.email,
    updates,
    reload: state.reloadResult as () => Promise<
      NonNullable<typeof updates> | undefined
    >,
    onDone: done,
    onClose: () => setDialog(null),
    returnFocusRef: returnFocus,
  };

  return (
    <div className="control-page update-settings">
      <PageHeader
        title="Agent updates"
        help={{ topic: "agent-updates" }}
        description="Let the dashboard update the agent on hosts that agreed to it, with builds signed by a release key those hosts pin."
        live={{
          updatedAt: state.updatedAt,
          error: state.error || undefined,
          loading: state.loading,
          refreshing: state.refreshing,
          onRefresh: () => {
            void state.reload();
            void keys.reload();
          },
        }}
      />
      {state.error && (
        <InlineError
          title={
            updates
              ? "Couldn't refresh agent updates."
              : "Couldn't load agent updates."
          }
          error={state.error}
          updatedAt={state.updatedAt}
          retry={() => void state.reload()}
          retrying={state.refreshing}
        />
      )}
      {loadingFirst ? (
        <section
          className="control-card update-card"
          aria-busy="true"
          aria-label="Loading agent updates"
        >
          <Skeleton width={220} height={18} />
          <Skeleton width="70%" height={12} />
        </section>
      ) : (
        updates &&
        common && (
          <>
            <section
              className="control-card update-card"
              aria-labelledby="update-state"
            >
              <div className="update-card-head">
                <div>
                  <h2 id="update-state">
                    {on ? "Agent updates are on" : "Agent updates are off"}
                  </h2>
                  <p>
                    {on
                      ? "A host takes an update only if it agreed to updates when it was added or last upgraded, and only a build signed by a key it pins."
                      : "Devices run the agent they have until someone upgrades it on the host."}
                  </p>
                </div>
                <StatusBadge
                  domain="updateSetting"
                  value={stopped ? "stopped" : on ? "on" : "off"}
                />
              </div>
              <div className="update-actions">
                {admin && !on && (
                  <Button icon={CircleArrowUp} onClick={open({ kind: "on" })}>
                    Turn on agent updates…
                  </Button>
                )}
                {admin && on && (
                  <Button variant="secondary" onClick={open({ kind: "off" })}>
                    Turn off…
                  </Button>
                )}
                {on && (
                  <a
                    className="button ghost"
                    href="#/agent-updates"
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey)
                        return;
                      event.preventDefault();
                      navigate("agent-updates");
                    }}
                  >
                    Open Devices, Agent updates
                    <ArrowRight size={15} aria-hidden="true" />
                  </a>
                )}
                {!admin && (
                  <p className="control-muted">
                    Only an administrator can change this.
                  </p>
                )}
              </div>
              {stopped && (
                <div className="update-stop" role="status">
                  <div>
                    <strong>All agent updates are stopped</strong>
                    <p>
                      {stopped.by_name ? `${stopped.by_name}, ` : ""}
                      <time
                        dateTime={stopped.at}
                        title={exactLocal(stopped.at)}
                      >
                        <DateCell value={stopped.at} />
                      </time>
                      : “{stopped.reason}”. No update rollout can start until an
                      administrator clears the stop. Clearing it resumes
                      nothing.
                    </p>
                  </div>
                  {admin && (
                    <Button
                      variant="secondary"
                      onClick={open({ kind: "clear" })}
                    >
                      Clear the stop
                    </Button>
                  )}
                </div>
              )}
            </section>

            {(current || rekey) && (
              <section
                className="control-card update-card"
                aria-labelledby="update-key"
              >
                <h2 id="update-key">Release key</h2>
                {current ? (
                  <>
                    <dl className="control-summary-list update-facts">
                      <div>
                        <dt>Who holds it</dt>
                        <dd>
                          <span className="update-custody">
                            {current.custody === "server" ? (
                              <Server size={15} aria-hidden="true" />
                            ) : (
                              <KeyRound size={15} aria-hidden="true" />
                            )}
                            {custodyName(updates.custody ?? current.custody)}
                          </span>
                          <small>
                            {on
                              ? "Fixed while updates are on."
                              : "You choose again when you turn updates on."}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>Fingerprint</dt>
                        <dd>
                          <Fingerprint value={current.fingerprint} />
                          <small>
                            Hosts pin this key when you add or upgrade them.
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>Made</dt>
                        <dd>
                          <DateCell value={current.created_at} />
                          {current.created_by_name
                            ? ` by ${current.created_by_name}`
                            : ""}
                        </dd>
                      </div>
                    </dl>
                    {on && admin && (
                      <div className="update-actions">
                        {current.custody === "server" ? (
                          <Button
                            variant="secondary"
                            onClick={open({ kind: "rotate" })}
                          >
                            Rotate key…
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            onClick={open({ kind: "rollover" })}
                          >
                            Upload rollover…
                          </Button>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="control-muted">
                      The release key was revoked. Updates are still on, but no
                      release can be prepared until a new key is set. Hosts that
                      pinned the old key need their Upgrade agent command.
                    </p>
                    {admin && (
                      <div className="update-actions">
                        <Button onClick={open({ kind: "on" })}>
                          Set a release key…
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {on && (
              <section
                className="update-section"
                aria-labelledby="update-history"
              >
                <div className="control-section-head">
                  <div>
                    <h2 id="update-history">Key history</h2>
                    <p>
                      Every key this server has registered, newest first.
                      Revoking a key withdraws what only it signed.
                    </p>
                  </div>
                </div>
                <TableCard className="control-table">
                  <DataTable<ReleaseKey>
                    label="Release keys"
                    className="update-key-table"
                    data={keys.data}
                    rowKey={(key) => key.fingerprint}
                    loading={keys.loading && keys.data.length === 0}
                    error={
                      keys.error
                        ? {
                            title: keys.updatedAt
                              ? "Couldn't refresh the key history."
                              : "Couldn't load the key history.",
                            message: keys.error,
                            updatedAt: keys.updatedAt,
                            retry: () => void keys.reload(),
                            retrying: keys.refreshing,
                          }
                        : null
                    }
                    mobileCard={(key) => ({
                      title: (
                        <>
                          <KeyShortId value={key.fingerprint} />
                        </>
                      ),
                      status: (
                        <StatusBadge domain="releaseKey" value={key.state} />
                      ),
                      meta: [
                        custodyName(key.custody),
                        `Made ${when(key.created_at)}${key.created_by_name ? ` by ${key.created_by_name}` : ""}`,
                        key.devices_pinning
                          ? `${key.devices_pinning} ${people(key.devices_pinning)} pin it`
                          : "No host pins it",
                      ],
                      actions:
                        admin && key.state !== "revoked" ? (
                          <Button
                            variant="danger-ghost compact"
                            onClick={open({ kind: "revoke", key })}
                          >
                            Revoke key…
                          </Button>
                        ) : undefined,
                    })}
                    columns={[
                      {
                        id: "key",
                        header: "Key",
                        cell: (key) => (
                          <>
                            <KeyShortId value={key.fingerprint} />
                            <small>{custodyName(key.custody)}</small>
                          </>
                        ),
                      },
                      {
                        id: "state",
                        header: "State",
                        cell: (key) => (
                          <>
                            <StatusBadge
                              domain="releaseKey"
                              value={key.state}
                            />
                            {key.state === "revoked" && key.revoked_reason && (
                              <small>{key.revoked_reason}</small>
                            )}
                          </>
                        ),
                      },
                      {
                        id: "made",
                        header: "Made",
                        cell: (key) => (
                          <>
                            <DateCell value={key.created_at} />
                            {key.created_by_name && (
                              <small>by {key.created_by_name}</small>
                            )}
                          </>
                        ),
                      },
                      {
                        id: "hosts",
                        header: "Hosts that pin it",
                        cell: (key) =>
                          key.devices_pinning ? (
                            <>
                              {key.devices_pinning}{" "}
                              {people(key.devices_pinning)}
                              <small>
                                {key.device_names.slice(0, 3).join(", ")}
                                {key.devices_pinning > 3 ? " and more" : ""}
                              </small>
                            </>
                          ) : (
                            <span className="control-muted">None</span>
                          ),
                      },
                      {
                        id: "actions",
                        header: <span className="sr-only">Actions</span>,
                        label: "Actions",
                        cell: (key) =>
                          admin && key.state !== "revoked" ? (
                            <Button
                              variant="danger-ghost compact"
                              aria-label={`Revoke key ${key.fingerprint.slice(0, 16)}`}
                              onClick={open({ kind: "revoke", key })}
                            >
                              Revoke key…
                            </Button>
                          ) : null,
                      },
                    ]}
                    empty="No release key is registered."
                  />
                </TableCard>
              </section>
            )}

            {on && (
              <section
                className="control-card update-card"
                aria-labelledby="update-hosts"
              >
                <h2 id="update-hosts">Hosts that trust an older key</h2>
                {stale.length === 0 &&
                !(frozen && frozen.total > 0) &&
                !keys.error ? (
                  <p className="control-muted">
                    No host that reported pins a retired or revoked key
                    {frozen
                      ? ", and none reports two successors of its key"
                      : ""}
                    . Hosts that haven&apos;t reported are not counted.
                  </p>
                ) : (
                  <ul className="update-host-list">
                    {stale.map(({ key, hosts, names, more, follows }) => (
                      <li key={key.fingerprint} data-state={key.state}>
                        <div>
                          <strong>
                            {hosts} {people(hosts)} pin the{" "}
                            {key.state === "revoked" ? "revoked" : "retired"}{" "}
                            key <KeyShortId value={key.fingerprint} />
                          </strong>
                          <p>
                            {names.join(", ")}
                            {more > 0 ? ` and ${more} more` : ""}
                          </p>
                          <small>
                            {follows
                              ? "They follow the rollover to the current key by themselves the next time a release is offered."
                              : key.state === "revoked"
                                ? "They accept no build signed by the current key. Run each host's Upgrade agent command, which pins the current key."
                                : "The rollover statements don't reach the current key. Run each host's Upgrade agent command, which pins it."}
                          </small>
                        </div>
                      </li>
                    ))}
                    {frozen && frozen.total > 0 && (
                      <li data-state="fork">
                        <div>
                          <strong>
                            {frozen.total}{" "}
                            {frozen.total === 1
                              ? "host is frozen"
                              : "hosts are frozen"}{" "}
                            on a fork
                          </strong>
                          {frozen.items.map((item) => (
                            <p key={item.device_id}>
                              <a
                                href={`#/devices/${encodeURIComponent(item.device_id)}`}
                              >
                                {item.device_name || item.device_id}
                              </a>
                              {" saw two successors of key "}
                              <code>
                                {item.rollover_conflict.from.slice(0, 16)}
                              </code>
                              {": "}
                              <code>
                                {item.rollover_conflict.to[0].slice(0, 16)}
                              </code>
                              {" and "}
                              <code>
                                {item.rollover_conflict.to[1].slice(0, 16)}
                              </code>
                            </p>
                          ))}
                          {frozen.total > frozen.items.length && (
                            <p>and {frozen.total - frozen.items.length} more</p>
                          )}
                          <small>
                            A frozen host accepts no update until its Upgrade
                            agent command is run with the key it should trust.
                          </small>
                        </div>
                      </li>
                    )}
                  </ul>
                )}
              </section>
            )}
          </>
        )
      )}

      {dialog && common && (
        <>
          {dialog.kind === "on" && <TurnOnDialog {...common} />}
          {dialog.kind === "off" && <TurnOffDialog {...common} />}
          {dialog.kind === "rotate" && <RotateDialog {...common} />}
          {dialog.kind === "rollover" && <RolloverDialog {...common} />}
          {dialog.kind === "clear" && <ClearStopDialog {...common} />}
          {dialog.kind === "revoke" && (
            <RevokeDialog
              email={common.email}
              target={dialog.key}
              readKeys={() => keys.reloadResult()}
              onDone={common.onDone}
              onClose={common.onClose}
              returnFocusRef={returnFocus}
            />
          )}
        </>
      )}
      <p className="control-muted update-foot">
        <DocLink topic="agent-updates">How agent updates work</DocLink>
      </p>
    </div>
  );
}
