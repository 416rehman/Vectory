import { useEffect, useState } from "react";
import { BellOff, X } from "lucide-react";
import { api, can, withRequestDeadline, type User } from "./api";
import type { ChannelList } from "./notificationsModel";
import "./notifications-hint.css";

const storageKey = (user: User) => `vectory-notifications-hint:${user.id}`;
function wasDismissed(user: User) {
  try {
    return localStorage.getItem(storageKey(user)) === "dismissed";
  } catch {
    return false;
  }
}

/**
 * One quiet line, for administrators only, while no notification channel
 * exists. It asks once per visit, never polls, stays silent when the question
 * fails, and is gone for good once dismissed.
 */
export default function NotificationsHint({
  user,
  placement,
}: {
  user: User;
  placement: "card" | "page";
}) {
  const admin = can(user, "admin");
  const [dismissed, setDismissed] = useState(() => wasDismissed(user));
  const [unset, setUnset] = useState(false);
  useEffect(() => {
    if (!admin || dismissed) return;
    const controller = new AbortController();
    withRequestDeadline(
      (signal) => api<ChannelList>("/notifications/channels", { signal }),
      15000,
      controller.signal,
    )
      .then((list) => {
        if (!controller.signal.aborted) setUnset(list.items.length === 0);
      })
      .catch(() => {
        /* A hint never reports its own failure. */
      });
    return () => controller.abort();
  }, [admin, dismissed, user.id]);
  if (!admin || dismissed || !unset) return null;
  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(storageKey(user), "dismissed");
    } catch {
      /* Hidden for this visit; browser storage may be unavailable. */
    }
  }
  return (
    <div
      className="notifications-hint"
      data-placement={placement}
      role="note"
      aria-label="Notifications"
    >
      <BellOff size={14} aria-hidden="true" />
      <p>
        Nobody is alerted when something here needs attention.{" "}
        <a href="#/notifications">Set up notifications</a>
      </p>
      <button
        type="button"
        className="notifications-hint-dismiss"
        aria-label="Dismiss the notifications tip"
        title="Dismiss"
        onClick={dismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
