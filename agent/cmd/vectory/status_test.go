package main

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vectory/vectory/agent/internal/agent"
)

// statusDir is an enrolled installation whose agent runs (the lock is held as
// `vectory run` holds it) and checked in 20 s ago, with the version the
// manifest named (or not) and the features the server listed.
func statusDir(t *testing.T, features []string, configurationName string, versionNumber uint64) string {
	t.Helper()
	dir := installedDir(t, agent.CapabilityPolicy{})
	if err := agent.WriteJSON(filepath.Join(dir, "identity.json"), agent.IdentityBundle{Credentials: agent.Credentials{DeviceID: "5e7a9c2d-0000-4000-8000-000000000001", CertificateExpiresAt: time.Now().Add(30 * 24 * time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	settings, err := agent.LoadSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	settings.Name, settings.Server = "edge-nyc-02", "https://vectory.example.com:8443"
	if err = agent.WriteJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	last := time.Now().Add(-20 * time.Second)
	sha := agent.Digest([]byte("candidate"))
	desired := &agent.Desired{VersionID: "3f2a9c1d-5b7e-4a10-9c2d-0e8f6a7b1c3d", SHA256: sha, Size: 1200, ArtifactPath: "/agent/v1/artifacts/" + sha, VectorVersion: agent.VectorVersion}
	applied := &agent.AppliedVersion{VersionID: desired.VersionID, Generation: 12}
	if configurationName != "" {
		// The signed manifest is where the names come from: read them as an agent does.
		raw, err := json.Marshal(map[string]any{"version_id": desired.VersionID, "sha256": sha, "size": 1200, "artifact_path": desired.ArtifactPath, "vector_version": agent.VectorVersion, "version_number": versionNumber, "configuration_name": configurationName})
		if err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(raw, desired); err != nil {
			t.Fatal(err)
		}
		applied.ConfigurationName, applied.VersionNumber = desired.ConfigurationName, desired.VersionNumber
	}
	state := agent.State{ApplyState: "verified_applied", Accepted: true, LastHeartbeat: &last, Policy: agent.Policy{HeartbeatSeconds: 60, TelemetryEnabled: true},
		Desired: desired, HighestGeneration: 12, ReportedGeneration: 12, ServerFeatures: features, Applied: applied}
	if err = agent.SaveState(dir, state); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(holdAsRun(t, dir))
	return dir
}

var dueIn = regexp.MustCompile(`Check-in   next due in (\d+) s \(every minute\)\n`)

// `vectory status` names the pipeline and version the signed manifest gave,
// says when the next check-in is due and whether wake-ups are on, and against a
// server that names nothing prints the lines it always did.
func TestStatusNamesWhatRunsAndWhenTheNextCheckInIsDue(t *testing.T) {
	t.Run("a server that names versions and offers wake-ups", func(t *testing.T) {
		dir := statusDir(t, []string{"wake", "validation"}, "Edge syslog processing", 3)
		code, stdout, stderr := invoke("status", "--state-dir", dir)
		if code != 0 || stderr != "" {
			t.Fatal(code, stderr)
		}
		for _, want := range []string{
			"Pipeline   Edge syslog processing · version 3 (3f2a9c1d, generation 12) · applied and verified\n",
			"Wake-ups   on · a new version or setting reaches this device within seconds\n",
		} {
			if !strings.Contains(stdout, want) {
				t.Fatalf("status lacks %q:\n%s", want, stdout)
			}
		}
		m := dueIn.FindStringSubmatch(stdout)
		if m == nil {
			t.Fatalf("the schedule row is missing:\n%s", stdout)
		}
		if seconds, err := strconv.Atoi(m[1]); err != nil || seconds < 30 || seconds > 41 {
			t.Fatalf("the schedule row is wrong (a minute interval, 20 s ago):\n%s", stdout)
		}
	})
	t.Run("an older server", func(t *testing.T) {
		dir := statusDir(t, nil, "", 0)
		code, stdout, stderr := invoke("status", "--state-dir", dir)
		if code != 0 || stderr != "" {
			t.Fatal(code, stderr)
		}
		if !strings.Contains(stdout, "Pipeline   Version 3f2a9c1d (generation 12) · applied and verified\n") || strings.Contains(stdout, "Wake-ups") || strings.Contains(stdout, "Running") {
			t.Fatalf("an older server's status:\n%s", stdout)
		}
		if !dueIn.MatchString(stdout) {
			t.Fatalf("the schedule row is missing:\n%s", stdout)
		}
	})
	t.Run("--json", func(t *testing.T) {
		dir := statusDir(t, []string{"wake"}, "Edge syslog processing", 3)
		code, stdout, stderr := invoke("status", "--state-dir", dir, "--json")
		if code != 0 || stderr != "" {
			t.Fatal(code, stderr)
		}
		var document map[string]any
		if err := json.Unmarshal([]byte(stdout), &document); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"state", "actual_sha256", "drift", "device", "next_step", "check_in", "wake_ups", "running_pipeline"} {
			if _, ok := document[key]; !ok {
				t.Fatalf("the JSON lacks %q: %s", key, stdout)
			}
		}
		pipeline := document["running_pipeline"].(map[string]any)
		checkIn := document["check_in"].(map[string]any)
		if pipeline["name"] != "Edge syslog processing" || pipeline["version_number"] != float64(3) || checkIn["interval_seconds"] != float64(60) || document["wake_ups"].(map[string]any)["listening"] != true {
			t.Fatalf("the JSON additions: %v", document)
		}
		due, ok := checkIn["due_in_seconds"].(float64)
		if !ok || due < 30 || due > 41 {
			t.Fatalf("due_in_seconds %v", checkIn)
		}
	})
}
