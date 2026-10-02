package agent

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// awsSink describes one restricted-mode sink that takes an AWS credential and
// where it carries it. Elasticsearch flattens the credential into auth; the
// others (the shared HTTP authentication) nest it one level down, in auth.auth.
type awsSink struct {
	typ    string
	nested bool
	sink   func(credential map[string]any) map[string]any
}

func awsAuth(nested bool, credential map[string]any) map[string]any {
	if nested {
		return map[string]any{"strategy": "aws", "service": "es", "auth": credential}
	}
	auth := map[string]any{"strategy": "aws"}
	maps.Copy(auth, credential)
	return auth
}

var awsSinks = []awsSink{
	{"elasticsearch", false, func(credential map[string]any) map[string]any {
		return map[string]any{"type": "elasticsearch", "inputs": []string{"in"}, "endpoints": []string{"https://search.example.net"},
			"aws": map[string]any{"region": "us-east-1"}, "auth": awsAuth(false, credential)}
	}},
	{"http", true, func(credential map[string]any) map[string]any {
		return map[string]any{"type": "http", "inputs": []string{"in"}, "uri": "https://ingest.example.net/events",
			"encoding": map[string]any{"codec": "json"}, "auth": awsAuth(true, credential)}
	}},
	{"loki", true, func(credential map[string]any) map[string]any {
		return map[string]any{"type": "loki", "inputs": []string{"in"}, "endpoint": "https://loki.example.net", "labels": map[string]any{"job": "vector"},
			"encoding": map[string]any{"codec": "json"}, "auth": awsAuth(true, credential)}
	}},
	{"prometheus_exporter", true, func(credential map[string]any) map[string]any {
		return map[string]any{"type": "prometheus_exporter", "inputs": []string{"in"}, "address": "0.0.0.0:9598", "auth": awsAuth(true, credential)}
	}},
}

// authField is where the credential sits, relative to the component.
func (s awsSink) authField() string {
	if s.nested {
		return "auth.auth"
	}
	return "auth"
}

func awsConfig(t *testing.T, s awsSink, credential map[string]any) []byte {
	t.Helper()
	config, err := json.Marshal(map[string]any{
		"sources": map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json"}},
		"sinks":   map[string]any{"out": s.sink(credential)},
	})
	if err != nil {
		t.Fatal(err)
	}
	return config
}

// A host that allows everything these sinks name: the only thing left to
// refuse is the credential.
func awsPolicy(root string) CapabilityPolicy {
	return CapabilityPolicy{
		AllowedFileRoots:       []string{root},
		AllowedNetworkHosts:    []string{"search.example.net:443", "ingest.example.net:443", "loki.example.net:443"},
		AllowedListenAddresses: []string{"0.0.0.0:9598"},
	}
}

