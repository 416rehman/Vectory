package agent

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/big"
	"os"
	"strings"
)

// Release keys. A team signs agent releases with an Ed25519 key, and a host
// pins the public half. Both halves live in one-line text files:
//
//	vectory-release-key ed25519 <base64 of the 32 raw bytes> <name>
//	vectory-release-private-key ed25519 <base64 of the 32-byte seed>
//
// A public key is valid only when its 32 bytes are the canonical encoding of a
// point on the curve that is not of small order. The standard library exports
// no point decoding, so the check is written out here with math/big.

const (
	releaseKeyPrefix        = "vectory-release-key ed25519 "
	releasePrivateKeyPrefix = "vectory-release-private-key ed25519 "
	maxReleaseKeyName       = 64
	// maxReleaseKeyFile bounds a key file: a line, its line ending and room for
	// a name, so a file that is something else is refused without being read.
	maxReleaseKeyFile = 512
)

// ReleaseKey is a public key that verifies agent releases. Its zero value is
// not a key: every ReleaseKey that holds bytes came through ParseReleaseKey,
// NewReleaseKey or ReleasePrivateKey.Public, which apply the key rule.
type ReleaseKey struct {
	raw   [ed25519.PublicKeySize]byte
	name  string
	valid bool
}

// invalidReleaseKey is the refusal for a key line or file that isn't a valid
// public key.
func invalidReleaseKey(format string, args ...any) *UpdateRefusal {
	return newUpdateRefusal(codeReleaseKeyInvalid, format, args...)
}

// ParseReleaseKey parses a public key line and applies the key rule. Errors
// are *UpdateRefusal with the code RELEASE_KEY_INVALID.
func ParseReleaseKey(line string) (ReleaseKey, error) {
	rest, ok := strings.CutPrefix(line, releaseKeyPrefix)
	if !ok {
		return ReleaseKey{}, invalidReleaseKey("a release key starts with %q", strings.TrimSuffix(releaseKeyPrefix, " "))
	}
	encoded, name, found := strings.Cut(rest, " ")
	if !found {
		return ReleaseKey{}, invalidReleaseKey("the key has no name after it")
	}
	raw, ok := decodeCanonicalBase64(encoded)
	if !ok || len(raw) != ed25519.PublicKeySize {
		return ReleaseKey{}, invalidReleaseKey("the key isn't the canonical base64 of 32 bytes")
	}
	var public [ed25519.PublicKeySize]byte
	copy(public[:], raw)
	return newReleaseKey(public, name)
}

// NewReleaseKey makes a key from the 32 raw bytes of a public key and a display
// name, applying the same rules as ParseReleaseKey.
func NewReleaseKey(public ed25519.PublicKey, name string) (ReleaseKey, error) {
	if len(public) != ed25519.PublicKeySize {
		return ReleaseKey{}, invalidReleaseKey("a public key is %d bytes, not %d", ed25519.PublicKeySize, len(public))
	}
	var raw [ed25519.PublicKeySize]byte
	copy(raw[:], public)
	return newReleaseKey(raw, name)
}

func newReleaseKey(raw [ed25519.PublicKeySize]byte, name string) (ReleaseKey, error) {
	if reason := checkReleaseKeyName(name); reason != "" {
		return ReleaseKey{}, invalidReleaseKey("%s", reason)
	}
	if reason := releasePointProblem(raw); reason != "" {
		return ReleaseKey{}, invalidReleaseKey("the key %s", reason)
	}
	return ReleaseKey{raw: raw, name: name, valid: true}, nil
}

// checkReleaseKeyName returns what is wrong with a key's display name, or "".
// The name is 1 to 64 printable ASCII characters that neither start nor end
// with a space and hold no quotation mark and no backslash: the line is quoted
// inside the JSON of a rollover statement and of the policy, where an escape
// cannot occur.
func checkReleaseKeyName(name string) string {
	switch {
	case name == "":
		return "the key has no name"
	case len(name) > maxReleaseKeyName:
		return fmt.Sprintf("the key's name is %d characters; at most %d are allowed", len(name), maxReleaseKeyName)
	case name[0] == ' ' || name[len(name)-1] == ' ':
		return "the key's name starts or ends with a space"
	}
	for i := 0; i < len(name); i++ {
		if name[i] < 0x20 || name[i] > 0x7e || name[i] == '"' || name[i] == '\\' {
			return "the key's name must be printable ASCII without a quotation mark or a backslash"
		}
	}
	return ""
}

