package agent

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

// This file stands in for the release library (release.go and release_keys.go)
// until it is merged, and carries only the names the update files use:
// UpdateRefusal, ReleaseKey and RolloverEnvelope. The merge deletes it. A key is
// checked for its shape here, not for being a point of the curve.

// UpdateRefusal is a refusal to take an agent update, with one of the agent
// codes of the contract and a sentence for people that says what was found.
type UpdateRefusal struct {
	Code   string
	Detail string
	// From and Successors are set only with KEY_ROLLOVER_CONFLICT.
	From       string
	Successors []string
}

func (e *UpdateRefusal) Error() string {
	if e.Detail == "" {
		return e.Code
	}
	return e.Code + ": " + e.Detail
}

// ReleaseKey is a public key that verifies agent releases.
type ReleaseKey struct {
	raw   [ed25519.PublicKeySize]byte
	name  string
	valid bool
}

const releaseKeyPrefix = "vectory-release-key ed25519 "

// ParseReleaseKey parses a public key line.
func ParseReleaseKey(line string) (ReleaseKey, error) {
	invalid := func(why string) (ReleaseKey, error) {
		return ReleaseKey{}, &UpdateRefusal{Code: "RELEASE_KEY_INVALID", Detail: why}
	}
	rest, ok := strings.CutPrefix(line, releaseKeyPrefix)
	if !ok {
		return invalid("a release key starts with vectory-release-key ed25519")
	}
	encoded, name, found := strings.Cut(rest, " ")
	if !found || name == "" || len(name) > 64 || name[0] == ' ' || name[len(name)-1] == ' ' {
		return invalid("the key has no usable name after it")
	}
	for i := 0; i < len(name); i++ {
		if name[i] < 0x20 || name[i] > 0x7e || name[i] == '"' || name[i] == '\\' {
			return invalid("the key's name must be printable ASCII without a quotation mark or a backslash")
		}
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(raw) != ed25519.PublicKeySize || base64.StdEncoding.EncodeToString(raw) != encoded {
		return invalid("the key isn't the canonical base64 of 32 bytes")
	}
	key := ReleaseKey{name: name, valid: true}
	copy(key.raw[:], raw)
	return key, nil
}

// Fingerprint is the lowercase hex SHA-256 of the 32 raw bytes.
func (k ReleaseKey) Fingerprint() string {
	if !k.valid {
		return ""
	}
	sum := sha256.Sum256(k.raw[:])
	return hex.EncodeToString(sum[:])
}

// ShortID is the first 16 characters of the fingerprint.
func (k ReleaseKey) ShortID() string {
	if fingerprint := k.Fingerprint(); fingerprint != "" {
		return fingerprint[:16]
	}
	return ""
}

// Line is the key as one line of text.
func (k ReleaseKey) Line() string {
	if !k.valid {
		return ""
	}
	return fmt.Sprintf("%s%s %s", releaseKeyPrefix, base64.StdEncoding.EncodeToString(k.raw[:]), k.name)
}

// Name is the display name on the key's line.
func (k ReleaseKey) Name() string { return k.name }

// IsZero reports whether k is the zero value, which is not a key.
func (k ReleaseKey) IsZero() bool { return !k.valid }

// RolloverEnvelope is a rollover statement and its signature as they travel:
// the base64 of the statement's bytes and of its 64-byte signature.
type RolloverEnvelope struct {
	Statement string `json:"statement"`
	Signature string `json:"signature"`
}
