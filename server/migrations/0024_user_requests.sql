-- A one-shot, actor-scoped identity for administrator account creation.
-- The submitted password and any password-derived material are never retained
-- here. A cancelled identity fences a delayed create under the writer lock.
CREATE TABLE user_requests (
 actor_id TEXT NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 state TEXT NOT NULL CHECK(state IN ('created','cancelled')),
 user_id TEXT REFERENCES users(id),
 created_at TEXT NOT NULL,
 cancelled_at TEXT,
 PRIMARY KEY(actor_id,request_id),
 CHECK (
  (state='created' AND user_id IS NOT NULL AND cancelled_at IS NULL) OR
  (state='cancelled' AND user_id IS NULL AND cancelled_at IS NOT NULL)
 )
);
