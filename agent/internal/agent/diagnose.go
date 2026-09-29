package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Bounds for diagnostics that leave the host (heartbeat protocol limits).
const (
	maxDiagnostics       = 10
	maxDiagnosticBytes   = 512
	maxDiagnosticMessage = 300
	maxDiagnosticHint    = 200
	redactedToken        = "«redacted»"
	// Vector's built-in data_dir when a configuration sets none.
	vectorDefaultDataDir = "/var/lib/vector/"
)

// Diagnostic is one structured finding from Vector's own output. Every text
// field has passed redaction: a token may be echoed only when it appears in
// the published, secret-free template (component IDs, paths, VRL text, field
// names) or in this host's reported runtime settings.
type Diagnostic struct {
	Severity      string `json:"severity"`
	Code          string `json:"code"`
	ComponentKind string `json:"component_kind,omitempty"`
	ComponentID   string `json:"component_id,omitempty"`
	RouteOutput   string `json:"route_output,omitempty"`
	Field         string `json:"field,omitempty"`
	Line          int    `json:"line,omitempty"`
	Column        int    `json:"column,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Message       string `json:"message"`
	Hint          string `json:"hint,omitempty"`
}

// VectorFailure carries Vector's raw, bounded output for a failed native
// step. The output never leaves the host: Engine turns it into redacted
// Diagnostics and appends it to the private local Vector log.
type VectorFailure struct {
	Phase   string // validate, test, start, reload, timeout
	Summary string // fixed, secret-free sentence
	Output  []byte // text output (validate/test)
	Records []vectorRecord
	// Diagnostics prepared by the agent itself (not yet redacted).
	Diagnostics []Diagnostic
}

func (f *VectorFailure) Error() string { return f.Summary }

func asVectorFailure(err error) *VectorFailure {
	var failure *VectorFailure
	if errors.As(err, &failure) {
		return failure
	}
	return nil
}

type componentRef struct{ Kind, Type string }

// redactor knows which tokens are safe to echo and which values must never be.
type redactor struct {
	safe       map[string]bool
	secrets    []string
	labels     [][2]string
	components map[string]componentRef
}

var (
	ansiEscape      = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)
	quotedText      = regexp.MustCompile("\"(?:[^\"\\\\]|\\\\.)*\"|`[^`\n]*`|'[^'\n]*'")
	wordPattern     = regexp.MustCompile(`\S+`)
	ipAddress       = regexp.MustCompile(`^\[?[0-9a-fA-F:.]*\d[0-9a-fA-F:.]*\]?(?::\d+)?$`)
	windowsPathLike = regexp.MustCompile(`^[A-Za-z]:\\`)
	envReference    = regexp.MustCompile(`\$\{?([A-Za-z_][A-Za-z0-9_]*)`)
	stageFile       = regexp.MustCompile(`[^\s"'\x60]*\.vectory-stage-[0-9a-f]+\.json|[^\s"'\x60]*host-runtime-stage-[0-9a-f]+\.json`)
	trimPunctuation = "()[]{},;:.!?<>'\"`"
)

// Vector's own fixed vocabulary: event types and reserved output names.
var vectorVocabulary = map[string]bool{"Log": true, "Metric": true, "Trace": true, "log": true, "metric": true, "trace": true, "_unmatched": true, "_default": true, "dropped": true}

func newRedactor() *redactor {
	r := &redactor{safe: map[string]bool{}, components: map[string]componentRef{}}
	for word := range vectorVocabulary {
		r.safe[word] = true
	}
	r.safe[vectorDefaultDataDir] = true
	r.safe[strings.TrimSuffix(vectorDefaultDataDir, "/")] = true
	return r
}

func (r *redactor) allowText(value string) {
	if value == "" || len(value) > 64*1024 {
		return
	}
	r.safe[value] = true
	for _, line := range strings.Split(value, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			r.safe[line] = true
		}
		for _, word := range strings.Fields(line) {
			r.safe[word] = true
			if core := strings.Trim(word, trimPunctuation); core != "" {
				r.safe[core] = true
			}
		}
	}
}

func (r *redactor) addSecret(value string) {
	if len(value) >= 4 {
		r.secrets = append(r.secrets, value)
	}
}

func (r *redactor) addLabel(path, label string) {
	if path != "" {
		r.labels = append(r.labels, [2]string{path, label})
	}
}

