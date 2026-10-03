# Agent release vectors

Shared test data for agent updates. The Rust server and the Go agent each implement the rules of the [Agent updates](../../CONTRACT.md#agent-updates) section of the contract, and both run every case in this directory, so a byte string that one accepts and the other refuses fails a test instead of reaching a host. The files are written by a third implementation, `rules.mjs`, with nothing but Node's own crypto, and checked in.

Every key here is a published test key: its seed is in `vectors.json`. Never pin one on a real host.

| File | What it holds |
| --- | --- |
| `vectors.json` | The test keys, the key-line cases, the key-bundle cases and the release cases |
| `report.json` | The bounds of the heartbeat member `agent_update`, and members the server accepts and refuses |
| `examples/` | One file for each format the contract quotes (`release.json`, `status.json`, ...), word for word |
| `generate.mjs` | Writes all of the above; `--check` fails when a file differs |
| `rules.mjs`, `cases.mjs`, `examples.mjs` | The reference rules, the cases with their expected answers, and the examples |

## Reading the files

- Rust, in `server/src/agent_release.rs` (and the report parser): `include_str!("../../contracts/fixtures/agent-release/vectors.json")` and `.../report.json`, as the tests for `vector-catalog/fixtures/report-bounds.json` do.
- Go, in `agent/internal/agent`: `repoFile(t, "contracts/fixtures/agent-release/vectors.json")` and `.../report.json`.

Both read every case and every key line, and require exactly the answer in the file: the result, the code, the signer, the pins and floors after, and the successors of a fork. A case that needs different code in one language to agree is a defect in one of the implementations or in the contract.

## `vectors.json`

```text
{ schema, about, keys, key_lines, bundles, cases }
```

- `keys`: `{name, seed_hex, public_key_line, fingerprint}`. The seed is 32 bytes of hex; the private key is the Ed25519 key of that seed, and the line and the fingerprint (the hex SHA-256 of the 32 public bytes) follow from it. Cases refer to keys by fingerprint.
- `key_lines`: `{name, about, line, expect}` where `expect` is `{result:"valid", fingerprint, name}` or `{result:"refused", code:"RELEASE_KEY_INVALID"}`. Run the key rule of the contract on `line`. The cases include the eight canonical encodings of the points of order 1, 2, 4 and 8, non-canonical encodings (`y` equal to the field prime or above it, among them the alias `y + p` of a point of large order, and a set sign bit on a point whose `x` is 0), and bytes that are not on the curve.
- `bundles`: `{name, about, bundle_b64, fingerprint, expect}`. What setup does with the bytes of `GET /agent/v1/release-keys` and the fingerprint the operator typed: compute each entry's fingerprint from its key bytes, ignore the `fingerprint` member for matching, refuse the whole bundle when a member disagrees with its key (`{result:"refused", code:"RELEASE_KEY_INVALID"}`), and otherwise pin the entry found (`{result:"valid", public_key}`) or find none (`{result:"absent"}`). Members setup does not know are ignored.
- `cases`: one offered release and what a host decides.

A case:

| Member | Meaning |
| --- | --- |
| `name`, `about` | What the case shows |
| `manifest_b64` | The exact bytes of `release.json`, as delivered |
| `signatures_b64` | The exact bytes of `release.json.sig`, as delivered |
| `rollovers` | The offer's envelopes in order, `{statement_b64, signature_b64}` (the contract's `{statement, signature}` on the wire) |
| `pins` | The fingerprints the host pins, sorted |
| `floors` | Fingerprint to the highest counter the host *attempted* from that key |
| `running_version`, `os`, `arch` | The host's agent version and platform |
| `track` | `patch` or `minor` |
| `service_definition` | The host's service definition generation |
| `now` | The host's clock, a UTC instant |
| `last` | The host's last result, `{release, outcome}` with the manifest SHA-256, or null |
| `expect` | `{result:"valid", signer, pins_after, floors_after}` or `{result:"refused", code}`; a fork adds `rollover_conflict:{from, to:[a, b]}` with the two successors in ascending order |

Decide the case with the order of the contract's [verification](../../CONTRACT.md#verification-and-the-signed-messages): the offer's shape (more than 8 envelopes), the signature file, the rollover chain (a fork is `KEY_ROLLOVER_CONFLICT`), the pins (`KEY_NOT_PINNED`), the signatures (`SIGNATURE_INVALID`), the manifest (`MANIFEST_INVALID`, an `issued_at` more than 24 hours ahead included), expiry (`MANIFEST_EXPIRED`, at `expires_at` itself), the platform, the counters (`RELEASE_ALREADY_TRIED` when `last` names this manifest, by its SHA-256, as `rolled_back` and `COUNTER_REPLAYED` otherwise, for any verifying signer whose floor is at or above the counter), the version (`ALREADY_RUNNING`, `DOWNGRADE_REFUSED`), the track, `min_from` and the service definition. The `order-*` cases break two rules at once to pin the order. A byte string outside the profile of the signed files is refused, and every kind has a case of its own: the number forms (`1e2`, `7.0`, `-0`, `07`, 2^53), duplicate and unknown members, escapes, a byte order mark, a non-ASCII byte and trailing bytes.

`floors_after` and `pins_after` are what a host holds if it takes the release: the pins after the rollover chain, and the floor of every signer raised to the counter (the old key's floor carried to its successor). Keys the host no longer pins have no floor.

### Signatures that differ between libraries

Verification is cofactorless with a canonical `S` and an `R` and a public key that are canonical points of large order. Two cases exist because the standard libraries differ: `refused-signature-with-s-not-below-the-group-order` (S plus the group order) and `refused-signature-whose-r-is-the-identity-point`. The second is a signature made from the test key's own scalar with `R` the identity point: it satisfies the verification equation for any message, a verifier without the small-order check accepts it, and the generator proves that Node's own verifier does. Rust's `verify_strict` refuses it; Go's `ed25519.Verify` does not, so the Go agent checks `R` against the same eight encodings and the canonical form the key rule refuses before it calls `Verify`.

## `report.json`

```text
{ description, bounds, members }
```

`bounds` are the numbers the member's parser keeps to (`keys`, `windows`, `window_characters`, `highest_counter`, `service_definition`, `first_check_in_ms`, `version_bytes`); the agent's constants must equal them. `members` are `{name, member, accepted, why?}`: the server must accept every member with `accepted:true` and refuse every other with a `400` that changes nothing, and the agent must never build a member the server refuses. A member holds the keys of the heartbeat member and nothing else; a null counts as absent for an optional member.

## Examples

`examples/` holds one file for each format the contract quotes. The contract section contains each file in a code block, word for word, and `--check` fails when it does not; the files are also validated against the generated schemas in `contracts/protocol.schema.json`. They tell one story: a host called edge-02 pins the team key on 3 October, is offered agent 0.1.1 (counter 7) on the 4th and takes it in its window on the 5th.

## Regenerating

```sh
node contracts/fixtures/agent-release/generate.mjs          # write the files
node contracts/fixtures/agent-release/generate.mjs --check  # fail when they differ
```

To add a case, add it to `cases.mjs` with the answer it should give: the script stops when `rules.mjs` computes another one, so a case cannot say something the rules do not. Change a rule in the contract, `rules.mjs`, the Rust server and the Go agent together, and commit the regenerated files.