// Name is the display name on the key's line. It says nothing about the key.
func (k ReleaseKey) Name() string { return k.name }

// PublicKey returns a copy of the 32 raw bytes.
func (k ReleaseKey) PublicKey() ed25519.PublicKey {
	return append(ed25519.PublicKey(nil), k.raw[:]...)
}

// Fingerprint is the lowercase hex SHA-256 of the 32 raw bytes, computed from
// the key itself and never taken from a field beside it. A value that is not a
// key has none.
func (k ReleaseKey) Fingerprint() string {
	if !k.valid {
		return ""
	}
	sum := sha256.Sum256(k.raw[:])
	return hex.EncodeToString(sum[:])
}

// ShortID is the first 16 characters of the fingerprint, which the dashboard
// and `vectory update status` print. Hosts compare whole fingerprints.
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
	return releaseKeyPrefix + base64.StdEncoding.EncodeToString(k.raw[:]) + " " + k.name
}

// IsZero reports whether k is the zero value, which is not a key.
func (k ReleaseKey) IsZero() bool { return !k.valid }

// GroupFingerprint writes a fingerprint in groups of eight characters, as
// people compare it: 05cc6c02 351af0cb ...
func GroupFingerprint(fingerprint string) string {
	var groups []string
	for len(fingerprint) > 8 {
		groups = append(groups, fingerprint[:8])
		fingerprint = fingerprint[8:]
	}
	return strings.Join(append(groups, fingerprint), " ")
}

// verify reports whether signature is the strict Ed25519 signature of
// prefix+message by this key. Strict means the same in the server and the
// agent: S is below the group order, and R and the public key are canonical
// encodings of points that are not of small order. crypto/ed25519 refuses a
// non-canonical S and compares R as bytes, so a non-canonical R can never
// match; what it accepts and a strict verifier refuses is an R of small order,
// which a signature made from the signing key's own scalar can satisfy for any
// message. Each of the three conditions is checked here, not left to the
// library.
func (k ReleaseKey) verify(prefix string, message, signature []byte) bool {
	if !k.valid || len(signature) != ed25519.SignatureSize {
		return false
	}
	var r [32]byte
	copy(r[:], signature[:32])
	if releasePointProblem(r) != "" {
		return false
	}
	if littleEndianInt(signature[32:]).Cmp(groupOrder) >= 0 {
		return false
	}
	signed := make([]byte, 0, len(prefix)+len(message))
	signed = append(append(signed, prefix...), message...)
	return ed25519.Verify(ed25519.PublicKey(k.raw[:]), signed, signature)
}

// ---------------------------------------------------------------- curve

var (
	// fieldPrime is p = 2^255 - 19, and groupOrder is the order l of the prime
	// subgroup, 2^252 + 27742317777372353535851937790883648493.
	fieldPrime = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))
	groupOrder = func() *big.Int {
		l, _ := new(big.Int).SetString("27742317777372353535851937790883648493", 10)
		return l.Add(l, new(big.Int).Lsh(big.NewInt(1), 252))
	}()
	// curveD is d = -121665/121666 mod p, the constant of -x^2 + y^2 = 1 + d x^2 y^2.
	curveD = func() *big.Int {
		inverse := new(big.Int).ModInverse(big.NewInt(121666), fieldPrime)
		d := new(big.Int).Mul(big.NewInt(-121665), inverse)
		return d.Mod(d, fieldPrime)
	}()
	// squareExponent is (p-1)/2, the exponent of Euler's criterion.
	squareExponent = new(big.Int).Rsh(new(big.Int).Sub(fieldPrime, big.NewInt(1)), 1)
)

