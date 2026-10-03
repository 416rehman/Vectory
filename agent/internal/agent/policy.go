package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// This policy is operator-owned. No field in the server protocol can modify it.
// Network allowlists constrain configuration, not DNS resolution or kernel egress.
// Use OS network/filesystem isolation when publishers are not trusted with allowed resources.
type CapabilityPolicy struct {
	FullVectorConfig       bool     `json:"full_vector_config,omitempty"`
	AllowedFileRoots       []string `json:"allowed_file_roots"`
	AllowedNetworkHosts    []string `json:"allowed_network_hosts"` // exact hostname:port
	AllowedListenAddresses []string `json:"allowed_listen_addresses"`
}

// DescribeAllowances says what restricted mode allows on this host, for the
// operator who just changed it: "files under /var/log/app; destination
// logs.example.net:443; listener 0.0.0.0:514".
func DescribeAllowances(p CapabilityPolicy) string {
	var parts []string
	add := func(one, many string, values []string) {
		if len(values) == 0 {
			return
		}
		label := many
		if len(values) == 1 {
			label = one
		}
		shown := values
		if len(values) > 5 {
			shown = append(slices.Clone(values[:5]), fmt.Sprintf("and %d more", len(values)-5))
		}
		parts = append(parts, label+" "+strings.Join(shown, ", "))
	}
	add("files under", "files under", p.AllowedFileRoots)
	add("destination", "destinations", p.AllowedNetworkHosts)
	add("listener", "listeners", p.AllowedListenAddresses)
	if len(parts) == 0 {
		return "nothing yet: restricted pipelines can't read files, reach destinations or open listeners here"
	}
	return strings.Join(parts, "; ")
}

// refusedMessage is the one-line reason this host gives for refusing a pipeline.
// Full mode refuses little (a component ID that is a path), and not because of
// restricted mode.
func (p CapabilityPolicy) refusedMessage() string {
	if p.FullVectorConfig {
		return "This host's local policy doesn't allow this pipeline"
	}
	return "This host's restricted-mode policy doesn't allow this pipeline"
}

func (p CapabilityPolicy) ConfigurationMode() string {
	if p.FullVectorConfig {
		return "full"
	}
	return "restricted"
}

var supported = map[string]map[string]bool{
	"sources":    {"demo_logs": true, "internal_metrics": true, "file": true, "http_server": true, "syslog": true, "opentelemetry": true},
	"transforms": {"remap": true, "filter": true, "route": true, "sample": true, "reduce": true, "log_to_metric": true},
	"sinks":      {"console": true, "blackhole": true, "http": true, "loki": true, "elasticsearch": true, "prometheus_exporter": true},
}
var environmentVariable = regexp.MustCompile(`\$[A-Za-z_]`)

// How restricted mode reads an AWS credential. The capability table
// (vector-catalog/capabilities.json, credential shape "aws") says the same, and
// a test keeps the two equal.
//
// A credentials file can name a program: Vector runs the profile's
// credential_process while it validates. A pipeline's own file sink can write
// such a file under a file root the host allowed, so the field is refused
// wherever it stands below an auth block, and no allowance permits it.
//
// With auth.strategy aws and no explicit keys, the AWS credential chain reaches
// this host's environment, shared profiles, the ECS task role and the instance
// metadata service, none of which any allowance names. A role to assume, the
// metadata client's settings and a profile all start from that chain, so they
// count as ambient even beside keys.
const credentialsFileKey = "credentials_file"

var (
	awsExplicitKeys = []string{"access_key_id", "secret_access_key"}
	awsAmbientKeys  = []string{"assume_role", "imds", "profile"}
	// awsCredentialPath says where each restricted-mode sink that takes an AWS
	// credential reads it once auth.strategy is aws. Elasticsearch flattens the
	// credential into auth; the shared HTTP authentication of http, loki and
	// prometheus_exporter nests it as auth.auth. Only that object counts: keys
	// anywhere else make nothing explicit.
	awsCredentialPath = map[string][]string{
		"elasticsearch":       {"auth"},
		"http":                {"auth", "auth"},
		"loki":                {"auth", "auth"},
		"prometheus_exporter": {"auth", "auth"},
	}
)

