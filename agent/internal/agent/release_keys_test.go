package agent

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------- an independent curve

// The key rule says what a point is, and the production check is written with a
// few lines of math/big and a list of eight encodings. This file holds a second
// implementation of the curve in plain big.Int arithmetic, written from
// RFC 8032 section 5.1 without that code, and compares the two on every edge of
// the encoding and on random bytes.

var (
	oracleP = mustBig("57896044618658097711785492504343953926634992332820282019728792003956564819949")
	oracleD = mustBig("37095705934669439343138083508754565189542113879843219016388785533085940283555")
	oracleL = mustBig("7237005577332262213973186563042994240857116359379907606001950938285454250989")
)

func mustBig(decimal string) *big.Int {
	value, ok := new(big.Int).SetString(decimal, 10)
	if !ok {
		panic(decimal)
	}
	return value
}

type oraclePoint struct{ x, y *big.Int }

func oracleMod(value *big.Int) *big.Int { return new(big.Int).Mod(value, oracleP) }
func oracleMul(a, b *big.Int) *big.Int  { return oracleMod(new(big.Int).Mul(a, b)) }
func oracleInverse(value *big.Int) *big.Int {
	return new(big.Int).ModInverse(value, oracleP)
}

func oracleIdentity() oraclePoint { return oraclePoint{big.NewInt(0), big.NewInt(1)} }

func oracleIsIdentity(point oraclePoint) bool {
	return point.x.Sign() == 0 && point.y.Cmp(big.NewInt(1)) == 0
}

// oracleSqrt is the square root of RFC 8032 section 5.1.3, or nil.
func oracleSqrt(square *big.Int) *big.Int {
	root := new(big.Int).Exp(square, new(big.Int).Rsh(new(big.Int).Add(oracleP, big.NewInt(3)), 3), oracleP)
	matches := func(candidate *big.Int) bool { return oracleMul(candidate, candidate).Cmp(oracleMod(square)) == 0 }
	if !matches(root) {
		sqrtMinusOne := new(big.Int).Exp(big.NewInt(2), new(big.Int).Rsh(new(big.Int).Sub(oracleP, big.NewInt(1)), 2), oracleP)
		root = oracleMul(root, sqrtMinusOne)
	}
	if !matches(root) {
		return nil
	}
	return root
}

// oracleDecode decodes as RFC 8032 does, after one more condition: the
// encoding must be canonical.
func oracleDecode(encoded [32]byte) (oraclePoint, bool) {
	sign := encoded[31] >> 7
	masked := encoded
	masked[31] &= 0x7f
	y := new(big.Int)
	for i := 31; i >= 0; i-- {
		y.Lsh(y, 8)
		y.Or(y, big.NewInt(int64(masked[i])))
	}
	if y.Cmp(oracleP) >= 0 {
		return oraclePoint{}, false
	}
	y2 := oracleMul(y, y)
	numerator := oracleMod(new(big.Int).Sub(y2, big.NewInt(1)))
	denominator := oracleMod(new(big.Int).Add(oracleMul(oracleD, y2), big.NewInt(1)))
	x := oracleSqrt(oracleMul(numerator, oracleInverse(denominator)))
	if x == nil || (x.Sign() == 0 && sign == 1) {
		return oraclePoint{}, false
	}
	if x.Bit(0) != uint(sign) {
		x = oracleMod(new(big.Int).Neg(x))
	}
	return oraclePoint{x, y}, true
}

func oracleEncode(point oraclePoint) [32]byte {
	var encoded [32]byte
	y := point.y.Bytes()
	for i, b := range y {
		encoded[len(y)-1-i] = b
	}
	encoded[31] |= byte(point.x.Bit(0)) << 7
	return encoded
}

func oracleAdd(a, b oraclePoint) oraclePoint {
	product := oracleMul(oracleD, oracleMul(oracleMul(a.x, b.x), oracleMul(a.y, b.y)))
	x := oracleMul(oracleMod(new(big.Int).Add(oracleMul(a.x, b.y), oracleMul(b.x, a.y))), oracleInverse(oracleMod(new(big.Int).Add(big.NewInt(1), product))))
	y := oracleMul(oracleMod(new(big.Int).Add(oracleMul(a.y, b.y), oracleMul(a.x, b.x))), oracleInverse(oracleMod(new(big.Int).Sub(big.NewInt(1), product))))
	return oraclePoint{x, y}
}