// learnConfiguration indexes an effective configuration. Its tokens become
// echo-safe, except credential leaves, which are treated as secrets: the
// only fields that can hold resolved local secrets are never trusted.
func (r *redactor) learnConfiguration(data []byte, fullVector bool) {
	var root map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if decoder.Decode(&root) != nil {
		return
	}
	for section, kind := range map[string]string{"sources": "source", "transforms": "transform", "sinks": "sink"} {
		components, _ := root[section].(map[string]any)
		for id, raw := range components {
			component, _ := raw.(map[string]any)
			typ, _ := component["type"].(string)
			r.components[id] = componentRef{kind, typ}
			if section == "sinks" {
				if auth, ok := component["auth"].(map[string]any); ok {
					for _, field := range []string{"user", "password", "token"} {
						if value, ok := auth[field].(string); ok {
							r.addSecret(value)
						}
					}
				}
			}
		}
	}
	var walk func(any, string)
	walk = func(value any, key string) {
		switch v := value.(type) {
		case map[string]any:
			for k, child := range v {
				r.safe[k] = true
				walk(child, strings.ToLower(k))
			}
		case []any:
			for _, child := range v {
				walk(child, key)
			}
		case string:
			if name, ok := strings.CutPrefix(v, secretPrefix); ok {
				r.safe[name] = true
			}
			if key == "user" || key == "password" || key == "token" {
				return
			}
			r.allowText(v)
			for _, match := range envReference.FindAllStringSubmatch(v, -1) {
				r.safe[match[1]] = true
				if value, ok := os.LookupEnv(match[1]); ok && fullVector {
					r.addSecret(value)
				}
			}
		case json.Number:
			r.safe[v.String()] = true
		}
	}
	walk(root, "")
	sort.Slice(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
}

func (r *redactor) allowed(token string) bool {
	return r.safe[token] || r.safe[strings.Trim(token, trimPunctuation)]
}

// sensitive reports tokens that could carry host or secret data when they do
// not come from the template: long tokens, URLs, paths, addresses, emails.
func sensitive(core string) bool {
	if strings.Contains(core, redactedToken) || core == "" {
		return false
	}
	return utf8.RuneCountInString(core) >= 24 || strings.Contains(core, "://") || strings.HasPrefix(core, "/") ||
		strings.HasPrefix(core, `\\`) || strings.Contains(core, "@") || windowsPathLike.MatchString(core) ||
		(strings.ContainsAny(core, ".:") && ipAddress.MatchString(core))
}

// text redacts free text. Secret values always go; known local paths become
// labels; quoted content must be template-derived; unquoted sensitive tokens
// must be template-derived.
func (r *redactor) text(s string) string {
	s = strings.ToValidUTF8(ansiEscape.ReplaceAllString(s, ""), "")
	for _, secret := range r.secrets {
		s = strings.ReplaceAll(s, secret, redactedToken)
	}
	for _, label := range r.labels {
		s = strings.ReplaceAll(s, label[0], label[1])
	}
	s = stageFile.ReplaceAllStringFunc(s, func(path string) string {
		if strings.Contains(path, "host-runtime-stage-") {
			return "host runtime settings"
		}
		return "staged configuration"
	})
	s = quotedText.ReplaceAllStringFunc(s, func(q string) string {
		inner := q[1 : len(q)-1]
		if inner == "" || r.allowed(inner) || inner == "staged configuration" || inner == "managed configuration" || inner == "host runtime settings" {
			return q
		}
		return q[:1] + redactedToken + q[len(q)-1:]
	})
	return wordPattern.ReplaceAllStringFunc(s, func(word string) string {
		if strings.Contains(word, redactedToken) {
			return word
		}
		core := strings.Trim(word, trimPunctuation)
		if !sensitive(core) || r.allowed(core) || r.allowed(word) {
			return word
		}
		return strings.Replace(word, core, redactedToken, 1)
	})
}

// identifier returns a component ID or output name only if it is a bounded
// token from the template; anything else is dropped rather than echoed.
func (r *redactor) identifier(value string) string {
	if value == "" || len(value) > 100 || !r.allowed(value) || strings.IndexFunc(value, func(c rune) bool {
		return !(unicode.IsLetter(c) || unicode.IsDigit(c) || strings.ContainsRune("_-.", c))
	}) >= 0 {
		return ""
	}
	return value
}

func truncateText(value string, max int) string {
	value = strings.TrimSpace(strings.Join(strings.Fields(value), " "))
	if utf8.RuneCountInString(value) <= max {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:max-1])) + "…"
}

func capitalize(value string) string {
	r, size := utf8.DecodeRuneInString(value)
	if size == 0 {
		return value
	}
	return string(unicode.ToUpper(r)) + value[size:]
}

