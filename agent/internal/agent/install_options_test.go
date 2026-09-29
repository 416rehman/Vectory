package agent

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func optionPointer[T any](value T) *T { return &value }

func TestInstallOptionsRejectAllInputsBeforeExistingMutation(t *testing.T) {
	for _, invalid := range []string{"metrics", "port-zero", "port-range", "secret", "policy", "binary", "config"} {
		t.Run(invalid, func(t *testing.T) {
			f := maintenanceFixture(t)
			opts := InstallOptions{FullVectorConfig: optionPointer(true)}
			switch invalid {
			case "metrics":
				opts.MetricsURL = optionPointer("not-an-endpoint")
			case "port-zero":
				opts.MetricsURL = optionPointer("http://127.0.0.1:0/metrics")
			case "port-range":
				opts.MetricsURL = optionPointer("http://127.0.0.1:65536/metrics")
			case "secret":
				opts.SecretFiles = optionPointer(map[string]string{"TOKEN": filepath.Join(f.dir, "missing-secret")})
			case "policy":
				opts.CapabilityPolicy = &CapabilityPolicy{AllowedNetworkHosts: []string{"bad-destination"}}
			case "binary":
				opts.VectorBinary = optionPointer("")
			case "config":
				opts.ManagedConfig = optionPointer("relative.json")
			}
			if InstallWithOptions(context.Background(), f.dir, opts) == nil {
				t.Fatal("invalid combined request accepted")
			}
			for path, expected := range f.files {
				got, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(got, expected) {
					t.Fatalf("invalid later option changed %s", filepath.Base(path))
				}
			}
		})
	}
}

