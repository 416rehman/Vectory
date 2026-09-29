package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFullVectorModeIsLocalAndExplicit(t *testing.T) {
	full := CapabilityPolicy{FullVectorConfig: true}
	if (CapabilityPolicy{}).ConfigurationMode() != "restricted" || full.ConfigurationMode() != "full" {
		t.Fatal("incorrect mode defaults")
	}
	for _, config := range []string{
		`{"sources":{"host":{"type":"host_metrics"}},"sinks":{"out":{"type":"blackhole","inputs":["host"]}}}`,
		`{"sources":{"commands":{"type":"exec","command":["host-approved-command"]}}}`,
		`{"secret":{"local":{"type":"file","path":"/host/secret.json"}}}`,
		`{"enrichment_tables":{"hosts":{"type":"file","file":{"path":"/host/hosts.csv","encoding":{"type":"csv"}}}}}`,
		`{"tests":[{"name":"pipeline assertion"}],"schema":{"enabled":true}}`,
		`{"transforms":{"env":{"type":"remap","inputs":["demo"],"source":".value = \"${HOST_VALUE}\""}}}`,
	} {
		if (CapabilityPolicy{}).Check([]byte(config)) == nil {
			t.Fatal("restricted mode accepted a full-mode capability")
		}
		if err := full.Check([]byte(config)); err != nil {
			t.Fatal("local full mode did not defer capability validation to Vector", err)
		}
	}
	for _, invalid := range []string{"null", "[]", "{", "{} {}"} {
		if full.Check([]byte(invalid)) == nil {
			t.Fatal("full mode accepted invalid JSON document")
		}
	}
	if _, _, err := ResolveLocalSecrets([]byte(`{"transforms":{"bad":{"type":"remap","source":"vectory-secret:KEY"}}}`), nil); err == nil {
		t.Fatal("native full mode must not broaden Vectory-specific secret references")
	}
	dir := t.TempDir()
	settings := Settings{VectorBinary: "fixed-vector", ManagedConfig: "fixed-config", CapabilityPolicy: CapabilityPolicy{AllowedNetworkHosts: []string{"example.test:443"}}}
	if err := WriteJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	generation := uint64(42)
	if err := SaveState(dir, State{HighestGeneration: generation, HighestPolicyGeneration: 31, SecretRevision: 8, FailedGeneration: &generation, FailedEffectiveSHA256: "failed-content"}); err != nil {
		t.Fatal(err)
	}
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if ConfigureFullVector(dir, true) == nil {
		t.Fatal("changed local trust while daemon lock was held")
	}
	unlock()
	for _, enabled := range []bool{true, true, false} {
		if err := ConfigureFullVector(dir, enabled); err != nil {
			t.Fatal(err)
		}
		got, err := LoadSettings(dir)
		if err != nil || got.CapabilityPolicy.FullVectorConfig != enabled || got.VectorBinary != settings.VectorBinary || got.ManagedConfig != settings.ManagedConfig || len(got.CapabilityPolicy.AllowedNetworkHosts) != 1 {
			t.Fatal("mode transition lost protected local settings", err)
		}
		st, err := LoadState(dir)
		if err != nil || st.HighestGeneration != 42 || st.HighestPolicyGeneration != 31 || st.SecretRevision != 8 || st.FailedGeneration != nil || st.FailedEffectiveSHA256 != "" {
			t.Fatal("mode transition failed to preserve security counters or clear old rejection", err)
		}
	}
}

func TestFullVectorEnvironmentAndFixedArguments(t *testing.T) {
	t.Setenv("VECTORY_TEST_NATIVE_VALUE", "host-authorized-value")
	t.Setenv("VECTOR_CONFIG", "unmanaged.json")
	t.Setenv("VECTOR_CONFIG_DIR", "unmanaged-dir")
	t.Setenv("VECTOR_LOG", "off")
	t.Setenv("VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION", "true")
	for _, full := range []bool{false, true} {
		env := strings.Join(vectorEnvironment(full), "\n")
		if strings.Contains(env, "VECTORY_TEST_NATIVE_VALUE=") != full {
			t.Fatal("native environment must require the explicit local grant")
		}
		for _, key := range []string{"VECTOR_CONFIG=", "VECTOR_CONFIG_DIR=", "VECTOR_LOG=", "VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION="} {
			if strings.Contains(env, key) {
				t.Fatal("environment replaced owned launch controls")
			}
		}
		for _, command := range []string{"", "validate", "test"} {
			args := vectorConfigArgs(command, "a file; never a shell.json", full)
			if strings.Contains(strings.Join(args, "|"), "--dangerously-allow-env-var-interpolation") != full {
				t.Fatal("native interpolation flag differs from local grant")
			}
			if command == "" && args[0] != "--config-json" || command != "" && args[0] != command {
				t.Fatal("unexpected native command")
			}
		}
	}
}