// finalize redacts and bounds one diagnostic so it serializes to at most
// maxDiagnosticBytes.
func (r *redactor) finalize(d Diagnostic) Diagnostic {
	if d.Severity != "warning" {
		d.Severity = "error"
	}
	d.ComponentID = r.identifier(d.ComponentID)
	d.RouteOutput = r.identifier(d.RouteOutput)
	if ref, ok := r.components[d.ComponentID]; ok && d.ComponentKind == "" {
		d.ComponentKind = ref.Kind
	}
	if d.ComponentKind != "source" && d.ComponentKind != "transform" && d.ComponentKind != "sink" {
		d.ComponentKind = ""
	}
	if d.ComponentID == "" {
		d.RouteOutput = ""
	}
	if d.Line < 0 || d.Line > 1_000_000 {
		d.Line = 0
	}
	if d.Column < 0 || d.Column > 1_000_000 {
		d.Column = 0
	}
	d.Message = truncateText(r.text(d.Message), maxDiagnosticMessage)
	if first, _, _ := strings.Cut(d.Message, " "); r.components[strings.Trim(first, trimPunctuation)] == (componentRef{}) {
		d.Message = capitalize(d.Message)
	}
	d.Hint = truncateText(r.text(d.Hint), maxDiagnosticHint)
	if d.Hint == "" {
		d.Hint = codeHints[d.Code]
	}
	d.Field = truncateText(r.text(d.Field), 128)
	if d.Message == "" {
		d.Message = "Vector reported an error."
	}
	for {
		encoded, _ := json.Marshal(d)
		if len(encoded) <= maxDiagnosticBytes {
			return d
		}
		switch {
		case d.Hint != "":
			d.Hint = ""
		case utf8.RuneCountInString(d.Message) > 60:
			d.Message = truncateText(d.Message, utf8.RuneCountInString(d.Message)-40)
		default:
			d.Field = ""
			return d
		}
	}
}

// codeHints are fixed, secret-free fixes for findings Vector reports without
// a suggestion of its own. Each is at most maxDiagnosticHint characters.
var codeHints = map[string]string{
	"DATA_DIR_MISSING":       "Remove data_dir from the pipeline to use the device's own data directory, or create this directory on the device.",
	"DATA_DIR_NOT_WRITABLE":  "Give the Vector service account write access, or remove data_dir from the pipeline to use the device's own data directory.",
	"DATA_DIR_CONFLICT":      "Remove data_dir from the pipeline to use the device's own data directory.",
	"HEALTHCHECK_FAILED":     "Vector still starts and retries delivery. Check the destination address, credentials and network access from the device.",
	"HEALTHCHECK_REQUIRED":   "Fix the failing sink, or remove healthchecks.require_healthy so Vector starts while a destination is down.",
	"ADDRESS_IN_USE":         "Stop the other process, or change this component's address.",
	"INVALID_ADDRESS":        "Use host:port, for example 127.0.0.1:9598.",
	"ENV_VAR_MISSING":        "Set it in the Vector service's environment on the device, or remove the reference from the pipeline.",
	"INPUT_NOT_FOUND":        "Change inputs to the ID of an existing source or transform.",
	"EVENT_TYPE_MISMATCH":    "Connect a component that emits the accepted event type, or convert events first (for example with log_to_metric).",
	"TLS_FILE_UNREADABLE":    "Check that the certificate and key files exist on the device and that the Vector service account can read them.",
	"FILE_NOT_FOUND":         "Check that the path exists on the device.",
	"PERMISSION_DENIED":      "Give the Vector service account access to the path, or change the path.",
	"UNKNOWN_FIELD":          "Remove the field or correct its name; check the component's reference for Vector " + VectorVersion + ".",
	"UNKNOWN_COMPONENT_TYPE": "Use a component type that Vector " + VectorVersion + " supports.",
	"MISSING_FIELD":          "Add the required field to this component.",
	"VRL_E100":               "Handle the error case, for example with a fallback: to_int(.status) ?? 0.",
	"OUTPUT_UNUSED":          "Connect it to a sink or transform, or remove it if unneeded.",
	"TEST_FAILED":            "Fix the transform, or update the test's expected values.",
}

// diagnosticSet dedupes, orders (errors first) and bounds diagnostics.
type diagnosticSet struct {
	items []Diagnostic
	seen  map[string]int
}

// add keeps one record per finding. Vector repeats transform errors in its
// "Transform errors" and "Component errors" sections, sometimes without the
// route name, so duplicates merge into the most specific record.
func (s *diagnosticSet) add(d Diagnostic) {
	if s.seen == nil {
		s.seen = map[string]int{}
	}
	key := strings.Join([]string{d.Severity, d.Code, d.ComponentID, strconv.Itoa(d.Line), strconv.Itoa(d.Column), d.Message}, "\x00")
	if i, ok := s.seen[key]; ok {
		existing := &s.items[i]
		if existing.RouteOutput == "" && d.RouteOutput != "" {
			existing.RouteOutput, existing.Field = d.RouteOutput, d.Field
		}
		if existing.Field == "" {
			existing.Field = d.Field
		}
		if existing.Hint == "" {
			existing.Hint = d.Hint
		}
		return
	}
	s.seen[key] = len(s.items)
	s.items = append(s.items, d)
}

func (s *diagnosticSet) result() []Diagnostic {
	sort.SliceStable(s.items, func(i, j int) bool {
		return s.items[i].Severity == "error" && s.items[j].Severity != "error"
	})
	if len(s.items) > maxDiagnostics {
		return s.items[:maxDiagnostics]
	}
	return s.items
}

// ---- Network error classification ----

var httpStatus = regexp.MustCompile(`(?i)(?:status(?: code)?[: ]+|responded with (?:an error: )?|http )([1-5]\d\d)\b`)

