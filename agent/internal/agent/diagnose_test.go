package agent

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func vectorFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "vector", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func testRedactor(config string) *redactor {
	r := newRedactor()
	r.learnConfiguration([]byte(config), false)
	r.addLabel("/etc/vectory/managed.json", "managed configuration")
	return r
}

func records(t *testing.T, name string) []vectorRecord {
	t.Helper()
	var out []vectorRecord
	scanner := bufio.NewScanner(strings.NewReader(string(vectorFixture(t, name))))
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		if rec, ok := parseVectorRecord(scanner.Bytes()); ok {
			out = append(out, rec)
		}
	}
	return out
}

func checkBounds(t *testing.T, diagnostics []Diagnostic) {
	t.Helper()
	if len(diagnostics) > maxDiagnostics {
		t.Fatalf("%d diagnostics exceed the bound", len(diagnostics))
	}
	for _, d := range diagnostics {
		encoded, _ := json.Marshal(d)
		if len(encoded) > maxDiagnosticBytes || utf8.RuneCountInString(d.Message) > maxDiagnosticMessage || d.Message == "" {
			t.Fatalf("diagnostic exceeds bounds: %s", encoded)
		}
		if d.Severity != "error" && d.Severity != "warning" {
			t.Fatalf("invalid severity: %s", encoded)
		}
	}
}

