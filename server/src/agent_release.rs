//! The release format of agent updates: the manifest of a release, its
//! detached signatures, the release keys that sign them and the rollover
//! statements that replace one key with another.
//!
//! The rules are those of the "Agent updates" section of
//! `contracts/CONTRACT.md`. The agent implements the same rules in Go and both
//! sides run the shared vectors in `contracts/fixtures/agent-release/`, so a
//! byte string that one side accepts and the other refuses fails a test.
//!
//! A signed file is verified as bytes and parsed afterwards; nothing is ever
//! re-serialized to be checked. Before serde sees a signed file its raw bytes
//! are held to the profile of the contract (printable ASCII, one object, only
//! canonical whole numbers, no escape sequence), and the typed structs refuse
//! unknown, missing and duplicate members. Serde alone would accept `7.0` where
//! an integer is expected, `null` for an optional member, spaces after the
//! object and a JSON array where a struct is expected; the byte profile and
//! the object-only reader below close each of those.

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::RngCore;
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{DeserializeOwned, MapAccess, Visitor, value::MapAccessDeserializer},
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    marker::PhantomData,
};

/// What a release signature covers, in front of the bytes of `release.json`.
pub const RELEASE_PREFIX: &[u8] = b"vectory-agent-release-v1\n";
/// What a rollover signature covers, in front of the bytes of the statement.
pub const ROLLOVER_PREFIX: &[u8] = b"vectory-release-key-rollover-v1\n";
pub const MANIFEST_SCHEMA: &str = "vectory.agent-release.v1";
pub const SIGNATURES_SCHEMA: &str = "vectory.agent-release-signatures.v1";
pub const ROLLOVER_SCHEMA: &str = "vectory.release-key-rollover.v1";
/// The start of a public key line, up to the base64 of the key.
pub const KEY_LINE_PREFIX: &str = "vectory-release-key ed25519 ";
pub const MAX_MANIFEST_BYTES: usize = 16 * 1024;
pub const MAX_SIGNATURE_FILE_BYTES: usize = 4 * 1024;
pub const MAX_STATEMENT_BYTES: usize = 1024;
/// Rollover statements in one offer.
pub const MAX_ROLLOVERS: usize = 8;
pub const MAX_ARTIFACTS: usize = 8;
pub const MAX_SIGNATURES: usize = 4;
/// The largest agent build a manifest may name: 128 MiB.
pub const MAX_BUILD_BYTES: u64 = 128 * 1024 * 1024;
/// The largest counter and the largest number any signed file may hold:
/// 2^53 - 1, the integers that every JSON implementation reads exactly.
pub const MAX_COUNTER: u64 = (1 << 53) - 1;
/// A release is valid for at most 400 days after it was issued.
pub const MAX_VALIDITY_SECONDS: i64 = 400 * 24 * 3600;
/// A host refuses a release issued more than this far ahead of its own clock.
pub const FUTURE_ISSUE_SECONDS: i64 = 24 * 3600;
const MAX_KEY_NAME: usize = 64;
/// The base64 of a statement of `MAX_STATEMENT_BYTES` bytes.
const MAX_STATEMENT_BASE64: usize = MAX_STATEMENT_BYTES.div_ceil(3) * 4;
const OPERATING_SYSTEMS: [&str; 3] = ["linux", "darwin", "windows"];
const ARCHITECTURES: [&str; 2] = ["amd64", "arm64"];

// ---------------------------------------------------------------- codes and errors

/// The agent codes that deciding a release can produce, and the one setup and
/// the key tools report for a key that fails the key rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Code {
    KeyNotPinned,
    SignatureInvalid,
    ManifestInvalid,
    ManifestExpired,
    KeyRolloverConflict,
    ReleaseAlreadyTried,
    CounterReplayed,
    DowngradeRefused,
    VersionNotOnTrack,
    AgentTooOld,
    AlreadyRunning,
    PlatformNotInRelease,
    ServiceDefinitionOutdated,
    ReleaseKeyInvalid,
}

impl Code {
    pub const ALL: [Code; 14] = [
        Code::KeyNotPinned,
        Code::SignatureInvalid,
        Code::ManifestInvalid,
        Code::ManifestExpired,
        Code::KeyRolloverConflict,
        Code::ReleaseAlreadyTried,
        Code::CounterReplayed,
        Code::DowngradeRefused,
        Code::VersionNotOnTrack,
        Code::AgentTooOld,
        Code::AlreadyRunning,
        Code::PlatformNotInRelease,
        Code::ServiceDefinitionOutdated,
        Code::ReleaseKeyInvalid,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Code::KeyNotPinned => "KEY_NOT_PINNED",
            Code::SignatureInvalid => "SIGNATURE_INVALID",
            Code::ManifestInvalid => "MANIFEST_INVALID",
            Code::ManifestExpired => "MANIFEST_EXPIRED",
            Code::KeyRolloverConflict => "KEY_ROLLOVER_CONFLICT",
            Code::ReleaseAlreadyTried => "RELEASE_ALREADY_TRIED",
            Code::CounterReplayed => "COUNTER_REPLAYED",
            Code::DowngradeRefused => "DOWNGRADE_REFUSED",
            Code::VersionNotOnTrack => "VERSION_NOT_ON_TRACK",
            Code::AgentTooOld => "AGENT_TOO_OLD",
            Code::AlreadyRunning => "ALREADY_RUNNING",
            Code::PlatformNotInRelease => "PLATFORM_NOT_IN_RELEASE",
            Code::ServiceDefinitionOutdated => "SERVICE_DEFINITION_OUTDATED",
            Code::ReleaseKeyInvalid => "RELEASE_KEY_INVALID",
        }
    }

    pub fn parse(text: &str) -> Option<Code> {
        Code::ALL.into_iter().find(|code| code.as_str() == text)
    }
}

impl fmt::Display for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A signed file or a statement that breaks a rule of its format. The text
/// says which rule, for logs and for people; no decision reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError(String);

impl ParseError {
    fn new(reason: impl Into<String>) -> Self {
        ParseError(reason.into())
    }

    pub fn reason(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ParseError {}

/// A key line, a key's bytes or a bundle entry that fails the key rule:
/// `RELEASE_KEY_INVALID`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyError(String);

impl KeyError {
    fn new(reason: impl Into<String>) -> Self {
        KeyError(reason.into())
    }

    pub fn code(&self) -> Code {
        Code::ReleaseKeyInvalid
    }

    pub fn reason(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for KeyError {}

/// Why a host refuses an offered release, with the code it reports. A fork of
/// a rollover also carries the pinned key and its two successors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: Code,
    /// Human text for logs and reviews; never an input to a decision.
    pub detail: String,
    /// Present exactly for `KEY_ROLLOVER_CONFLICT`.
    pub conflict: Option<RolloverConflict>,
}

impl Refusal {
    pub fn new(code: Code, detail: impl Into<String>) -> Self {
        Refusal {
            code,
            detail: detail.into(),
            conflict: None,
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for Refusal {}

/// A fork: two statements from one pinned key that name different successors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RolloverConflict {
    pub from: String,
    /// The two successors' fingerprints in ascending order.
    pub to: [String; 2],
}

// ---------------------------------------------------------------- the profile

/// The raw-byte rules of `release.json`, `release.json.sig` and a rollover
/// statement, checked before anything is decoded: at most `limit` bytes; one
/// object, `{` first and `}` last, with at most one line feed after it; every
/// other byte printable ASCII and no backslash anywhere (so no escape and no
/// quotation mark inside a string); outside strings only the characters
/// `{}[]:,`, the space, the quotation mark and digits, so no `null`, `true`,
/// sign, fraction or exponent; and every run of digits `0` or a digit 1 to 9
/// followed by digits, at most 2^53 - 1. Returns the object's bytes.
fn profile(bytes: &[u8], limit: usize) -> Result<&[u8], ParseError> {
    if bytes.is_empty() {
        return Err(ParseError::new("the file is empty"));
    }
    if bytes.len() > limit {
        return Err(ParseError::new(format!(
            "the file is longer than {limit} bytes"
        )));
    }
    let body = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    if body.first() != Some(&b'{') {
        return Err(ParseError::new(
            "the file is one object with no byte before it",
        ));
    }
    if body.last() != Some(&b'}') {
        return Err(ParseError::new(
            "nothing but one line feed may follow the object",
        ));
    }
    let mut in_string = false;
    let mut digits: Option<usize> = None;
    for (at, &byte) in body.iter().enumerate() {
        if !(0x20..=0x7e).contains(&byte) {
            return Err(ParseError::new("a byte that is not printable ASCII"));
        }
        if byte == b'\\' {
            return Err(ParseError::new("a backslash"));
        }
        if in_string {
            in_string = byte != b'"';
            continue;
        }
        if byte.is_ascii_digit() {
            digits.get_or_insert(at);
            continue;
        }
        if let Some(start) = digits.take() {
            whole_number(&body[start..at])?;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'}' | b'[' | b']' | b':' | b',' | b' ' => {}
            _ => {
                return Err(ParseError::new(
                    "a character outside strings that no value of the format uses",
                ));
            }
        }
    }
    if in_string {
        return Err(ParseError::new("a string is not closed"));
    }
    Ok(body)
}

fn whole_number(digits: &[u8]) -> Result<(), ParseError> {
    if digits.len() > 1 && digits[0] == b'0' {
        return Err(ParseError::new("a number with a leading zero"));
    }
    if digits.len() > 16 {
        return Err(ParseError::new("a number above 2^53 - 1"));
    }
    let value = digits
        .iter()
        .fold(0u64, |value, digit| value * 10 + u64::from(digit - b'0'));
    if value > MAX_COUNTER {
        return Err(ParseError::new("a number above 2^53 - 1"));
    }
    Ok(())
}

/// The profile, then the typed struct: unknown, missing and duplicate members
/// and a value of another type are refused by the struct.
fn decode<T: DeserializeOwned>(bytes: &[u8], limit: usize) -> Result<T, ParseError> {
    let body = profile(bytes, limit)?;
    serde_json::from_slice(body).map_err(|error| ParseError::new(error.to_string()))
}

/// A struct read from a JSON object only. The derive also reads a struct from
/// a JSON array (its fields in order), which no signed file may do.
struct Members<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Members<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Object<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for Object<T> {
            type Value = Members<T>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object")
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Members<T>, A::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(Members)
            }
        }
        deserializer.deserialize_map(Object(PhantomData))
    }
}

/// Canonical base64 (RFC 4648 section 4): the standard alphabet with padding,
/// no whitespace and zero unused bits.
fn strict_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = BASE64.decode(text).ok()?;
    (BASE64.encode(&bytes) == text).then_some(bytes)
}

pub fn manifest_sha256(manifest: &[u8]) -> String {
    hex::encode(Sha256::digest(manifest))
}

/// 64 lowercase hexadecimal characters: a fingerprint or a SHA-256.
pub fn is_hex64(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

// ---------------------------------------------------------------- instants and versions

/// A UTC instant, `YYYY-MM-DDTHH:MM:SSZ` (whole seconds, years 1970 to 9999),
/// as seconds since the epoch. Nothing else is an instant: no offset, no
/// fraction, no lowercase letter, no leap second.
pub fn parse_instant(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 20 {
        return None;
    }
    let separators = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'Z'),
    ];
    if separators.iter().any(|&(at, byte)| bytes[at] != byte) {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> {
        let digits = &bytes[from..to];
        digits.iter().all(u8::is_ascii_digit).then(|| {
            digits
                .iter()
                .fold(0, |value, digit| value * 10 + i64::from(digit - b'0'))
        })
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if year < 1970
        || !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// The instant as `parse_instant` reads it; `None` outside the years 1970 to
/// 9999.
pub fn format_instant(seconds: i64) -> Option<String> {
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    if !(1970..=9999).contains(&year) {
        return None;
    }
    let of_day = seconds.rem_euclid(86_400);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        of_day / 3_600,
        of_day % 3_600 / 60,
        of_day % 60
    ))
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `major.minor.patch`: three numbers, each `0` or one to nine digits that
/// start with 1 to 9. Versions compare as numbers (`0.1.10` is newer than
/// `0.1.9`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    pub fn parse(text: &str) -> Option<Version> {
        let mut parts = text.split('.');
        let (major, minor, patch) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        Some(Version {
            major: component(major)?,
            minor: component(minor)?,
            patch: component(patch)?,
        })
    }
}

fn component(text: &str) -> Option<u32> {
    let bytes = text.as_bytes();
    let canonical = !bytes.is_empty()
        && bytes.len() <= 9
        && bytes.iter().all(u8::is_ascii_digit)
        && (bytes[0] != b'0' || bytes.len() == 1);
    if canonical { text.parse().ok() } else { None }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The versions a host takes: `patch` keeps the running major and minor,
/// `minor` keeps the running major. A major version is never a track.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Track {
    Patch,
    Minor,
}

impl Track {
    pub fn parse(text: &str) -> Option<Track> {
        match text {
            "patch" => Some(Track::Patch),
            "minor" => Some(Track::Minor),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Track::Patch => "patch",
            Track::Minor => "minor",
        }
    }
}

// ---------------------------------------------------------------- keys

/// An Ed25519 release key: 32 bytes that are the canonical encoding of a point
/// that is not of small order, and a display name. Holding one is proof that it
/// passed the key rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseKey {
    bytes: [u8; 32],
    name: String,
    fingerprint: String,
    point: VerifyingKey,
}

