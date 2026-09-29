package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
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

func (p CapabilityPolicy) Check(data []byte) error {
	var root map[string]any
	if e := json.Unmarshal(data, &root); e != nil {
		return errors.New("configuration must be a JSON object")
	}
	if root == nil {
		return errors.New("configuration must be an object")
	}
	// This explicit local grant trusts publishers with all capabilities of the
	// adopted Vector process. Vector itself still validates the complete bundle.
	if p.FullVectorConfig {
		return nil
	}
	for k, v := range root {
		switch k {
		case "sources", "transforms", "sinks":
			components, ok := v.(map[string]any)
			if !ok {
				return errors.New("component section must be an object")
			}
			for _, raw := range components {
				c, ok := raw.(map[string]any)
				if !ok {
					return errors.New("component must be an object")
				}
				typ, _ := c["type"].(string)
				// Resource-bearing components cannot rely on implicit defaults, which
				// would bypass explicit local path/destination/listener authorization.
				switch typ {
				case "http":
					if uri, ok := c["uri"].(string); !ok || uri == "" {
						return errors.New("capability denied: HTTP sink needs an explicit authorized uri")
					}
				case "loki":
					if uri, ok := c["endpoint"].(string); !ok || uri == "" {
						return errors.New("capability denied: Loki sink needs an explicit authorized endpoint")
					}
				case "elasticsearch":
					if endpoints, ok := c["endpoints"].([]any); !ok || len(endpoints) == 0 {
						return errors.New("capability denied: Elasticsearch needs explicit authorized endpoints")
					}
				case "http_server", "syslog", "prometheus_exporter":
					if address, ok := c["address"].(string); !ok || address == "" {
						return errors.New("capability denied: source needs an explicit authorized listener")
					}
				case "opentelemetry":
					for _, protocol := range []string{"http", "grpc"} {
						block, ok := c[protocol].(map[string]any)
						if !ok {
							return errors.New("capability denied: OpenTelemetry requires explicit HTTP and gRPC listener configuration")
						}
						if address, ok := block["address"].(string); !ok || address == "" {
							return errors.New("capability denied: OpenTelemetry listener address required")
						}
					}
				}
				if typ == "console" {
					if target := c["target"]; target != "stderr" {
						return errors.New("capability denied: console requires explicit stderr target to isolate JSON startup logs")
					}
				}
				if !supported[k][typ] {
					return fmt.Errorf("capability denied: unsupported %s component", k)
				}
				if e := p.walk(c, ""); e != nil {
					return e
				}
			}
		case "data_dir":
			s, ok := v.(string)
			if !ok {
				return errors.New("data_dir must be a path")
			}
			if e := p.file(s); e != nil {
				return e
			}
		case "api":
			a, ok := v.(map[string]any)
			if !ok {
				return errors.New("api must be an object")
			}
			if enabled, _ := a["enabled"].(bool); enabled {
				addr, _ := a["address"].(string)
				host, _, e := net.SplitHostPort(addr)
				if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
					return errors.New("Vector API must use an explicit loopback address")
				}
			}
		case "acknowledgements", "healthchecks", "timezone":
			if e := p.walk(v, k); e != nil {
				return e
			}
		default:
			return errors.New("capability denied: unsupported top-level setting")
		}
	}
	return nil
}
func (p CapabilityPolicy) walk(v any, key string) error {
	switch x := v.(type) {
	case map[string]any:
		for k, value := range x {
			lower := strings.ToLower(k)
			if lower == "command" || lower == "exec" || lower == "provider" || lower == "secret" || lower == "secrets" || lower == "source_files" || lower == "files" || lower == "enrichment_tables" {
				return errors.New("capability denied: executable, provider, or external code setting")
			}
			if lower == "verify_certificate" || lower == "verify_hostname" {
				if b, ok := value.(bool); ok && !b {
					return errors.New("TLS verification cannot be disabled")
				}
			}
			if e := p.walk(value, lower); e != nil {
				return e
			}
		}
	case []any:
		for _, value := range x {
			if e := p.walk(value, key); e != nil {
				return e
			}
		}
	case string:
		if environmentVariable.MatchString(x) || strings.Contains(x, "${") || strings.Contains(x, "{{") || strings.Contains(x, "%{") {
			return errors.New("capability denied: substitution and dynamic resource templates are unsupported")
		}
		lower := strings.ToLower(x)
		for _, f := range []string{"get_env_var", "get_secret", "set_secret", "remove_secret", "dns_lookup", "get_enrichment_table", "find_enrichment_table"} {
			if strings.Contains(lower, f) {
				return errors.New("capability denied: external VRL capability")
			}
		}
		if key == "endpoint" || key == "endpoints" || key == "uri" || key == "url" || strings.Contains(x, "://") {
			if e := p.network(x); e != nil {
				return e
			}
		}
		if key == "address" {
			allowed := false
			for _, a := range p.AllowedListenAddresses {
				if x == a {
					allowed = true
				}
			}
			if !allowed {
				return errors.New("capability denied: listener is not locally allowed")
			}
		}
		if key == "include" || key == "exclude" || key == "path" || strings.HasSuffix(key, "_file") || strings.HasSuffix(key, "_path") || strings.HasSuffix(key, "_dir") {
			if e := p.file(x); e != nil {
				return e
			}
		}
	}
	return nil
}
func (p CapabilityPolicy) network(s string) error {
	u, e := url.Parse(s)
	if e != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return errors.New("capability denied: invalid network destination")
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
	return errors.New("capability denied: network destination is not locally allowed")
}
func (p CapabilityPolicy) file(s string) error {
	if !filepath.IsAbs(s) {
		return errors.New("capability denied: resource path must be absolute")
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
			return errors.New("capability denied: resource has unsafe path")
		}
		matches, e := filepath.Glob(clean)
		if e != nil {
			return errors.New("invalid resource glob")
		}
		for _, m := range matches {
			if e = SafePath(m); e != nil {
				return errors.New("capability denied: resource links are forbidden")
			}
		}
		return nil
	}
	return errors.New("capability denied: file root is not locally allowed")
}
