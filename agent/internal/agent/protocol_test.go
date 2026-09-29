package agent

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "__vector-host" {
		os.Exit(VectorHostMain(os.Args[2:]))
	}
	hermeticTestEnvironment()
	os.Exit(m.Run())
}

// hermeticTestEnvironment makes t.TempDir() return canonical paths (on macOS
// the temporary directory lives under the /var -> /private/var symlink, which
// strict path checks rightly refuse) and keeps proxy settings of the machine
// running the tests out of network classification tests.
func hermeticTestEnvironment() {
	if runtime.GOOS != "windows" {
		if dir, err := filepath.EvalSymlinks(os.TempDir()); err == nil {
			_ = os.Setenv("TMPDIR", dir)
		}
	}
	for _, name := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		_ = os.Unsetenv(name)
	}
}
func signed(t *testing.T, m Manifest, key ed25519.PrivateKey) Envelope {
	t.Helper()
	b, e := json.Marshal(m)
	if e != nil {
		t.Fatal(e)
	}
	return Envelope{base64.StdEncoding.EncodeToString(b), base64.StdEncoding.EncodeToString(ed25519.Sign(key, b))}
}
func sampleManifest() Manifest {
	now := time.Now().UTC().Truncate(time.Second)
	h := Digest([]byte(`{"sources":{}}`))
	return Manifest{ProtocolVersion: 1, DeviceID: "device-a", Nonce: "nonce", IssuedAt: now, ExpiresAt: now.Add(5 * time.Minute), Generation: 2, PolicyGeneration: 3, Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}, Desired: &Desired{VersionID: "v2", SHA256: h, Size: 14, ArtifactPath: "/agent/v1/artifacts/" + h, VectorVersion: VectorVersion}}
}
func TestManifestSecurity(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	trust := base64.StdEncoding.EncodeToString(pub)
	good := sampleManifest()
	st := State{Accepted: true, HighestGeneration: 2, HighestPolicyGeneration: 3, DesiredIdentity: Identity(good.Desired), PolicyIdentity: Identity(good.Policy)}
	if _, e := VerifyEnvelope(signed(t, good, key), trust, "device-a", "nonce", good.IssuedAt, st); e != nil {
		t.Fatal(e)
	}
	cases := map[string]func(*Manifest){"recipient": func(m *Manifest) { m.DeviceID = "device-b" }, "nonce": func(m *Manifest) { m.Nonce = "other" }, "protocol": func(m *Manifest) { m.ProtocolVersion = 2 }, "expired": func(m *Manifest) {
		m.IssuedAt = m.IssuedAt.Add(-10 * time.Minute)
		m.ExpiresAt = m.ExpiresAt.Add(-10 * time.Minute)
	}, "future": func(m *Manifest) { m.IssuedAt = m.IssuedAt.Add(2 * time.Minute) }, "long_validity": func(m *Manifest) { m.ExpiresAt = m.ExpiresAt.Add(time.Minute) }, "stale_config": func(m *Manifest) { m.Generation = 1 }, "stale_policy": func(m *Manifest) { m.PolicyGeneration = 2 }, "same_generation_content": func(m *Manifest) { m.Desired.VersionID = "changed" }, "same_generation_policy": func(m *Manifest) { m.Policy.SyncPaused = true }, "external_artifact": func(m *Manifest) { m.Desired.ArtifactPath = "https://evil.example/config" }, "traversal": func(m *Manifest) { m.Desired.ArtifactPath = "/agent/v1/artifacts/../secrets" }, "oversize": func(m *Manifest) { m.Desired.Size = MaxArtifact + 1 }, "negative_size": func(m *Manifest) { m.Desired.Size = -1 }, "policy_bounds": func(m *Manifest) { m.Policy.HeartbeatSeconds = 0 }}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			m := good
			d := *good.Desired
			m.Desired = &d
			change(&m)
			if _, e := VerifyEnvelope(signed(t, m, key), trust, "device-a", "nonce", good.IssuedAt, st); e == nil {
				t.Fatal("hostile manifest accepted")
			}
		})
	}
	t.Run("bad_signature", func(t *testing.T) {
		env := signed(t, good, key)
		env.Signature = base64.StdEncoding.EncodeToString(make([]byte, 64))
		if _, e := VerifyEnvelope(env, trust, "device-a", "nonce", good.IssuedAt, st); e == nil {
			t.Fatal("signature accepted")
		}
	})
	t.Run("explicit_rollback_new_generation", func(t *testing.T) {
		m := good
		d := *m.Desired
		m.Desired = &d
		m.Generation = 4
		m.Desired.VersionID = "old-version"
		if _, e := VerifyEnvelope(signed(t, m, key), trust, "device-a", "nonce", good.IssuedAt, st); e != nil {
			t.Fatal(e)
		}
	})
}
func TestServerOrigin(t *testing.T) {
	for _, s := range []string{"http://localhost", "https://x/path", "https://user:pass@x", "https://x?evil=1", "https://x#fragment"} {
		if _, e := NormalizeServer(s); e == nil {
			t.Errorf("accepted %s", s)
		}
	}
	if got, e := NormalizeServer("127.0.0.1:8443"); e != nil || got != "https://127.0.0.1:8443" {
		t.Fatal(got, e)
	}
}
func TestStateAtomicAndPause(t *testing.T) {
	dir := t.TempDir()
	if e := PrivateDir(dir); e != nil {
		t.Fatal(e)
	}
	s := State{HighestGeneration: 42, ApplyState: "written"}
	if e := SaveState(dir, s); e != nil {
		t.Fatal(e)
	}
	got, e := LoadState(dir)
	if e != nil || got.HighestGeneration != 42 {
		t.Fatal(got, e)
	}
	if e = SetPause(dir, true); e != nil || !LocalPaused(dir) {
		t.Fatal(e)
	}
	if e = SetPause(dir, false); e != nil || LocalPaused(dir) {
		t.Fatal(e)
	}
	unlock, e := Lock(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer unlock()
	if second, e := Lock(dir); e == nil {
		second()
		t.Fatal("second process lock succeeded")
	}
}
func TestPolicyNegative(t *testing.T) {
	p := CapabilityPolicy{}
	valid := []byte(`{"sources":{"synthetic":{"type":"demo_logs","format":"json"}},"transforms":{"clean":{"type":"remap","inputs":["synthetic"],"source":".tag = \"test\""}},"sinks":{"discard":{"type":"blackhole","inputs":["clean"]}}}`)
	if e := p.Check(valid); e != nil {
		t.Fatal(e)
	}
	cases := map[string]string{
		"implicit_elasticsearch": `{"sinks":{"x":{"type":"elasticsearch"}}}`,
		"implicit_listener":      `{"sources":{"x":{"type":"http_server"}}}`,
		"console_stdout":         `{"sinks":{"x":{"type":"console","target":"stdout"}}}`,
		"console_default":        `{"sinks":{"x":{"type":"console"}}}`,
		"exec":                   `{"sources":{"x":{"type":"exec","command":["calc"]}}}`, "unknown": `{"sources":{"x":{"type":"host_metrics"}}}`, "secret": `{"secret":{"x":{"type":"exec","command":["evil"]}}}`, "file": `{"sources":{"x":{"type":"file","include":["/etc/passwd"]}}}`, "network": `{"sinks":{"x":{"type":"http","uri":"https://evil.test/"}}}`, "command": `{"transforms":{"x":{"type":"remap","command":"calc"}}}`, "vrl_env": `{"transforms":{"x":{"type":"remap","source":".x = get_env_var!(\"SECRET\")"}}}`, "api": `{"api":{"enabled":true,"address":"0.0.0.0:8686"}}`, "disable_tls": `{"sinks":{"x":{"type":"http","tls":{"verify_certificate":false}}}}`, "source_files": `{"transforms":{"x":{"type":"remap","source_files":["/tmp/evil.vrl"]}}}`, "template": `{"sinks":{"x":{"type":"console","target":"{{field}}"}}}`}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if e := p.Check([]byte(data)); e == nil {
				t.Fatal("capability bypass")
			}
		})
	}
	for _, variable := range []string{"$SECRET", "${SECRET}"} {
		for _, field := range []string{"uri", "path", "source", "format"} {
			t.Run(variable+field, func(t *testing.T) {
				b, _ := json.Marshal(map[string]any{"sources": map[string]any{"x": map[string]any{"type": "demo_logs", field: variable}}})
				if e := p.Check(b); e == nil {
					t.Fatal("substitution accepted")
				}
			})
		}
	}
}
func TestPolicyAllowedRoots(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "allowed.log")
	p := CapabilityPolicy{AllowedFileRoots: []string{dir}, AllowedNetworkHosts: []string{"logs.example:443"}}
	if e := p.file(file); e != nil {
		t.Fatal(e)
	}
	if e := p.file(filepath.Join(dir, "..", "escape.log")); e == nil {
		t.Fatal("escape accepted")
	}
	if e := p.network("https://logs.example/v1"); e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{"https://logs.example.evil/v1", "https://logs.example:444/v1", "https://user:pass@logs.example/v1", "file:///etc/passwd"} {
		if e := p.network(s); e == nil {
			t.Fatal("network bypass")
		}
	}
}
func TestScrubbedEnvironment(t *testing.T) {
	t.Setenv("VECTOR_CONFIG", "evil")
	t.Setenv("VECTOR_CONFIG_DIR", "evil")
	t.Setenv("VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION", "true")
	t.Setenv("SECRET", "sensitive")
	for _, v := range cleanEnvironment() {
		if strings.HasPrefix(v, "VECTOR_") || strings.HasPrefix(v, "SECRET=") {
			t.Fatal("unsafe environment inherited")
		}
	}
}
func TestStartupAckCannotBeForgedByOtherTargets(t *testing.T) {
	w := newVectorLog("")
	for _, forged := range []string{
		`{"level":"INFO","target":"vector::vrl","message":"Vector has started.","version":"0.58.0"}`,
		`{"level":"INFO","target":"vector","message":"Vector has started.","version":"0.57.0"}`,
		`{"host":"x","message":"Vector has started.","target":"vector","version":"0.58.0"}`,
	} {
		_, _ = w.Write([]byte(forged + "\n"))
	}
	if w.signals.started != 0 {
		t.Fatal("forged or incomplete ack accepted")
	}
	_, _ = w.Write([]byte(`{"level":"INFO","target":"vector","message":"Vector has started.","version":"0.58.0"}` + "\n"))
	if w.signals.started != 1 {
		t.Fatal("real ack not accepted")
	}
}
func TestAdoptionAndServiceRejectSharedDirectories(t *testing.T) {
	root := t.TempDir()
	config := filepath.Join(root, "managed.json")
	if err := os.WriteFile(filepath.Join(root, "unrelated-secret.conf"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := CheckManagedDirectory(config, filepath.Join(root, "state")); err == nil {
		t.Fatal("shared configuration directory accepted")
	}
	if err := CheckFreshStateDirectory(root); err == nil {
		t.Fatal("shared state directory accepted")
	}
	b, err := os.ReadFile(filepath.Join(root, "unrelated-secret.conf"))
	if err != nil || string(b) != "preserve" {
		t.Fatal("preflight modified unrelated content")
	}
	dedicated := t.TempDir()
	if err = CheckManagedDirectory(filepath.Join(dedicated, "managed.json"), filepath.Join(root, "state")); err != nil {
		t.Fatal(err)
	}
}
