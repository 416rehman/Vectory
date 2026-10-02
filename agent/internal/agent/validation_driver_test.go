package agent

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// newVectorCheckDevice is a check device whose Vector is the stand-in
// executable, run for real by the agent's own driver: the pinned binary's
// digest is checked, the time limit is the setting's and the candidate is
// validated through the same overlay and arguments as an apply's.
func newVectorCheckDevice(t *testing.T, config fakeVectorConfig, change func(*Settings)) *checkDevice {
	t.Helper()
	d := newCheckDevice(t)
	binary := standInVector(t, config)
	digest, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	d.e.Settings.VectorBinary, d.e.Settings.VectorBinarySHA256, d.e.Settings.ValidationSeconds = binary, digest, 5
	if change != nil {
		change(&d.e.Settings)
	}
	log := newVectorLog(d.state)
	t.Cleanup(log.close)
	d.e.Log = log
	d.e.Driver = &validationDriver{VectorDriver: &VectorDriver{Settings: d.e.Settings, Dir: d.state, Log: log}, alive: true}
	return d
}

// candidateWithTests is a pipeline with the tests named. Each test asserts a
// value in its VRL, as the stand-in's failing output quotes it: text a result may
// repeat only because it comes from the pipeline itself.
func candidateWithTests(names ...string) []byte {
	tests := []any{}
	for _, name := range names {
		tests = append(tests, map[string]any{"name": name, "inputs": []any{map[string]any{"insert_at": "tag", "type": "log", "log_fields": map[string]any{"message": "hi"}}},
			"outputs": []any{map[string]any{"extract_from": "tag", "conditions": []any{map[string]any{"type": "vrl", "source": `assert_eq!(.env, "staging")`}}}}})
	}
	return mustJSONFor(map[string]any{
		"sources":    map[string]any{"synthetic": map[string]any{"type": "demo_logs", "format": "json"}},
		"transforms": map[string]any{"tag": map[string]any{"type": "remap", "inputs": []string{"synthetic"}, "source": `.env = "prod"`}},
		"sinks":      map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"tag"}}},
		"tests":      tests,
	})
}

// checkedAs asks for a check under id and returns its result.
func (d *checkDevice) checkedAs(id string, data []byte, runTests bool) map[string]any {
	d.t.Helper()
	d.ask(data, id, runTests)
	d.poll()
	d.poll()
	res := result(d.plane.last())
	if res == nil || res["id"] != id {
		d.t.Fatalf("no result for %s in %v", id, d.plane.last())
	}
	return res
}

// vectorCalls are the invocations the stand-in logged, by command.
func vectorCalls(t *testing.T, calls string) (validations, tests []string) {
	t.Helper()
	raw, err := os.ReadFile(calls)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		switch {
		case strings.HasPrefix(line, "validate"):
			validations = append(validations, line)
		case strings.HasPrefix(line, "test"):
			tests = append(tests, line)
		}
	}
	return validations, tests
}

// Vector's tests run only when the request asks for them, and then each test
// is reported by name: the ones that passed and the one that failed, with its
// first failing condition, failing tests first.
func TestTestsRunOnlyWhenAskedAndAreReportedByName(t *testing.T) {
	withoutSpacing(t)
	calls := filepath.Join(t.TempDir(), "calls.log")
	d := newVectorCheckDevice(t, fakeVectorConfig{Calls: calls, Test: "fail", FailTests: []string{"second"}}, nil)
	d.poll()
	candidate := candidateWithTests("first", "second", "third")

	res := d.checkedAs(checkID, candidate, false)
	if res["valid"] != true || len(res["tests"].([]any)) != 0 || len(res["diagnostics"].([]any)) != 0 {
		t.Fatalf("a check that wasn't asked to run tests: %v", res)
	}
	if validations, tests := vectorCalls(t, calls); len(validations) != 1 || len(tests) != 0 {
		t.Fatalf("validations %v, tests %v", validations, tests)
	}

	res = d.checkedAs(checkID2, candidate, true)
	if validations, tests := vectorCalls(t, calls); len(validations) != 2 || len(tests) != 1 {
		t.Fatalf("validations %v, tests %v", validations, tests)
	}
	got := res["tests"].([]any)
	if res["valid"] != false || len(got) != 3 {
		t.Fatalf("result %v", res)
	}
	want := []struct {
		name   string
		passed bool
	}{{"second", false}, {"first", true}, {"third", true}}
	for i, w := range want {
		test := got[i].(map[string]any)
		if test["name"] != w.name || test["passed"] != w.passed || test["not_run"] != nil {
			t.Fatalf("test %d is %v", i, test)
		}
	}
	if message, _ := got[0].(map[string]any)["message"].(string); !strings.Contains(message, `assertion failed: "prod" == "staging"`) {
		t.Fatalf("the failing test's message is %q", message)
	}
	diagnostics := diagnosticsOf(t, res)
	if len(diagnostics) != 1 || diagnostics[0]["code"] != "TEST_FAILED" || diagnostics[0]["component_id"] != "tag" || diagnostics[0]["field"] != "tests" {
		t.Fatalf("diagnostics %v", diagnostics)
	}
}