// classifyNetwork maps an error chain to a bounded reason.
func classifyNetwork(text string) string {
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "connection refused"):
		return "connection_refused"
	case strings.Contains(lower, "dns error") || strings.Contains(lower, "failed to lookup address") || strings.Contains(lower, "name or service not known") || strings.Contains(lower, "no such host") || strings.Contains(lower, "nodename nor servname"):
		return "dns"
	case strings.Contains(lower, "certificate") || strings.Contains(lower, "tls") || strings.Contains(lower, "ssl") || strings.Contains(lower, "handshake"):
		return "tls"
	case strings.Contains(lower, "timed out") || strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline"):
		return "timeout"
	case strings.Contains(lower, "connection reset") || strings.Contains(lower, "broken pipe"):
		return "connection_reset"
	case strings.Contains(lower, "no route to host") || strings.Contains(lower, "network is unreachable"):
		return "unreachable"
	case strings.Contains(lower, "address already in use") || strings.Contains(lower, "addrinuse"):
		return "address_in_use"
	case strings.Contains(lower, "permission denied"):
		return "permission_denied"
	case strings.Contains(lower, "no such file or directory"):
		return "not_found"
	}
	if m := httpStatus.FindStringSubmatch(text); m != nil {
		return "http_" + m[1]
	}
	return ""
}

// reasonText says what a network reason means, in words.
var reasonText = map[string]string{
	"connection_refused": "the destination refused the connection",
	"dns":                "the destination's host name could not be resolved",
	"tls":                "the TLS handshake failed",
	"timeout":            "the request timed out",
	"connection_reset":   "the connection was reset",
	"unreachable":        "the destination network is unreachable",
	"permission_denied":  "permission denied",
}

// causeOf returns the most specific segment of a Vector error chain.
func causeOf(chain string) string {
	parts := strings.Split(chain, ": ")
	return strings.TrimSpace(parts[len(parts)-1])
}

func healthDiagnostic(kind, id, chain string) Diagnostic {
	reason := classifyNetwork(chain)
	cause := reasonText[reason]
	if strings.HasPrefix(reason, "http_") {
		cause = "the destination answered HTTP " + strings.TrimPrefix(reason, "http_")
	}
	if cause == "" {
		cause = causeOf(chain)
	}
	return Diagnostic{Severity: "warning", Code: "HEALTHCHECK_FAILED", ComponentKind: kind, ComponentID: id, Reason: reason, Message: "Health check failed: " + cause + "."}
}

// ---- VRL diagnostic blocks ----

var (
	vrlHeader   = regexp.MustCompile(`error\[(E\d{3})\]:\s*(.*)$`)
	vrlPosition = regexp.MustCompile(`┌─\s*[^:\s]*:(\d+):(\d+)`)
	vrlGutter   = regexp.MustCompile(`^\s*(\d+)?\s*│(.*)$`)
	vrlNote     = regexp.MustCompile(`^\s*=\s?(.*)$`)
)

type vrlBlock struct {
	code, title, suggestion string
	line, column            int
	labels                  []string
}

func parseVRLBlock(lines []string) (vrlBlock, bool) {
	var b vrlBlock
	start := -1
	for i, line := range lines {
		if m := vrlHeader.FindStringSubmatch(line); m != nil {
			b.code, b.title, start = m[1], strings.TrimSpace(m[2]), i
			break
		}
	}
	if start < 0 {
		return b, false
	}
	expectSuggestion, inTry := false, false
	for _, line := range lines[start+1:] {
		if m := vrlPosition.FindStringSubmatch(line); m != nil && b.line == 0 {
			b.line, _ = strconv.Atoi(m[1])
			b.column, _ = strconv.Atoi(m[2])
			continue
		}
		if m := vrlGutter.FindStringSubmatch(line); m != nil {
			if m[1] != "" {
				continue // a source line; the dashboard shows it from the pipeline itself
			}
			content := strings.TrimSpace(strings.TrimLeft(m[2], " -^│|"))
			if content == "" {
				continue
			}
			if expectSuggestion && b.suggestion == "" {
				b.suggestion = content
				expectSuggestion = false
				continue
			}
			if strings.HasPrefix(strings.ToLower(content), "or change this to") {
				expectSuggestion = true
				continue
			}
			if i := strings.Index(content, "expected one of"); i >= 0 {
				content = strings.TrimSpace(content[:i])
			}
			if content != "" && len(b.labels) < 3 {
				b.labels = append(b.labels, content)
			}
			continue
		}
		if m := vrlNote.FindStringSubmatch(line); m != nil {
			note := strings.TrimSpace(m[1])
			lower := strings.ToLower(note)
			switch {
			case strings.HasPrefix(lower, "try:"):
				inTry = b.suggestion == ""
			case note == "":
			case strings.HasPrefix(lower, "see ") || strings.HasPrefix(lower, "learn more") || strings.HasPrefix(lower, "try your code"):
				inTry = false
			case inTry && b.suggestion == "":
				b.suggestion = note
			}
		}
	}
	return b, true
}

