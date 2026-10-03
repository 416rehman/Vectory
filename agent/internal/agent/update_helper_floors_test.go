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

// A floor is only ever raised. The release library says what a host holds after a
// release, and leaves out the key a statement of the offer replaces; the file keeps
// that key's floor beside its successor's, and every floor of a key that isn't pinned.
func TestRaisingFloorsNeverLowersRemovesOrMovesOne(t *testing.T) {
	_, a := floorKey(t, 1)
	_, b := floorKey(t, 2)
	_, z := floorKey(t, 9)
	fa, fb, fz := a.Fingerprint(), b.Fingerprint(), z.Fingerprint()

	for name, test := range map[string]struct {
		stored, taken, want map[string]uint64
	}{
		"a first attempt makes a floor": {
			stored: map[string]uint64{}, taken: map[string]uint64{fa: 5},
			want: map[string]uint64{fa: 5},
		},
		"a floor is raised": {
			stored: map[string]uint64{fa: 3}, taken: map[string]uint64{fa: 5},
			want: map[string]uint64{fa: 5},
		},
		"a floor is never lowered": {
			stored: map[string]uint64{fa: 9}, taken: map[string]uint64{fa: 5},
			want: map[string]uint64{fa: 9},
		},
		"the key a statement replaces keeps its floor beside its successor's": {
			stored: map[string]uint64{fa: 10}, taken: map[string]uint64{fb: 11},
			want: map[string]uint64{fa: 10, fb: 11},
		},
		"the floor of a key that isn't pinned is kept": {
			stored: map[string]uint64{fz: 8}, taken: map[string]uint64{fa: 5},
			want: map[string]uint64{fa: 5, fz: 8},
		},
		"a successor's floor above the release's counter is kept": {
			stored: map[string]uint64{fa: 10, fb: 14}, taken: map[string]uint64{fb: 11},
			want: map[string]uint64{fa: 10, fb: 14},
		},
		"nothing taken changes nothing": {
			stored: map[string]uint64{fa: 4, fz: 8}, taken: map[string]uint64{},
			want: map[string]uint64{fa: 4, fz: 8},
		},
		"a floor of zero makes no entry": {
			stored: map[string]uint64{}, taken: map[string]uint64{fa: 0},
			want: map[string]uint64{},
		},
	} {
		stored, taken := maps.Clone(test.stored), maps.Clone(test.taken)
		got := raiseFloors(stored, taken, []string{fa})
		if !maps.Equal(got, test.want) {
			t.Errorf("%s: %v, want %v", name, got, test.want)
		}
		if !maps.Equal(stored, test.stored) || !maps.Equal(taken, test.taken) {
			t.Errorf("%s: what it was given was changed", name)
		}
	}
}

// counters.json keeps the floors of the keys a host pinned before, up to a bound; past
// it the lowest go, which are the ones raised longest ago because counters come from
// one sequence, and a pinned key's floor is never what goes.
func TestTheFileKeepsSixteenFloorsAndTheLowestOfTheKeysThatArentPinnedGoFirst(t *testing.T) {
	stored := map[string]uint64{}
	var keys []ReleaseKey
	for seed := byte(1); seed <= 20; seed++ {
		_, key := floorKey(t, seed)
		keys = append(keys, key)
		stored[key.Fingerprint()] = uint64(seed)
	}
	// Two pinned keys with the lowest floors of all.
	pinned := []string{keys[0].Fingerprint(), keys[1].Fingerprint()}
	got := raiseFloors(stored, map[string]uint64{keys[19].Fingerprint(): 30}, pinned)
	if len(got) != maxStoredFloors {
		t.Fatalf("%d floors kept, the bound is %d", len(got), maxStoredFloors)
	}
	for _, fingerprint := range pinned {
		if got[fingerprint] != stored[fingerprint] {
			t.Errorf("the floor of a pinned key was dropped: %v", got)
		}
	}
	if got[keys[19].Fingerprint()] != 30 {
		t.Errorf("the floor that was raised isn't there: %v", got)
	}
	// Of the others (keys 3 to 20), the 14 highest stay and the four lowest go.
	for i, key := range keys[2:] {
		_, kept := got[key.Fingerprint()]
		if want := i >= 4; kept != want {
			t.Errorf("the floor of key %d is kept: %v, want %v", i+3, kept, want)
		}
	}
	// Within the bound nothing is dropped.
	small := map[string]uint64{keys[0].Fingerprint(): 1, keys[1].Fingerprint(): 2}
	if got := raiseFloors(small, nil, nil); !maps.Equal(got, small) {
		t.Errorf("floors within the bound were changed: %v", got)
	}
}