func TestValidateOutputBecomesStructuredDiagnostics(t *testing.T) {
	type want struct {
		code, kind, id, route, field, severity, reason string
		line, column                                   int
		message, hint                                  []string
	}
	cases := []struct {
		fixture, config string
		want            []want
		absent          []string
	}{
		{"datadir_missing.validate.txt", `{"sources":{"app":{"type":"demo_logs","format":"syslog"}},"sinks":{"out":{"type":"blackhole","inputs":["app"]}}}`,
			[]want{{code: "DATA_DIR_MISSING", field: "data_dir", message: []string{`"/var/lib/vector/" does not exist on this device`}, hint: []string{"Remove data_dir from the pipeline"}}}, nil},
		{"datadir_readonly.validate.txt", `{"data_dir":"/srv/vector/readonly","sources":{}}`,
			[]want{{code: "DATA_DIR_NOT_WRITABLE", field: "data_dir", message: []string{`"/srv/vector/readonly"`}}}, nil},
		{"datadir_readonly.validate.txt", `{"sources":{}}`,
			[]want{{code: "DATA_DIR_NOT_WRITABLE", message: []string{`"«redacted»"`}}}, []string{"/srv/vector"}},
		{"vrl_e103.validate.txt", `{"transforms":{"tag":{"type":"remap","inputs":["app"],"source":".env = \"prod\"\n.status_code = to_int(.status)"}}}`,
			[]want{{code: "VRL_E103", kind: "transform", id: "tag", field: "source", line: 2, column: 16,
				message: []string{"Unhandled fallible assignment", "this expression is fallible"}, hint: []string{"Try: .status_code, err = to_int(.status)"}}}, nil},
		{"route_fallible.validate.txt", `{"transforms":{"by_severity":{"type":"route","inputs":["app"],"route":{"errors":".status >= 500"}}}}`,
			[]want{
				{code: "VRL_E100", kind: "transform", id: "by_severity", route: "errors", field: "route.errors", line: 1, column: 1, message: []string{"Unhandled error", "expression can result in runtime error"}, hint: []string{"Handle the error case", "?? 0"}},
				{code: "OUTPUT_UNUSED", severity: "warning", id: "by_severity", route: "_unmatched", message: []string{"Nothing reads the _unmatched output of by_severity."}},
			}, nil},
		{"filter_bad.validate.txt", `{"transforms":{"keep":{"type":"filter","inputs":["app"],"condition":"parse_json(.message).level == \"error\""}}}`,
			[]want{{code: "VRL_E110", id: "keep", field: "condition", line: 1, column: 12, message: []string{"Invalid argument type: this expression resolves to any but the parameter \"value\" expects the exact type string"}, hint: []string{"Try: .message = string!(.message)"}}}, nil},
		{"multi.validate.txt", `{"transforms":{"a":{"type":"remap","inputs":["app"],"source":".x = to_int(.y)"},"b":{"type":"remap","inputs":["app"],"source":"del("}}}`,
			[]want{{code: "VRL_E103", id: "a"}, {code: "VRL_E204", id: "b", message: []string{"Syntax error", "unexpected end of program"}}, {code: "DATA_DIR_MISSING"}}, []string{"expected one of"}},
		{"vrl_syntax.validate.txt", `{"transforms":{"t":{"type":"remap","inputs":["app"],"source":".a = 1\n.b = ("}}}`,
			[]want{{code: "VRL_E204", id: "t", line: 2, column: 7}}, []string{"identifier"}},
		{"type_mismatch.validate.txt", `{"sources":{"app":{"type":"demo_logs"}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["app"]}}}`,
			[]want{{code: "EVENT_TYPE_MISMATCH", kind: "sink", id: "prom", field: "inputs", message: []string{"Event types don't match: app sends logs, but prom accepts only metrics."}}}, nil},
		{"missing_input.validate.txt", `{"sinks":{"out":{"type":"blackhole","inputs":["nope"]}}}`,
			[]want{{code: "INPUT_NOT_FOUND", kind: "sink", id: "out", field: "inputs", message: []string{`Input "nope" does not match any component.`}}}, nil},
		{"unknown_type.validate.txt", `{"sources":{"app":{"type":"demo_logz"}}}`,
			[]want{{code: "UNKNOWN_COMPONENT_TYPE", kind: "source", id: "app", field: "type", message: []string{"Unknown variant `demo_logz`"}}}, []string{"expected one of", "amqp"}},
		{"port_bad.validate.txt", `{"sources":{"h":{"type":"http_server","address":"127.0.0.1:99999"}}}`,
			[]want{{code: "INVALID_ADDRESS", kind: "source", id: "h", field: "address"}}, nil},
		{"tls_missing.validate.txt", `{"sinks":{"web":{"type":"http","uri":"https://127.0.0.1:1/ingest","tls":{"ca_file":"/nonexistent/ca.pem"}}}}`,
			[]want{{code: "TLS_FILE_UNREADABLE", kind: "sink", id: "web", field: "tls", message: []string{`"/nonexistent/ca.pem"`}}}, nil},
		{"env_missing.validate.txt", `{"sinks":{"web":{"type":"http","uri":"http://${NO_SUCH_VECTORY_VAR}/ingest"}}}`,
			[]want{{code: "ENV_VAR_MISSING", message: []string{`"NO_SUCH_VECTORY_VAR"`}}}, nil},
		{"es_health.validate.txt", `{"sinks":{"es":{"type":"elasticsearch","endpoints":["http://127.0.0.1:1"]}}}`,
			[]want{{code: "HEALTHCHECK_FAILED", severity: "warning", kind: "sink", id: "es", reason: "connection_refused", message: []string{"Health check failed: the destination refused the connection."}, hint: []string{"Vector still starts"}}}, nil},
		{"loki_dns.validate.txt", `{"sinks":{"lk":{"type":"loki","endpoint":"http://no-such-host.invalid:3100"}}}`,
			[]want{{code: "HEALTHCHECK_FAILED", severity: "warning", id: "lk", reason: "dns"}}, nil},
	}
	for _, c := range cases {
		t.Run(c.fixture, func(t *testing.T) {
			got := testRedactor(c.config).parseValidateOutput(vectorFixture(t, c.fixture))
			checkBounds(t, got)
			if len(got) != len(c.want) {
				t.Fatalf("got %d diagnostics, want %d: %+v", len(got), len(c.want), got)
			}
			for i, w := range c.want {
				d := got[i]
				if d.Code != w.code || w.kind != "" && d.ComponentKind != w.kind || w.id != "" && d.ComponentID != w.id || d.RouteOutput != w.route && w.route != "" ||
					w.field != "" && d.Field != w.field || w.line != 0 && (d.Line != w.line || d.Column != w.column) || w.reason != "" && d.Reason != w.reason {
					t.Fatalf("diagnostic %d = %+v, want %+v", i, d, w)
				}
				if severity := map[bool]string{true: w.severity, false: "error"}[w.severity != ""]; d.Severity != severity {
					t.Fatalf("severity %q, want %q", d.Severity, severity)
				}
				for _, part := range w.message {
					if !strings.Contains(d.Message, part) {
						t.Fatalf("message %q lacks %q", d.Message, part)
					}
				}
				for _, part := range w.hint {
					if !strings.Contains(d.Hint, part) {
						t.Fatalf("hint %q lacks %q", d.Hint, part)
					}
				}
			}
			encoded, _ := json.Marshal(got)
			for _, text := range append(c.absent, "\x1b[", "etc/vectory") {
				if strings.Contains(string(encoded), text) {
					t.Fatalf("diagnostics contain %q: %s", text, encoded)
				}
			}
		})
	}
}

