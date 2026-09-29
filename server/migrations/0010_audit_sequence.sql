-- Existing same-second audit records have no explicit sequence. Their current
-- rowid is the best available historical insertion-order approximation; use it
-- only for this one-time backfill. The INTEGER PRIMARY KEY below is persistent
-- across VACUUM and physical backup/restore, unlike an unaliased hidden rowid.
CREATE TABLE audit_sequence (
    sequence INTEGER PRIMARY KEY,
    audit_id TEXT NOT NULL UNIQUE
);
INSERT INTO audit_sequence(audit_id)
SELECT id FROM records WHERE kind='audit' ORDER BY created_at ASC,rowid ASC;
CREATE TRIGGER audit_sequence_insert AFTER INSERT ON records
WHEN new.kind='audit' BEGIN
    INSERT INTO audit_sequence(audit_id) VALUES(new.id);
END;
