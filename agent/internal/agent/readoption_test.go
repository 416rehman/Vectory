package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSamePathInstallDoesNotTrustReplacedBinary(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "vector.exe")
	if err := os.WriteFile(binary, []byte("original synthetic binary"), 0700); err != nil {
		t.Fatal(err)
	}
	pinned, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	s := Settings{Adopted: true, VectorBinary: binary, VectorBinarySHA256: pinned, ManagedConfig: filepath.Join(dir, "managed.json")}
	if err = WriteJSON(filepath.Join(dir, "settings.json"), s); err != nil {
		t.Fatal(err)
	}
	if err = SaveState(dir, State{HighestGeneration: 7}); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(binary, []byte("deliberate synthetic replacement"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = Install(context.Background(), dir, binary, s.ManagedConfig, true, nil); err != nil {
		t.Fatal(err)
	}
	got, err := LoadSettings(dir)
	if err != nil || got.VectorBinarySHA256 != pinned {
		t.Fatal("ordinary install silently approved new bytes", err)
	}
	driver := &VectorDriver{Settings: got}
	for name, run := range map[string]func() error{
		"validate": func() error { return driver.Validate(context.Background(), s.ManagedConfig) },
		"activate": func() error { return driver.Activate(context.Background(), s.ManagedConfig) },
	} {
		failure := asVectorFailure(run())
		if failure == nil || len(failure.Diagnostics) != 1 || failure.Diagnostics[0].Code != "VECTOR_BINARY_UNAVAILABLE" {
			t.Fatalf("driver must reject replacement before executing it (%s): %+v", name, failure)
		}
	}
}

type readoptFixture struct {
	dir, binary, approved, managed, good string
	settings                             Settings
	files                                map[string][]byte
}

func newReadoptFixture(t *testing.T, full bool) readoptFixture {
	t.Helper()
	dir, configDir, binDir := t.TempDir(), t.TempDir(), t.TempDir()
	binary, managed := filepath.Join(binDir, "vector.exe"), filepath.Join(configDir, "managed.json")
	write := func(path string, data []byte) {
		if err := AtomicWrite(path, data); err != nil {
			t.Fatal(err)
		}
	}
	write(binary, []byte("original executable fixture"))
	original, _ := FileDigest(binary)
	settings := Settings{Server: "https://example.invalid:8443", CAFile: "synthetic-ca", Name: "synthetic", VectorBinary: binary, VectorBinarySHA256: original, ManagedConfig: managed, Adopted: true, CapabilityPolicy: CapabilityPolicy{FullVectorConfig: full}, ValidationSeconds: 23, StartupSeconds: 19, MetricsURL: "http://127.0.0.1:9598/metrics", SecretFiles: map[string]string{"TOKEN": "synthetic-binding"}}
	if err := WriteJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	fields, _ := adoptionObject(raw)
	fields["future_extension"] = json.RawMessage(`{"exact":18446744073709551615,"opaque":[null,false]}`)
	raw, _ = json.Marshal(fields)
	write(filepath.Join(dir, "settings.json"), raw)
	goodData := []byte(`{"sources":{"x":{"type":"demo_logs"}},"sinks":{"out":{"type":"blackhole","inputs":["x"]}}}`)
	managedData := []byte(`{"sources":{"manual":{"type":"demo_logs"}},"sinks":{"out":{"type":"blackhole","inputs":["manual"]}}}`)
	good := filepath.Join(dir, "good-"+Digest(goodData)+".json")
	write(managed, managedData)
	write(good, goodData)
	failed := uint64(42)
	state := State{DeviceID: "synthetic-device", HighestGeneration: 42, HighestPolicyGeneration: 9, ReportedGeneration: 40, LastGoodSHA256: Digest(goodData), ActualSHA256: Digest(goodData), ApplyState: "rolled_back", FailedGeneration: &failed, FailedEffectiveSHA256: Digest([]byte("rejected")), SecretRevision: 8, AppliedSecretRevision: 7, Policy: Policy{HeartbeatSeconds: 120, SyncPaused: true}, ConfigurationAttempt: &ConfigurationAttempt{Generation: 42, VersionID: "synthetic-version", SHA256: Digest([]byte("candidate")), State: "rolled_back", SecretRevision: 8, Error: &Issue{Code: "APPLY_ROLLED_BACK", Stage: "rollback", Message: "synthetic"}}}
	if err := SaveState(dir, state); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"credentials.json", "identity.json", "private-key.pem", "origin.json", "paused"} {
		write(filepath.Join(dir, name), []byte("synthetic preserved "+name))
	}
	files := map[string][]byte{}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		files[path], _ = os.ReadFile(path)
	}
	files[managed] = managedData
	write(binary, []byte("approved replacement fixture"))
	approved, _ := FileDigest(binary)
	return readoptFixture{dir, binary, approved, managed, good, settings, files}
}

