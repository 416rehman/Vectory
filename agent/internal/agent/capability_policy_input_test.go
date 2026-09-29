package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func capabilityInput(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "capability-policy.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCapabilityPolicyRejectsLossyOrAmbiguousDocuments(t *testing.T) {
	root := filepath.Join(t.TempDir(), "replacement-\ufffd")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(root)
	valid := `{"allowed_file_roots":[` + string(encoded) + `]} `
	cases := map[string][]byte{
		"invalid-utf8-path":            bytes.ReplaceAll([]byte(valid), []byte("\ufffd"), []byte{0xff}),
		"lone-high":                    []byte(strings.ReplaceAll(valid, "\ufffd", `\ud800`)),
		"lone-low":                     []byte(strings.ReplaceAll(valid, "\ufffd", `\udfff`)),
		"unpaired-high":                []byte(strings.ReplaceAll(valid, "\ufffd", `\ud800\u0041`)),
		"unknown-value-lone-surrogate": []byte(`{"future_field":"\ud800"}`),
		"key-lone-surrogate":           []byte(`{"\ud800":[]}`),
		"network-lone-surrogate":       []byte(`{"allowed_network_hosts":["\ud800.example:443"]}`),
		"listener-lone-surrogate":      []byte(`{"allowed_listen_addresses":["\udfff.example:443"]}`),
		"invalid-utf8-key":             []byte("{\"\xff\":[]}"),
		"null":                         []byte("null"), "array": []byte("[]"),
		"duplicate":         []byte(`{"allowed_file_roots":[],"allowed_file_roots":[]}`),
		"escaped-duplicate": []byte(`{"allowed_file_roots":[],"\u0061llowed_file_roots":[]}`),
		"trailing":          []byte(valid + "{}"),
		"bom":               append([]byte{0xef, 0xbb, 0xbf}, []byte(valid)...),
		"oversize":          append([]byte("{}"), bytes.Repeat([]byte(" "), 2*MaxArtifact)...),
		"null-element":      []byte(`{"allowed_file_roots":[null]}`),
		"wrong-list-type":   []byte(`{"allowed_file_roots":"not-a-list"}`),
		"wrong-mode-type":   []byte(`{"full_vector_config":null}`),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			path := capabilityInput(t, data)
			_, err := ReadInstallPolicy(path)
			if err == nil {
				t.Fatal("ambiguous or malformed policy accepted")
			}
			if strings.Contains(err.Error(), root) || strings.Contains(err.Error(), path) || strings.Contains(err.Error(), "future_field") {
				t.Fatal("diagnostic disclosed supplied policy contents")
			}
		})
	}
	for _, path := range []string{"", "relative.json", t.TempDir(), filepath.Join(t.TempDir(), "absent.json")} {
		if _, err := ReadInstallPolicy(path); err == nil {
			t.Fatal("unsafe or unavailable policy file accepted")
		}
	}
}

func TestCapabilityPolicyValidUnicodeAndEmptyListCompatibility(t *testing.T) {
	for _, name := range []string{"caf\u00e9", "replacement-\ufffd", "emoji-\U0001f511", `literal-\ud800`} {
		root := filepath.Join(t.TempDir(), name)
		encoded, _ := json.Marshal(root)
		escaped := strings.ReplaceAll(string(encoded), "\ufffd", `\ufffd`)
		escaped = strings.ReplaceAll(escaped, "\U0001f511", `\ud83d\udd11`)
		for _, value := range []string{string(encoded), escaped} {
			raw := []byte(`{"allowed_file_roots":[` + value + `],"allowed_network_hosts":["logs.example.test:443"],"allowed_listen_addresses":["127.0.0.1:9800"],"full_vector_config":true}`)
			policy, err := ReadInstallPolicy(capabilityInput(t, raw))
			if err != nil || len(policy.AllowedFileRoots) != 1 || policy.AllowedFileRoots[0] != root || !policy.FullVectorConfig {
				t.Fatal("valid Unicode policy did not retain exact path", err)
			}
		}
	}
	for _, raw := range []string{`{}`, `{"allowed_file_roots":null,"allowed_network_hosts":null,"allowed_listen_addresses":null}`, `{"allowed_file_roots":[],"allowed_network_hosts":[],"allowed_listen_addresses":[]}`} {
		policy, err := ReadInstallPolicy(capabilityInput(t, []byte(raw)))
		if err != nil || len(policy.AllowedFileRoots)+len(policy.AllowedNetworkHosts)+len(policy.AllowedListenAddresses) != 0 {
			t.Fatal("compatible empty replacement lists were rejected", err)
		}
	}
}

