package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// credentialsPipeline is an Elasticsearch sink that signs with the AWS profile
// at profile, pointed at a port nothing listens on, so nothing leaves the host.
func credentialsPipeline(dataDir string, auth map[string]any) map[string]any {
	return map[string]any{
		"data_dir": dataDir,
		"sources":  map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json", "interval": 0.2}},
		"sinks": map[string]any{"out": map[string]any{
			"type": "elasticsearch", "inputs": []string{"in"}, "endpoints": []string{"http://127.0.0.1:9"},
			"aws": map[string]any{"region": "us-east-1"}, "auth": auth,
		}},
	}
}

// With the pinned Vector. An AWS profile with credential_process names a
// program, and Vector runs it while it validates a configuration: that is the
// premise, shown by running `vector validate` on the pipeline directly. A
// restricted device refuses the same pipeline before it stages anything or
// starts Vector, even when the host allowed both the folder that holds the
// profile and the destination, so the program never runs.
//
// Where the program is a shell script (everywhere but Windows), the premise is
// measured. The refusal runs on every platform.
func TestNativeACredentialsFileNeverRunsAProgramInRestrictedMode(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for native Vector runtime tests")
	}
	ctx := context.Background()
	work := privateTempDir(t)
	dataDir := filepath.Join(work, "data")
	if err := os.Mkdir(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(work, "marker")
	script := filepath.Join(work, "credential-process.sh")
	profile := filepath.Join(work, "credentials")
	// The shell's own redirect writes the marker, so the program needs no PATH.
	program := "#!/bin/sh\n: > '" + marker + "'\necho '{\"Version\":1,\"AccessKeyId\":\"AKIAIOSFODNN7EXAMPLE\",\"SecretAccessKey\":\"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\"}'\n"
	if err := os.WriteFile(script, []byte(program), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(profile, []byte("[vector]\ncredential_process = "+script+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	auth := map[string]any{"strategy": "aws", "credentials_file": profile, "profile": "vector"}

	if runtime.GOOS != "windows" {
		t.Run("without the policy Vector runs the program", func(t *testing.T) {
			config := filepath.Join(work, "control.json")
			data, _ := json.Marshal(credentialsPipeline(dataDir, auth))
			if err := os.WriteFile(config, data, 0o600); err != nil {
				t.Fatal(err)
			}
			validateCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
			defer cancel()
			cmd := exec.CommandContext(validateCtx, binary, "validate", "--config-json", config)
			cmd.Dir = work
			cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
			// The health check fails (nothing listens on port 9), so the exit status
			// says nothing; the marker does.
			_ = cmd.Run()
			if _, err := os.Stat(marker); err != nil {
				t.Fatal("this Vector no longer runs a credential_process program while it validates: the rule in policy.go needs another look")
			}
			if err := os.Remove(marker); err != nil {
				t.Fatal(err)
			}
		})
	}

	t.Run("a restricted device refuses it before Vector runs", func(t *testing.T) {
		e, driver := nativeRuntimeFixture(t)
		policy := CapabilityPolicy{AllowedFileRoots: []string{work}, AllowedNetworkHosts: []string{"127.0.0.1:9"}}
		e.Settings.CapabilityPolicy, driver.Settings.CapabilityPolicy = policy, policy

		data, _ := json.Marshal(credentialsPipeline(dataDir, auth))
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/agent/v1/artifacts/"+Digest(data) {
				_, _ = w.Write(data)
				return
			}
			http.NotFound(w, r)
		}))
		defer server.Close()
		e.Client = &Client{HTTP: server.Client(), Base: server.URL}
		m := sampleManifest()
		m.Generation = 2
		m.Desired = &Desired{VersionID: "v2", SHA256: Digest(data), Size: int64(len(data)), ArtifactPath: "/agent/v1/artifacts/" + Digest(data), VectorVersion: VectorVersion}
		e.State = State{Accepted: true, HighestGeneration: m.Generation, HighestPolicyGeneration: m.PolicyGeneration, DesiredIdentity: Identity(m.Desired), PolicyIdentity: Identity(m.Policy), Desired: m.Desired, Policy: m.Policy, ApplyState: "unmanaged"}
		if err := e.save(); err != nil {
			t.Fatal(err)
		}

		if err := e.Reconcile(ctx, m); err == nil {
			t.Fatal("a credentials file was applied")
		}
		requireAttempt(t, e, m, "failed", "CAPABILITY_DENIED")
		diagnostics := e.State.ConfigurationAttempt.Error.Diagnostics
		if len(diagnostics) != 1 || diagnostics[0].Code != "CREDENTIALS_FILE_DENIED" || diagnostics[0].Field != "auth.credentials_file" ||
			diagnostics[0].Message != `Sink "out" (elasticsearch) sets auth.credentials_file. A credentials file can name a program that Vector runs, so restricted mode refuses it.` ||
			diagnostics[0].Hint != "Use device secrets for access keys, or deploy to a full-mode device." {
			t.Fatalf("diagnostics: %+v", diagnostics)
		}
		if err := serverAcceptsDiagnostic(diagnostics[0]); err != nil {
			t.Errorf("the server would refuse this diagnostic: %v", err)
		}
		if driver.Alive() {
			t.Fatal("Vector was started for a version the agent refused")
		}
		if _, err := os.Stat(e.Settings.ManagedConfig); !os.IsNotExist(err) {
			t.Fatal("the refused version reached the managed path")
		}
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatal("the program ran")
		}
	})
}

