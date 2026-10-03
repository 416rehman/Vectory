package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// What `vectory status` prints is checked against golden files, for a device
// whose server is older and names nothing, and for one whose signed manifests
// name the pipeline and its version: testdata/status/<name>.golden. Setting
// VECTORY_UPDATE_GOLDEN rewrites them from what the code says now; the diff is
// then reviewed like any other change.
func assertStatusGolden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "status", name+".golden")
	if os.Getenv("VECTORY_UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if text := strings.ReplaceAll(string(want), "\r\n", "\n"); text != got {
		t.Fatalf("%s differs from its golden file.\n--- got\n%s--- want\n%s", name, got, text)
	}
}

var statusNow = time.Date(2026, 10, 2, 14, 30, 0, 0, time.UTC)

// statusView is a device that checked in 12 s ago, runs its version under
// systemd, and has a server that lists the wake feature, changed by change.
func statusView(change func(*StatusView)) *StatusView {
	last := statusNow.Add(-12 * time.Second)
	sha := Digest([]byte("candidate"))
	desired := &Desired{VersionID: "3f2a9c1d-5b7e-4a10-9c2d-0e8f6a7b1c3d", SHA256: sha, Size: 1200, ArtifactPath: "/agent/v1/artifacts/" + sha, VectorVersion: VectorVersion}
	v := &StatusView{
		StateDir: DefaultPaths().StateDir, DeviceID: "5e7a9c2d-0000-4000-8000-000000000001", BinaryOK: true, ReadAt: statusNow,
		Settings: Settings{Name: "edge-nyc-02", Server: "https://vectory.example.com:8443", VectorBinary: "/usr/bin/vector", VectorVersion: "0.58.0"},
		Service:  ServiceInfo{Manager: "systemd", Name: "vectory.service", Installed: true, State: "running", PID: 812},
		State: State{LastHeartbeat: &last, Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}, Accepted: true, Desired: desired, HighestGeneration: 12, ReportedGeneration: 12,
			ApplyState: "verified_applied", ServerFeatures: []string{featureWake}, Applied: &AppliedVersion{VersionID: desired.VersionID, Generation: 12}},
	}
	if change != nil {
		change(v)
	}
	v.Next = v.nextStep(statusNow)
	return v
}

// named makes the signed manifest name the version, as a server that does.
func named(v *StatusView, name string, number displayNumber) {
	v.State.Desired.ConfigurationName, v.State.Desired.VersionNumber = displayName(name), number
	if v.State.Applied != nil && v.State.Applied.VersionID == v.State.Desired.VersionID {
		v.State.Applied.ConfigurationName, v.State.Applied.VersionNumber = displayName(name), number
	}
}

func TestStatusGoldenFiles(t *testing.T) {
	previous := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = previous })
	cases := []struct {
		name   string
		change func(*StatusView)
	}{
		{"older-server-applied", func(v *StatusView) { v.State.ServerFeatures = nil }},
		{"older-server-without-wake-applied", func(v *StatusView) { v.State.ServerFeatures = []string{featureHostRuntime, featureDiagnostics} }},
		{"named-applied", func(v *StatusView) { named(v, "Edge syslog processing", 3) }},
		{"named-rolled-back", func(v *StatusView) {
			named(v, "Edge syslog processing", 3)
			v.State.Applied = &AppliedVersion{VersionID: "a1b2c3d4-0000-4000-8000-000000000003", Generation: 11, ConfigurationName: "Edge syslog processing", VersionNumber: 3}
			v.State.Desired.VersionNumber = 4
			v.State.ApplyState = "rolled_back"
			v.State.Error = &Issue{Code: "APPLY_ROLLED_BACK", Stage: "rollback", Message: "Vector didn't confirm it runs this version; last verified configuration restored"}
		}},
		{"named-unassigned", func(v *StatusView) {
			named(v, "Edge syslog processing", 3)
			v.State.Desired, v.State.ApplyState = nil, "unmanaged"
			v.State.LastGoodSHA256, v.ActualSHA = "feedface", "feedface"
		}},
		{"named-with-local-edits", func(v *StatusView) {
			named(v, "Edge syslog processing", 3)
			v.Drift = true
			v.State.LastGoodSHA256 = "feedface"
		}},
		{"named-only-by-number", func(v *StatusView) { v.State.Desired.VersionNumber = 3 }},
		{"check-in-overdue", func(v *StatusView) {
			named(v, "Edge syslog processing", 3)
			last := statusNow.Add(-95 * time.Second)
			v.State.LastHeartbeat = &last
		}},
		{"check-in-every-15-seconds", func(v *StatusView) {
			v.State.Policy.HeartbeatSeconds = 15
			last := statusNow.Add(-4 * time.Second)
			v.State.LastHeartbeat = &last
		}},
		{"check-in-due-now", func(v *StatusView) {
			last := statusNow.Add(-60 * time.Second)
			v.State.LastHeartbeat = &last
		}},
		{"wake-off-on-this-host", func(v *StatusView) { v.Settings.NoWake = true }},
		{"wake-off-for-this-run", func(v *StatusView) { v.State.Wake = wakeOffRun }},
		{"wake-requests-failing", func(v *StatusView) { v.State.Wake = wakeFailed }},
		{"wake-paused-while-check-ins-fail", func(v *StatusView) {
			last := statusNow.Add(-90 * time.Second)
			v.State.LastHeartbeat = &last
			v.State.CheckInFailure = &CheckInFailure{Since: statusNow.Add(-30 * time.Second), Message: "Can't reach the server (connection refused).", Code: "CONNECTION_REFUSED"}
		}},
		{"agent-stopped", func(v *StatusView) { v.Service.State, v.Service.PID = "dead", 0 }},
		{"no-check-in-yet", func(v *StatusView) { v.State.LastHeartbeat = nil }},
		{"not-enrolled", func(v *StatusView) { v.DeviceID, v.State = "", State{Policy: Policy{HeartbeatSeconds: 60}} }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			assertStatusGolden(t, c.name, RenderStatus(statusView(c.change), statusNow))
		})
	}
}