// All tests passing leaves the result valid, with each test listed as passed;
// a candidate with no tests, asked to run them, is valid on its own.
func TestPassingTestsAreListedAndACandidateWithoutTestsIsValid(t *testing.T) {
	withoutSpacing(t)
	d := newVectorCheckDevice(t, fakeVectorConfig{}, nil)
	d.poll()
	res := d.checkedAs(checkID, candidateWithTests("first", "second"), true)
	got := res["tests"].([]any)
	if res["valid"] != true || len(got) != 2 || got[0].(map[string]any)["passed"] != true || got[1].(map[string]any)["passed"] != true {
		t.Fatalf("result %v", res)
	}
	res = d.checkedAs(checkID2, candidateWithTests(), true)
	if res["valid"] != true || len(res["tests"].([]any)) != 0 {
		t.Fatalf("result %v", res)
	}
}

// When Vector rejects the candidate, its tests are not run, and say so: they
// are never reported as passed, and never as failed.
func TestTestsThatDidNotRunAreSaidNotToHaveRun(t *testing.T) {
	calls := filepath.Join(t.TempDir(), "calls.log")
	d := newVectorCheckDevice(t, fakeVectorConfig{Validate: "reject", Calls: calls}, nil)
	d.poll()
	res := d.checkedAs(checkID, candidateWithTests("first", "second"), true)
	got := res["tests"].([]any)
	if res["valid"] != false || len(got) != 2 {
		t.Fatalf("result %v", res)
	}
	for _, item := range got {
		test := item.(map[string]any)
		if test["passed"] != false || test["not_run"] != true || !strings.HasPrefix(test["message"].(string), "Not run") {
			t.Fatalf("test %v", test)
		}
	}
	if _, tests := vectorCalls(t, calls); len(tests) != 0 {
		t.Fatal("the tests ran although validation failed")
	}
	diagnostics := diagnosticsOf(t, res)
	if len(diagnostics) != 1 || diagnostics[0]["code"] != "VALIDATION_ERROR" {
		t.Fatalf("diagnostics %v", diagnostics)
	}
}

// A validation that outlasts the setting's time limit ends in a diagnostic in
// the words of a check, with the child killed; nothing is left behind.
func TestACheckThatOutlastsTheTimeLimitIsAnswered(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "validation.pid")
	d := newVectorCheckDevice(t, fakeVectorConfig{Validate: "hang", PIDFile: pidFile}, func(s *Settings) { s.ValidationSeconds = 1 })
	d.poll()
	started := time.Now()
	res := d.checkedAs(checkID, candidateWithTests("first"), true)
	if took := time.Since(started); took < time.Second || took > 20*time.Second {
		t.Fatalf("the check ended after %s, not at its one-second limit", took)
	}
	diagnostics := diagnosticsOf(t, res)
	if res["valid"] != false || len(diagnostics) != 1 || diagnostics[0]["code"] != "VECTOR_TIMEOUT" {
		t.Fatalf("result %v", res)
	}
	hint, _ := diagnostics[0]["hint"].(string)
	if !strings.Contains(hint, "run the check again") || strings.Contains(hint, "Retry application") || strings.Contains(hint, "previous configuration") {
		t.Fatalf("the hint is an apply's: %q", hint)
	}
	if test := res["tests"].([]any)[0].(map[string]any); test["not_run"] != true {
		t.Fatalf("test %v", test)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("the stand-in never started: %v", err)
	}
	var pid int
	for _, c := range strings.TrimSpace(string(raw)) {
		pid = pid*10 + int(c-'0')
	}
	waitUntilGone(t, pid)
	if left := d.staging(); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
}

