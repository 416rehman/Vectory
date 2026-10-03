package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// serverAcceptsDiagnostic mirrors the bounds the server puts on every
// diagnostic of a heartbeat (server/src/configuration_attempt.rs). A diagnostic
// that breaks one gets the whole heartbeat refused, so the agent must never
// send it. The rule for an ID is reportableID, which the shared fixture
// component-ids.json pins to the server's, and the size is measured as the
// server measures it (diagnosticBytes, pinned by report-bounds.json).
func serverAcceptsDiagnostic(d Diagnostic) error {
	asciiToken := func(value string, max int, extra string) bool {
		if value == "" || len(value) > max {
			return false
		}
		for _, b := range []byte(value) {
			if !(b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || strings.IndexByte(extra, b) >= 0) {
				return false
			}
		}
		return true
	}
	text := func(value string, min, max int) bool {
		n := utf8.RuneCountInString(value)
		return n >= min && n <= max && strings.IndexFunc(value, unicode.IsControl) < 0
	}
	switch {
	case d.Severity != "error" && d.Severity != "warning":
		return fmt.Errorf("severity %q", d.Severity)
	case !asciiToken(d.Code, 48, "_") || d.Code != strings.ToUpper(d.Code):
		return fmt.Errorf("code %q", d.Code)
	case d.ComponentKind != "" && d.ComponentKind != "source" && d.ComponentKind != "transform" && d.ComponentKind != "sink":
		return fmt.Errorf("component kind %q", d.ComponentKind)
	case d.ComponentID != "" && !reportableID(d.ComponentID):
		return fmt.Errorf("component ID %q", d.ComponentID)
	case d.RouteOutput != "" && !reportableID(d.RouteOutput):
		return fmt.Errorf("route output %q", d.RouteOutput)
	case d.Field != "" && !text(d.Field, 1, 128):
		return fmt.Errorf("field %q", d.Field)
	case !text(d.Message, 1, 300):
		return fmt.Errorf("message %q", d.Message)
	case d.Hint != "" && !text(d.Hint, 1, 200):
		return fmt.Errorf("hint %q", d.Hint)
	case diagnosticBytes(d) > 512:
		return fmt.Errorf("%d bytes", diagnosticBytes(d))
	}
	return nil
}

var allowEverything = CapabilityPolicy{
	AllowedFileRoots:       []string{"/var/log", "/var/lib/vectory-agent"},
	AllowedNetworkHosts:    []string{"127.0.0.1:8686", "localhost:8686"},
	AllowedListenAddresses: []string{"127.0.0.1:8686", "0.0.0.0:8686", "[::1]:8686", "localhost:8686"},
}

// Vector's API has no authentication: while it is open, any user on the host
// can read every component's live events. A pipeline can't open it in
// restricted mode, with any address or none, whatever the host allows. The
// host's allowances don't cover it: no `vectory allow` flag names it.
func TestRestrictedModeRefusesTheLocalAPI(t *testing.T) {
	pipeline := `,"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}`
	for name, api := range map[string]string{
		"enabled on loopback":      `{"enabled":true,"address":"127.0.0.1:8686"}`,
		"enabled on IPv6 loopback": `{"enabled":true,"address":"[::1]:8686"}`,
		"enabled on the default":   `{"enabled":true}`,
		"enabled on every address": `{"enabled":true,"address":"0.0.0.0:8686"}`,
		"disabled":                 `{"enabled":false}`,
		"disabled with an address": `{"enabled":false,"address":"0.0.0.0:8686"}`,
		"empty":                    `{}`,
		"null":                     `null`,
		"not an object":            `true`,
	} {
		t.Run(name, func(t *testing.T) {
			config := `{"api":` + api + pipeline + `}`
			for policyName, p := range map[string]CapabilityPolicy{"no allowances": {}, "every allowance": allowEverything} {
				var refusal *PolicyRefusal
				if err := p.Check([]byte(config)); !errors.As(err, &refusal) || refusal.Code != "LOCAL_API_DENIED" || refusal.Field != "api" {
					t.Fatalf("%s: got %v", policyName, err)
				}
				d := refusal.Diagnostic()
				if d.Code != "LOCAL_API_DENIED" || d.Field != "api" || d.ComponentID != "" {
					t.Fatalf("%s: %+v", policyName, d)
				}
				if err := serverAcceptsDiagnostic(refusal.Diagnostic()); err != nil {
					t.Fatalf("the server would refuse this diagnostic: %v", err)
				}
			}
			// The host that runs full mode trusts its publishers with everything
			// Vector can do, so nothing changes there.
			if err := (CapabilityPolicy{FullVectorConfig: true}).Check([]byte(config)); err != nil {
				t.Fatalf("full mode: %v", err)
			}
		})
	}
	// Pipelines without the block are unaffected.
	if err := (CapabilityPolicy{}).Check([]byte(`{` + strings.TrimPrefix(pipeline, ",") + `}`)); err != nil {
		t.Fatalf("a pipeline without api: %v", err)
	}
}

