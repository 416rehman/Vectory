package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The run loop sends the result of a check a second after it is made, not at
// the next interval (a minute here), so the person waiting sees it in seconds.
// The whole path is the real one: mutual TLS, the signed manifest, the download
// of the candidate over the same client, Vector's own validation (here the
// stand-in script setup adopted) and the loop's schedule.
func TestTheResultOfACheckGoesOutAtOnceNotAtTheNextInterval(t *testing.T) {
	server, dir, base := enrolledForWake(t, []string{featureValidation}, nil)
	server.carry(ValidationRequest{ID: checkID, SHA256: Digest(newConfig), Size: int64(len(newConfig)), ArtifactPath: "/agent/v1/artifacts/" + Digest(newConfig), ExpiresAt: time.Now().UTC().Add(10 * time.Minute).Truncate(time.Second)}, newConfig)
	running(t, dir, runOptions{noWake: true}, nil)

	answered := func() int {
		for i, beat := range server.sent() {
			if beat["validation_result"] != nil {
				return i
			}
		}
		return -1
	}
	eventually(t, 20*time.Second, func() bool { return answered() >= 0 })
	at := answered()
	if at <= int(base) {
		t.Fatalf("the result came in heartbeat %d, before the loop's own", at)
	}
	res := server.sent()[at]["validation_result"].(map[string]any)
	if res["id"] != checkID || res["valid"] != true {
		t.Fatalf("result %v", res)
	}
	times := server.beatsAt()
	if gap := times[at].Sub(times[at-1]); gap > 5*time.Second {
		t.Fatalf("the result waited %v after the request arrived; the interval is a minute", gap)
	}
	if beat := server.sent()[at]; beat["agent_features"] == nil || beat["readiness"] == nil {
		t.Fatalf("the heartbeat that carries the result lacks the announcements: %v", beat)
	}
	if left, err := os.ReadDir(filepath.Join(dir, validationStagingName)); err != nil || len(left) != 0 {
		t.Fatalf("the staging directory holds %v: %v", left, err)
	}
}
