package agent

import (
	"maps"
	"sort"
)

// Counter floors and rollovers.
//
// A floor is the highest counter of a release signed by a key that the step
// attempted. counters.json holds one for each key, at most four (the contract's
// bound), and a floor is never lowered: a release at or below a signer's floor is
// refused, which is what stops a server from making a host try a release twice.
//
// A rollover replaces a pinned key with its successor, and the successor takes the
// old key's floor. The step moves the pins only at commit, when the build that
// came with the statement has proven itself, so for the whole trial (and for ever
// after a rollback, which leaves the pins where they were) the host still pins the
// key that was replaced, and a release signed by its successor is checked, by
// followRollovers, against the floor the old key carries over. The step therefore
// records an attempt on the keys the host pins now:
//
//   - before the swap, the floor of every pinned key that the signer descends from
//     through the statements is raised to the release's counter, so that the
//     attempt is on disk under the key the host will still pin if the trial rolls
//     back, and the successor's own floor needs no entry yet;
//   - at commit, when the pins become what the statements say, the floors become
//     what VerifyReleaseFiles says a host holds after the release: the old key's
//     floor moved to the successor and raised to the counter.
//
// Floors of keys that were never pinned together with a release (left from an
// earlier set of pins) are kept until there is no room, and are the first to go.

// rolloverLineage follows the offer's statements as VerifyRelease does (a
// statement counts when it parses, replaces a key that is pinned at that point of
// the chain and verifies under that key) and says, for each key pinned afterwards,
// which of the keys pinned before it descends from, sorted. A key that was pinned
// and not replaced descends from itself.
func rolloverLineage(pinned []ReleaseKey, envelopes []RolloverEnvelope) map[string][]string {
	pins := make(map[string]ReleaseKey, len(pinned))
	origin := make(map[string]map[string]bool, len(pinned))
	for _, key := range pinned {
		if key.IsZero() {
			continue
		}
		fingerprint := key.Fingerprint()
		pins[fingerprint] = key
		origin[fingerprint] = map[string]bool{fingerprint: true}
	}
	for _, envelope := range envelopes {
		statement, err := envelope.Parse()
		if err != nil {
			continue
		}
		replaced, isPinned := pins[statement.From]
		if !isPinned || !statement.VerifiedBy(replaced) {
			continue
		}
		successor := statement.To.Fingerprint()
		merged := map[string]bool{}
		maps.Copy(merged, origin[successor])
		maps.Copy(merged, origin[statement.From])
		delete(pins, statement.From)
		delete(origin, statement.From)
		pins[successor] = statement.To
		origin[successor] = merged
	}
	lineage := make(map[string][]string, len(origin))
	for fingerprint, from := range origin {
		for ancestor := range from {
			lineage[fingerprint] = append(lineage[fingerprint], ancestor)
		}
		sort.Strings(lineage[fingerprint])
	}
	return lineage
}

// floorsBeforeSwap are the floors the step writes before it stops the service:
// every floor already there, with the floor of each key the host pins now that a
// signer descends from raised to the release's counter. It never lowers a floor.
func floorsBeforeSwap(floors map[string]uint64, pinned []ReleaseKey, envelopes []RolloverEnvelope, signers []ReleaseKey, counter uint64) map[string]uint64 {
	lineage := rolloverLineage(pinned, envelopes)
	raised := make(map[string]uint64, len(floors)+1)
	maps.Copy(raised, floors)
	for _, signer := range signers {
		for _, ancestor := range lineage[signer.Fingerprint()] {
			raised[ancestor] = max(raised[ancestor], counter)
		}
	}
	return trimFloors(raised, fingerprintsOf(pinned))
}

// floorsAtCommit are the floors once the pins are what the release's statements
// say: what VerifyReleaseFiles says a host holds (the floors of the keys pinned
// afterwards, the old key's moved to its successor), and the floors the step kept
// for keys that were not pinned before or after.
func floorsAtCommit(current map[string]uint64, pinnedBefore []ReleaseKey, taken Verified) map[string]uint64 {
	was := map[string]bool{}
	for _, fingerprint := range fingerprintsOf(pinnedBefore) {
		was[fingerprint] = true
	}
	floors := make(map[string]uint64, len(taken.Floors))
	maps.Copy(floors, taken.Floors)
	for fingerprint, floor := range current {
		if _, pinnedNow := floors[fingerprint]; !pinnedNow && !was[fingerprint] {
			floors[fingerprint] = floor
		}
	}
	return trimFloors(floors, fingerprintsOf(taken.Pins))
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

// trimFloors keeps at most maxUpdateFingerprints floors: those of the keys in keep
// first, then the highest of the others.
func trimFloors(floors map[string]uint64, keep []string) map[string]uint64 {
	if len(floors) <= maxUpdateFingerprints {
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
	trimmed := make(map[string]uint64, maxUpdateFingerprints)
	for _, fingerprint := range order[:maxUpdateFingerprints] {
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