// The refusal says why, and what to do: remove the block or use a full-mode
// device, and that no host allowance changes it.
func TestTheLocalAPIRefusalSaysWhyAndWhatToDo(t *testing.T) {
	err := (CapabilityPolicy{}).Check([]byte(`{"api":{"enabled":true,"address":"127.0.0.1:8686"}}`))
	var refusal *PolicyRefusal
	if !errors.As(err, &refusal) {
		t.Fatalf("not a refusal: %v", err)
	}
	d := refusal.Diagnostic()
	if d.Message != `The pipeline has an "api" block. Vector's local API has no authentication, so any user on this host could read live events from it, and restricted mode never allows it.` {
		t.Errorf("message: %s", d.Message)
	}
	if d.Hint != `Remove the api block, or deploy to a full-mode device. No host allowance can permit it.` {
		t.Errorf("hint: %s", d.Hint)
	}
	// The status and doctor commands name the same reason.
	local := capabilityDiagnostic(err.Error())
	if local.Reason != "LOCAL_API_DENIED" || !strings.Contains(local.NextAction, "full mode") {
		t.Errorf("local diagnostic: %+v", local)
	}
}

// The refusal names the component and what is wrong with its ID, and says what
// to do and why; the status and doctor commands name the same reason.
func TestTheComponentIDRefusalSaysWhyAndWhatToDo(t *testing.T) {
	err := (CapabilityPolicy{FullVectorConfig: true}).Check([]byte(`{"sinks":{"/tmp/x":{"type":"blackhole","inputs":["in"]}}}`))
	var refusal *PolicyRefusal
	if !errors.As(err, &refusal) {
		t.Fatalf("not a refusal: %v", err)
	}
	d := refusal.Diagnostic()
	if d.Message != `Sink "/tmp/x" (blackhole) has a slash in its ID.` {
		t.Errorf("message: %s", d.Message)
	}
	if d.Hint != "Rename it and the inputs that name it. Vector uses an ID as a directory name in its data directory, so it can't be a path." {
		t.Errorf("hint: %s", d.Hint)
	}
	local := capabilityDiagnostic(err.Error())
	if local.Reason != "INVALID_COMPONENT_ID" || !strings.Contains(local.NextAction, "every mode") || strings.Contains(local.NextAction, "restricted policy") {
		t.Errorf("local diagnostic: %+v", local)
	}
}

// vectory status ends with the next step. For the two refusals no host
// allowance can lift, it must not send the operator looking for an allowance.
func TestTheNextStepForARefusalNoAllowanceCanLiftDoesNotPointAtAnAllowance(t *testing.T) {
	refused := func(code string) State {
		return State{LastGoodSHA256: "a", Error: &Issue{Code: "CAPABILITY_DENIED", Diagnostics: []Diagnostic{{Code: code, Severity: "error"}}}}
	}
	api := applyNextAction("", refused("LOCAL_API_DENIED"))
	id := applyNextAction("", refused("INVALID_COMPONENT_ID"))
	for name, next := range map[string]string{"api": api, "component ID": id} {
		if strings.Contains(next, "Allow what the problem names") || !strings.HasSuffix(next, "Vector keeps running the last working configuration.") {
			t.Errorf("%s: %q", name, next)
		}
	}
	if !strings.Contains(api, "Remove the api block") || !strings.Contains(api, "full mode") || !strings.Contains(api, "No allowance can permit it") {
		t.Errorf("api: %q", api)
	}
	if !strings.Contains(id, "Rename the component") || !strings.Contains(id, "No setting on this host can allow an ID that is a path") {
		t.Errorf("component ID: %q", id)
	}
	// Any other capability refusal still says to allow what it names.
	other := State{LastGoodSHA256: "a", Error: &Issue{Code: "CAPABILITY_DENIED", Diagnostics: []Diagnostic{{Code: "LISTENER_DENIED", Severity: "error"}}}}
	if next := applyNextAction("", other); !strings.HasPrefix(next, "Allow what the problem names on this host") {
		t.Errorf("other: %q", next)
	}
}

