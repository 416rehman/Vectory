export type PageFailureKind = "load" | "timeout" | "render";

export class PageLoadError extends Error {
  constructor(public readonly kind: "load" | "timeout") {
    super(
      kind === "timeout"
        ? "Page loading timed out."
        : "Page files could not be loaded.",
    );
    this.name = "PageLoadError";
  }
}

export function pageFailureKind(error: unknown): PageFailureKind {
  // An arbitrary rendering error or server message must not impersonate a
  // failed import. Never place its raw message, payload or stack in the UI.
  return error instanceof PageLoadError ? error.kind : "render";
}

/** Dynamic imports cannot be aborted. Retire the wait and consume late results. */
export function loadPage<T>(
  loader: () => Promise<T>,
  timeoutMs = 30000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new PageLoadError("timeout"));
    }, timeoutMs);
    Promise.resolve()
      .then(loader)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new PageLoadError("load"));
        },
      );
  });
}
