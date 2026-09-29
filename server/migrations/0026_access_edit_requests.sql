-- One-shot, actor-scoped identities for administrator account-access edits.
-- An applied row stores only the exact public User snapshot returned at commit.
-- Cancellation fences an absent edit; it cannot roll back an applied edit.
CREATE TABLE access_edit_requests (
 actor_id TEXT NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 user_id TEXT NOT NULL REFERENCES users(id),
 state TEXT NOT NULL CHECK(state IN ('applied','cancelled')),
 user_json TEXT,
 created_at TEXT NOT NULL,
 cancelled_at TEXT,
 PRIMARY KEY(actor_id,request_id),
 CHECK (
  (state='applied' AND user_json IS NOT NULL AND cancelled_at IS NULL) OR
  (state='cancelled' AND user_json IS NULL AND cancelled_at IS NOT NULL)
 )
);
CREATE INDEX access_edit_requests_target ON access_edit_requests(user_id);