// externalVRL lists VRL functions that reach outside the event: the
// environment, secrets, enrichment tables, DNS, HTTP and files (a JSON schema
// or a protobuf descriptor). Restricted mode denies them because they bypass
// the host's allowances. The server's DEVICE_VRL_FUNCTIONS and the dashboard's
// deviceVrlFunctions list the same names; tests/security/test_vrl_function_lists.py
// fails when they drift. parse_etld and parse_groks reach a file only when a
// call passes one, so they are not listed here: see fileArgumentFunctions.
var externalVRL = []string{"get_env_var", "get_secret", "set_secret", "remove_secret", "get_enrichment_table_record", "find_enrichment_table_records", "dns_lookup", "reverse_dns", "http_request", "validate_json_schema", "parse_proto", "encode_proto"}

// externalCalls matches a call of each external function: `name(` or
// `name!(` that is not the end of a longer identifier or a field path. A metric
// named http_requests_total, an event value "http_request" or a step called
// http_requests is data, not a call. VRL allows no space between a name and
// its parenthesis; the pattern tolerates whitespace, so it never misses one.
var externalCalls = func() []*regexp.Regexp {
	calls := make([]*regexp.Regexp, len(externalVRL))
	for i, name := range externalVRL {
		calls[i] = regexp.MustCompile(`(?:^|[^A-Za-z0-9_.])` + regexp.QuoteMeta(name) + `\s*(?:!\s*)?\(`)
	}
	return calls
}()

// PolicyRefusal says exactly what restricted mode refused: the component,
// the resource (destination host:port, listener, path) and the allowance
// that would permit it. Its Error text is a fixed category.
type PolicyRefusal struct {
	Code          string
	Category      string // fixed text, see Error
	Section       string // sources, transforms, sinks, or "" for a global setting
	ComponentID   string
	ComponentType string
	Field         string
	Resource      string // host:port, listen address, path, setting or VRL function
	Argument      string // the argument that passes a file to the VRL function in Resource, such as alias_sources
	Allowance     string // allowed_network_hosts, allowed_listen_addresses, allowed_file_roots
	Suggested     string // the allowance entry that would permit it
	problem       string // INVALID_COMPONENT_ID: what is wrong with the ID, such as "a slash in its ID"
	// StateDir is the state directory of the agent that refused, for the
	// commands in the fix; empty when it isn't known.
	StateDir string
}

func (e *PolicyRefusal) Error() string { return e.Category }

func refusal(code, category string) *PolicyRefusal {
	return &PolicyRefusal{Code: code, Category: category}
}

// componentKind is the singular kind for a component section.
func componentKind(section string) string {
	return map[string]string{"sources": "source", "transforms": "transform", "sinks": "sink"}[section]
}

// subject names what was refused: `Sink "out" (http)` or `The pipeline`.
func (e *PolicyRefusal) subject() string {
	if e.ComponentID == "" {
		return "The pipeline"
	}
	kind := componentKind(e.Section)
	subject := strings.ToUpper(kind[:1]) + kind[1:] + ` "` + shortID(e.ComponentID) + `"`
	if e.ComponentType != "" {
		subject += " (" + e.ComponentType + ")"
	}
	return subject
}

