# ADR 0006: What the artifact SHA-256 covers

Proposed 2026-09-29. This records the digest definition in `contracts/CONTRACT.md` as implemented at commit `a469266`; no one has reviewed or accepted it yet.

## Context

The specification (section 5, line 132) asks for a SHA-256 over precisely defined artifact bytes, canvas layout outside the hash, a distinct digest when device variables change the artifact, and separate meanings for the template identity, the delivered artifact and the actual managed file.

## Decision

- The artifact is the configuration rendered by `validation::render` in `server/src/validation.rs`: pretty-printed JSON with object keys in sorted order (the default `serde_json` map), plus one trailing newline.
- Its digest is the lowercase hexadecimal SHA-256 of those exact UTF-8 bytes (`db::hash`), and its size is their length. Publishing stores the bytes, digest and size in the immutable version record.
- The graph (canvas positions and presentation) is stored beside the configuration and never enters the bytes.
- When a deployment binds version variables per device, the server renders a device-specific artifact (`server/src/variables.rs`). The signed manifest carries that artifact's digest and size, while `version_id` stays the template identity.
- The agent keeps three digests apart: the template digest it applied (`applied_template_sha256`), the effective digest after it substitutes local secrets, and the digest of the managed file on disk (`actual_sha256`), which it recomputes before each reconciliation.

## Consequences

- The same configuration always has the same digest, and moving a node cannot change it. No test proves the second point yet.
- Stored versions keep their exact bytes, so a later change to `render` changes only newly rendered artifacts. Such a change must be treated as a protocol change, because agents compare digests.
- A version that uses device secrets is verified by its template digest, its generation and a higher secret revision, not by comparing the effective digest with the template.
