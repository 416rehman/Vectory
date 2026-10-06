package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// hostileSinkPipeline is a pipeline whose only sink is named by a path outside
// dataDir and keeps its buffer on disk: the one place Vector turns a component
// ID into a directory.
func hostileSinkPipeline(dataDir, sinkID string) map[string]any {
	return map[string]any{
		"data_dir": dataDir,
		"sources":  map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json", "interval": 0.2}},
		"sinks": map[string]any{sinkID: map[string]any{
			"type": "blackhole", "inputs": []string{"in"}, "print_interval_secs": 0,
			"buffer": map[string]any{"type": "disk", "max_size": 268435488},
		}},
	}
}

// A version whose component ID is a path never reaches Vector: the agent
// refuses it before it stages or writes anything, in either mode, keeps what
// runs, and reports a reason the server accepts.
func TestAComponentIDThatIsAPathIsRefusedBeforeAnythingIsStaged(t *testing.T) {
	for _, full := range []bool{false, true} {
		name := map[bool]string{false: "restricted", true: "full"}[full]
		t.Run(name, func(t *testing.T) {
			outside := filepath.Join(t.TempDir(), "outside", "snk")
			data, _ := json.Marshal(hostileSinkPipeline(filepath.Join(t.TempDir(), "data"), outside))
			e, m, d := fixture(t, data)
			e.Settings.CapabilityPolicy.FullVectorConfig = full
			if err := e.Reconcile(context.Background(), m); err == nil {
				t.Fatal("a component ID that is a path was accepted")
			}
			requireAttempt(t, e, m, "failed", "CAPABILITY_DENIED")
			if d.starts != 0 || e.actual() != Digest(oldConfig) || e.State.LastGoodSHA256 != Digest(oldConfig) {
				t.Fatalf("what runs changed: starts %d", d.starts)
			}
			issue := e.State.ConfigurationAttempt.Error
			wantMessage := map[bool]string{false: "This host's restricted-mode policy doesn't allow this pipeline", true: "This host's local policy doesn't allow this pipeline"}[full]
			if issue.Message != wantMessage {
				t.Errorf("message %q", issue.Message)
			}
			if len(issue.Diagnostics) != 1 || issue.Diagnostics[0].Code != "INVALID_COMPONENT_ID" || !strings.HasPrefix(issue.Diagnostics[0].Message, `Sink "`) {
				t.Fatalf("diagnostics: %+v", issue.Diagnostics)
			}
			if err := serverAcceptsDiagnostic(issue.Diagnostics[0]); err != nil {
				t.Errorf("the server would refuse this diagnostic: %v", err)
			}
			if _, err := os.Stat(filepath.Dir(outside)); !os.IsNotExist(err) {
				t.Fatal("the directory outside the data directory exists")
			}
			// The refused version is held back like any other the host refuses.
			if e.State.FailedGeneration == nil || *e.State.FailedGeneration != m.Generation {
				t.Error("the refused version is not held back")
			}
		})
	}
}

// A restricted device that already runs a version with an api block (one
// accepted before restricted mode refused the block) keeps that process until
// the next apply. Starting the configuration again, after Vector or the agent
// restarted, is a new start the policy judges: restricted mode refuses it and
// says why, for the managed file and for the last working copy alike, and a
// full-mode device starts it as before.
func TestRestartingAConfigurationWithAnAPIBlockIsRefusedInRestrictedModeOnly(t *testing.T) {
	withAPI := []byte(`{"api":{"enabled":true,"address":"127.0.0.1:8686"},"sources":{"synthetic":{"type":"demo_logs","format":"json"}},"sinks":{"discard":{"type":"blackhole","inputs":["synthetic"]}}}`)
	for _, tc := range []struct {
		name          string
		full, drifted bool
	}{
		{"restricted, the managed file", false, false},
		{"restricted, the last working copy", false, true},
		{"full, the managed file", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, _, d := fixture(t, newConfig)
			e.Settings.CapabilityPolicy.FullVectorConfig = tc.full
			if err := AtomicWrite(filepath.Join(e.Dir, "good-"+Digest(withAPI)+".json"), withAPI); err != nil {
				t.Fatal(err)
			}
			e.State.LastGoodSHA256 = Digest(withAPI)
			managed := withAPI
			if tc.drifted {
				managed = oldConfig // the managed file drifted: the last working copy is restored first
			}
			if err := AtomicWrite(e.Settings.ManagedConfig, managed); err != nil {
				t.Fatal(err)
			}
			d.alive = false // Vector or the agent restarted
			err := e.StartExisting(context.Background())
			if tc.full {
				if err != nil || d.starts != 1 || !d.alive {
					t.Fatalf("a full-mode device did not start its configuration: %v starts %d", err, d.starts)
				}
				return
			}
			if err == nil || d.starts != 0 || d.alive {
				t.Fatalf("a restricted device started a configuration with an api block: %v starts %d", err, d.starts)
			}
			issue := e.State.Error
			if issue == nil || issue.Code != "CAPABILITY_DENIED" || issue.Stage != "startup" || len(issue.Diagnostics) != 1 || issue.Diagnostics[0].Code != "LOCAL_API_DENIED" {
				t.Fatalf("issue: %+v", issue)
			}
			if err := serverAcceptsDiagnostic(issue.Diagnostics[0]); err != nil {
				t.Errorf("the server would refuse this diagnostic: %v", err)
			}
		})
	}
}

