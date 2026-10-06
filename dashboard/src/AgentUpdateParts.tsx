import { CopyButton } from "./ui";
import { fingerprintGroups, shortKeyId } from "./releaseKey";
import "./agent-updates.css";

/**
 * A key's fingerprint in groups of eight, for comparing by eye with what a
 * host prints. The first sixteen characters are the key's short ID, set in a
 * heavier weight, because that is what a host and `vectory update status` show.
 */
export function Fingerprint({
  value,
  copy = true,
  label = "Fingerprint",
}: {
  value: string;
  copy?: boolean;
  label?: string;
}) {
  return (
    <div className="update-fingerprint">
      <code aria-label={`${label}: ${fingerprintGroups(value).join(" ")}`}>
        {fingerprintGroups(value).map((group, index) => (
          <span key={index} data-short={index < 2 ? "" : undefined}>
            {group}
          </span>
        ))}
      </code>
      {copy && (
        <CopyButton
          text={value}
          label="Copy"
          ariaLabel={`Copy fingerprint ${shortKeyId(value)}`}
          copiedMessage="Fingerprint copied."
          variant="ghost compact"
        />
      )}
    </div>
  );
}

/** "Pins key 3f9a1c0277de9b41 · kept offline": what a command makes a host trust. */
export function KeyShortId({ value }: { value: string }) {
  return <code className="update-short-id">{shortKeyId(value)}</code>;
}
