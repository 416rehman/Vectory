package agent

import (
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Every restricted-mode refusal names the component, the exact resource and
// the allowance line that would permit it.
func TestPolicyRefusalsSayWhatWasRefusedAndHowToAllowIt(t *testing.T) {
	p := CapabilityPolicy{}
	cases := []struct {
		name, config, code, message, hint string
	}{
		{"destination", `{"sinks":{"out":{"type":"http","inputs":["in"],"uri":"http://127.0.0.1:9/x"}}}`, "NETWORK_DESTINATION_DENIED",
			`Sink "out" (http) sends to 127.0.0.1:9, which this host hasn't approved.`, `Add "127.0.0.1:9" to allowed_network_hosts on the host`},
		{"listener", `{"sources":{"in":{"type":"http_server","address":"0.0.0.0:8080"}}}`, "LISTENER_DENIED",
			`Source "in" (http_server) listens on 0.0.0.0:8080, which this host hasn't approved.`, `Add "0.0.0.0:8080" to allowed_listen_addresses`},
		{"file pattern", `{"sources":{"logs":{"type":"file","include":["/var/log/app/*.log"]}}}`, "FILE_ACCESS_DENIED",
			`Source "logs" (file) uses /var/log/app/*.log, outside this host's allowed file roots.`, `Add "/var/log/app" to allowed_file_roots`},
		{"data_dir", `{"data_dir":"/srv/vector/"}`, "FILE_ACCESS_DENIED",
			`The pipeline uses /srv/vector/, outside this host's allowed file roots.`, `Add "/srv/vector" to allowed_file_roots`},
		{"component", `{"sinks":{"s3":{"type":"aws_s3"}}}`, "UNSUPPORTED_LOCAL_CAPABILITY",
			`Sink "s3" (aws_s3) isn't available in restricted mode.`, "deploy to a full-mode device"},
		{"vrl http", `{"transforms":{"enrich":{"type":"remap","source":".x, err = http_request(\"http://10.0.0.1/\")"}}}`, "DYNAMIC_CAPABILITY_DENIED",
			`Transform "enrich" (remap) calls http_request, which restricted mode doesn't allow.`, ""},
		{"vrl dns", `{"transforms":{"enrich":{"type":"remap","source":".host = reverse_dns!(.ip)"}}}`, "DYNAMIC_CAPABILITY_DENIED",
			`Transform "enrich" (remap) calls reverse_dns, which restricted mode doesn't allow.`, ""},
		{"setting", `{"enrichment_tables":{}}`, "UNSUPPORTED_LOCAL_CAPABILITY",
			`The top-level setting "enrichment_tables" isn't allowed in restricted mode.`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if runtime.GOOS == "windows" && strings.Contains(tc.config, `"/`) {
				t.Skip("POSIX paths")
			}
			err := p.Check([]byte(tc.config))
			var refusal *PolicyRefusal
			if !errors.As(err, &refusal) {
				t.Fatalf("not a refusal: %v", err)
			}
			d := refusal.Diagnostic()
			if d.Code != tc.code || d.Message != tc.message || !strings.Contains(d.Hint, tc.hint) {
				t.Fatalf("got %+v", d)
			}
		})
	}
}

// Unit tests insert sample events into transforms during `vector test`; they
// add no capability, so restricted devices accept them. Their VRL is still
// held to restricted mode.
func TestRestrictedModeAcceptsPipelineTests(t *testing.T) {
	p := CapabilityPolicy{}
	withTests := `{"sources":{"in":{"type":"demo_logs","format":"json"}},"transforms":{"t":{"type":"remap","inputs":["in"],"source":".x = 1"}},"sinks":{"out":{"type":"blackhole","inputs":["t"]}},` +
		`"tests":[{"name":"sets x","inputs":[{"insert_at":"t","type":"log","log_fields":{"message":"GET https://example.com/$HOME /etc/passwd"}}],"outputs":[{"extract_from":"t","conditions":[{"type":"vrl","source":"assert_eq!(.x, 1)"}]}]}]}`
	if err := p.Check([]byte(withTests)); err != nil {
		t.Fatalf("tests refused: %v", err)
	}
	external := strings.Replace(withTests, `assert_eq!(.x, 1)`, `assert_eq!(get_env_var!(\"HOME\"), \"/root\")`, 1)
	var refusal *PolicyRefusal
	if err := p.Check([]byte(external)); !errors.As(err, &refusal) || refusal.Resource != "get_env_var" {
		t.Fatalf("external VRL in a test accepted: %v", err)
	}
	if err := p.Check([]byte(`{"tests":{"name":"x"}}`)); err == nil {
		t.Fatal("malformed tests accepted")
	}
}