// The machine-readable form keeps every key it had and adds its own, each only
// when the agent has something true to say; the additions are checked against
// golden files too.
func TestStatusJSONIsAdditiveAndCompatible(t *testing.T) {
	previous := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = previous })
	established := []string{"state", "actual_sha256", "local_paused", "drift", "telemetry_available", "version", "configuration_mode", "diagnostics", "state_dir", "server", "service", "agent_running", "vector_binary", "vector_binary_ok", "next_step", "device"}
	additions := []string{"running_pipeline", "check_in", "wake_ups"}
	for name, change := range map[string]func(*StatusView){
		"json-older-server": func(v *StatusView) { v.State.ServerFeatures = nil },
		"json-named":        func(v *StatusView) { named(v, "Edge syslog processing", 3) },
		"json-overdue-and-wake-off": func(v *StatusView) {
			named(v, "Edge syslog processing", 3)
			last := statusNow.Add(-95 * time.Second)
			v.State.LastHeartbeat = &last
			v.Settings.NoWake = true
		},
	} {
		t.Run(name, func(t *testing.T) {
			document := StatusJSON(statusView(change))
			for _, key := range established {
				if _, ok := document[key]; !ok {
					t.Fatalf("the status JSON lost %q", key)
				}
			}
			added := map[string]any{}
			for _, key := range additions {
				if value, ok := document[key]; ok {
					added[key] = value
				}
			}
			encoded, err := json.MarshalIndent(added, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			assertStatusGolden(t, name, string(encoded)+"\n")
		})
	}
	// Only the added keys differ between an older server and one that names the
	// version; the state it carries is the same shape plus the display fields.
	older, newer := StatusJSON(statusView(func(v *StatusView) { v.State.ServerFeatures = nil })), StatusJSON(statusView(func(v *StatusView) { named(v, "Edge syslog processing", 3) }))
	if _, ok := older["running_pipeline"]; ok {
		t.Fatal("an older server's manifest produced a pipeline name")
	}
	if _, ok := newer["running_pipeline"]; !ok {
		t.Fatal("a named version isn't in the JSON")
	}
	if !reflect.DeepEqual(older["check_in"], newer["check_in"]) {
		t.Fatal("the schedule depends on whether the server names versions")
	}
}

// Whether the device waits for wake-ups, from what the agent knows itself.
func TestWakeUpStatus(t *testing.T) {
	cases := []struct {
		name   string
		change func(*StatusView)
		want   wakeStatus
		shown  bool
	}{
		{"listening", nil, wakeStatus{Listening: true}, true},
		{"the server doesn't offer it", func(v *StatusView) { v.State.ServerFeatures = nil }, wakeStatus{}, false},
		{"the host turned it off", func(v *StatusView) { v.Settings.NoWake = true }, wakeStatus{Reason: wakeReasonHost}, true},
		{"this run turned it off", func(v *StatusView) { v.State.Wake = wakeOffRun }, wakeStatus{Reason: wakeReasonRun}, true},
		{"a wait failed", func(v *StatusView) { v.State.Wake = wakeFailed }, wakeStatus{Reason: wakeReasonRequests}, true},
		{"check-ins fail", func(v *StatusView) {
			last := statusNow.Add(-90 * time.Second)
			v.State.LastHeartbeat = &last
			v.State.CheckInFailure = &CheckInFailure{Since: statusNow.Add(-30 * time.Second), Message: "down"}
		}, wakeStatus{Reason: wakeReasonCheckIns}, true},
		{"the agent isn't running", func(v *StatusView) { v.Service.State = "dead" }, wakeStatus{}, false},
		{"no check-in yet", func(v *StatusView) { v.State.LastHeartbeat = nil }, wakeStatus{}, false},
		{"not enrolled", func(v *StatusView) { v.DeviceID = "" }, wakeStatus{}, false},
		{"turned off on a server that doesn't offer it", func(v *StatusView) { v.Settings.NoWake, v.State.ServerFeatures = true, nil }, wakeStatus{}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, shown := statusView(c.change).wakeUps()
			if shown != c.shown || got != c.want {
				t.Fatalf("wakeUps = %+v shown %v, want %+v shown %v", got, shown, c.want, c.shown)
			}
		})
	}
}