func TestFullVectorLocalCredentialRemainsLiteral(t *testing.T) {
	path := filepath.Join(t.TempDir(), "local-credential")
	for _, value := range []string{"${HOST_SECRET}", "$HOST_SECRET", "price$$change", "SECRET[native.value]"} {
		if err := AtomicWrite(path, []byte(value)); err != nil {
			t.Fatal(err)
		}
		_, _, err := resolveLocalSecrets(secretTemplate("https://example.test/events"), map[string]string{"API_TOKEN": path}, true)
		if err == nil || strings.Contains(err.Error(), value) {
			t.Fatal("materialized plaintext could be reinterpreted or leaked", err)
		}
	}
	const value = "literal-safe-credential"
	if err := AtomicWrite(path, []byte(value)); err != nil {
		t.Fatal(err)
	}
	got, used, err := resolveLocalSecrets(secretTemplate("https://example.test/events"), map[string]string{"API_TOKEN": path}, true)
	if err != nil || !used || !strings.Contains(string(got), value) {
		t.Fatal("literal credential could not be materialized in full mode", err)
	}
}

func TestFullVectorHeartbeatCannotChangeLocalMode(t *testing.T) {
	for _, full := range []bool{false, true} {
		t.Run((CapabilityPolicy{FullVectorConfig: full}).ConfigurationMode(), func(t *testing.T) {
			pub, key, _ := ed25519.GenerateKey(rand.Reader)
			var captured Heartbeat
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if json.NewDecoder(r.Body).Decode(&captured) != nil {
					http.Error(w, "invalid", 400)
					return
				}
				manifest := sampleManifest()
				manifest.Nonce = captured.Nonce
				manifest.Desired = nil
				b, _ := json.Marshal(manifest)
				var hostile map[string]any
				_ = json.Unmarshal(b, &hostile)
				hostile["configuration_mode"] = (CapabilityPolicy{FullVectorConfig: !full}).ConfigurationMode()
				hostile["policy"].(map[string]any)["full_vector_config"] = !full
				b, _ = json.Marshal(hostile)
				_ = json.NewEncoder(w).Encode(Envelope{base64.StdEncoding.EncodeToString(b), base64.StdEncoding.EncodeToString(ed25519.Sign(key, b))})
			}))
			defer srv.Close()
			e := &Engine{Dir: t.TempDir(), Settings: Settings{CapabilityPolicy: CapabilityPolicy{FullVectorConfig: full}}, Driver: &fakeDriver{}, Client: &Client{HTTP: srv.Client(), Base: srv.URL}, Credentials: Credentials{DeviceID: "device-a", SigningPublicKey: base64.StdEncoding.EncodeToString(pub)}}
			_ = e.Poll(context.Background()) // rejecting unknown fields is also safe
			if captured.ConfigurationMode != e.Settings.CapabilityPolicy.ConfigurationMode() || e.Settings.CapabilityPolicy.FullVectorConfig != full {
				t.Fatal("signed remote policy changed host-owned trust mode or heartbeat misreported it")
			}
		})
	}
}

func TestFullVectorEnrollmentReportsLocalMode(t *testing.T) {
	for _, full := range []bool{false, true} {
		t.Run((CapabilityPolicy{FullVectorConfig: full}).ConfigurationMode(), func(t *testing.T) {
			dir := t.TempDir()
			ca := makeCA(t)
			pub, _, _ := ed25519.GenerateKey(rand.Reader)
			var mode string
			srv := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req Enrollment
				if json.NewDecoder(r.Body).Decode(&req) != nil {
					http.Error(w, "invalid", 400)
					return
				}
				mode = req.ConfigurationMode
				block, _ := pem.Decode([]byte(req.CSRPEM))
				csr, err := x509.ParseCertificateRequest(block.Bytes)
				if err != nil || csr.CheckSignature() != nil {
					http.Error(w, "invalid", 400)
					return
				}
				expires := time.Now().Add(48 * time.Hour).Truncate(time.Second)
				_ = json.NewEncoder(w).Encode(Credentials{DeviceID: "device-full-test", CertificatePEM: ca.issue(t, csr.PublicKey, "device-full-test", false, expires), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(pub), CertificateExpiresAt: expires})
			}))
			caFile := filepath.Join(dir, "server-ca.pem")
			if err := AtomicWrite(caFile, []byte(ca.pem)); err != nil {
				t.Fatal(err)
			}
			settings := Settings{Server: srv.URL, CAFile: caFile, Name: "full-mode-fixture", CapabilityPolicy: CapabilityPolicy{FullVectorConfig: full}}
			if err := Enroll(context.Background(), dir, settings, "one-use-fixture-token"); err != nil {
				t.Fatal(err)
			}
			if mode != settings.CapabilityPolicy.ConfigurationMode() {
				t.Fatal("trusted enrollment did not report locally selected mode")
			}
		})
	}
}

