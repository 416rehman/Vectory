package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// nativeCheckDevice is a check device whose Vector is the pinned binary of
// VECTOR_TEST_BINARY, run for real by the agent's own driver. The test skips
// without it.
func nativeCheckDevice(t *testing.T) *checkDevice {
	t.Helper()
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY to verified Vector 0.58.0 for native checks on request")
	}
	d := newCheckDevice(t)
	digest, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	d.e.Settings.VectorBinary, d.e.Settings.VectorBinarySHA256, d.e.Settings.ValidationSeconds, d.e.Settings.StartupSeconds = binary, digest, 60, 20
	log := newVectorLog(d.state)
	t.Cleanup(log.close)
	d.e.Log = log
	d.e.Driver = &validationDriver{VectorDriver: &VectorDriver{Settings: d.e.Settings, Dir: d.state, Log: log}, alive: true}
	return d
}

// nativePipeline is a pipeline of the pinned Vector's own components: a
// transform that tags events, and the tests named, each asserting what it is
// given. A test named in failing asserts a value the transform doesn't write.
func nativePipeline(passing []string, failing []string, source string) []byte {
	if source == "" {
		source = `.env = "prod"`
	}
	tests := []any{}
	for _, name := range append(append([]string{}, passing...), failing...) {
		expected := "prod"
		for _, bad := range failing {
			if name == bad {
				expected = "staging"
			}
		}
		tests = append(tests, map[string]any{
			"name":    name,
			"inputs":  []any{map[string]any{"insert_at": "tag", "type": "log", "log_fields": map[string]any{"message": "hi"}}},
			"outputs": []any{map[string]any{"extract_from": "tag", "conditions": []any{map[string]any{"type": "vrl", "source": `assert_eq!(.env, "` + expected + `")`}}}},
		})
	}
	return mustJSONFor(map[string]any{
		"sources":    map[string]any{"synthetic": map[string]any{"type": "demo_logs", "format": "json"}},
		"transforms": map[string]any{"tag": map[string]any{"type": "remap", "inputs": []string{"synthetic"}, "source": source}},
		"sinks":      map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"tag"}}},
		"tests":      tests,
	})
}

// A candidate that passes on the device with the pinned Vector, tests included,
// is valid, and the check leaves the device as it found it, data directory and
// all.
func TestNativeAPassingCandidateIsValid(t *testing.T) {
	withoutSpacing(t)
	d := nativeCheckDevice(t)
	d.poll()
	before := d.snapshot()
	res := d.checkedAs(checkID, nativePipeline([]string{"tags the environment", "tags it again"}, nil, ""), true)
	if res["valid"] != true || len(res["diagnostics"].([]any)) != 0 {
		t.Fatalf("result %v", res)
	}
	tests := res["tests"].([]any)
	if len(tests) != 2 {
		t.Fatalf("tests %v", tests)
	}
	for _, item := range tests {
		if test := item.(map[string]any); test["passed"] != true || test["not_run"] != nil {
			t.Fatalf("test %v", test)
		}
	}
	if d.driver.starts != 0 {
		t.Fatal("a check started Vector")
	}
	if got := d.snapshot(); len(got) != len(before) {
		t.Fatal("the snapshot changed shape")
	}
	for key, value := range before {
		if d.snapshot()[key] != value {
			t.Fatalf("the check changed %s", key)
		}
	}
	if _, err := os.Stat(filepath.Join(d.state, "vector-data")); !os.IsNotExist(err) {
		t.Fatalf("the check left the data directory it created: %v", err)
	}
	if left := d.staging(); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
	// Asked not to run the tests, it doesn't, and a failing test goes unnoticed.
	res = d.checkedAs(checkID2, nativePipeline(nil, []string{"would fail"}, ""), false)
	if res["valid"] != true || len(res["tests"].([]any)) != 0 {
		t.Fatalf("a check that wasn't asked to run tests: %v", res)
	}
}

