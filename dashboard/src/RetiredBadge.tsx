import type { ReactNode } from "react";
import { StatusBadge } from "./ui";
import "./retired-badge.css";

/**
 * Beside a device's own name when the record is a retired identity: a
 * recovery replaced it, and the record stays for history.
 */
export function RetiredBadge() {
  return (
    <StatusBadge
      tone="neutral"
      icon="ban"
      label="Retired identity"
      description="A recovery replaced this identity. Its record stays for history."
      className="retired-badge"
    />
  );
}

/**
 * A retired identity's name (usually a link) with its badge on the same line
 * while there is room, and under the name when there is not.
 */
export function RetiredName({ children }: { children: ReactNode }) {
  return (
    <span className="retired-name">
      {children}
      <RetiredBadge />
    </span>
  );
}