func TestNativeFullVectorConfigurationAndTests(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("VECTOR_TEST_BINARY is required for real native validation and activation")
	}
	dir := t.TempDir()
	if err := PrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	csvPath := filepath.Join(dir, "hosts.csv")
	secretPath := filepath.Join(dir, "native-secret.json")
	outputPath := filepath.Join(dir, "events.json")
	const secret = "native-provider-sensitive-fixture-value"
	const environment = "native-environment-fixture-value"
	t.Setenv("VECTORY_TEST_FULL_VALUE", environment)
	for path, data := range map[string][]byte{csvPath: []byte("hostname,owner\ntest,review-owner\n"), secretPath: []byte(`{"marker":"` + secret + `"}`)} {
		if err := AtomicWrite(path, data); err != nil {
			t.Fatal(err)
		}
	}
	config := map[string]any{
		"data_dir":          dir,
		"secret":            map[string]any{"fixture": map[string]any{"type": "file", "path": secretPath}},
		"enrichment_tables": map[string]any{"hosts": map[string]any{"type": "file", "file": map[string]any{"path": csvPath, "encoding": map[string]any{"type": "csv"}}}},
		"sources":           map[string]any{"demo": map[string]any{"type": "demo_logs", "format": "json", "interval": 0.05}, "host": map[string]any{"type": "host_metrics", "collectors": []string{"cpu"}, "scrape_interval_secs": 1}},
		"transforms":        map[string]any{"enrich": map[string]any{"type": "remap", "inputs": []string{"demo"}, "source": ".enriched = get_enrichment_table_record!(\"hosts\", {\"hostname\":\"test\"}).owner\n.secret_value = \"SECRET[fixture.marker]\"\n.env_value = \"${VECTORY_TEST_FULL_VALUE}\""}},
		"sinks":             map[string]any{"out": map[string]any{"type": "file", "inputs": []string{"enrich"}, "path": outputPath, "encoding": map[string]any{"codec": "json"}}, "discard": map[string]any{"type": "blackhole", "inputs": []string{"host"}}},
		"tests":             []any{map[string]any{"name": "native enrichment and credentials", "inputs": []any{map[string]any{"insert_at": "enrich", "type": "log", "log_fields": map[string]any{"message": "isolated fixture"}}}, "outputs": []any{map[string]any{"extract_from": "enrich", "conditions": []string{`.enriched == "review-owner" && .env_value == "${VECTORY_TEST_FULL_VALUE}" && .secret_value == "SECRET[fixture.marker]"`}}}}},
	}
	data, _ := json.Marshal(config)
	e, manifest, _ := fixture(t, data)
	e.Settings.VectorBinary = binary
	var err error
	e.Settings.VectorBinarySHA256, err = FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	e.Settings.CapabilityPolicy.FullVectorConfig = true
	e.Settings.ValidationSeconds = 30
	e.Settings.StartupSeconds = 20
	driver := &VectorDriver{Settings: e.Settings}
	e.Driver = driver
	t.Cleanup(func() { _ = driver.Stop() })
	if err := e.Reconcile(context.Background(), manifest); err != nil {
		t.Fatal("native full configuration failed", err)
	}
	if e.State.ApplyState != "verified_applied" || !driver.Alive() || e.actual() != Digest(data) {
		t.Fatal("full configuration did not reach observed activation")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		observed, _ := os.ReadFile(outputPath)
		if strings.Contains(string(observed), secret) && strings.Contains(string(observed), environment) && strings.Contains(string(observed), "review-owner") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native output did not demonstrate enrichment, environment and native file provider resolution")
		}
		time.Sleep(50 * time.Millisecond)
	}
	stateJSON, _ := json.Marshal(e.State)
	if strings.Contains(string(stateJSON), secret) || strings.Contains(string(stateJSON), environment) {
		t.Fatal("resolved native credentials leaked into state")
	}
	// A valid topology whose unit test fails must be rejected before replacing
	// the current file or stopping the already verified owned process.
	config["tests"].([]any)[0].(map[string]any)["outputs"].([]any)[0].(map[string]any)["conditions"] = []string{`.secret_value == "intentionally incorrect expected value"`}
	failed, _ := json.Marshal(config)
	stage := filepath.Join(e.Dir, "failing-native-test.json")
	if err := AtomicWrite(stage, failed); err != nil {
		t.Fatal(err)
	}
	if err := driver.Validate(context.Background(), stage); err == nil || !strings.Contains(err.Error(), "configuration tests failed") || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), environment) {
		t.Fatal("native failing unit test was not safely rejected", err)
	}
	failureServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(failed) }))
	defer failureServer.Close()
	e.Client = &Client{HTTP: failureServer.Client(), Base: failureServer.URL}
	manifest.Generation++
	manifest.Desired = &Desired{VersionID: "failing-native-tests", SHA256: Digest(failed), Size: int64(len(failed)), ArtifactPath: "/agent/v1/artifacts/" + Digest(failed), VectorVersion: VectorVersion}
	if err := e.Reconcile(context.Background(), manifest); err == nil {
		t.Fatal("native failed test did not reject apply")
	}
	if e.actual() != Digest(data) || !driver.Alive() || e.State.LastGoodSHA256 != Digest(data) || e.State.ReportedGeneration != 2 {
		t.Fatal("failed unit test changed the current verified workload")
	}
	stateJSON, _ = json.Marshal(e.State)
	if strings.Contains(string(stateJSON), secret) || strings.Contains(string(stateJSON), environment) {
		t.Fatal("failed-test diagnostics leaked native credentials")
	}
}