// Diagnostic explains the refusal and its fix. The resource comes from the
// published pipeline; the caller's redaction still applies.
func (e *PolicyRefusal) Diagnostic() Diagnostic {
	d := Diagnostic{Severity: "error", Code: e.Code, ComponentKind: componentKind(e.Section), ComponentID: e.ComponentID, Field: e.Field}
	// `vectory allow` adds to the host's allowances and keeps the rest.
	flag := map[string]string{"allowed_network_hosts": "--network", "allowed_listen_addresses": "--listener", "allowed_file_roots": "--file-root"}[e.Allowance]
	grant := func(entry string) string {
		return "Allow it on the host, with the agent stopped: " + CommandFor(e.StateDir, "vectory allow "+flag+" "+quoteArg(entry)) + ". Or deploy to a full-mode device."
	}
	subject := e.subject()
	switch {
	case e.Allowance == "allowed_network_hosts" && e.Resource != "":
		d.Message = subject + " sends to " + e.Resource + ", which this host hasn't approved."
		d.Hint = grant(e.Suggested)
	case e.Allowance == "allowed_listen_addresses" && e.Resource != "":
		d.Message = subject + " listens on " + e.Resource + ", which this host hasn't approved."
		d.Hint = grant(e.Suggested)
	case e.Allowance == "allowed_file_roots" && e.Resource != "" && e.Suggested == "":
		d.Message = subject + " uses " + e.Resource + ", outside this host's allowed file roots."
		d.Hint = "Choose the directory that holds these files and allow it on the host, with the agent stopped: " + CommandFor(e.StateDir, "vectory allow --file-root DIR") + ". Or deploy to a full-mode device."
	case e.Allowance == "allowed_file_roots" && e.Resource != "":
		d.Message = subject + " uses " + e.Resource + ", outside this host's allowed file roots."
		d.Hint = grant(e.Suggested)
	case e.Code == "NETWORK_DESTINATION_DENIED" && e.Resource != "":
		d.Message = subject + " uses " + e.Resource + ", which restricted mode can't approve: use http(s)://host:port without credentials."
	case e.Code == "NETWORK_DESTINATION_DENIED":
		d.Message = subject + " needs an explicit " + e.Field + " in restricted mode."
	case e.Code == "LOCAL_API_DENIED":
		d.Message = `The pipeline has an "api" block. Vector's local API has no authentication, so any user on this host could read live events from it, and restricted mode never allows it.`
		d.Hint = "Remove the api block, or deploy to a full-mode device. No host allowance can permit it."
	case e.Code == "CREDENTIALS_FILE_DENIED":
		d.Message = subject + " sets " + e.Field + ". A credentials file can name a program that Vector runs, so restricted mode refuses it."
		d.Hint = "Use device secrets for access keys, or deploy to a full-mode device."
	case e.Code == "AMBIENT_CREDENTIALS_DENIED":
		d.Message = subject + " can sign with this host's own AWS credentials, which restricted mode refuses. In " + e.Field + ", set access_key_id and secret_access_key, and no assume_role, imds or profile."
		d.Hint = "Give the sink explicit credentials as device secrets, or deploy to a full-mode device."
	case e.Code == "INVALID_COMPONENT_ID":
		// The ID is not a plain token, which is what component_id carries: the
		// message names it, escaped and bounded.
		d.ComponentID = ""
		d.Message = subject + " has " + e.problem + "."
		d.Hint = "Rename it and the inputs that name it. Vector uses an ID as a directory name in its data directory, so it can't be a path."
	case e.Code == "LISTENER_DENIED":
		d.Message = subject + " needs an explicit listen address in restricted mode."
	case e.Code == "FILE_ACCESS_DENIED" && e.Resource != "":
		d.Message = subject + " uses " + e.Resource + ", which must be an absolute path without symbolic links in restricted mode."
	case e.Code == "UNSUPPORTED_LOCAL_CAPABILITY" && (e.Field == "file" || e.Field == "files" || e.Field == "source_files"):
		d.Message = subject + ` loads its program from a file on this device, which restricted mode doesn't allow.`
		d.Hint = `Paste the program into "source", or deploy to a full-mode device.`
	case e.Code == "UNSUPPORTED_LOCAL_CAPABILITY" && e.Field != "":
		d.Message = subject + ` sets "` + e.Field + `", which restricted mode doesn't allow.`
		d.Hint = "Remove it, or deploy to a full-mode device."
	case e.Code == "UNSUPPORTED_LOCAL_CAPABILITY" && e.ComponentID != "":
		d.Message = subject + " isn't available in restricted mode."
		d.Hint = "Use a component restricted mode supports, or deploy to a full-mode device."
	case e.Code == "UNSUPPORTED_LOCAL_CAPABILITY" && e.Resource != "":
		d.Message = `The top-level setting "` + e.Resource + `" isn't allowed in restricted mode.`
		d.Hint = "Remove it, or deploy to a full-mode device."
	case e.Code == "DYNAMIC_CAPABILITY_DENIED" && e.Argument != "":
		d.Message = subject + " reads a file with " + e.Resource + " (" + e.Argument + "), which restricted mode doesn't allow."
		d.Hint = "Remove the " + e.Argument + " argument, or deploy to a full-mode device. No allowance on a restricted host can permit it."
	case e.Code == "DYNAMIC_CAPABILITY_DENIED" && e.Resource != "":
		d.Message = subject + " calls " + e.Resource + ", which restricted mode doesn't allow."
		d.Hint = "Use fixed values in the pipeline, or deploy to a full-mode device."
	case e.Code == "DYNAMIC_CAPABILITY_DENIED":
		d.Message = subject + " uses an environment substitution or template in " + e.Field + "; restricted mode needs fixed values."
	case e.Code == "TLS_VERIFICATION_REQUIRED":
		d.Message = subject + " turns off " + e.Field + "; restricted mode always verifies TLS."
	case e.Code == "CONSOLE_TARGET_DENIED":
		d.Message = subject + " must set target to stderr in restricted mode."
	default:
		d.Message = subject + " isn't allowed by this host's restricted-mode policy."
	}
	return d
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Check applies restricted mode to an effective configuration. The first
// refusal, in a stable order, is returned as a *PolicyRefusal.
func (p CapabilityPolicy) Check(data []byte) error {
	var root map[string]any
	if e := json.Unmarshal(data, &root); e != nil {
		return errors.New("configuration must be a JSON object")
	}
	if root == nil {
		return errors.New("configuration must be an object")
	}
	// A component ID that names a path makes Vector write outside its data
	// directory. That is a containment rule, so it holds in every mode.
	if e := componentIDRefusal(root); e != nil {
		return e
	}
	// This explicit local grant trusts publishers with all capabilities of the
	// adopted Vector process. Vector itself still validates the complete bundle.
	if p.FullVectorConfig {
		return nil
	}
	exporter, exporterAddress := monitoringExporter(root)
	for _, k := range sortedKeys(root) {
		v := root[k]
		switch k {
		case "sources", "transforms", "sinks":
			components, ok := v.(map[string]any)
			if !ok {
				return errors.New("component section must be an object")
			}
			for _, id := range sortedKeys(components) {
				c, ok := components[id].(map[string]any)
				if !ok {
					return errors.New("component must be an object")
				}
				typ, _ := c["type"].(string)
				policy := p
				if k == "sinks" && id == exporter {
					policy.AllowedListenAddresses = append(slices.Clone(p.AllowedListenAddresses), exporterAddress)
				}
				if e := policy.component(k, typ, c); e != nil {
					e.Section, e.ComponentID, e.ComponentType = k, id, typ
					return e
				}
			}
		case "data_dir":
			s, ok := v.(string)
			if !ok {
				return errors.New("data_dir must be a path")
			}
			if e := p.file(s); e != nil {
				e.Field = "data_dir"
				return e
			}
		case "api":
			// Vector's API has no authentication: while it is open, any user on
			// the host can read every component's live events. No allowance
			// covers it, and a block that is switched off is refused too: the
			// host decides whether the API exists, never a pipeline. A
			// pipeline that needs one runs in full mode.
			r := refusal("LOCAL_API_DENIED", "capability denied: Vector's local API has no authentication")
			r.Field = "api"
			return r
		case "acknowledgements", "healthchecks", "timezone":
			if e := p.walk(v, k); e != nil {
				return e
			}
		case "tests":
			if e := checkTests(v); e != nil {
				return e
			}
		default:
			r := refusal("UNSUPPORTED_LOCAL_CAPABILITY", "capability denied: unsupported top-level setting")
			r.Resource = k
			return r
		}
	}
	return nil
}

// driveLetterPrefix is a Windows drive prefix at the start of an ID: one ASCII
// letter and a colon. It is the check the server's validate makes (an ASCII
// alphabetic first character, then ':'), so the two never disagree.
var driveLetterPrefix = regexp.MustCompile(`^[A-Za-z]:`)

// componentIDRefusal refuses the first component, in a stable order, whose ID
// could be a path. Vector joins an ID onto its data_dir for checkpoints and
// disk buffers, so an absolute path replaces the directory: a pipeline could
// make Vector create files anywhere its account can write. Vector itself
// refuses a "." in an ID, so "." and ".." never get this far. A memory
// enrichment table counts too: with inputs it is a sink named by the table,
// and its source_key names a source of its own.
func componentIDRefusal(root map[string]any) *PolicyRefusal {
	refused := func(section, id, typ, problem string) *PolicyRefusal {
		r := refusal("INVALID_COMPONENT_ID", "component ID must be a plain name")
		// The type comes from the same pipeline: shown, it can't push the
		// reason out of the message either.
		r.Section, r.ComponentID, r.ComponentType, r.problem = section, id, shortText(typ, 40), problem
		return r
	}
	for _, section := range []string{"sinks", "sources", "transforms"} {
		components, ok := root[section].(map[string]any)
		if !ok {
			continue // Vector rejects a section that is not an object
		}
		for _, id := range sortedKeys(components) {
			if problem := componentIDProblem(id); problem != "" {
				component, _ := components[id].(map[string]any)
				typ, _ := component["type"].(string)
				return refused(section, id, typ, problem)
			}
		}
	}
	tables, _ := root["enrichment_tables"].(map[string]any)
	for _, name := range sortedKeys(tables) {
		table, _ := tables[name].(map[string]any)
		if table["type"] != "memory" {
			continue
		}
		if _, takesInputs := table["inputs"]; takesInputs {
			if problem := componentIDProblem(name); problem != "" {
				return refused("sinks", name, "memory", problem)
			}
		}
		source, _ := table["source_config"].(map[string]any)
		if key, ok := source["source_key"].(string); ok {
			if problem := componentIDProblem(key); problem != "" {
				return refused("sources", key, "memory", problem)
			}
		}
	}
	return nil
}

// componentIDProblem says what makes id more than a name, or "": a path
// separator or a control character anywhere, or a drive letter and a colon at
// the start, which Windows reads as a path on that drive. Nothing else is
// refused: Vector accepts the rest (a colon elsewhere, spaces, commas, quotes,
// non-ASCII), and so does the server.
func componentIDProblem(id string) string {
	switch {
	case strings.Contains(id, "/"):
		return "a slash in its ID"
	case strings.Contains(id, `\`):
		return "a backslash in its ID"
	case strings.IndexFunc(id, unicode.IsControl) >= 0:
		return "a control character in its ID"
	case driveLetterPrefix.MatchString(id):
		return "a drive letter and colon at the start of its ID"
	}
	return ""
}

// shortText is how a message shows text that came from a pipeline: control
// characters, line separators and text-direction controls as escapes
// (escapeRune), and nothing past max characters, so a hostile value can't break
// the line, reorder it or push the explanation out of it.
func shortText(text string, max int) string {
	var out strings.Builder
	shown := 0
	for _, r := range text {
		if shown == max {
			out.WriteString("…")
			break
		}
		if hostileRune(r) {
			out.WriteString(escapeRune(r))
		} else {
			out.WriteRune(r)
		}
		shown++
	}
	return out.String()
}

// shortID is how a message shows a component ID.
func shortID(id string) string { return shortText(id, 64) }

// monitoringExporter finds the one listener restricted mode allows without a
// host allowance: Vectory's own monitoring path, a prometheus_exporter sink
// on a loopback address whose inputs are all internal_metrics sources. It
// serves Vector's own counters, never events, and only to this host, and it
// is what the agent reads delivery health from. Only the first such sink (by
// ID) qualifies; a second one, and anything else that listens, still needs
// its allowance. Everything else in the exporter (TLS files, for example) is
// checked as usual.
func monitoringExporter(root map[string]any) (id, address string) {
	sources, _ := root["sources"].(map[string]any)
	sinks, _ := root["sinks"].(map[string]any)
	internalMetrics := func(input any) bool {
		name, _ := input.(string)
		source, _ := sources[name].(map[string]any)
		typ, _ := source["type"].(string)
		return typ == "internal_metrics"
	}
	for _, id := range sortedKeys(sinks) {
		sink, _ := sinks[id].(map[string]any)
		typ, _ := sink["type"].(string)
		address, _ := sink["address"].(string)
		inputs, _ := sink["inputs"].([]any)
		if typ != "prometheus_exporter" || !loopbackListener(address) || len(inputs) == 0 {
			continue
		}
		fed := true
		for _, input := range inputs {
			fed = fed && internalMetrics(input)
		}
		if fed {
			return id, address
		}
	}
	return "", ""
}

// loopbackListener reports whether address is a loopback IP literal with an
// explicit port, such as 127.0.0.1:9598 or [::1]:9598.
func loopbackListener(address string) bool {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	number, err := strconv.Atoi(port)
	ip := net.ParseIP(host)
	return err == nil && number > 0 && number <= 65535 && ip != nil && ip.IsLoopback()
}

// component checks one component; the caller fills in its identity.
func (p CapabilityPolicy) component(section, typ string, c map[string]any) *PolicyRefusal {
	// Resource-bearing components cannot rely on implicit defaults, which
	// would bypass explicit local path/destination/listener authorization.
	missing := func(field, category string) *PolicyRefusal {
		r := refusal("NETWORK_DESTINATION_DENIED", category)
		r.Field = field
		return r
	}
	switch typ {
	case "http":
		if uri, ok := c["uri"].(string); !ok || uri == "" {
			return missing("uri", "capability denied: HTTP sink needs an explicit authorized uri")
		}
	case "loki":
		if uri, ok := c["endpoint"].(string); !ok || uri == "" {
			return missing("endpoint", "capability denied: Loki sink needs an explicit authorized endpoint")
		}
	case "elasticsearch":
		if endpoints, ok := c["endpoints"].([]any); !ok || len(endpoints) == 0 {
			return missing("endpoints", "capability denied: Elasticsearch needs explicit authorized endpoints")
		}
	case "http_server", "syslog", "prometheus_exporter":
		if address, ok := c["address"].(string); !ok || address == "" {
			r := refusal("LISTENER_DENIED", "capability denied: source needs an explicit authorized listener")
			r.Field = "address"
			return r
		}
	case "opentelemetry":
		for _, protocol := range []string{"grpc", "http"} {
			block, ok := c[protocol].(map[string]any)
			if !ok {
				r := refusal("LISTENER_DENIED", "capability denied: OpenTelemetry requires explicit HTTP and gRPC listener configuration")
				r.Field = protocol + ".address"
				return r
			}
			if address, ok := block["address"].(string); !ok || address == "" {
				r := refusal("LISTENER_DENIED", "capability denied: OpenTelemetry listener address required")
				r.Field = protocol + ".address"
				return r
			}
		}
	}
	if typ == "console" {
		if target := c["target"]; target != "stderr" {
			r := refusal("CONSOLE_TARGET_DENIED", "capability denied: console requires explicit stderr target to isolate JSON startup logs")
			r.Field = "target"
			return r
		}
	}
	if !supported[section][typ] {
		return refusal("UNSUPPORTED_LOCAL_CAPABILITY", "capability denied: unsupported "+section+" component")
	}
	// remap.file loads a VRL program from any path on the device; Vector
	// compiles it and quotes it in errors, so it is neither checked against the
	// file roots nor scanned for external functions. `files` is refused by walk.
	if _, ok := c["file"]; ok && typ == "remap" {
		r := refusal("UNSUPPORTED_LOCAL_CAPABILITY", "capability denied: executable, provider, or external code setting")
		r.Field = "file"
		return r
	}
	// No host allowance permits an AWS credentials file or the host's own AWS
	// identity, so these come before the checks that an allowance can satisfy.
	if e := credentialRefusal(typ, c); e != nil {
		return e
	}
	// A `path` names a file only for a Unix socket. For http_server and loki it
	// is the URL path, which needs no file allowance.
	mode, _ := c["mode"].(string)
	return p.walkIn(c, "", typ == "syslog" && mode == "unix")
}

// credentialRefusal refuses what no host allowance can permit in an AWS
// credential: a credentials file, and the host's own identity.
func credentialRefusal(typ string, c map[string]any) *PolicyRefusal {
	if field := credentialsFileField(c, nil, false); field != "" {
		r := refusal("CREDENTIALS_FILE_DENIED", "capability denied: an AWS credentials file can run a program")
		r.Field = field
		return r
	}
	return ambientAWSRefusal(typ, c)
}

// credentialsFileField is the path of the first credentials_file key below an
// auth block, in a stable order, or "". The rule is on the key name, so any
// component that has the field is covered, however deep it stands below auth.
func credentialsFileField(value any, path []string, belowAuth bool) string {
	switch x := value.(type) {
	case map[string]any:
		for _, k := range sortedKeys(x) {
			here := append(slices.Clone(path), k)
			lower := strings.ToLower(k)
			if belowAuth && lower == credentialsFileKey {
				return boundedFieldPath(strings.Join(here, "."))
			}
			if found := credentialsFileField(x[k], here, belowAuth || lower == "auth"); found != "" {
				return found
			}
		}
	case []any:
		for _, item := range x {
			if found := credentialsFileField(item, path, belowAuth); found != "" {
				return found
			}
		}
	}
	return ""
}

// ambientAWSRefusal refuses a sink that signs with the AWS strategy and
// doesn't carry explicit keys, in the object where the sink reads them.
func ambientAWSRefusal(typ string, c map[string]any) *PolicyRefusal {
	path, signs := awsCredentialPath[typ]
	if !signs {
		return nil
	}
	auth, _ := c["auth"].(map[string]any)
	if strategy, _ := auth["strategy"].(string); !strings.EqualFold(strategy, "aws") {
		return nil
	}
	credential := c
	for _, key := range path {
		credential, _ = credential[key].(map[string]any) // a missing or non-object block reads as empty
	}
	if explicitAWSCredential(credential) {
		return nil
	}
	r := refusal("AMBIENT_CREDENTIALS_DENIED", "capability denied: ambient AWS credentials")
	r.Field = strings.Join(path, ".")
	return r
}

// explicitAWSCredential says whether an AWS credential object names its own
// keys and borrows nothing from the host: both keys are non-empty strings, and
// no role to assume, metadata client setting or profile starts from the host's
// chain. A value is present unless it is null or false, as the capability
// table reads it.
func explicitAWSCredential(credential map[string]any) bool {
	for _, key := range awsExplicitKeys {
		if value, _ := credential[key].(string); strings.TrimSpace(value) == "" {
			return false
		}
	}
	for key, value := range credential {
		if slices.Contains(awsAmbientKeys, strings.ToLower(key)) && value != nil && value != false {
			return false
		}
	}
	return true
}

// boundedFieldPath is how a refusal names a field of the pipeline: control characters
// replaced and the length bounded, so a hostile key can't break the report.
func boundedFieldPath(path string) string {
	var out []rune
	for _, r := range path {
		if len(out) == 100 {
			out = append(out, '…')
			break
		}
		if unicode.IsControl(r) {
			r = '?'
		}
		out = append(out, r)
	}
	return string(out)
}

// checkTests accepts Vector unit tests in restricted mode. Tests run only in
// `vector test` during validation: they insert sample events into
// transforms and check the output, with no sources, sinks or I/O. Sample
// events are data, not resources, so only their VRL (input and condition
// `source` programs) is checked for functions that reach outside the event.
func checkTests(v any) *PolicyRefusal {
	tests, ok := v.([]any)
	if !ok {
		r := refusal("UNSUPPORTED_LOCAL_CAPABILITY", "capability denied: unsupported top-level setting")
		r.Resource = "tests"
		return r
	}
	var find func(any) *PolicyRefusal
	find = func(value any) *PolicyRefusal {
		switch x := value.(type) {
		case map[string]any:
			for _, k := range sortedKeys(x) {
				if e := find(x[k]); e != nil {
					return e
				}
			}
		case []any:
			for _, item := range x {
				if e := find(item); e != nil {
					return e
				}
			}
		case string:
			return vrlRefusal(x, "tests")
		}
		return nil
	}
	return find(tests)
}

// externalFunction names the first external VRL function a program calls.
func externalFunction(program string) string {
	for i, call := range externalCalls {
		if call.MatchString(program) {
			return externalVRL[i]
		}
	}
	return ""
}

// vrlRefusal refuses a string that calls a VRL function restricted mode doesn't
// allow: one that reaches outside the event, or one that passes a file, which
// Vector reads when it compiles the program. field is the setting that holds
// the string.
func vrlRefusal(program, field string) *PolicyRefusal {
	if function := externalFunction(program); function != "" {
		r := refusal("DYNAMIC_CAPABILITY_DENIED", "capability denied: external VRL capability")
		r.Field, r.Resource = field, function
		return r
	}
	if calls := fileArgumentCalls(program); len(calls) > 0 {
		r := refusal("DYNAMIC_CAPABILITY_DENIED", calls[0].category())
		r.Field, r.Resource, r.Argument = field, calls[0].name, calls[0].argument
		return r
	}
	return nil
}

func (p CapabilityPolicy) walk(v any, key string) *PolicyRefusal {
	return p.walkIn(v, key, false)
}

// walkIn checks a component's settings; pathIsFile says whether a `path`
// setting names a file (a Unix socket) rather than a URL path.
func (p CapabilityPolicy) walkIn(v any, key string, pathIsFile bool) *PolicyRefusal {
	switch x := v.(type) {
	case map[string]any:
		for _, k := range sortedKeys(x) {
			value := x[k]
			lower := strings.ToLower(k)
			if lower == "command" || lower == "exec" || lower == "provider" || lower == "secret" || lower == "secrets" || lower == "source_files" || lower == "files" || lower == "enrichment_tables" {
				r := refusal("UNSUPPORTED_LOCAL_CAPABILITY", "capability denied: executable, provider, or external code setting")
				r.Field = k
				return r
			}
			if lower == "verify_certificate" || lower == "verify_hostname" {
				if b, ok := value.(bool); ok && !b {
					r := refusal("TLS_VERIFICATION_REQUIRED", "TLS verification cannot be disabled")
					r.Field = lower
					return r
				}
			}
			if e := p.walkIn(value, lower, pathIsFile); e != nil {
				return e
			}
		}
	case []any:
		for _, value := range x {
			if e := p.walkIn(value, key, pathIsFile); e != nil {
				return e
			}
		}
	case string:
		if environmentVariable.MatchString(x) || strings.Contains(x, "${") || strings.Contains(x, "{{") || strings.Contains(x, "%{") {
			r := refusal("DYNAMIC_CAPABILITY_DENIED", "capability denied: substitution and dynamic resource templates are unsupported")
			r.Field = key
			return r
		}
		if r := vrlRefusal(x, key); r != nil {
			return r
		}
		if key == "endpoint" || key == "endpoints" || key == "uri" || key == "url" || strings.Contains(x, "://") {
			if e := p.network(x); e != nil {
				e.Field = key
				return e
			}
		}
		if key == "address" && !p.listenerAllowed(x) {
			r := refusal("LISTENER_DENIED", "capability denied: listener is not locally allowed")
			r.Field, r.Resource, r.Allowance, r.Suggested = key, x, "allowed_listen_addresses", x
			return r
		}
		if key == "include" || key == "exclude" || (key == "path" && pathIsFile) || strings.HasSuffix(key, "_file") || strings.HasSuffix(key, "_path") || strings.HasSuffix(key, "_dir") {
			if e := p.file(x); e != nil {
				e.Field = key
				return e
			}
		}
	}
	return nil
}

// listenerAllowed reports whether an exact listen address is locally allowed.
func (p CapabilityPolicy) listenerAllowed(address string) bool {
	for _, a := range p.AllowedListenAddresses {
		if address == a {
			return true
		}
	}
	return false
}
func (p CapabilityPolicy) network(s string) *PolicyRefusal {
	u, e := url.Parse(s)
	if e != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		r := refusal("NETWORK_DESTINATION_DENIED", "capability denied: invalid network destination")
		if e == nil && u.User == nil {
			r.Resource = s
		}
		return r
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	host := net.JoinHostPort(strings.ToLower(u.Hostname()), port)
	for _, allowed := range p.AllowedNetworkHosts {
		if host == strings.ToLower(allowed) {
			return nil
		}
	}
	r := refusal("NETWORK_DESTINATION_DENIED", "capability denied: network destination is not locally allowed")
	r.Resource, r.Allowance, r.Suggested = host, "allowed_network_hosts", host
	return r
}
func (p CapabilityPolicy) file(s string) *PolicyRefusal {
	denied := func(category string) *PolicyRefusal {
		r := refusal("FILE_ACCESS_DENIED", category)
		r.Resource = s
		return r
	}
	if !filepath.IsAbs(s) {
		return denied("capability denied: resource path must be absolute")
	}
	clean := filepath.Clean(s)
	// Wildcards may occur only below an allowed root; check all existing matches for links.
	static := clean
	if i := strings.IndexAny(static, "*?["); i >= 0 {
		static = filepath.Dir(static[:i])
	}
	for _, root := range p.AllowedFileRoots {
		if !filepath.IsAbs(root) {
			continue
		}
		rel, e := filepath.Rel(filepath.Clean(root), clean)
		if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		if e = SafePath(static); e != nil {
			return denied("capability denied: resource has unsafe path")
		}
		matches, e := filepath.Glob(clean)
		if e != nil {
			return denied("invalid resource glob")
		}
		for _, m := range matches {
			if e = SafePath(m); e != nil {
				return denied("capability denied: resource links are forbidden")
			}
		}
		return nil
	}
	r := denied("capability denied: file root is not locally allowed")
	// Suggest the directory itself (or the static part of a pattern), but never
	// the filesystem root or a top-level directory: following that advice would
	// hand every file the service account can read to restricted publishers.
	suggested := static
	if static == clean && !strings.HasSuffix(s, string(filepath.Separator)) {
		suggested = filepath.Dir(clean)
	}
	if strings.Count(filepath.ToSlash(suggested), "/") < 2 {
		suggested = ""
	}
	r.Allowance, r.Suggested = "allowed_file_roots", suggested
	return r
}