// vrlField names the configuration field that holds the VRL program.
func vrlField(ref componentRef, route string) string {
	switch {
	case route != "":
		return "route." + route
	case ref.Type == "remap":
		return "source"
	case ref.Type == "filter":
		return "condition"
	case ref.Type == "sample":
		return "exclude"
	}
	return ""
}

var vrlParameter = regexp.MustCompile(`parameter "([a-z_][a-z0-9_]{0,31})"`)

func (r *redactor) vrlDiagnostic(block vrlBlock, kind, id, route string) Diagnostic {
	message := block.title
	for i, label := range block.labels {
		// VRL function parameter names are compiler vocabulary, not data.
		for _, m := range vrlParameter.FindAllStringSubmatch(label, -1) {
			r.safe[m[1]] = true
		}
		separator := "; "
		if i == 0 {
			separator = ": "
		} else if strings.HasPrefix(label, "but ") || strings.HasPrefix(label, "and ") {
			separator = " "
		}
		message += separator + label
	}
	d := Diagnostic{Code: "VRL_" + block.code, ComponentKind: kind, ComponentID: id, RouteOutput: route, Line: block.line, Column: block.column, Message: message}
	if ref, ok := r.components[id]; ok {
		d.ComponentKind = ref.Kind
		d.Field = vrlField(ref, route)
	}
	if block.suggestion != "" {
		d.Hint = "Try: " + block.suggestion
	}
	if block.code == "E000" {
		d.Code = "VRL_RUNTIME_ERROR"
	}
	return d
}

// ---- `vector validate` text output ----

var (
	componentError  = regexp.MustCompile(`^(Source|Transform|Sink) "([^"]+)":\s*(?:route "([^"]+)":\s*)?(.*)$`)
	componentPath   = regexp.MustCompile(`^(sources|transforms|sinks)\.([^:\s]+):\s*(.*)$`)
	dataDirMissing  = regexp.MustCompile(`^data_dir "(.*)" does not exist$`)
	dataDirReadonly = regexp.MustCompile(`^data_dir "(.*)" is not writable$`)
	healthFailed    = regexp.MustCompile(`^Health check for "([^"]+)" failed:\s*(.*)$`)
	typeMismatch    = regexp.MustCompile(`^Data type mismatch between (\S+) \((.*)\) and (\S+) \((.*)\)$`)
	inputMissing    = regexp.MustCompile(`^Input "([^"]+)" for (sink|transform) "([^"]+)" doesn't match any components\.?$`)
	envMissing      = regexp.MustCompile(`^Missing environment variable in config\. name = "([^"]+)"`)
	noConsumers     = regexp.MustCompile(`^(?:Source|Transform) "([^"]+)" has no consumers$`)
	textLogLine     = regexp.MustCompile(`^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s`)
	sectionHeader   = regexp.MustCompile(`^(Transform errors|Component errors|Failed to load \[|Loaded with warnings \[|-{3,}\s*$|\s+Validated\s*$)`)
)

func isOutputMarker(line string) bool {
	return strings.HasPrefix(line, "x ") || strings.HasPrefix(line, "~ ") || strings.HasPrefix(line, "√ ") ||
		sectionHeader.MatchString(line) || textLogLine.MatchString(line)
}

func singular(section string) string {
	return strings.TrimSuffix(section, "s")
}

func (r *redactor) componentFailure(kind, id, text string) Diagnostic {
	d := Diagnostic{ComponentKind: strings.ToLower(kind), ComponentID: id, Code: "COMPONENT_BUILD_FAILED", Message: text}
	d.Reason = classifyNetwork(text)
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "certificate") || strings.Contains(lower, "private key") || strings.Contains(lower, "tls"):
		d.Code, d.Field = "TLS_FILE_UNREADABLE", "tls"
	case d.Reason == "address_in_use":
		d.Code, d.Field = "ADDRESS_IN_USE", "address"
	case d.Reason == "not_found":
		d.Code = "FILE_NOT_FOUND"
	case d.Reason == "permission_denied":
		d.Code = "PERMISSION_DENIED"
	}
	return d
}

