-- Keep the actor/request identity namespace shared across deployment operations.
-- Historical mappings remain create operations with the original v1 digest.
ALTER TABLE deployment_requests ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'create'
 CHECK(operation_kind IN ('create','rollback'));
ALTER TABLE deployment_requests ADD COLUMN source_deployment_id TEXT
 CHECK((operation_kind='create' AND source_deployment_id IS NULL)
    OR (operation_kind='rollback' AND source_deployment_id IS NOT NULL AND length(source_deployment_id)=36));