func successfulChecks() adoptionChecks {
	return adoptionChecks{func(context.Context, Settings) (string, error) { return VectorVersion, nil }, func(context.Context, Settings, string) error { return nil }}
}

func TestReAdoptValidatesWithHostRuntimeWithoutLeavingFiles(t *testing.T) {
	f := newReadoptFixture(t, false)
	previousProbe := vectorDefaultDataDirProbe
	vectorDefaultDataDirProbe = filepath.Join(t.TempDir(), "absent-default")
	t.Cleanup(func() { vectorDefaultDataDirProbe = previousProbe })
	calls := filepath.Join(t.TempDir(), "calls.log")
	binary := standInVector(t, fakeVectorConfig{Calls: calls})
	digest, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReAdopt(context.Background(), f.dir, binary, digest); err != nil {
		t.Fatal(err)
	}
	validations, _ := vectorCalls(t, calls)
	if len(validations) != 2 {
		t.Fatalf("expected both retained configurations to be validated: %v", validations)
	}
	for _, validation := range validations {
		if strings.Count(validation, "--config-json") != 2 {
			t.Fatalf("re-adoption validated a different runtime than apply: %s", validation)
		}
	}
	if _, err := os.Lstat(agentDataDir(f.dir)); !os.IsNotExist(err) {
		t.Fatalf("validation left a new host data directory: %v", err)
	}
}

func TestReAdoptChangesOnlyApprovedIdentityAndValidatesBothSnapshots(t *testing.T) {
	for _, full := range []bool{false, true} {
		t.Run(map[bool]string{false: "restricted", true: "full"}[full], func(t *testing.T) {
			f := newReadoptFixture(t, full)
			checks := successfulChecks()
			seen := []string{}
			checks.validate = func(_ context.Context, s Settings, path string) error {
				if s.VectorBinary != f.binary || s.VectorBinarySHA256 != f.approved || !reflect.DeepEqual(s.CapabilityPolicy, f.settings.CapabilityPolicy) {
					t.Fatal("validation changed trust/path")
				}
				if path == f.managed || path == f.good {
					t.Fatal("validation must use an immutable copy")
				}
				data, _ := os.ReadFile(path)
				seen = append(seen, string(data))
				return nil
			}
			report, err := reAdopt(context.Background(), f.dir, "", f.approved, checks)
			if err != nil || !report.Changed || report.WorkloadStarted || !reflect.DeepEqual(report.Validated, []string{"managed", "last_good"}) {
				t.Fatal(report, err)
			}
			if !reflect.DeepEqual(seen, []string{string(f.files[f.managed]), string(f.files[f.good])}) {
				t.Fatal("did not validate exact current and recovery bytes")
			}
			for path, data := range f.files {
				if filepath.Base(path) == "settings.json" {
					continue
				}
				got, _ := os.ReadFile(path)
				if string(got) != string(data) {
					t.Fatalf("changed %s", filepath.Base(path))
				}
			}
			before, _ := adoptionObject(f.files[filepath.Join(f.dir, "settings.json")])
			afterBytes, _ := os.ReadFile(filepath.Join(f.dir, "settings.json"))
			after, _ := adoptionObject(afterBytes)
			before["vector_binary_sha256"], _ = json.Marshal(f.approved)
			for key, want := range before {
				var a, b any
				d := json.NewDecoder(strings.NewReader(string(want)))
				d.UseNumber()
				_ = d.Decode(&a)
				d = json.NewDecoder(strings.NewReader(string(after[key])))
				d.UseNumber()
				_ = d.Decode(&b)
				if !reflect.DeepEqual(a, b) {
					t.Fatalf("changed setting %s", key)
				}
			}
			report, err = reAdopt(context.Background(), f.dir, "", f.approved, successfulChecks())
			if err != nil || report.Changed {
				t.Fatal("same approved pin is not a no-op", err)
			}
			final, _ := os.ReadFile(filepath.Join(f.dir, "settings.json"))
			if string(final) != string(afterBytes) {
				t.Fatal("same-pin validation rewrote settings")
			}
		})
	}
}

