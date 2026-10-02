package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

// twoSinkSecretTemplate references three device secrets from two sinks.
func twoSinkSecretTemplate() []byte {
	return mustJSONFor(map[string]any{
		"sources": map[string]any{"synthetic": map[string]any{"type": "demo_logs", "format": "json"}},
		"sinks": map[string]any{
			"out":    map[string]any{"type": "http", "inputs": []string{"synthetic"}, "uri": "https://sink.example/events", "encoding": map[string]string{"codec": "json"}, "auth": map[string]string{"strategy": "bearer", "token": "vectory-secret:API_TOKEN"}},
			"mirror": map[string]any{"type": "http", "inputs": []string{"synthetic"}, "uri": "https://sink.example/mirror", "encoding": map[string]string{"codec": "json"}, "auth": map[string]string{"strategy": "basic", "user": "vectory-secret:MIRROR_USER", "password": "vectory-secret:MIRROR_PASSWORD"}},
		},
	})
}

func mustJSONFor(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// bind binds the device secret name to a private file holding value and
// returns the file's path.
func (d *checkDevice) bind(name, value string) string {
	d.t.Helper()
	path := filepath.Join(privateTempDir(d.t), name)
	if err := AtomicWrite(path, []byte(value+"\n")); err != nil {
		d.t.Fatal(err)
	}
	if d.e.Settings.SecretFiles == nil {
		d.e.Settings.SecretFiles = map[string]string{}
	}
	d.e.Settings.SecretFiles[name] = path
	return path
}

// checked polls twice, so that the check runs and its result goes out, and
// returns that result.
func (d *checkDevice) checked(data []byte, runTests bool) map[string]any {
	d.t.Helper()
	d.ask(data, checkID, runTests)
	d.poll()
	d.poll()
	res := result(d.plane.last())
	if res == nil {
		d.t.Fatalf("no result in %v", d.plane.last())
	}
	return res
}

func diagnosticsOf(t *testing.T, res map[string]any) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, item := range res["diagnostics"].([]any) {
		out = append(out, item.(map[string]any))
	}
	return out
}

// A candidate that references device secrets this device hasn't bound is not
// valid, and names every missing one, sorted, without running Vector: the
// result carries names only, with the component and field of each.
func TestAMissingSecretBindingIsReportedByName(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	d.bind("API_TOKEN", "bound-value-1")
	d.e.Settings.CapabilityPolicy.AllowedNetworkHosts = []string{"sink.example:443"}
	res := d.checked(twoSinkSecretTemplate(), false)
	if res["valid"] != false || !reflect.DeepEqual(res["secrets_missing"], []any{"MIRROR_PASSWORD", "MIRROR_USER"}) {
		t.Fatalf("result %v", res)
	}
	diagnostics := diagnosticsOf(t, res)
	if len(diagnostics) != 2 {
		t.Fatalf("diagnostics %v", diagnostics)
	}
	for i, want := range []struct{ name, field string }{{"MIRROR_PASSWORD", "auth.password"}, {"MIRROR_USER", "auth.user"}} {
		got := diagnostics[i]
		if got["code"] != "SECRET_BINDING_MISSING" || got["component_kind"] != "sink" || got["component_id"] != "mirror" || got["field"] != want.field || got["severity"] != "error" ||
			got["message"] != `This device has no file bound to secret "`+want.name+`".` || !strings.Contains(got["hint"].(string), "configure-secrets") {
			t.Fatalf("diagnostic %d is %v", i, got)
		}
	}
	if len(d.driver.checks()) != 0 || len(d.staging()) != 0 {
		t.Fatal("a candidate whose secrets can't be filled in was staged or checked")
	}
	requireNoSecrets(t, d.plane, "bound-value-1")
}

// A bound name whose file can't be read is a different problem from an unbound
// one: it is a diagnostic, and not in secrets_missing.
func TestAnUnreadableSecretFileIsNotAMissingBinding(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	path := d.bind("API_TOKEN", "x")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	res := d.checked(secretTemplate("https://sink.example/events"), false)
	diagnostics := diagnosticsOf(t, res)
	if res["valid"] != false || len(res["secrets_missing"].([]any)) != 0 || len(diagnostics) != 1 || diagnostics[0]["code"] != "SECRET_FILE_UNREADABLE" {
		t.Fatalf("result %v", res)
	}
	if bytes.Contains(mustJSON(t, res), []byte(path)) || bytes.Contains(mustJSON(t, res), []byte(filepath.Dir(path))) {
		t.Fatal("the result names the secret's file")
	}
}