func (r *redactor) classifyValidationError(body string, block []string) Diagnostic {
	if m := componentError.FindStringSubmatch(body); m != nil {
		kind, id, route, rest := strings.ToLower(m[1]), m[2], m[3], strings.TrimSpace(m[4])
		if vrl, ok := parseVRLBlock(append([]string{rest}, block...)); ok {
			return r.vrlDiagnostic(vrl, kind, id, route)
		}
		return r.componentFailure(kind, id, rest)
	}
	if m := dataDirMissing.FindStringSubmatch(body); m != nil {
		return Diagnostic{Code: "DATA_DIR_MISSING", Field: "data_dir", Message: "The data directory \"" + m[1] + "\" does not exist on this device."}
	}
	if m := dataDirReadonly.FindStringSubmatch(body); m != nil {
		return Diagnostic{Code: "DATA_DIR_NOT_WRITABLE", Field: "data_dir", Message: "Vector cannot write to the data directory \"" + m[1] + "\"."}
	}
	if strings.HasPrefix(body, "conflicting values for 'data_dir'") {
		return Diagnostic{Code: "DATA_DIR_CONFLICT", Field: "data_dir", Message: "The pipeline and this device set different data directories."}
	}
	if m := healthFailed.FindStringSubmatch(body); m != nil {
		return healthDiagnostic("sink", m[1], m[2])
	}
	if m := typeMismatch.FindStringSubmatch(body); m != nil {
		return Diagnostic{Code: "EVENT_TYPE_MISMATCH", ComponentID: m[3], Field: "inputs", Message: "Event types don't match: " + m[1] + " sends " + eventTypes(m[2]) + ", but " + m[3] + " accepts only " + eventTypes(m[4]) + "."}
	}
	if m := inputMissing.FindStringSubmatch(body); m != nil {
		return Diagnostic{Code: "INPUT_NOT_FOUND", ComponentKind: m[2], ComponentID: m[3], Field: "inputs", Message: "Input \"" + m[1] + "\" does not match any component."}
	}
	if m := envMissing.FindStringSubmatch(body); m != nil {
		return Diagnostic{Code: "ENV_VAR_MISSING", Message: "Environment variable \"" + m[1] + "\" is not set on this device."}
	}
	if m := componentPath.FindStringSubmatch(body); m != nil {
		kind, id, rest := singular(m[1]), m[2], m[3]
		d := Diagnostic{Code: "CONFIG_INVALID", ComponentKind: kind, ComponentID: id, Message: rest}
		switch {
		case strings.HasPrefix(rest, "unknown variant"):
			d.Code, d.Field = "UNKNOWN_COMPONENT_TYPE", "type"
			if i := strings.Index(rest, ", expected"); i >= 0 {
				d.Message = rest[:i]
			}
		case strings.HasPrefix(rest, "unknown field"):
			d.Code = "UNKNOWN_FIELD"
			if i := strings.Index(rest, ", expected"); i >= 0 {
				d.Message = rest[:i]
			}
		case strings.HasPrefix(rest, "missing field"):
			d.Code = "MISSING_FIELD"
		case strings.Contains(rest, "socket address"):
			d.Code, d.Field = "INVALID_ADDRESS", "address"
		}
		return d
	}
	lower := strings.ToLower(body)
	if strings.Contains(lower, "secret") {
		return Diagnostic{Code: "SECRET_UNAVAILABLE", Message: body}
	}
	return Diagnostic{Code: "VALIDATION_ERROR", Message: body}
}

func eventTypes(list string) string {
	var types []string
	for _, t := range []string{"Log", "Metric", "Trace"} {
		if strings.Contains(list, "\""+t+"\"") {
			types = append(types, strings.ToLower(t)+"s")
		}
	}
	if len(types) == 0 {
		return "other events"
	}
	return strings.Join(types, " and ")
}

// parseValidateOutput turns `vector validate` text output into diagnostics.
func (r *redactor) parseValidateOutput(output []byte) []Diagnostic {
	lines := strings.Split(strings.ToValidUTF8(ansiEscape.ReplaceAllString(string(output), ""), ""), "\n")
	var set diagnosticSet
	for i := 0; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], " \r")
		switch {
		case strings.HasPrefix(line, "x "):
			j := i + 1
			for j < len(lines) && !isOutputMarker(strings.TrimRight(lines[j], "\r")) {
				j++
			}
			set.add(r.finalize(r.classifyValidationError(strings.TrimSpace(line[2:]), lines[i+1:j])))
			i = j - 1
		case strings.HasPrefix(line, "~ "):
			body := strings.TrimSpace(line[2:])
			if m := noConsumers.FindStringSubmatch(body); m != nil {
				id, output, _ := strings.Cut(m[1], ".")
				message := "Nothing reads the output of " + id + "."
				if output != "" {
					message = "Nothing reads the " + output + " output of " + id + "."
				}
				set.add(r.finalize(Diagnostic{Severity: "warning", Code: "OUTPUT_UNUSED", ComponentID: id, RouteOutput: output, Message: message}))
			} else if !strings.HasPrefix(body, "Health checks are disabled") {
				set.add(r.finalize(Diagnostic{Severity: "warning", Code: "VALIDATION_WARNING", Message: body}))
			}
		}
	}
	return set.result()
}

// ---- `vector test` output ----

var (
	testFailedLine = regexp.MustCompile(`^test (.+) \.\.\. failed$`)
	testHeader     = regexp.MustCompile(`^test (.+):$`)
	testCheck      = regexp.MustCompile(`^check\[\d+\] for (?:transforms|outputs) \[(.*)\] failed`)
	testCondition  = regexp.MustCompile(`^condition\[\d+\]:\s*(.*)$`)
	quotedID       = regexp.MustCompile(`"([^"]+)"`)
)

