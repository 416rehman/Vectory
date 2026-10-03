import { CopyButton } from "./ui";
import "./agent-updates.css";

/**
 * A command to run on a host, in a block that scrolls inside itself (a line is
 * never broken at a flag) with its own copy button. `label` names it for
 * assistive technology, and says which host it is for when there are several.
 */
export function CommandBlock({
  command,
  label,
  heading,
}: {
  command: string;
  /** "Upgrade command for edge-02". */
  label: string;
  /** A visible line above it, such as "On edge-01, edge-02". */
  heading?: string;
}) {
  return (
    <div className="update-command">
      {heading && <span className="update-command-heading">{heading}</span>}
      <div className="update-command-body">
        <pre tabIndex={0} aria-label={label}>
          <code>{command}</code>
        </pre>
        <CopyButton
          text={command}
          ariaLabel={`Copy ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
          copiedMessage={`${label} copied.`}
        />
      </div>
    </div>
  );
}
