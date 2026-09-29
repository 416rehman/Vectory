package agent

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestInstallReplacesLocalAllowancesWithoutResettingIdentity(t *testing.T) {
	for _, full := range []bool{false, true} {
		t.Run(map[bool]string{false: "restricted", true: "full"}[full], func(t *testing.T) {
			dir := t.TempDir()
			settings := Settings{
				Server: "https://control.example.test:8443", Name: "existing-host", CAFile: "trusted-ca.pem",
				VectorBinary: "adopted-vector", VectorBinarySHA256: "pinned-binary", ManagedConfig: "managed.json", Adopted: true,
				ValidationSeconds: 30, StartupSeconds: 20, MetricsURL: "http://127.0.0.1:9598/metrics",
				SecretFiles:      map[string]string{"TOKEN": "host-private-token"},
				CapabilityPolicy: CapabilityPolicy{FullVectorConfig: full, AllowedNetworkHosts: []string{"old.example.test:443"}},
			}
			generation := uint64(42)
			state := State{
				DeviceID: "existing-device", HighestGeneration: 42, HighestPolicyGeneration: 31,
				DesiredIdentity: "accepted-configuration", PolicyIdentity: "accepted-policy", Accepted: true,
				ReportedGeneration: 40, ApplyState: "failed", LastGoodSHA256: "verified-content", ActualSHA256: "verified-content",
				Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true, SyncPaused: true}, RemotePauseAcknowledged: true,
				SecretRevision: 8, AppliedSecretRevision: 7, AppliedTemplateSHA256: "verified-template",
				MaterializationSHA256: "rendered-template", FailedGeneration: &generation, FailedEffectiveSHA256: "rejected-content",
			}
			if err := WriteJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
				t.Fatal(err)
			}
			if err := SaveState(dir, state); err != nil {
				t.Fatal(err)
			}
			preserved := map[string]string{
				"identity.pem": "private credential fixture", "good-verified-content.json": "verified artifact fixture",
				"journal.json": `{"stage":"written","generation":42}`, "paused": "local emergency pause\n",
			}
			for name, data := range preserved {
				if err := AtomicWrite(filepath.Join(dir, name), []byte(data)); err != nil {
					t.Fatal(err)
				}
			}
			updated := CapabilityPolicy{FullVectorConfig: !full, AllowedFileRoots: []string{t.TempDir()}, AllowedNetworkHosts: []string{"new.example.test:443"}, AllowedListenAddresses: []string{"127.0.0.1:9598"}}
			unlock, err := Lock(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err = Install(context.Background(), dir, "", "", false, &updated); err == nil {
				t.Fatal("changed permissions while the daemon lock was held")
			}
			unlock()
			if got, err := LoadSettings(dir); err != nil || !reflect.DeepEqual(got, settings) {
				t.Fatal("rejected live update modified settings", err)
			}
			if err = Install(context.Background(), dir, "", "", false, &updated); err != nil {
				t.Fatal(err)
			}
			updated.FullVectorConfig = full
			settings.CapabilityPolicy = updated
			if got, err := LoadSettings(dir); err != nil || !reflect.DeepEqual(got, settings) {
				t.Fatal("allowance replacement changed adoption, identity settings or trust mode", err)
			}
			state.FailedGeneration, state.FailedEffectiveSHA256 = nil, ""
			if got, err := LoadState(dir); err != nil || !reflect.DeepEqual(got, state) {
				t.Fatal("allowance replacement lost durable security or recovery state", err)
			}
			for name, expected := range preserved {
				if data, err := os.ReadFile(filepath.Join(dir, name)); err != nil || string(data) != expected {
					t.Fatalf("allowance update altered %s: %v", name, err)
				}
			}
			if !full {
				config := []byte(`{"sources":{"demo":{"type":"demo_logs"}},"sinks":{"out":{"type":"http","inputs":["demo"],"uri":"https://new.example.test/events","encoding":{"codec":"json"}}}}`)
				if err = updated.Check(config); err != nil {
					t.Fatal("newly approved destination still rejected", err)
				}
			}

			// Omitting the flag or repeating identical allowances is a no-op,
			// including rejection suppression from a subsequent failed attempt.
			state.FailedGeneration, state.FailedEffectiveSHA256 = &generation, "later-rejection"
			if err = SaveState(dir, state); err != nil {
				t.Fatal(err)
			}
			for _, policy := range []*CapabilityPolicy{nil, &updated} {
				if err = Install(context.Background(), dir, "", "", false, policy); err != nil {
					t.Fatal(err)
				}
				if got, err := LoadState(dir); err != nil || !reflect.DeepEqual(got, state) {
					t.Fatal("idempotent install reset retry suppression", err)
				}
			}
			if err = Install(context.Background(), dir, "", "", false, &CapabilityPolicy{}); err != nil {
				t.Fatal(err)
			}
			if got, err := LoadSettings(dir); err != nil || !reflect.DeepEqual(got.CapabilityPolicy, CapabilityPolicy{FullVectorConfig: full}) {
				t.Fatal("explicit empty policy did not remove allowances while retaining trust mode", err)
			}
		})
	}
}

func TestInstallPolicyUpdateRejectsBrokenStateOrChangedAdoption(t *testing.T) {
	dir := t.TempDir()
	settings := Settings{VectorBinary: "fixed-binary", ManagedConfig: "fixed-config", CapabilityPolicy: CapabilityPolicy{AllowedNetworkHosts: []string{"old.example.test:443"}}}
	if err := WriteJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	updated := CapabilityPolicy{AllowedNetworkHosts: []string{"new.example.test:443"}}
	if err := Install(context.Background(), dir, "different-binary", "", false, &updated); err == nil {
		t.Fatal("allowance update accepted a changed adopted executable")
	}
	if err := AtomicWrite(filepath.Join(dir, "state.json"), []byte("broken state")); err != nil {
		t.Fatal(err)
	}
	if err := Install(context.Background(), dir, "", "", false, &updated); err == nil {
		t.Fatal("allowance update discarded unreadable security state")
	}
	if got, err := LoadSettings(dir); err != nil || !reflect.DeepEqual(got, settings) {
		t.Fatal("failed update modified protected settings", err)
	}
}