// Restricted mode refuses a candidate the way it refuses an apply: with the
// component, the resource and the exact command that would allow it.
func TestARestrictedModeRefusalIsReportedWithItsFix(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	d.bind("API_TOKEN", "t")
	res := d.checked(secretTemplate("https://not-approved.example/events"), false)
	diagnostics := diagnosticsOf(t, res)
	if res["valid"] != false || len(diagnostics) != 1 {
		t.Fatalf("result %v", res)
	}
	got := diagnostics[0]
	if got["code"] != "NETWORK_DESTINATION_DENIED" || got["component_id"] != "out" || got["field"] != "uri" ||
		!strings.Contains(got["message"].(string), "not-approved.example:443") || !strings.Contains(got["hint"].(string), "vectory allow --network not-approved.example:443") {
		t.Fatalf("diagnostic %v", got)
	}
	if len(d.driver.checks()) != 0 || len(d.staging()) != 0 {
		t.Fatal("a refused candidate was staged or checked")
	}
}

// What Vector's own validation finds is reported through the apply path's
// diagnostics: here a failing validation, a timeout in the words of a check,
// and a data directory the agent couldn't prepare.
func TestVectorsFindingsAreReportedAsAnApplyReportsThem(t *testing.T) {
	bad := []byte(`{"sources":{"synthetic":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["nope"]}}}`)
	cases := []struct {
		name string
		fail error
		code string
		hint string
		not  string
	}{
		{"validation", &VectorFailure{Phase: "validate", Summary: "Vector rejected the configuration", Output: vectorFixture(t, "missing_input.validate.txt")}, "INPUT_NOT_FOUND", "Change inputs", ""},
		{"timeout", &VectorFailure{Phase: "timeout", Summary: "Vector did not finish validating this version within 30 s."}, "VECTOR_TIMEOUT", "run the check again", "Retry application"},
		{"data directory", dataDirFailure("/srv/vector-data"), "DATA_DIR_UNAVAILABLE", "", ""},
		{"unavailable", prepareFailure("VECTOR_BINARY_UNAVAILABLE", "The Vector binary this agent approved is missing, unreadable or changed.", "Run vectory doctor on the host."), "VECTOR_BINARY_UNAVAILABLE", "vectory doctor", ""},
		{"full disk", &DiskFullError{Dir: "/anywhere", cause: syscall.ENOSPC}, "DISK_FULL", "run the check again", "next check-in"},
		{"anything else", fmt.Errorf("open /root/secret-path: permission denied"), "CHECK_UNAVAILABLE", "vectory doctor", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newCheckDevice(t)
			d.poll()
			d.driver.respond(func(checkedCandidate) (candidateRun, error) { return candidateRun{}, c.fail })
			res := d.checked(bad, false)
			diagnostics := diagnosticsOf(t, res)
			if res["valid"] != false || len(diagnostics) == 0 || diagnostics[0]["code"] != c.code {
				t.Fatalf("result %v", res)
			}
			hint, _ := diagnostics[0]["hint"].(string)
			if !strings.Contains(strings.ToLower(hint), strings.ToLower(c.hint)) || c.not != "" && strings.Contains(hint, c.not) {
				t.Fatalf("hint %q", hint)
			}
			encoded := string(mustJSON(t, res))
			if strings.Contains(encoded, "/root/secret-path") || strings.Contains(encoded, "/anywhere") {
				t.Fatalf("a path leaked: %s", encoded)
			}
			if left := d.staging(); len(left) != 0 {
				t.Fatalf("left %v", left)
			}
		})
	}
}