func TestInstallOptionsComposeOnceWithExplicitPresence(t *testing.T) {
	f := maintenanceFixture(t)
	secret := filepath.Join(t.TempDir(), "synthetic-secret")
	if err := AtomicWrite(secret, []byte("synthetic-placeholder")); err != nil {
		t.Fatal(err)
	}
	opts := InstallOptions{
		FullVectorConfig: optionPointer(true), MetricsURL: optionPointer("http://127.0.0.1:9600/metrics"),
		CapabilityPolicy: &CapabilityPolicy{AllowedNetworkHosts: []string{"logs.example.invalid:443"}},
		SecretFiles:      optionPointer(map[string]string{"NEW": secret}),
	}
	if err := InstallWithOptions(context.Background(), f.dir, opts); err != nil {
		t.Fatal(err)
	}
	s, _ := LoadSettings(f.dir)
	if !s.CapabilityPolicy.FullVectorConfig || s.MetricsURL != *opts.MetricsURL || len(s.SecretFiles) != 1 || s.SecretFiles["NEW"] != secret || len(s.CapabilityPolicy.AllowedNetworkHosts) != 1 {
		t.Fatal("did not save the composed option set")
	}
	settingsPath, statePath := filepath.Join(f.dir, "settings.json"), filepath.Join(f.dir, "state.json")
	currentSettings := maintenanceFields(t, settingsPath)
	oldSettings, _ := adoptionObject(f.files[settingsPath])
	if !equalRawJSON(currentSettings["future_extension"], oldSettings["future_extension"]) {
		t.Fatal("composed update lost unknown settings")
	}
	currentState := maintenanceFields(t, statePath)
	oldState, _ := adoptionObject(f.files[statePath])
	for key, value := range oldState {
		if key == "failed_generation" || key == "failed_effective_sha256" {
			if _, exists := currentState[key]; exists {
				t.Fatal("changed capabilities retained old suppression")
			}
		} else if !equalRawJSON(value, currentState[key]) {
			t.Fatalf("changed unrelated state field %s", key)
		}
	}
	// An omitted mode cannot be revoked by the policy file. Equal options must
	// preserve a later failure and raw file bytes without another reset.
	if err := os.WriteFile(statePath, f.files[statePath], 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(settingsPath)
	opts.FullVectorConfig = nil
	if err := InstallWithOptions(context.Background(), f.dir, opts); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(settingsPath)
	state, _ := os.ReadFile(statePath)
	if !bytes.Equal(before, after) || !bytes.Equal(state, f.files[statePath]) {
		t.Fatal("equal composed update rewrote files or reset later failure")
	}
	if err := InstallWithOptions(context.Background(), f.dir, InstallOptions{FullVectorConfig: optionPointer(false), SecretFiles: optionPointer(map[string]string{})}); err != nil {
		t.Fatal(err)
	}
	s, _ = LoadSettings(f.dir)
	if s.CapabilityPolicy.FullVectorConfig || len(s.SecretFiles) != 0 || s.MetricsURL != *opts.MetricsURL || len(s.CapabilityPolicy.AllowedNetworkHosts) != 1 {
		t.Fatal("explicit false/empty or omitted fields were not respected")
	}
}

func TestInstallOptionsFreshPreflightHasNoSideEffects(t *testing.T) {
	for _, invalid := range []string{"metrics", "missing-binary", "managed-directory", "probe"} {
		t.Run(invalid, func(t *testing.T) {
			root := t.TempDir()
			dir, managed := filepath.Join(root, "new-state"), filepath.Join(root, "new-managed", "managed.json")
			binary := filepath.Join(root, "synthetic-vector")
			if err := os.WriteFile(binary, []byte("synthetic-probe-fixture"), 0700); err != nil {
				t.Fatal(err)
			}
			opts := InstallOptions{Adopt: true, VectorBinary: &binary, ManagedConfig: &managed}
			switch invalid {
			case "metrics":
				opts.MetricsURL = optionPointer("bad-metrics")
			case "missing-binary":
				opts.VectorBinary = optionPointer(filepath.Join(root, "missing-vector"))
			case "managed-directory":
				opts.ManagedConfig = optionPointer(filepath.Join(dir, "managed.json"))
			}
			probeCalled := false
			err := installWithOptions(context.Background(), dir, opts, func(context.Context, Settings) (string, error) {
				probeCalled = true
				return "", errors.New("synthetic unsupported version")
			})
			if err == nil || probeCalled != (invalid == "probe") {
				t.Fatal("preflight order or refusal incorrect", err)
			}
			if _, err = os.Lstat(dir); !os.IsNotExist(err) {
				t.Fatal("invalid input created/protected state directory")
			}
			if _, err = os.Lstat(filepath.Dir(managed)); !os.IsNotExist(err) {
				t.Fatal("invalid input created managed directory")
			}
		})
	}
}

func TestInstallOptionsFreshModeAndConcurrentInstallation(t *testing.T) {
	for _, concurrent := range []bool{false, true} {
		t.Run(map[bool]string{false: "fresh-policy-cannot-grant-mode", true: "fresh-reread"}[concurrent], func(t *testing.T) {
			root := t.TempDir()
			dir, managed, binary := filepath.Join(root, "state"), filepath.Join(root, "managed", "managed.json"), filepath.Join(root, "vector")
			if err := os.WriteFile(binary, []byte("synthetic-probe-fixture"), 0700); err != nil {
				t.Fatal(err)
			}
			opts := InstallOptions{Adopt: true, VectorBinary: &binary, ManagedConfig: &managed, CapabilityPolicy: &CapabilityPolicy{FullVectorConfig: true}, MetricsURL: optionPointer("http://127.0.0.1:9598/metrics")}
			probe := func(_ context.Context, s Settings) (string, error) {
				if s.CapabilityPolicy.FullVectorConfig {
					t.Fatal("policy file implicitly granted fresh full mode")
				}
				if concurrent {
					if err := PrivateDir(dir); err != nil {
						t.Fatal(err)
					}
					s.Name, s.Server = "peer-install", "https://example.invalid:8443"
					if err := WriteJSON(filepath.Join(dir, "settings.json"), s); err != nil {
						t.Fatal(err)
					}
					if err := SaveState(dir, State{HighestGeneration: 77, ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
						t.Fatal(err)
					}
				}
				return VectorVersion, nil
			}
			if err := installWithOptions(context.Background(), dir, opts, probe); err != nil {
				t.Fatal(err)
			}
			s, _ := LoadSettings(dir)
			if s.CapabilityPolicy.FullVectorConfig || s.MetricsURL != *opts.MetricsURL || concurrent && s.Name != "peer-install" {
				t.Fatal("fresh composition or under-lock reread failed")
			}
			if concurrent {
				state, err := LoadState(dir)
				if err != nil || state.HighestGeneration != 77 {
					t.Fatal("existing installation reread reset durable state")
				}
			}
		})
	}
}

func TestInstallOptionsDoesNotAcceptIncompleteExistingState(t *testing.T) {
	f := maintenanceFixture(t)
	path := filepath.Join(f.dir, "state.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	for _, options := range []InstallOptions{{}, {MetricsURL: optionPointer("http://127.0.0.1:9600/metrics")}} {
		if InstallWithOptions(context.Background(), f.dir, options) == nil {
			t.Fatal("incomplete initialization reported as successful install")
		}
		settings, _ := os.ReadFile(filepath.Join(f.dir, "settings.json"))
		if !bytes.Equal(settings, f.files[filepath.Join(f.dir, "settings.json")]) {
			t.Fatal("incomplete installation altered settings")
		}
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("fabricated missing anti-rollback state")
		}
	}
}

func TestInstallOptionsFreshInitializationFailureIsExplicit(t *testing.T) {
	root := t.TempDir()
	dir, managed, binary := filepath.Join(root, "state"), filepath.Join(root, "managed", "managed.json"), filepath.Join(root, "vector")
	if err := os.WriteFile(binary, []byte("synthetic-probe-fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	opts := InstallOptions{Adopt: true, VectorBinary: &binary, ManagedConfig: &managed}
	err := installWithOptionsAndState(context.Background(), dir, opts,
		func(context.Context, Settings) (string, error) { return VectorVersion, nil },
		func(string, State) error { return errors.New("injected initial state write failure") })
	if err == nil || !strings.Contains(err.Error(), "installation settings were saved, but state initialization is incomplete") {
		t.Fatal("fresh partial initialization was not disclosed", err)
	}
	if _, err = LoadSettings(dir); err != nil {
		t.Fatal("fixture did not reach settings commit", err)
	}
	if _, err = os.Lstat(filepath.Join(dir, "state.json")); !os.IsNotExist(err) {
		t.Fatal("fixture unexpectedly created state")
	}
	if InstallWithOptions(context.Background(), dir, InstallOptions{}) == nil {
		t.Fatal("later no-op falsely accepted incomplete installation")
	}
}

func TestInstallOptionsStrictInputObjects(t *testing.T) {
	for _, value := range []string{"null", "[]", `{} {}`, `{"allowed_file_roots":[],"allowed_file_roots":[]}`, `{"allow_full":true}`, `{"allowed_network_hosts":["bad"]}`, `{"allowed_file_roots":["relative"]}`, `{"full_vector_config":null}`} {
		path := filepath.Join(t.TempDir(), "policy.json")
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadInstallPolicy(path); err == nil {
			t.Fatalf("accepted invalid policy object %s", value)
		}
	}
	for _, value := range []string{"null", "[]", `{} {}`, `{"KEY":"x","KEY":"y"}`, `{"KEY":null}`} {
		path := filepath.Join(t.TempDir(), "bindings.json")
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadSecretBindings(path); err == nil {
			t.Fatalf("accepted invalid bindings object %s", value)
		}
	}
}