var explicitKeys = map[string]any{"access_key_id": "AKIAIOSFODNN7EXAMPLE", "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}

// reported is the diagnostic the agent sends: the refusal's own text after the
// redaction every diagnostic goes through. It must read as the refusal does, so
// the operator sees the reason and not a redaction mark.
func reported(t *testing.T, p CapabilityPolicy, config []byte) Diagnostic {
	t.Helper()
	diagnostics := (&Engine{}).policyDiagnostics(p.Check(config), config)
	if len(diagnostics) != 1 {
		t.Fatalf("diagnostics: %+v", diagnostics)
	}
	return diagnostics[0]
}

func refusalOf(t *testing.T, err error) *PolicyRefusal {
	t.Helper()
	var refusal *PolicyRefusal
	if !errors.As(err, &refusal) {
		t.Fatalf("not a refusal: %v", err)
	}
	return refusal
}

// An AWS credentials file names the program Vector runs to get credentials
// (credential_process), measured with the pinned Vector on `vector validate`.
// A pipeline's own file sink can write such a file under a file root the host
// allowed, so restricted mode refuses the field wherever the file lies, and no
// allowance changes that. Full mode is unchanged.
func TestRestrictedModeRefusesAnAWSCredentialsFile(t *testing.T) {
	root := t.TempDir()
	for _, s := range awsSinks {
		t.Run(s.typ, func(t *testing.T) {
			inside := filepath.Join(root, "credentials")
			outside := filepath.Join(t.TempDir(), "credentials")
			for name, file := range map[string]string{"under an allowed root": inside, "outside every root": outside} {
				config := awsConfig(t, s, map[string]any{"credentials_file": file, "profile": "vector"})
				refusal := refusalOf(t, awsPolicy(root).Check(config))
				if refusal.Code != "CREDENTIALS_FILE_DENIED" || refusal.Section != "sinks" || refusal.ComponentID != "out" || refusal.ComponentType != s.typ || refusal.Field != s.authField()+".credentials_file" {
					t.Fatalf("%s: %+v", name, refusal)
				}
				d := refusal.Diagnostic()
				wantMessage := `Sink "out" (` + s.typ + `) sets ` + s.authField() + `.credentials_file. A credentials file can name a program that Vector runs, so restricted mode refuses it.`
				if d.Code != "CREDENTIALS_FILE_DENIED" || d.Message != wantMessage || d.Hint != "Use device secrets for access keys, or deploy to a full-mode device." || d.Field != s.authField()+".credentials_file" {
					t.Fatalf("%s: %+v", name, d)
				}
				if err := serverAcceptsDiagnostic(d); err != nil {
					t.Fatalf("%s: the server would refuse this diagnostic: %v", name, err)
				}
				if sent := reported(t, awsPolicy(root), config); sent != d {
					t.Fatalf("%s: the agent sends %+v, not %+v", name, sent, d)
				}
				// The path is the pipeline's text and stays out of the message.
				if strings.Contains(d.Message, file) || strings.Contains(d.Hint, file) {
					t.Fatalf("%s: the diagnostic echoes the path: %+v", name, d)
				}
			}
			config := awsConfig(t, s, map[string]any{"credentials_file": inside, "profile": "vector"})
			if err := (CapabilityPolicy{FullVectorConfig: true}).Check(config); err != nil {
				t.Fatalf("full mode: %v", err)
			}
		})
	}
}

// The rule is on the key name, so any component that has the field is covered,
// at any depth below its auth block, however the key is spelled.
func TestACredentialsFileIsRefusedWhereverItStandsUnderAuth(t *testing.T) {
	check := func(sink map[string]any) error {
		config, _ := json.Marshal(map[string]any{
			"sources": map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json"}},
			"sinks":   map[string]any{"out": sink},
		})
		return CapabilityPolicy{}.Check(config)
	}
	for name, auth := range map[string]any{
		"directly":         map[string]any{"credentials_file": "/srv/aws/credentials"},
		"nested":           map[string]any{"strategy": "aws", "auth": map[string]any{"credentials_file": "/srv/aws/credentials"}},
		"deeper":           map[string]any{"a": map[string]any{"b": map[string]any{"credentials_file": "/srv/aws/credentials"}}},
		"in a list":        map[string]any{"a": []any{map[string]any{"credentials_file": "/srv/aws/credentials"}}},
		"spelled in caps":  map[string]any{"CREDENTIALS_FILE": "/srv/aws/credentials"},
		"empty value":      map[string]any{"credentials_file": ""},
		"null value":       map[string]any{"credentials_file": nil},
		"not a path":       map[string]any{"credentials_file": 7},
		"beside real keys": map[string]any{"strategy": "aws", "access_key_id": "AKIA", "secret_access_key": "x", "credentials_file": "/x"},
	} {
		refusal := refusalOf(t, check(map[string]any{"type": "blackhole", "inputs": []string{"in"}, "auth": auth}))
		if refusal.Code != "CREDENTIALS_FILE_DENIED" || !strings.HasSuffix(strings.ToLower(refusal.Field), "credentials_file") || !strings.HasPrefix(refusal.Field, "auth.") {
			t.Errorf("%s: %+v", name, refusal)
		}
	}
	// Spelled with another case, the field is named the way the pipeline wrote it.
	if refusal := refusalOf(t, check(map[string]any{"type": "blackhole", "inputs": []string{"in"}, "Auth": map[string]any{"Credentials_File": "/x"}})); refusal.Code != "CREDENTIALS_FILE_DENIED" || refusal.Field != "Auth.Credentials_File" {
		t.Errorf("mixed case: %+v", refusal)
	}
	// A key of that name that isn't below an auth block is not this rule's
	// business (a Loki label, a metric tag): it is judged as before.
	for name, sink := range map[string]map[string]any{
		"a label":       {"type": "loki", "inputs": []string{"in"}, "endpoint": "https://loki.example.net", "labels": map[string]any{"credentials_file": "app"}, "encoding": map[string]any{"codec": "json"}},
		"a tag":         {"type": "blackhole", "inputs": []string{"in"}, "tags": map[string]any{"credentials_file": "app"}},
		"another block": {"type": "blackhole", "inputs": []string{"in"}, "encoding": map[string]any{"credentials_file": "app"}},
	} {
		p := CapabilityPolicy{AllowedNetworkHosts: []string{"loki.example.net:443"}}
		config, _ := json.Marshal(map[string]any{"sources": map[string]any{"in": map[string]any{"type": "demo_logs"}}, "sinks": map[string]any{"out": sink}})
		var refusal *PolicyRefusal
		if err := p.Check(config); errors.As(err, &refusal) && refusal.Code == "CREDENTIALS_FILE_DENIED" {
			t.Errorf("%s: %+v", name, refusal)
		}
	}
	if err := (CapabilityPolicy{}).Check([]byte(`{"transforms":{"r":{"type":"remap","inputs":["in"],"source":".credentials_file = \"x\""}}}`)); err != nil {
		t.Errorf("a field in a program: %v", err)
	}
}

// With auth.strategy aws and no explicit keys, Vector's AWS credential chain
// reaches this host's environment, shared profiles, the ECS task role and the
// instance metadata service, none of which any allowance names. Restricted
// mode refuses every shape the capability table calls ambient, in each of the
// four sinks that take the credential, and accepts the explicit shape.
func TestRestrictedModeRefusesAmbientAWSCredentials(t *testing.T) {
	with := func(extra map[string]any) map[string]any {
		out := maps.Clone(explicitKeys)
		maps.Copy(out, extra)
		return out
	}
	ambient := map[string]map[string]any{
		"no keys":                            {},
		"only a region":                      {"region": "us-east-1"},
		"only the access key ID":             {"access_key_id": "AKIAIOSFODNN7EXAMPLE"},
		"only the secret access key":         {"secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"},
		"empty keys":                         {"access_key_id": "", "secret_access_key": ""},
		"an empty secret access key":         {"access_key_id": "AKIAIOSFODNN7EXAMPLE", "secret_access_key": ""},
		"keys that are not strings":          {"access_key_id": 1, "secret_access_key": true},
		"null keys":                          {"access_key_id": nil, "secret_access_key": nil},
		"only a role to assume":              {"assume_role": "arn:aws:iam::123456789012:role/vector"},
		"a role beside the keys":             with(map[string]any{"assume_role": "arn:aws:iam::123456789012:role/vector"}),
		"only the metadata client":           {"imds": map[string]any{"max_attempts": 2}},
		"the metadata client beside keys":    with(map[string]any{"imds": map[string]any{"max_attempts": 2}}),
		"only a profile":                     {"profile": "default"},
		"a profile beside the keys":          with(map[string]any{"profile": "vector"}),
		"a role with a session name":         {"assume_role": "arn:aws:iam::123456789012:role/vector", "session_name": "vector"},
		"only a load timeout":                {"load_timeout_secs": 30},
		"only a session token":               {"session_token": "token"},
		"keys under a spelling Vector hates": {"Access_Key_Id": "AKIA", "Secret_Access_Key": "x"},
	}
	for _, s := range awsSinks {
		t.Run(s.typ, func(t *testing.T) {
			p := awsPolicy(t.TempDir())
			for name, credential := range ambient {
				refusal := refusalOf(t, p.Check(awsConfig(t, s, credential)))
				if refusal.Code != "AMBIENT_CREDENTIALS_DENIED" || refusal.Section != "sinks" || refusal.ComponentID != "out" || refusal.ComponentType != s.typ || refusal.Field != s.authField() {
					t.Errorf("%s: %+v", name, refusal)
					continue
				}
				d := refusal.Diagnostic()
				wantMessage := `Sink "out" (` + s.typ + `) can sign with this host's own AWS credentials, which restricted mode refuses. In ` + s.authField() + `, set access_key_id and secret_access_key, and no assume_role, imds or profile.`
				if d.Code != "AMBIENT_CREDENTIALS_DENIED" || d.Message != wantMessage || d.Hint != "Give the sink explicit credentials as device secrets, or deploy to a full-mode device." || d.Field != s.authField() {
					t.Errorf("%s: %+v", name, d)
				}
				if err := serverAcceptsDiagnostic(d); err != nil {
					t.Errorf("%s: the server would refuse this diagnostic: %v", name, err)
				}
				if sent := reported(t, p, awsConfig(t, s, credential)); sent != d {
					t.Errorf("%s: the agent sends %+v, not %+v", name, sent, d)
				}
				if err := (CapabilityPolicy{FullVectorConfig: true}).Check(awsConfig(t, s, credential)); err != nil {
					t.Errorf("%s: full mode: %v", name, err)
				}
			}
			// Both keys, as plain strings or as the values device secrets resolve
			// to, and nothing that borrows the host's identity.
			for name, credential := range map[string]map[string]any{
				"both keys":                  explicitKeys,
				"keys, a session token":      with(map[string]any{"session_token": "AQoDYXdz"}),
				"keys and a region":          with(map[string]any{"region": "eu-west-1"}),
				"keys, a region and a token": with(map[string]any{"region": "eu-west-1", "session_token": "AQoDYXdz"}),
			} {
				if err := p.Check(awsConfig(t, s, credential)); err != nil {
					t.Errorf("%s: refused: %v", name, err)
				}
			}
		})
	}
}

// Only the credential object counts: keys in the wrong place don't make the
// sink explicit, whatever Vector's own parser does with them.
func TestAmbientAWSCredentialsAreJudgedWhereTheSinkReadsThem(t *testing.T) {
	p := awsPolicy(t.TempDir())
	// Elasticsearch reads the keys in auth, so keys in an auth.auth block are decoys.
	es := awsSinks[0]
	config := awsConfig(t, es, map[string]any{"auth": explicitKeys})
	if refusal := refusalOf(t, p.Check(config)); refusal.Code != "AMBIENT_CREDENTIALS_DENIED" || refusal.Field != "auth" {
		t.Errorf("elasticsearch with keys one level down: %+v", refusal)
	}
	// The others read them in auth.auth, so keys in auth are decoys.
	for _, s := range awsSinks[1:] {
		sink := s.sink(map[string]any{})
		maps.Copy(sink["auth"].(map[string]any), explicitKeys)
		config, _ := json.Marshal(map[string]any{
			"sources": map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json"}},
			"sinks":   map[string]any{"out": sink},
		})
		if refusal := refusalOf(t, p.Check(config)); refusal.Code != "AMBIENT_CREDENTIALS_DENIED" || refusal.Field != "auth.auth" {
			t.Errorf("%s with keys in auth: %+v", s.typ, refusal)
		}
		// A missing block is the same shape as an empty one.
		sink = s.sink(map[string]any{})
		delete(sink["auth"].(map[string]any), "auth")
		config, _ = json.Marshal(map[string]any{
			"sources": map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json"}},
			"sinks":   map[string]any{"out": sink},
		})
		if refusal := refusalOf(t, p.Check(config)); refusal.Code != "AMBIENT_CREDENTIALS_DENIED" || refusal.Field != "auth.auth" {
			t.Errorf("%s with no auth.auth: %+v", s.typ, refusal)
		}
	}
}

// Only the aws strategy reaches the credential chain. Other strategies, and a
// sink with no auth block, are judged as before.
func TestOtherAuthenticationStrategiesAreNotAmbient(t *testing.T) {
	p := awsPolicy(t.TempDir())
	for name, tc := range map[string]struct {
		sink map[string]any
	}{
		"elasticsearch basic":     {map[string]any{"type": "elasticsearch", "inputs": []string{"in"}, "endpoints": []string{"https://search.example.net"}, "auth": map[string]any{"strategy": "basic", "user": "u", "password": "p"}}},
		"http basic":              {map[string]any{"type": "http", "inputs": []string{"in"}, "uri": "https://ingest.example.net/x", "encoding": map[string]any{"codec": "json"}, "auth": map[string]any{"strategy": "basic", "user": "u", "password": "p"}}},
		"http bearer":             {map[string]any{"type": "http", "inputs": []string{"in"}, "uri": "https://ingest.example.net/x", "encoding": map[string]any{"codec": "json"}, "auth": map[string]any{"strategy": "bearer", "token": "t"}}},
		"http custom":             {map[string]any{"type": "http", "inputs": []string{"in"}, "uri": "https://ingest.example.net/x", "encoding": map[string]any{"codec": "json"}, "auth": map[string]any{"strategy": "custom", "value": "Token x"}}},
		"loki without auth":       {map[string]any{"type": "loki", "inputs": []string{"in"}, "endpoint": "https://loki.example.net", "labels": map[string]any{"job": "vector"}, "encoding": map[string]any{"codec": "json"}}},
		"elasticsearch plain":     {map[string]any{"type": "elasticsearch", "inputs": []string{"in"}, "endpoints": []string{"https://search.example.net"}}},
		"auth that isn't a block": {map[string]any{"type": "elasticsearch", "inputs": []string{"in"}, "endpoints": []string{"https://search.example.net"}, "auth": "aws"}},
	} {
		config, _ := json.Marshal(map[string]any{
			"sources": map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json"}},
			"sinks":   map[string]any{"out": tc.sink},
		})
		if err := p.Check(config); err != nil {
			t.Errorf("%s: refused: %v", name, err)
		}
	}
}

// Both refusals are ones no host allowance can lift, and the status and doctor
// commands say so instead of sending the operator to look for one.
func TestTheAWSCredentialRefusalsPointAtDeviceSecretsAndFullMode(t *testing.T) {
	for code, category := range map[string]string{
		"CREDENTIALS_FILE_DENIED":    "capability denied: an AWS credentials file can run a program",
		"AMBIENT_CREDENTIALS_DENIED": "capability denied: ambient AWS credentials",
	} {
		refused := State{LastGoodSHA256: "a", Error: &Issue{Code: "CAPABILITY_DENIED", Diagnostics: []Diagnostic{{Code: code, Severity: "error"}}}}
		next := applyNextAction(refused)
		if strings.Contains(next, "Allow what the problem names") || !strings.Contains(next, "device secrets") || !strings.Contains(next, "full mode") || !strings.HasSuffix(next, "Vector keeps running the last working configuration.") {
			t.Errorf("%s: %q", code, next)
		}
		local := capabilityDiagnostic(category)
		if local.Reason != code || !strings.Contains(local.NextAction, "device secrets") || !strings.Contains(local.NextAction, "full mode") {
			t.Errorf("%s: %+v", code, local)
		}
	}
}

// The agent's own rule is the capability table's, written out: the same
// component types, the same credential objects, the same conditions, the same
// keys. When the table changes, this test says what to change here.
func TestTheAWSCredentialRuleFollowsTheCapabilityTable(t *testing.T) {
	var shape *capabilityCredentialShape
	for i := range capabilityCredentialShapes {
		if capabilityCredentialShapes[i].Name == "aws" {
			shape = &capabilityCredentialShapes[i]
		}
	}
	if shape == nil {
		t.Fatal("the table has no aws credential shape")
	}
	if !slices.Equal(shape.AmbientKeys, awsAmbientKeys) {
		t.Errorf("ambient keys: the table says %v, the rule %v", shape.AmbientKeys, awsAmbientKeys)
	}
	for _, key := range shape.Explicit {
		if !slices.Contains(awsExplicitKeys, key) {
			t.Errorf("the table counts %s as explicit, the rule doesn't require it", key)
		}
	}
	refused := ""
	for _, r := range shape.RefusedKeys {
		refused += r.Name + " "
	}
	if refused != credentialsFileKey+" " {
		t.Errorf("refused keys: the table says %q, the rule %q", refused, credentialsFileKey)
	}
	for _, s := range awsSinks {
		var found []capabilityCredential
		for _, c := range capabilityCredentials {
			if c.Scope == "sinks/"+s.typ && c.Shape == "aws" {
				found = append(found, c)
			}
		}
		if len(found) != 1 {
			t.Errorf("%s: the table has %d aws credentials", s.typ, len(found))
			continue
		}
		path := strings.Join(awsCredentialPath[s.typ], ".")
		if found[0].Path != path || path != s.authField() {
			t.Errorf("%s: the table puts the credential at %q, the rule at %q", s.typ, found[0].Path, path)
		}
		if len(found[0].When) != 1 || found[0].When[0].Field != "auth.strategy" || !slices.Equal(found[0].When[0].Values, []string{`"aws"`}) {
			t.Errorf("%s: the table's condition is %+v", s.typ, found[0].When)
		}
	}
	// Every restricted-mode sink that the table gives an aws credential is one
	// the rule knows.
	for _, c := range capabilityCredentials {
		typ, isSink := strings.CutPrefix(c.Scope, "sinks/")
		if isSink && c.Shape == "aws" && supported["sinks"][typ] && awsCredentialPath[typ] == nil {
			t.Errorf("%s takes an AWS credential in the table and has no rule", typ)
		}
	}
}

// A restricted device that already runs a version with an AWS credentials file
// or the host's own AWS identity keeps running it until another version
// applies. Starting that configuration again, after Vector or the agent
// restarted, is a new start the policy judges: restricted mode refuses it and
// says why, and a full-mode device starts it as before.
func TestRestartingAConfigurationWithAWSCredentialsOnlyFullModeAllowsIsRefusedInRestrictedMode(t *testing.T) {
	for name, tc := range map[string]struct {
		credential map[string]any
		code       string
	}{
		"a credentials file":          {map[string]any{"credentials_file": "/srv/aws/credentials", "profile": "vector"}, "CREDENTIALS_FILE_DENIED"},
		"the host's own AWS identity": {map[string]any{}, "AMBIENT_CREDENTIALS_DENIED"},
	} {
		for _, full := range []bool{false, true} {
			t.Run(name+map[bool]string{false: ", restricted", true: ", full"}[full], func(t *testing.T) {
				config := awsConfig(t, awsSinks[0], tc.credential)
				e, _, d := fixture(t, newConfig)
				e.Settings.CapabilityPolicy = CapabilityPolicy{FullVectorConfig: full, AllowedNetworkHosts: []string{"search.example.net:443"}}
				if err := AtomicWrite(filepath.Join(e.Dir, "good-"+Digest(config)+".json"), config); err != nil {
					t.Fatal(err)
				}
				e.State.LastGoodSHA256 = Digest(config)
				if err := AtomicWrite(e.Settings.ManagedConfig, config); err != nil {
					t.Fatal(err)
				}
				d.alive = false // Vector or the agent restarted
				err := e.StartExisting(context.Background())
				if full {
					if err != nil || d.starts != 1 || !d.alive {
						t.Fatalf("a full-mode device did not start its configuration: %v starts %d", err, d.starts)
					}
					return
				}
				if err == nil || d.starts != 0 || d.alive {
					t.Fatalf("a restricted device started the configuration: %v starts %d", err, d.starts)
				}
				issue := e.State.Error
				if issue == nil || issue.Code != "CAPABILITY_DENIED" || issue.Stage != "startup" || len(issue.Diagnostics) != 1 || issue.Diagnostics[0].Code != tc.code {
					t.Fatalf("issue: %+v", issue)
				}
				if err := serverAcceptsDiagnostic(issue.Diagnostics[0]); err != nil {
					t.Errorf("the server would refuse this diagnostic: %v", err)
				}
			})
		}
	}
}
