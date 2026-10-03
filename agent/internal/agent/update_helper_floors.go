package agent

import (
	"maps"
	"slices"
	"sort"
)

// Counter floors and rollovers.
//
// A floor is the highest counter of a release signed by a key that the step
// attempted. counters.json holds one for each key the host pins and for the keys it
// pinned before, and a floor is only ever raised: a release at or below a signer's
// floor is refused, which is what stops a server from making a host try a release
// twice. Nothing lowers a floor, moves it from one key to another or removes it,
// whatever happens to the pins.
//
// A rollover replaces a pinned key with its successor. The release library decides
// with the larger of the old key's floor and the successor's, and says what a host
// holds after a release in Verified.Floors, which leaves out the key the chain
// replaces. The step doesn't write that map in place of the file's floors: it
// raises the file's floors to it (raiseFloors), and the file keeps both keys'. The
// pins move at commit, when the build that came with the statement has proven
// itself, so for the whole trial, and for ever after a rollback, the host pins the
// key that was replaced; the floors on disk when the service stops are the ones the
// host has if the trial fails, and the old key's is among them. Without it a release
// the old key signed, tried here and rolled back, would be accepted again.

// maxStoredFloors bounds counters.json: the floors of the keys a host pins (at most
// four) and of the keys it pinned before. Beyond it the lowest go first. Counters
// come from one sequence, so the lowest floor is the one raised longest ago, and the
// floor of a key the host pins is never dropped for another's.
const maxStoredFloors = 16

// raiseFloors is the floors after an attempt: every floor that is stored, with each
// floor in taken (what the release library says a host holds after the release) at
// least that high. A floor is never lowered, removed or moved to another key. At most
// maxStoredFloors are kept, those of the keys in keep last to go.
func raiseFloors(stored, taken map[string]uint64, keep []string) map[string]uint64 {
	raised := make(map[string]uint64, len(stored)+len(taken))
	maps.Copy(raised, stored)
	for fingerprint, floor := range taken {
		if floor > raised[fingerprint] {
			raised[fingerprint] = floor
		}
	}
	return trimFloors(raised, keep, maxStoredFloors)
}

// replacePins is the pins after the statements of an offer: a statement that
// parses, replaces a key pinned at that point of the chain and verifies under that
// key puts its successor in that key's place, and every other pin stays where it is.
// It follows the statements as the release library does, which has already refused a
// fork and said what the pins are after them; the step compares the two before it
// writes anything.
func replacePins(pinned []ReleaseKey, envelopes []RolloverEnvelope) []ReleaseKey {
	pins := make([]ReleaseKey, 0, len(pinned))
	for _, key := range pinned {
		if !key.IsZero() {
			pins = append(pins, key)
		}
	}
	indexOf := func(fingerprint string) int {
		return slices.IndexFunc(pins, func(key ReleaseKey) bool { return key.Fingerprint() == fingerprint })
	}
	for _, envelope := range envelopes {
		statement, err := envelope.Parse()
		if err != nil {
			continue
		}
		at := indexOf(statement.From)
		if at < 0 || !statement.VerifiedBy(pins[at]) {
			continue
		}
		if indexOf(statement.To.Fingerprint()) >= 0 {
			// The successor is pinned already: it stays where it is, and the key it
			// replaces goes.
			pins = slices.Delete(pins, at, at+1)
			continue
		}
		pins[at] = statement.To
	}
	return pins
}

func fingerprintsOf(keys []ReleaseKey) []string {
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		if !key.IsZero() {
			out = append(out, key.Fingerprint())
		}
	}
	return out
}

// trimFloors keeps at most limit floors: those of the keys in keep first, then the
// highest of the others.
func trimFloors(floors map[string]uint64, keep []string, limit int) map[string]uint64 {
	if len(floors) <= limit {
		return floors
	}
	kept := map[string]bool{}
	for _, fingerprint := range keep {
		kept[fingerprint] = true
	}
	order := make([]string, 0, len(floors))
	for fingerprint := range floors {
		order = append(order, fingerprint)
	}
	sort.Slice(order, func(i, j int) bool {
		a, b := order[i], order[j]
		if kept[a] != kept[b] {
			return kept[a]
		}
		if floors[a] != floors[b] {
			return floors[a] > floors[b]
		}
		return a < b
	})
	trimmed := make(map[string]uint64, limit)
	for _, fingerprint := range order[:limit] {
		trimmed[fingerprint] = floors[fingerprint]
	}
	return trimmed
}

// sameFingerprints reports whether two lists of keys are the same set of keys.
func sameFingerprints(a, b []ReleaseKey) bool {
	left, right := fingerprintsOf(a), fingerprintsOf(b)
	if len(left) != len(right) {
		return false
	}
	sort.Strings(left)
	sort.Strings(right)
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