func TestReAdoptExplicitNewPathPreservesManagedPath(t *testing.T) {
	f := newReadoptFixture(t, false)
	candidate := filepath.Join(t.TempDir(), "vector.exe")
	if err := AtomicWrite(candidate, []byte("different location")); err != nil {
		t.Fatal(err)
	}
	approved, _ := FileDigest(candidate)
	report, err := reAdopt(context.Background(), f.dir, candidate, approved, successfulChecks())
	if err != nil || report.VectorBinary != candidate {
		t.Fatal(report, err)
	}
	s, _ := LoadSettings(f.dir)
	if s.ManagedConfig != f.managed || s.VectorBinary != candidate || s.VectorBinarySHA256 != approved {
		t.Fatal(s)
	}
}

func TestReAdoptRejectsBeforeCandidateExecution(t *testing.T) {
	for _, mode := range []string{"wrong_hash", "malformed_hash", "held_lock", "missing_state", "corrupt_state", "empty_state", "null_counter", "empty_policy", "null_policy_flag", "unknown_state", "missing_settings", "journal", "identity_journal", "relative_binary", "directory_binary"} {
		t.Run(mode, func(t *testing.T) {
			f := newReadoptFixture(t, false)
			approved, binary := f.approved, ""
			unlock := func() {}
			switch mode {
			case "wrong_hash":
				approved = strings.Repeat("0", 64)
			case "malformed_hash":
				approved = "abc"
			case "held_lock":
				var err error
				unlock, err = Lock(f.dir)
				if err != nil {
					t.Fatal(err)
				}
			case "missing_state":
				_ = os.Remove(filepath.Join(f.dir, "state.json"))
			case "corrupt_state":
				_ = AtomicWrite(filepath.Join(f.dir, "state.json"), []byte("null"))
			case "empty_state":
				_ = AtomicWrite(filepath.Join(f.dir, "state.json"), []byte("{}"))
			case "null_counter", "empty_policy", "null_policy_flag", "unknown_state":
				path := filepath.Join(f.dir, "state.json")
				data, _ := os.ReadFile(path)
				fields, _ := adoptionObject(data)
				if mode == "null_counter" {
					fields["reported_generation"] = json.RawMessage("null")
				}
				if mode == "empty_policy" {
					fields["policy"] = json.RawMessage("{}")
				}
				if mode == "null_policy_flag" {
					fields["policy"] = json.RawMessage(`{"heartbeat_seconds":60,"sync_paused":null,"telemetry_enabled":true}`)
				}
				if mode == "unknown_state" {
					fields["apply_state"] = json.RawMessage(`"invented"`)
				}
				data, _ = json.Marshal(fields)
				_ = AtomicWrite(path, data)
			case "missing_settings":
				_ = os.Remove(filepath.Join(f.dir, "settings.json"))
			case "journal":
				_ = AtomicWrite(filepath.Join(f.dir, "journal.json"), []byte("broken"))
			case "identity_journal":
				_ = AtomicWrite(filepath.Join(f.dir, "recovery-commit.json"), []byte("{}"))
			case "relative_binary":
				binary = "relative-vector.exe"
			case "directory_binary":
				binary = t.TempDir()
			}
			defer unlock()
			calls := 0
			checks := successfulChecks()
			checks.probe = func(context.Context, Settings) (string, error) { calls++; return VectorVersion, nil }
			_, err := reAdopt(context.Background(), f.dir, binary, approved, checks)
			if err == nil || calls != 0 {
				t.Fatal("invalid preflight executed candidate", err, calls)
			}
		})
	}
}

