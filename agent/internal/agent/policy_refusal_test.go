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
