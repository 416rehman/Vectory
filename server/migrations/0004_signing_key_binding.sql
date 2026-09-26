ALTER TABLE credentials ADD COLUMN signing_key_id TEXT;
CREATE INDEX credential_signing_key ON credentials(signing_key_id,expires_at,revoked);