func TestStatusAndDoctorPrintTheProblems(t *testing.T) {
	now := time.Now()
	issue := &Issue{Code: "CAPABILITY_DENIED", Stage: "validation", Message: "This host's restricted-mode policy doesn't allow this pipeline",
		Diagnostics: []Diagnostic{{Severity: "error", Code: "NETWORK_DESTINATION_DENIED", Message: `Sink "out" (http) sends to 127.0.0.1:9, which this host hasn't approved.`, Hint: `Add "127.0.0.1:9" to allowed_network_hosts on the host.`}}}
	v := &StatusView{Settings: Settings{Name: "edge"}, State: State{ApplyState: "failed", Error: issue, Desired: &Desired{VersionID: "e3a9e737"}, LastHeartbeat: &now}}
	v.Next = v.nextStep(now)
	out := RenderStatus(v, now)
	for _, want := range []string{"Problem    Sink \"out\" (http) sends to 127.0.0.1:9", "           Fix: Add \"127.0.0.1:9\" to allowed_network_hosts"} {
		if !strings.Contains(out, want) {
			t.Fatalf("status lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "below") || strings.Contains(out, "desired_configuration") {
		t.Fatalf("status points at text it doesn't print:\n%s", out)
	}
	report := &DoctorReport{}
	report.add("apply", "fail", "Last apply", "CAPABILITY_DENIED during validation", applyNextAction(v.State))
	for _, problem := range problemRows(issue.Diagnostics) {
		report.add("apply", "info", "Problem", problem.Message, problem.Hint)
	}
	if rendered := RenderDoctor(report); !strings.Contains(rendered, "sends to 127.0.0.1:9") || !strings.Contains(rendered, "1 problem needs attention") {
		t.Fatalf("doctor:\n%s", rendered)
	}
}

// A function's name inside data is not a call. The canonical Prometheus metric,
// an event value and a step called http_requests are ordinary pipelines, and
// restricted mode is the default.
func TestRestrictedModeAllowsPipelinesThatOnlyMentionAFunctionName(t *testing.T) {
	p := CapabilityPolicy{}
	for name, config := range map[string]string{
		"metric name":    `{"transforms":{"m":{"type":"log_to_metric","inputs":["in"],"metrics":[{"type":"counter","field":"message","name":"http_requests_total"}]}},"sinks":{"out":{"type":"blackhole","inputs":["m"]}}}`,
		"event value":    `{"transforms":{"f":{"type":"filter","inputs":["in"],"condition":".event == \"http_request\""}},"sinks":{"out":{"type":"blackhole","inputs":["f"]}}}`,
		"string":         `{"transforms":{"r":{"type":"remap","inputs":["in"],"source":".kind = \"http_request_log\""}},"sinks":{"out":{"type":"blackhole","inputs":["r"]}}}`,
		"step name":      `{"transforms":{"http_requests":{"type":"remap","inputs":["in"],"source":".x = 1"}},"sinks":{"out":{"type":"blackhole","inputs":["http_requests"]}}}`,
		"field path":     `{"transforms":{"r":{"type":"remap","inputs":["in"],"source":".parse_proto = 1\n.get_env_var = 2"}},"sinks":{"out":{"type":"blackhole","inputs":["r"]}}}`,
		"tag named file": `{"transforms":{"m":{"type":"log_to_metric","inputs":["in"],"metrics":[{"type":"counter","field":"message","name":"lines","tags":{"file":"app"}}]}},"sinks":{"out":{"type":"blackhole","inputs":["m"]}}}`,
	} {
		if err := p.Check([]byte(config)); err != nil {
			t.Errorf("%s refused: %v", name, err)
		}
	}
}

// Calls are refused in every spelling VRL accepts, including the ones that
// read a file on the device.
func TestRestrictedModeRefusesEveryCallSpelling(t *testing.T) {
	p := CapabilityPolicy{}
	for source, function := range map[string]string{
		`http_request!(\"http://10.0.0.1/\")`:                 "http_request",
		`http_request! (\"http://10.0.0.1/\")`:                "http_request",
		`.a, err = http_request(\"http://10.0.0.1/\")`:        "http_request",
		`get_env_var!(\"HOME\")`:                              "get_env_var",
		`.h = dns_lookup!(.host)`:                             "dns_lookup",
		`get_enrichment_table_record!(\"t\", {})`:             "get_enrichment_table_record",
		`find_enrichment_table_records!(\"t\", {})`:           "find_enrichment_table_records",
		`validate_json_schema!(.message, \"/x/schema.json\")`: "validate_json_schema",
		`parse_proto!(.message, \"/x/d.desc\", \"a.B\")`:      "parse_proto",
		`encode_proto!(.message, \"/x/d.desc\", \"a.B\")`:     "encode_proto",
	} {
		config := `{"transforms":{"r":{"type":"remap","inputs":["in"],"source":"` + source + `"}}}`
		var refusal *PolicyRefusal
		if err := p.Check([]byte(config)); !errors.As(err, &refusal) || refusal.Code != "DYNAMIC_CAPABILITY_DENIED" || refusal.Resource != function {
			t.Errorf("%s: got %v", source, err)
		}
	}
	// The same calls inside a unit test's VRL.
	tested := `{"tests":[{"name":"t","inputs":[],"outputs":[{"extract_from":"t","conditions":[{"type":"vrl","source":"validate_json_schema!(.m, \"/x.json\")"}]}]}]}`
	var refusal *PolicyRefusal
	if err := p.Check([]byte(tested)); !errors.As(err, &refusal) || refusal.Resource != "validate_json_schema" {
		t.Errorf("test VRL accepted: %v", err)
	}
}

// remap.file loads a VRL program from any path on the device. It is refused
// like files, with a message that says what to do instead.
func TestRestrictedModeRefusesAProgramLoadedFromAFile(t *testing.T) {
	p := CapabilityPolicy{AllowedFileRoots: []string{"/var/log/app"}}
	for _, field := range []string{"file", "files"} {
		value := `"/etc/vector/program.vrl"`
		if field == "files" {
			value = `["/etc/vector/program.vrl"]`
		}
		config := `{"transforms":{"r":{"type":"remap","inputs":["in"],"` + field + `":` + value + `}}}`
		var refusal *PolicyRefusal
		if err := p.Check([]byte(config)); !errors.As(err, &refusal) || refusal.Code != "UNSUPPORTED_LOCAL_CAPABILITY" || refusal.Field != field {
			t.Fatalf("%s: got %v", field, err)
		}
		d := refusal.Diagnostic()
		if d.Message != `Transform "r" (remap) loads its program from a file on this device, which restricted mode doesn't allow.` ||
			!strings.Contains(d.Hint, `Paste the program into "source"`) {
			t.Errorf("%s: %+v", field, d)
		}
	}
}

// An HTTP route's path is part of a URL, not a file. Judging it as one made
// restricted mode refuse ordinary listeners and sinks, and its hint told the
// operator to allow "/".
func TestAnHTTPRoutePathIsNotAFilePath(t *testing.T) {
	p := CapabilityPolicy{AllowedListenAddresses: []string{"127.0.0.1:8080"}, AllowedNetworkHosts: []string{"loki.example.net:443"}}
	for name, config := range map[string]string{
		"http_server": `{"sources":{"in":{"type":"http_server","address":"127.0.0.1:8080","path":"/ingest"}}}`,
		"loki":        `{"sinks":{"out":{"type":"loki","inputs":["in"],"endpoint":"https://loki.example.net","path":"/loki/api/v1/push","labels":{"job":"vector"},"encoding":{"codec":"json"}}}}`,
	} {
		if err := p.Check([]byte(config)); err != nil {
			t.Errorf("%s refused: %v", name, err)
		}
	}
	if runtime.GOOS == "windows" {
		t.Skip("POSIX paths")
	}
	// A path that does name a file is still checked, and a top-level directory
	// is never suggested as the allowance.
	var refusal *PolicyRefusal
	err := p.Check([]byte(`{"sources":{"logs":{"type":"file","include":["/data/app.log"]}}}`))
	if !errors.As(err, &refusal) || refusal.Code != "FILE_ACCESS_DENIED" {
		t.Fatalf("file source: %v", err)
	}
	if refusal.Suggested != "" {
		t.Errorf("suggested %q", refusal.Suggested)
	}
	if hint := refusal.Diagnostic().Hint; !strings.Contains(hint, "Choose the directory that holds these files") || strings.Contains(hint, `Add "/"`) {
		t.Errorf("hint: %s", hint)
	}
}