func oracleScalarMultiply(point oraclePoint, scalar *big.Int) oraclePoint {
	result := oracleIdentity()
	for i := scalar.BitLen() - 1; i >= 0; i-- {
		result = oracleAdd(result, result)
		if scalar.Bit(i) == 1 {
			result = oracleAdd(result, point)
		}
	}
	return result
}

// oracleSmallOrder reports whether eight times the point is the identity.
func oracleSmallOrder(point oraclePoint) bool {
	return oracleIsIdentity(oracleScalarMultiply(point, big.NewInt(8)))
}

// oracleAccepts is the key rule, written the plain way.
func oracleAccepts(encoded [32]byte) bool {
	point, ok := oracleDecode(encoded)
	return ok && !oracleSmallOrder(point)
}

// oracleTorsion is the eight points whose order divides 8, found as the
// multiples of l times a point of the curve: the group of the curve has order
// 8l, so l times any point lies in the subgroup of order 8, and it generates
// the subgroup when four times it is not the identity.
func oracleTorsion(t *testing.T) map[[32]byte]bool {
	t.Helper()
	for y := int64(3); y < 200; y++ {
		var encoded [32]byte
		encoded[0] = byte(y)
		point, ok := oracleDecode(encoded)
		if !ok {
			continue
		}
		generator := oracleScalarMultiply(point, oracleL)
		if oracleIsIdentity(oracleScalarMultiply(generator, big.NewInt(4))) {
			continue
		}
		found := map[[32]byte]bool{}
		current := oracleIdentity()
		for i := 0; i < 8; i++ {
			found[oracleEncode(current)] = true
			current = oracleAdd(current, generator)
		}
		return found
	}
	t.Fatal("no point of the curve gave a generator of the subgroup of order 8")
	return nil
}

func TestCurveConstantsAreTheStandardOnes(t *testing.T) {
	if fieldPrime.Cmp(oracleP) != 0 || curveD.Cmp(oracleD) != 0 || groupOrder.Cmp(oracleL) != 0 {
		t.Fatalf("p %v d %v l %v", fieldPrime, curveD, groupOrder)
	}
	// The base point has order l: l times it is the identity, and it is a valid key.
	base := mustBig("46316835694926478169428394003475163141307993866256225615783033603165251855960")
	basePoint, ok := oracleDecode(oracleEncode(oraclePoint{x: mustBig("15112221349535400772501151409588531511454012693041857206046113283949847762202"), y: base}))
	if !ok || !oracleIsIdentity(oracleScalarMultiply(basePoint, oracleL)) {
		t.Fatal("the oracle's base point doesn't have order l")
	}
}

