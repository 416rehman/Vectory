-- Retain operation keys indefinitely. These covering order prefixes make
-- account-scoped discovery bounded without scanning other actors' requests.
CREATE INDEX deployment_requests_recent
 ON deployment_requests(actor_id,created_at DESC,request_id DESC);
CREATE INDEX deployment_requests_operation_recent
 ON deployment_requests(actor_id,operation_kind,created_at DESC,request_id DESC);
