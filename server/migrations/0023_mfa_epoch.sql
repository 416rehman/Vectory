-- Internal generation for MFA lifecycle changes. It is deliberately separate
-- from the public account revision used by account-edit forms.
ALTER TABLE users ADD COLUMN mfa_epoch INTEGER NOT NULL DEFAULT 0;
