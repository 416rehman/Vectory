package agent

import (
	"context"
	"strings"
	"testing"
)

// Any 0.58 patch release is supported; other minors, pre-releases and
// malformed strings are not. The agent accepts exactly the strings the
// server's vector_compatible accepts (server/src/validation.rs): an optional
// "v" and build details after a space are ignored.
func TestVectorPatchReleasesAreSupported(t *testing.T) {
	for _, version := range []string{
		"0.58.0", "0.58.1", "v0.58.12", "0.58.2 (x86_64-unknown-linux-gnu 0f0e3d1 2026-05-01)", "  0.58.3", VectorVersion,
	} {
		if !SupportedVectorVersion(version) {
			t.Errorf("%q refused", version)
		}
	}
	for _, version := range []string{
		"", "0.58", "0.58.", "0.57.0", "0.59.0", "0.580.0", "0.58.x", "0.58.1-rc1", "0.58.1-rc.1", "1.58.0", "10.58.0", "0.58.12345", "vv0.58.1", "x0.58.1",
	} {
		if SupportedVectorVersion(version) {
			t.Errorf("%q accepted", version)
		}
	}
	if !strings.HasPrefix(VectorVersion, vectorSupportedSeries+".") || VectorSeries != vectorSupportedSeries+".x" {
		t.Fatal("the built-in release must belong to the supported series")
	}
	// The heartbeat reports the adopted binary's clean release, and never an
	// unsupported recorded value.
	for recorded, want := range map[string]string{
		"0.58.3": "0.58.3", "v0.58.4 (x86_64-unknown-linux-gnu 0f0e3d1 2026-05-01)": "0.58.4", "": VectorVersion, "0.59.0": VectorVersion, "garbage": VectorVersion,
	} {
		if got := (Settings{VectorVersion: recorded}).adoptedVectorVersion(); got != want {
			t.Errorf("recorded %q reported as %q, want %q", recorded, got, want)
		}
	}
}

// A patch difference between a manifest and the adopted binary is not a
// conflict, in either direction; another minor version still is.
func TestSameVectorSeriesIgnoresPatchReleases(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want bool
	}{
		{"0.58.0", "0.58.3", true},
		{"0.58.3", "0.58.0", true},
		{"v0.58.1", "0.58.2 (x86_64-unknown-linux-gnu 0f0e3d1 2026-05-01)", true},
		{"0.58.0", "0.59.0", false},
		{"0.57.9", "0.58.0", false},
		{"1.58.0", "0.58.0", false},
		{"0.58.1-rc1", "0.58.1", false},
		{"", "0.58.0", false},
		{"0.58.0", "", false},
		{"", "", false},
	} {
		if got := sameVectorSeries(tc.a, tc.b); got != tc.want {
			t.Errorf("sameVectorSeries(%q, %q) = %v", tc.a, tc.b, got)
		}
	}
}

// The server still stamps every manifest with "0.58.0". A device that runs a
// patch release compares the manifest's version with its own adopted binary
// by minor series, so the pipeline applies; any other series is refused with
// a message that names both versions.
func TestManifestVectorVersionOnlyNeedsTheSameMinorSeries(t *testing.T) {
	for _, tc := range []struct {
		name, adopted, manifest string
		accepted                bool
	}{
		{"server pin, newer patch on the device", "0.58.3", "0.58.0", true},
		{"newer patch in the manifest", "0.58.0", "0.58.7", true},
		{"v prefix", "0.58.2", "v0.58.1", true},
		{"build details", "0.58.2", "0.58.1 (x86_64-unknown-linux-gnu 0f0e3d1 2026-05-01)", true},
		{"install from before the version was recorded", "", "0.58.4", true},
		{"next minor", "0.58.3", "0.59.0", false},
		{"previous minor", "0.58.3", "0.57.9", false},
		{"other major", "0.58.3", "1.58.0", false},
		{"pre-release", "0.58.3", "0.58.1-rc1", false},
		{"no version", "0.58.3", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, m, d := fixture(t, newConfig)
			e.Settings.VectorVersion = tc.adopted
			m.Desired.VectorVersion = tc.manifest
			err := e.Reconcile(context.Background(), m)
			if tc.accepted {
				if err != nil || e.State.ApplyState != "verified_applied" || d.starts != 1 {
					t.Fatalf("manifest %q refused on a device running %q: %v %+v", tc.manifest, tc.adopted, err, e.State.Error)
				}
				requireAttempt(t, e, m, "verified_applied", "")
				return
			}
			if err == nil || d.starts != 0 {
				t.Fatalf("manifest %q applied on a device running %q", tc.manifest, tc.adopted)
			}
			requireAttempt(t, e, m, "failed", "INCOMPATIBLE")
			message := e.State.Error.Message
			running := tc.adopted
			if running == "" {
				running = VectorVersion
			}
			if !strings.Contains(message, "this device runs Vector "+running) || !strings.Contains(message, "patch releases of the same minor version") {
				t.Fatalf("message doesn't explain the conflict: %q", message)
			}
			if tc.manifest != "" && !strings.Contains(message, "built for Vector "+tc.manifest) && !strings.Contains(message, "built for Vector "+strings.Fields(tc.manifest)[0]) {
				t.Fatalf("message doesn't name the manifest's version %q: %q", tc.manifest, message)
			}
			// `vectory status` shows it on the Pipeline row.
			if row := (&StatusView{State: e.State}).pipeline(); !strings.Contains(row, message) {
				t.Fatalf("status doesn't show the conflict: %q", row)
			}
		})
	}
}

// A pre-release or custom build reports a version Vector's own startup record
// repeats, which the agent never acknowledges: setup must refuse it up front,
// naming the version, instead of adopting it and timing out every activation.
func TestPreReleaseBinaryIsRefusedWithItsFullVersion(t *testing.T) {
	for _, version := range []string{"0.58.1-rc1", "0.58.0-nightly-2026-09-01", "0.58.2-custom.1"} {
		binary := fakeVector(t, version)
		if found := InspectVector(context.Background(), binary); found.Version != version || found.Problem == "" {
			t.Errorf("inspect %s: %+v", version, found)
		}
		if got, err := ProbeVector(context.Background(), Settings{VectorBinary: binary}); err == nil {
			t.Errorf("probe accepted %s as %q", version, got)
		}
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