// smallOrderEncodings are the canonical encodings of the eight points of order
// 1, 2, 4 and 8: the identity (y = 1), the point of order 2 (y = -1), the two
// of order 4 (y = 0, with either sign) and the four of order 8. The shared
// vectors list the same eight, and a test derives them from the curve
// equation, so this list can't drift from the arithmetic.
var smallOrderEncodings = [8][32]byte{
	hexBytes32("0000000000000000000000000000000000000000000000000000000000000000"),
	hexBytes32("0000000000000000000000000000000000000000000000000000000000000080"),
	hexBytes32("0100000000000000000000000000000000000000000000000000000000000000"),
	hexBytes32("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
	hexBytes32("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85"),
	hexBytes32("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
	hexBytes32("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa"),
	hexBytes32("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
}

func hexBytes32(text string) (out [32]byte) {
	decoded, err := hex.DecodeString(text)
	if err != nil || len(decoded) != len(out) {
		panic("release key table: " + text)
	}
	copy(out[:], decoded)
	return out
}

// littleEndianInt reads little-endian bytes as an integer.
func littleEndianInt(little []byte) *big.Int {
	reversed := make([]byte, len(little))
	for i, b := range little {
		reversed[len(little)-1-i] = b
	}
	return new(big.Int).SetBytes(reversed)
}

// releasePointProblem says why 32 bytes are not an acceptable point, or "" when
// they are the canonical encoding of a point of the curve that is not of small
// order. It decodes as RFC 8032 section 5.1.3 does and then also requires the
// encoding to be canonical, which the RFC leaves to the caller.
func releasePointProblem(encoded [32]byte) string {
	for _, small := range smallOrderEncodings {
		if encoded == small {
			return "is a point of small order"
		}
	}
	signBit := encoded[31] >> 7
	masked := encoded
	masked[31] &= 0x7f
	y := littleEndianInt(masked[:])
	if y.Cmp(fieldPrime) >= 0 {
		return "isn't a canonical encoding: its y coordinate is not below 2^255-19"
	}
	// x^2 = (y^2 - 1) / (d y^2 + 1) must be a square.
	y2 := new(big.Int).Mul(y, y)
	y2.Mod(y2, fieldPrime)
	numerator := new(big.Int).Sub(y2, big.NewInt(1))
	numerator.Mod(numerator, fieldPrime)
	denominator := new(big.Int).Mul(curveD, y2)
	denominator.Add(denominator, big.NewInt(1))
	denominator.Mod(denominator, fieldPrime)
	if denominator.Sign() == 0 {
		return "isn't a point of the curve"
	}
	x2 := numerator.Mul(numerator, denominator.ModInverse(denominator, fieldPrime))
	x2.Mod(x2, fieldPrime)
	if x2.Sign() == 0 {
		// x = 0 has a single encoding: with the sign bit set it is an alias.
		if signBit == 1 {
			return "isn't a canonical encoding: the sign bit is set on a point whose x is 0"
		}
		return ""
	}
	// Euler's criterion: a nonzero a is a square exactly when a^((p-1)/2) = 1.
	if new(big.Int).Exp(x2, squareExponent, fieldPrime).Cmp(big.NewInt(1)) != 0 {
		return "isn't a point of the curve"
	}
	return ""
}

// ---------------------------------------------------------------- base64

// decodeCanonicalBase64 decodes base64 as the contract writes it: the standard
// alphabet, padding, canonical (the unused bits are zero) and no whitespace.
// The standard library's decoder skips carriage returns and line feeds, so the
// alphabet is checked first and the result is encoded again and compared.
func decodeCanonicalBase64(text string) ([]byte, bool) {
	if len(text)%4 != 0 {
		return nil, false
	}
	padding := 0
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			if padding > 0 {
				return nil, false
			}
		case c == '=':
			padding++
		default:
			return nil, false
		}
	}
	if padding > 2 {
		return nil, false
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(text)
	if err != nil || base64.StdEncoding.EncodeToString(decoded) != text {
		return nil, false
	}
	return decoded, true
}

// DecodeCanonicalBase64 decodes the base64 of the contract's signed files and
// offers: the standard alphabet with padding, no whitespace, and the unused
// bits zero.
func DecodeCanonicalBase64(text string) ([]byte, error) {
	decoded, ok := decodeCanonicalBase64(text)
	if !ok {
		return nil, errors.New("not canonical base64: use the standard alphabet with padding, no whitespace, and zero unused bits")
	}
	return decoded, nil
}

// trimLineEnding removes one final line ending, a line feed or a carriage
// return and a line feed, so a key file edited on Windows still reads.
func trimLineEnding(text string) string {
	if trimmed, ok := strings.CutSuffix(text, "\r\n"); ok {
		return trimmed
	}
	return strings.TrimSuffix(text, "\n")
}

// ---------------------------------------------------------------- private keys

// ReleasePrivateKey is the secret half of a release key: the 32-byte seed of an
// Ed25519 key. It is written to a file that only its owner can read, and it
// never prints itself.
type ReleasePrivateKey struct {
	seed  [ed25519.SeedSize]byte
	valid bool
}

// GenerateReleasePrivateKey makes a new key from the system's random source.
func GenerateReleasePrivateKey() (ReleasePrivateKey, error) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return ReleasePrivateKey{}, err
	}
	key := ReleasePrivateKey{valid: true}
	copy(key.seed[:], private.Seed())
	return key, nil
}

