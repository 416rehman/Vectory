package agent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// An offer of an agent build and a configuration apply in one check-in, with a
// real Vector: the apply finishes first (Vector validated, started and verified
// running), and only then is the build asked for.
func TestNativeAnOfferAndAConfigurationApplyInOneCheckIn(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for the native update tests")
	}
	rig := newOfferRig(t)
	dataDir := t.TempDir()
	var configuration map[string]any
	if err := json.Unmarshal(newConfig, &configuration); err != nil {
		t.Fatal(err)
	}
	configuration["data_dir"] = dataDir
	nativeConfig, err := json.Marshal(configuration)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	rig.e.Settings.CapabilityPolicy.AllowedFileRoots = []string{dataDir}
	rig.e.Settings.VectorBinary, rig.e.Settings.VectorBinarySHA256 = binary, digest
	rig.e.Settings.ValidationSeconds, rig.e.Settings.StartupSeconds = 30, 20
	log := newVectorLog(rig.state)
	driver := &VectorDriver{Settings: rig.e.Settings, Dir: rig.state, Log: log}
	rig.e.Driver = driver
	// Windows can't remove a directory that holds a file still open, so Vector is
	// stopped and its log closed before the temporary directory goes, as the other
	// native tests do.
	t.Cleanup(func() { _ = driver.Stop(); log.close() })

	// What the handler saw when the build was asked for: whether the new
	// configuration was already in place, verified, with Vector running.
	var mu sync.Mutex
	var sawApplied []bool
	rig.answerWith(func(w http.ResponseWriter, r *http.Request) {
		managed, _ := os.ReadFile(rig.managed)
		_, good := os.Stat(filepath.Join(rig.state, "good-"+Digest(nativeConfig)+".json"))
		mu.Lock()
		sawApplied = append(sawApplied, bytes.Equal(managed, nativeConfig) && good == nil)
		mu.Unlock()
		rig.sendBuild(w, r)
	})
	rig.plane.offer("/agent/v1/artifacts/"+Digest(nativeConfig), nativeConfig)
	rig.plane.with(func(m *Manifest) {
		m.Generation++
		m.Desired = &Desired{VersionID: "v2", SHA256: Digest(nativeConfig), Size: int64(len(nativeConfig)), ArtifactPath: "/agent/v1/artifacts/" + Digest(nativeConfig), VectorVersion: VectorVersion}
	})

	rig.poll()
	if rig.e.State.ApplyState != "verified_applied" || !driver.Alive() || rig.e.actual() != Digest(nativeConfig) {
		t.Fatalf("the configuration wasn't applied by the end of the check-in that brought the offer: %s %v", rig.e.State.ApplyState, rig.e.State.Error)
	}
	if rig.e.update.decision.state != UpdateStateDownloading {
		t.Fatalf("the build didn't wait for the apply and start after it: %+v", rig.e.update.decision)
	}
	rig.settle()
	rig.poll()
	mu.Lock()
	saw := append([]bool(nil), sawApplied...)
	mu.Unlock()
	if len(saw) != 1 || !saw[0] {
		t.Fatalf("the build was asked for before the apply had finished: %v", saw)
	}
	if beat := rig.beat(); beat["state"] != "staged" || beat["release"] != rig.releaseSHA {
		t.Fatalf("the host reports %v", beat)
	}
	health, err := ReadUpdateHealth(rig.exchange().Health)
	if err != nil || health.Vector != UpdateVectorRunning || health.Offer != rig.releaseSHA {
		t.Fatalf("health.json is %+v (%v)", health, err)
	}
	if _, err := ReadUpdateRequest(rig.exchange().Request); err != nil {
		t.Fatal(err)
	}
}
