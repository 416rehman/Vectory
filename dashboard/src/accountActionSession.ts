export type AccountActionContext = {
  userId: string;
  enabled: boolean;
  csrfToken: string;
  csrfVersion: number;
  epoch: number;
  valid: boolean;
};

/** Also compares invalid contexts so an explicit, guarded departure can work. */
export function sameAccountActionContext(
  before: AccountActionContext,
  current: AccountActionContext,
) {
  return (
    before.userId === current.userId &&
    before.enabled === current.enabled &&
    before.csrfToken === current.csrfToken &&
    before.csrfVersion === current.csrfVersion &&
    before.epoch === current.epoch &&
    before.valid === current.valid
  );
}

export function canUseAccountActionContext(
  original: AccountActionContext,
  current: AccountActionContext,
) {
  return (
    original.enabled &&
    original.valid &&
    !!original.csrfToken &&
    sameAccountActionContext(original, current)
  );
}

export function matchesPasswordChangeReceipt(
  original: AccountActionContext,
  session: { user: { id: string; enabled: boolean }; csrf_token: string },
) {
  // A successful password change creates a new session for the same account.
  // Revision arithmetic cannot identify it: unrelated name edits may coexist.
  return (
    session.user.enabled &&
    session.user.id === original.userId &&
    !!session.csrf_token &&
    session.csrf_token !== original.csrfToken
  );
}
