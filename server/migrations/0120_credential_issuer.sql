-- The device CA that issued each credential: the SHA-256 of the CA
-- certificate's DER. A CA replaced by `vectory-admin rotate-device-ca` is
-- retired only once no active device still holds a certificate it issued.
-- Credentials issued before this column stay NULL and count as the previous
-- CA's until they expire or their device renews onto the new one.
ALTER TABLE credentials ADD COLUMN ca_id TEXT;
CREATE INDEX credentials_ca ON credentials(ca_id,expires_at);