func TestSmallOrderEncodingsAreTheSubgroupOfOrderEight(t *testing.T) {
	derived := oracleTorsion(t)
	if len(derived) != 8 {
		t.Fatalf("the oracle found %d points", len(derived))
	}
	listed := map[[32]byte]bool{}
	for _, encoding := range smallOrderEncodings {
		listed[encoding] = true
	}
	if len(listed) != 8 {
		t.Fatalf("the list holds %d different encodings", len(listed))
	}
	for encoding := range derived {
		if !listed[encoding] {
			t.Errorf("the encoding %x is of small order and is not in the list", encoding)
		}
	}
	// And the vectors' eight small-order key lines are those same eight.
	fromVectors := map[[32]byte]bool{}
	for _, vector := range loadReleaseVectors(t).KeyLines {
		if !strings.HasPrefix(vector.Name, "small-order-") {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(strings.Fields(vector.Line)[2])
		if err != nil || len(raw) != 32 {
			t.Fatalf("%s: %v", vector.Name, err)
		}
		var encoding [32]byte
		copy(encoding[:], raw)
		fromVectors[encoding] = true
	}
	if len(fromVectors) != 8 {
		t.Fatalf("the vectors list %d small-order encodings", len(fromVectors))
	}
	for encoding := range fromVectors {
		if !listed[encoding] {
			t.Errorf("the vectors list %x, which the check does not refuse", encoding)
		}
	}
}

// Every edge of the encoding, then random bytes: the check and the oracle agree.
func TestReleaseKeyRuleAgreesWithAnIndependentCurveImplementation(t *testing.T) {
	var samples [][32]byte
	with := func(y *big.Int) {
		for sign := byte(0); sign < 2; sign++ {
			var encoded [32]byte
			y.FillBytes(encoded[:])
			for i, j := 0, 31; i < j; i, j = i+1, j-1 {
				encoded[i], encoded[j] = encoded[j], encoded[i]
			}
			encoded[31] |= sign << 7
			samples = append(samples, encoded)
		}
	}
	limit := new(big.Int).Lsh(big.NewInt(1), 255)
	for y := int64(0); y < 300; y++ {
		with(big.NewInt(y))
	}
	for offset := int64(-300); offset < 19; offset++ {
		with(new(big.Int).Add(oracleP, big.NewInt(offset)))
	}
	with(new(big.Int).Sub(limit, big.NewInt(1)))
	for _, encoding := range smallOrderEncodings {
		samples = append(samples, encoding)
	}
	random := rand.New(rand.NewSource(8620))
	for i := 0; i < 3000; i++ {
		var encoded [32]byte
		random.Read(encoded[:])
		samples = append(samples, encoded)
	}
	accepted := 0
	for _, encoded := range samples {
		want := oracleAccepts(encoded)
		if got := releasePointProblem(encoded) == ""; got != want {
			t.Fatalf("%x: the check says %v (%q), the oracle says %v", encoded, got, releasePointProblem(encoded), want)
		}
		if want {
			accepted++
		}
	}
	if accepted < 1000 || accepted > len(samples)-1000 {
		t.Fatalf("%d of %d samples accepted: the samples don't exercise both outcomes", accepted, len(samples))
	}
}

// ---------------------------------------------------------------- signatures

// A signature whose R is the identity point, made from the key's own scalar,
// satisfies the verification equation for any message: S = k*a gives [S]B =
// [k]A, so R = [S]B - [k]A is the identity. crypto/ed25519 accepts it; a strict
// verifier refuses it, and so does the release check.
func TestSignatureWhoseRIsTheIdentityPointIsRefused(t *testing.T) {
	private := testPrivateKey(t, 1)
	public := testPublicKey(t, private, "team")
	message := []byte(testManifest)
	signed := append([]byte(releaseSignaturePrefix), message...)

	digest := sha512.Sum512(private.seed[:])
	scalarBytes := digest[:32]
	scalarBytes[0] &= 248
	scalarBytes[31] &= 127
	scalarBytes[31] |= 64
	scalar := littleEndianInt(scalarBytes)
	identity := smallOrderEncodings[2]
	challenge := sha512.New()
	challenge.Write(identity[:])
	challenge.Write(public.raw[:])
	challenge.Write(signed)
	k := littleEndianInt(challenge.Sum(nil))
	k.Mod(k, oracleL)
	s := new(big.Int).Mul(k, scalar)
	s.Mod(s, oracleL)
	var signature []byte
	signature = append(signature, identity[:]...)
	sBytes := s.FillBytes(make([]byte, 32))
	for i, j := 0, 31; i < j; i, j = i+1, j-1 {
		sBytes[i], sBytes[j] = sBytes[j], sBytes[i]
	}
	signature = append(signature, sBytes...)

	if !ed25519.Verify(ed25519.PublicKey(public.raw[:]), signed, signature) {
		t.Fatal("the crafted signature no longer satisfies crypto/ed25519's equation: the premise of this test changed")
	}
	if public.verify(releaseSignaturePrefix, message, signature) {
		t.Fatal("a signature whose R is the identity point is accepted")
	}
}

// S plus the group order is the same scalar to a verifier that reduces it, and a
// different number to one that doesn't: it is refused.
func TestSignatureWithAScalarNotBelowTheGroupOrderIsRefused(t *testing.T) {
	private := testPrivateKey(t, 1)
	public := testPublicKey(t, private, "team")
	message := []byte(testManifest)
	signature := private.SignRelease(message)
	if !public.verify(releaseSignaturePrefix, message, signature) {
		t.Fatal("the honest signature is refused")
	}
	reversed := make([]byte, 32)
	for i := range reversed {
		reversed[i] = signature[63-i]
	}
	s := new(big.Int).SetBytes(reversed)
	s.Add(s, oracleL)
	raised := s.FillBytes(make([]byte, 32))
	forged := append([]byte(nil), signature[:32]...)
	for i := 31; i >= 0; i-- {
		forged = append(forged, raised[i])
	}
	if public.verify(releaseSignaturePrefix, message, forged) {
		t.Fatal("a scalar not below the group order is accepted")
	}
	for _, length := range []int{0, 32, 63, 65} {
		if public.verify(releaseSignaturePrefix, message, bytes.Repeat([]byte{1}, length)) {
			t.Errorf("a signature of %d bytes is accepted", length)
		}
	}
	if (ReleaseKey{}).verify(releaseSignaturePrefix, message, signature) {
		t.Error("the zero key verifies")
	}
}

// ---------------------------------------------------------------- keys

func TestReleaseKeyFacets(t *testing.T) {
	private := testPrivateKey(t, 1)
	key, err := private.Public("team key 2026")
	if err != nil {
		t.Fatal(err)
	}
	raw := key.PublicKey()
	if len(raw) != 32 || !bytes.Equal(raw, ed25519.NewKeyFromSeed(private.seed[:]).Public().(ed25519.PublicKey)) {
		t.Fatal("PublicKey is the 32 raw bytes")
	}
	raw[0] ^= 1
	if bytes.Equal(raw, key.PublicKey()) {
		t.Error("PublicKey returns a copy")
	}
	if len(key.Fingerprint()) != 64 || key.ShortID() != key.Fingerprint()[:16] || key.Fingerprint() != private.Fingerprint() {
		t.Errorf("%s %s", key.Fingerprint(), key.ShortID())
	}
	parsed, err := ParseReleaseKey(key.Line())
	if err != nil || parsed != key || parsed.Name() != "team key 2026" {
		t.Fatalf("%+v %v", parsed, err)
	}
	var zero ReleaseKey
	if !zero.IsZero() || zero.Fingerprint() != "" || zero.ShortID() != "" || zero.Line() != "" {
		t.Error("the zero key is not a key")
	}
	group := GroupFingerprint(key.Fingerprint())
	fields := strings.Fields(group)
	if len(fields) != 8 || strings.Join(fields, "") != key.Fingerprint() || len(group) != 64+7 {
		t.Errorf("%q", group)
	}
	for _, field := range fields {
		if len(field) != 8 {
			t.Errorf("%q", group)
		}
	}
	if GroupFingerprint("") != "" || GroupFingerprint("abc") != "abc" {
		t.Error("short text stays whole")
	}
}

func TestReleaseKeyNamesFollowTheirRules(t *testing.T) {
	private := testPrivateKey(t, 1)
	public := private.signingKey().Public().(ed25519.PublicKey)
	for name, ok := range map[string]bool{
		"t":                          true,
		strings.Repeat("n", 64):      true,
		strings.Repeat("n", 65):      false,
		"":                           false,
		" lead":                      false,
		"trail ":                     false,
		"two words":                  true,
		"ops/release #1 (2026) [a]~": true,
		`quote"`:                     false,
		`back\slash`:                 false,
		"tab\there":                  false,
		"new\nline":                  false,
		"café":                       false,
		"del\x7f":                    false,
	} {
		_, err := NewReleaseKey(public, name)
		if (err == nil) != ok {
			t.Errorf("%q: %v", name, err)
		}
		if err != nil {
			wantRefusal(t, err, "RELEASE_KEY_INVALID")
		}
	}
	if _, err := NewReleaseKey(public[:31], "short"); err == nil {
		t.Error("31 bytes are not a key")
	}
}

// A key line is exactly its three fields: a refused line gives no key and the
// code of the contract.
func TestReleaseKeyLineGrammar(t *testing.T) {
	team := testPublicKey(t, testPrivateKey(t, 1), "team")
	encoded := base64.StdEncoding.EncodeToString(team.PublicKey())
	for line, ok := range map[string]bool{
		"vectory-release-key ed25519 " + encoded + " team":                         true,
		"vectory-release-key ed25519 " + encoded + " team " + "more":               true,
		"vectory-release-key ed25519 " + encoded:                                   false,
		"vectory-release-key ed25519 " + encoded + " ":                             false,
		"vectory-release-key ed25519  " + encoded + " team":                        false,
		"vectory-release-key ed25519 " + encoded + "  team":                        false,
		"vectory-release-key ed25519 " + encoded + " team\n":                       false,
		"vectory-release-key ed25519 " + encoded + " team\r":                       false,
		"vectory-release-key ed25519\t" + encoded + " team":                        false,
		" vectory-release-key ed25519 " + encoded + " team":                        false,
		"vectory-release-key ed448 " + encoded + " team":                           false,
		"vectory-release-key ED25519 " + encoded + " team":                         false,
		"ssh-ed25519 " + encoded + " team":                                         false,
		"vectory-release-key ed25519 " + strings.TrimRight(encoded, "=") + " team": false,
	} {
		key, err := ParseReleaseKey(line)
		if (err == nil) != ok {
			t.Errorf("%q: %v", line, err)
		}
		if err != nil {
			wantRefusal(t, err, "RELEASE_KEY_INVALID")
			if !key.IsZero() {
				t.Errorf("%q gave a key", line)
			}
		}
	}
}

func TestCanonicalBase64(t *testing.T) {
	for text, ok := range map[string]bool{
		"":         true,
		"AAAA":     true,
		"AAA=":     true,
		"AA==":     true,
		"AAB=":     false, // padding bits not zero
		"AB==":     false,
		"AAA":      false,
		"AAAA\n":   false,
		"AA\nAA":   false,
		"AA AA":    false,
		"AA==AAAA": false,
		"A===":     false,
		"====":     false,
		"-_-_":     false,
		"AAAA ":    false,
	} {
		decoded, err := DecodeCanonicalBase64(text)
		if (err == nil) != ok {
			t.Errorf("%q: %x %v", text, decoded, err)
		}
	}
}

// ---------------------------------------------------------------- private keys

func TestPrivateKeyFileFormat(t *testing.T) {
	key := testPrivateKey(t, 5)
	contents := key.FileContents()
	want := "vectory-release-private-key ed25519 " + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{5}, 32)) + "\n"
	if string(contents) != want {
		t.Fatalf("%q", contents)
	}
	for name, text := range map[string]string{
		"as written":            want,
		"without a line ending": strings.TrimSuffix(want, "\n"),
		"with a Windows ending": strings.TrimSuffix(want, "\n") + "\r\n",
	} {
		parsed, err := ParseReleasePrivateKey([]byte(text))
		if err != nil || parsed != key {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, text := range map[string]string{
		"nothing":                "",
		"a public key line":      testPublicKey(t, key, "team").Line(),
		"two lines":              want + want,
		"two line feeds":         want + "\n",
		"a lone carriage return": strings.TrimSuffix(want, "\n") + "\r\r\n",
		"a short seed":           "vectory-release-private-key ed25519 " + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{5}, 31)) + "\n",
		"a long seed":            "vectory-release-private-key ed25519 " + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{5}, 33)) + "\n",
		"another algorithm":      strings.Replace(want, "ed25519", "ed448", 1),
		"padding bits set":       strings.Replace(want, "U=\n", "V=\n", 1),
		"extra text":             strings.TrimSuffix(want, "\n") + " team\n",
	} {
		if _, err := ParseReleasePrivateKey([]byte(text)); err == nil {
			t.Errorf("%s is accepted", name)
		}
	}
	if (ReleasePrivateKey{}).FileContents() != nil {
		t.Error("the zero key has no file")
	}
	if _, err := (ReleasePrivateKey{}).Public("x"); err == nil {
		t.Error("the zero key has no public half")
	}
}