// With the pinned Vector: given a sink whose ID is a path, Vector does create
// the directory outside its data directory (the premise), and the agent never
// lets it get that far, in restricted and in full mode. The same pipeline with
// an ordinary ID applies and keeps its state under the data directory.
//
// Where Vector runs on Windows, the premise and the ordinary version are not
// measured: how it joins an ID that has a drive prefix onto its data directory
// has not been observed there. The refusal itself, which never starts Vector,
// runs on every platform, so nothing here is skipped.
func TestNativeAComponentIDThatIsAPathNeverCreatesStateOutsideTheDataDirectory(t *testing.T) {
	if os.Getenv("VECTOR_TEST_BINARY") == "" {
		t.Skip("set VECTOR_TEST_BINARY for native Vector runtime tests")
	}
	ctx := context.Background()
	measured := runtime.GOOS != "windows"

	// The premise, with no policy in the way: Vector joins the ID onto data_dir,
	// an absolute path replaces it, and its buffer files appear there.
	if measured {
		t.Run("without the policy Vector writes outside its data directory", func(t *testing.T) {
			e, driver := nativeRuntimeFixture(t)
			dataDir, outside := privateTempDir(t), filepath.Join(privateTempDir(t), "outside", "snk")
			writeManaged(t, e.Settings.ManagedConfig, hostileSinkPipeline(dataDir, outside))
			if err := driver.Activate(ctx, e.Settings.ManagedConfig); err != nil {
				t.Fatalf("activation: %v", err)
			}
			deadline := time.Now().Add(30 * time.Second)
			for {
				if entries, err := os.ReadDir(outside); err == nil && len(entries) > 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("this Vector no longer creates files at a component ID that is a path: the rule in policy.go needs another look")
				}
				time.Sleep(100 * time.Millisecond)
			}
			_ = driver.Stop()
		})
	}

	for _, full := range []bool{false, true} {
		name := map[bool]string{false: "restricted", true: "full"}[full]
		t.Run(name, func(t *testing.T) {
			e, driver := nativeRuntimeFixture(t)
			dataDir := privateTempDir(t)
			outside := filepath.Join(privateTempDir(t), "outside", "snk")
			policy := CapabilityPolicy{FullVectorConfig: full}
			if !full {
				policy.AllowedFileRoots = []string{dataDir}
			}
			e.Settings.CapabilityPolicy, driver.Settings.CapabilityPolicy = policy, policy

			artifacts := map[string][]byte{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for digest, data := range artifacts {
					if r.URL.Path == "/agent/v1/artifacts/"+digest {
						_, _ = w.Write(data)
						return
					}
				}
				http.NotFound(w, r)
			}))
			defer server.Close()
			e.Client = &Client{HTTP: server.Client(), Base: server.URL}
			offer := func(generation uint64, config map[string]any) Manifest {
				data, _ := json.Marshal(config)
				artifacts[Digest(data)] = data
				m := sampleManifest()
				m.Generation = generation
				m.Desired = &Desired{VersionID: "v" + string(rune('0'+generation)), SHA256: Digest(data), Size: int64(len(data)), ArtifactPath: "/agent/v1/artifacts/" + Digest(data), VectorVersion: VectorVersion}
				return m
			}

			hostile := offer(2, hostileSinkPipeline(dataDir, outside))
			e.State = State{Accepted: true, HighestGeneration: hostile.Generation, HighestPolicyGeneration: hostile.PolicyGeneration, DesiredIdentity: Identity(hostile.Desired), PolicyIdentity: Identity(hostile.Policy), Desired: hostile.Desired, Policy: hostile.Policy, ApplyState: "unmanaged"}
			if err := e.save(); err != nil {
				t.Fatal(err)
			}
			if err := e.Reconcile(ctx, hostile); err == nil {
				t.Fatal("a component ID that is a path was applied")
			}
			requireAttempt(t, e, hostile, "failed", "CAPABILITY_DENIED")
			if driver.Alive() {
				t.Fatal("Vector was started for a version the agent refused")
			}
			if _, err := os.Stat(e.Settings.ManagedConfig); !os.IsNotExist(err) {
				t.Fatal("the refused version reached the managed path")
			}
			if _, err := os.Stat(filepath.Dir(outside)); !os.IsNotExist(err) {
				t.Fatal("the directory outside the data directory exists")
			}

			// The same pipeline with an ordinary ID applies, and its buffer lives
			// under the data directory.
			if !measured {
				return
			}
			ordinary := offer(3, hostileSinkPipeline(dataDir, "snk"))
			e.State.HighestGeneration, e.State.Desired, e.State.DesiredIdentity = ordinary.Generation, ordinary.Desired, Identity(ordinary.Desired)
			if err := e.Reconcile(ctx, ordinary); err != nil {
				t.Fatalf("the ordinary version was refused: %v %+v", err, e.State.Error)
			}
			if !driver.Alive() || e.State.ApplyState != "verified_applied" {
				t.Fatalf("not applied: %s", e.State.ApplyState)
			}
			if entries, err := os.ReadDir(filepath.Join(dataDir, "buffer", "v2", "snk")); err != nil || len(entries) == 0 {
				t.Fatalf("no buffer under the data directory: %v", err)
			}
			if _, err := os.Stat(filepath.Dir(outside)); !os.IsNotExist(err) {
				t.Fatal("the directory outside the data directory exists after the ordinary version")
			}
		})
	}
}
