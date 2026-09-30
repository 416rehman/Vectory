import { useId, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";

/** The Overview's card: a titled section with an optional action. */
export function Card({
  title,
  subtitle,
  action,
  className = "",
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      className={`overview-card ${className}`.trim()}
      aria-labelledby={id}
    >
      <div className="overview-card-head">
        <div className="overview-card-titles">
          <h2 id={id}>{title}</h2>
          {subtitle && <p className="overview-card-subtitle">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function CardLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="overview-card-link" href={href}>
      {children}
      <ArrowRight size={14} aria-hidden="true" />
    </a>
  );
}
