/** Same-origin API reference execution never forwards session credentials. */
export async function scalarFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(
    input instanceof Request
      ? input
      : new URL(String(input), window.location.origin),
    init,
  );
  const url = new URL(request.url);
  if (
    url.origin !== window.location.origin ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/api/v1/")
  ) {
    throw new Error(
      "The API reference executes only this instance's /api/v1 requests. Agent endpoints require the CLI and device mTLS.",
    );
  }
  const headers = new Headers(request.headers);
  headers.delete("X-CSRF-Token");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    const session = await fetch("/api/v1/session", {
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: request.signal,
    });
    if (!session.ok)
      throw new Error("Sign in to Vectory before sending an API mutation.");
    const value: unknown = await session.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("csrf_token" in value) ||
      typeof value.csrf_token !== "string" ||
      !value.csrf_token
    )
      throw new Error("The current session did not provide a CSRF token.");
    headers.set("X-CSRF-Token", value.csrf_token);
  }
  return fetch(
    new Request(request, {
      headers,
      credentials: "same-origin",
      redirect: "error",
    }),
  );
}