func TestTestOutputNamesTheFailingAssertionWithoutPayloads(t *testing.T) {
	config := `{"transforms":{"tag":{"type":"remap","inputs":["app"],"source":".env = \"prod\""}},"tests":[{"name":"tags env","outputs":[{"extract_from":"tag","conditions":[{"type":"vrl","source":"assert_eq!(.env, \"staging\")"}]}]}]}`
	got := testRedactor(config).parseTestOutput(vectorFixture(t, "testfail.test.txt"))
	checkBounds(t, got)
	if len(got) != 1 || got[0].Code != "TEST_FAILED" || got[0].ComponentID != "tag" || got[0].Line != 1 {
		t.Fatalf("unexpected test diagnostics: %+v", got)
	}
	if want := `Test "tags env" failed: assertion failed: "prod" == "staging"`; got[0].Message != want {
		t.Fatalf("message %q, want %q", got[0].Message, want)
	}
	if strings.Contains(got[0].Message, "timestamp") {
		t.Fatal("test output payload leaked into diagnostics")
	}
}

func TestRuntimeLogsExplainStartAndReloadFailures(t *testing.T) {
	r := testRedactor(`{"sources":{"h":{"type":"http_server","address":"127.0.0.1:18777"}},"transforms":{"t":{"type":"remap","inputs":["app"],"source":".x = to_int(.status)"}}}`)
	port := r.parseRuntimeRecords(records(t, "portinuse.run.jsonl"))
	checkBounds(t, port)
	if len(port) != 1 || port[0].Code != "ADDRESS_IN_USE" || port[0].ComponentID != "h" || port[0].ComponentKind != "source" ||
		port[0].Message != "Another process is already listening on 127.0.0.1:18777." {
		t.Fatalf("port-in-use diagnostics: %+v", port)
	}
	reload := r.parseRuntimeRecords(records(t, "reload.run.jsonl"))
	if len(reload) == 0 || reload[0].Code != "VRL_E103" || reload[0].ComponentID != "t" || reload[0].Line != 1 || reload[0].Column != 6 {
		t.Fatalf("reload diagnostics: %+v", reload)
	}
	health := testRedactor(`{"sinks":{"es":{"type":"elasticsearch"}}}`).parseRuntimeRecords(records(t, "es_run.run.jsonl"))
	if len(health) == 0 || health[0].Code != "HEALTHCHECK_FAILED" || health[0].Severity != "warning" || health[0].ComponentID != "es" || health[0].Reason != "connection_refused" {
		t.Fatalf("runtime healthcheck diagnostics: %+v", health)
	}
	forged := []vectorRecord{
		{Level: "ERROR", Message: "Configuration error.", Error: "Transform \"t\": invented", Target: "vrl::stdlib::log::implementation", ComponentID: "t", ComponentKind: "transform", ComponentType: "remap"},
		{Level: "ERROR", Message: "Something went wrong.", Target: "vrl::stdlib::log::implementation", ComponentID: "t", ComponentKind: "transform", ComponentType: "remap"},
	}
	if out := r.parseRuntimeRecords(forged); len(out) != 0 {
		t.Fatalf("pipeline log() output became diagnostics: %+v", out)
	}
}