// String and Format keep the seed out of logs and error messages, whichever
// verb formats the value (Format answers %v, %+v, %#v, %d, %x and the rest).
func (k ReleasePrivateKey) String() string { return "ReleasePrivateKey{}" }

func (k ReleasePrivateKey) Format(state fmt.State, verb rune) {
	_, _ = io.WriteString(state, k.String())
}

func (k ReleasePrivateKey) signingKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(k.seed[:])
}

// Public is the public half, with the display name given.
func (k ReleasePrivateKey) Public(name string) (ReleaseKey, error) {
	if !k.valid {
		return ReleaseKey{}, errors.New("not a release private key")
	}
	return NewReleaseKey(k.signingKey().Public().(ed25519.PublicKey), name)
}

// Fingerprint is the fingerprint of the public half.
func (k ReleasePrivateKey) Fingerprint() string {
	if !k.valid {
		return ""
	}
	sum := sha256.Sum256(k.signingKey().Public().(ed25519.PublicKey))
	return hex.EncodeToString(sum[:])
}

// IsZero reports whether k is the zero value, which is not a key.
func (k ReleasePrivateKey) IsZero() bool { return !k.valid }

// sign signs prefix+message. Ed25519 is deterministic: the same key and bytes
// give the same signature.
func (k ReleasePrivateKey) sign(prefix string, message []byte) []byte {
	signed := make([]byte, 0, len(prefix)+len(message))
	signed = append(append(signed, prefix...), message...)
	return ed25519.Sign(k.signingKey(), signed)
}

// SignRelease signs the exact bytes of a release.json, as stored and
// delivered: nothing is parsed or re-serialized.
func (k ReleasePrivateKey) SignRelease(manifest []byte) []byte {
	return k.sign(releaseSignaturePrefix, manifest)
}

// FileContents is the key file: one line and a final line feed.
func (k ReleasePrivateKey) FileContents() []byte {
	if !k.valid {
		return nil
	}
	return []byte(releasePrivateKeyPrefix + base64.StdEncoding.EncodeToString(k.seed[:]) + "\n")
}

// ParseReleasePrivateKey reads the contents of a private key file.
func ParseReleasePrivateKey(contents []byte) (ReleasePrivateKey, error) {
	rest, ok := strings.CutPrefix(trimLineEnding(string(contents)), releasePrivateKeyPrefix)
	if !ok {
		return ReleasePrivateKey{}, errors.New("not a release private key: the file should hold one line that starts with " + strings.TrimSuffix(releasePrivateKeyPrefix, " "))
	}
	seed, ok := decodeCanonicalBase64(rest)
	if !ok || len(seed) != ed25519.SeedSize {
		return ReleasePrivateKey{}, errors.New("not a release private key: the seed isn't the canonical base64 of 32 bytes")
	}
	key := ReleasePrivateKey{valid: true}
	copy(key.seed[:], seed)
	return key, nil
}