// Vector joins a component's ID onto its data_dir for checkpoints and disk
// buffers, so an absolute path replaces the directory. Both modes refuse an ID
// that could be a path: it is a containment rule, not a capability.
func TestComponentIDsMustBePlainNames(t *testing.T) {
	build := func(section, id string) []byte {
		typ := map[string]string{"sources": "demo_logs", "transforms": "remap", "sinks": "blackhole"}[section]
		config, _ := json.Marshal(map[string]any{section: map[string]any{id: map[string]any{"type": typ}}})
		return config
	}
	hostile := map[string]string{
		"/tmp/x":                "a slash in its ID",
		"a/b":                   "a slash in its ID",
		"../x":                  "a slash in its ID",
		"C:/x":                  "a slash in its ID",
		`C:\x`:                  "a backslash in its ID",
		`\\server\share\x`:      "a backslash in its ID",
		`a\b`:                   "a backslash in its ID",
		"a\nb":                  "a control character in its ID",
		"a\x00b":                "a control character in its ID",
		"a\x1bb":                "a control character in its ID",
		"\x7f":                  "a control character in its ID",
		"a\u0085b":              "a control character in its ID",
		"\x1b[2J/tmp/hidden":    "a slash in its ID",
		"safe-looking\u0007bel": "a control character in its ID",
		// On Windows a drive prefix replaces the data directory, as an absolute
		// path does. The server can't know the host's system, so the rule holds
		// on every host.
		"C:x": "a drive letter and colon at the start of its ID",
		"d:":  "a drive letter and colon at the start of its ID",
		"Z:y": "a drive letter and colon at the start of its ID",
	}
	modes := map[string]CapabilityPolicy{"restricted": {}, "full": {FullVectorConfig: true}, "restricted with every allowance": allowEverything}
	for id, problem := range hostile {
		for _, section := range []string{"sources", "transforms", "sinks"} {
			for mode, p := range modes {
				var refusal *PolicyRefusal
				err := p.Check(build(section, id))
				if !errors.As(err, &refusal) || refusal.Code != "INVALID_COMPONENT_ID" {
					t.Errorf("%s %q in %s: got %v", mode, id, section, err)
					continue
				}
				if refusal.Section != section || refusal.ComponentID != id || refusal.problem != problem {
					t.Errorf("%s %q in %s: %+v", mode, id, section, refusal)
				}
				d := refusal.Diagnostic()
				if err := serverAcceptsDiagnostic(d); err != nil {
					t.Errorf("%s %q in %s: the server would refuse this diagnostic: %v\n%+v", mode, id, section, err, d)
				}
				if !strings.HasSuffix(d.Message, " has "+problem+".") || !strings.Contains(d.Hint, "Rename it") {
					t.Errorf("%s %q in %s: %+v", mode, id, section, d)
				}
			}
		}
	}
	// Ordinary names go through, in both modes: the rule adds nothing beyond
	// what lets an ID leave the data directory. Vector accepts the rest, and so
	// does the server (its tests pin the same list).
	for _, id := range []string{
		"in", "my-source_2", "Edge Logs", "café", "ab:c", "UPPER", "x", strings.Repeat("a", 128),
		"with space", "-leading-dash", "star*", "bracket[0]", "colon:name", "cc:x", "1:x", "é:x", " c:x",
		"a,b", "a$b", "a{b}", "100%", `a"b`, "a'b", "UPPER_lower-123",
	} {
		for mode, p := range modes {
			for _, section := range []string{"sources", "transforms", "sinks"} {
				var refusal *PolicyRefusal
				if err := p.Check(build(section, id)); errors.As(err, &refusal) && refusal.Code == "INVALID_COMPONENT_ID" {
					t.Errorf("%s refused the ordinary ID %q", mode, id)
				}
			}
		}
	}
	// Full mode defers everything else to Vector, including a section that is
	// not an object.
	for _, config := range []string{`{"sources":[]}`, `{"sinks":"x"}`, `{"transforms":{"t":5}}`, `{}`} {
		if err := (CapabilityPolicy{FullVectorConfig: true}).Check([]byte(config)); err != nil {
			t.Errorf("full mode %s: %v", config, err)
		}
	}
}