// Vector 0.58 without CAP_NET_BIND_SERVICE (recorded with setpriv
// --bounding-set=-net_bind_service): every restricted-mode listener on a port
// below 1024 fails with "Permission denied". That's the port, not a path.
func TestPrivilegedPortIsNotAPathProblem(t *testing.T) {
	previous := unprivilegedPortStart
	t.Cleanup(func() { unprivilegedPortStart = previous })
	unprivilegedPortStart = func() int { return 1024 }
	sink := `,"sinks":{"out":{"type":"blackhole","inputs":["in"]}}}`
	cases := []struct{ fixture, config, id, kind, addresses string }{
		{"privport_syslog_tcp.run.jsonl", `{"sources":{"sys":{"type":"syslog","mode":"tcp","address":"127.0.0.1:514"}}` + sink, "sys", "source", "127.0.0.1:514"},
		{"privport_syslog_udp.run.jsonl", `{"sources":{"sys":{"type":"syslog","mode":"udp","address":"127.0.0.1:514"}}` + sink, "sys", "source", "127.0.0.1:514"},
		{"privport_http.run.jsonl", `{"sources":{"web":{"type":"http_server","address":"0.0.0.0:80","decoding":{"codec":"json"}}}` + sink, "web", "source", "0.0.0.0:80"},
		{"privport_otel.run.jsonl", `{"sources":{"otel":{"type":"opentelemetry","grpc":{"address":"127.0.0.1:317"},"http":{"address":"127.0.0.1:318"}}}` + sink, "otel", "source", "127.0.0.1:317 and 127.0.0.1:318"},
		{"privport_prom.run.jsonl", `{"sources":{"m":{"type":"internal_metrics"}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["m"],"address":"127.0.0.1:998"}}}`, "prom", "sink", "127.0.0.1:998"},
	}
	for _, c := range cases {
		got := testRedactor(c.config).parseRuntimeRecords(records(t, c.fixture))
		checkBounds(t, got)
		if len(got) != 1 || got[0].Code != "PRIVILEGED_PORT" || got[0].ComponentID != c.id || got[0].ComponentKind != c.kind || got[0].Field != "address" ||
			got[0].Message != "Vector can't listen on "+c.addresses+": ports below 1024 need a privilege the service account lacks." ||
			!strings.Contains(got[0].Hint, "such as 1514") || !strings.Contains(got[0].Hint, "AmbientCapabilities=CAP_NET_BIND_SERVICE") {
			t.Errorf("%s: %+v", c.fixture, got)
		}
	}
	// macOS and Windows have no privileged ports, and neither has a Linux host
	// that lowered the limit: the cause is elsewhere.
	unprivilegedPortStart = func() int { return 0 }
	if got := testRedactor(cases[0].config).parseRuntimeRecords(records(t, cases[0].fixture)); len(got) != 1 || got[0].Code != "PERMISSION_DENIED" {
		t.Fatalf("no privileged ports: %+v", got)
	}
	unprivilegedPortStart = func() int { return 1024 }
	// A Unix socket that can't be created is a path problem.
	unix := []vectorRecord{{Level: "ERROR", Message: "Error binding socket.", Error: "Permission denied (os error 13)", ErrorCode: "socket_bind", Target: "vector::internal_events::socket", ComponentID: "sys", ComponentKind: "source", ComponentType: "syslog"}}
	if got := testRedactor(`{"sources":{"sys":{"type":"syslog","mode":"unix","path":"/run/app/syslog.sock"}}` + sink).parseRuntimeRecords(unix); len(got) != 1 || got[0].Code != "PERMISSION_DENIED" || !strings.Contains(got[0].Hint, "path") {
		t.Fatalf("unix socket: %+v", got)
	}
}

func TestCodeHintsFitTheHeartbeatBound(t *testing.T) {
	for code, hint := range codeHints {
		if n := utf8.RuneCountInString(hint); n > maxDiagnosticHint {
			t.Errorf("%s hint has %d characters, more than %d", code, n, maxDiagnosticHint)
		}
	}
}