func TestCapabilityPolicyDirectInvalidUTF8RefusesBeforeEffects(t *testing.T) {
	for _, field := range []string{"roots", "network", "listeners"} {
		t.Run(field, func(t *testing.T) {
			f := maintenanceFixture(t)
			policy := &CapabilityPolicy{}
			switch field {
			case "roots":
				policy.AllowedFileRoots = []string{filepath.Join(t.TempDir(), string([]byte{0xff}))}
			case "network":
				policy.AllowedNetworkHosts = []string{string([]byte{0xff}) + ".example:443"}
			case "listeners":
				policy.AllowedListenAddresses = []string{string([]byte{0xff}) + ".example:9800"}
			}
			options := InstallOptions{CapabilityPolicy: policy, FullVectorConfig: optionPointer(true), ClearMetricsURL: true}
			if InstallWithOptions(context.Background(), f.dir, options) == nil {
				t.Fatal("direct API accepted invalid Unicode")
			}
			for path, expected := range f.files {
				actual, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(expected, actual) {
					t.Fatal("invalid direct policy changed installed data", err)
				}
			}
			dir := filepath.Join(t.TempDir(), "uncreated-state")
			called := false
			options.Adopt = true
			if installWithOptions(context.Background(), dir, options, func(context.Context, Settings) (string, error) {
				called = true
				return VectorVersion, nil
			}) == nil || called {
				t.Fatal("invalid policy reached native preflight")
			}
			if _, err := os.Lstat(dir); !os.IsNotExist(err) {
				t.Fatal("invalid policy created fresh state")
			}
		})
	}
}

func TestCapabilityPolicyUnicodeUpdatePreservesAuthorityAndRawFields(t *testing.T) {
	for _, full := range []bool{false, true} {
		t.Run(map[bool]string{false: "restricted", true: "full"}[full], func(t *testing.T) {
			f := maintenanceFixture(t)
			if full {
				if err := ConfigureFullVector(f.dir, true); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(f.dir, "state.json"), f.files[filepath.Join(f.dir, "state.json")], 0600); err != nil {
					t.Fatal(err)
				}
			}
			settingsPath, statePath := filepath.Join(f.dir, "settings.json"), filepath.Join(f.dir, "state.json")
			beforeSettings, beforeState := maintenanceFields(t, settingsPath), maintenanceFields(t, statePath)
			root := filepath.Join(t.TempDir(), "reviewed-\ufffd-\U0001f511")
			raw, _ := json.Marshal(CapabilityPolicy{FullVectorConfig: !full, AllowedFileRoots: []string{root}})
			policy, err := ReadInstallPolicy(capabilityInput(t, raw))
			if err != nil {
				t.Fatal(err)
			}
			if err = InstallWithOptions(context.Background(), f.dir, InstallOptions{CapabilityPolicy: policy}); err != nil {
				t.Fatal(err)
			}
			current, _ := LoadSettings(f.dir)
			if current.CapabilityPolicy.FullVectorConfig != full || len(current.CapabilityPolicy.AllowedFileRoots) != 1 || current.CapabilityPolicy.AllowedFileRoots[0] != root {
				t.Fatal("policy changed mode or normalized a valid path")
			}
			afterSettings, afterState := maintenanceFields(t, settingsPath), maintenanceFields(t, statePath)
			for key, value := range beforeSettings {
				if key != "capability_policy" && !equalRawJSON(value, afterSettings[key]) {
					t.Fatalf("policy update changed unrelated %s", key)
				}
			}
			previousCapability, _ := adoptionObject(beforeSettings["capability_policy"])
			currentCapability, _ := adoptionObject(afterSettings["capability_policy"])
			if !equalRawJSON(previousCapability["future_capability"], currentCapability["future_capability"]) {
				t.Fatal("unknown nested settings lost")
			}
			for key, value := range beforeState {
				if key == "failed_generation" || key == "failed_effective_sha256" {
					if _, present := afterState[key]; present {
						t.Fatal("changed capability did not clear prior suppression")
					}
				} else if !equalRawJSON(value, afterState[key]) {
					t.Fatalf("changed unrelated state %s", key)
				}
			}
			// An equivalent escaped spelling is a no-op, even after a later
			// failure has been recorded. Omitted policy remains no change.
			if err = os.WriteFile(statePath, f.files[statePath], 0600); err != nil {
				t.Fatal(err)
			}
			exact, _ := os.ReadFile(settingsPath)
			exact = append([]byte("\n\t"), exact...)
			if err = os.WriteFile(settingsPath, exact, 0600); err != nil {
				t.Fatal(err)
			}
			escaped := strings.ReplaceAll(string(raw), "\ufffd", `\ufffd`)
			escaped = strings.ReplaceAll(escaped, "\U0001f511", `\ud83d\udd11`)
			policy, err = ReadInstallPolicy(capabilityInput(t, []byte(escaped)))
			if err != nil {
				t.Fatal(err)
			}
			for _, options := range []InstallOptions{{CapabilityPolicy: policy}, {}} {
				if err = InstallWithOptions(context.Background(), f.dir, options); err != nil {
					t.Fatal(err)
				}
				after, _ := os.ReadFile(settingsPath)
				state, _ := os.ReadFile(statePath)
				if !bytes.Equal(exact, after) || !bytes.Equal(state, f.files[statePath]) {
					t.Fatal("equivalent or omitted policy rewrote settings or retry state")
				}
			}
			policy, err = ReadInstallPolicy(capabilityInput(t, []byte("{}")))
			if err != nil {
				t.Fatal(err)
			}
			if err = InstallWithOptions(context.Background(), f.dir, InstallOptions{CapabilityPolicy: policy}); err != nil {
				t.Fatal(err)
			}
			current, _ = LoadSettings(f.dir)
			if current.CapabilityPolicy.FullVectorConfig != full || len(current.CapabilityPolicy.AllowedFileRoots) != 0 {
				t.Fatal("explicit empty policy changed mode or failed to clear lists")
			}
		})
	}
}