// Candidates the pinned Vector rejects are reported through the diagnostics an
// apply gives: the component, the field and the fix.
func TestNativeFailingCandidatesAreReportedLikeAnApplyReportsThem(t *testing.T) {
	withoutSpacing(t)
	d := nativeCheckDevice(t)
	d.poll()
	cases := []struct {
		name  string
		data  []byte
		check func(t *testing.T, diagnostics []map[string]any)
	}{
		{"an input that doesn't exist", mustJSONFor(map[string]any{
			"sources": map[string]any{"synthetic": map[string]any{"type": "demo_logs", "format": "json"}},
			"sinks":   map[string]any{"out": map[string]any{"type": "blackhole", "inputs": []string{"nope"}}},
		}), func(t *testing.T, diagnostics []map[string]any) {
			if len(diagnostics) != 1 || diagnostics[0]["code"] != "INPUT_NOT_FOUND" || diagnostics[0]["component_id"] != "out" || diagnostics[0]["field"] != "inputs" {
				t.Fatalf("diagnostics %v", diagnostics)
			}
		}},
		{"VRL that doesn't compile", nativePipeline(nil, nil, `.status_code = to_int(.status)`), func(t *testing.T, diagnostics []map[string]any) {
			if len(diagnostics) != 1 || diagnostics[0]["code"] != "VRL_E103" || diagnostics[0]["component_id"] != "tag" || diagnostics[0]["field"] != "source" || diagnostics[0]["line"] != float64(1) {
				t.Fatalf("diagnostics %v", diagnostics)
			}
			if hint, _ := diagnostics[0]["hint"].(string); !strings.HasPrefix(hint, "Try: ") {
				t.Fatalf("hint %q", hint)
			}
		}},
		{"a data directory that doesn't exist", mustJSONFor(map[string]any{
			"data_dir": filepath.Join(d.root, "no-such-data-dir"),
			"sources":  map[string]any{"synthetic": map[string]any{"type": "demo_logs", "format": "json"}},
			"sinks":    map[string]any{"out": map[string]any{"type": "blackhole", "inputs": []string{"synthetic"}}},
		}), func(t *testing.T, diagnostics []map[string]any) {
			if len(diagnostics) != 1 || diagnostics[0]["code"] != "DATA_DIR_MISSING" || diagnostics[0]["field"] != "data_dir" {
				t.Fatalf("diagnostics %v", diagnostics)
			}
		}},
	}
	d.e.Settings.CapabilityPolicy.AllowedFileRoots = []string{d.root}
	d.e.Driver.(*validationDriver).VectorDriver.Settings.CapabilityPolicy.AllowedFileRoots = []string{d.root}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := d.checkedAs(fmt.Sprintf("00000000-0000-4000-8000-%012d", i), c.data, true)
			if res["valid"] != false {
				t.Fatalf("result %v", res)
			}
			c.check(t, diagnosticsOf(t, res))
			if left := d.staging(); len(left) != 0 {
				t.Fatalf("left %v", left)
			}
			if _, err := os.Stat(filepath.Join(d.root, "no-such-data-dir")); !os.IsNotExist(err) {
				t.Fatal("the agent created the data directory a pipeline set")
			}
		})
	}
}

// A candidate whose test fails under the pinned Vector: not valid, the failing
// test first with its first failing condition, the passing ones listed as
// passed, and a TEST_FAILED diagnostic for the component under test.
func TestNativeAFailingTestIsReported(t *testing.T) {
	d := nativeCheckDevice(t)
	d.poll()
	res := d.checked(nativePipeline([]string{"tags the environment"}, []string{"expects staging"}, ""), true)
	if res["valid"] != false {
		t.Fatalf("result %v", res)
	}
	tests := res["tests"].([]any)
	if len(tests) != 2 {
		t.Fatalf("tests %v", tests)
	}
	first, second := tests[0].(map[string]any), tests[1].(map[string]any)
	if first["name"] != "expects staging" || first["passed"] != false || first["not_run"] != nil || second["name"] != "tags the environment" || second["passed"] != true {
		t.Fatalf("tests %v", tests)
	}
	if message, _ := first["message"].(string); !strings.Contains(message, `assertion failed: "prod" == "staging"`) {
		t.Fatalf("message %q", message)
	}
	diagnostics := diagnosticsOf(t, res)
	if len(diagnostics) != 1 || diagnostics[0]["code"] != "TEST_FAILED" || diagnostics[0]["component_id"] != "tag" || diagnostics[0]["field"] != "tests" {
		t.Fatalf("diagnostics %v", diagnostics)
	}
	// Vector's output payloads, which hold event data, never leave the device.
	if strings.Contains(string(mustJSON(t, res)), "output payloads") || strings.Contains(string(mustJSON(t, res)), `"message":"hi"`) {
		t.Fatalf("Vector's output reached the result: %s", mustJSON(t, res))
	}
}

// A device-secret value is substituted into what the pinned Vector validates, so
// the check is the apply's, yet it appears nowhere in what is reported when the
// candidate fails.
func TestNativeASecretIsUsedAndNeverReported(t *testing.T) {
	const secret = "native-secret-5b1e7c93d2"
	d := nativeCheckDevice(t)
	d.poll()
	path := d.bind("API_TOKEN", secret)
	d.e.Settings.CapabilityPolicy.AllowedNetworkHosts = []string{"sink.example:443"}
	d.e.Driver.(*validationDriver).VectorDriver.Settings.SecretFiles = d.e.Settings.SecretFiles
	candidate := mustJSONFor(map[string]any{
		"sources": map[string]any{"synthetic": map[string]any{"type": "demo_logs", "format": "json"}},
		"sinks": map[string]any{"out": map[string]any{"type": "http", "inputs": []string{"nope"}, "uri": "https://sink.example/events", "encoding": map[string]string{"codec": "json"},
			"auth": map[string]string{"strategy": "bearer", "token": "vectory-secret:API_TOKEN"}, "healthcheck": map[string]any{"enabled": false}}},
	})
	res := d.checked(candidate, false)
	if res["valid"] != false || len(res["secrets_missing"].([]any)) != 0 {
		t.Fatalf("result %v", res)
	}
	if first := diagnosticsOf(t, res)[0]; first["code"] != "INPUT_NOT_FOUND" {
		t.Fatalf("diagnostic %v", first)
	}
	requireNoSecrets(t, d.plane, secret, path, filepath.Dir(path))
}
