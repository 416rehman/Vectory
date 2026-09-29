import type { ReactNode } from "react";
import { CircleHelp, ExternalLink } from "lucide-react";
import "./help-link.css";

export type DocTopic =
  | "getting-started"
  | "installation"
  | "pipelines"
  | "deployments"
  | "telemetry"
  | "notifications"
  | "resources"
  | "glossary"
  | "troubleshooting"
  | "administer"
  | "compatibility"
  | "api";

export type HelpDescriptor = {
  topic: DocTopic;
  section?: string;
  label?: string;
};

type HelpLinkProps = {
  label: string;
  className?: string;
} & (
  | { topic: DocTopic; section?: string; href?: never }
  | { href: string; topic?: never; section?: never }
);

/** A page or panel's single help action; terminology links remain text. */
export function HelpLink({
  topic,
  section,
  href,
  label,
  className = "",
}: HelpLinkProps) {
  const accessibleLabel = `${label} (opens in a new tab)`;
  return (
    <a
      className={`page-help-link ${className}`.trim()}
      href={href ?? helpHref(topic, section)}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      target="_blank"
      rel="noopener noreferrer"
    >
      <CircleHelp size={17} aria-hidden="true" focusable="false" />
    </a>
  );
}

export function helpHref(topic = "", section?: string) {
  const pipeline =
    typeof window === "undefined"
      ? undefined
      : window.location.hash.match(
          /^#\/configurations\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:\?|$)/i,
        )?.[1];
  return `/help/${topic ? encodeURIComponent(topic) + "/" : ""}${pipeline ? `?pipeline=${encodeURIComponent(pipeline)}` : ""}${section ? "#" + encodeURIComponent(section) : ""}`;
}

/** Help opens alongside the editor so even an invalid local draft stays intact. */
export default function DocLink({
  topic,
  section,
  children,
  className = "doc-term-link",
}: {
  topic: DocTopic;
  section?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      className={className}
      href={helpHref(topic, section)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ExternalLink
        className="doc-link-indicator"
        size={12}
        aria-hidden="true"
        focusable="false"
      />
      <span className="sr-only"> (opens help in a new tab)</span>
    </a>
  );
}

export function ExternalDocLink({
  href,
  children,
  className = "doc-term-link",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ExternalLink
        className="doc-link-indicator"
        size={12}
        aria-hidden="true"
        focusable="false"
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
