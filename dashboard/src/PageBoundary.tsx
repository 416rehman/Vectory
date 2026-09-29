import {
  Component,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleAlert, ExternalLink, RefreshCw } from "lucide-react";
import { pageFailureKind, type PageFailureKind } from "./pageLoading";
import { Button } from "./ui";
import "./page-recovery.css";

function PageRecovery({ kind }: { kind: PageFailureKind }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [canceled, setCanceled] = useState(false);
  const claimed = useRef(false);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  function reload() {
    if (claimed.current) return;
    claimed.current = true;
    try {
      if (
        !window.dispatchEvent(
          new Event("vectory:before-navigate", { cancelable: true }),
        )
      ) {
        setCanceled(true);
        return;
      }
      setCanceled(false);
      window.location.reload();
    } finally {
      // Navigation has no awaitable completion, and a native beforeunload
      // prompt may cancel it. Keep Reload available if this page remains open.
      claimed.current = false;
    }
  }
  return (
    <section className="page-recovery" aria-labelledby={titleId}>
      <span className="page-recovery-icon">
        <CircleAlert size={24} aria-hidden="true" />
      </span>
      <h1 id={titleId} ref={heading} tabIndex={-1}>
        {kind === "timeout"
          ? "This page is taking too long"
          : kind === "load"
            ? "This page couldn’t load"
            : "This page stopped working"}
      </h1>
      <p>
        {kind === "render"
          ? "An unexpected problem interrupted this page. Unsaved changes on it may no longer be available. Reload to reopen your saved data."
          : "The page files didn’t finish loading. Your connection may have been interrupted, or this tab may be using an older version of Vectory. Check your connection, then reload."}
      </p>
      <p className="page-recovery-hint">
        You can still use the navigation to open another page.
      </p>
      <div className="page-recovery-actions">
        <Button icon={RefreshCw} onClick={reload}>
          Reload page
        </Button>
        <a
          href="/help/troubleshooting/#a-page-is-blank-or-cannot-load"
          target="_blank"
          rel="noopener noreferrer"
        >
          Troubleshooting <ExternalLink size={14} aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      {canceled && (
        <p className="page-recovery-canceled" role="status">
          Reload was canceled. Finish or save any work still open before trying
          again.
        </p>
      )}
    </section>
  );
}

/** Catch page render/import faults while keeping the surrounding shell usable. */
export default class PageBoundary extends Component<
  {
    resetKey: string;
    children: ReactNode;
  },
  { failure: PageFailureKind | null }
> {
  state: { failure: PageFailureKind | null } = { failure: null };
  static getDerivedStateFromError(error: unknown) {
    return { failure: pageFailureKind(error) };
  }
  componentDidUpdate(
    previous: Readonly<{ resetKey: string; children: ReactNode }>,
  ) {
    // Do not key/remount healthy pages when only their query changes: an editor
    // may still have unsaved work. A failed page can reset on deliberate routing.
    if (previous.resetKey !== this.props.resetKey && this.state.failure)
      this.setState({ failure: null });
  }
  render() {
    return this.state.failure ? (
      <PageRecovery kind={this.state.failure} />
    ) : (
      this.props.children
    );
  }
}
