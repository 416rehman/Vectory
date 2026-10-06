/** Vector writes option, function and value names in backticks. */
export default function ProblemText({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`\n]+`)/)
        .map((part, index) =>
          part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
            <code key={index}>{part.slice(1, -1)}</code>
          ) : (
            part
          ),
        )}
    </>
  );
}