// The next check-in is the last successful one plus the interval; past it, the
// status says by how much.
func TestCheckInSchedule(t *testing.T) {
	cases := []struct {
		name     string
		interval int
		ago      time.Duration
		want     string
	}{
		{"a minute interval, 12 s ago", 60, 12 * time.Second, "next due in 48 s (every minute)"},
		{"exactly due", 60, 60 * time.Second, "next due in a moment (every minute)"},
		{"just late", 60, 72 * time.Second, "overdue by 12 s (every minute)"},
		{"far overdue", 60, 25 * time.Minute, "overdue by 24 min (every minute)"},
		{"an hour overdue", 15, 3*time.Hour + 20*time.Minute, "overdue by 3 h (every 15 s)"},
		{"five minutes", 300, 2 * time.Minute, "next due in 3 min (every 5 min)"},
		{"an hour interval", 3600, time.Minute, "next due in 59 min (every hour)"},
		{"an interval the server can't set", 3, 12 * time.Second, "next due in 48 s (every minute)"},
		{"no interval yet", 0, 12 * time.Second, "next due in 48 s (every minute)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := statusView(func(v *StatusView) {
				last := statusNow.Add(-c.ago)
				v.State.LastHeartbeat, v.State.Policy.HeartbeatSeconds = &last, c.interval
			})
			if got, ok := v.checkInText(statusNow); !ok || got != c.want {
				t.Fatalf("%q, want %q", got, c.want)
			}
		})
	}
	// A clock set back never reads as a check-in from the future.
	v := statusView(func(v *StatusView) {
		last := statusNow.Add(30 * time.Second)
		v.State.LastHeartbeat = &last
	})
	if got, _ := v.checkInText(statusNow); !strings.HasPrefix(got, "next due in ") {
		t.Fatalf("%q", got)
	}
	if _, ok := statusView(func(v *StatusView) { v.State.LastHeartbeat = nil }).checkInText(statusNow); ok {
		t.Fatal("a device that hasn't checked in has a schedule")
	}
}

// Nothing the status prints can be a secret: it is built from names, numbers,
// times and fixed words, so a device whose state holds a secret's value or
// path anywhere else still doesn't print it.
func TestStatusNeverPrintsASecret(t *testing.T) {
	const value = "planted-secret-31c7a9"
	v := statusView(func(v *StatusView) {
		named(v, "Edge syslog processing", 3)
		v.Settings.SecretFiles = map[string]string{"API_TOKEN": "/etc/secrets/" + value}
		v.State.Error = nil
	})
	text := RenderStatus(v, statusNow)
	encoded, _ := json.Marshal(StatusJSON(v))
	for label, output := range map[string]string{"text": text, "json": string(encoded)} {
		if strings.Contains(output, value) {
			t.Fatalf("%s prints a secret:\n%s", label, output)
		}
	}
}

