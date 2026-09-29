package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func secretTemplate(uri string) []byte {
	b, _ := json.Marshal(map[string]any{"sources": map[string]any{"synthetic": map[string]any{"type": "demo_logs", "format": "json", "interval": 0.05}}, "sinks": map[string]any{"out": map[string]any{"type": "http", "inputs": []string{"synthetic"}, "uri": uri, "encoding": map[string]string{"codec": "json"}, "batch": map[string]any{"timeout_secs": 0.1}, "auth": map[string]string{"strategy": "bearer", "token": "vectory-secret:API_TOKEN"}}}})
	return b
}
func secretFixture(t *testing.T) (*Engine, Manifest, *fakeDriver, string) {
	t.Helper()
	e, m, d := fixture(t, secretTemplate("https://sink.example/events"))
	p := filepath.Join(privateTempDir(t), "token")
	if err := AtomicWrite(p, []byte("first-sensitive-token")); err != nil {
		t.Fatal(err)
	}
	e.Settings.SecretFiles = map[string]string{"API_TOKEN": p}
	e.Settings.CapabilityPolicy.AllowedNetworkHosts = []string{"sink.example:443"}
	return e, m, d, p
}
func TestSecretTypedResolutionAndNegativePaths(t *testing.T) {
	p := filepath.Join(privateTempDir(t), "token")
	value := "x\"},\"sources\":{\"evil\":{}}\nline2"
	if err := AtomicWrite(p, []byte(value+"\n")); err != nil {
		t.Fatal(err)
	}
	bindings := map[string]string{"API_TOKEN": p}
	raw := secretTemplate("https://sink.example/events")
	effective, used, err := ResolveLocalSecrets(raw, bindings)
	if err != nil || !used {
		t.Fatal(err)
	}
	var parsed map[string]any
	if json.Unmarshal(effective, &parsed) != nil {
		t.Fatal("typed rendering produced invalid JSON")
	}
	sink := parsed["sinks"].(map[string]any)["out"].(map[string]any)
	if sink["auth"].(map[string]any)["token"] != value || len(parsed["sources"].(map[string]any)) != 1 {
		t.Fatal("typed reference changed JSON structure")
	}
	for _, bad := range []string{
		`{"sinks":{"out":{"type":"console","auth":{"token":"vectory-secret:API_TOKEN"}}}}`,
		`{"sinks":{"out":{"type":"http","uri":"vectory-secret:API_TOKEN"}}}`,
		`{"sinks":{"out":{"type":"http","auth":{"strategy":"vectory-secret:API_TOKEN"}}}}`,
		`{"sinks":{"out":{"type":"http","auth":{"token":"prefix-vectory-secret:API_TOKEN"}}}}`,
		`{"sinks":{"out":{"type":"http","auth":{"token":"vectory-secret:API_TOKEN suffix"}}}}`,
		`{"sinks":{"out":{"type":"http","auth":{"token":"vectory-secret:1BAD"}}}}`,
		`{"sinks":{"out":{"type":"http","auth":{"token":["vectory-secret:API_TOKEN"]}}}}`,
		`{"sources":{"x":{"type":"demo_logs","format":"vectory-secret:API_TOKEN"}}}`,
		`{"sinks":{"out":{"type":"http","auth":{"token":"vectory-secret:MISSING"}}}}`,
	} {
		if _, _, err := ResolveLocalSecrets([]byte(bad), bindings); err == nil {
			t.Fatalf("accepted forbidden reference %s", bad)
		}
	}
	plain := []byte(` {"sources":{},"sinks":{}} `)
	got, used, err := ResolveLocalSecrets(plain, bindings)
	if err != nil || used || !bytes.Equal(got, plain) {
		t.Fatal("ordinary config bytes changed")
	}
	// The fields accepted before the table existed still resolve. Vector 0.58's
	// elasticsearch sink has no bearer token, so it has user and password.
	for _, typ := range []string{"http", "loki", "elasticsearch"} {
		for _, field := range []string{"user", "password", "token"} {
			if typ == "elasticsearch" && field == "token" {
				continue
			}
			raw := []byte(`{"sinks":{"out":{"type":"` + typ + `","auth":{"` + field + `":"vectory-secret:API_TOKEN"},"large":9007199254740993}}}`)
			got, used, err := ResolveLocalSecrets(raw, bindings)
			if err != nil || !used || !bytes.Contains(got, []byte("9007199254740993")) {
				t.Fatal("allowlisted field or exact JSON number lost", err)
			}
		}
	}
}
func TestSecretPrivateFileAndBounds(t *testing.T) {
	for name, value := range map[string][]byte{"empty": {}, "oversized": bytes.Repeat([]byte("x"), MaxSecret+1), "nul": {'x', 0}, "nonutf8": {0xff}} {
		t.Run(name, func(t *testing.T) {
			p := filepath.Join(privateTempDir(t), "token")
			if err := AtomicWrite(p, value); err != nil {
				t.Fatal(err)
			}
			if _, err := readLocalSecret(p); err == nil {
				t.Fatal("unsafe secret accepted")
			}
		})
	}
	p := filepath.Join(privateTempDir(t), "token")
	if err := AtomicWrite(p, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	if _, err := readLocalSecret(p); err != nil {
		t.Fatal("private file rejected", err)
	}
	t.Run("hardlink", func(t *testing.T) {
		other := filepath.Join(filepath.Dir(p), "alias")
		if err := os.Link(p, other); err != nil {
			t.Skip(err)
		}
		defer os.Remove(other)
		if _, err := readLocalSecret(other); err == nil {
			t.Fatal("hardlinked private file accepted")
		}
	})
	t.Run("symlink", func(t *testing.T) {
		other := filepath.Join(filepath.Dir(p), "link")
		if err := os.Symlink(p, other); err != nil {
			t.Skip(err)
		}
		defer os.Remove(other)
		if _, err := readLocalSecret(other); err == nil {
			t.Fatal("symlinked private file accepted")
		}
	})
	if runtime.GOOS != "windows" {
		if err := os.Chmod(p, 0640); err != nil {
			t.Fatal(err)
		}
		if _, err := readLocalSecret(p); err == nil {
			t.Fatal("group-readable secret accepted")
		}
	}
}
func TestSecretRotationSameGenerationRollbackAndCorrection(t *testing.T) {
	e, m, d, p := secretFixture(t)
	ctx := context.Background()
	if err := e.Reconcile(ctx, m); err != nil {
		t.Fatal(err)
	}
	first := e.actual()
	if first == m.Desired.SHA256 || e.State.AppliedTemplateSHA256 != m.Desired.SHA256 || e.State.SecretRevision != 1 || e.State.AppliedSecretRevision != 1 {
		t.Fatal("template/effective state mismatch")
	}
	if err := e.Reconcile(ctx, m); err != nil || d.starts != 1 {
		t.Fatal("unchanged secret restarted", err)
	}
	if err := AtomicWrite(p, []byte("second-sensitive-token")); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(ctx, m); err != nil {
		t.Fatal(err)
	}
	second := e.actual()
	if second == first || d.starts != 2 || e.State.SecretRevision != 2 || e.State.ReportedGeneration != m.Generation {
		t.Fatal("same-generation rotation did not activate")
	}
	if err := AtomicWrite(p, []byte("rejected-sensitive-token")); err != nil {
		t.Fatal(err)
	}
	d.failNext = true
	if err := e.Reconcile(ctx, m); err != nil {
		t.Fatal(err)
	}
	if e.actual() != second || e.State.SecretRevision != 3 || e.State.AppliedSecretRevision != 2 || e.State.ApplyState != "rolled_back" {
		t.Fatal("rollback lost revision distinction")
	}
	starts := d.starts
	if err := e.Reconcile(ctx, m); err != nil || d.starts != starts {
		t.Fatal("failed effective revision was retried", err)
	}
	if err := AtomicWrite(p, []byte("corrected-sensitive-token")); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(ctx, m); err != nil {
		t.Fatal(err)
	}
	if e.State.ApplyState != "verified_applied" || e.State.SecretRevision != 4 || e.State.AppliedSecretRevision != 4 || d.starts != starts+1 {
		t.Fatal("corrected same generation blocked")
	}
	files, err := filepath.Glob(filepath.Join(e.Dir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if err = checkPrivateFile(file); err != nil {
			t.Fatal("effective config/backup/state permissions weak", filepath.Base(file), err)
		}
	}
}
func TestSecretRotationCrashBoundaries(t *testing.T) {
	for _, stage := range []string{"validated", "prepared", "written", "reload_requested", "activated", "verified"} {
		t.Run(stage, func(t *testing.T) {
			e, m, _, p := secretFixture(t)
			ctx := context.Background()
			if err := e.Reconcile(ctx, m); err != nil {
				t.Fatal(err)
			}
			first := e.actual()
			if err := AtomicWrite(p, []byte("rotated-sensitive-token")); err != nil {
				t.Fatal(err)
			}
			e.Fault = func(at string) error {
				if at == stage {
					return errors.New("simulated crash")
				}
				return nil
			}
			if err := e.Reconcile(ctx, m); err == nil {
				t.Fatal("fault did not fire")
			}
			st, err := LoadState(e.Dir)
			if err != nil {
				t.Fatal(err)
			}
			if st.SecretRevision != 2 {
				t.Fatal("attempt revision was not durable before failure")
			}
			recovered := &Engine{Dir: e.Dir, Settings: e.Settings, State: st, Driver: &fakeDriver{}}
			if err = recovered.Recover(ctx); err != nil {
				t.Fatal(err)
			}
			if err = recovered.StartExisting(ctx); err != nil {
				t.Fatal(err)
			}
			if stage == "verified" {
				if recovered.actual() == first || recovered.State.AppliedSecretRevision != 2 {
					t.Fatal("committed secret rotation rolled back")
				}
			} else {
				if recovered.actual() != first || recovered.State.AppliedSecretRevision != 1 || recovered.State.ApplyState == "verified_applied" {
					t.Fatal("incomplete secret rotation falsely acknowledged")
				}
			}
			if recovered.State.SecretRevision != 2 {
				t.Fatal("crash recovery rolled back monotonic attempt counter")
			}
		})
	}
}

type secretLeakingDriver struct {
	fakeDriver
	leak string
}

func (d *secretLeakingDriver) Validate(context.Context, string) error { return errors.New(d.leak) }
func TestSecretDiagnosticsNeverExposeValues(t *testing.T) {
	e, m, _, p := secretFixture(t)
	leak := "unique-plaintext-never-export"
	if err := AtomicWrite(p, []byte(leak)); err != nil {
		t.Fatal(err)
	}
	e.Driver = &secretLeakingDriver{leak: leak}
	err := e.Reconcile(context.Background(), m)
	if err == nil || strings.Contains(err.Error(), leak) {
		t.Fatal("secret leaked in validation error")
	}
	if err = WriteJSON(filepath.Join(e.Dir, "settings.json"), e.Settings); err != nil {
		t.Fatal(err)
	}
	status, err := StateSummary(e.Dir)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(status)
	if bytes.Contains(out, []byte(leak)) {
		t.Fatal("secret leaked in status")
	}
	for _, file := range []string{"state.json", "template-" + m.Desired.SHA256 + ".json"} {
		b, err := os.ReadFile(filepath.Join(e.Dir, file))
		if err != nil || bytes.Contains(b, []byte(leak)) {
			t.Fatal("secret leaked to metadata or template", file, err)
		}
	}
	var heartbeat []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		heartbeat, _ = io.ReadAll(r.Body)
		http.Error(w, "fixture no manifest", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	e.Client = &Client{HTTP: srv.Client(), Base: srv.URL}
	_ = e.Poll(context.Background())
	if len(heartbeat) == 0 || bytes.Contains(heartbeat, []byte(leak)) || bytes.Contains(heartbeat, []byte("first-sensitive-token")) {
		t.Fatal("secret leaked in heartbeat payload")
	}
	if err := AtomicWrite(p, []byte("${SECRET_EXFILTRATION}")); err != nil {
		t.Fatal(err)
	}
	e.Driver = &fakeDriver{}
	if err = e.Reconcile(context.Background(), m); err == nil || e.State.Error.Code != "CAPABILITY_DENIED" {
		t.Fatal("effective capabilities were not rechecked")
	}
}
func TestNativeVectorLocalSecretRotation(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for native secret rotation integration")
	}
	observed := make(chan string, 1024)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		if r.Method == "POST" {
			select {
			case observed <- r.Header.Get("Authorization"):
			default:
			}
		}
		w.WriteHeader(200)
	}))
	defer receiver.Close()
	raw := secretTemplate(receiver.URL + "/events")
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	doc["data_dir"] = dataDir
	raw, _ = json.Marshal(doc)
	e, m, _, p := secretFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(raw) }))
	defer server.Close()
	e.Client = &Client{HTTP: server.Client(), Base: server.URL}
	m.Desired = &Desired{VersionID: "native-secret", SHA256: Digest(raw), Size: int64(len(raw)), ArtifactPath: "/agent/v1/artifacts/" + Digest(raw), VectorVersion: VectorVersion}
	e.State.Desired = m.Desired
	e.Settings.VectorBinary = binary
	e.Settings.VectorBinarySHA256, _ = FileDigest(binary)
	e.Settings.ValidationSeconds = 30
	e.Settings.StartupSeconds = 20
	e.Settings.CapabilityPolicy.AllowedFileRoots = []string{dataDir}
	u, _ := url.Parse(receiver.URL)
	e.Settings.CapabilityPolicy.AllowedNetworkHosts = []string{u.Host}
	driver := &VectorDriver{Settings: e.Settings}
	e.Driver = driver
	defer driver.Stop()
	waitHeader := func(want string) {
		t.Helper()
		timeout := time.NewTimer(5 * time.Second)
		defer timeout.Stop()
		for {
			select {
			case got := <-observed:
				if got == want {
					return
				}
			case <-timeout.C:
				t.Fatal("real Vector did not emit the locally resolved Authorization header")
			}
		}
	}
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if e.State.ApplyState != "verified_applied" || !driver.Alive() {
		t.Fatal("native secret activation unverified")
	}
	waitHeader("Bearer first-sensitive-token")
	first := e.actual()
	if err := AtomicWrite(p, []byte("second-native-sensitive-token")); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	waitHeader("Bearer second-native-sensitive-token")
	if e.actual() == first || e.State.SecretRevision != 2 || e.State.ReportedGeneration != m.Generation || e.State.AppliedTemplateSHA256 != m.Desired.SHA256 {
		t.Fatal("native same-generation secret rotation not verified")
	}
}