// With the pinned Vector, the facts the ambient-credential rule rests on: it
// validates a sink that signs with the AWS strategy and no keys, in each of
// the four restricted-mode sinks that take one, in the shapes the rule refuses
// (nothing, a role to assume, the metadata client) and in the explicit one it
// accepts; and it refuses a lone key and keys in the wrong place, so no shape
// the rule counts as explicit leaves it a credential chain to fall back to.
func TestNativeVectorAcceptsAmbientAWSCredentialsAndTheRuleRefusesThem(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for native Vector runtime tests")
	}
	work := privateTempDir(t)
	dataDir := filepath.Join(work, "data")
	if err := os.Mkdir(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	validates := func(t *testing.T, s awsSink, credential map[string]any) bool {
		t.Helper()
		sink := s.sink(credential)
		sources := map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json", "count": 1}}
		if s.typ == "prometheus_exporter" {
			sources = map[string]any{"in": map[string]any{"type": "internal_metrics"}}
		}
		data, _ := json.Marshal(map[string]any{"data_dir": dataDir, "sources": sources, "sinks": map[string]any{"out": sink}})
		config := filepath.Join(work, "case.json")
		if err := os.WriteFile(config, data, 0o600); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, binary, "validate", "--no-environment", "--config-json", config)
		cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
		return cmd.Run() == nil
	}
	policy := awsPolicy(work)
	for _, s := range awsSinks {
		t.Run(s.typ, func(t *testing.T) {
			for name, credential := range map[string]map[string]any{
				"no keys":      {},
				"a role":       {"assume_role": "arn:aws:iam::123456789012:role/vector"},
				"the metadata": {"imds": map[string]any{"max_attempts": 2}},
			} {
				if !validates(t, s, credential) {
					t.Errorf("%s: this Vector no longer accepts an ambient AWS credential here: the rule in policy.go needs another look", name)
				}
				if refusal := refusalOf(t, policy.Check(awsConfig(t, s, credential))); refusal.Code != "AMBIENT_CREDENTIALS_DENIED" {
					t.Errorf("%s: %+v", name, refusal)
				}
			}
			if !validates(t, s, explicitKeys) {
				t.Error("explicit keys no longer validate")
			}
			if err := policy.Check(awsConfig(t, s, explicitKeys)); err != nil {
				t.Errorf("explicit keys refused: %v", err)
			}
			for name, credential := range map[string]map[string]any{
				"only the access key ID":     {"access_key_id": "AKIAIOSFODNN7EXAMPLE"},
				"only the secret access key": {"secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"},
			} {
				if validates(t, s, credential) {
					t.Errorf("%s: this Vector now accepts it, so it may fall back to the chain", name)
				}
			}
		})
	}
}