// Native output is bounded before it is parsed; the bound must never leave a
// partial line (and so a partial secret) behind.
func TestBoundedOutputNeverKeepsAPartialSecret(t *testing.T) {
	secret := "CorrectHorseBattery9"
	r := newRedactor()
	r.learnConfiguration([]byte(`{"sinks":{"out":{"type":"http","inputs":["in"],"uri":"https://example.invalid","encoding":{"codec":"json"},"auth":{"strategy":"basic","user":"svc","password":"`+secret+`"}}}}`), false)
	line := "x Sink \"out\": rejected credential password=" + secret + "\n"
	for cut := len(line) - len(secret) - 2; cut < len(line); cut++ {
		w := &limitedWriter{max: 64 + cut}
		_, _ = w.Write([]byte(strings.Repeat("-", 63) + "\n"))
		_, _ = w.Write([]byte(line))
		_, _ = w.Write([]byte("more output\n"))
		if strings.Contains(w.b.String(), secret[:4]) {
			t.Fatalf("cut at %d kept a partial line: %q", cut, w.b.String())
		}
		for _, d := range r.parseValidateOutput(w.b.Bytes()) {
			if strings.Contains(d.Message, secret[:4]) {
				t.Fatalf("partial secret in diagnostics: %q", d.Message)
			}
		}
	}
	whole := &limitedWriter{max: 1024}
	_, _ = whole.Write([]byte("a\nb"))
	if whole.b.String() != "a\nb" {
		t.Fatal("output under the bound must be kept as is")
	}
}

