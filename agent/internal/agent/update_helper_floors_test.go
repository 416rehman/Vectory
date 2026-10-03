package agent

import (
	"encoding/base64"
	"maps"
	"slices"
	"testing"
	"time"
)

func floorKey(t *testing.T, seed byte) (ReleasePrivateKey, ReleaseKey) {
	t.Helper()
	private := testPrivateKey(t, seed)
	return private, testPublicKey(t, private, "key-"+string(rune('a'+seed)))
}

func rolloverTo(t *testing.T, from ReleasePrivateKey, to ReleaseKey) RolloverEnvelope {
	t.Helper()
	envelope, err := SignRollover(from, to, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	return envelope
}

// statementNotSignedBy is a statement that replaces from with to, whose signature is
// by another key: it parses, and it doesn't verify under from.
func statementNotSignedBy(t *testing.T, from, to ReleaseKey, signer ReleasePrivateKey) RolloverEnvelope {
	t.Helper()
	statement := []byte(`{"schema":"` + rolloverStatementSchema + `","from":"` + from.Fingerprint() + `","to":"` + to.Line() + `","issued_at":"2026-10-01T00:00:00Z"}`)
	envelope := RolloverEnvelope{
		Statement: base64.StdEncoding.EncodeToString(statement),
		Signature: base64.StdEncoding.EncodeToString(signer.sign(rolloverSignaturePrefix, statement)),
	}
	parsed, err := envelope.Parse()
	if err != nil {
		t.Fatal(err)
	}
	if parsed.VerifiedBy(from) {
		t.Fatal("the statement verifies under the key it was not signed by")
	}
	return envelope
}

func fingerprintsSorted(keys ...ReleaseKey) []string {
	out := fingerprintsOf(keys)
	slices.Sort(out)
	return out
}

func TestEachKeyThePinsBecomeDescendsFromTheKeysThatWerePinnedBefore(t *testing.T) {
	aPrivate, a := floorKey(t, 1)
	bPrivate, b := floorKey(t, 2)
	_, c := floorKey(t, 3)
	xPrivate, x := floorKey(t, 4)
	_, y := floorKey(t, 5)

	for name, test := range map[string]struct {
		pinned    []ReleaseKey
		envelopes []RolloverEnvelope
		want      map[string][]string
	}{
		"no statement: a key descends from itself": {
			pinned: []ReleaseKey{a},
			want:   map[string][]string{a.Fingerprint(): {a.Fingerprint()}},
		},
		"a statement to a new key": {
			pinned:    []ReleaseKey{a},
			envelopes: []RolloverEnvelope{rolloverTo(t, aPrivate, b)},
			want:      map[string][]string{b.Fingerprint(): {a.Fingerprint()}},
		},
		"a chain of two statements": {
			pinned:    []ReleaseKey{a},
			envelopes: []RolloverEnvelope{rolloverTo(t, aPrivate, b), rolloverTo(t, bPrivate, c)},
			want:      map[string][]string{c.Fingerprint(): {a.Fingerprint()}},
		},
		"the chain's statements out of order: the second can't be followed yet": {
			pinned:    []ReleaseKey{a},
			envelopes: []RolloverEnvelope{rolloverTo(t, bPrivate, c), rolloverTo(t, aPrivate, b)},
			want:      map[string][]string{b.Fingerprint(): {a.Fingerprint()}},
		},
		"a statement to a key that is pinned too merges the two": {
			pinned:    []ReleaseKey{a, x},
			envelopes: []RolloverEnvelope{rolloverTo(t, aPrivate, x)},
			want:      map[string][]string{x.Fingerprint(): fingerprintsSorted(a, x)},
		},
		"one key replaced and the other left": {
			pinned:    []ReleaseKey{a, x},
			envelopes: []RolloverEnvelope{rolloverTo(t, aPrivate, b)},
			want:      map[string][]string{b.Fingerprint(): {a.Fingerprint()}, x.Fingerprint(): {x.Fingerprint()}},
		},
		"a statement that doesn't verify under the key it replaces is ignored": {
			pinned:    []ReleaseKey{a},
			envelopes: []RolloverEnvelope{statementNotSignedBy(t, a, b, xPrivate)},
			want:      map[string][]string{a.Fingerprint(): {a.Fingerprint()}},
		},
		"a statement from a key that isn't pinned is ignored": {
			pinned:    []ReleaseKey{a},
			envelopes: []RolloverEnvelope{rolloverTo(t, xPrivate, y)},
			want:      map[string][]string{a.Fingerprint(): {a.Fingerprint()}},
		},
		"a statement that doesn't parse is ignored": {
			pinned:    []ReleaseKey{a},
			envelopes: []RolloverEnvelope{{Statement: "not base64!", Signature: ""}},
			want:      map[string][]string{a.Fingerprint(): {a.Fingerprint()}},
		},
		"the zero key is never pinned": {
			pinned: []ReleaseKey{{}, a},
			want:   map[string][]string{a.Fingerprint(): {a.Fingerprint()}},
		},
	} {
		got := rolloverLineage(test.pinned, test.envelopes)
		if !maps.EqualFunc(got, test.want, slices.Equal[[]string]) {
			t.Errorf("%s: the lineage is %v, want %v", name, got, test.want)
		}
	}
}

// The lineage follows the statements the way the release library does, so that the
// pins it ends with are the pins VerifyReleaseFiles says a host holds after the
// release.
func TestTheLineageEndsWithTheSamePinsTheReleaseLibraryFollowsTo(t *testing.T) {
	aPrivate, a := floorKey(t, 1)
	bPrivate, b := floorKey(t, 2)
	_, c := floorKey(t, 3)
	xPrivate, x := floorKey(t, 4)
	_, y := floorKey(t, 5)
	for name, envelopes := range map[string][]RolloverEnvelope{
		"none":            nil,
		"one":             {rolloverTo(t, aPrivate, b)},
		"a chain":         {rolloverTo(t, aPrivate, b), rolloverTo(t, bPrivate, c)},
		"out of order":    {rolloverTo(t, bPrivate, c), rolloverTo(t, aPrivate, b)},
		"into a pinned":   {rolloverTo(t, aPrivate, x)},
		"unrelated":       {rolloverTo(t, xPrivate, y), rolloverTo(t, aPrivate, b)},
		"not signed by a": {statementNotSignedBy(t, a, b, xPrivate)},
	} {
		pinned := []ReleaseKey{a, x}
		pins, _, err := followRollovers(pinned, map[string]uint64{}, envelopes)
		if err != nil {
			t.Fatal(err)
		}
		got := slices.Sorted(maps.Keys(rolloverLineage(pinned, envelopes)))
		want := slices.Sorted(maps.Keys(pins))
		if !slices.Equal(got, want) {
			t.Errorf("%s: the lineage ends with %v, the library with %v", name, got, want)
		}
	}
}

func TestTheFloorBeforeTheSwapIsRaisedOnEveryPinnedKeyTheSignerDescendsFrom(t *testing.T) {
	aPrivate, a := floorKey(t, 1)
	_, b := floorKey(t, 2)
	_, x := floorKey(t, 4)
	_, z := floorKey(t, 9)
	toB := rolloverTo(t, aPrivate, b)

	for name, test := range map[string]struct {
		floors    map[string]uint64
		pinned    []ReleaseKey
		envelopes []RolloverEnvelope
		signers   []ReleaseKey
		counter   uint64
		want      map[string]uint64
	}{
		"a plain release raises the signer's floor": {
			floors: map[string]uint64{a.Fingerprint(): 3}, pinned: []ReleaseKey{a}, signers: []ReleaseKey{a}, counter: 5,
			want: map[string]uint64{a.Fingerprint(): 5},
		},
		"a first release makes a floor": {
			floors: map[string]uint64{}, pinned: []ReleaseKey{a}, signers: []ReleaseKey{a}, counter: 5,
			want: map[string]uint64{a.Fingerprint(): 5},
		},
		"a floor is never lowered": {
			floors: map[string]uint64{a.Fingerprint(): 9}, pinned: []ReleaseKey{a}, signers: []ReleaseKey{a}, counter: 5,
			want: map[string]uint64{a.Fingerprint(): 9},
		},
		"a successor's release is on disk under the key the host still pins": {
			floors: map[string]uint64{a.Fingerprint(): 3}, pinned: []ReleaseKey{a}, envelopes: []RolloverEnvelope{toB}, signers: []ReleaseKey{b}, counter: 5,
			want: map[string]uint64{a.Fingerprint(): 5},
		},
		"only the keys the signer descends from": {
			floors: map[string]uint64{a.Fingerprint(): 3, x.Fingerprint(): 4}, pinned: []ReleaseKey{a, x}, envelopes: []RolloverEnvelope{toB}, signers: []ReleaseKey{b}, counter: 5,
			want: map[string]uint64{a.Fingerprint(): 5, x.Fingerprint(): 4},
		},
		"two signers raise two floors": {
			floors: map[string]uint64{}, pinned: []ReleaseKey{a, x}, signers: []ReleaseKey{a, x}, counter: 6,
			want: map[string]uint64{a.Fingerprint(): 6, x.Fingerprint(): 6},
		},
		"the floor of a key that isn't pinned stays while there is room": {
			floors: map[string]uint64{z.Fingerprint(): 8}, pinned: []ReleaseKey{a}, signers: []ReleaseKey{a}, counter: 5,
			want: map[string]uint64{a.Fingerprint(): 5, z.Fingerprint(): 8},
		},
		"a signer that isn't a pinned key's descendant raises nothing": {
			floors: map[string]uint64{a.Fingerprint(): 3}, pinned: []ReleaseKey{a}, signers: []ReleaseKey{z}, counter: 5,
			want: map[string]uint64{a.Fingerprint(): 3},
		},
	} {
		before := maps.Clone(test.floors)
		got := floorsBeforeSwap(test.floors, test.pinned, test.envelopes, test.signers, test.counter)
		if !maps.Equal(got, test.want) {
			t.Errorf("%s: %v, want %v", name, got, test.want)
		}
		if !maps.Equal(test.floors, before) {
			t.Errorf("%s: the floors it was given were changed", name)
		}
	}
}

// Whatever the statements are, the floors written before the swap are never below
// the floors the host held, and the release's counter is on disk for every pinned key
// the signer descends from: the two things a rollback has to be unable to lose.
func TestTheFloorsWrittenBeforeTheSwapCoverTheAttemptWhateverThePinsBecome(t *testing.T) {
	aPrivate, a := floorKey(t, 1)
	bPrivate, b := floorKey(t, 2)
	_, c := floorKey(t, 3)
	chain := []RolloverEnvelope{rolloverTo(t, aPrivate, b), rolloverTo(t, bPrivate, c)}
	held := map[string]uint64{a.Fingerprint(): 3}

	before := floorsBeforeSwap(held, []ReleaseKey{a}, chain, []ReleaseKey{c}, 5)
	if before[a.Fingerprint()] != 5 {
		t.Fatalf("after a release signed two keys down the chain, the key the host pins has the floor %v", before)
	}
	// If the build is taken back, the host pins a again: the release is already tried.
	pins, floors, err := followRollovers([]ReleaseKey{a}, before, chain)
	if err != nil {
		t.Fatal(err)
	}
	if _, pinned := pins[c.Fingerprint()]; !pinned || floors[c.Fingerprint()] < 5 {
		t.Fatalf("following the chain from the floors on disk gives the pins %v and the floors %v, and the release would be tried again", slices.Sorted(maps.Keys(pins)), floors)
	}
}

func TestTheFloorsAtCommitAreWhatTheLibrarySaysAHostHoldsAndTheStepKeepsTheRest(t *testing.T) {
	aPrivate, a := floorKey(t, 1)
	bPrivate, b := floorKey(t, 2)
	_, z := floorKey(t, 9)
	toB := rolloverTo(t, aPrivate, b)

	manifest := string(mustManifest(t, 7))
	signed := func(private ReleasePrivateKey, key ReleaseKey) VerifyInput {
		return signedBy(t, manifest, private, key)
	}

	// The host pinned a, and the release is signed by b, which a's statement names.
	onDisk := floorsBeforeSwap(map[string]uint64{a.Fingerprint(): 3, z.Fingerprint(): 8}, []ReleaseKey{a}, []RolloverEnvelope{toB}, []ReleaseKey{b}, 7)
	input := signed(bPrivate, b)
	input.Pins, input.Floors, input.Rollovers = []ReleaseKey{a}, onDisk, []RolloverEnvelope{toB}
	taken, err := VerifyReleaseFiles(input)
	if err != nil {
		t.Fatal(err)
	}
	got := floorsAtCommit(onDisk, []ReleaseKey{a}, taken)
	want := map[string]uint64{b.Fingerprint(): 7, z.Fingerprint(): 8}
	if !maps.Equal(got, want) {
		t.Errorf("the floors at commit are %v, want %v: the old key's floor moves to its successor, and a key that was never pinned with this release keeps its own", got, want)
	}

	// A release signed by a key that stays pinned has no statement to follow.
	plain := signed(aPrivate, a)
	plain.Pins, plain.Floors = []ReleaseKey{a}, map[string]uint64{a.Fingerprint(): 7}
	taken, err = VerifyReleaseFiles(plain)
	if err != nil {
		t.Fatal(err)
	}
	if got := floorsAtCommit(plain.Floors, []ReleaseKey{a}, taken); !maps.Equal(got, map[string]uint64{a.Fingerprint(): 7}) {
		t.Errorf("a plain release: %v", got)
	}
	// A floor the host held above the release's counter is kept.
	plain.Floors = map[string]uint64{a.Fingerprint(): 12}
	taken, err = VerifyReleaseFiles(plain)
	if err != nil {
		t.Fatal(err)
	}
	if got := floorsAtCommit(plain.Floors, []ReleaseKey{a}, taken); got[a.Fingerprint()] != 12 {
		t.Errorf("a floor was lowered at commit: %v", got)
	}
}

func mustManifest(t *testing.T, counter uint64) []byte {
	t.Helper()
	manifest, err := BuildReleaseManifest(ReleaseManifest{
		Version: "0.1.1", Counter: counter,
		IssuedAt: time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC), ExpiresAt: time.Date(2027, 4, 1, 12, 0, 0, 0, time.UTC),
		ServiceDefinition: 1,
		Artifacts: []ReleaseArtifact{{OS: "linux", Arch: "amd64", Format: "executable", File: "vectory-0.1.1-linux-amd64", Size: 10,
			SHA256: "4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return manifest
}

func TestTheFloorsKeptAreAtMostTheContractsBoundAndTheKeysThatArePinnedGoLast(t *testing.T) {
	var keys []ReleaseKey
	for seed := byte(1); seed <= 7; seed++ {
		_, key := floorKey(t, seed)
		keys = append(keys, key)
	}
	floors := map[string]uint64{}
	for i, key := range keys {
		floors[key.Fingerprint()] = uint64(10 + i)
	}
	// Two pinned keys with low floors, five others with higher ones.
	pinned := []ReleaseKey{keys[0], keys[1]}
	got := trimFloors(floors, fingerprintsOf(pinned))
	if len(got) != maxUpdateFingerprints {
		t.Fatalf("%d floors kept, the bound is %d", len(got), maxUpdateFingerprints)
	}
	for _, key := range pinned {
		if got[key.Fingerprint()] != floors[key.Fingerprint()] {
			t.Errorf("the floor of a pinned key was dropped: %v", got)
		}
	}
	// The two others kept are the highest.
	for _, key := range keys[5:] {
		if got[key.Fingerprint()] != floors[key.Fingerprint()] {
			t.Errorf("a higher floor of a key that isn't pinned was dropped: %v", got)
		}
	}
	// Within the bound nothing is dropped.
	small := map[string]uint64{keys[0].Fingerprint(): 1, keys[1].Fingerprint(): 2}
	if got := trimFloors(small, nil); !maps.Equal(got, small) {
		t.Errorf("floors within the bound were changed: %v", got)
	}
}

func TestTwoListsOfKeysAreTheSameSetWhateverTheirOrder(t *testing.T) {
	_, a := floorKey(t, 1)
	_, b := floorKey(t, 2)
	_, c := floorKey(t, 3)
	for name, test := range map[string]struct {
		left, right []ReleaseKey
		same        bool
	}{
		"the same":            {[]ReleaseKey{a, b}, []ReleaseKey{b, a}, true},
		"empty":               {nil, nil, true},
		"one apart":           {[]ReleaseKey{a, b}, []ReleaseKey{a, c}, false},
		"one more":            {[]ReleaseKey{a}, []ReleaseKey{a, b}, false},
		"the zero key counts": {[]ReleaseKey{a, {}}, []ReleaseKey{a}, true},
	} {
		if got := sameFingerprints(test.left, test.right); got != test.same {
			t.Errorf("%s: %v", name, got)
		}
	}
}
