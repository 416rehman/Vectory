package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
)

// repoFile reads a file from the repository root (tests run in the package
// directory).
func repoFile(t *testing.T, relative string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", filepath.FromSlash(relative)))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// schemaCredentialPaths walks the captured Vector schema independently of the
// generators and returns every field whose type resolves to SensitiveString,
// per "section/type": the components are assembled like Vector's own
// Sources/Transforms/Sinks enums plus their common outer fields.
func schemaCredentialPaths(t *testing.T) map[string]map[string]bool {
	t.Helper()
	var schema struct {
		Definitions map[string]any `json:"definitions"`
	}
	if err := json.Unmarshal(repoFile(t, "vector-catalog/upstream/vector-schema-0.58.0.json"), &schema); err != nil {
		t.Fatal(err)
	}
	const sensitive = "#/definitions/vector_common::sensitive_string::SensitiveString"
	resolve := func(ref string) any {
		return schema.Definitions[strings.TrimPrefix(ref, "#/definitions/")]
	}
	var walk func(node any, path string, refs []string, found map[string]bool)
	walk = func(node any, path string, refs []string, found map[string]bool) {
		n, ok := node.(map[string]any)
		if !ok {
			return
		}
		if ref, _ := n["$ref"].(string); ref == sensitive {
			found[path] = true
			return
		} else if ref != "" && !slices.Contains(refs, ref) {
			walk(resolve(ref), path, append(refs[:len(refs):len(refs)], ref), found)
		}
		for _, key := range []string{"allOf", "oneOf", "anyOf"} {
			branches, _ := n[key].([]any)
			for _, branch := range branches {
				walk(branch, path, refs, found)
			}
		}
		properties, _ := n["properties"].(map[string]any)
		for key, child := range properties {
			next := key
			if path != "" {
				next = path + "." + key
			}
			walk(child, next, refs, found)
		}
		if additional, ok := n["additionalProperties"].(map[string]any); ok {
			walk(additional, path+".*", refs, found)
		}
		if items, ok := n["items"].(map[string]any); ok {
			walk(items, path+"[]", refs, found)
		}
	}
	out := map[string]map[string]bool{}
	for _, section := range []string{"sources", "transforms", "sinks"} {
		singular := strings.TrimSuffix(section, "s")
		title := strings.ToUpper(section[:1]) + section[1:]
		enum := "#/definitions/vector::" + section + "::" + title
		var common []any
		for name, definition := range schema.Definitions {
			if strings.HasPrefix(name, "vector::config::"+singular+"::"+strings.ToUpper(singular[:1])+singular[1:]+"Outer") {
				all, _ := definition.(map[string]any)["allOf"].([]any)
				for _, entry := range all {
					if ref, _ := entry.(map[string]any)["$ref"].(string); ref != enum {
						common = append(common, entry)
					}
				}
			}
		}
		if len(common) == 0 {
			t.Fatalf("no common %s fields in the schema", section)
		}
		variants, _ := resolve(enum).(map[string]any)["oneOf"].([]any)
		for _, variant := range variants {
			typ := ""
			all, _ := variant.(map[string]any)["allOf"].([]any)
			for _, entry := range all {
				properties, _ := entry.(map[string]any)["properties"].(map[string]any)
				if field, ok := properties["type"].(map[string]any); ok {
					typ, _ = field["const"].(string)
				}
			}
			if typ == "" || strings.HasPrefix(typ, "unit_test") {
				continue
			}
			found := map[string]bool{}
			walk(map[string]any{"allOf": append(append([]any(nil), common...), variant)}, "", nil, found)
			if len(found) > 0 {
				out[section+"/"+typ] = found
			}
		}
	}
	return out
}

// reviewedCredential lists the table's fields that Vector types as plain
// strings; scripts/generate-vector-catalog.mjs reviews each one.
func reviewedCredential(component, field string) bool {
	switch {
	case field == "key_pass" || strings.HasSuffix(field, ".key_pass"):
		return true // every TLS private key passphrase
	case strings.HasSuffix(field, "auth.user") || strings.HasSuffix(field, "auth.username"):
		return true // basic authentication user names
	}
	return map[string]bool{
		"sources/mqtt password":                             true,
		"sinks/mqtt password":                               true,
		"sources/okta token":                                true,
		"sinks/prometheus_remote_write auth.password":       true,
		"sinks/redis sentinel_connect.connections.password": true,
	}[component+" "+field]
}

func TestSecretFieldTableCoversEverySensitiveSchemaField(t *testing.T) {
	schema := schemaCredentialPaths(t)
	fields := 0
	for component, paths := range schema {
		section, typ, _ := strings.Cut(component, "/")
		for path := range paths {
			fields++
			if !secretFieldMatches(section, typ, parseSecretField(path)) {
				t.Errorf("%s: Vector credential field %s is missing from the agent's table", component, path)
			}
		}
	}
	// The pinned schema has 150 SensitiveString fields; a smaller count means
	// the walk above stopped seeing them.
	if fields < 150 {
		t.Fatalf("the schema walk found only %d credential fields", fields)
	}
	for _, row := range secretFieldTable {
		component := row[0] + "/" + row[1]
		if !schema[component][row[2]] && !reviewedCredential(component, row[2]) {
			t.Errorf("%s: %s is neither a Vector credential field nor a reviewed one", component, row[2])
		}
	}
}

func TestSecretFieldTablesMatchAcrossCopies(t *testing.T) {
	var copy struct {
		VectorVersion string                         `json:"vector_version"`
		SchemaSHA256  string                         `json:"schema_sha256"`
		FieldCount    int                            `json:"field_count"`
		Fields        map[string]map[string][]string `json:"fields"`
	}
	if err := json.Unmarshal(repoFile(t, "dashboard/src/generated/secret-fields.json"), &copy); err != nil {
		t.Fatal(err)
	}
	var fromJSON, fromGo []string
	for section, types := range copy.Fields {
		for typ, paths := range types {
			for _, path := range paths {
				fromJSON = append(fromJSON, section+"/"+typ+"/"+path)
			}
		}
	}
	for _, row := range secretFieldTable {
		fromGo = append(fromGo, strings.Join(row[:], "/"))
	}
	sort.Strings(fromJSON)
	sort.Strings(fromGo)
	if strings.Join(fromJSON, "\n") != strings.Join(fromGo, "\n") || copy.FieldCount != len(fromGo) {
		t.Fatal("the agent's table differs from dashboard/src/generated/secret-fields.json; run node scripts/generate-secret-fields.mjs")
	}
	if copy.VectorVersion != secretFieldVectorVersion || copy.SchemaSHA256 != secretFieldSchemaSHA256 || secretFieldVectorVersion != VectorVersion {
		t.Fatal("the table was generated from another schema")
	}
}

// secretConfig nests value at a table path: a list for "[]", a one-key map
// for "*".
func secretConfig(section, typ, field string, value any) []byte {
	steps := parseSecretField(field)
	for i := len(steps) - 1; i >= 0; i-- {
		switch {
		case steps[i].item:
			value = []any{value}
		case steps[i].key == "*":
			value = map[string]any{"x": value}
		default:
			value = map[string]any{steps[i].key: value}
		}
	}
	component := value.(map[string]any)
	component["type"] = typ
	component["large"] = json.Number("9007199254740993")
	b, _ := json.Marshal(map[string]any{section: map[string]any{"c": component}})
	return b
}

// valueAt reads the value at a table path from a configuration.
func valueAt(t *testing.T, config []byte, section, field string) any {
	t.Helper()
	var root map[string]any
	if err := json.Unmarshal(config, &root); err != nil {
		t.Fatal(err)
	}
	var at any = root[section].(map[string]any)["c"]
	for _, step := range parseSecretField(field) {
		switch {
		case step.item:
			at = at.([]any)[0]
		case step.key == "*":
			at = at.(map[string]any)["x"]
		default:
			at = at.(map[string]any)[step.key]
		}
	}
	return at
}

func TestEverySecretFieldIsSubstituted(t *testing.T) {
	p := filepath.Join(privateTempDir(t), "credential")
	if err := AtomicWrite(p, []byte("resolved-credential\n")); err != nil {
		t.Fatal(err)
	}
	bindings := map[string]string{"CREDENTIAL": p}
	for _, row := range secretFieldTable {
		template := secretConfig(row[0], row[1], row[2], "vectory-secret:CREDENTIAL")
		effective, used, err := ResolveLocalSecrets(template, bindings)
		if err != nil || !used {
			t.Fatalf("%v: %v", row, err)
		}
		if got := valueAt(t, effective, row[0], row[2]); got != "resolved-credential" {
			t.Fatalf("%v: substituted %v", row, got)
		}
		if !bytes.Contains(effective, []byte("9007199254740993")) {
			t.Fatalf("%v: exact JSON number lost", row)
		}
	}
	// Nothing else changes: a plain value at a table path stays as written.
	plain := secretConfig("sinks", "datadog_logs", "default_api_key", "${DD_API_KEY}")
	if got, used, err := ResolveLocalSecrets(plain, bindings); err != nil || used || !bytes.Equal(got, plain) {
		t.Fatal("a configuration without references changed", err)
	}
}

func TestSecretReferencesOutsideCredentialFieldsAreRefused(t *testing.T) {
	p := filepath.Join(privateTempDir(t), "token")
	if err := AtomicWrite(p, []byte("exfiltrated-value")); err != nil {
		t.Fatal(err)
	}
	bindings := map[string]string{"T": p}
	for config, field := range map[string]string{
		`{"sinks":{"out":{"type":"http","uri":"vectory-secret:T"}}}`:                                                                 "sinks.out.uri",
		`{"sinks":{"out":{"type":"http","uri":"https://sink.example/","request":{"headers":{"Authorization":"vectory-secret:T"}}}}}`: "sinks.out.request.headers.Authorization",
		`{"sinks":{"out":{"type":"loki","endpoint":"vectory-secret:T"}}}`:                                                            "sinks.out.endpoint",
		`{"sinks":{"out":{"type":"elasticsearch","endpoints":["vectory-secret:T"]}}}`:                                                "sinks.out.endpoints[0]",
		`{"sinks":{"out":{"type":"file","path":"vectory-secret:T","encoding":{"codec":"json"}}}}`:                                    "sinks.out.path",
		`{"sources":{"in":{"type":"exec","mode":"scheduled","command":["echo","vectory-secret:T"]}}}`:                                "sources.in.command[1]",
		`{"transforms":{"t":{"type":"remap","inputs":["in"],"source":".token = \"vectory-secret:T\""}}}`:                             "transforms.t.source",
		`{"sinks":{"out":{"type":"not_a_vector_sink","auth":{"token":"vectory-secret:T"}}}}`:                                         "sinks.out.auth.token",
		`{"sinks":{"out":{"type":"http","auth":{"token":{"value":"vectory-secret:T"}}}}}`:                                            "sinks.out.auth.token.value",
		`{"sources":{"hec":{"type":"splunk_hec","valid_tokens":{"[]":"vectory-secret:T"}}}}`:                                         "sources.hec.valid_tokens.[]",
		`{"sinks":{"out":{"auth":{"password":"vectory-secret:T"}}}}`:                                                                 "sinks.out.auth.password",
		`{"tests":[{"name":"t","inputs":[{"insert_at":"t","type":"log","log_fields":{"message":"vectory-secret:T"}}]}]}`:             "tests[0].inputs[0].log_fields.message",
		`{"api":{"enabled":true,"address":"vectory-secret:T"}}`:                                                                      "api.address",
		`{"sinks":{"vectory-secret:T":"vectory-secret:T"}}`:                                                                          "sinks.vectory-secret:T",
		`{"sinks":{"out":{"type":"http","auth":{"token":"prefix-vectory-secret:T"}}}}`:                                               "auth.token",
		`{"sinks":{"out":{"type":"http","auth":{"token":"vectory-secret:T suffix"}}}}`:                                               "auth.token",
		`{"sinks":{"out":{"type":"http","auth":{"token":"vectory-secret:1BAD"}}}}`:                                                   "auth.token",
		`{"sinks":{"dd":{"type":"datadog_logs","default_api_key":["vectory-secret:T"]}}}`:                                            "sinks.dd.default_api_key[0]",
	} {
		effective, _, err := ResolveLocalSecrets([]byte(config), bindings)
		var ref *secretReferenceError
		if err == nil || !errors.As(err, &ref) || ref.code != "SECRET_REFERENCE_REFUSED" || !strings.Contains(err.Error(), field) {
			t.Fatalf("%s: got %v", config, err)
		}
		if effective != nil || strings.Contains(err.Error(), "exfiltrated-value") {
			t.Fatalf("%s: refused reference was resolved", config)
		}
	}
}

func TestResolvedCredentialsAreRedactedWherever(t *testing.T) {
	effective := []byte(`{"sources":{"hec":{"type":"splunk_hec","address":"127.0.0.1:8088","valid_tokens":["hec-token-4f1b9"]},` +
		`"q":{"type":"kafka","bootstrap_servers":"kafka.example:9092","group_id":"g","topics":["t"],"sasl":{"enabled":true,"mechanism":"PLAIN","username":"svc","password":"k9"}}},` +
		`"sinks":{"dd":{"type":"datadog_logs","inputs":["hec"],"default_api_key":"dd-api-key-8c1e33a","tls":{"key_file":"/etc/tls/key.pem","key_pass":"tls-pass-2b"}},` +
		`"rw":{"type":"prometheus_remote_write","inputs":["q"],"endpoint":"https://rw.example/api/v1/write","auth":{"strategy":"basic","user":"writer-7","password":"rw-pass-5d"}}}}`)
	r := newRedactor()
	r.learnConfiguration(effective, false)
	for _, value := range []string{"hec-token-4f1b9", "k9", "dd-api-key-8c1e33a", "tls-pass-2b", "writer-7", "rw-pass-5d"} {
		got := r.text("Vector said: " + value + ` failed; "` + value + `" rejected (` + value + `)`)
		if strings.Contains(got, value) {
			t.Errorf("%s leaked: %q", value, got)
		}
		if r.identifier(value) != "" || !r.containsSecret(value) {
			t.Errorf("%s is trusted as a template token", value)
		}
	}
	// Short credentials are redacted as whole words only.
	if got := r.text("k9x stays, k9 goes"); got != "k9x stays, "+redactedToken+" goes" {
		t.Fatalf("short credential: %q", got)
	}
	// Template text around the credentials is still echoed.
	if got := r.text(`component "dd" rejected default_api_key`); got != `component "dd" rejected default_api_key` {
		t.Fatalf("template tokens redacted: %q", got)
	}
}

func TestSecretFailureNamesTheFieldOfAnyComponent(t *testing.T) {
	dir := privateTempDir(t)
	template := []byte(`{"sources":{"hec":{"type":"splunk_hec","valid_tokens":["vectory-secret:HEC_TOKEN"]}},"sinks":{"dd":{"type":"datadog_logs","inputs":["hec"],"default_api_key":"vectory-secret:DD_API_KEY"}}}`)
	e := &Engine{Dir: dir, Settings: Settings{ManagedConfig: filepath.Join(dir, "managed.json")}}
	p := filepath.Join(dir, "hec")
	if err := AtomicWrite(p, []byte("hec-token")); err != nil {
		t.Fatal(err)
	}
	_, _, err := resolveLocalSecrets(template, map[string]string{"HEC_TOKEN": p}, false)
	got := e.secretDiagnostics(err, template)
	if len(got) != 1 || got[0].Code != "SECRET_BINDING_MISSING" || got[0].ComponentKind != "sink" || got[0].ComponentID != "dd" || got[0].Field != "default_api_key" || !strings.Contains(got[0].Message, `"DD_API_KEY"`) {
		t.Fatalf("missing binding: %+v", got)
	}
	_, _, err = resolveLocalSecrets(template, map[string]string{"DD_API_KEY": p}, false)
	got = e.secretDiagnostics(err, template)
	if len(got) != 1 || got[0].ComponentKind != "source" || got[0].ComponentID != "hec" || got[0].Field != "valid_tokens[0]" {
		t.Fatalf("list item: %+v", got)
	}
	refused := []byte(`{"sinks":{"out":{"type":"http","uri":"https://sink.example/","request":{"headers":{"X-Very-Long-Header-Name":"vectory-secret:TOKEN"}}}}}`)
	_, _, err = resolveLocalSecrets(refused, map[string]string{"TOKEN": p}, false)
	got = e.secretDiagnostics(err, refused)
	if len(got) != 1 || got[0].Code != "SECRET_REFERENCE_REFUSED" || got[0].ComponentID != "out" || got[0].Field != "request.headers.X-Very-Long-Header-Name" || got[0].Hint == "" {
		t.Fatalf("refused reference: %+v", got)
	}
	if encoded, _ := json.Marshal(got); bytes.Contains(encoded, []byte(dir)) || bytes.Contains(encoded, []byte("hec-token")) {
		t.Fatalf("diagnostic leaked a path or value: %s", encoded)
	}
}

func TestHeartbeatReportsBoundSecretNamesOnlyToServersThatAcceptThem(t *testing.T) {
	bindings := map[string]string{"ZETA": "/private/zeta", "ALPHA": "/private/alpha", "not a name": "/private/x"}
	build := func(features []string) Heartbeat {
		e := &Engine{Dir: t.TempDir(), State: State{ServerFeatures: features}, Settings: Settings{SecretFiles: bindings}, Log: newVectorLog("")}
		var h Heartbeat
		e.addHeartbeatFeatures(&h, []byte(`{"sources":{}}`), metricsNone, "")
		return h
	}
	legacy := build([]string{featureDiagnostics})
	if legacy.SecretNames != nil {
		t.Fatal("an older server received secret names")
	}
	current := build([]string{featureSecretNames})
	if current.SecretNames == nil || strings.Join(*current.SecretNames, ",") != "ALPHA,ZETA" {
		t.Fatalf("secret names = %v", current.SecretNames)
	}
	encoded, _ := json.Marshal(current)
	if !bytes.Contains(encoded, []byte(`"secret_names":["ALPHA","ZETA"]`)) || bytes.Contains(encoded, []byte("/private")) {
		t.Fatalf("heartbeat = %s", encoded)
	}
	none := &Engine{Dir: t.TempDir(), State: State{ServerFeatures: []string{featureSecretNames}}, Log: newVectorLog("")}
	var h Heartbeat
	none.addHeartbeatFeatures(&h, []byte(`{}`), metricsNone, "")
	if encoded, _ := json.Marshal(h); !bytes.Contains(encoded, []byte(`"secret_names":[]`)) {
		t.Fatalf("a host without bindings must say so: %s", encoded)
	}
	many := map[string]string{}
	for i := 0; i < 70; i++ {
		many["N"+strings.Repeat("x", i)] = "/p"
	}
	if got := boundSecretNames(many); len(got) != maxSecretNames || !sort.StringsAreSorted(got) {
		t.Fatalf("bound names are not bounded and sorted: %d", len(got))
	}
}