// What status.json reports is at most four floors, those of the pinned keys first and
// then the highest.
func TestStatusReportsAtMostFourFloorsAndThePinnedKeysFirst(t *testing.T) {
	var keys []ReleaseKey
	floors := map[string]uint64{}
	for seed := byte(1); seed <= 7; seed++ {
		_, key := floorKey(t, seed)
		keys = append(keys, key)
		floors[key.Fingerprint()] = uint64(10 + seed)
	}
	// Two pinned keys with low floors, five others with higher ones.
	pinned := []string{keys[0].Fingerprint(), keys[1].Fingerprint()}
	got := trimFloors(floors, pinned, maxUpdateFingerprints)
	if len(got) != maxUpdateFingerprints {
		t.Fatalf("%d floors kept, the bound is %d", len(got), maxUpdateFingerprints)
	}
	for _, fingerprint := range pinned {
		if got[fingerprint] != floors[fingerprint] {
			t.Errorf("the floor of a pinned key was dropped: %v", got)
		}
	}
	// The two others kept are the highest.
	for _, key := range keys[5:] {
		if got[key.Fingerprint()] != floors[key.Fingerprint()] {
			t.Errorf("a higher floor of a key that isn't pinned was dropped: %v", got)
		}
	}
	small := map[string]uint64{keys[0].Fingerprint(): 1, keys[1].Fingerprint(): 2}
	if got := trimFloors(small, nil, maxUpdateFingerprints); !maps.Equal(got, small) {
		t.Errorf("floors within the bound were changed: %v", got)
	}
}

// The pins after an offer's statements, edited in place: a successor takes its
// predecessor's place and every other pin stays where it is.
func TestReplacingPinsPutsASuccessorWhereItsPredecessorWasAndLeavesEveryOtherPinWhereItIs(t *testing.T) {
	aPrivate, a := floorKey(t, 1)
	bPrivate, b := floorKey(t, 2)
	_, c := floorKey(t, 3)
	xPrivate, x := floorKey(t, 4)
	_, y := floorKey(t, 5)
	_, w := floorKey(t, 6)

	for name, test := range map[string]struct {
		pinned    []ReleaseKey
		envelopes []RolloverEnvelope
		want      []ReleaseKey
	}{
		"no statement": {
			pinned: []ReleaseKey{a, x}, want: []ReleaseKey{a, x},
		},
		"a statement to a new key, the first pin": {
			pinned: []ReleaseKey{a, x}, envelopes: []RolloverEnvelope{rolloverTo(t, aPrivate, b)},
			want: []ReleaseKey{b, x},
		},
		"a statement to a new key, the last pin": {
			pinned: []ReleaseKey{x, a}, envelopes: []RolloverEnvelope{rolloverTo(t, aPrivate, b)},
			want: []ReleaseKey{x, b},
		},
		"a chain of two statements": {
			pinned: []ReleaseKey{a, x}, envelopes: []RolloverEnvelope{rolloverTo(t, aPrivate, b), rolloverTo(t, bPrivate, c)},
			want: []ReleaseKey{c, x},
		},
		"the chain's statements out of order: the second can't be followed yet": {
			pinned: []ReleaseKey{a, x}, envelopes: []RolloverEnvelope{rolloverTo(t, bPrivate, c), rolloverTo(t, aPrivate, b)},
			want: []ReleaseKey{b, x},
		},
		"a statement to a key that is pinned too: the successor stays where it is": {
			pinned: []ReleaseKey{a, w, x}, envelopes: []RolloverEnvelope{rolloverTo(t, aPrivate, x)},
			want: []ReleaseKey{w, x},
		},
		"two keys replaced": {
			pinned: []ReleaseKey{a, x}, envelopes: []RolloverEnvelope{rolloverTo(t, xPrivate, y), rolloverTo(t, aPrivate, b)},
			want: []ReleaseKey{b, y},
		},
		"a statement that doesn't verify under the key it replaces is ignored": {
			pinned: []ReleaseKey{a, x}, envelopes: []RolloverEnvelope{statementNotSignedBy(t, a, b, xPrivate)},
			want: []ReleaseKey{a, x},
		},
		"a statement from a key that isn't pinned is ignored": {
			pinned: []ReleaseKey{a}, envelopes: []RolloverEnvelope{rolloverTo(t, xPrivate, y)},
			want: []ReleaseKey{a},
		},
		"a statement that doesn't parse is ignored": {
			pinned: []ReleaseKey{a}, envelopes: []RolloverEnvelope{{Statement: "not base64!", Signature: ""}},
			want: []ReleaseKey{a},
		},
		"the zero key is never pinned": {
			pinned: []ReleaseKey{{}, a}, want: []ReleaseKey{a},
		},
	} {
		got := fingerprintsOf(replacePins(test.pinned, test.envelopes))
		if want := fingerprintsOf(test.want); !slices.Equal(got, want) {
			t.Errorf("%s: the pins are %v, want %v", name, shortList(got), shortList(want))
		}
		// The release library, which refuses a fork and says what a host pins after
		// the statements, ends with the same set.
		pins, _, err := followRollovers(test.pinned, map[string]uint64{}, test.envelopes)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got, want := slices.Sorted(maps.Keys(pins)), fingerprintsSortedOf(test.want); !slices.Equal(got, want) {
			t.Errorf("%s: the library follows to %v, and the edit to %v", name, shortList(want), shortList(got))
		}
	}
}

func fingerprintsSortedOf(keys []ReleaseKey) []string {
	out := fingerprintsOf(keys)
	slices.Sort(out)
	return out
}

func shortList(fingerprints []string) []string {
	out := make([]string, len(fingerprints))
	for i, fingerprint := range fingerprints {
		out[i] = shortFingerprint(fingerprint)[:6]
	}
	return out
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