// Vector is given the staged copy and the copy of its runtime settings from the
// check's private directory, never from the managed directory or the state
// directory's top level, and both are deleted.
func TestVectorIsGivenOnlyFilesFromTheStagingDirectory(t *testing.T) {
	calls := filepath.Join(t.TempDir(), "calls.log")
	d := newVectorCheckDevice(t, fakeVectorConfig{Calls: calls}, nil)
	d.poll()
	d.checkedAs(checkID, candidateWithTests("first"), true)
	raw, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	staging := filepath.Join(d.state, validationStagingName) + string(filepath.Separator)
	seen := 0
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		for i, field := range fields {
			if field != "--config-json" {
				continue
			}
			seen++
			if !strings.HasPrefix(fields[i+1], staging) {
				t.Fatalf("Vector was given %s, outside %s", fields[i+1], staging)
			}
		}
	}
	if seen != 4 { // validate and test, each with the candidate and the overlay
		t.Fatalf("%d configuration files were given", seen)
	}
	if left := d.staging(); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
	if left := leftovers(t, d.state); len(left) != 0 {
		t.Fatalf("left %v in the state directory", left)
	}
}

// The data directory a check has to create to let Vector validate is removed
// again, to the last directory it created; one that existed stays as it was, and
// one a pipeline sets is never created by the agent.
func TestACheckLeavesTheDataDirectoryAsItFoundIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses the stand-in's own log of what exists")
	}
	t.Run("a directory the agent creates", func(t *testing.T) {
		calls := filepath.Join(t.TempDir(), "calls.log")
		var dataDir string
		d := newVectorCheckDevice(t, fakeVectorConfig{Calls: calls}, func(s *Settings) {
			dataDir = filepath.Join(filepath.Dir(filepath.Dir(s.ManagedConfig)), "host-data", "nested", "vector")
			s.VectorDataDir = dataDir
		})
		d.poll()
		res := d.checkedAs(checkID, candidateWithTests(), false)
		if res["valid"] != true {
			t.Fatalf("result %v", res)
		}
		if raw, _ := os.ReadFile(calls); !strings.Contains(string(raw), "data_dir exists=true") {
			t.Fatalf("Vector wasn't given a data directory that exists:\n%s", raw)
		}
		if _, err := os.Stat(filepath.Dir(filepath.Dir(dataDir))); !os.IsNotExist(err) {
			t.Fatalf("the directories the check created were left behind: %v", err)
		}
	})
	t.Run("the agent's own default", func(t *testing.T) {
		d := newVectorCheckDevice(t, fakeVectorConfig{}, nil)
		d.poll()
		if res := d.checkedAs(checkID, candidateWithTests(), false); res["valid"] != true {
			t.Fatalf("result %v", res)
		}
		if _, err := os.Stat(filepath.Join(d.state, "vector-data")); !os.IsNotExist(err) {
			t.Fatalf("the default data directory was created and left: %v", err)
		}
	})
	t.Run("a directory that exists", func(t *testing.T) {
		var dataDir string
		d := newVectorCheckDevice(t, fakeVectorConfig{}, func(s *Settings) {
			dataDir = filepath.Join(filepath.Dir(filepath.Dir(s.ManagedConfig)), "existing-data")
			s.VectorDataDir = dataDir
		})
		if err := os.MkdirAll(dataDir, 0700); err != nil {
			t.Fatal(err)
		}
		checkpoint := filepath.Join(dataDir, "checkpoint")
		if err := os.WriteFile(checkpoint, []byte("kept"), 0600); err != nil {
			t.Fatal(err)
		}
		d.poll()
		d.checkedAs(checkID, candidateWithTests(), false)
		if raw, err := os.ReadFile(checkpoint); err != nil || string(raw) != "kept" {
			t.Fatalf("the data directory's content changed: %q %v", raw, err)
		}
	})
	t.Run("a directory the pipeline sets", func(t *testing.T) {
		calls := filepath.Join(t.TempDir(), "calls.log")
		var pipelineDir string
		d := newVectorCheckDevice(t, fakeVectorConfig{Calls: calls}, func(s *Settings) {
			root := filepath.Dir(filepath.Dir(s.ManagedConfig))
			pipelineDir = filepath.Join(root, "pipeline-data")
			s.CapabilityPolicy.AllowedFileRoots = []string{root}
		})
		d.poll()
		candidate := mustJSONFor(map[string]any{
			"data_dir": pipelineDir,
			"sources":  map[string]any{"synthetic": map[string]any{"type": "demo_logs", "format": "json"}},
			"sinks":    map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"synthetic"}}},
		})
		d.checkedAs(checkID, candidate, false)
		if _, err := os.Stat(pipelineDir); !os.IsNotExist(err) {
			t.Fatalf("the agent created the data directory a pipeline set: %v", err)
		}
		if raw, _ := os.ReadFile(calls); !strings.Contains(string(raw), "data_dir exists=false") {
			t.Fatalf("the stand-in didn't see the missing directory:\n%s", raw)
		}
	})
	t.Run("a directory that can't be created", func(t *testing.T) {
		d := newVectorCheckDevice(t, fakeVectorConfig{}, func(s *Settings) {
			blocker := filepath.Join(filepath.Dir(filepath.Dir(s.ManagedConfig)), "blocker")
			if err := os.WriteFile(blocker, []byte("a file"), 0600); err != nil {
				t.Fatal(err)
			}
			s.VectorDataDir = filepath.Join(blocker, "data")
		})
		d.poll()
		res := d.checkedAs(checkID, candidateWithTests(), false)
		diagnostics := diagnosticsOf(t, res)
		if res["valid"] != false || len(diagnostics) != 1 || diagnostics[0]["code"] != "DATA_DIR_UNAVAILABLE" || diagnostics[0]["field"] != "data_dir" {
			t.Fatalf("result %v", res)
		}
	})
}