// parseTestOutput reports each failing `vector test` case with its first
// failing condition. Output payloads are never included.
func (r *redactor) parseTestOutput(output []byte) []Diagnostic {
	lines := strings.Split(strings.ToValidUTF8(ansiEscape.ReplaceAllString(string(output), ""), ""), "\n")
	var set diagnosticSet
	failing := map[string]bool{}
	for _, line := range lines {
		if m := testFailedLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			failing[m[1]] = true
		}
	}
	current, component, reported := "", "", map[string]bool{}
	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, "output payloads from") {
			current = ""
			continue
		}
		if m := testHeader.FindStringSubmatch(line); m != nil && failing[m[1]] {
			current, component = m[1], ""
			continue
		}
		if current == "" || reported[current] {
			continue
		}
		if m := testCheck.FindStringSubmatch(line); m != nil {
			if ids := quotedID.FindStringSubmatch(m[1]); ids != nil {
				component = ids[1]
			}
			if strings.Contains(line, "no events") {
				reported[current] = true
				set.add(r.finalize(Diagnostic{Code: "TEST_FAILED", ComponentKind: "transform", ComponentID: component, Field: "tests", Message: "Test \"" + current + "\" failed: " + line}))
			}
			continue
		}
		if m := testCondition.FindStringSubmatch(line); m != nil {
			j := i + 1
			for j < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[j]), "output payloads from") && !testCondition.MatchString(strings.TrimSpace(lines[j])) && !testHeader.MatchString(strings.TrimSpace(lines[j])) {
				j++
			}
			message := strings.TrimSuffix(strings.TrimSpace(m[1]), ":")
			d := Diagnostic{Code: "TEST_FAILED", ComponentKind: "transform", ComponentID: component, Field: "tests"}
			if vrl, ok := parseVRLBlock(lines[i+1 : j]); ok {
				detail := vrl.title
				if k := strings.Index(detail, "assertion failed"); k >= 0 {
					detail = detail[k:]
				}
				d.Line, d.Column = vrl.line, vrl.column
				message = detail
			}
			d.Message = "Test \"" + current + "\" failed: " + message
			set.add(r.finalize(d))
			reported[current] = true
			i = j - 1
		}
	}
	for name := range failing {
		if !reported[name] {
			set.add(r.finalize(Diagnostic{Code: "TEST_FAILED", Field: "tests", Message: "Test \"" + name + "\" failed."}))
		}
	}
	return set.result()
}

// ---- Runtime JSON logs ----

// vectorRecord is one parsed line of Vector's JSON internal log.
type vectorRecord struct {
	Level, Message, Target, Error, ErrorType, Stage, Reason string
	ComponentID, ComponentKind, ComponentType               string
	Address, ChangedFields, Version                         string
	Timestamp                                               string
}

func jsonText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	}
	return ""
}

func parseVectorRecord(line []byte) (vectorRecord, bool) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' {
		return vectorRecord{}, false
	}
	var raw map[string]any
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	if decoder.Decode(&raw) != nil {
		return vectorRecord{}, false
	}
	rec := vectorRecord{
		Level: strings.ToUpper(jsonText(raw["level"])), Message: jsonText(raw["message"]), Target: jsonText(raw["target"]),
		Error: jsonText(raw["error"]), ErrorType: jsonText(raw["error_type"]), Stage: jsonText(raw["stage"]),
		Reason: jsonText(raw["reason"]), Address: jsonText(raw["address"]), ChangedFields: jsonText(raw["changed_fields"]),
		Version: jsonText(raw["version"]), Timestamp: jsonText(raw["timestamp"]),
		ComponentID: jsonText(raw["component_id"]), ComponentKind: jsonText(raw["component_kind"]), ComponentType: jsonText(raw["component_type"]),
	}
	if rec.Message == "" {
		rec.Message = jsonText(raw["msg"])
	}
	// Vector stores the component in the event (healthchecks), the span, or the span stack.
	if rec.ComponentID == "" {
		spans := []any{raw["span"]}
		if stack, ok := raw["spans"].([]any); ok {
			spans = append(spans, stack...)
		}
		for _, s := range spans {
			span, _ := s.(map[string]any)
			if id := jsonText(span["component_id"]); id != "" {
				rec.ComponentID, rec.ComponentKind, rec.ComponentType = id, jsonText(span["component_kind"]), jsonText(span["component_type"])
				break
			}
		}
	}
	return rec, rec.Level != "" && rec.Message != ""
}