impl ReleaseKey {
    /// Reads `vectory-release-key ed25519 <base64 of the 32 bytes> <name>`:
    /// single spaces, printable ASCII on one line, a name of 1 to 64
    /// characters that neither starts nor ends with a space and holds no
    /// quotation mark and no backslash. The key must pass the key rule.
    pub fn parse(line: &str) -> Result<ReleaseKey, KeyError> {
        if !line.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
            return Err(KeyError::new("a key line is printable ASCII on one line"));
        }
        let rest = line
            .strip_prefix(KEY_LINE_PREFIX)
            .ok_or_else(|| KeyError::new("not a vectory release key line"))?;
        let (encoded, name) = rest
            .split_once(' ')
            .ok_or_else(|| KeyError::new("a key line ends with a name"))?;
        let alphabet =
            |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=');
        if encoded.is_empty() || !encoded.bytes().all(alphabet) {
            return Err(KeyError::new("the key is not base64"));
        }
        let bytes = strict_base64(encoded)
            .and_then(|decoded| <[u8; 32]>::try_from(decoded).ok())
            .ok_or_else(|| KeyError::new("the key is not the canonical base64 of 32 bytes"))?;
        ReleaseKey::from_public_bytes(&bytes, name)
    }

    /// A key from its 32 bytes, which must pass the key rule: the canonical
    /// encoding (the `y` coordinate below 2^255 - 19 and the sign bit clear
    /// when `x` is 0) of a point on the curve that is not one of the eight
    /// points of order 1, 2, 4 or 8.
    pub fn from_public_bytes(bytes: &[u8; 32], name: &str) -> Result<ReleaseKey, KeyError> {
        if !key_name_is_valid(name) {
            return Err(KeyError::new(
                "a key name is 1 to 64 printable ASCII characters without a quotation mark or a backslash, and neither starts nor ends with a space",
            ));
        }
        let point = large_order_point(bytes).ok_or_else(|| {
            KeyError::new("the key is not the canonical encoding of a point of large order")
        })?;
        Ok(ReleaseKey {
            bytes: *bytes,
            name: name.to_owned(),
            fingerprint: hex::encode(Sha256::digest(bytes)),
            point,
        })
    }

    /// The public key of a seed.
    pub fn from_seed(seed: &[u8; 32], name: &str) -> Result<ReleaseKey, KeyError> {
        ReleaseKey::from_public_bytes(
            &SigningKey::from_bytes(seed).verifying_key().to_bytes(),
            name,
        )
    }

    pub fn public_bytes(&self) -> &[u8; 32] {
        &self.bytes
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The lowercase hex SHA-256 of the 32 bytes, always computed from them.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// The first 16 characters of the fingerprint.
    pub fn short_id(&self) -> &str {
        &self.fingerprint[..16]
    }

    /// The key as the line that `parse` reads.
    pub fn line(&self) -> String {
        format!(
            "{KEY_LINE_PREFIX}{} {}",
            BASE64.encode(self.bytes),
            self.name
        )
    }
}

impl fmt::Display for ReleaseKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.line())
    }
}

fn key_name_is_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_KEY_NAME
        && name
            .bytes()
            .all(|byte| (0x20..=0x7e).contains(&byte) && byte != b'"' && byte != b'\\')
        && !name.starts_with(' ')
        && !name.ends_with(' ')
}

/// The point an encoding stands for when it is on the curve, written in its
/// canonical form (the decompression also accepts a `y` at or above the field
/// prime and a set sign bit on a point whose `x` is 0, which re-compressing the
/// point reveals) and not of small order.
fn large_order_point(bytes: &[u8; 32]) -> Option<VerifyingKey> {
    let point = VerifyingKey::from_bytes(bytes).ok()?;
    let canonical = point.to_edwards().compress().to_bytes() == *bytes;
    (canonical && !point.is_weak()).then_some(point)
}

/// What setup does with one entry of the key bundle: the key must pass the key
/// rule and the `fingerprint` member must equal the fingerprint computed from
/// the key's bytes. An entry whose member disagrees makes the whole bundle
/// malformed, so a server never serves one.
pub fn bundle_entry_matches(
    public_key_line: &str,
    fingerprint_field: &str,
) -> Result<ReleaseKey, KeyError> {
    let key = ReleaseKey::parse(public_key_line)?;
    if key.fingerprint() != fingerprint_field {
        return Err(KeyError::new(
            "the fingerprint member is not the fingerprint of the key",
        ));
    }
    Ok(key)
}

/// A fresh seed from the operating system's random number generator.
pub fn generate_seed() -> [u8; 32] {
    let mut seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    seed
}

// ---------------------------------------------------------------- signatures

/// The order of the base point's group, little endian.
const GROUP_ORDER: [u8; 32] = [
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
];

fn below_group_order(scalar: &[u8; 32]) -> bool {
    scalar
        .iter()
        .rev()
        .zip(GROUP_ORDER.iter().rev())
        .find(|(scalar, order)| scalar != order)
        .is_some_and(|(scalar, order)| scalar < order)
}

/// Strict verification, the same in every language that verifies a release:
/// cofactorless, `S` below the group order, `R` a canonical encoding of a point
/// that is not of small order. The key is the pinned key's own bytes, never a
/// key that came with the signature.
fn verify_prefixed(key: &ReleaseKey, prefix: &[u8], bytes: &[u8], signature: &[u8; 64]) -> bool {
    let (Some(r), Some(s)) = (signature.first_chunk::<32>(), signature.last_chunk::<32>()) else {
        return false;
    };
    if !below_group_order(s) || large_order_point(r).is_none() {
        return false;
    }
    let message = [prefix, bytes].concat();
    key.point
        .verify_strict(&message, &Signature::from_bytes(signature))
        .is_ok()
}

fn sign_prefixed(seed: &[u8; 32], prefix: &[u8], bytes: &[u8]) -> [u8; 64] {
    SigningKey::from_bytes(seed)
        .sign(&[prefix, bytes].concat())
        .to_bytes()
}

/// Signs the bytes of a release manifest with the key of `seed`, for server
/// custody (the caller unseals the seed). It refuses bytes that are not a valid
/// manifest, so a key never signs what no host would accept.
pub fn sign(seed: &[u8; 32], manifest: &[u8]) -> Result<[u8; 64], ParseError> {
    parse_manifest(manifest)?;
    Ok(sign_prefixed(seed, RELEASE_PREFIX, manifest))
}

/// Signs a rollover statement with the key of `seed`; it refuses a statement
/// that is not valid.
pub fn sign_rollover(seed: &[u8; 32], statement: &[u8]) -> Result<[u8; 64], ParseError> {
    parse_statement(statement).map_err(|error| ParseError::new(error.to_string()))?;
    Ok(sign_prefixed(seed, ROLLOVER_PREFIX, statement))
}

/// Whether `signature` is a signature by `key` over the release prefix and the
/// manifest's bytes.
pub fn verify_release_signature(key: &ReleaseKey, manifest: &[u8], signature: &[u8; 64]) -> bool {
    verify_prefixed(key, RELEASE_PREFIX, manifest, signature)
}

/// One entry of `release.json.sig`: the fingerprint that selects the pinned key
/// to try, and the signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignatureEntry {
    pub key: String,
    pub signature: [u8; 64],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSignatureFile {
    schema: String,
    signatures: Vec<Members<RawSignature>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSignature {
    key: String,
    signature: String,
}

/// Reads `release.json.sig`: at most 4 KiB, 1 to 4 entries with distinct
/// lowercase 64-hex keys and canonical base64 signatures of 64 bytes.
pub fn parse_signature_file(bytes: &[u8]) -> Result<Vec<SignatureEntry>, ParseError> {
    let raw: RawSignatureFile = decode(bytes, MAX_SIGNATURE_FILE_BYTES)?;
    if raw.schema != SIGNATURES_SCHEMA {
        return Err(ParseError::new(
            "the schema is not vectory.agent-release-signatures.v1",
        ));
    }
    if raw.signatures.is_empty() || raw.signatures.len() > MAX_SIGNATURES {
        return Err(ParseError::new("a signature file holds 1 to 4 entries"));
    }
    let mut keys = BTreeSet::new();
    let mut entries = Vec::with_capacity(raw.signatures.len());
    for Members(entry) in raw.signatures {
        if !is_hex64(&entry.key) {
            return Err(ParseError::new(
                "a key is 64 lowercase hexadecimal characters",
            ));
        }
        if !keys.insert(entry.key.clone()) {
            return Err(ParseError::new("a key appears twice"));
        }
        let signature = strict_base64(&entry.signature)
            .and_then(|decoded| <[u8; 64]>::try_from(decoded).ok())
            .ok_or_else(|| ParseError::new("a signature is the canonical base64 of 64 bytes"))?;
        entries.push(SignatureEntry {
            key: entry.key,
            signature,
        });
    }
    Ok(entries)
}

#[derive(Serialize)]
struct SignatureFileOut {
    schema: &'static str,
    signatures: Vec<SignatureOut>,
}

#[derive(Serialize)]
struct SignatureOut {
    key: String,
    signature: String,
}

/// The bytes of a `release.json.sig`: one line, no final line feed, the
/// members in the order of the contract.
pub fn build_signature_file(entries: &[SignatureEntry]) -> Result<Vec<u8>, ParseError> {
    let file = SignatureFileOut {
        schema: SIGNATURES_SCHEMA,
        signatures: entries
            .iter()
            .map(|entry| SignatureOut {
                key: entry.key.clone(),
                signature: BASE64.encode(entry.signature),
            })
            .collect(),
    };
    let bytes = serde_json::to_vec(&file).map_err(|error| ParseError::new(error.to_string()))?;
    parse_signature_file(&bytes)?;
    Ok(bytes)
}

/// What the server checks when a signature file is uploaded for a release: the
/// file is a valid signature file and one of its entries names `key` and
/// verifies over the release prefix and the stored manifest. Entries for other
/// keys are allowed and not checked.
pub fn check_signature_file(
    manifest: &[u8],
    signature_file: &[u8],
    key: &ReleaseKey,
) -> Result<(), Refusal> {
    let entries = parse_signature_file(signature_file)
        .map_err(|error| Refusal::new(Code::SignatureInvalid, error.to_string()))?;
    let verified = entries
        .iter()
        .filter(|entry| entry.key == key.fingerprint())
        .any(|entry| verify_release_signature(key, manifest, &entry.signature));
    if verified {
        Ok(())
    } else {
        Err(Refusal::new(
            Code::SignatureInvalid,
            "no entry names the key and verifies over the manifest",
        ))
    }
}

// ---------------------------------------------------------------- the manifest

/// One build of a release: the agent executable of a platform.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Artifact {
    pub os: String,
    pub arch: String,
    pub file: String,
    pub size: u64,
    pub sha256: String,
}

/// A parsed `release.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub version: Version,
    pub counter: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub min_from: Option<Version>,
    pub service_definition: u64,
    pub artifacts: Vec<Artifact>,
}

impl Manifest {
    pub fn artifact_for(&self, os: &str, arch: &str) -> Option<&Artifact> {
        self.artifacts
            .iter()
            .find(|artifact| artifact.os == os && artifact.arch == arch)
    }
}

/// `vectory-<version>-<os>-<arch>`, plus `.exe` on Windows.
pub fn artifact_file_name(version: &Version, os: &str, arch: &str) -> String {
    let extension = if os == "windows" { ".exe" } else { "" };
    format!("vectory-{version}-{os}-{arch}{extension}")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    schema: String,
    version: String,
    counter: u64,
    issued_at: String,
    expires_at: String,
    #[serde(default)]
    min_from: Option<String>,
    service_definition: u64,
    artifacts: Vec<Members<RawArtifact>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawArtifact {
    os: String,
    arch: String,
    format: String,
    file: String,
    size: u64,
    sha256: String,
}

/// Reads `release.json` under the rules of the contract's table: at most 16 KiB
/// and the profile of the signed files; the exact schema; a version; a counter
/// of 1 to 2^53 - 1; instants with `expires_at` after `issued_at` and at most
/// 400 days later; an optional `min_from` version; a service definition of 1 or
/// more; 1 to 8 artifacts, unique by platform, each with a known `os` and
/// `arch`, the format `executable`, its file name, a size of 1 byte to 128 MiB
/// and a lowercase SHA-256.
pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, ParseError> {
    let raw: RawManifest = decode(bytes, MAX_MANIFEST_BYTES)?;
    if raw.schema != MANIFEST_SCHEMA {
        return Err(ParseError::new(
            "the schema is not vectory.agent-release.v1",
        ));
    }
    let version = Version::parse(&raw.version)
        .ok_or_else(|| ParseError::new("the version is not major.minor.patch"))?;
    if !(1..=MAX_COUNTER).contains(&raw.counter) {
        return Err(ParseError::new("the counter is 1 to 2^53 - 1"));
    }
    let issued_at = parse_instant(&raw.issued_at)
        .ok_or_else(|| ParseError::new("issued_at is not a UTC instant"))?;
    let expires_at = parse_instant(&raw.expires_at)
        .ok_or_else(|| ParseError::new("expires_at is not a UTC instant"))?;
    if expires_at <= issued_at || expires_at - issued_at > MAX_VALIDITY_SECONDS {
        return Err(ParseError::new(
            "expires_at is after issued_at and at most 400 days later",
        ));
    }
    let min_from = raw
        .min_from
        .as_deref()
        .map(|text| {
            Version::parse(text).ok_or_else(|| ParseError::new("min_from is not major.minor.patch"))
        })
        .transpose()?;
    if raw.service_definition < 1 {
        return Err(ParseError::new("the service definition is 1 or more"));
    }
    if raw.artifacts.is_empty() || raw.artifacts.len() > MAX_ARTIFACTS {
        return Err(ParseError::new("a release has 1 to 8 artifacts"));
    }
    let mut platforms = BTreeSet::new();
    let mut artifacts = Vec::with_capacity(raw.artifacts.len());
    for Members(artifact) in raw.artifacts {
        if !OPERATING_SYSTEMS.contains(&artifact.os.as_str())
            || !ARCHITECTURES.contains(&artifact.arch.as_str())
        {
            return Err(ParseError::new("an artifact names an unknown platform"));
        }
        if artifact.format != "executable" {
            return Err(ParseError::new("the only artifact format is executable"));
        }
        if !platforms.insert((artifact.os.clone(), artifact.arch.clone())) {
            return Err(ParseError::new("two artifacts are for one platform"));
        }
        if artifact.file != artifact_file_name(&version, &artifact.os, &artifact.arch) {
            return Err(ParseError::new(
                "an artifact's file name is not the one of its platform",
            ));
        }
        if !(1..=MAX_BUILD_BYTES).contains(&artifact.size) {
            return Err(ParseError::new("an artifact is 1 byte to 128 MiB"));
        }
        if !is_hex64(&artifact.sha256) {
            return Err(ParseError::new(
                "an artifact's sha256 is 64 lowercase hexadecimal characters",
            ));
        }
        artifacts.push(Artifact {
            os: artifact.os,
            arch: artifact.arch,
            file: artifact.file,
            size: artifact.size,
            sha256: artifact.sha256,
        });
    }
    Ok(Manifest {
        version,
        counter: raw.counter,
        issued_at,
        expires_at,
        min_from,
        service_definition: raw.service_definition,
        artifacts,
    })
}

/// A build to put in a manifest. The file name is the one of its platform.
#[derive(Clone, Copy, Debug)]
pub struct ArtifactInput<'a> {
    pub os: &'a str,
    pub arch: &'a str,
    pub size: u64,
    pub sha256: &'a str,
}