func TestReAdoptValidationFailureNeverChangesPin(t *testing.T) {
	for _, mode := range []string{"wrong_version", "probe_failure", "validate_failure", "missing_managed", "missing_good", "corrupt_good", "bad_good_id", "capability_denied"} {
		t.Run(mode, func(t *testing.T) {
			f := newReadoptFixture(t, false)
			checks := successfulChecks()
			switch mode {
			case "wrong_version":
				checks.probe = func(context.Context, Settings) (string, error) { return "0.0.0", nil }
			case "probe_failure":
				checks.probe = func(context.Context, Settings) (string, error) { return "", errors.New("failed") }
			case "validate_failure":
				checks.validate = func(context.Context, Settings, string) error { return errors.New("rejected") }
			case "missing_managed":
				_ = os.Remove(f.managed)
			case "missing_good":
				_ = os.Remove(f.good)
			case "corrupt_good":
				_ = AtomicWrite(f.good, []byte("{}"))
			case "bad_good_id":
				st, _ := LoadState(f.dir)
				st.LastGoodSHA256 = "../unsafe"
				_ = SaveState(f.dir, st)
			case "capability_denied":
				_ = AtomicWrite(f.managed, []byte(`{"sources":{"x":{"type":"exec","command":["never"]}}}`))
			}
			_, err := reAdopt(context.Background(), f.dir, "", f.approved, checks)
			if err == nil {
				t.Fatal("invalid workload accepted")
			}
			s, _ := LoadSettings(f.dir)
			if s.VectorBinarySHA256 != f.settings.VectorBinarySHA256 {
				t.Fatal("failed validation approved digest")
			}
		})
	}
}

func TestReAdoptRejectsChangesOrCancellationDuringValidation(t *testing.T) {
	for _, mode := range []string{"binary_after_probe", "binary_after_validation", "managed", "good", "state", "settings", "journal", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			f := newReadoptFixture(t, false)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			checks := successfulChecks()
			changed := false
			mutate := func() {
				if changed {
					return
				}
				changed = true
				switch mode {
				case "binary_after_probe", "binary_after_validation":
					_ = AtomicWrite(f.binary, []byte("changed again"))
				case "managed":
					_ = AtomicWrite(f.managed, []byte("{}"))
				case "good":
					_ = AtomicWrite(f.good, []byte("{}"))
				case "state":
					st, _ := LoadState(f.dir)
					st.HighestGeneration++
					_ = SaveState(f.dir, st)
				case "settings":
					s, _ := LoadSettings(f.dir)
					s.Name = "concurrent"
					_ = WriteJSON(filepath.Join(f.dir, "settings.json"), s)
				case "journal":
					_ = AtomicWrite(filepath.Join(f.dir, "journal.json"), []byte("{}"))
				case "cancel":
					cancel()
				}
			}
			if mode == "binary_after_probe" {
				checks.probe = func(context.Context, Settings) (string, error) { mutate(); return VectorVersion, nil }
			} else {
				checks.validate = func(context.Context, Settings, string) error { mutate(); return nil }
			}
			_, err := reAdopt(ctx, f.dir, "", f.approved, checks)
			if err == nil {
				t.Fatal("changed/cancelled operation approved")
			}
			s, _ := LoadSettings(f.dir)
			if s.VectorBinarySHA256 != f.settings.VectorBinarySHA256 {
				t.Fatal("failure approved digest")
			}
		})
	}
}

func TestReAdoptNeverEstablishedMissingManagedAndEnrollmentLock(t *testing.T) {
	f := newReadoptFixture(t, false)
	_ = os.Remove(f.managed)
	_ = os.Remove(f.good)
	if err := SaveState(f.dir, State{ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60}}); err != nil {
		t.Fatal(err)
	}
	report, err := reAdopt(context.Background(), f.dir, "", f.approved, successfulChecks())
	if err != nil || len(report.Validated) != 0 || report.WorkloadStarted {
		t.Fatal(report, err)
	}
	unlock, err := Lock(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if err = EnrollWithOptions(context.Background(), f.dir, EnrollmentOptions{Server: "https://example.invalid:8443", Name: "synthetic", Token: "synthetic"}); err == nil {
		t.Fatal("enrollment overwrote settings without sharing daemon lock")
	}
}