func TestCredentialsUnderFourBytesAreRedactedAsWholeWords(t *testing.T) {
	r := newRedactor()
	r.learnConfiguration([]byte(`{"sinks":{"out":{"type":"http","inputs":["in"],"uri":"https://example.invalid","encoding":{"codec":"json"},"auth":{"strategy":"basic","user":"ops","password":"k9x"}}}}`), false)
	got := r.text("authentication failed for ops with k9x, retry (k9x) k9xyz")
	// The credential goes wherever it stands alone. The same letters inside
	// other words stay, so ordinary messages are not mangled.
	want := "authentication failed for " + redactedToken + " with " + redactedToken + ", retry (" + redactedToken + ") k9xyz"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if !r.containsSecret("k9x") || r.containsSecret("k9xyz") {
		t.Fatal("a short credential overlaps only as a whole word")
	}
	one := newRedactor()
	one.addSecret("7")
	if got := one.text("port 87 attempt 7 of 9 _7"); got != "port 87 attempt "+redactedToken+" of 9 _7" {
		t.Fatalf("single character credential: %q", got)
	}
	// A skipped match keeps its left context: "abab" is one word.
	ab := newRedactor()
	ab.addSecret("ab")
	for input, want := range map[string]string{
		"abab":    "abab",
		"ababab":  "ababab",
		"xab ab":  "xab " + redactedToken,
		"ab-ab":   redactedToken + "-" + redactedToken,
		"ab_ab":   "ab_ab",
		"(ab)":    "(" + redactedToken + ")",
		"abab ab": "abab " + redactedToken,
	} {
		if got := ab.text(input); got != want {
			t.Errorf("text(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestRedactionEchoesOnlyTemplateTokens(t *testing.T) {
	config := `{"data_dir":"/srv/vector/data","sinks":{"es":{"type":"elasticsearch","endpoints":["https://logs.example.com:9200"],"auth":{"strategy":"basic","user":"svc","password":"hunter2-resolved-secret"}}},"transforms":{"parse":{"type":"remap","source":". = parse_apache_log!(.message, format: \"common\")"}}}`
	r := testRedactor(config)
	t.Setenv("VECTORY_TEST_TOKEN", "env-derived-value")
	for input, want := range map[string]string{
		`password "hunter2-resolved-secret" rejected`:                    `password "«redacted»" rejected`,
		`auth failed for hunter2-resolved-secret@host`:                   `auth failed for «redacted»@host`,
		`Could not open "/srv/vector/data"`:                              `Could not open "/srv/vector/data"`,
		`Could not open "/home/alice/private.pem"`:                       `Could not open "«redacted»"`,
		`endpoint https://logs.example.com:9200 unreachable`:             `endpoint https://logs.example.com:9200 unreachable`,
		`endpoint https://10.2.3.4:9200 unreachable`:                     `endpoint «redacted» unreachable`,
		`peer 10.2.3.4:9200 reset`:                                       `peer «redacted» reset`,
		`token AKIAIOSFODNN7EXAMPLEKEY12345 invalid`:                     `token «redacted» invalid`,
		`at parse_apache_log!(.message, format: "common")`:               `at parse_apache_log!(.message, format: "common")`,
		`wrote /etc/vectory/managed.json`:                                `wrote managed configuration`,
		`mail admin@example.org`:                                         `mail «redacted»`,
		"\x1b[31mred\x1b[0m text":                                        "red text",
		`staged /etc/vectory/.vectory-stage-0123abcd.json failed`:        `staged staged configuration failed`,
		`read /var/lib/vectory/host-runtime-stage-0123456789abcdef.json`: `read host runtime settings`,
	} {
		if got := r.text(input); got != want {
			t.Errorf("text(%q) = %q, want %q", input, got, want)
		}
	}
	full := newRedactor()
	full.learnConfiguration([]byte(`{"sinks":{"web":{"type":"http","uri":"https://${VECTORY_TEST_TOKEN}.example"}}}`), true)
	if got := full.text("GET env-derived-value failed"); got != "GET «redacted» failed" {
		t.Fatalf("referenced environment value not scrubbed: %q", got)
	}
	if got := r.identifier("svc"); got != "" {
		t.Fatal("credential leaf accepted as an identifier")
	}
	long := r.finalize(Diagnostic{Code: "VALIDATION_ERROR", Message: strings.Repeat("word ", 400), Hint: strings.Repeat("hint ", 200), Field: strings.Repeat("f", 400)})
	checkBounds(t, []Diagnostic{long})
}

func TestNetworkErrorsHaveBoundedReasons(t *testing.T) {
	for text, want := range map[string]string{
		"error trying to connect: tcp connect error: Connection refused (os error 111)": "connection_refused",
		"dns error: failed to lookup address information: Name or service not known":    "dns",
		"invalid peer certificate: UnknownIssuer":                                       "tls",
		"operation timed out":                                     "timeout",
		"connection reset by peer":                                "connection_reset",
		"Server responded with an error: 503 Service Unavailable": "http_503",
		"Http status: 401":                                        "http_401",
		"TcpBind { source: Os { code: 98, kind: AddrInUse, message: \"Address already in use\" }": "address_in_use",
		"something else": "",
	} {
		if got := classifyNetwork(text); got != want {
			t.Errorf("classifyNetwork(%q) = %q, want %q", text, got, want)
		}
	}
}

func TestSecretFailuresNameTheReferenceButNeverThePathOrValue(t *testing.T) {
	dir := privateTempDir(t)
	secretPath := filepath.Join(dir, "es-password")
	template := []byte(`{"sinks":{"es":{"type":"elasticsearch","endpoints":["https://es.example:9200"],"auth":{"strategy":"basic","user":"svc","password":"vectory-secret:es_password"}}}}`)
	e := &Engine{Dir: dir, Settings: Settings{ManagedConfig: filepath.Join(dir, "managed.json")}}
	for _, c := range []struct {
		bindings map[string]string
		code     string
	}{
		{map[string]string{}, "SECRET_BINDING_MISSING"},
		{map[string]string{"es_password": secretPath}, "SECRET_FILE_UNREADABLE"},
	} {
		_, _, err := resolveLocalSecrets(template, c.bindings, false)
		got := e.secretDiagnostics(err, template)
		if len(got) != 1 || got[0].Code != c.code || got[0].ComponentID != "es" || got[0].Field != "auth.password" || !strings.Contains(got[0].Message, `"es_password"`) {
			t.Fatalf("%s: %+v", c.code, got)
		}
		encoded, _ := json.Marshal(got)
		if strings.Contains(string(encoded), dir) {
			t.Fatalf("secret file path leaked: %s", encoded)
		}
	}
	if got := e.secretDiagnostics(errors.New("other"), template); got != nil {
		t.Fatal("unrelated errors must not produce secret diagnostics")
	}
}

func TestDiagnosticSetKeepsErrorsFirstAndBounded(t *testing.T) {
	var set diagnosticSet
	r := newRedactor()
	set.add(r.finalize(Diagnostic{Severity: "warning", Code: "W", Message: "warning"}))
	for i := 0; i < 15; i++ {
		set.add(r.finalize(Diagnostic{Code: "E", Message: "error " + string(rune('a'+i))}))
		set.add(r.finalize(Diagnostic{Code: "E", Message: "error " + string(rune('a'+i))}))
	}
	got := set.result()
	if len(got) != maxDiagnostics || got[0].Severity != "error" {
		t.Fatalf("unexpected bounded set: %+v", got)
	}
	for _, d := range got {
		if d.Severity == "warning" {
			t.Fatal("warning displaced an error")
		}
	}
}
