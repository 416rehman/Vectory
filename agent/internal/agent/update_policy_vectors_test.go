package agent

import (
	"encoding/json"
	"errors"
	"testing"
)

// The policy is where a host's pinned keys are read, so it must take exactly the
// key lines the release library takes: the shared vectors hold the lines that
// are valid and the ones that look valid and are not (a name with a control
// character, a key that is a point of small order, base64 that is not
// canonical), and a line the library refuses must never become a pin.
func TestThePolicyTakesTheKeyLinesTheSharedVectorsAccept(t *testing.T) {
	vectors := loadReleaseVectors(t)
	var valid, refused int
	for _, vector := range vectors.KeyLines {
		t.Run(vector.Name, func(t *testing.T) {
			line, err := json.Marshal(vector.Line)
			if err != nil {
				t.Fatal(err)
			}
			policy := `{"schema":"vectory.update-policy.v1","consent":"auto","track":"patch","windows":[],"paused":false,` +
				`"keys":[{"public_key":` + string(line) + `,"pinned_at":"2026-10-03T12:30:00Z"}],"updated_at":"2026-10-03T12:30:00Z"}`
			parsed, err := ParseUpdatePolicy([]byte(policy))
			switch vector.Expect.Result {
			case "valid":
				valid++
				if err != nil {
					t.Fatalf("%q: %v", vector.Line, err)
				}
				if got := parsed.Keys[0].Key; got.Fingerprint() != vector.Expect.Fingerprint || got.Name() != vector.Expect.Name {
					t.Errorf("%q was read as %s %q; the vector says %s %q", vector.Line, got.Fingerprint(), got.Name(), vector.Expect.Fingerprint, vector.Expect.Name)
				}
				// And what the policy writes for it is the line the vectors accept.
				data, err := MarshalUpdatePolicy(parsed)
				if err != nil {
					t.Fatal(err)
				}
				if again, err := ParseUpdatePolicy(data); err != nil || again.Keys[0].Key.Line() != parsed.Keys[0].Key.Line() {
					t.Errorf("the key changed when the policy was written and read: %v", err)
				}
			case "refused":
				refused++
				if !errors.Is(err, ErrUpdatePolicyInvalid) {
					t.Errorf("%q (%s) was accepted as a pin, or refused with the wrong error: %v", vector.Line, vector.About, err)
				}
			default:
				t.Fatalf("the vector's result is %q", vector.Expect.Result)
			}
		})
	}
	if valid < 8 || refused < 40 {
		t.Errorf("%d valid and %d refused key lines were checked; the vectors hold at least 8 and 40", valid, refused)
	}
}
