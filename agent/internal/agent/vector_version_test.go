package agent

import (
	"context"
	"testing"
)

// Any 0.58 patch release is supported; other minors, pre-releases and
// malformed strings are not.
func TestVectorPatchReleasesAreSupported(t *testing.T) {
	for version, want := range map[string]bool{
		"0.58.0": true, "0.58.1": true, "0.58.12": true,
		"0.57.0": false, "0.59.0": false, "0.58": false, "0.58.1-rc.1": false, "10.58.0": false, "": false,
	} {
		if got := SupportedVectorVersion(version); got != want {
			t.Errorf("%q: %v", version, got)
		}
	}
	if (Settings{VectorVersion: "0.58.3"}).adoptedVectorVersion() != "0.58.3" || (Settings{}).adoptedVectorVersion() != VectorVersion {
		t.Fatal("the heartbeat must report the adopted binary's version")
	}
}

func TestPatchReleaseBinaryIsAdoptedAndReportsItsVersion(t *testing.T) {
	binary := fakeVector(t, "0.58.2")
	if found := InspectVector(context.Background(), binary); found.Problem != "" || found.Version != "0.58.2" {
		t.Fatalf("inspect: %+v", found)
	}
	version, err := ProbeVector(context.Background(), Settings{VectorBinary: binary})
	if err != nil || version != "0.58.2" {
		t.Fatalf("probe = %q, %v", version, err)
	}
	if _, err = ProbeVector(context.Background(), Settings{VectorBinary: fakeVector(t, "0.59.0")}); err == nil {
		t.Fatal("0.59.0 accepted")
	}
	l := newVectorLog("")
	_, _ = l.Write([]byte(`{"level":"INFO","target":"vector","message":"Vector has started.","version":"0.58.2"}` + "\n"))
	if l.signals.started != 1 {
		t.Fatal("a patch release's startup acknowledgment was not accepted")
	}
}