// A result never carries a secret value, a secret's file or Vector's output:
// the device-local value is removed from everything Vector prints, in every
// heartbeat that carries the result.
func TestAResultNeverCarriesASecretValueOrAFile(t *testing.T) {
	const secret = "planted-secret-9f2c41d7a8"
	d := newCheckDevice(t)
	d.poll()
	path := d.bind("API_TOKEN", secret)
	d.e.Settings.CapabilityPolicy.AllowedNetworkHosts = []string{"sink.example:443"}
	d.driver.respond(func(c checkedCandidate) (candidateRun, error) {
		if !bytes.Contains(c.Content, []byte(secret)) {
			t.Error("the staged copy lacks the device's secret: the check wouldn't be the apply's")
		}
		output := "x Sink \"out\": the header value " + secret + " is invalid for " + path + "\n" +
			"x Sink \"out\": Authorization: Bearer " + secret + "\n" +
			"~ Health checks are disabled\n"
		return candidateRun{}, &VectorFailure{Phase: "validate", Summary: "Vector rejected the configuration", Output: []byte(output)}
	})
	res := d.checked(secretTemplate("https://sink.example/events"), false)
	if res["valid"] != false || len(diagnosticsOf(t, res)) == 0 {
		t.Fatalf("result %v", res)
	}
	if !strings.Contains(string(mustJSON(t, res)), redactedToken) {
		t.Fatalf("the secret wasn't replaced by a mark: %s", mustJSON(t, res))
	}
	requireNoSecrets(t, d.plane, secret, path, filepath.Dir(path))
	// Diagnostics are findings parsed out of Vector's output, never the output
	// itself: a line the parser has no finding for isn't forwarded.
	for _, body := range d.plane.rawBodies() {
		if bytes.Contains(body, []byte("Health checks are disabled")) {
			t.Fatalf("Vector's output reached a heartbeat: %s", body)
		}
	}
}

// The files a check works with, and the directory they are in, are never named
// by path in a result: what Vector says about them reaches it as the apply's
// diagnostics show them, as the staged configuration and the host's runtime
// settings.
func TestAResultNeverNamesTheStagedFiles(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	d.driver.respond(func(c checkedCandidate) (candidateRun, error) {
		overlay := filepath.Join(filepath.Dir(c.Path), "host-runtime-stage-0123456789abcdef.json")
		output := "x Sink \"out\": cannot read " + c.Path + "\n" +
			"x Sink \"out\": cannot read " + overlay + "\n" +
			"x Sink \"out\": cannot create " + filepath.Dir(c.Path) + "\n"
		return candidateRun{}, &VectorFailure{Phase: "validate", Summary: "Vector rejected the configuration", Output: []byte(output)}
	})
	res := d.checked([]byte(`{"sources":{"synthetic":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["synthetic"]}}}`), false)
	if res["valid"] != false || len(diagnosticsOf(t, res)) == 0 {
		t.Fatalf("result %v", res)
	}
	encoded := string(mustJSON(t, res))
	for _, leaked := range []string{d.state, d.root, validationStagingName, ".vectory-stage-", "host-runtime-stage-"} {
		if strings.Contains(encoded, leaked) {
			t.Fatalf("the result names %q: %s", leaked, encoded)
		}
	}
	for _, label := range []string{"Cannot read staged configuration", "Cannot read host runtime settings"} {
		if !strings.Contains(encoded, label) {
			t.Fatalf("the result lacks %q: %s", label, encoded)
		}
	}
	for _, body := range d.plane.rawBodies() {
		if bytes.Contains(body, []byte(validationStagingName)) || bytes.Contains(body, []byte(d.root)) {
			t.Fatalf("a heartbeat names the check's directory: %s", body)
		}
	}
}

// What an old server, or one that doesn't list the feature, is sent: the
// original heartbeat, with nothing new in it, whatever it sends the agent.
func TestOldServersGetTheOriginalHeartbeatShape(t *testing.T) {
	original := []string{"protocol_version", "request_id", "nonce", "boot_id", "agent_version", "vector_version", "configuration_mode", "reported_generation", "policy_generation", "actual_sha256", "apply_state", "local_paused", "remote_pause_acknowledged", "error", "telemetry", "applied_template_sha256", "secret_revision", "configuration_attempt", "host_runtime", "vector_log_summary", "secret_names", "service_manager", "vector_running", "agent_sha256", "state_dir"}
	for name, features := range map[string][]string{
		"an older server that sends no features": nil,
		"a server with other features":           {featureWake, featureHostRuntime, featureSecretNames, featureDiagnostics},
	} {
		t.Run(name, func(t *testing.T) {
			d := newCheckDevice(t)
			d.e.State.ServerFeatures = features
			d.plane.with(func(m *Manifest) { m.Features = features })
			d.ask(newConfig, checkID, true) // a request the server never listed the feature for
			for i := 0; i < 3; i++ {
				d.poll()
			}
			for i, beat := range d.plane.sent() {
				for key := range beat {
					if !slices.Contains(original, key) {
						t.Fatalf("heartbeat %d carries %q, which isn't in the original shape", i, key)
					}
				}
			}
			if len(d.driver.checks()) != 0 {
				t.Fatal("a request the server didn't list the feature for was checked")
			}
		})
	}
}

