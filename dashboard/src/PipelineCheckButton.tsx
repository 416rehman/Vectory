import * as Popover from "@radix-ui/react-popover";
import { CircleAlert, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { useHoverDisclosure } from "./useHoverDisclosure";

type CheckResult = {
  valid: boolean;
  vector_validated: boolean;
  errors: string[];
  warnings: string[];
};

export default function PipelineCheckButton({
  state,
  description,
  feedbackId,
  result,
  checking,
  disabled,
  hidden,
  onCheck,
}: {
  state: "neutral" | "checking" | "passed" | "partial" | "failed" | "stale";
  description: string;
  feedbackId: string;
  result: CheckResult | null;
  checking: boolean;
  disabled: boolean;
  hidden: boolean;
  onCheck: () => void;
}) {
  const help = useHoverDisclosure();
  const restoreKeyboardFocus = useRef(false);
  const wasChecking = useRef(false);
  useEffect(() => {
    if (!checking) return;
    // Do not take focus back if the user deliberately moved on while checking.
    const cancel = () => {
      restoreKeyboardFocus.current = false;
    };
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
    };
  }, [checking]);
  useEffect(() => {
    const completed = wasChecking.current && !checking;
    wasChecking.current = checking;
    if (!completed) return;
    const restore = restoreKeyboardFocus.current;
    restoreKeyboardFocus.current = false;
    // Validation temporarily makes the workspace inert. Restore keyboard
    // focus only when that operation caused the blur, never after a mouse tap.
    if (
      restore &&
      !disabled &&
      !hidden &&
      document.activeElement === document.body
    )
      help.triggerRef.current?.focus({ preventScroll: true });
  }, [checking, disabled, hidden, help.triggerRef]);
  useEffect(() => {
    if (hidden) help.close();
  }, [hidden, help.close]);
  const Icon =
    state === "checking"
      ? LoaderCircle
      : state === "failed"
        ? CircleX
        : state === "stale" || state === "partial"
          ? CircleAlert
          : CircleCheck;
  const title = result
    ? result.valid
      ? result.vector_validated
        ? result.warnings.length
          ? "Checks passed with warnings"
          : "Vector checks passed"
        : "Device validation pending"
      : "Pipeline needs attention"
    : state === "checking"
      ? "Checking pipeline…"
      : "Check pipeline";
  return (
    <>
      <Popover.Root
        open={help.open && !hidden}
        onOpenChange={help.onOpenChange}
      >
        <Popover.Trigger asChild>
          <button
            {...help.triggerProps}
            ref={help.triggerRef}
            type="button"
            className="icon-button editor-check-button"
            aria-label="Check pipeline"
            aria-describedby={feedbackId}
            aria-busy={checking || undefined}
            data-check-state={state}
            disabled={disabled}
            onClick={(event) => {
              restoreKeyboardFocus.current =
                event.detail === 0 &&
                !(event.nativeEvent as PointerEvent).pointerType;
              help.triggerProps.onClick(event);
              onCheck();
            }}
          >
            <Icon size={17} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            {...help.contentProps}
            ref={help.contentRef}
            className="editor-checks-popover"
            aria-label="Pipeline check results"
            side="bottom"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            tabIndex={-1}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onEscapeKeyDown={help.onEscapeKeyDown}
          >
            <strong>{title}</strong>
            {!result && (
              <p>
                {state === "neutral"
                  ? "Run checks for the current pipeline."
                  : description}
              </p>
            )}
            {result?.valid && !result.vector_validated && (
              <p>
                No errors were found in the checks available here. Each device
                validates the full configuration before applying it.
              </p>
            )}
            {result?.valid && result.vector_validated && (
              <p>
                Configuration checks passed. Devices verify their local
                environment and permissions before applying the pipeline.
              </p>
            )}
            {!!result?.errors?.length && (
              <ul>
                {result.errors.map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
              </ul>
            )}
            {result?.warnings?.map((message, index) => (
              <p key={index}>{message}</p>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <span id={feedbackId} className="sr-only" aria-live="polite">
        {description}
      </span>
    </>
  );
}
