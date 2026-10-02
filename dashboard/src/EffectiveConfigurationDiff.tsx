import { useState } from "react";
import { Info } from "lucide-react";
import type { DeviceConfigurationDiff } from "./api";
import { CopyButton } from "./ui";
import {
  changesHeading,
  countsSentence,
  hunkTitle,
} from "./effectiveConfigurationModel";

/** Lines drawn before the first "Show more", and with each one. */
const FIRST_LINES = 160;
const MORE_LINES = 240;

const MARKS = {
  context: { mark: " ", word: "Unchanged" },
  removed: { mark: "−", word: "Removed" },
  added: { mark: "+", word: "Added" },
} as const;

/**
 * The comparison of two offered generations: what changed in numbers, then
 * the changed lines in their hunks, each named by the components around it.
 * It draws a screenful at a time, since a diff can run to 2,000 lines.
 */
export default function EffectiveConfigurationDiff({
  diff,
}: {
  diff: DeviceConfigurationDiff;
}) {
  const [shown, setShown] = useState(FIRST_LINES);
  const total = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  let budget = shown;
  const heading = changesHeading(diff.from?.generation ?? null, diff);
  const summary = countsSentence(diff.counts);

  if (!diff.from)
    return (
      <p className="effective-config-note">
        This is the first configuration offered to this device. There is nothing
        earlier to compare it with.
      </p>
    );
  if (diff.identical)
    return (
      <p className="effective-config-note">
        <strong>No changes.</strong> Generation {diff.to.generation} is the same
        text as generation {diff.from.generation}. A retry, or a version that
        only moved components on the canvas, offers the same text again.
      </p>
    );

  return (
    <div className="effective-config-changes">
      <div className="effective-config-changes-head">
        <div>
          <h3>{heading}</h3>
          <p
            className="effective-config-counts"
            aria-label={`${summary} between generation ${diff.from.generation} and generation ${diff.to.generation}`}
          >
            {(
              [
                ["added", diff.counts.added, "+"],
                ["removed", diff.counts.removed, "−"],
                ["changed", diff.counts.changed, "~"],
              ] as const
            )
              .filter(([, count]) => count > 0)
              .map(([kind, count, mark]) => (
                <span key={kind} data-kind={kind}>
                  <span aria-hidden="true">{mark}</span>{" "}
                  {count.toLocaleString()} {kind}
                </span>
              ))}
          </p>
        </div>
        <CopyButton
          text={diff.unified}
          label="Copy diff"
          ariaLabel={`Copy the diff from generation ${diff.from.generation} to generation ${diff.to.generation}`}
          copiedMessage="Copied the diff."
        />
      </div>
      {diff.approximate && (
        <p className="effective-config-banner" data-tone="info" role="note">
          <Info size={15} aria-hidden="true" />
          <span>
            This change is too large to match line by line, so the region that
            changed is shown as removed and added, including some lines that are
            the same on both sides.
          </span>
        </p>
      )}
      {diff.hunks.map((hunk, index) => {
        if (budget <= 0) return null;
        const lines = hunk.lines.slice(0, budget);
        budget -= lines.length;
        const title = hunkTitle(hunk);
        return (
          <section
            key={`${hunk.old_start}:${hunk.new_start}:${index}`}
            className="effective-config-hunk"
            aria-label={`${title.where}, ${title.lines}`}
          >
            <header>
              <code>{title.where}</code>
              <span>{title.lines}</span>
            </header>
            <ol>
              {lines.map((line, row) => {
                // A removed line has only its old number; the others have a new one.
                const at = line.new_line ?? line.old_line;
                return (
                  <li key={row} data-kind={line.kind}>
                    <span
                      className="effective-config-line-number"
                      aria-hidden="true"
                    >
                      {line.old_line}
                    </span>
                    <span
                      className="effective-config-line-number"
                      aria-hidden="true"
                    >
                      {line.new_line}
                    </span>
                    <span className="effective-config-mark" aria-hidden="true">
                      {MARKS[line.kind].mark}
                    </span>
                    <span className="sr-only">
                      {MARKS[line.kind].word}
                      {at ? `, line ${at}: ` : ": "}
                    </span>
                    <code>{line.text || " "}</code>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
      <div className="effective-config-more">
        <span>
          {Math.min(shown, total).toLocaleString()} of {total.toLocaleString()}{" "}
          lines shown
          {diff.truncated &&
            `, the first part of ${diff.total_lines.toLocaleString()}`}
        </span>
        {shown < total && (
          <button
            type="button"
            className="button ghost compact"
            onClick={() => setShown((value) => value + MORE_LINES)}
          >
            Show {Math.min(MORE_LINES, total - shown).toLocaleString()} more
            lines
          </button>
        )}
      </div>
      {diff.truncated && (
        <p className="effective-config-banner" data-tone="info" role="note">
          <Info size={15} aria-hidden="true" />
          <span>
            Only the first {total.toLocaleString()} lines of the diff are shown;
            the counts above cover the whole change. Download both generations
            to compare them in full.
          </span>
        </p>
      )}
    </div>
  );
}