// The announcements follow the manifest: every heartbeat carries them while the
// last manifest lists the feature, and none does once it stops.
func TestAnnouncementsFollowWhatTheManifestLists(t *testing.T) {
	d := newCheckDevice(t)
	for i := 0; i < 3; i++ {
		d.poll()
		beat := d.plane.last()
		if beat["agent_features"] == nil || beat["readiness"] == nil {
			t.Fatalf("heartbeat %d lacks the announcements: %v", i, beat)
		}
	}
	d.plane.with(func(m *Manifest) { m.Features = []string{featureWake} })
	d.poll() // still sent: the last manifest listed the feature
	d.poll()
	if beat := d.plane.last(); beat["agent_features"] != nil || beat["readiness"] != nil || beat["validation_result"] != nil {
		t.Fatalf("announcements after the server stopped listing the feature: %v", beat)
	}
}

// A server that refuses a heartbeat that carries a result as invalid (400) is
// not sent that result again: it is dropped and the check-in goes through at
// once without it, so one bad result can't keep a device from checking in.
func TestARefusedResultIsDroppedAndNeverResent(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	d.plane.mu.Lock()
	d.plane.answer = func(beat map[string]any) int {
		if beat["validation_result"] != nil {
			return http.StatusBadRequest
		}
		return 0
	}
	d.plane.mu.Unlock()
	d.ask(newConfig, checkID, false)
	d.poll() // the check
	before := len(d.plane.sent())
	d.poll() // refused with the result, answered without it
	beats := d.plane.sent()[before:]
	if len(beats) != 2 || beats[0]["validation_result"] == nil || beats[1]["validation_result"] != nil {
		t.Fatalf("the exchange was %d heartbeats: %v", len(beats), beats)
	}
	if beats[0]["nonce"] == beats[1]["nonce"] || beats[0]["request_id"] == beats[1]["request_id"] {
		t.Fatal("the retry reused the refused heartbeat's nonce or id")
	}
	if beats[1]["agent_features"] == nil || beats[1]["readiness"] == nil {
		t.Fatal("dropping the result also dropped the announcements")
	}
	if d.e.State.CheckInFailure != nil || d.e.validation.pending != nil || !d.e.validationAnswered(checkID) {
		t.Fatalf("the refusal wasn't absorbed: pending %v", d.e.validation.pending)
	}
	for i := 0; i < 3; i++ {
		d.poll()
		if result(d.plane.last()) != nil {
			t.Fatal("a refused result was sent again")
		}
	}
	if len(d.driver.checks()) != 1 {
		t.Fatalf("a request whose result was refused was checked again: %d", len(d.driver.checks()))
	}
}

// A server that refuses the announcements themselves gets none for the rest of
// this process, and the device keeps checking in.
func TestRefusedAnnouncementsAreNotSentAgain(t *testing.T) {
	d := newCheckDevice(t)
	d.plane.mu.Lock()
	d.plane.answer = func(beat map[string]any) int {
		if beat["agent_features"] != nil || beat["readiness"] != nil || beat["validation_result"] != nil {
			return http.StatusBadRequest
		}
		return 0
	}
	d.plane.mu.Unlock()
	d.poll()
	beats := d.plane.sent()
	if len(beats) != 2 || beats[0]["agent_features"] == nil || beats[1]["agent_features"] != nil || beats[1]["readiness"] != nil {
		t.Fatalf("heartbeats %v", beats)
	}
	if d.e.State.CheckInFailure != nil || !d.e.validation.optionalRefused {
		t.Fatal("the refusal wasn't absorbed")
	}
	d.poll()
	if len(d.plane.sent()) != 3 {
		t.Fatalf("%d heartbeats, want one more", len(d.plane.sent()))
	}
	// A refusal that has nothing to do with them is an ordinary failure.
	other := newCheckDevice(t)
	other.plane.mu.Lock()
	other.plane.answer = func(map[string]any) int { return http.StatusBadRequest }
	other.plane.mu.Unlock()
	if err := other.e.Poll(context.Background()); err == nil {
		t.Fatal("a refused heartbeat succeeded")
	}
	if other.e.validation.optionalRefused {
		t.Fatal("a refusal that wasn't about the announcements stopped them")
	}
}