// A failed wait is written to the state by the loop, and a wait that answers
// clears it, so status can tell the two apart; the state isn't rewritten when
// nothing changed.
func TestTheLoopRecordsWhatItSawOfWaits(t *testing.T) {
	durable := func(e *Engine) string {
		t.Helper()
		st, err := LoadState(e.Dir)
		if err != nil {
			t.Fatal(err)
		}
		return st.Wake
	}
	failing, _ := wakeEngine(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unavailable", http.StatusInternalServerError)
	})
	(&workloadSupervisor{}).wait(context.Background(), failing, 400*time.Millisecond, quiet, true)
	if failing.State.Wake != wakeFailed || durable(failing) != wakeFailed {
		t.Fatalf("a failed wait left %q (durable %q)", failing.State.Wake, durable(failing))
	}
	answering, _ := wakeEngine(t, func(w http.ResponseWriter, _ *http.Request) { answer(w, `{"changed":true}`) })
	answering.State.Wake = wakeFailed
	(&workloadSupervisor{}).wait(context.Background(), answering, 5*time.Second, quiet, true)
	if answering.State.Wake != "" || durable(answering) != "" {
		t.Fatalf("an answered wait left %q (durable %q)", answering.State.Wake, durable(answering))
	}
	// The server holds a wait for much longer than a check-in interval can be, so
	// a healthy wait is usually still unanswered when its interval ends. One that
	// has been held past the spacing works, and ends an earlier failure; one that
	// was cut off sooner proves nothing.
	var requests atomic.Int32
	holding, _ := wakeEngine(t, func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			http.Error(w, "unavailable", http.StatusInternalServerError)
			return
		}
		<-r.Context().Done()
	})
	s := &workloadSupervisor{}
	s.wait(context.Background(), holding, 400*time.Millisecond, quiet, true)
	if holding.State.Wake != wakeFailed {
		t.Fatalf("a failed wait left %q", holding.State.Wake)
	}
	s.wait(context.Background(), holding, 400*time.Millisecond, quiet, true)
	if holding.State.Wake != wakeFailed || durable(holding) != wakeFailed {
		t.Fatalf("a wait cut off at once cleared the failure: %q (durable %q)", holding.State.Wake, durable(holding))
	}
	s.wait(context.Background(), holding, wakeSpacing+600*time.Millisecond, quiet, true)
	if requests.Load() != 3 || holding.State.Wake != "" || durable(holding) != "" {
		t.Fatalf("a wait held to the end of its interval left %q (durable %q) after %d requests", holding.State.Wake, durable(holding), requests.Load())
	}
	// An unchanged state isn't written again.
	e := &Engine{Dir: t.TempDir()}
	e.noteWake("")
	if _, err := os.Stat(filepath.Join(e.Dir, "state.json")); !os.IsNotExist(err) {
		t.Fatal("noting nothing new wrote the state")
	}
	e.noteWake(wakeOffRun)
	if durable(e) != wakeOffRun {
		t.Fatal("a new observation wasn't saved")
	}
}

// A running agent says what its waits did, and `vectory status` reads it: this
// run turned them off, or the server's answers to them are errors.
func TestStatusReadsWhatTheRunningAgentSawOfWaits(t *testing.T) {
	t.Run("a run with --no-wake", func(t *testing.T) {
		_, dir, _ := enrolledForWake(t, []string{featureWake}, nil)
		running(t, dir, runOptions{noWake: true}, nil)
		eventually(t, 5*time.Second, func() bool {
			state, err := LoadState(dir)
			return err == nil && state.Wake == wakeOffRun
		})
		view, err := ReadStatus(context.Background(), dir)
		if err != nil {
			t.Fatal(err)
		}
		if wake, ok := view.wakeUps(); !ok || wake.Listening || wake.Reason != wakeReasonRun {
			t.Fatalf("wakeUps = %+v %v\n%s", wake, ok, RenderStatus(view, time.Now()))
		}
		if text := RenderStatus(view, time.Now()); !strings.Contains(text, "Wake-ups   off · this run was started with --no-wake") || !strings.Contains(text, "Check-in   next due in ") {
			t.Fatalf("status:\n%s", text)
		}
	})
	t.Run("waits the server answers with errors", func(t *testing.T) {
		server, dir, _ := enrolledForWake(t, []string{featureWake}, nil)
		server.setWait(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "unavailable", http.StatusInternalServerError)
		})
		running(t, dir, runOptions{}, nil)
		eventually(t, 5*time.Second, func() bool {
			state, err := LoadState(dir)
			return err == nil && state.Wake == wakeFailed
		})
		view, err := ReadStatus(context.Background(), dir)
		if err != nil {
			t.Fatal(err)
		}
		if wake, ok := view.wakeUps(); !ok || wake.Listening || wake.Reason != wakeReasonRequests {
			t.Fatalf("wakeUps = %+v %v", wake, ok)
		}
	})
	t.Run("waits that are held", func(t *testing.T) {
		server, dir, base := enrolledForWake(t, []string{featureWake}, nil)
		held := make(chan struct{}, 1)
		server.setWait(func(w http.ResponseWriter, r *http.Request) {
			select {
			case held <- struct{}{}:
			default:
			}
			<-r.Context().Done()
		})
		running(t, dir, runOptions{}, nil)
		eventually(t, 5*time.Second, func() bool { return server.heartbeats.Load() == base+1 })
		select {
		case <-held:
		case <-time.After(5 * time.Second):
			t.Fatal("the agent never waited")
		}
		view, err := ReadStatus(context.Background(), dir)
		if err != nil {
			t.Fatal(err)
		}
		if wake, ok := view.wakeUps(); !ok || !wake.Listening {
			t.Fatalf("wakeUps = %+v %v\n%s", wake, ok, RenderStatus(view, time.Now()))
		}
		if text := RenderStatus(view, time.Now()); !strings.Contains(text, "Wake-ups   on · a new version or setting reaches this device within seconds") {
			t.Fatalf("status:\n%s", text)
		}
	})
}