#[derive(Serialize)]
struct ManifestOut<'a> {
    schema: &'static str,
    version: &'a str,
    counter: u64,
    issued_at: String,
    expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_from: Option<&'a str>,
    service_definition: u64,
    artifacts: Vec<ArtifactOut<'a>>,
}

#[derive(Serialize)]
struct ArtifactOut<'a> {
    os: &'a str,
    arch: &'a str,
    format: &'static str,
    file: String,
    size: u64,
    sha256: &'a str,
}

/// The canonical bytes of a manifest, the ones the server stores, signs and
/// delivers: one object, the members in the order of the contract's example, no
/// whitespace and no final line feed. A manifest that `parse_manifest` would
/// refuse is never built.
pub fn build_manifest(
    version: &str,
    counter: u64,
    issued_at: i64,
    expires_at: i64,
    min_from: Option<&str>,
    service_definition: u64,
    artifacts: &[ArtifactInput<'_>],
) -> Result<Vec<u8>, ParseError> {
    let parsed = Version::parse(version)
        .ok_or_else(|| ParseError::new("the version is not major.minor.patch"))?;
    let instant = |seconds, name| {
        format_instant(seconds)
            .ok_or_else(|| ParseError::new(format!("{name} is outside the years 1970 to 9999")))
    };
    let manifest = ManifestOut {
        schema: MANIFEST_SCHEMA,
        version,
        counter,
        issued_at: instant(issued_at, "issued_at")?,
        expires_at: instant(expires_at, "expires_at")?,
        min_from,
        service_definition,
        artifacts: artifacts
            .iter()
            .map(|artifact| ArtifactOut {
                os: artifact.os,
                arch: artifact.arch,
                format: "executable",
                file: artifact_file_name(&parsed, artifact.os, artifact.arch),
                size: artifact.size,
                sha256: artifact.sha256,
            })
            .collect(),
    };
    let bytes =
        serde_json::to_vec(&manifest).map_err(|error| ParseError::new(error.to_string()))?;
    parse_manifest(&bytes)?;
    Ok(bytes)
}

// ---------------------------------------------------------------- rollover statements

/// A statement that replaces the key `from` with the key `to`, read from its
/// bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Statement {
    /// The fingerprint of the key it replaces.
    pub from: String,
    /// The successor; its fingerprint is computed from its bytes.
    pub to: ReleaseKey,
    pub issued_at: i64,
}

/// Why a statement is not usable. `KeyInvalid` is a `to` that is not a valid key
/// line (`RELEASE_KEY_INVALID`); `Malformed` is anything else wrong with the
/// statement, its envelope or its encoding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RolloverError {
    Malformed(String),
    KeyInvalid(String),
}

impl fmt::Display for RolloverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RolloverError::Malformed(reason) | RolloverError::KeyInvalid(reason) => {
                f.write_str(reason)
            }
        }
    }
}

impl std::error::Error for RolloverError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawStatement {
    schema: String,
    from: String,
    to: String,
    issued_at: String,
}

/// Reads a rollover statement: at most 1 KiB, the profile of the signed files,
/// the exact schema, `from` a fingerprint, `to` a key line that passes the key
/// rule and whose fingerprint is not `from`, and an instant.
pub fn parse_statement(bytes: &[u8]) -> Result<Statement, RolloverError> {
    let raw: RawStatement = decode(bytes, MAX_STATEMENT_BYTES)
        .map_err(|error| RolloverError::Malformed(error.to_string()))?;
    let malformed = |reason: &str| RolloverError::Malformed(reason.to_owned());
    if raw.schema != ROLLOVER_SCHEMA {
        return Err(malformed(
            "the schema is not vectory.release-key-rollover.v1",
        ));
    }
    if !is_hex64(&raw.from) {
        return Err(malformed(
            "from is a 64-character lowercase hexadecimal fingerprint",
        ));
    }
    let issued_at =
        parse_instant(&raw.issued_at).ok_or_else(|| malformed("issued_at is not a UTC instant"))?;
    let to = ReleaseKey::parse(&raw.to)
        .map_err(|error| RolloverError::KeyInvalid(error.reason().to_owned()))?;
    if to.fingerprint() == raw.from {
        return Err(malformed("a key cannot replace itself"));
    }
    Ok(Statement {
        from: raw.from,
        to,
        issued_at,
    })
}

#[derive(Serialize)]
struct StatementOut<'a> {
    schema: &'static str,
    from: &'a str,
    to: String,
    issued_at: String,
}

/// The canonical bytes of a rollover statement: one object, no whitespace, no
/// final line feed.
pub fn build_statement(
    from_fingerprint: &str,
    to: &ReleaseKey,
    issued_at: i64,
) -> Result<Vec<u8>, ParseError> {
    let statement = StatementOut {
        schema: ROLLOVER_SCHEMA,
        from: from_fingerprint,
        to: to.line(),
        issued_at: format_instant(issued_at)
            .ok_or_else(|| ParseError::new("issued_at is outside the years 1970 to 9999"))?,
    };
    let bytes =
        serde_json::to_vec(&statement).map_err(|error| ParseError::new(error.to_string()))?;
    parse_statement(&bytes).map_err(|error| ParseError::new(error.to_string()))?;
    Ok(bytes)
}

/// A statement as delivered: `{"statement":"<base64>","signature":"<base64>"}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RolloverEnvelope {
    pub statement: String,
    pub signature: String,
}

impl RolloverEnvelope {
    pub fn new(statement: &[u8], signature: &[u8; 64]) -> Self {
        RolloverEnvelope {
            statement: BASE64.encode(statement),
            signature: BASE64.encode(signature),
        }
    }

    /// Decodes and reads the envelope; see [`Rollover::from_base64`].
    pub fn decode(&self) -> Result<Rollover, RolloverError> {
        Rollover::from_base64(&self.statement, &self.signature)
    }
}

/// A rollover statement with the bytes that were signed and its signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rollover {
    pub statement: Statement,
    bytes: Vec<u8>,
    signature: [u8; 64],
}

impl Rollover {
    /// Reads the base64 of a statement and of its signature: canonical base64,
    /// a statement of at most 1 KiB, a signature of 64 bytes. It does not check
    /// the signature: [`Rollover::verify`] does, against the key `from` names.
    pub fn from_base64(statement: &str, signature: &str) -> Result<Rollover, RolloverError> {
        let malformed = |reason: &str| RolloverError::Malformed(reason.to_owned());
        if statement.len() > MAX_STATEMENT_BASE64 {
            return Err(malformed("a statement is at most 1 KiB"));
        }
        let bytes = strict_base64(statement)
            .ok_or_else(|| malformed("the statement is not canonical base64"))?;
        let signature = strict_base64(signature)
            .and_then(|decoded| <[u8; 64]>::try_from(decoded).ok())
            .ok_or_else(|| malformed("the signature is not the canonical base64 of 64 bytes"))?;
        Ok(Rollover {
            statement: parse_statement(&bytes)?,
            bytes,
            signature,
        })
    }

    /// Whether the signature verifies under `from_key` over the rollover prefix
    /// and the statement's bytes. The caller passes the key whose fingerprint
    /// is `statement.from`.
    pub fn verify(&self, from_key: &ReleaseKey) -> bool {
        from_key.fingerprint() == self.statement.from
            && verify_prefixed(from_key, ROLLOVER_PREFIX, &self.bytes, &self.signature)
    }

    pub fn statement_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn envelope(&self) -> RolloverEnvelope {
        RolloverEnvelope::new(&self.bytes, &self.signature)
    }
}

/// The keys a host pins after following the rollovers of an offer, and its
/// counter floors carried over to them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chain {
    /// By fingerprint.
    pub pins: BTreeMap<String, ReleaseKey>,
    pub floors: BTreeMap<String, u64>,
}

/// Follows an offer's rollover statements in order. A statement is ignored when
/// it cannot be read, when its `from` is not a key pinned at that point of the
/// chain or when its signature does not verify under that key. Otherwise the
/// host pins `to`, drops `from` and carries `from`'s floor to `to` (the higher
/// of the two when `to` has one). A fork, two statements from one pinned key
/// that both verify and name different successors, none followed yet, is
/// `KEY_ROLLOVER_CONFLICT` with the first statement's successor and the first
/// later one that differs; a statement from a key the chain already replaced is
/// ignored, never a conflict. An offer carries at most 8 statements.
pub fn follow_rollovers(
    pins: &[ReleaseKey],
    floors: &BTreeMap<String, u64>,
    envelopes: &[RolloverEnvelope],
) -> Result<Chain, Refusal> {
    check_envelope_count(envelopes)?;
    let mut pinned: BTreeMap<String, ReleaseKey> = pins
        .iter()
        .map(|key| (key.fingerprint().to_owned(), key.clone()))
        .collect();
    let mut floors = floors.clone();
    let statements: Vec<Option<Rollover>> = envelopes
        .iter()
        .map(|envelope| envelope.decode().ok())
        .collect();
    for (index, statement) in statements.iter().enumerate() {
        let Some(statement) = statement else { continue };
        let from = &statement.statement.from;
        let Some(from_key) = pinned.get(from).cloned() else {
            continue;
        };
        if !statement.verify(&from_key) {
            continue;
        }
        let to = statement.statement.to.fingerprint();
        for other in statements[index + 1..].iter().flatten() {
            if other.statement.from == *from
                && other.statement.to.fingerprint() != to
                && other.verify(&from_key)
            {
                let mut successors = [to.to_owned(), other.statement.to.fingerprint().to_owned()];
                successors.sort();
                return Err(Refusal {
                    code: Code::KeyRolloverConflict,
                    detail: format!(
                        "two statements from key {} name different successors",
                        from_key.short_id()
                    ),
                    conflict: Some(RolloverConflict {
                        from: from.clone(),
                        to: successors,
                    }),
                });
            }
        }
        pinned.remove(from);
        pinned.insert(to.to_owned(), statement.statement.to.clone());
        let carried = floors.remove(from).unwrap_or(0);
        let floor = floors.entry(to.to_owned()).or_insert(0);
        *floor = (*floor).max(carried);
    }
    Ok(Chain {
        pins: pinned,
        floors,
    })
}