// Whatever a check finds, what the apply path holds is as it was: the managed
// file, the journal, the last known good, the generations, the desired version
// and the verified outcome, and nothing the agent writes is left in the
// directories it works in. The check also leaves no note in Vector's local log.
func TestNoCheckChangesTheDevice(t *testing.T) {
	bad := []byte(`{"sources":{"synthetic":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["nope"]}}}`)
	cases := []struct {
		name string
		data []byte
		run  func(d *checkDevice)
	}{
		{"passing", newConfig, nil},
		{"failing validation", bad, func(d *checkDevice) {
			d.driver.respond(func(checkedCandidate) (candidateRun, error) {
				return candidateRun{}, &VectorFailure{Phase: "validate", Output: vectorFixture(t, "missing_input.validate.txt")}
			})
		}},
		{"missing secret", secretTemplate("https://sink.example/events"), nil},
		{"restricted-mode refusal", secretTemplate("https://not-approved.example/events"), func(d *checkDevice) { d.bind("API_TOKEN", "x") }},
		{"timeout", newConfig, func(d *checkDevice) {
			d.driver.respond(func(checkedCandidate) (candidateRun, error) {
				return candidateRun{}, &VectorFailure{Phase: "timeout", Summary: "Vector did not finish validating this version within 30 s."}
			})
		}},
		{"other failure", newConfig, func(d *checkDevice) {
			d.driver.respond(func(checkedCandidate) (candidateRun, error) { return candidateRun{}, os.ErrPermission })
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newCheckDevice(t)
			d.poll()
			if c.run != nil {
				c.run(d)
			}
			managedDir := filepath.Dir(d.managed)
			beforeState, beforeManaged := dirNames(t, d.state), dirNames(t, managedDir)
			before := d.snapshot()
			req := d.request(c.data, checkID, true)
			d.plane.offer(req.ArtifactPath, c.data)
			d.carry(req)
			manifest := d.plane.manifest
			manifest.IssuedAt = time.Now().UTC()
			parsed := validationRequest(manifest, d.e.now())
			if parsed == nil {
				t.Fatal("the request isn't one the agent acts on")
			}
			d.e.checkCandidate(context.Background(), parsed)
			if d.e.validation.pending == nil {
				t.Fatal("the check made no result")
			}
			if after := d.snapshot(); !reflect.DeepEqual(before, after) {
				t.Fatalf("the check changed the device:\n%v\n%v", before, after)
			}
			for _, dir := range []string{d.state, managedDir} {
				if left := leftovers(t, dir); len(left) != 0 {
					t.Fatalf("temporary files left in %s: %v", dir, left)
				}
			}
			if left := d.staging(); len(left) != 0 {
				t.Fatalf("left %v", left)
			}
			// What the state directory gained is only the memory of nothing: the
			// staging directory, and no other file. The managed directory gained nothing.
			if got := dirNames(t, managedDir); !reflect.DeepEqual(got, beforeManaged) {
				t.Fatalf("the managed directory changed: %v -> %v", beforeManaged, got)
			}
			for _, name := range dirNames(t, d.state) {
				if !slices.Contains(beforeState, name) && name != validationStagingName {
					t.Fatalf("a check left %s in the state directory", name)
				}
			}
			if _, err := os.Stat(filepath.Join(d.state, vectorLogName)); !os.IsNotExist(err) {
				t.Fatal("a check wrote Vector's local log")
			}
		})
	}
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// A result stays within the bounds the server's parser enforces, whatever
// Vector reports: at most 20 diagnostics (errors first), 100 tests (failing
// first), 64 secret names, each diagnostic under 512 bytes, test names under
// 200 bytes and messages under 512.
func TestAResultStaysWithinItsBounds(t *testing.T) {
	// Thirty sinks that each name an input that doesn't exist.
	sinks := map[string]any{}
	var output strings.Builder
	for i := 0; i < 30; i++ {
		id := fmt.Sprintf("sink_%02d", i)
		sinks[id] = map[string]any{"type": "blackhole", "inputs": []string{fmt.Sprintf("nope_%02d", i)}}
		fmt.Fprintf(&output, "x Input \"nope_%02d\" for sink \"%s\" doesn't match any components.\n", i, id)
	}
	// Tests: 130, in order, the last ten failing.
	var tests []any
	var testOutput strings.Builder
	testOutput.WriteString("Running tests\n")
	long := strings.Repeat("é", 150)
	for i := 0; i < 130; i++ {
		name := fmt.Sprintf("test %03d %s", i, long)
		tests = append(tests, map[string]any{"name": name})
		if i >= 120 {
			fmt.Fprintf(&testOutput, "test %s ... failed\n", name)
		} else {
			fmt.Fprintf(&testOutput, "test %s ... passed\n", name)
		}
	}
	d := newCheckDevice(t)
	d.poll()

	t.Run("diagnostics", func(t *testing.T) {
		data := mustJSONFor(map[string]any{"sources": map[string]any{"synthetic": map[string]any{"type": "demo_logs"}}, "sinks": sinks})
		d.driver.respond(func(checkedCandidate) (candidateRun, error) {
			return candidateRun{}, &VectorFailure{Phase: "validate", Output: []byte(output.String())}
		})
		res := d.checked(data, false)
		diagnostics := diagnosticsOf(t, res)
		if len(diagnostics) != maxValidationDiagnostics {
			t.Fatalf("%d diagnostics", len(diagnostics))
		}
		for _, diagnostic := range diagnostics {
			if len(mustJSON(t, diagnostic)) > maxDiagnosticBytes {
				t.Fatalf("a diagnostic is over %d bytes: %v", maxDiagnosticBytes, diagnostic)
			}
		}
	})

	t.Run("tests", func(t *testing.T) {
		d := newCheckDevice(t)
		d.poll()
		data := mustJSONFor(map[string]any{"sources": map[string]any{"synthetic": map[string]any{"type": "demo_logs"}}, "tests": tests})
		d.driver.respond(func(checkedCandidate) (candidateRun, error) {
			return candidateRun{TestsRan: true, TestOutput: []byte(testOutput.String())}, &VectorFailure{Phase: "test", Summary: "Vector configuration tests failed", Output: []byte(testOutput.String())}
		})
		res := d.checked(data, true)
		got := res["tests"].([]any)
		if len(got) != maxValidationTests {
			t.Fatalf("%d tests", len(got))
		}
		for i, item := range got {
			test := item.(map[string]any)
			name, _ := test["name"].(string)
			message, _ := test["message"].(string)
			if len(name) > maxTestName || len(message) > maxTestMessage {
				t.Fatalf("test %d name %d bytes, message %d bytes", i, len(name), len(message))
			}
			if (i < 10) == (test["passed"] == true) {
				t.Fatalf("failing tests come first: test %d is %v", i, test)
			}
		}
		if res["valid"] != false {
			t.Fatal("a failing test left the result valid")
		}
		if len(diagnosticsOf(t, res)) != 10 {
			t.Fatalf("the failing tests' diagnostics: %v", res["diagnostics"])
		}
	})

	t.Run("secret names", func(t *testing.T) {
		references := map[string]any{}
		for i := 0; i < 64; i++ {
			references[fmt.Sprintf("S%02d", i)] = map[string]any{"type": "http", "inputs": []string{"synthetic"}, "uri": "https://sink.example/events", "auth": map[string]string{"strategy": "bearer", "token": fmt.Sprintf("vectory-secret:NAME_%02d", i)}}
		}
		d := newCheckDevice(t)
		d.poll()
		res := d.checked(mustJSONFor(map[string]any{"sources": map[string]any{"synthetic": map[string]any{"type": "demo_logs"}}, "sinks": references}), false)
		names := res["secrets_missing"].([]any)
		if len(names) != maxSecretNames || !slices.IsSorted(toStrings(names)) {
			t.Fatalf("%d names, sorted %v", len(names), slices.IsSorted(toStrings(names)))
		}
	})

	// One more name than an agent resolves is a finding of its own, not a longer
	// list: the configuration can't be filled in, so no name is missing.
	t.Run("more secret names than a configuration may name", func(t *testing.T) {
		references := map[string]any{}
		for i := 0; i < maxSecretNames+1; i++ {
			references[fmt.Sprintf("S%02d", i)] = map[string]any{"type": "http", "inputs": []string{"synthetic"}, "uri": "https://sink.example/events", "auth": map[string]string{"strategy": "bearer", "token": fmt.Sprintf("vectory-secret:NAME_%02d", i)}}
		}
		d := newCheckDevice(t)
		d.poll()
		res := d.checked(mustJSONFor(map[string]any{"sources": map[string]any{"synthetic": map[string]any{"type": "demo_logs"}}, "sinks": references}), false)
		diagnostics := diagnosticsOf(t, res)
		if res["valid"] != false || len(res["secrets_missing"].([]any)) != 0 || len(diagnostics) != 1 || diagnostics[0]["code"] != "CONFIG_INVALID" ||
			diagnostics[0]["message"] != fmt.Sprintf("The configuration names more than %d device secrets.", maxSecretNames) {
			t.Fatalf("result %v", res)
		}
		if len(d.driver.checks()) != 0 || len(d.staging()) != 0 {
			t.Fatal("a configuration that can't be filled in was staged or checked")
		}
	})
}

func toStrings(values []any) []string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i], _ = v.(string)
	}
	return out
}
