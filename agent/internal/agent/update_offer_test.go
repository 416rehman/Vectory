package agent

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The agent's side of an offer of an agent build, against a control plane that
// signs manifests and serves a release's build, and a host whose policy and
// privileged step the test writes. Every test is about what the agent did to this
// host and what it told the server.

func TestAnOfferIsVerifiedDownloadedAndStaged(t *testing.T) {
	rig := newOfferRig(t)

	// The check-in that brings the offer starts the transfer in the background.
	rig.poll()
	if rig.e.update.download == nil || rig.e.update.decision.state != UpdateStateDownloading {
		t.Fatalf("no transfer began: %+v", rig.e.update.decision)
	}
	if beat := rig.beat(); beat["state"] != "idle" {
		t.Fatalf("the check-in that carried the offer reported %v before the agent had decided anything", beat)
	}
	// The next check-in reports it, and takes the finished build in.
	<-rig.e.update.download.done
	rig.poll()
	if beat := rig.beat(); beat["state"] != "downloading" || beat["release"] != rig.releaseSHA {
		t.Fatalf("the check-in after it reported %v", beat)
	}
	if rig.e.update.download != nil || rig.e.update.decision.state != UpdateStateStaged {
		t.Fatalf("the finished build wasn't taken in: %+v", rig.e.update.decision)
	}
	rig.poll()
	beat := rig.beat()
	if beat["state"] != "staged" || beat["release"] != rig.releaseSHA || beat["eligibility"] != "eligible" || beat["consent"] != "auto" {
		t.Fatalf("a staged build is reported as %v", beat)
	}

	// What the step finds: the build under its name, the signed files exactly as
	// they came, and the request last.
	for name, want := range map[string][]byte{
		UpdateBuildFile(runtime.GOOS): rig.build,
		UpdateReleaseFile:             rig.manifest,
		UpdateSignaturesFile:          rig.signatures,
		UpdateRolloversFile:           []byte(`{"schema":"vectory.update-rollovers.v1","rollovers":[]}` + "\n"),
	} {
		got, err := os.ReadFile(rig.stagedFile(name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s isn't what was offered", name)
		}
	}
	if _, err := os.Lstat(rig.stagedFile(UpdateBuildPartFile)); !os.IsNotExist(err) {
		t.Fatalf("a partial build was left behind: %v", err)
	}
	request, err := ReadUpdateRequest(rig.exchange().Request)
	if err != nil {
		t.Fatal(err)
	}
	if request.ManifestSHA256 != rig.releaseSHA || request.ArtifactSHA256 != rig.buildSHA || request.RolloutID != defaultRollout || time.Since(request.OfferedAt) > time.Minute {
		t.Fatalf("the request is %+v", request)
	}
	// Nothing was asked for twice, and the log said what happened once.
	if rig.requests() != 1 {
		t.Fatalf("the build was asked for %d times", rig.requests())
	}
	if !rig.said1("Downloading agent update 0.1.1") || !rig.said1("Agent update 0.1.1 ("+byteSize(int64(len(rig.build)))+") is staged. The update step applies it within a minute.") {
		t.Fatalf("the log said %q", rig.said)
	}
	// It is the service account's own: private files, in private directories.
	if runtime.GOOS != "windows" {
		for path, mode := range map[string]os.FileMode{
			rig.exchange().Dir: 0o700, rig.exchange().Incoming: 0o700, filepath.Join(rig.exchange().Incoming, rig.releaseSHA): 0o700,
			rig.stagedFile(UpdateBuildFile(runtime.GOOS)): 0o600, rig.stagedFile(UpdateReleaseFile): 0o600, rig.exchange().Request: 0o600,
		} {
			if info, err := os.Lstat(path); err != nil || info.Mode().Perm() != mode {
				t.Errorf("%s: %v %v, want %04o", path, info, err, mode)
			}
		}
	}
}

// Staging is quiet from then on: another check-in changes nothing and asks for
// nothing, and a process that starts later takes the staged build as it finds it.
func TestAStagedBuildIsLeftAloneAndFoundAgainAfterARestart(t *testing.T) {
	rig := newOfferRig(t)
	rig.settle()
	rig.poll()
	before, err := os.ReadFile(rig.exchange().Request)
	if err != nil {
		t.Fatal(err)
	}
	rig.poll()
	rig.poll()
	after, _ := os.ReadFile(rig.exchange().Request)
	if !bytes.Equal(before, after) || rig.requests() != 1 {
		t.Fatalf("a quiet check-in changed something: %d requests", rig.requests())
	}

	// A new process: nothing in memory, the build on disk.
	rig.e.update = updateRun{}
	rig.poll()
	rig.poll()
	if rig.requests() != 1 || rig.e.update.download != nil {
		t.Fatalf("the staged build was fetched again: %d requests", rig.requests())
	}
	if beat := rig.beat(); beat["state"] != "staged" {
		t.Fatalf("after a restart the host says %v", beat)
	}
}

// A build someone changed on disk after it was staged is not the signed one: the
// agent finds out, deletes it and fetches it again.
func TestAStagedBuildThatIsNotTheSignedOneIsFetchedAgain(t *testing.T) {
	rig := newOfferRig(t)
	rig.settle()
	rig.poll()
	path := rig.stagedFile(UpdateBuildFile(runtime.GOOS))
	tampered := bytes.Clone(rig.build)
	tampered[10] ^= 0xff
	if err := os.WriteFile(path, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	rig.e.update = updateRun{} // a process that never checked it
	rig.settle()
	rig.poll()
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, rig.build) || rig.requests() != 2 {
		t.Fatalf("the build on disk is the signed one: %v, asked for %d times, %v", bytes.Equal(got, rig.build), rig.requests(), err)
	}
}

func TestAnAskHostStagesAndWaitsForTheHost(t *testing.T) {
	rig := newOfferRig(t)
	rig.consent(UpdateConsentAsk)
	rig.settle()
	rig.poll()
	if beat := rig.beat(); beat["state"] != "waiting_for_host" || beat["release"] != rig.releaseSHA || beat["consent"] != "ask" {
		t.Fatalf("an ask host reports %v", beat)
	}
	// It staged the build and wrote the request: applying is for the host to ask.
	if _, err := ReadUpdateRequest(rig.exchange().Request); err != nil {
		t.Fatal(err)
	}
	if !rig.said1("is staged, and waits for you: sudo vectory update apply --state-dir") {
		t.Fatalf("the log said %q", rig.said)
	}
}

func TestAnAutomaticHostOutsideItsWindowStagesAndSaysSo(t *testing.T) {
	withLocalZone(t, time.UTC)
	rig := newOfferRig(t)
	// A window that is closed whatever the time of day: a minute, in the hour that
	// isn't now.
	now := time.Now().UTC()
	other := (now.Hour() + 12) % 24
	rig.consent(UpdateConsentAuto, "daily "+twoDigits(other)+":10-"+twoDigits(other)+":20 UTC")
	rig.settle()
	rig.poll()
	beat := rig.beat()
	if beat["state"] != "waiting_for_window" || beat["window_open"] != false || beat["next_window_at"] == nil {
		t.Fatalf("a host outside its window reports %v", beat)
	}
	if _, err := ReadUpdateRequest(rig.exchange().Request); err != nil {
		t.Fatalf("a window gates the start of an apply, not the staging: %v", err)
	}
	if !rig.said1("is staged, and waits for the update window.") {
		t.Fatalf("the log said %q", rig.said)
	}
}

func twoDigits(n int) string {
	return string([]byte{byte('0' + n/10), byte('0' + n%10)})
}

// ---------------------------------------------------------------- health.json

func TestHealthIsWrittenAfterEachCheckInOfAHostThatConsented(t *testing.T) {
	rig := newOfferRig(t)
	if _, err := os.Lstat(rig.exchange().Health); !os.IsNotExist(err) {
		t.Fatalf("health.json before any check-in: %v", err)
	}
	rig.poll()
	health, err := ReadUpdateHealth(rig.exchange().Health)
	if err != nil {
		t.Fatal(err)
	}
	if health.AgentSHA256 != rig.e.State.Agent.SHA256 || health.AgentVersion != Version || health.BootID != rig.e.BootID || health.Vector != UpdateVectorRunning {
		t.Fatalf("health.json is %+v", health)
	}
	if health.Offer != rig.releaseSHA {
		t.Fatalf("health.json names the offer %q, the manifest offered %q", health.Offer, rig.releaseSHA)
	}
	if time.Since(health.CheckedInAt) > time.Minute || health.CheckedInAt.Nanosecond()%1_000_000 != 0 {
		t.Fatalf("checked in at %s", health.CheckedInAt)
	}
	first := health.CheckedInAt

	// A manifest that offers nothing says so, and a stopped Vector says that.
	rig.withdraw()
	rig.e.Driver.(*candidateDriver).fakeDriver.alive = false
	time.Sleep(5 * time.Millisecond)
	rig.poll()
	health, err = ReadUpdateHealth(rig.exchange().Health)
	if err != nil {
		t.Fatal(err)
	}
	if health.Offer != "" || health.Vector != UpdateVectorStopped || !health.CheckedInAt.After(first) {
		t.Fatalf("health.json is %+v after a check-in with no offer and Vector stopped", health)
	}
	// A host with no workload says none.
	rig.e.Settings.Adopted = false
	_ = rig.e.Poll(t.Context()) // an agent that adopted nothing can't reconcile, and still checks in
	if health, _ = ReadUpdateHealth(rig.exchange().Health); health.Vector != UpdateVectorNone {
		t.Fatalf("vector is %q for a host that supervises nothing", health.Vector)
	}
}

// The check-in has to have been answered by a manifest this agent verified: one it
// refuses writes nothing.
func TestHealthIsNotWrittenForACheckInThatWasNotAnswered(t *testing.T) {
	rig := newOfferRig(t)
	rig.plane.mu.Lock()
	rig.plane.answer = func(map[string]any) int { return 503 }
	rig.plane.mu.Unlock()
	if err := rig.e.Poll(t.Context()); err == nil {
		t.Fatal("a refused check-in succeeded")
	}
	if _, err := os.Lstat(rig.exchange().Health); !os.IsNotExist(err) {
		t.Fatalf("health.json for a check-in nobody answered: %v", err)
	}
}

// ---------------------------------------------------------------- off writes nothing

// A host whose consent is off, or whose policy this agent may not trust, reports
// that and does nothing else: no download, no file, not even a directory.
func TestAHostThatIsOffMakesNothingAnywhere(t *testing.T) {
	for name, setup := range map[string]func(*offerRig){
		"consent off with its key kept": func(r *offerRig) { r.consent(UpdateConsentOff) },
		"no policy at all":              func(r *offerRig) { _ = os.RemoveAll(r.paths.PolicyDir) },
		"a policy in a directory others can write": func(r *offerRig) {
			if runtime.GOOS == "windows" {
				t.Skip("the Windows rule is tested by the path check")
			}
			if err := os.Chmod(r.paths.PolicyDir, 0o777); err != nil {
				t.Fatal(err)
			}
			// A host whose step has never run: nothing but this agent can say what is
			// wrong with the place of the policy.
			if err := os.Remove(r.paths.Status); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			rig := newOfferRig(t)
			setup(rig)
			for i := 0; i < 3; i++ {
				rig.poll()
			}
			if rig.requests() != 0 {
				t.Fatalf("a host that is off asked for the build %d times", rig.requests())
			}
			rig.nothingUnderUpdates()
			beat := rig.beat()
			if beat["consent"] != "off" || beat["state"] != "idle" || beat["code"] != "UPDATES_OFF" || beat["release"] != nil {
				t.Fatalf("a host that is off reports %v", beat)
			}
			if name == "a policy in a directory others can write" && beat["eligibility"] != "UNTRUSTED_LOCATION" {
				t.Fatalf("an untrusted policy is reported as %v", beat["eligibility"])
			}
			if len(rig.said) != 0 {
				t.Fatalf("the log said %q", rig.said)
			}
			// Nothing in the state directory but what the agent keeps anyway.
			entries, _ := os.ReadDir(rig.state)
			for _, entry := range entries {
				if strings.Contains(entry.Name(), "update") || strings.Contains(entry.Name(), "incoming") {
					t.Fatalf("the agent made %s", entry.Name())
				}
			}
		})
	}
}

// Consent withdrawn mid-transfer ends it, and what it had written goes with it.
func TestConsentWithdrawnDuringATransferEndsTheTransfer(t *testing.T) {
	rig := newOfferRig(t)
	started := make(chan struct{})
	rig.answerWith(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)))
		_, _ = w.Write(rig.build[:1000])
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	})
	rig.poll()
	<-started
	rig.consent(UpdateConsentOff)
	rig.poll()
	if rig.e.update.download != nil {
		t.Fatal("the transfer wasn't stopped")
	}
	if _, err := os.Lstat(rig.stagedFile(UpdateBuildPartFile)); !os.IsNotExist(err) {
		t.Fatalf("the partial build stayed: %v", err)
	}
	if _, err := os.Lstat(rig.exchange().Request); !os.IsNotExist(err) {
		t.Fatalf("a request was written for a host that turned updates off: %v", err)
	}
}