// A check writes nothing to Vector's local log, which `vectory logs` shows; an
// apply's validation that fails still does.
func TestACheckLeavesNoNoteInTheLocalLog(t *testing.T) {
	d := newVectorCheckDevice(t, fakeVectorConfig{Validate: "reject"}, nil)
	d.poll()
	if res := d.checkedAs(checkID, candidateWithTests("first"), true); res["valid"] != false {
		t.Fatalf("result %v", res)
	}
	log := filepath.Join(d.state, vectorLogName)
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatal("a check wrote Vector's local log")
	}
	stage := filepath.Join(d.state, "apply-stage.json")
	if err := AtomicWrite(stage, candidateWithTests("first")); err != nil {
		t.Fatal(err)
	}
	if err := d.e.Driver.Validate(context.Background(), stage); err == nil {
		t.Fatal("the stand-in accepted the configuration")
	}
	if raw, err := os.ReadFile(log); err != nil || !strings.Contains(string(raw), "vector validate rejected the configuration") {
		t.Fatalf("an apply's failed validation no longer leaves its note: %q %v", raw, err)
	}
}

// The apply's own validation is as it was: it runs the configuration's tests
// whenever it has some, and a failing one rejects the version.
func TestAnApplysValidationStillRunsTheTestsItHas(t *testing.T) {
	calls := filepath.Join(t.TempDir(), "calls.log")
	d := newVectorCheckDevice(t, fakeVectorConfig{Calls: calls, Test: "fail", FailTests: []string{"second"}}, nil)
	stage := filepath.Join(d.state, "apply-stage.json")
	if err := AtomicWrite(stage, candidateWithTests("first")); err != nil {
		t.Fatal(err)
	}
	if err := d.e.Driver.Validate(context.Background(), stage); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(stage, candidateWithTests("first", "second")); err != nil {
		t.Fatal(err)
	}
	err := d.e.Driver.Validate(context.Background(), stage)
	if failure := asVectorFailure(err); failure == nil || failure.Phase != "test" {
		t.Fatalf("a failing test didn't reject the version: %v", err)
	}
	if _, tests := vectorCalls(t, calls); len(tests) != 2 {
		t.Fatalf("tests ran %d times", len(tests))
	}
}
