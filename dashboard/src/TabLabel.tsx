import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import "./tab-label.css";

export default function TabLabel({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span className="tab-label">
      <Icon size={16} aria-hidden="true" focusable="false" />
      <span>{children}</span>
    </span>
  );
}
