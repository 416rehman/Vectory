package agent

import (
	"reflect"
	"testing"
)

// The agent writes the rollover statements of an offer to rollovers.json for the
// privileged step to verify, so the file must hold every chain that verifies in
// the shared vectors, as it was sent, and must not hold a chain that is too long
// to verify.
func TestRolloversOfTheSharedVectorsAreFilesTheReaderAndTheWriterAgreeOn(t *testing.T) {
	vectors := loadReleaseVectors(t)
	var chains, tooLong int
	for _, vector := range vectors.Cases {
		if len(vector.Rollovers) == 0 {
			continue
		}
		envelopes := make([]RolloverEnvelope, len(vector.Rollovers))
		for i, rollover := range vector.Rollovers {
			envelopes[i] = RolloverEnvelope{Statement: rollover.StatementB64, Signature: rollover.SignatureB64}
		}
		t.Run(vector.Name, func(t *testing.T) {
			data, err := MarshalUpdateRollovers(envelopes)
			if len(envelopes) > MaxRolloverChain {
				tooLong++
				if err == nil {
					t.Errorf("a chain of %d statements was written, and a host follows at most %d", len(envelopes), MaxRolloverChain)
				}
				return
			}
			if vector.Expect.Result != "valid" {
				// What failed to verify may still have the shape of a chain; the reader
				// checks the shape, and VerifyRelease says whether it verifies.
				return
			}
			chains++
			if err != nil {
				t.Fatalf("a chain that verifies in the vectors can't be written: %v", err)
			}
			back, err := ParseUpdateRollovers(data)
			if err != nil || !reflect.DeepEqual(back, envelopes) {
				t.Errorf("the chain came back as %v, %v", back, err)
			}
		})
	}
	if chains < 10 || tooLong < 1 {
		t.Errorf("%d chains that verify and %d that are too long were checked; the vectors hold at least 10 and 1", chains, tooLong)
	}
}
