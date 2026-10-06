package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func enrolledTrustFixture(t *testing.T, server string) (string, map[string]json.RawMessage, []byte, []byte) {
	t.Helper()
	f := maintenanceFixture(t)
	path := filepath.Join(f.dir, "settings.json")
	fields := maintenanceFields(t, path)
	fields["server"], _ = json.Marshal(server)
	updated, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, updated, 0600); err != nil {
		t.Fatal(err)
	}
	if err := StoreIdentity(f.dir, Credentials{DeviceID: "preserved-device"}, []byte("preserved-private-key")); err != nil {
		t.Fatal(err)
	}
	identity, err := os.ReadFile(filepath.Join(f.dir, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	state, err := os.ReadFile(filepath.Join(f.dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	return f.dir, fields, identity, state
}

func assertTrustOnlyChanged(t *testing.T, dir string, before map[string]json.RawMessage, identity, state []byte) string {
	t.Helper()
	after := maintenanceFields(t, filepath.Join(dir, "settings.json"))
	caPath := ""
	if err := json.Unmarshal(after["ca_file"], &caPath); err != nil {
		t.Fatal(err)
	}
	delete(before, "ca_file")
	delete(after, "ca_file")
	if len(before) != len(after) {
		t.Fatalf("trust repair changed the number of other settings: before %d, after %d", len(before), len(after))
	}
	for name, prior := range before {
		if !equalRawJSON(prior, after[name]) {
			t.Fatalf("trust repair changed setting %q: before %s, after %s", name, prior, after[name])
		}
	}
	gotIdentity, err := os.ReadFile(filepath.Join(dir, "identity.json"))
	if err != nil || !bytes.Equal(gotIdentity, identity) {
		t.Fatal("trust repair changed identity", err)
	}
	gotState, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil || !bytes.Equal(gotState, state) {
		t.Fatal("trust repair changed state, including counters or pause", err)
	}
	return caPath
}

func TestTrustServerRotatesPinnedCAWithoutChangingIdentityOrOtherSettings(t *testing.T) {
	old := makeCA(t)
	rotated := makeCA(t)
	var requests atomic.Int32
	server := chainServer(t, rotated, nil, false, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))
	dir, before, identity, state := enrolledTrustFixture(t, server.URL)
	oldPath := filepath.Join(dir, ServerCAFile)
	if err := AtomicWrite(oldPath, []byte(old.pem)); err != nil {
		t.Fatal(err)
	}
	settings := maintenanceFields(t, filepath.Join(dir, "settings.json"))
	settings["ca_file"], _ = json.Marshal(oldPath)
	settingsBytes, _ := json.Marshal(settings)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), settingsBytes, 0600); err != nil {
		t.Fatal(err)
	}
	before["ca_file"], _ = json.Marshal(oldPath)

	result, err := TrustServer(context.Background(), dir, TrustServerOptions{Server: server.URL, CASHA256: fingerprint(rotated.cert)})
	if err != nil || result.Trust != "pinned CA" {
		t.Fatal("verified rotation failed", result, err)
	}
	if requests.Load() != 0 {
		t.Fatal("fingerprint probe sent an HTTP request")
	}
	newPath := assertTrustOnlyChanged(t, dir, before, identity, state)
	if newPath == oldPath || !strings.HasPrefix(filepath.Base(newPath), "server-ca-") {
		t.Fatalf("CA was not saved as a separate private snapshot: %q", newPath)
	}
	newCA, err := os.ReadFile(newPath)
	if err != nil || !bytes.Equal(newCA, PinnedCAPEM(rotated.cert)) {
		t.Fatal("saved CA does not match verified fingerprint", err)
	}
	if err := ProbeServer(context.Background(), server.URL, newPath); err != nil {
		t.Fatal("new trust does not connect to enrolled address", err)
	}
}

func TestTrustServerCopiesAndVerifiesSuppliedCA(t *testing.T) {
	ca := makeCA(t)
	var requests atomic.Int32
	server := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	dir, before, identity, state := enrolledTrustFixture(t, server.URL)
	file := filepath.Join(privateTempDir(t), "operator-ca.pem")
	if err := AtomicWrite(file, []byte(ca.pem)); err != nil {
		t.Fatal(err)
	}
	result, err := TrustServer(context.Background(), dir, TrustServerOptions{Server: server.URL, CAFile: &file})
	if err != nil || result.Trust != "supplied CA file" {
		t.Fatal("CA file repair failed", result, err)
	}
	if requests.Load() != 1 {
		t.Fatal("candidate was not probed at the saved address")
	}
	path := assertTrustOnlyChanged(t, dir, before, identity, state)
	if path == file {
		t.Fatal("settings still depend on a mutable operator file")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, []byte(ca.pem)) {
		t.Fatal("copied CA bytes differ", err)
	}
	if err := AtomicWrite(file, []byte(makeCA(t).pem)); err != nil {
		t.Fatal(err)
	}
	if err := ProbeServer(context.Background(), server.URL, path); err != nil {
		t.Fatal("changing the operator file changed active trust", err)
	}
}

