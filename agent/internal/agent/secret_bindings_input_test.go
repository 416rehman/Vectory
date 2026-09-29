package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSecretBindingsInputRejectsAmbiguousObjects(t *testing.T) {
	secret := filepath.Join(privateTempDir(t), "private-synthetic-secret")
	if err := AtomicWrite(secret, []byte("synthetic-value-never-echo")); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(secret)
	valid := `{"TOKEN":` + string(encoded) + `}`
	tooMany := map[string]string{}
	for i := 0; i < 65; i++ {
		tooMany[fmt.Sprintf("TOKEN%d", i)] = secret
	}
	overCount, _ := json.Marshal(tooMany)
	cases := map[string][]byte{
		"null": []byte("null"), "array": []byte("[]"), "trailing": []byte(valid + " {}"),
		"duplicate":         []byte(`{"TOKEN":` + string(encoded) + `,"TOKEN":` + string(encoded) + `}`),
		"escaped-duplicate": []byte(`{"TOKEN":` + string(encoded) + `,"\u0054OKEN":` + string(encoded) + `}`),
		"null-value":        []byte(`{"TOKEN":null}`), "boolean": []byte(`{"TOKEN":true}`),
		"number": []byte(`{"TOKEN":123}`), "object": []byte(`{"TOKEN":{}}`), "array-value": []byte(`{"TOKEN":[]}`),
		"relative": []byte(`{"TOKEN":"relative-private"}`), "empty-path": []byte(`{"TOKEN":""}`),
		"nul-path": []byte(`{"TOKEN":"\u0000"}`), "bad-name": []byte(`{"9TOKEN":` + string(encoded) + `}`),
		"invalid-utf8": append([]byte(`{"TOKEN":"`), append([]byte{0xff}, []byte(`"}`)...)...),
		"bom":          append([]byte{0xef, 0xbb, 0xbf}, []byte(valid)...), "over-count": overCount,
		"over-size": append([]byte("{}"), bytes.Repeat([]byte(" "), 2*MaxArtifact)...),
	}
	for label, data := range cases {
		t.Run(label, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "bindings.json")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			_, err := ReadSecretBindings(path)
			if err == nil {
				t.Fatal("ambiguous operator input accepted")
			}
			if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "synthetic-value-never-echo") || strings.Contains(err.Error(), "TOKEN") {
				t.Fatal("binding input diagnostic disclosed private input")
			}
		})
	}
	for _, path := range []string{"", "relative.json", t.TempDir(), filepath.Join(t.TempDir(), "absent.json")} {
		if _, err := ReadSecretBindings(path); err == nil {
			t.Fatal("unsafe or absent map accepted")
		}
	}
}

func TestSecretBindingsUnicodeIsLossless(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"caf\u00e9", "replacement-\ufffd", "emoji-\U0001f511"} {
		secret := filepath.Join(dir, name)
		if err := AtomicWrite(secret, []byte("synthetic-placeholder")); err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(secret)
		escaped := strings.ReplaceAll(string(encoded), "\U0001f511", `\ud83d\udd11`)
		escaped = strings.ReplaceAll(escaped, "\ufffd", `\ufffd`)
		for _, token := range []string{string(encoded), escaped} {
			path := filepath.Join(t.TempDir(), "bindings.json")
			if err := os.WriteFile(path, []byte(`{"TOKEN":`+token+`}`), 0600); err != nil {
				t.Fatal(err)
			}
			got, err := ReadSecretBindings(path)
			if err != nil || (*got)["TOKEN"] != secret {
				t.Fatal("valid Unicode path did not round trip", err)
			}
		}
		if strings.Contains(name, "�") {
			for _, escape := range []string{`\ud800`, `\udfff`, `\ud800\u0041`} {
				path := filepath.Join(t.TempDir(), "bindings.json")
				if err := os.WriteFile(path, []byte(`{"TOKEN":`+strings.ReplaceAll(string(encoded), "�", escape)+`}`), 0600); err != nil {
					t.Fatal(err)
				}
				if _, err := ReadSecretBindings(path); err == nil {
					t.Fatal("unpaired surrogate silently selected replacement-character file")
				}
			}
		}
	}
	// Escaped backslashes do not turn literal text into Unicode escapes.
	for _, value := range []string{`"\\ud800"`, `"\ud83d\udd11"`, `"\u0041"`} {
		if !pairedJSONSurrogates([]byte(value)) {
			t.Fatal("valid JSON escape rejected")
		}
	}
}

func TestSecretBindingsNilIsNotAnExplicitClear(t *testing.T) {
	f := maintenanceFixture(t)
	var omitted map[string]string
	for _, operation := range []func() error{
		func() error { return ConfigureSecretFiles(f.dir, nil) },
		func() error {
			return InstallWithOptions(context.Background(), f.dir, InstallOptions{SecretFiles: &omitted})
		},
		func() error {
			return ConfigureSecretFiles(f.dir, map[string]string{"TOKEN": string([]byte{'/', 0xff})})
		},
	} {
		if operation() == nil {
			t.Fatal("ambiguous direct request accepted")
		}
		for path, expected := range f.files {
			actual, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(expected, actual) {
				t.Fatal("rejection changed installed data", err)
			}
		}
	}
}

func TestSecretBindingsReplacementAndExplicitClearPreserveMaintenanceState(t *testing.T) {
	f := maintenanceFixture(t)
	settings := filepath.Join(f.dir, "settings.json")
	before := maintenanceFields(t, settings)
	secret := filepath.Join(privateTempDir(t), "private-synthetic-secret")
	if err := AtomicWrite(secret, []byte("synthetic-placeholder")); err != nil {
		t.Fatal(err)
	}
	for _, bindings := range []map[string]string{{"NEW": secret}, {}} {
		path := filepath.Join(t.TempDir(), "bindings.json")
		if err := WriteJSON(path, bindings); err != nil {
			t.Fatal(err)
		}
		read, err := ReadSecretBindings(path)
		if err != nil || read == nil || *read == nil {
			t.Fatal("explicit bindings rejected", err)
		}
		if err = ConfigureSecretFiles(f.dir, *read); err != nil {
			t.Fatal(err)
		}
		got, err := LoadSettings(f.dir)
		if err != nil || len(got.SecretFiles) != len(bindings) || got.SecretFiles["NEW"] != bindings["NEW"] {
			t.Fatal("bindings did not replace whole map", err)
		}
		after := maintenanceFields(t, settings)
		for key, value := range before {
			if key != "secret_files" && !equalRawJSON(value, after[key]) {
				t.Fatalf("binding update changed unrelated %s", key)
			}
		}
		for path, expected := range f.files {
			if path != settings {
				actual, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(expected, actual) {
					t.Fatal("binding update changed state, identity or workload", err)
				}
			}
		}
		exact, _ := os.ReadFile(settings)
		exact = append([]byte("\n\t"), append(exact, '\n')...)
		if err := os.WriteFile(settings, exact, 0600); err != nil {
			t.Fatal(err)
		}
		if err = ConfigureSecretFiles(f.dir, *read); err != nil {
			t.Fatal(err)
		}
		again, _ := os.ReadFile(settings)
		if !bytes.Equal(exact, again) {
			t.Fatal("same map rewrote original settings bytes")
		}
	}
}