// ReadReleasePrivateKey reads a private key file. Like every private file it
// must be a regular file with a single name, owned by this account or root and
// closed to everyone else, and it is opened without following a link.
func ReadReleasePrivateKey(path string) (ReleasePrivateKey, error) {
	file, err := openPrivateFile(path)
	if err != nil {
		problem, fix := privateFileProblem(path, err)
		message := fmt.Sprintf("the release key %s %s", path, problem)
		if fix != "" {
			message += ". " + strings.ReplaceAll(fix, "the token", "the key")
		}
		return ReleasePrivateKey{}, errors.New(message)
	}
	defer file.Close()
	contents, err := io.ReadAll(io.LimitReader(file, maxReleaseKeyFile+1))
	if err != nil {
		return ReleasePrivateKey{}, fmt.Errorf("couldn't read the release key %s: %w", path, err)
	}
	if len(contents) > maxReleaseKeyFile {
		return ReleasePrivateKey{}, fmt.Errorf("%s isn't a release private key: it is longer than a key file", path)
	}
	key, err := ParseReleasePrivateKey(contents)
	if err != nil {
		return ReleasePrivateKey{}, fmt.Errorf("%s: %w", path, err)
	}
	return key, nil
}

// WriteReleasePrivateKey creates the file for a new private key. It never
// replaces anything: a file that exists is refused (the error satisfies
// errors.Is(err, fs.ErrExist)), and so is a path with a symbolic link in it,
// the file's own name included. The file is created closed to everyone but this
// account before the key is written to it, and removed again if the write
// fails.
func WriteReleasePrivateKey(path string, key ReleasePrivateKey) error {
	if key.IsZero() {
		return errors.New("not a release private key")
	}
	if err := SafePath(path); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|openNoFollow, 0600)
	if err != nil {
		return err
	}
	fail := func(err error) error {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := protect(path, false); err != nil {
		return fail(err)
	}
	if _, err := file.Write(key.FileContents()); err != nil {
		return fail(err)
	}
	if err := file.Sync(); err != nil {
		return fail(err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

// ---------------------------------------------------------------- public key files

// missingFileError is the error for a file that isn't there, in words for
// people; errors.Is(err, fs.ErrNotExist) holds.
type missingFileError struct{ path string }

func (e *missingFileError) Error() string        { return e.path + " doesn't exist" }
func (e *missingFileError) Is(target error) bool { return target == fs.ErrNotExist }

// ReadReleaseFile reads a file an operator names, such as a release.json: a
// regular file of at most limit bytes. A link is followed (these files are
// public), and a device file or a pipe is refused rather than waited on.
func ReadReleaseFile(path string, limit int64) ([]byte, error) {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, &missingFileError{path}
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s isn't a regular file", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if opened, err := file.Stat(); err != nil || !opened.Mode().IsRegular() {
		return nil, fmt.Errorf("%s isn't a regular file", path)
	}
	contents, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(contents)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", path, limit)
	}
	return contents, nil
}

// ReadReleasePublicKeyFile reads a file that holds one public key line, with
// or without a final line ending.
func ReadReleasePublicKeyFile(path string) (ReleaseKey, error) {
	contents, err := ReadReleaseFile(path, maxReleaseKeyFile)
	if err != nil {
		return ReleaseKey{}, err
	}
	key, err := ParseReleaseKey(trimLineEnding(string(contents)))
	if err != nil {
		var refusal *UpdateRefusal
		if errors.As(err, &refusal) {
			return ReleaseKey{}, &UpdateRefusal{Code: refusal.Code, Detail: path + ": " + refusal.Detail}
		}
		return ReleaseKey{}, err
	}
	return key, nil
}
