import {
  Component,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { pageFailureKind, type PageFailureKind } from "./pageLoading";
import { Button, Modal } from "./ui";
import "./page-recovery.css";

/**
 * Reload unless an open editor or request vetoes leaving (before-navigate).
 * Returns false when it was vetoed, so the caller can say so.
 */
function guardedReload() {
  if (
    !window.dispatchEvent(
      new Event("vectory:before-navigate", { cancelable: true }),
    )
  )
    return false;
  window.location.reload();
  return true;
}

function PageRecovery({
  kind,
  standalone = false,
}: {
  kind: PageFailureKind;
  /** Nothing else is on screen: no navigation to fall back on. */
  standalone?: boolean;
}) {
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
      setCanceled(!guardedReload());
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
      {!standalone && (
        <p className="page-recovery-hint">
          You can still use the navigation to open another page.
        </p>
      )}
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

/**
 * Catch page render/import faults while keeping the surrounding shell usable.
 * `standalone` wraps the whole signed-in app: its recovery fills the window.
 */
export default class PageBoundary extends Component<
  {
    resetKey: string;
    children: ReactNode;
    standalone?: boolean;
  },
  { failure: PageFailureKind | null }
> {
  state: { failure: PageFailureKind | null } = { failure: null };
  static getDerivedStateFromError(error: unknown) {
    return { failure: pageFailureKind(error) };
  }
  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    // Do not key/remount healthy pages when only their query changes: an editor
    // may still have unsaved work. A failed page can reset on deliberate routing.
    if (previous.resetKey !== this.props.resetKey && this.state.failure)
      this.setState({ failure: null });
  }
  render() {
    if (!this.state.failure) return this.props.children;
    return this.props.standalone ? (
      <main className="app-loading">
        <PageRecovery kind={this.state.failure} standalone />
      </main>
    ) : (
      <PageRecovery kind={this.state.failure} />
    );
  }
}

/**
 * Catches a lazily loaded part of a page (a dialog, a form section) that fails
 * to download or render, and shows `fallback` in its place: the page stays.
 */
export class ChunkBoundary extends Component<
  { children: ReactNode; fallback: (kind: PageFailureKind) => ReactNode },
  { failure: PageFailureKind | null }
> {
  state: { failure: PageFailureKind | null } = { failure: null };
  static getDerivedStateFromError(error: unknown) {
    return { failure: pageFailureKind(error) };
  }
  render() {
    return this.state.failure
      ? this.props.fallback(this.state.failure)
      : this.props.children;
  }
}

/** A dialog whose files didn't load, or that broke: close it, or reload. */
export function DialogRecovery({
  kind,
  onClose,
}: {
  kind: PageFailureKind;
  onClose: () => void;
}) {
  const [canceled, setCanceled] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={
        kind === "timeout"
          ? "This dialog is taking too long"
          : kind === "load"
            ? "This dialog couldn’t load"
            : "This dialog stopped working"
      }
      description={
        kind === "render"
          ? "An unexpected problem interrupted it. Nothing was sent. Close it and try again, or reload the page."
          : "Its files didn’t finish loading, so nothing was sent. Check your connection, then reload the page."
      }
    >
      {canceled && (
        <div className="modal-body">
          <p className="page-recovery-canceled" role="status">
            Reload was canceled. Finish or save any work still open before
            trying again.
          </p>
        </div>
      )}
      <div className="modal-footer">
        <Button
          variant="secondary"
          icon={RefreshCw}
          onClick={() => setCanceled(!guardedReload())}
        >
          Reload page
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

/**
 * While a dialog's files download: nothing for a moment (a quick load never
 * flashes), then a small "Opening…" so a click visibly did something.
 */
export function DialogLoading() {
  return (
    <div className="dialog-loading" role="status">
      <LoaderCircle className="spin" size={15} aria-hidden="true" />
      <span>Opening…</span>
    </div>
  );
}