// parseRuntimeRecords explains why Vector failed to start or reload, from
// the JSON log records written during that attempt.
func (r *redactor) parseRuntimeRecords(records []vectorRecord) []Diagnostic {
	var set diagnosticSet
	addresses := map[string]string{}
	for _, rec := range records {
		if rec.Address != "" && rec.ComponentID != "" {
			addresses[rec.ComponentID] = rec.Address
		}
	}
	failedComponents := map[string]bool{}
	for _, rec := range records {
		// A pipeline's VRL log() output is event data, not Vector's verdict.
		if strings.HasPrefix(rec.Target, "vrl::") {
			continue
		}
		switch {
		case rec.Message == "Configuration error." && rec.Error != "":
			lines := strings.Split(rec.Error, "\n")
			set.add(r.finalize(r.classifyValidationError(strings.TrimSpace(lines[0]), lines[1:])))
		case rec.Message == "Healthcheck failed.":
			set.add(r.finalize(healthDiagnostic(rec.ComponentKind, rec.ComponentID, rec.Error)))
		case rec.Message == "Sinks unhealthy.":
			set.add(r.finalize(Diagnostic{Code: "HEALTHCHECK_REQUIRED", Field: "healthchecks.require_healthy", Message: "Vector stopped because the pipeline requires healthy sinks at startup and a sink failed its health check."}))
		case rec.Message == "Config reload rejected due to non-reloadable global options.":
			set.add(r.finalize(Diagnostic{Severity: "warning", Code: "RELOAD_REJECTED", Field: rec.ChangedFields, Message: "Vector cannot reload a change to " + rec.ChangedFields + "; the agent restarted it instead."}))
		case rec.Level == "ERROR" && rec.ComponentID != "" && !strings.HasPrefix(rec.Message, "An error occurred that Vector couldn't handle"):
			failedComponents[rec.ComponentID] = true
			text := rec.Message
			if rec.Error != "" {
				text += " " + rec.Error
			}
			d := r.componentFailure(rec.ComponentKind, rec.ComponentID, text)
			d.Code = strings.Replace(d.Code, "COMPONENT_BUILD_FAILED", "COMPONENT_FAILED", 1)
			if d.Code == "ADDRESS_IN_USE" {
				d.Message = "Another process is already listening on this component's address."
				if address := addresses[rec.ComponentID]; address != "" {
					d.Message = "Another process is already listening on " + address + "."
				}
			}
			set.add(r.finalize(d))
		}
	}
	for _, rec := range records {
		if rec.Level == "ERROR" && !strings.HasPrefix(rec.Target, "vrl::") && strings.HasPrefix(rec.Message, "An error occurred that Vector couldn't handle") && rec.ComponentID != "" && !failedComponents[rec.ComponentID] {
			set.add(r.finalize(Diagnostic{Code: "COMPONENT_FAILED", ComponentKind: rec.ComponentKind, ComponentID: rec.ComponentID, Message: "The component stopped with an error Vector could not handle."}))
		}
	}
	return set.result()
}

// ---- Engine integration ----

// diagnoseFailure converts a native failure into redacted diagnostics. The
// effective configuration seeds the echo-safe vocabulary; its credential
// leaves and referenced environment values are scrubbed.
func (e *Engine) diagnoseFailure(err error, effective []byte) []Diagnostic {
	failure := asVectorFailure(err)
	if failure == nil {
		return nil
	}
	r := e.redactorFor(effective)
	var out []Diagnostic
	switch failure.Phase {
	case "validate":
		out = r.parseValidateOutput(failure.Output)
	case "test":
		out = r.parseTestOutput(failure.Output)
	case "start", "reload":
		out = r.parseRuntimeRecords(failure.Records)
	case "timeout":
		out = []Diagnostic{r.finalize(Diagnostic{Code: "VECTOR_TIMEOUT", Message: failure.Summary})}
	}
	for _, d := range failure.Diagnostics {
		out = append(out, r.finalize(d))
	}
	if len(out) == 0 && failure.Phase != "timeout" && failure.Phase != "prepare" {
		out = []Diagnostic{r.finalize(Diagnostic{Code: "VECTOR_" + strings.ToUpper(failure.Phase) + "_FAILED", Message: failure.Summary})}
	}
	return out
}

// secretDiagnostics explains a failed typed secret reference by name.
func (e *Engine) secretDiagnostics(err error, template []byte) []Diagnostic {
	var ref *secretReferenceError
	if !errors.As(err, &ref) {
		return nil
	}
	d := Diagnostic{Code: ref.code, ComponentKind: "sink", ComponentID: ref.sink, Field: "auth." + ref.field}
	switch ref.code {
	case "SECRET_BINDING_MISSING":
		d.Message = "This device has no file bound to secret \"" + ref.name + "\"."
		d.Hint = "Bind it on the host with configure-secrets while the agent is stopped."
	case "SECRET_FILE_UNREADABLE":
		d.Message = "The file bound to secret \"" + ref.name + "\" is missing, empty or not private to the agent account."
		d.Hint = "Run configure-secrets on the host; it prints the exact fix."
	default:
		d.Message = "Secret \"" + ref.name + "\" contains interpolation syntax that full mode would expand."
	}
	return []Diagnostic{e.redactorFor(template).finalize(d)}
}

func (e *Engine) redactorFor(effective []byte) *redactor {
	r := newRedactor()
	r.learnConfiguration(effective, e.Settings.CapabilityPolicy.FullVectorConfig)
	host := e.hostRuntime(effective)
	if host.DataDir != "" {
		r.safe[host.DataDir] = true
	}
	r.addLabel(e.Settings.ManagedConfig, "managed configuration")
	r.addLabel(hostRuntimePath(e.Dir), "host runtime settings")
	return r
}