// The ID rule is judged before anything else, so one answer comes back for a
// pipeline with several problems, and it is the one that names the component.
func TestAComponentIDIsRefusedBeforeAnythingElse(t *testing.T) {
	config := `{"api":{"enabled":true},"data_dir":"relative","sources":{"/etc/x":{"type":"exec","command":["id"]}},"sinks":{"out":{"type":"aws_s3"}}}`
	var refusal *PolicyRefusal
	if err := (CapabilityPolicy{}).Check([]byte(config)); !errors.As(err, &refusal) || refusal.Code != "INVALID_COMPONENT_ID" || refusal.ComponentID != "/etc/x" {
		t.Fatalf("got %v", err)
	}
}

// Windows reads `C:name` as a path on drive C that replaces the data
// directory, so an ID that starts with a drive letter and a colon is refused.
// The server refuses exactly the same (an ASCII letter, then a colon, at the
// start), so the test spells the rule out: only the start of the ID counts,
// and only an ASCII letter.
func TestADriveLetterAndColonAtTheStartOfAComponentIDIsRefused(t *testing.T) {
	for _, id := range []string{"C:x", "c:x", "d:", "Z:", "z:y", "A:1"} {
		if got := componentIDProblem(id); got != "a drive letter and colon at the start of its ID" {
			t.Errorf("%q: %q", id, got)
		}
		if !driveLetterPrefix.MatchString(id) {
			t.Errorf("%q does not match ^[A-Za-z]:", id)
		}
	}
	for _, id := range []string{"ab:c", "cc:x", "1:x", "_:x", "é:x", "x", "kafka:orders", ":x", " c:x", "a b:c"} {
		if got := componentIDProblem(id); got != "" {
			t.Errorf("%q: %q", id, got)
		}
	}
	// The rule is the regular expression, nothing more.
	if driveLetterPrefix.String() != "^[A-Za-z]:" {
		t.Errorf("the drive prefix rule is %q", driveLetterPrefix)
	}
	// A separator or a control character is refused anywhere in the ID.
	for _, id := range []string{"a/b", `a\b`, "a\tb", "/", `\`, "\x00"} {
		if componentIDProblem(id) == "" {
			t.Errorf("%q passed", id)
		}
	}
	if componentIDProblem("ordinary-name_1") != "" {
		t.Error("an ordinary name was refused")
	}
}

// A memory enrichment table is a component too: with inputs it is a sink
// named by the table, and its source_key names a source of its own. Both are
// held to the rule, in the cases the server checks, and nothing else about an
// enrichment table is judged here: restricted mode refuses the section as a
// whole, and full mode leaves it to Vector.
func TestMemoryTableNamesAreHeldToTheRule(t *testing.T) {
	memory := func(table, key string, inputs bool) []byte {
		body := map[string]any{"type": "memory", "source_config": map[string]any{"source_key": key, "export_interval": 5}}
		if inputs {
			body["inputs"] = []string{"in"}
		}
		config, _ := json.Marshal(map[string]any{
			"sources":           map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json"}},
			"enrichment_tables": map[string]any{table: body},
		})
		return config
	}
	for _, p := range []CapabilityPolicy{{}, {FullVectorConfig: true}} {
		mode := p.ConfigurationMode()
		for _, tc := range []struct {
			name        string
			config      []byte
			section, id string
			refused     bool
		}{
			{"a table name that is a path, with inputs", memory("a/b", "export", true), "sinks", "a/b", true},
			{"a table name that is a drive path, with inputs", memory("C:x", "export", true), "sinks", "C:x", true},
			{"a source key that is a path", memory("cache", "/tmp/x", false), "sources", "/tmp/x", true},
			{"a source key with a backslash, beside inputs", memory("cache", `e\x`, true), "sources", `e\x`, true},
			{"a source key with a control character", memory("cache", "e\nx", false), "sources", "e\nx", true},
			{"a table name that is a path, without inputs, is not a component", memory("a/b", "export", false), "", "", false},
			{"ordinary names", memory("cache", "export", true), "", "", false},
		} {
			var refusal *PolicyRefusal
			err := p.Check(tc.config)
			if tc.refused {
				if !errors.As(err, &refusal) || refusal.Code != "INVALID_COMPONENT_ID" || refusal.Section != tc.section || refusal.ComponentID != tc.id || refusal.ComponentType != "memory" {
					t.Errorf("%s, %s: got %v %+v", mode, tc.name, err, refusal)
					continue
				}
				d := refusal.Diagnostic()
				if err := serverAcceptsDiagnostic(d); err != nil {
					t.Errorf("%s, %s: the server would refuse this diagnostic: %v\n%+v", mode, tc.name, err, d)
				}
				if kind := map[string]string{"sinks": "Sink", "sources": "Source"}[tc.section]; !strings.HasPrefix(d.Message, kind+` "`) || !strings.Contains(d.Message, "(memory)") {
					t.Errorf("%s, %s: %s", mode, tc.name, d.Message)
				}
			} else if errors.As(err, &refusal) && refusal.Code == "INVALID_COMPONENT_ID" {
				t.Errorf("%s, %s: refused: %+v", mode, tc.name, refusal)
			}
		}
	}
}