func TestTrustServerRejectsAmbiguousAddressWrongTrustAndRunningAgentWithoutChangingSettings(t *testing.T) {
	ca := makeCA(t)
	var requests atomic.Int32
	server := trustedServer(t, ca, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))
	dir, _, identity, state := enrolledTrustFixture(t, server.URL)
	settingsPath := filepath.Join(dir, "settings.json")
	before, _ := os.ReadFile(settingsPath)
	badCA := makeCA(t)
	file := filepath.Join(privateTempDir(t), "wrong-ca.pem")
	if err := AtomicWrite(file, []byte(badCA.pem)); err != nil {
		t.Fatal(err)
	}
	systemRoots := ""
	for _, tc := range []struct {
		name   string
		choice TrustServerOptions
	}{
		{"missing address", TrustServerOptions{CAFile: &file}},
		{"other server", TrustServerOptions{Server: "https://other.example.invalid", CAFile: &file}},
		{"same origin but ambiguous spelling", TrustServerOptions{Server: server.URL + "/", CAFile: &file}},
		{"wrong pin", TrustServerOptions{Server: server.URL, CASHA256: fingerprint(badCA.cert)}},
		{"wrong CA file", TrustServerOptions{Server: server.URL, CAFile: &file}},
		{"untrusted system roots", TrustServerOptions{Server: server.URL, CAFile: &systemRoots}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := TrustServer(context.Background(), dir, tc.choice); err == nil {
				t.Fatal("unverified or ambiguous repair accepted")
			}
			after, _ := os.ReadFile(settingsPath)
			if !bytes.Equal(before, after) {
				t.Fatal("refused repair changed settings")
			}
			paths, err := filepath.Glob(filepath.Join(dir, "server-ca-*.pem"))
			if err != nil || len(paths) != 0 {
				t.Fatalf("refused repair left a candidate CA behind: %v, %v", paths, err)
			}
		})
	}
	if requests.Load() != 0 {
		t.Fatal("wrong CA reached an HTTP handler")
	}
	gotIdentity, _ := os.ReadFile(filepath.Join(dir, "identity.json"))
	gotState, _ := os.ReadFile(filepath.Join(dir, "state.json"))
	if !bytes.Equal(gotIdentity, identity) || !bytes.Equal(gotState, state) {
		t.Fatal("refused repair changed identity or state")
	}
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, err := TrustServer(context.Background(), dir, TrustServerOptions{Server: server.URL, CAFile: &file}); err == nil {
		t.Fatal("repair bypassed maintenance lock")
	}
}

func TestTrustServerNeverCopiesAPrivateKeyFromOperatorCAFile(t *testing.T) {
	ca := makeCA(t)
	server := trustedServer(t, ca, http.NotFoundHandler())
	for name, contents := range map[string][]byte{
		"private key":   append([]byte(ca.pem), privatePEM(t, ca.key)...),
		"trailing junk": append([]byte(ca.pem), []byte("untrusted trailing data")...),
		"leading junk":  append([]byte("untrusted leading data\n"), []byte(ca.pem)...),
	} {
		t.Run(name, func(t *testing.T) {
			dir, _, _, _ := enrolledTrustFixture(t, server.URL)
			settingsPath := filepath.Join(dir, "settings.json")
			before, _ := os.ReadFile(settingsPath)
			file := filepath.Join(privateTempDir(t), "unsafe-ca.pem")
			if err := AtomicWrite(file, contents); err != nil {
				t.Fatal(err)
			}
			if _, err := TrustServer(context.Background(), dir, TrustServerOptions{Server: server.URL, CAFile: &file}); err == nil || !strings.Contains(err.Error(), "private keys") {
				t.Fatalf("CA file containing noncertificate content was not refused: %v", err)
			}
			after, _ := os.ReadFile(settingsPath)
			if !bytes.Equal(before, after) {
				t.Fatal("refused secret-bearing CA file changed settings")
			}
			paths, err := filepath.Glob(filepath.Join(dir, "server-ca-*.pem"))
			if err != nil || len(paths) != 0 {
				t.Fatalf("refused CA was staged: %v, %v", paths, err)
			}
		})
	}
}