fn check_envelope_count(envelopes: &[RolloverEnvelope]) -> Result<(), Refusal> {
    if envelopes.len() > MAX_ROLLOVERS {
        return Err(Refusal::new(
            Code::ManifestInvalid,
            "an offer carries at most 8 rollover statements",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------- the decision

/// What the host's last result says: the manifest SHA-256 it was about and how
/// it ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastResult {
    pub release: String,
    pub outcome: Outcome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Committed,
    RolledBack,
    Failed,
    Refused,
}

impl Outcome {
    pub fn parse(text: &str) -> Option<Outcome> {
        match text {
            "committed" => Some(Outcome::Committed),
            "rolled_back" => Some(Outcome::RolledBack),
            "failed" => Some(Outcome::Failed),
            "refused" => Some(Outcome::Refused),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Committed => "committed",
            Outcome::RolledBack => "rolled_back",
            Outcome::Failed => "failed",
            Outcome::Refused => "refused",
        }
    }
}

/// Everything a host decides an offered release from.
pub struct VerifyInput<'a> {
    /// The bytes of `release.json` as delivered.
    pub manifest: &'a [u8],
    /// The bytes of `release.json.sig` as delivered.
    pub signatures: &'a [u8],
    pub rollovers: &'a [RolloverEnvelope],
    /// The keys the host pins.
    pub pins: &'a [ReleaseKey],
    /// Fingerprint to the highest counter the host attempted from that key.
    pub floors: &'a BTreeMap<String, u64>,
    pub last: Option<&'a LastResult>,
    pub running_version: &'a str,
    pub os: &'a str,
    pub arch: &'a str,
    pub track: Track,
    /// The generation of the host's service definition.
    pub service_definition: u64,
    /// The host's clock, in seconds since the epoch.
    pub now: i64,
}

/// A release the host accepts, with what it holds after taking it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub manifest: Manifest,
    /// The SHA-256 of the manifest bytes, the digest a host reports as `release`.
    pub manifest_sha256: String,
    /// The first signer in the signature file's order.
    pub signer: String,
    /// Every pinned key whose signature verified, in file order.
    pub signers: Vec<String>,
    /// The artifact of the host's platform.
    pub artifact: Artifact,
    /// The pins after the rollover chain, ascending by fingerprint.
    pub pins_after: Vec<ReleaseKey>,
    /// The floor of every pin that has one, with each signer's raised to the
    /// release's counter.
    pub floors_after: BTreeMap<String, u64>,
}

/// Decides an offered release in the order of the contract and stops at the
/// first refusal:
///
/// 1. more than 8 rollover envelopes: `MANIFEST_INVALID`;
/// 2. a signature file that does not parse: `SIGNATURE_INVALID`;
/// 3. the rollover chain ([`follow_rollovers`]): `KEY_ROLLOVER_CONFLICT`;
/// 4. no entry names a pinned key: `KEY_NOT_PINNED`;
/// 5. no entry for a pinned key verifies: `SIGNATURE_INVALID`;
/// 6. a manifest that does not parse, or an `issued_at` more than 24 hours
///    after the host's clock: `MANIFEST_INVALID`;
/// 7. the clock at or after `expires_at`: `MANIFEST_EXPIRED`;
/// 8. no artifact for the platform: `PLATFORM_NOT_IN_RELEASE`;
/// 9. a counter at or below the floor of any signer: `RELEASE_ALREADY_TRIED`
///    when the last result names this manifest as rolled back, else
///    `COUNTER_REPLAYED`;
/// 10. the running version: `ALREADY_RUNNING` (equal) or `DOWNGRADE_REFUSED`
///     (older), and a running version that is not `major.minor.patch` is
///     `VERSION_NOT_ON_TRACK`, because nothing can be newer than a version no
///     one can place;
/// 11. a version off the track: `VERSION_NOT_ON_TRACK`;
/// 12. a running version below `min_from`: `AGENT_TOO_OLD`;
/// 13. a service definition newer than the host's: `SERVICE_DEFINITION_OUTDATED`.
pub fn verify_release(input: &VerifyInput<'_>) -> Result<Verified, Refusal> {
    check_envelope_count(input.rollovers)?;
    let entries = parse_signature_file(input.signatures)
        .map_err(|error| Refusal::new(Code::SignatureInvalid, error.to_string()))?;
    let Chain { pins, mut floors } = follow_rollovers(input.pins, input.floors, input.rollovers)?;
    let named: Vec<&SignatureEntry> = entries
        .iter()
        .filter(|entry| pins.contains_key(&entry.key))
        .collect();
    if named.is_empty() {
        return Err(Refusal::new(
            Code::KeyNotPinned,
            "no signature names a key this host pins",
        ));
    }
    let signers: Vec<&SignatureEntry> = named
        .into_iter()
        .filter(|entry| {
            verify_release_signature(&pins[&entry.key], input.manifest, &entry.signature)
        })
        .collect();
    if signers.is_empty() {
        return Err(Refusal::new(
            Code::SignatureInvalid,
            "no signature by a pinned key verifies over the manifest",
        ));
    }
    let manifest = parse_manifest(input.manifest)
        .map_err(|error| Refusal::new(Code::ManifestInvalid, error.to_string()))?;
    if manifest.issued_at - input.now > FUTURE_ISSUE_SECONDS {
        return Err(Refusal::new(
            Code::ManifestInvalid,
            "the release was issued more than 24 hours after this host's clock",
        ));
    }
    if input.now >= manifest.expires_at {
        return Err(Refusal::new(
            Code::ManifestExpired,
            "the release has expired",
        ));
    }
    let Some(artifact) = manifest.artifact_for(input.os, input.arch).cloned() else {
        return Err(Refusal::new(
            Code::PlatformNotInRelease,
            format!("the release has no build for {}/{}", input.os, input.arch),
        ));
    };
    let digest = manifest_sha256(input.manifest);
    if signers
        .iter()
        .any(|entry| floors.get(&entry.key).copied().unwrap_or(0) >= manifest.counter)
    {
        let tried = input
            .last
            .is_some_and(|last| last.release == digest && last.outcome == Outcome::RolledBack);
        return Err(if tried {
            Refusal::new(
                Code::ReleaseAlreadyTried,
                "this build was tried here and rolled back",
            )
        } else {
            Refusal::new(
                Code::CounterReplayed,
                "the release's counter is at or below one this host already attempted",
            )
        });
    }
    let Some(running) = Version::parse(input.running_version) else {
        return Err(Refusal::new(
            Code::VersionNotOnTrack,
            "the running version is not major.minor.patch",
        ));
    };
    match manifest.version.cmp(&running) {
        std::cmp::Ordering::Equal => {
            return Err(Refusal::new(
                Code::AlreadyRunning,
                "the release is the running version",
            ));
        }
        std::cmp::Ordering::Less => {
            return Err(Refusal::new(
                Code::DowngradeRefused,
                "the release is older than the running version",
            ));
        }
        std::cmp::Ordering::Greater => {}
    }
    let same_major = manifest.version.major == running.major;
    let same_minor = same_major && manifest.version.minor == running.minor;
    let on_track = match input.track {
        Track::Patch => same_minor,
        Track::Minor => same_major,
    };
    if !on_track {
        return Err(Refusal::new(
            Code::VersionNotOnTrack,
            format!(
                "the release is not on this host's {} track",
                input.track.as_str()
            ),
        ));
    }
    if manifest.min_from.is_some_and(|minimum| running < minimum) {
        return Err(Refusal::new(
            Code::AgentTooOld,
            "the running version is older than the release's minimum",
        ));
    }
    if manifest.service_definition > input.service_definition {
        return Err(Refusal::new(
            Code::ServiceDefinitionOutdated,
            "the release needs a newer service definition than this host has",
        ));
    }
    for entry in &signers {
        floors.insert(entry.key.clone(), manifest.counter);
    }
    let floors_after = pins
        .keys()
        .filter_map(|fingerprint| {
            floors
                .get(fingerprint)
                .filter(|floor| **floor > 0)
                .map(|floor| (fingerprint.clone(), *floor))
        })
        .collect();
    Ok(Verified {
        manifest_sha256: digest,
        signer: signers[0].key.clone(),
        signers: signers.iter().map(|entry| entry.key.clone()).collect(),
        artifact,
        pins_after: pins.into_values().collect(),
        floors_after,
        manifest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{Rng, SeedableRng, rngs::StdRng, seq::SliceRandom};
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../contracts/fixtures/agent-release/vectors.json");
    const CONTRACT: &str = include_str!("../../contracts/CONTRACT.md");
    const EXAMPLE_RELEASE: &str =
        include_str!("../../contracts/fixtures/agent-release/examples/release.json");
    const EXAMPLE_SIGNATURES: &str =
        include_str!("../../contracts/fixtures/agent-release/examples/release.json.sig");
    const EXAMPLE_STATEMENT: &str =
        include_str!("../../contracts/fixtures/agent-release/examples/rollover.json");
    const EXAMPLE_ENVELOPE: &str =
        include_str!("../../contracts/fixtures/agent-release/examples/rollover-envelope.json");
    const EXAMPLE_BUNDLE: &str =
        include_str!("../../contracts/fixtures/agent-release/examples/release-keys.json");
    const EXAMPLE_KEY: &str =
        include_str!("../../contracts/fixtures/agent-release/examples/team.pub");
    /// The manifest the Go agent's tests parse; see `rust_built_release_is_current`.
    const GOLDEN_FILE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../agent/internal/agent/testdata/rust-built-release.json"
    );

    // ------------------------------------------------------------ helpers

    fn without_line_feed(file: &str) -> &str {
        file.strip_suffix('\n').unwrap_or(file)
    }

    fn vectors() -> Value {
        serde_json::from_str(VECTORS).expect("the vectors are JSON")
    }

    #[derive(Clone)]
    struct TestKey {
        seed: [u8; 32],
        key: ReleaseKey,
    }

    /// The published test keys of the vectors, by name.
    fn test_keys() -> BTreeMap<String, TestKey> {
        vectors()["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                let name = entry["name"].as_str().unwrap();
                let seed: [u8; 32] = hex::decode(entry["seed_hex"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap();
                let key = ReleaseKey::parse(entry["public_key_line"].as_str().unwrap()).unwrap();
                assert_eq!(key.fingerprint(), entry["fingerprint"].as_str().unwrap());
                assert_eq!(ReleaseKey::from_seed(&seed, name).unwrap(), key, "{name}");
                (name.to_owned(), TestKey { seed, key })
            })
            .collect()
    }

    fn test_key(name: &str) -> TestKey {
        test_keys()[name].clone()
    }

    fn signature_file_of(key: &TestKey, manifest: &[u8]) -> Vec<u8> {
        build_signature_file(&[SignatureEntry {
            key: key.key.fingerprint().to_owned(),
            signature: sign_prefixed(&key.seed, RELEASE_PREFIX, manifest),
        }])
        .unwrap()
    }

    /// A host that pins the given keys, runs 0.1.0 on linux/amd64 and decides at
    /// the moment the example release was offered.
    struct Host {
        pins: Vec<ReleaseKey>,
        floors: BTreeMap<String, u64>,
        last: Option<LastResult>,
        rollovers: Vec<RolloverEnvelope>,
        running_version: &'static str,
        track: Track,
        service_definition: u64,
        now: i64,
    }

    impl Host {
        fn new(pins: &[&TestKey]) -> Host {
            Host {
                pins: pins.iter().map(|key| key.key.clone()).collect(),
                floors: BTreeMap::new(),
                last: None,
                rollovers: Vec::new(),
                running_version: "0.1.0",
                track: Track::Patch,
                service_definition: 1,
                now: parse_instant("2026-10-04T01:58:10Z").unwrap(),
            }
        }

        fn decide(&self, manifest: &[u8], signatures: &[u8]) -> Result<Verified, Refusal> {
            verify_release(&VerifyInput {
                manifest,
                signatures,
                rollovers: &self.rollovers,
                pins: &self.pins,
                floors: &self.floors,
                last: self.last.as_ref(),
                running_version: self.running_version,
                os: "linux",
                arch: "amd64",
                track: self.track,
                service_definition: self.service_definition,
                now: self.now,
            })
        }
    }

    fn example_manifest() -> &'static str {
        without_line_feed(EXAMPLE_RELEASE)
    }

    /// The example manifest with its first `from` replaced by `to`.
    fn changed(from: &str, to: &str) -> Vec<u8> {
        assert!(
            example_manifest().contains(from),
            "the example holds {from}"
        );
        example_manifest().replacen(from, to, 1).into_bytes()
    }

    fn example_inputs() -> Vec<ArtifactInput<'static>> {
        vec![
            ArtifactInput {
                os: "linux",
                arch: "amd64",
                size: 15_204_352,
                sha256: "4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f",
            },
            ArtifactInput {
                os: "windows",
                arch: "amd64",
                size: 15_892_480,
                sha256: "25043433d22cf8f6f5ffb531abb6a0b0fe0952af2bb946586b5868b4bdf4e201",
            },
        ]
    }

    fn instant(text: &str) -> i64 {
        parse_instant(text).unwrap()
    }

    // ------------------------------------------------------------ the shared vectors

    /// What setup does with the bytes of `GET /agent/v1/release-keys` and the
    /// fingerprint an operator typed, built on `bundle_entry_matches`.
    fn pin_from_bundle(bytes: &[u8], wanted: &str) -> Result<Option<ReleaseKey>, KeyError> {
        let bundle: Value =
            serde_json::from_slice(bytes).map_err(|_| KeyError::new("the bundle is not JSON"))?;
        if bundle["schema"] != "vectory.release-keys.v1" {
            return Err(KeyError::new("the schema is not vectory.release-keys.v1"));
        }
        let entries = bundle["keys"]
            .as_array()
            .ok_or_else(|| KeyError::new("the bundle has no keys"))?;
        let mut found = None;
        for entry in entries {
            if !matches!(entry["state"].as_str(), Some("current" | "retired")) {
                return Err(KeyError::new("an entry's state is current or retired"));
            }
            let key = bundle_entry_matches(
                entry["public_key"].as_str().unwrap_or(""),
                entry["fingerprint"].as_str().unwrap_or(""),
            )?;
            if key.fingerprint() == wanted && found.is_none() {
                found = Some(key);
            }
        }
        Ok(found)
    }

    fn run_case(case: &Value, keys: &BTreeMap<String, ReleaseKey>) -> Result<Verified, Refusal> {
        let manifest = BASE64
            .decode(case["manifest_b64"].as_str().unwrap())
            .unwrap();
        let signatures = BASE64
            .decode(case["signatures_b64"].as_str().unwrap())
            .unwrap();
        let rollovers: Vec<RolloverEnvelope> = case["rollovers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|envelope| RolloverEnvelope {
                statement: envelope["statement_b64"].as_str().unwrap().to_owned(),
                signature: envelope["signature_b64"].as_str().unwrap().to_owned(),
            })
            .collect();
        let pins: Vec<ReleaseKey> = case["pins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|fingerprint| keys[fingerprint.as_str().unwrap()].clone())
            .collect();
        let floors: BTreeMap<String, u64> = case["floors"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(fingerprint, floor)| (fingerprint.clone(), floor.as_u64().unwrap()))
            .collect();
        let last = case["last"].as_object().map(|last| LastResult {
            release: last["release"].as_str().unwrap().to_owned(),
            outcome: Outcome::parse(last["outcome"].as_str().unwrap()).unwrap(),
        });
        verify_release(&VerifyInput {
            manifest: &manifest,
            signatures: &signatures,
            rollovers: &rollovers,
            pins: &pins,
            floors: &floors,
            last: last.as_ref(),
            running_version: case["running_version"].as_str().unwrap(),
            os: case["os"].as_str().unwrap(),
            arch: case["arch"].as_str().unwrap(),
            track: Track::parse(case["track"].as_str().unwrap()).unwrap(),
            service_definition: case["service_definition"].as_u64().unwrap(),
            now: instant(case["now"].as_str().unwrap()),
        })
    }

    fn strings(value: &Value) -> Vec<&str> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect()
    }

    #[test]
    fn shared_release_vectors() {
        let vectors = vectors();
        let keys: BTreeMap<String, ReleaseKey> = test_keys()
            .into_values()
            .map(|entry| (entry.key.fingerprint().to_owned(), entry.key))
            .collect();

        let key_lines = vectors["key_lines"].as_array().unwrap();
        for case in key_lines {
            let name = case["name"].as_str().unwrap();
            let line = case["line"].as_str().unwrap();
            let expect = &case["expect"];
            match ReleaseKey::parse(line) {
                Ok(key) => {
                    assert_eq!(expect["result"], "valid", "{name}: the line was accepted");
                    assert_eq!(key.fingerprint(), expect["fingerprint"].as_str().unwrap());
                    assert_eq!(key.name(), expect["name"].as_str().unwrap(), "{name}");
                    assert_eq!(key.line(), line, "{name}: the key writes its own line");
                }
                Err(error) => {
                    assert_eq!(expect["result"], "refused", "{name}: refused as {error}");
                    assert_eq!(error.code().as_str(), expect["code"].as_str().unwrap());
                }
            }
        }

        let bundles = vectors["bundles"].as_array().unwrap();
        for case in bundles {
            let name = case["name"].as_str().unwrap();
            let bytes = BASE64.decode(case["bundle_b64"].as_str().unwrap()).unwrap();
            let expect = &case["expect"];
            let wanted = case["fingerprint"].as_str().unwrap();
            match pin_from_bundle(&bytes, wanted) {
                Ok(Some(key)) => {
                    assert_eq!(expect["result"], "valid", "{name}: a key was pinned");
                    assert_eq!(key.line(), expect["public_key"].as_str().unwrap(), "{name}");
                }
                Ok(None) => assert_eq!(expect["result"], "absent", "{name}"),
                Err(error) => {
                    assert_eq!(expect["result"], "refused", "{name}: refused as {error}");
                    assert_eq!(error.code().as_str(), expect["code"].as_str().unwrap());
                }
            }
        }

        let cases = vectors["cases"].as_array().unwrap();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let expect = &case["expect"];
            match run_case(case, &keys) {
                Ok(verified) => {
                    assert_eq!(
                        expect["result"], "valid",
                        "{name}: the release was accepted"
                    );
                    assert_eq!(
                        verified.signer,
                        expect["signer"].as_str().unwrap(),
                        "{name}"
                    );
                    let pins_after: Vec<&str> = verified
                        .pins_after
                        .iter()
                        .map(ReleaseKey::fingerprint)
                        .collect();
                    assert_eq!(pins_after, strings(&expect["pins_after"]), "{name}");
                    let floors_after: BTreeMap<&str, u64> = verified
                        .floors_after
                        .iter()
                        .map(|(key, floor)| (key.as_str(), *floor))
                        .collect();
                    let wanted: BTreeMap<&str, u64> = expect["floors_after"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(key, floor)| (key.as_str(), floor.as_u64().unwrap()))
                        .collect();
                    assert_eq!(floors_after, wanted, "{name}");
                    assert_eq!(verified.artifact.os, case["os"].as_str().unwrap(), "{name}");
                }
                Err(refusal) => {
                    assert_eq!(expect["result"], "refused", "{name}: refused as {refusal}");
                    assert_eq!(
                        refusal.code.as_str(),
                        expect["code"].as_str().unwrap(),
                        "{name}: {refusal}"
                    );
                    let conflict = expect.get("rollover_conflict").map(|conflict| {
                        let to = strings(&conflict["to"]);
                        RolloverConflict {
                            from: conflict["from"].as_str().unwrap().to_owned(),
                            to: [to[0].to_owned(), to[1].to_owned()],
                        }
                    });
                    assert_eq!(refusal.conflict, conflict, "{name}");
                }
            }
        }

        // A file that lost cases would pass quietly otherwise.
        assert!(key_lines.len() >= 48, "{} key lines", key_lines.len());
        assert!(bundles.len() >= 13, "{} bundles", bundles.len());
        assert!(cases.len() >= 261, "{} cases", cases.len());
    }

    #[test]
    fn the_codes_are_the_ones_of_the_contract() {
        for code in Code::ALL {
            assert!(
                CONTRACT.contains(&format!("`{}`", code.as_str())),
                "{code} is not in the contract"
            );
            assert_eq!(Code::parse(code.as_str()), Some(code));
        }
        let names: BTreeSet<&str> = Code::ALL.iter().map(|code| code.as_str()).collect();
        assert_eq!(names.len(), Code::ALL.len());
        assert_eq!(Code::parse("key_not_pinned"), None);
        assert_eq!(Code::parse("NO_CHECK_IN"), None);
    }

    // ------------------------------------------------------------ the contract's examples

    #[test]
    fn the_contract_examples_are_read_signed_and_rebuilt_byte_for_byte() {
        let team = test_key("team");
        assert_eq!(
            ReleaseKey::parse(without_line_feed(EXAMPLE_KEY)).unwrap(),
            team.key
        );

        // The server's canonical form is the example, without its final line feed.
        let built = build_manifest(
            "0.1.1",
            7,
            instant("2026-10-03T12:00:00Z"),
            instant("2027-04-01T12:00:00Z"),
            Some("0.1.0"),
            1,
            &example_inputs(),
        )
        .unwrap();
        assert_eq!(built, example_manifest().as_bytes());
        assert_eq!(
            parse_manifest(EXAMPLE_RELEASE.as_bytes()).unwrap(),
            parse_manifest(&built).unwrap(),
            "a final line feed changes nothing but the bytes"
        );

        // Ed25519 is deterministic: signing the example gives the example's bytes.
        let entries = parse_signature_file(EXAMPLE_SIGNATURES.as_bytes()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, team.key.fingerprint());
        assert_eq!(sign(&team.seed, &built).unwrap(), entries[0].signature);
        assert_eq!(
            build_signature_file(&entries).unwrap(),
            without_line_feed(EXAMPLE_SIGNATURES).as_bytes()
        );
        assert!(verify_release_signature(
            &team.key,
            &built,
            &entries[0].signature
        ));

        // The host of the example story takes the release. The signature covers
        // the bytes without the example file's final line feed.
        let verified = Host::new(&[&team])
            .decide(built.as_slice(), EXAMPLE_SIGNATURES.as_bytes())
            .unwrap();
        assert_eq!(
            Host::new(&[&team])
                .decide(EXAMPLE_RELEASE.as_bytes(), EXAMPLE_SIGNATURES.as_bytes())
                .unwrap_err()
                .code,
            Code::SignatureInvalid,
            "a signature covers every byte, the final line feed too"
        );
        assert_eq!(verified.signer, team.key.fingerprint());
        assert_eq!(verified.artifact.file, "vectory-0.1.1-linux-amd64");
        assert_eq!(
            verified.manifest_sha256,
            "01e2380259f57e6f0a7b7b2fca2b5882fcec1cab1a94c9a1d0dc00703f0367c8"
        );
        assert_eq!(verified.floors_after[team.key.fingerprint()], 7);

        // The rollover statement and its envelope.
        let next = test_key("team-next");
        let statement = parse_statement(EXAMPLE_STATEMENT.as_bytes()).unwrap();
        assert_eq!(statement.from, team.key.fingerprint());
        assert_eq!(statement.to, next.key);
        assert_eq!(statement.issued_at, instant("2026-11-02T09:00:00Z"));
        let statement_bytes = without_line_feed(EXAMPLE_STATEMENT).as_bytes();
        assert_eq!(
            build_statement(team.key.fingerprint(), &next.key, statement.issued_at).unwrap(),
            statement_bytes
        );
        let envelope: RolloverEnvelope = serde_json::from_str(EXAMPLE_ENVELOPE).unwrap();
        let rollover = envelope.decode().unwrap();
        assert_eq!(rollover.statement_bytes(), statement_bytes);
        assert!(rollover.verify(&team.key));
        assert!(!rollover.verify(&next.key));
        assert_eq!(rollover.envelope(), envelope);
        assert_eq!(
            sign_rollover(&team.seed, statement_bytes)
                .unwrap()
                .as_slice(),
            BASE64.decode(&envelope.signature).unwrap()
        );

        // Following the example's statement moves the pin and the floor.
        let mut host = Host::new(&[&team]);
        host.floors.insert(team.key.fingerprint().to_owned(), 6);
        let chain = follow_rollovers(&host.pins, &host.floors, &[envelope]).unwrap();
        assert_eq!(
            chain.pins.keys().map(String::as_str).collect::<Vec<_>>(),
            [next.key.fingerprint()]
        );
        assert_eq!(
            chain.floors,
            BTreeMap::from([(next.key.fingerprint().to_owned(), 6)])
        );

        // The key bundle: every entry's member is the fingerprint of its key.
        let bundle: Value = serde_json::from_str(EXAMPLE_BUNDLE).unwrap();
        for entry in bundle["keys"].as_array().unwrap() {
            bundle_entry_matches(
                entry["public_key"].as_str().unwrap(),
                entry["fingerprint"].as_str().unwrap(),
            )
            .unwrap();
        }
    }

    // ------------------------------------------------------------ what the agent reads

    fn golden_manifest() -> Vec<u8> {
        build_manifest(
            "1.12.345",
            4_503_599_627_370_497,
            instant("2026-10-03T12:00:00Z"),
            instant("2027-04-01T12:00:00Z"),
            Some("1.12.0"),
            2,
            &[
                ArtifactInput {
                    os: "linux",
                    arch: "amd64",
                    size: 15_204_352,
                    sha256: "4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f",
                },
                ArtifactInput {
                    os: "linux",
                    arch: "arm64",
                    size: 1,
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                },
                ArtifactInput {
                    os: "darwin",
                    arch: "arm64",
                    size: 134_217_728,
                    sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                },
                ArtifactInput {
                    os: "windows",
                    arch: "amd64",
                    size: 15_892_480,
                    sha256: "25043433d22cf8f6f5ffb531abb6a0b0fe0952af2bb946586b5868b4bdf4e201",
                },
            ],
        )
        .unwrap()
    }

    /// The agent's tests parse this file with the Go parser and check every
    /// field. `VECTORY_UPDATE_GOLDEN=1 cargo test --lib agent_release` rewrites
    /// it from what the server builds now.
    #[test]
    fn rust_built_release_is_current() {
        let built = golden_manifest();
        if std::env::var("VECTORY_UPDATE_GOLDEN").is_ok_and(|value| !value.is_empty()) {
            std::fs::write(GOLDEN_FILE, &built).unwrap();
        }
        let stored = std::fs::read(GOLDEN_FILE).unwrap_or_else(|error| {
            panic!("{GOLDEN_FILE}: {error}; run with VECTORY_UPDATE_GOLDEN=1 to write it")
        });
        assert_eq!(
            String::from_utf8_lossy(&stored),
            String::from_utf8_lossy(&built),
            "the golden file is stale; run with VECTORY_UPDATE_GOLDEN=1 to rewrite it"
        );
        let parsed = parse_manifest(&stored).unwrap();
        assert_eq!(parsed.artifacts.len(), 4);
        assert_eq!(
            parsed.artifacts[3].file,
            "vectory-1.12.345-windows-amd64.exe"
        );
    }

    // ------------------------------------------------------------ the property test

    struct Random {
        running: Version,
        version: Version,
        counter: u64,
        issued_at: i64,
        expires_at: i64,
        min_from: Option<Version>,
        service_definition: u64,
        artifacts: Vec<(&'static str, &'static str, u64, String)>,
    }

    fn random_component(rng: &mut StdRng) -> u32 {
        match rng.gen_range(0..4) {
            0 => 0,
            1 => rng.gen_range(1..=20),
            2 => rng.gen_range(1..=999_999_999),
            _ => 999_999_998,
        }
    }

    fn random_release(rng: &mut StdRng) -> Random {
        let running = Version {
            major: random_component(rng),
            minor: random_component(rng),
            patch: random_component(rng),
        };
        let version = Version {
            patch: running.patch + 1,
            ..running
        };
        let counter = match rng.gen_range(0..4) {
            0 => 1,
            1 => MAX_COUNTER,
            _ => rng.gen_range(1..=MAX_COUNTER),
        };
        // The last second of the year 9999 is 253,402,300,799.
        let issued_at = rng.gen_range(0..=253_402_300_799 - MAX_VALIDITY_SECONDS);
        let expires_at = issued_at + rng.gen_range(1..=MAX_VALIDITY_SECONDS);
        let min_from = rng.gen_bool(0.5).then(|| Version {
            patch: running.patch.saturating_sub(rng.gen_range(0..=2)),
            ..running
        });
        let mut platforms: Vec<(&'static str, &'static str)> = OPERATING_SYSTEMS
            .iter()
            .flat_map(|os| ARCHITECTURES.iter().map(move |arch| (*os, *arch)))
            .collect();
        platforms.shuffle(rng);
        platforms.truncate(rng.gen_range(1..=6));
        let artifacts = platforms
            .into_iter()
            .map(|(os, arch)| {
                let mut digest = [0u8; 32];
                rng.fill_bytes(&mut digest);
                let size = match rng.gen_range(0..4) {
                    0 => 1,
                    1 => MAX_BUILD_BYTES,
                    _ => rng.gen_range(1..=MAX_BUILD_BYTES),
                };
                (os, arch, size, hex::encode(digest))
            })
            .collect();
        Random {
            running,
            version,
            counter,
            issued_at,
            expires_at,
            min_from,
            service_definition: rng.gen_range(1..=1000),
            artifacts,
        }
    }

    #[test]
    fn built_manifests_parse_verify_and_rebuild_to_the_same_bytes() {
        let mut rng = StdRng::seed_from_u64(0x5eed_0005);
        for round in 0..400 {
            let release = random_release(&mut rng);
            let inputs: Vec<ArtifactInput<'_>> = release
                .artifacts
                .iter()
                .map(|(os, arch, size, sha256)| ArtifactInput {
                    os,
                    arch,
                    size: *size,
                    sha256,
                })
                .collect();
            let min_from = release.min_from.map(|version| version.to_string());
            let bytes = build_manifest(
                &release.version.to_string(),
                release.counter,
                release.issued_at,
                release.expires_at,
                min_from.as_deref(),
                release.service_definition,
                &inputs,
            )
            .unwrap_or_else(|error| panic!("round {round}: {error}"));

            // Parsing gives back every input.
            let parsed = parse_manifest(&bytes).unwrap();
            assert_eq!(parsed.version, release.version, "round {round}");
            assert_eq!(parsed.counter, release.counter, "round {round}");
            assert_eq!(parsed.issued_at, release.issued_at, "round {round}");
            assert_eq!(parsed.expires_at, release.expires_at, "round {round}");
            assert_eq!(parsed.min_from, release.min_from, "round {round}");
            assert_eq!(parsed.service_definition, release.service_definition);
            assert_eq!(parsed.artifacts.len(), release.artifacts.len());
            for (artifact, (os, arch, size, sha256)) in
                parsed.artifacts.iter().zip(&release.artifacts)
            {
                assert_eq!((artifact.os.as_str(), artifact.arch.as_str()), (*os, *arch));
                assert_eq!((artifact.size, &artifact.sha256), (*size, sha256));
                assert_eq!(
                    artifact.file,
                    artifact_file_name(&release.version, os, arch),
                    "round {round}"
                );
            }

            // Rebuilding from the parsed manifest gives the same bytes.
            let rebuilt_inputs: Vec<ArtifactInput<'_>> = parsed
                .artifacts
                .iter()
                .map(|artifact| ArtifactInput {
                    os: &artifact.os,
                    arch: &artifact.arch,
                    size: artifact.size,
                    sha256: &artifact.sha256,
                })
                .collect();
            let rebuilt = build_manifest(
                &parsed.version.to_string(),
                parsed.counter,
                parsed.issued_at,
                parsed.expires_at,
                parsed
                    .min_from
                    .map(|version| version.to_string())
                    .as_deref(),
                parsed.service_definition,
                &rebuilt_inputs,
            )
            .unwrap();
            assert_eq!(rebuilt, bytes, "round {round}");

            // A host that pins the signing key takes it.
            let mut seed = [0u8; 32];
            rng.fill_bytes(&mut seed);
            let key = ReleaseKey::from_seed(&seed, "property").unwrap();
            let file = build_signature_file(&[SignatureEntry {
                key: key.fingerprint().to_owned(),
                signature: sign(&seed, &bytes).unwrap(),
            }])
            .unwrap();
            let first = &release.artifacts[0];
            let pins = [key.clone()];
            let floors = BTreeMap::new();
            let running = release.running.to_string();
            let input = VerifyInput {
                manifest: &bytes,
                signatures: &file,
                rollovers: &[],
                pins: &pins,
                floors: &floors,
                last: None,
                running_version: &running,
                os: first.0,
                arch: first.1,
                track: Track::Patch,
                service_definition: release.service_definition,
                now: release.issued_at + (release.expires_at - release.issued_at) / 2,
            };
            let verified =
                verify_release(&input).unwrap_or_else(|error| panic!("round {round}: {error}"));
            assert_eq!(verified.manifest, parsed, "round {round}");
            assert_eq!(verified.signer, key.fingerprint());
            assert_eq!(verified.floors_after[key.fingerprint()], release.counter);
            assert_eq!(verified.artifact.sha256, first.3);
            assert_eq!(verified.manifest_sha256, manifest_sha256(&bytes));

            // Any changed bit breaks the signature, whatever else it breaks.
            let mut changed = bytes.clone();
            let at = rng.gen_range(0..changed.len());
            changed[at] ^= 1 << rng.gen_range(0..8);
            let refusal = verify_release(&VerifyInput {
                manifest: &changed,
                ..input
            })
            .unwrap_err();
            assert_eq!(refusal.code, Code::SignatureInvalid, "round {round}");
        }
    }

    // ------------------------------------------------------------ the profile of the signed files

    #[test]
    fn the_example_is_accepted_and_every_pitfall_of_a_json_reader_is_refused() {
        assert!(parse_manifest(example_manifest().as_bytes()).is_ok());
        assert!(parse_manifest(EXAMPLE_RELEASE.as_bytes()).is_ok());

        // Numbers: whole decimal numbers up to 2^53 - 1, nothing else.
        for number in [
            "1e2",
            "1E2",
            "1e+2",
            "7.0",
            "7.",
            ".7",
            "-0",
            "-7",
            "+7",
            "07",
            "00",
            "0x7",
            "1_0",
            "7 7",
            "0.7",
            "9007199254740992",
            "18446744073709551616",
            "99999999999999999999999",
            "NaN",
            "Infinity",
            "\"7\"",
            "[7]",
            "{}",
        ] {
            for member in [
                "\"counter\":7",
                "\"service_definition\":1",
                "\"size\":15204352",
            ] {
                let name = member.split(':').next().unwrap();
                let bytes = changed(member, &format!("{name}:{number}"));
                assert!(parse_manifest(&bytes).is_err(), "{name} accepted {number}");
            }
        }
        assert!(parse_manifest(&changed("\"counter\":7", "\"counter\":9007199254740991")).is_ok());
        assert!(parse_manifest(&changed("\"counter\":7", "\"counter\":0")).is_err());

        // Literals: no null, even for the optional member, and no boolean.
        for (from, to) in [
            ("\"min_from\":\"0.1.0\"", "\"min_from\":null"),
            ("\"min_from\":\"0.1.0\"", "\"min_from\":true"),
            ("\"counter\":7", "\"counter\":null"),
            ("\"counter\":7", "\"counter\":true"),
            ("\"version\":\"0.1.1\"", "\"version\":false"),
            ("\"version\":\"0.1.1\"", "\"version\":null"),
        ] {
            assert!(parse_manifest(&changed(from, to)).is_err(), "{to}");
        }

        // The optional member is absent, never null.
        let without_minimum = changed("\"min_from\":\"0.1.0\",", "");
        assert_eq!(parse_manifest(&without_minimum).unwrap().min_from, None);

        // Strings: no escape sequence, however it spells the character.
        for (from, to) in [
            ("\"version\":\"0.1.1\"", "\"version\":\"0.1.\\u0031\""),
            ("\"version\":\"0.1.1\"", "\"version\":\"0.1.\\/1\""),
            ("\"os\":\"linux\"", "\"os\":\"lin\\u0075x\""),
            ("\"schema\":", "\"sch\\u0065ma\":"),
        ] {
            assert!(parse_manifest(&changed(from, to)).is_err(), "{to}");
        }

        // Members are matched exactly.
        for (from, to) in [
            ("\"schema\":", "\"Schema\":"),
            ("\"counter\":", "\"counter \":"),
            ("\"counter\":", "\"counter\":7,\"counter\":"),
            ("\"counter\":7", "\"counter\":7,\"extra\":1"),
            ("\"os\":\"linux\"", "\"os\":\"linux\",\"os\":\"linux\""),
            ("\"os\":\"linux\"", "\"os\":\"linux\",\"note\":\"x\""),
        ] {
            assert!(parse_manifest(&changed(from, to)).is_err(), "{to}");
        }

        // A struct is read from an object only: serde would also read it from
        // an array of its members in order.
        let as_arrays = br#"{"schema":"vectory.agent-release.v1","version":"0.1.1","counter":7,"issued_at":"2026-10-03T12:00:00Z","expires_at":"2027-04-01T12:00:00Z","service_definition":1,"artifacts":[["linux","amd64","executable","vectory-0.1.1-linux-amd64",15204352,"4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f"]]}"#;
        assert!(parse_manifest(as_arrays).is_err());
        let key = test_key("team").key;
        let signature = "92Djw+8q0PShRNfEeTrnmFmFFmfd/QA+Tc/tmfgVAh+hAMMtcEOYJAoAav8IQCXEql5SQcO3rdpCDDaQGqlbAA==";
        let as_array = format!(
            r#"{{"schema":"vectory.agent-release-signatures.v1","signatures":[["{}","{signature}"]]}}"#,
            key.fingerprint()
        );
        assert!(parse_signature_file(as_array.as_bytes()).is_err());
        let as_object = format!(
            r#"{{"schema":"vectory.agent-release-signatures.v1","signatures":[{{"key":"{}","signature":"{signature}"}}]}}"#,
            key.fingerprint()
        );
        assert!(parse_signature_file(as_object.as_bytes()).is_ok());
        assert!(parse_manifest(br#"["vectory.agent-release.v1"]"#).is_err());
        assert!(parse_statement(br#"["a","b","c","d"]"#).is_err());

        // Nothing outside the object, but one line feed.
        for tail in [" ", "\t", "\r\n", "\n\n", "\n ", "{}", ",", "\0"] {
            let mut bytes = example_manifest().as_bytes().to_vec();
            bytes.extend_from_slice(tail.as_bytes());
            assert!(parse_manifest(&bytes).is_err(), "{tail:?}");
        }
        for head in [" ", "\n", "\u{feff}", "\t"] {
            let bytes = format!("{head}{}", example_manifest());
            assert!(parse_manifest(bytes.as_bytes()).is_err(), "{head:?}");
        }

        // Bytes: printable ASCII only.
        for byte in [0x00u8, 0x09, 0x0b, 0x0d, 0x1f, 0x7f, 0x80, 0xc2, 0xff] {
            let mut bytes = example_manifest().as_bytes().to_vec();
            let at = bytes.iter().position(|byte| *byte == b':').unwrap();
            bytes.insert(at + 1, byte);
            assert!(parse_manifest(&bytes).is_err(), "{byte:#x}");
        }

        // Nesting that no member of the format has never reaches deep recursion.
        let deep = format!("{{\"schema\":{}{}}}", "[".repeat(5000), "]".repeat(5000));
        assert!(parse_manifest(deep.as_bytes()).is_err());
        let deep = format!("{{\"artifacts\":{}{}}}", "[".repeat(5000), "]".repeat(5000));
        assert!(parse_manifest(deep.as_bytes()).is_err());
        assert!(parse_manifest(&[b'{'; 16384]).is_err());
        assert!(parse_manifest(&[]).is_err());
        assert!(parse_manifest(b"\n").is_err());
        assert!(parse_manifest(b"{}").is_err());
    }

    #[test]
    fn members_may_come_in_any_order_and_spaces_may_stand_between_any_tokens() {
        let expected = parse_manifest(example_manifest().as_bytes()).unwrap();

        // Every member, and every member of an artifact, in sorted order.
        let sorted = serde_json::to_vec(
            &serde_json::from_slice::<Value>(example_manifest().as_bytes()).unwrap(),
        )
        .unwrap();
        assert!(sorted.starts_with(b"{\"artifacts\""));
        assert_eq!(parse_manifest(&sorted).unwrap(), expected);

        for text in [
            example_manifest(),
            without_line_feed(EXAMPLE_SIGNATURES),
            without_line_feed(EXAMPLE_STATEMENT),
        ] {
            let mut spaced = String::new();
            let mut in_string = false;
            for character in text.chars() {
                if character == '"' {
                    in_string = !in_string;
                }
                if !in_string && matches!(character, '{' | '}' | '[' | ']' | ':' | ',') {
                    spaced.extend([' ', character, ' ']);
                } else {
                    spaced.push(character);
                }
            }
            let spaced = spaced.trim();
            assert_ne!(spaced, text);
            if text.contains("agent-release.v1") {
                assert_eq!(parse_manifest(spaced.as_bytes()).unwrap(), expected);
            } else if text.contains("signatures") {
                assert_eq!(
                    parse_signature_file(spaced.as_bytes()).unwrap(),
                    parse_signature_file(text.as_bytes()).unwrap()
                );
            } else {
                assert_eq!(
                    parse_statement(spaced.as_bytes()).unwrap(),
                    parse_statement(text.as_bytes()).unwrap()
                );
            }
        }
    }

    #[test]
    fn sizes_have_their_own_bounds() {
        // The example, padded with spaces inside its braces to `length` bytes.
        let object = |length: usize| {
            let mut bytes = example_manifest().as_bytes().to_vec();
            bytes.pop();
            bytes.resize(length - 1, b' ');
            bytes.push(b'}');
            assert_eq!(bytes.len(), length);
            bytes
        };
        assert!(parse_manifest(&object(MAX_MANIFEST_BYTES)).is_ok());
        assert!(parse_manifest(&object(MAX_MANIFEST_BYTES + 1)).is_err());
        // The final line feed counts toward the limit.
        let mut with_feed = object(MAX_MANIFEST_BYTES - 1);
        with_feed.push(b'\n');
        assert!(parse_manifest(&with_feed).is_ok());
        let mut with_feed = object(MAX_MANIFEST_BYTES);
        with_feed.push(b'\n');
        assert!(parse_manifest(&with_feed).is_err());

        // The signature file and the statement have their own limits.
        let team = test_key("team");
        let signature = BASE64.encode([1u8; 64]);
        let file = |padding: usize| {
            format!(
                "{{\"schema\":\"vectory.agent-release-signatures.v1\",\"signatures\":[{{\"key\":\"{}\",\"signature\":\"{signature}\"}}]{}}}",
                team.key.fingerprint(),
                " ".repeat(padding)
            )
        };
        let base = file(0).len();
        assert!(parse_signature_file(file(MAX_SIGNATURE_FILE_BYTES - base).as_bytes()).is_ok());
        assert!(
            parse_signature_file(file(MAX_SIGNATURE_FILE_BYTES - base + 1).as_bytes()).is_err()
        );
        let statement = without_line_feed(EXAMPLE_STATEMENT);
        let padded = |padding: usize| {
            format!(
                "{}{}}}",
                &statement[..statement.len() - 1],
                " ".repeat(padding)
            )
        };
        let room = MAX_STATEMENT_BYTES - statement.len();
        assert!(parse_statement(padded(room).as_bytes()).is_ok());
        assert!(parse_statement(padded(room + 1).as_bytes()).is_err());
    }

    // ------------------------------------------------------------ keys and points

    #[test]
    fn the_eight_points_of_small_order_are_not_keys_and_their_aliases_are_not_either() {
        let mut p = [0xffu8; 32];
        p[0] = 0xed;
        p[31] = 0x7f;
        let small_order = [
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000080",
            "0100000000000000000000000000000000000000000000000000000000000000",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        ];
        for encoding in small_order {
            let bytes: [u8; 32] = hex::decode(encoding).unwrap().try_into().unwrap();
            assert!(
                ReleaseKey::from_public_bytes(&bytes, "small").is_err(),
                "{encoding}"
            );
            assert!(large_order_point(&bytes).is_none(), "{encoding}");
        }
        // y = p and y = p + 1 with each sign bit: the same points as y = 0 and 1.
        for offset in 0..19u8 {
            for sign in [0u8, 0x80] {
                let mut bytes = p;
                bytes[0] += offset;
                bytes[31] |= sign;
                assert!(
                    large_order_point(&bytes).is_none(),
                    "p + {offset} with sign {sign:#x}"
                );
            }
        }
        // The base point, and a point of large order with a small y.
        let base = ReleaseKey::parse(
            "vectory-release-key ed25519 WGZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmY= test",
        )
        .unwrap();
        assert_eq!(base.short_id(), "cb05c9fac26332f9");
    }

    #[test]
    fn the_group_order_bounds_s() {
        assert!(!below_group_order(&GROUP_ORDER));
        let mut below = GROUP_ORDER;
        below[0] -= 1;
        assert!(below_group_order(&below));
        let mut above = GROUP_ORDER;
        above[0] += 1;
        assert!(!below_group_order(&above));
        assert!(below_group_order(&[0; 32]));
        assert!(!below_group_order(&[0xff; 32]));
        // 2^252 is below the order, which is 2^252 plus a 125-bit number, and
        // 2^253 is above it; a high byte decides before any low byte can.
        let mut high = [0u8; 32];
        high[31] = 0x10;
        assert!(below_group_order(&high));
        high[31] = 0x20;
        assert!(!below_group_order(&high));
        high[31] = 0x0f;
        high[0] = 0xff;
        assert!(below_group_order(&high));
    }

    #[test]
    fn a_signature_is_strict_in_s_and_r() {
        let team = test_key("team");
        let manifest = example_manifest().as_bytes();
        let signature = sign(&team.seed, manifest).unwrap();
        assert!(verify_release_signature(&team.key, manifest, &signature));

        // S plus the group order is the same scalar, which a lax verifier takes.
        let mut s_plus_order = signature;
        let mut carry = 0u16;
        for (byte, order) in s_plus_order[32..].iter_mut().zip(GROUP_ORDER) {
            let sum = u16::from(*byte) + u16::from(order) + carry;
            *byte = sum as u8;
            carry = sum >> 8;
        }
        assert_eq!(carry, 0, "the sum fits in 256 bits");
        assert!(!verify_release_signature(
            &team.key,
            manifest,
            &s_plus_order
        ));

        // R as the identity point, and R in a non-canonical encoding.
        let mut identity = signature;
        identity[..32].fill(0);
        identity[0] = 1;
        assert!(!verify_release_signature(&team.key, manifest, &identity));
        let mut alias = signature;
        alias[31] |= 0x80;
        assert!(!verify_release_signature(&team.key, manifest, &alias));

        // Another key's signature, another message, another prefix.
        let other = test_key("outsider");
        assert!(!verify_release_signature(&other.key, manifest, &signature));
        assert!(!verify_release_signature(
            &team.key,
            &manifest[1..],
            &signature
        ));
        assert!(!verify_prefixed(
            &team.key,
            ROLLOVER_PREFIX,
            manifest,
            &signature
        ));
        let rollover_signed = sign_prefixed(&team.seed, ROLLOVER_PREFIX, manifest);
        assert!(!verify_release_signature(
            &team.key,
            manifest,
            &rollover_signed
        ));
    }

    #[test]
    fn a_key_line_and_a_key_agree() {
        let team = test_key("team");
        assert_eq!(team.key.name(), "team");
        assert_eq!(team.key.short_id(), &team.key.fingerprint()[..16]);
        assert_eq!(team.key.to_string(), team.key.line());
        assert_eq!(team.key.public_bytes().len(), 32);
        assert_eq!(
            hex::encode(Sha256::digest(team.key.public_bytes())),
            team.key.fingerprint()
        );
        // The same bytes under another name are the same fingerprint.
        let renamed = ReleaseKey::from_public_bytes(team.key.public_bytes(), "renamed").unwrap();
        assert_eq!(renamed.fingerprint(), team.key.fingerprint());
        assert_ne!(renamed, team.key);
        for name in [
            "",
            " a",
            "a ",
            "a\"b",
            "a\\b",
            "caf\u{e9}",
            "a\nb",
            &"n".repeat(65),
        ] {
            assert!(
                ReleaseKey::from_public_bytes(team.key.public_bytes(), name).is_err(),
                "{name:?}"
            );
        }
        // A generated seed makes a valid key that signs.
        let seed = generate_seed();
        assert_ne!(seed, generate_seed());
        let key = ReleaseKey::from_seed(&seed, "generated").unwrap();
        assert_eq!(ReleaseKey::parse(&key.line()).unwrap(), key);
    }

    #[test]
    fn a_bundle_entry_names_the_fingerprint_of_its_key_and_no_other() {
        for (name, entry) in test_keys() {
            let line = entry.key.line();
            assert_eq!(
                bundle_entry_matches(&line, entry.key.fingerprint()).unwrap(),
                entry.key,
                "{name}"
            );
            assert!(bundle_entry_matches(&line, &entry.key.fingerprint().to_uppercase()).is_err());
            assert!(bundle_entry_matches(&line, &entry.key.fingerprint()[..63]).is_err());
            assert!(bundle_entry_matches(&line, "").is_err());
            let other = test_keys()
                .into_values()
                .find(|other| other.key.fingerprint() != entry.key.fingerprint())
                .unwrap();
            let error = bundle_entry_matches(&line, other.key.fingerprint()).unwrap_err();
            assert_eq!(error.code(), Code::ReleaseKeyInvalid, "{name}");
        }
        // A fingerprint that is right does not rescue a key that is not one.
        let small =
            "vectory-release-key ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= small";
        let fingerprint = hex::encode(Sha256::digest([0u8; 32]));
        assert!(bundle_entry_matches(small, &fingerprint).is_err());
    }

    // ------------------------------------------------------------ instants and versions

    #[test]
    fn instants_are_whole_seconds_in_utc_and_nothing_else() {
        assert_eq!(parse_instant("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_instant("2026-10-03T12:00:00Z"), Some(1_791_028_800));
        assert_eq!(parse_instant("9999-12-31T23:59:59Z"), Some(253_402_300_799));
        assert_eq!(parse_instant("2028-02-29T00:00:00Z"), Some(1_835_395_200));
        for text in [
            "",
            "2026-10-03",
            "2026-10-03T12:00Z",
            "2026-10-03T12:00:00",
            "2026-10-03T12:00:00z",
            "2026-10-03t12:00:00Z",
            "2026-10-03 12:00:00Z",
            "2026-10-03T12:00:00+00:00",
            "2026-10-03T12:00:00.000Z",
            "2026-10-03T12:00:00 Z",
            " 2026-10-03T12:00:00Z",
            "2026-10-03T12:00:00Z ",
            "2026-02-30T00:00:00Z",
            "2025-02-29T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-00-10T00:00:00Z",
            "2026-01-00T00:00:00Z",
            "2026-01-32T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:60:00Z",
            "2026-01-01T00:00:60Z",
            "1969-12-31T23:59:59Z",
            "+026-10-03T12:00:00Z",
            "2026-10-0\u{663}T12:00:00Z",
            "\u{662}026-10-03T12:00:00Z",
        ] {
            assert_eq!(parse_instant(text), None, "{text:?}");
        }
        assert!(parse_instant("2000-02-29T00:00:00Z").is_some());
        assert_eq!(format_instant(-1), None);
        assert_eq!(format_instant(253_402_300_800), None);
        assert_eq!(
            format_instant(253_402_300_799).as_deref(),
            Some("9999-12-31T23:59:59Z")
        );
    }

    #[test]
    fn instants_agree_with_chrono_for_every_second_sampled() {
        let mut rng = StdRng::seed_from_u64(0x5eed_0006);
        let mut samples = vec![
            0,
            1,
            86_399,
            86_400,
            951_782_400,
            4_107_542_400,
            253_402_300_799,
        ];
        samples.extend((0..20_000).map(|_| rng.gen_range(0..=253_402_300_799i64)));
        for seconds in samples {
            let expected = chrono::DateTime::from_timestamp(seconds, 0)
                .unwrap()
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string();
            assert_eq!(format_instant(seconds).as_deref(), Some(expected.as_str()));
            assert_eq!(parse_instant(&expected), Some(seconds), "{expected}");
        }
    }

    #[test]
    fn versions_are_three_canonical_numbers_that_compare_as_numbers() {
        let version = |text: &str| Version::parse(text).unwrap();
        assert!(version("0.1.10") > version("0.1.9"));
        assert!(version("1.0.0") > version("0.999999999.999999999"));
        assert!(version("0.0.0") < version("0.0.1"));
        assert_eq!(version("999999999.0.7").to_string(), "999999999.0.7");
        for text in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "1.2.-3",
            "+1.2.3",
            "1.2.3-rc.1",
            "1.2.3+build",
            "v1.2.3",
            " 1.2.3",
            "1.2.3 ",
            "1..3",
            ".1.2",
            "1.2.",
            "1.2.1000000000",
            "1.2.3\n",
            "1.2.\u{663}",
            "a.b.c",
            "1.2.0x3",
        ] {
            assert_eq!(Version::parse(text), None, "{text:?}");
        }
        assert_eq!(Track::parse("patch"), Some(Track::Patch));
        assert_eq!(Track::parse("minor"), Some(Track::Minor));
        assert_eq!(Track::parse("major"), None);
        assert_eq!(Track::parse("Patch"), None);
        for outcome in [
            Outcome::Committed,
            Outcome::RolledBack,
            Outcome::Failed,
            Outcome::Refused,
        ] {
            assert_eq!(Outcome::parse(outcome.as_str()), Some(outcome));
        }
        assert_eq!(Outcome::parse("success"), None);
    }

    // ------------------------------------------------------------ building

    #[test]
    fn a_manifest_that_no_host_would_accept_is_never_built() {
        let inputs = example_inputs();
        let build = |version: &str,
                     counter: u64,
                     issued: &str,
                     expires: &str,
                     min_from: Option<&str>,
                     definition: u64,
                     artifacts: &[ArtifactInput<'_>]| {
            build_manifest(
                version,
                counter,
                instant(issued),
                instant(expires),
                min_from,
                definition,
                artifacts,
            )
        };
        let (issued, expires) = ("2026-10-03T12:00:00Z", "2027-04-01T12:00:00Z");
        assert!(build("0.1.1", 7, issued, expires, None, 1, &inputs).is_ok());
        assert!(build("0.1.1", 7, issued, expires, Some("0.1.0"), 1, &inputs).is_ok());
        for version in ["0.1", "0.1.1-rc.1", "01.1.1", "", "0.1.1 "] {
            assert!(
                build(version, 7, issued, expires, None, 1, &inputs).is_err(),
                "{version:?}"
            );
        }
        assert!(build("0.1.1", 0, issued, expires, None, 1, &inputs).is_err());
        assert!(build("0.1.1", MAX_COUNTER + 1, issued, expires, None, 1, &inputs).is_err());
        assert!(build("0.1.1", 7, expires, issued, None, 1, &inputs).is_err());
        assert!(build("0.1.1", 7, issued, issued, None, 1, &inputs).is_err());
        assert!(build("0.1.1", 7, issued, "2027-11-07T12:00:01Z", None, 1, &inputs).is_err());
        assert!(build("0.1.1", 7, issued, "2027-11-07T12:00:00Z", None, 1, &inputs).is_ok());
        assert!(build("0.1.1", 7, issued, expires, Some("0.1"), 1, &inputs).is_err());
        assert!(build("0.1.1", 7, issued, expires, None, 0, &inputs).is_err());
        assert!(build("0.1.1", 7, issued, expires, None, 1, &[]).is_err());
        let duplicate = [inputs[0], inputs[0]];
        assert!(build("0.1.1", 7, issued, expires, None, 1, &duplicate).is_err());
        let nine: Vec<ArtifactInput<'_>> = (0..9)
            .map(|index| ArtifactInput {
                os: ["linux", "darwin", "windows"][index % 3],
                arch: ["amd64", "arm64"][index % 2],
                ..inputs[0]
            })
            .collect();
        assert!(build("0.1.1", 7, issued, expires, None, 1, &nine).is_err());
        for (os, arch, size, sha256) in [
            ("plan9", "amd64", 1, inputs[0].sha256),
            ("linux", "x86_64", 1, inputs[0].sha256),
            ("linux", "amd64", 0, inputs[0].sha256),
            ("linux", "amd64", MAX_BUILD_BYTES + 1, inputs[0].sha256),
            (
                "linux",
                "amd64",
                1,
                "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            ),
            ("linux", "amd64", 1, "abcdef"),
        ] {
            let artifacts = [ArtifactInput {
                os,
                arch,
                size,
                sha256,
            }];
            assert!(
                build("0.1.1", 7, issued, expires, None, 1, &artifacts).is_err(),
                "{os} {arch} {size} {sha256}"
            );
        }
        // Instants outside the years the format holds.
        assert!(build_manifest("0.1.1", 7, -1, 100, None, 1, &inputs).is_err());
        assert!(build_manifest("0.1.1", 7, 0, 253_402_300_800, None, 1, &inputs).is_err());
        // The file names follow the platform.
        let manifest =
            parse_manifest(&build("0.1.1", 7, issued, expires, None, 1, &inputs).unwrap()).unwrap();
        assert_eq!(
            manifest.artifact_for("windows", "amd64").unwrap().file,
            "vectory-0.1.1-windows-amd64.exe"
        );
        assert_eq!(
            manifest.artifact_for("linux", "amd64").unwrap().file,
            "vectory-0.1.1-linux-amd64"
        );
        assert!(manifest.artifact_for("linux", "arm64").is_none());
        assert!(manifest.artifact_for("Linux", "amd64").is_none());
    }

    #[test]
    fn a_key_signs_only_what_a_host_could_read() {
        let team = test_key("team");
        assert!(sign(&team.seed, example_manifest().as_bytes()).is_ok());
        assert!(sign(&team.seed, b"{}").is_err());
        assert!(sign(&team.seed, b"").is_err());
        assert!(sign(&team.seed, &changed("\"counter\":7", "\"counter\":7.0")).is_err());
        assert!(sign_rollover(&team.seed, example_manifest().as_bytes()).is_err());
        assert!(sign_rollover(&team.seed, without_line_feed(EXAMPLE_STATEMENT).as_bytes()).is_ok());
        assert!(sign_rollover(&team.seed, b"{}").is_err());
    }

    // ------------------------------------------------------------ the signature file

    #[test]
    fn an_uploaded_signature_must_name_the_current_key_and_verify() {
        let team = test_key("team");
        let outsider = test_key("outsider");
        let manifest = example_manifest().as_bytes();
        let by_team = signature_file_of(&team, manifest);
        assert!(check_signature_file(manifest, &by_team, &team.key).is_ok());

        // Another key's file, or a file for another manifest, is refused.
        let refused = check_signature_file(manifest, &by_team, &outsider.key).unwrap_err();
        assert_eq!(refused.code, Code::SignatureInvalid);
        let other_manifest = changed("\"counter\":7", "\"counter\":8");
        assert!(check_signature_file(&other_manifest, &by_team, &team.key).is_err());
        assert!(check_signature_file(manifest, b"", &team.key).is_err());
        assert!(check_signature_file(manifest, b"not json", &team.key).is_err());

        // An entry that names the key with another key's signature is refused.
        let forged = build_signature_file(&[SignatureEntry {
            key: team.key.fingerprint().to_owned(),
            signature: sign_prefixed(&outsider.seed, RELEASE_PREFIX, manifest),
        }])
        .unwrap();
        assert!(check_signature_file(manifest, &forged, &team.key).is_err());

        // Entries for other keys come along and are not checked.
        let together = build_signature_file(&[
            SignatureEntry {
                key: outsider.key.fingerprint().to_owned(),
                signature: [7; 64],
            },
            SignatureEntry {
                key: team.key.fingerprint().to_owned(),
                signature: sign_prefixed(&team.seed, RELEASE_PREFIX, manifest),
            },
        ])
        .unwrap();
        assert!(check_signature_file(manifest, &together, &team.key).is_ok());

        // Building refuses what a reader would.
        assert!(build_signature_file(&[]).is_err());
        let entry = SignatureEntry {
            key: team.key.fingerprint().to_owned(),
            signature: [0; 64],
        };
        assert!(build_signature_file(&[entry.clone(), entry.clone()]).is_err());
        let five: Vec<SignatureEntry> = test_keys()
            .into_values()
            .take(5)
            .map(|key| SignatureEntry {
                key: key.key.fingerprint().to_owned(),
                signature: [0; 64],
            })
            .collect();
        assert!(build_signature_file(&five).is_err());
        assert!(build_signature_file(&five[..4]).is_ok());
        let upper = SignatureEntry {
            key: team.key.fingerprint().to_uppercase(),
            signature: [0; 64],
        };
        assert!(build_signature_file(&[upper]).is_err());
    }

    // ------------------------------------------------------------ rollovers

    fn statement_between(from: &TestKey, to: &TestKey) -> RolloverEnvelope {
        let statement = build_statement(
            from.key.fingerprint(),
            &to.key,
            instant("2026-11-02T09:00:00Z"),
        )
        .unwrap();
        let signature = sign_rollover(&from.seed, &statement).unwrap();
        RolloverEnvelope::new(&statement, &signature)
    }

    #[test]
    fn a_statement_is_malformed_or_names_a_key_that_is_not_one() {
        let team = test_key("team");
        let next = test_key("team-next");
        let envelope = statement_between(&team, &next);
        let rollover = envelope.decode().unwrap();
        assert!(rollover.verify(&team.key));
        assert_eq!(rollover.statement.to, next.key);
        assert_eq!(rollover.envelope(), envelope);

        let signature = BASE64.decode(&envelope.signature).unwrap();
        let statement = BASE64.decode(&envelope.statement).unwrap();
        let wrap = |statement: &[u8]| {
            Rollover::from_base64(&BASE64.encode(statement), &envelope.signature)
        };
        let small =
            "vectory-release-key ed25519 AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= small";
        let with_to = |to: &str| {
            let text = String::from_utf8(statement.clone()).unwrap();
            text.replace(&next.key.line(), to).into_bytes()
        };
        assert!(matches!(
            wrap(&with_to(small)),
            Err(RolloverError::KeyInvalid(_))
        ));
        assert!(matches!(
            wrap(&with_to("not a key")),
            Err(RolloverError::KeyInvalid(_))
        ));
        let itself = with_to(&team.key.line());
        assert!(matches!(wrap(&itself), Err(RolloverError::Malformed(_))));
        let other_schema = String::from_utf8(statement.clone())
            .unwrap()
            .replace("rollover.v1", "rollover.v2")
            .into_bytes();
        assert!(matches!(
            wrap(&other_schema),
            Err(RolloverError::Malformed(_))
        ));
        let upper = String::from_utf8(statement.clone())
            .unwrap()
            .replace(
                team.key.fingerprint(),
                &team.key.fingerprint().to_uppercase(),
            )
            .into_bytes();
        assert!(matches!(wrap(&upper), Err(RolloverError::Malformed(_))));
        let mut padded = statement.clone();
        padded.insert(padded.len() - 1, b' ');
        padded.pop();
        padded.extend_from_slice(&[b' '; MAX_STATEMENT_BYTES]);
        padded.push(b'}');
        assert!(matches!(wrap(&padded), Err(RolloverError::Malformed(_))));

        // The encodings are strict.
        let good = &envelope.statement;
        assert!(Rollover::from_base64(&good[..good.len() - 1], &envelope.signature).is_err());
        assert!(Rollover::from_base64(&format!(" {good}"), &envelope.signature).is_err());
        let url_alphabet = envelope.signature.replace('+', "-").replace('/', "_");
        assert_ne!(
            url_alphabet, envelope.signature,
            "the example signature uses both"
        );
        assert!(Rollover::from_base64(good, &url_alphabet).is_err());
        assert!(Rollover::from_base64(good, &BASE64.encode(&signature[..63])).is_err());
        assert!(
            Rollover::from_base64(good, &BASE64.encode([&signature[..], &[0]].concat())).is_err()
        );
        assert!(Rollover::from_base64(good, "").is_err());
        assert!(Rollover::from_base64("", &envelope.signature).is_err());
        assert!(
            Rollover::from_base64(&"A".repeat(MAX_STATEMENT_BASE64 + 4), &envelope.signature)
                .is_err()
        );

        // A signature verifies only under the key the statement names, and only
        // for a key that is that one.
        assert!(!rollover.verify(&next.key));
        let forged = Rollover::from_base64(
            &envelope.statement,
            &BASE64.encode(sign_prefixed(&next.seed, ROLLOVER_PREFIX, &statement)),
        )
        .unwrap();
        assert!(!forged.verify(&team.key));
        let release_signature = sign_prefixed(&team.seed, RELEASE_PREFIX, &statement);
        let wrong_prefix =
            Rollover::from_base64(&envelope.statement, &BASE64.encode(release_signature)).unwrap();
        assert!(!wrong_prefix.verify(&team.key));

        // The envelope is the wire shape, with no other member.
        assert!(
            serde_json::from_str::<RolloverEnvelope>(r#"{"statement":"","signature":"","x":1}"#)
                .is_err()
        );
        assert_eq!(
            serde_json::to_string(&envelope).unwrap(),
            format!(
                r#"{{"statement":"{}","signature":"{}"}}"#,
                envelope.statement, envelope.signature
            )
        );
    }

    #[test]
    fn a_chain_moves_pins_and_floors_and_a_fork_names_both_successors() {
        let (a, b, c) = (
            test_key("chain-0"),
            test_key("chain-1"),
            test_key("chain-2"),
        );
        let fingerprint = |key: &TestKey| key.key.fingerprint().to_owned();
        let mut host = Host::new(&[&a]);
        host.floors = BTreeMap::from([
            (fingerprint(&a), 5),
            (fingerprint(&test_key("outsider")), 99),
        ]);

        let ab = statement_between(&a, &b);
        let bc = statement_between(&b, &c);
        let chain = follow_rollovers(&host.pins, &host.floors, &[ab.clone(), bc.clone()]).unwrap();
        assert_eq!(chain.pins.keys().collect::<Vec<_>>(), [&fingerprint(&c)]);
        assert_eq!(chain.floors.get(&fingerprint(&c)), Some(&5));
        assert!(!chain.floors.contains_key(&fingerprint(&a)));
        assert_eq!(
            chain.floors.get(&fingerprint(&test_key("outsider"))),
            Some(&99)
        );

        // Out of order, a statement from a key not yet pinned is ignored.
        let chain = follow_rollovers(&host.pins, &host.floors, &[bc.clone(), ab.clone()]).unwrap();
        assert_eq!(chain.pins.keys().collect::<Vec<_>>(), [&fingerprint(&b)]);

        // A repeated statement is followed once; one from the replaced key is ignored.
        let ac = statement_between(&a, &c);
        let chain = follow_rollovers(&host.pins, &host.floors, &[ab.clone(), ab.clone()]).unwrap();
        assert_eq!(chain.pins.keys().collect::<Vec<_>>(), [&fingerprint(&b)]);
        let late = follow_rollovers(
            &host.pins,
            &host.floors,
            &[ab.clone(), bc.clone(), ac.clone()],
        );
        assert_eq!(
            late.unwrap_err().code,
            Code::KeyRolloverConflict,
            "A to C after A to B is a fork, even though B moved on"
        );

        // A fork names its pinned key and the two successors, in order.
        for (first, second) in [(&ab, &ac), (&ac, &ab)] {
            let refusal =
                follow_rollovers(&host.pins, &host.floors, &[first.clone(), second.clone()])
                    .unwrap_err();
            assert_eq!(refusal.code, Code::KeyRolloverConflict);
            let mut successors = [fingerprint(&b), fingerprint(&c)];
            successors.sort();
            assert_eq!(
                refusal.conflict,
                Some(RolloverConflict {
                    from: fingerprint(&a),
                    to: successors
                })
            );
        }

        // A statement that does not verify under the pinned key is no fork.
        let forged = {
            let statement =
                build_statement(&fingerprint(&a), &c.key, instant("2026-11-02T09:00:00Z")).unwrap();
            RolloverEnvelope::new(
                &statement,
                &sign_prefixed(&c.seed, ROLLOVER_PREFIX, &statement),
            )
        };
        let chain = follow_rollovers(&host.pins, &host.floors, &[ab.clone(), forged]).unwrap();
        assert_eq!(chain.pins.keys().collect::<Vec<_>>(), [&fingerprint(&b)]);

        // At most eight statements.
        assert!(follow_rollovers(&host.pins, &host.floors, &vec![ab.clone(); 8]).is_ok());
        let refusal = follow_rollovers(&host.pins, &host.floors, &vec![ab; 9]).unwrap_err();
        assert_eq!(refusal.code, Code::ManifestInvalid);
    }

    // ------------------------------------------------------------ the decision beyond the vectors

    #[test]
    fn the_last_result_decides_only_between_a_replay_and_a_retry() {
        let team = test_key("team");
        let manifest = example_manifest().as_bytes();
        let signatures = signature_file_of(&team, manifest);
        let digest = manifest_sha256(manifest);
        let mut host = Host::new(&[&team]);
        host.floors.insert(team.key.fingerprint().to_owned(), 7);
        let code = |host: &Host| host.decide(manifest, &signatures).unwrap_err().code;
        assert_eq!(code(&host), Code::CounterReplayed);
        for (release, outcome, wanted) in [
            (
                digest.as_str(),
                Outcome::RolledBack,
                Code::ReleaseAlreadyTried,
            ),
            (digest.as_str(), Outcome::Committed, Code::CounterReplayed),
            (digest.as_str(), Outcome::Failed, Code::CounterReplayed),
            (digest.as_str(), Outcome::Refused, Code::CounterReplayed),
            (&"0".repeat(64), Outcome::RolledBack, Code::CounterReplayed),
        ] {
            host.last = Some(LastResult {
                release: release.to_owned(),
                outcome,
            });
            assert_eq!(code(&host), wanted, "{release} {outcome:?}");
        }
        // Without a floor at the counter the last result changes nothing.
        host.floors.insert(team.key.fingerprint().to_owned(), 6);
        host.last = Some(LastResult {
            release: digest,
            outcome: Outcome::RolledBack,
        });
        assert!(host.decide(manifest, &signatures).is_ok());
    }

    #[test]
    fn a_running_version_that_is_not_a_release_version_is_never_guessed() {
        let team = test_key("team");
        let manifest = example_manifest().as_bytes();
        let signatures = signature_file_of(&team, manifest);
        for running in ["0.1.0-dev", "dev", "", "0.1", "0.1.0+build"] {
            let mut host = Host::new(&[&team]);
            host.running_version = Box::leak(running.to_owned().into_boxed_str());
            let refusal = host.decide(manifest, &signatures).unwrap_err();
            assert_eq!(refusal.code, Code::VersionNotOnTrack, "{running:?}");
        }
    }

    #[test]
    fn the_track_and_the_minimum_gate_after_the_version() {
        let team = test_key("team");
        let build = |version: &str, min_from: Option<&str>| {
            let manifest = build_manifest(
                version,
                7,
                instant("2026-10-03T12:00:00Z"),
                instant("2027-04-01T12:00:00Z"),
                min_from,
                1,
                &example_inputs(),
            )
            .unwrap();
            let signatures = signature_file_of(&team, &manifest);
            (manifest, signatures)
        };
        let mut host = Host::new(&[&team]);
        host.running_version = "0.1.4";
        for (version, track, wanted) in [
            ("0.1.5", Track::Patch, None),
            ("0.1.99", Track::Patch, None),
            ("0.2.0", Track::Patch, Some(Code::VersionNotOnTrack)),
            ("1.0.0", Track::Patch, Some(Code::VersionNotOnTrack)),
            ("0.2.0", Track::Minor, None),
            ("0.99.0", Track::Minor, None),
            ("1.0.0", Track::Minor, Some(Code::VersionNotOnTrack)),
            ("0.1.4", Track::Minor, Some(Code::AlreadyRunning)),
            ("0.1.3", Track::Minor, Some(Code::DowngradeRefused)),
            ("0.0.9", Track::Patch, Some(Code::DowngradeRefused)),
        ] {
            host.track = track;
            let (manifest, signatures) = build(version, None);
            let result = host
                .decide(&manifest, &signatures)
                .map(|_| ())
                .map_err(|r| r.code);
            assert_eq!(result.err(), wanted, "{version} on {track:?}");
        }
        host.track = Track::Patch;
        let (manifest, signatures) = build("0.1.5", Some("0.1.4"));
        assert!(host.decide(&manifest, &signatures).is_ok());
        let (manifest, signatures) = build("0.1.5", Some("0.1.5"));
        assert_eq!(
            host.decide(&manifest, &signatures).unwrap_err().code,
            Code::AgentTooOld
        );
        host.service_definition = 0;
        let (manifest, signatures) = build("0.1.5", None);
        assert_eq!(
            host.decide(&manifest, &signatures).unwrap_err().code,
            Code::ServiceDefinitionOutdated
        );
    }

    #[test]
    fn two_signers_each_have_their_floor_raised_and_either_one_can_refuse() {
        let (team, project) = (test_key("team"), test_key("project"));
        let manifest = example_manifest().as_bytes();
        let signatures = build_signature_file(&[
            SignatureEntry {
                key: project.key.fingerprint().to_owned(),
                signature: sign_prefixed(&project.seed, RELEASE_PREFIX, manifest),
            },
            SignatureEntry {
                key: team.key.fingerprint().to_owned(),
                signature: sign_prefixed(&team.seed, RELEASE_PREFIX, manifest),
            },
        ])
        .unwrap();
        let mut host = Host::new(&[&team, &project]);
        let verified = host.decide(manifest, &signatures).unwrap();
        assert_eq!(
            verified.signer,
            project.key.fingerprint(),
            "the first in file order"
        );
        assert_eq!(verified.signers.len(), 2);
        assert_eq!(verified.floors_after.len(), 2);
        assert!(verified.floors_after.values().all(|floor| *floor == 7));
        assert_eq!(
            verified
                .pins_after
                .iter()
                .map(ReleaseKey::fingerprint)
                .collect::<Vec<_>>(),
            {
                let mut both = [team.key.fingerprint(), project.key.fingerprint()];
                both.sort();
                both
            }
        );
        host.floors.insert(project.key.fingerprint().to_owned(), 7);
        assert_eq!(
            host.decide(manifest, &signatures).unwrap_err().code,
            Code::CounterReplayed
        );
        // A host that pins one of the two takes the release on that signature.
        let one = Host::new(&[&project]);
        assert_eq!(
            one.decide(manifest, &signatures).unwrap().signers,
            [project.key.fingerprint()]
        );
    }
}