func TestPrivateKeyNeverPrintsItsSeed(t *testing.T) {
	key := testPrivateKey(t, 0x5a)
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%d", "%x", "%q"} {
		for _, value := range []any{key, &key, []ReleasePrivateKey{key}, struct{ Key ReleasePrivateKey }{key}} {
			text := fmt.Sprintf(verb, value)
			if strings.Contains(text, base64.StdEncoding.EncodeToString(key.seed[:])) || strings.Contains(text, hex.EncodeToString(key.seed[:])) || strings.Contains(text, "90 90") {
				t.Errorf("%s prints the seed: %s", verb, text)
			}
		}
	}
	if text := fmt.Sprintf("%v", key); text != "ReleasePrivateKey{}" {
		t.Errorf("%q", text)
	}
}

func TestGeneratedReleaseKeysAreDifferentAndValid(t *testing.T) {
	first, err := GenerateReleasePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	second, err := GenerateReleasePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || first.IsZero() || first.Fingerprint() == second.Fingerprint() {
		t.Fatal("two generated keys are the same")
	}
	public, err := first.Public("generated")
	if err != nil {
		t.Fatal(err)
	}
	signature := first.SignRelease([]byte(testManifest))
	if !public.verify(releaseSignaturePrefix, []byte(testManifest), signature) {
		t.Error("a generated key verifies its own signature")
	}
	if !bytes.Equal(signature, first.SignRelease([]byte(testManifest))) {
		t.Error("Ed25519 signatures are deterministic")
	}
}

