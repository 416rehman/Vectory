import { useEffect } from "react";
import { ExternalLink } from "lucide-react";
import { helpHref } from "./DocLink";

/** Preserve old bookmarked routes; normal help links open beside the workspace. */
export default function Documentation({
  topic,
}: {
  topic?: string;
  navigate: (path: string) => void;
}) {
  const [page, section] = (topic || "").split("#");
  const href = helpHref(page, section);
  useEffect(() => {
    window.location.replace(href);
  }, [href]);
  return (
    <p>
      Opening the help center.{" "}
      <a href={href}>
        Continue to documentation{" "}
        <ExternalLink
          className="doc-link-indicator"
          size={12}
          aria-hidden="true"
        />
      </a>
      .
    </p>
  );
}
