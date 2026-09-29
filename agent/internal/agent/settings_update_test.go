package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func maintenanceFixture(t *testing.T) readoptFixture {
	t.Helper()
	f := newReadoptFixture(t, false)
	for _, name := range []string{"settings.json", "state.json"} {
		path := filepath.Join(f.dir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		fields, _ := adoptionObject(data)
		fields["future_extension"] = json.RawMessage(`{"exact":18446744073709551615,"future":null}`)
		if name == "settings.json" {
			capability, _ := adoptionObject(fields["capability_policy"])
			capability["future_capability"] = json.RawMessage(`{"exact":18446744073709551615,"list":[null,1]}`)
			fields["capability_policy"], _ = json.Marshal(capability)
		}
		data, _ = json.Marshal(fields)
		data = append([]byte(" \n\t"), append(data, '\n', '\n')...)
		if err = os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		f.files[path] = data
	}
	return f
}

func maintenanceFields(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := adoptionObject(data)
	if err != nil {
		t.Fatal(err)
	}
	return fields
}

func equalRawJSON(a, b []byte) bool {
	var ca, cb bytes.Buffer
	return json.Compact(&ca, a) == nil && json.Compact(&cb, b) == nil && bytes.Equal(ca.Bytes(), cb.Bytes())
}

func TestSettingsMaintenancePreservesUnrelatedFields(t *testing.T) {
	for _, operation := range []string{"metrics", "secrets", "allowances", "full", "retry"} {
		t.Run(operation, func(t *testing.T) {
			f := maintenanceFixture(t)
			settingsPath, statePath := filepath.Join(f.dir, "settings.json"), filepath.Join(f.dir, "state.json")
			beforeSettings, beforeState := maintenanceFields(t, settingsPath), maintenanceFields(t, statePath)
			var err error
			changedSettings := map[string]bool{}
			switch operation {
			case "metrics":
				changedSettings["metrics_url"] = true
				err = ConfigureMetrics(f.dir, "http://127.0.0.1:9599/metrics")
			case "secrets":
				changedSettings["secret_files"] = true
				secret := filepath.Join(t.TempDir(), "synthetic-secret")
				if err = AtomicWrite(secret, []byte("synthetic-placeholder")); err != nil {
					t.Fatal(err)
				}
				err = ConfigureSecretFiles(f.dir, map[string]string{"NEW": secret})
			case "allowances":
				changedSettings["capability_policy"] = true
				err = Install(context.Background(), f.dir, "", "", false, &CapabilityPolicy{AllowedNetworkHosts: []string{"logs.example.invalid:443"}})
			case "full":
				changedSettings["capability_policy"] = true
				err = ConfigureFullVector(f.dir, true)
			case "retry":
				err = Retry(f.dir)
			}
			if err != nil {
				t.Fatal(err)
			}
			afterSettings, afterState := maintenanceFields(t, settingsPath), maintenanceFields(t, statePath)
			for key, value := range beforeSettings {
				if !changedSettings[key] && !equalRawJSON(value, afterSettings[key]) {
					t.Fatalf("changed unrelated settings field %s", key)
				}
			}
			beforeCap, _ := adoptionObject(beforeSettings["capability_policy"])
			afterCap, _ := adoptionObject(afterSettings["capability_policy"])
			if !equalRawJSON(beforeCap["future_capability"], afterCap["future_capability"]) {
				t.Fatal("lost nested capability extension")
			}
			reset := operation == "allowances" || operation == "full" || operation == "retry"
			for key, value := range beforeState {
				if reset && (key == "failed_generation" || key == "failed_effective_sha256") {
					if _, exists := afterState[key]; exists {
						t.Fatal("explicit maintenance did not clear suppression")
					}
				} else if !equalRawJSON(value, afterState[key]) {
					t.Fatalf("changed unrelated state field %s", key)
				}
			}
			for path, data := range f.files {
				if path != settingsPath && path != statePath {
					got, readErr := os.ReadFile(path)
					if readErr != nil || !bytes.Equal(got, data) {
						t.Fatalf("changed unrelated artifact %s", filepath.Base(path))
					}
				}
			}
			if operation == "secrets" {
				s, _ := LoadSettings(f.dir)
				if len(s.SecretFiles) != 1 || s.SecretFiles["NEW"] == "" {
					t.Fatal("new binding map merged instead of replacing old names")
				}
				if err = ConfigureSecretFiles(f.dir, map[string]string{}); err != nil {
					t.Fatal(err)
				}
				s, _ = LoadSettings(f.dir)
				if len(s.SecretFiles) != 0 {
					t.Fatal("empty map retained old bindings")
				}
			}
		})
	}
}

func TestSettingsMaintenanceNoOpKeepsExactBytes(t *testing.T) {
	f := maintenanceFixture(t)
	path := filepath.Join(f.dir, "settings.json")
	fields := maintenanceFields(t, path)
	fields["secret_files"] = json.RawMessage(`{}`)
	data, _ := json.Marshal(fields)
	data = append([]byte("\n \t"), append(data, '\n')...)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	operations := []func() error{
		func() error { return Install(context.Background(), f.dir, "", "", false, nil) },
		func() error { return Install(context.Background(), f.dir, "", "", false, &CapabilityPolicy{}) },
		func() error { return ConfigureFullVector(f.dir, false) },
		func() error { return ConfigureSecretFiles(f.dir, map[string]string{}) },
		func() error { return ConfigureMetrics(f.dir, f.settings.MetricsURL) },
	}
	for _, operation := range operations {
		if err := operation(); err != nil {
			t.Fatal(err)
		}
		got, _ := os.ReadFile(path)
		state, _ := os.ReadFile(filepath.Join(f.dir, "state.json"))
		if !bytes.Equal(got, data) || !bytes.Equal(state, f.files[filepath.Join(f.dir, "state.json")]) {
			t.Fatal("no-op rewrote formatting, absent values or retry state")
		}
	}
	for _, value := range []string{"null", ""} {
		fields["capability_policy"] = json.RawMessage(value)
		if value == "" {
			delete(fields, "capability_policy")
		}
		data, _ = json.Marshal(fields)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if err := ConfigureFullVector(f.dir, false); err != nil {
			t.Fatal(err)
		}
		got, _ := os.ReadFile(path)
		if !bytes.Equal(got, data) {
			t.Fatal("no-op materialized legacy null/absent capability default")
		}
		if err := ConfigureFullVector(f.dir, true); err != nil {
			t.Fatal("could not explicitly update legacy default", err)
		}
	}
}

func TestSettingsMaintenanceRefusesUnsafeOrChangedFiles(t *testing.T) {
	for _, test := range []string{"missing", "directory", "invalid", "duplicate", "oversized"} {
		t.Run(test, func(t *testing.T) {
			f := maintenanceFixture(t)
			path := filepath.Join(f.dir, "settings.json")
			switch test {
			case "missing":
				_ = os.Remove(path)
			case "directory":
				_ = os.Remove(path)
				_ = os.Mkdir(path, 0700)
			case "invalid":
				_ = os.WriteFile(path, []byte("null"), 0600)
			case "duplicate":
				_ = os.WriteFile(path, []byte(`{"name":"one","name":"two"}`), 0600)
			case "oversized":
				_ = os.WriteFile(path, bytes.Repeat([]byte(" "), 2*MaxArtifact+1), 0600)
			}
			if err := ConfigureFullVector(f.dir, true); err == nil {
				t.Fatal("unsafe settings accepted")
			}
			state, _ := os.ReadFile(filepath.Join(f.dir, "state.json"))
			if !bytes.Equal(state, f.files[filepath.Join(f.dir, "state.json")]) {
				t.Fatal("refusal reset suppression")
			}
		})
	}
	f := maintenanceFixture(t)
	doc, err := loadSettingsDocument(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	next := doc.value
	next.MetricsURL = "http://127.0.0.1:9599/metrics"
	prepared, err := doc.prepare(next)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.close()
	changed := append(append([]byte{}, doc.raw...), '\n')
	if err = os.WriteFile(doc.path, changed, 0600); err != nil {
		t.Fatal(err)
	}
	if prepared.commit() == nil {
		t.Fatal("committed over a changed settings snapshot")
	}
	got, _ := os.ReadFile(doc.path)
	if !bytes.Equal(got, changed) {
		t.Fatal("refusal overwrote new settings")
	}
	if _, err = prepareMaintenanceWriteWithSecurity(doc.path, changed, []byte(`{}`), func(string, string) error { return errors.New("injected access preservation failure") }); err == nil {
		t.Fatal("metadata failure accepted")
	}
	got, _ = os.ReadFile(doc.path)
	if !bytes.Equal(got, changed) {
		t.Fatal("metadata refusal changed original")
	}
}

func TestSettingsMaintenanceRequiresStoppedAgent(t *testing.T) {
	f := maintenanceFixture(t)
	unlock, err := Lock(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	operations := []func() error{
		func() error { return ConfigureMetrics(f.dir, "http://127.0.0.1:9600/metrics") },
		func() error { return ConfigureSecretFiles(f.dir, map[string]string{}) },
		func() error {
			return EnrollWithOptions(context.Background(), f.dir, EnrollmentOptions{Server: f.settings.Server, Name: f.settings.Name, Token: "synthetic"})
		},
		func() error { return ConfigureFullVector(f.dir, true) },
		func() error { return Install(context.Background(), f.dir, "", "", false, nil) },
		func() error { return Unenroll(f.dir) },
		func() error { return Retry(f.dir) },
	}
	for _, operation := range operations {
		if operation() == nil {
			t.Fatal("maintenance accepted while daemon lock held")
		}
	}
	for path, expected := range f.files {
		got, readErr := os.ReadFile(path)
		if readErr != nil || !bytes.Equal(got, expected) {
			t.Fatalf("locked refusal changed %s", filepath.Base(path))
		}
	}
}

func TestUnenrollPreflightsSettingsAndPreservesUnrelatedSettings(t *testing.T) {
	f := maintenanceFixture(t)
	statePath := filepath.Join(f.dir, "state.json")
	if err := os.WriteFile(statePath, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if Unenroll(f.dir) == nil {
		t.Fatal("unenrollment accepted broken state")
	}
	for _, name := range []string{"identity.json", "credentials.json", "private-key.pem"} {
		got, err := os.ReadFile(filepath.Join(f.dir, name))
		if err != nil || !bytes.Equal(got, f.files[filepath.Join(f.dir, name)]) {
			t.Fatal("failed preflight removed identity")
		}
	}
	if err := os.WriteFile(statePath, f.files[statePath], 0600); err != nil {
		t.Fatal(err)
	}
	before := maintenanceFields(t, filepath.Join(f.dir, "settings.json"))
	old, _ := LoadState(f.dir)
	if err := Unenroll(f.dir); err != nil {
		t.Fatal(err)
	}
	after := maintenanceFields(t, filepath.Join(f.dir, "settings.json"))
	for key, value := range before {
		if key == "name" || key == "server" {
			if string(after[key]) != `""` {
				t.Fatal("retained unenrolled server identity")
			}
		} else if !equalRawJSON(value, after[key]) {
			t.Fatalf("unenrollment changed unrelated settings field %s", key)
		}
	}
	current, _ := LoadState(f.dir)
	if !reflect.DeepEqual(current, resetForReplacement(old, "")) {
		t.Fatal("unenrollment changed established identity-reset semantics")
	}
	for _, path := range []string{f.managed, f.good, filepath.Join(f.dir, "paused")} {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, f.files[path]) {
			t.Fatal("unenrollment changed retained workload or pause")
		}
	}
}
