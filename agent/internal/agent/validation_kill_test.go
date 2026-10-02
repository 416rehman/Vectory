package agent

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The agent process is killed for real at the moment a check has staged its
// copy of the candidate, and restarted. The killed check leaves its staged copy
// (a process that is gone can't delete it); the next start deletes it before
// anything else, whatever its age, the managed file and the last known good
// are as the apply left them, and the lock is free.
func TestKillInTheMiddleOfACheckLeavesNothingAfterTheNextStart(t *testing.T) {
	d := newApplyDevice(t)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	request := ValidationRequest{ID: checkID, SHA256: d.m.Desired.SHA256, Size: d.m.Desired.Size, ArtifactPath: d.m.Desired.ArtifactPath, ExpiresAt: time.Now().UTC().Add(10 * time.Minute).Truncate(time.Second)}
	asking := d.m
	asking.Features, asking.Validation = []string{featureValidation}, mustJSON(t, request)
	plane := newKillControlPlane(t, asking, privateKey, newConfig)
	killing := killRequest{Dir: d.e.Dir, Managed: d.managed, Server: plane.URL, PublicKey: base64.StdEncoding.EncodeToString(publicKey), Mode: "apply", Stop: "validation_staged"}

	child := startKillChild(t, killing)
	child.waitFor(t, "stage validation_staged")
	child.kill(t)

	staging := filepath.Join(d.e.Dir, validationStagingName)
	entries, err := os.ReadDir(staging)
	if err != nil || len(entries) == 0 {
		t.Fatalf("the killed check left no staged copy to delete: %v %v", entries, err)
	}
	// The apply finished before the check began: the killed check changed none
	// of what it left.
	if managed, err := os.ReadFile(d.managed); err != nil || Digest(managed) != Digest(newConfig) {
		t.Fatalf("the managed file is %q: %v", managed, err)
	}
	if journalStage(t, d.e.Dir) != "" {
		t.Fatal("a journal was left behind")
	}
	if good, err := os.ReadFile(filepath.Join(d.e.Dir, "good-"+Digest(newConfig)+".json")); err != nil || Digest(good) != Digest(newConfig) {
		t.Fatalf("the last known good is lost or damaged: %v", err)
	}

	// The next start: the request is gone from the manifest, so nothing makes a
	// new copy; what was left is deleted at once.
	plane.setManifest(d.m)
	restart := killing
	restart.Mode, restart.Stop = "restart", ""
	snapshots := startKillChild(t, restart).finish(t)
	if !snapshotAt(t, snapshots, "locked").Locked {
		t.Fatal("the restarted agent couldn't take the lock")
	}
	if recovered := snapshotAt(t, snapshots, "recovered"); recovered.Error != "" {
		t.Fatalf("recovery failed: %s", recovered.Error)
	}
	entries, err = os.ReadDir(staging)
	if err != nil || len(entries) != 0 {
		t.Fatalf("the restart left %v in the staging directory: %v", entries, err)
	}
	if managed, err := os.ReadFile(d.managed); err != nil || Digest(managed) != Digest(newConfig) {
		t.Fatalf("the managed file is %q after the restart: %v", managed, err)
	}
}
