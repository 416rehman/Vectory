-- Keep the durable audit ordinal while indexing the existing time/ordinal order.
ALTER TABLE audit_sequence ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
UPDATE audit_sequence SET created_at=(SELECT created_at FROM records WHERE kind='audit' AND id=audit_id);
DROP TRIGGER audit_sequence_insert;
CREATE TRIGGER audit_sequence_insert AFTER INSERT ON records
WHEN new.kind='audit' BEGIN
    INSERT INTO audit_sequence(audit_id,created_at) VALUES(new.id,new.created_at);
END;
CREATE INDEX audit_sequence_recent ON audit_sequence(created_at DESC,sequence DESC);
CREATE INDEX audit_actor ON records(json_extract(data,'$.actor')) WHERE kind='audit';
CREATE INDEX audit_target ON records(json_extract(data,'$.target')) WHERE kind='audit';
CREATE INDEX audit_device ON records(json_extract(data,'$.device_id')) WHERE kind='audit';
CREATE INDEX audit_action_outcome ON records(json_extract(data,'$.action'),json_extract(data,'$.outcome')) WHERE kind='audit';