func TestPrivateKeyFileRoundTrip(t *testing.T) {
	dir := privateTempDir(t)
	path := filepath.Join(dir, "team.key")
	key := testPrivateKey(t, 6)
	if err := WriteReleasePrivateKey(path, key); err != nil {
		t.Fatal(err)
	}
	read, err := ReadReleasePrivateKey(path)
	if err != nil || read != key {
		t.Fatalf("%v", err)
	}
	// It never replaces anything.
	other := testPrivateKey(t, 7)
	if err := WriteReleasePrivateKey(path, other); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("a second write: %v", err)
	}
	if again, err := ReadReleasePrivateKey(path); err != nil || again != key {
		t.Fatal("the existing key changed")
	}
	if err := WriteReleasePrivateKey(path, ReleasePrivateKey{}); err == nil {
		t.Error("the zero key is not written")
	}
	// Only an absolute path with no link in it.
	if err := WriteReleasePrivateKey("relative.key", key); err == nil {
		t.Error("a relative path is refused")
	}
	if _, err := os.Stat("relative.key"); err == nil {
		os.Remove("relative.key")
		t.Error("a relative path created a file")
	}
	if err := WriteReleasePrivateKey(filepath.Join(dir, "missing", "team.key"), key); err == nil {
		t.Error("a missing directory is refused")
	}
}

