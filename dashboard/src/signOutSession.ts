export type SignOutIntent = {
  userId: string;
  csrfToken: string;
  csrfVersion: number;
  epoch: number;
};

export type SignOutContext = SignOutIntent & {
  enabled: boolean;
  valid: boolean;
};

export function matchesSignOutContext(
  intent: SignOutIntent,
  current: SignOutContext,
) {
  return (
    current.valid &&
    current.enabled &&
    !!intent.csrfToken &&
    intent.userId === current.userId &&
    intent.csrfToken === current.csrfToken &&
    intent.csrfVersion === current.csrfVersion &&
    intent.epoch === current.epoch
  );
}

export function matchesSignOutSession(
  intent: SignOutIntent,
  session: { user: { id: string; enabled: boolean }; csrf_token: string },
) {
  // A second sign-in by the same person is still a different session.
  return (
    session.user.enabled &&
    !!intent.csrfToken &&
    session.user.id === intent.userId &&
    session.csrf_token === intent.csrfToken
  );
}

let signingOut = false;
/** Whether this tab is deliberately signing out right now. */
export function isSigningOut() {
  return signingOut;
}
/**
 * While a deliberate sign-out runs, an ended session is the expected outcome,
 * so the re-sign-in dialog stays out of the way.
 */
export function setSigningOut(active: boolean) {
  if (signingOut === active) return;
  signingOut = active;
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("vectory:sign-out-activity"));
}