// What the refusal sends to the server stays inside its bounds for any ID, and
// still names the component: a control character is shown as an escape, a very
// long ID is cut, and an ID that is not a token is left out of component_id.
func TestComponentIDRefusalsFitTheServerForAnyID(t *testing.T) {
	long := "/" + strings.Repeat("directory/", 40)
	for _, id := range []string{"/tmp/x", "a\nb", "\x1b[31m/tmp/red\x1b[0m", "x\u0007y/z", long, "C:\\Windows\\System32", "a/\u2028b"} {
		config, _ := json.Marshal(map[string]any{"sinks": map[string]any{id: map[string]any{"type": "blackhole", "inputs": []string{}}}})
		for _, full := range []bool{false, true} {
			e := &Engine{Settings: Settings{CapabilityPolicy: CapabilityPolicy{FullVectorConfig: full}}}
			err := e.Settings.CapabilityPolicy.Check(config)
			diagnostics := e.policyDiagnostics(err, config)
			if len(diagnostics) != 1 {
				t.Fatalf("%q: %+v", id, diagnostics)
			}
			d := diagnostics[0]
			if err := serverAcceptsDiagnostic(d); err != nil {
				t.Errorf("%q (full=%v): the server would refuse this diagnostic: %v\n%+v", id, full, err, d)
			}
			if d.ComponentID != "" || d.ComponentKind != "sink" || !strings.HasPrefix(d.Message, `Sink "`) || strings.Contains(d.Message, redactedToken) {
				t.Errorf("%q (full=%v): %+v", id, full, d)
			}
		}
	}
	// The component's type comes from the same pipeline, so it can be anything
	// too: the diagnostic still fits, and still says what is wrong with the ID.
	for _, typ := range []string{"a\nb", "\x1b[31mred", strings.Repeat("t", 5000), "naïve type"} {
		config, _ := json.Marshal(map[string]any{"sinks": map[string]any{"/tmp/x": map[string]any{"type": typ, "inputs": []string{}}}})
		e := &Engine{}
		diagnostics := e.policyDiagnostics((CapabilityPolicy{FullVectorConfig: true}).Check(config), config)
		if len(diagnostics) != 1 {
			t.Fatalf("type %q: %+v", typ, diagnostics)
		}
		d := diagnostics[0]
		if err := serverAcceptsDiagnostic(d); err != nil {
			t.Errorf("type %q: the server would refuse this diagnostic: %v\n%+v", typ, err, d)
		}
		if !strings.HasPrefix(d.Message, `Sink "/tmp/x" (`) || !strings.HasSuffix(d.Message, " has a slash in its ID.") {
			t.Errorf("type %q: the message lost what is wrong with the ID: %q", typ, d.Message)
		}
	}
	if got := shortID("x\u0007y\nz"); got != `x\x07y\x0az` {
		t.Errorf("escapes: %q", got)
	}
	if got := shortID("plain-name"); got != "plain-name" {
		t.Errorf("a plain name changed: %q", got)
	}
}