func TestPrivateKeyFileContentsAreChecked(t *testing.T) {
	dir := privateTempDir(t)
	for name, contents := range map[string]string{
		"empty":        "",
		"a public key": testPublicKey(t, testPrivateKey(t, 1), "team").Line() + "\n",
		"long":         strings.Repeat("x", 600),
	} {
		path := filepath.Join(dir, strings.ReplaceAll(name, " ", "-")+".key")
		if err := AtomicWrite(path, []byte(contents)); err != nil {
			t.Fatal(err)
		}
		_, err := ReadReleasePrivateKey(path)
		if err == nil || !strings.Contains(err.Error(), path) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := ReadReleasePrivateKey(filepath.Join(dir, "missing.key")); err == nil || !strings.Contains(err.Error(), "doesn't exist") {
		t.Errorf("a missing file: %v", err)
	}
	if _, err := ReadReleasePrivateKey("relative.key"); err == nil {
		t.Error("a relative path is refused")
	}
}

func TestReadReleaseFile(t *testing.T) {
	dir := privateTempDir(t)
	path := filepath.Join(dir, "release.json")
	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadReleaseFile(path, 5); err != nil || string(got) != "hello" {
		t.Errorf("%q %v", got, err)
	}
	if _, err := ReadReleaseFile(path, 4); err == nil || !strings.Contains(err.Error(), "larger than 4 bytes") {
		t.Errorf("a file over the limit: %v", err)
	}
	if _, err := ReadReleaseFile(dir, 100); err == nil || !strings.Contains(err.Error(), "isn't a regular file") {
		t.Errorf("a directory: %v", err)
	}
	if _, err := ReadReleaseFile(filepath.Join(dir, "missing"), 100); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a missing file: %v", err)
	}
}

func TestReadReleasePublicKeyFile(t *testing.T) {
	dir := privateTempDir(t)
	key := testPublicKey(t, testPrivateKey(t, 1), "team")
	for name, contents := range map[string]string{
		"a line":                 key.Line(),
		"a line and a line feed": key.Line() + "\n",
		"a line and a CRLF":      key.Line() + "\r\n",
	} {
		path := filepath.Join(dir, strings.ReplaceAll(name, " ", "-")+".pub")
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
		if got, err := ReadReleasePublicKeyFile(path); err != nil || got != key {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, contents := range map[string]string{
		"two lines":          key.Line() + "\n" + key.Line() + "\n",
		"a blank line after": key.Line() + "\n\n",
		"a different file":   "hello\n",
		"a small-order key":  "vectory-release-key ed25519 " + base64.StdEncoding.EncodeToString(smallOrderEncodings[2][:]) + " small\n",
		"UTF-16 text":        "v\x00e\x00c\x00t\x00o\x00r\x00y\x00",
		"a long file":        strings.Repeat("x", 600),
	} {
		path := filepath.Join(dir, strings.ReplaceAll(name, " ", "-")+".pub")
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadReleasePublicKeyFile(path); err == nil {
			t.Errorf("%s is accepted", name)
		} else if name == "a small-order key" {
			if refusal := wantRefusal(t, err, "RELEASE_KEY_INVALID"); !strings.Contains(refusal.Detail, path) || !strings.Contains(refusal.Detail, "small order") {
				t.Errorf("%s", refusal.Detail)
			}
		}
	}
}
