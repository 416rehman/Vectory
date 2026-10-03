package agent

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

const Version = "0.1.0"

// VectorVersion is the Vector release this agent is built and tested with.
// Any patch release of the same minor version is supported (VectorSeries).
const VectorVersion = "0.58.0"

// vectorSupportedSeries is the supported major.minor; VectorSeries names it
// for people: 0.58.x.
const (
	vectorSupportedSeries = "0.58"
	VectorSeries          = vectorSupportedSeries + ".x"
)

var vectorTriple = regexp.MustCompile(`^([0-9]+)\.([0-9]+)\.[0-9]{1,4}$`)

// vectorRelease normalizes a Vector version as a binary, a device or a
// manifest reports it to "major.minor.patch", and names its "major.minor"
// series. It accepts what the server's own compatibility check accepts: a
// leading "v" and build details after the first space, as in
// "0.58.1 (x86_64-unknown-linux-gnu 2bcad9b 2026-08-26)". Anything else, a
// pre-release for example, isn't a release the agent knows.
func vectorRelease(reported string) (release, series string, ok bool) {
	words := strings.Fields(reported)
	if len(words) == 0 {
		return "", "", false
	}
	match := vectorTriple.FindStringSubmatch(strings.TrimPrefix(words[0], "v"))
	if match == nil {
		return "", "", false
	}
	return match[0], match[1] + "." + match[2], true
}

// vectorPrerelease reports whether a Vector version names a pre-release, such
// as 0.58.1-rc.1: whatever its numbers, it isn't a release the agent knows.
func vectorPrerelease(reported string) bool {
	words := strings.Fields(reported)
	return len(words) > 0 && strings.Contains(strings.TrimPrefix(words[0], "v"), "-")
}

// SupportedVectorVersion reports whether a Vector version is a patch release
// of the supported minor version.
func SupportedVectorVersion(version string) bool {
	_, series, ok := vectorRelease(version)
	return ok && series == vectorSupportedSeries
}

// sameVectorSeries reports whether two Vector versions share major.minor.
// Patch releases fix bugs without changing configuration, so a patch
// difference between a manifest and the adopted binary is not a conflict.
func sameVectorSeries(a, b string) bool {
	_, first, ok := vectorRelease(a)
	if !ok {
		return false
	}
	_, second, ok := vectorRelease(b)
	return ok && first == second
}

const MaxArtifact = 1024 * 1024

// MaxAgentBuild bounds an agent build: the download of an update, and the
// privileged step's copy of it (128 MiB, the contract's bound on a release's
// artifact). MaxArtifact keeps bounding pipeline artifacts and the signed
// manifest that carries an offer.
const MaxAgentBuild = 128 * 1024 * 1024
const MaxJSONCounter uint64 = 9007199254740991

type Policy struct {
	HeartbeatSeconds int  `json:"heartbeat_seconds"`
	SyncPaused       bool `json:"sync_paused"`
	TelemetryEnabled bool `json:"telemetry_enabled"`
}
type Desired struct {
	VersionID     string `json:"version_id"`
	SHA256        string `json:"sha256"`
	Size          int64  `json:"size"`
	ArtifactPath  string `json:"artifact_path"`
	VectorVersion string `json:"vector_version"`
	// VersionNumber and ConfigurationName say which pipeline version this is, in
	// the server's words, for `vectory status`. They are display-only: Identity
	// leaves them out, so renaming a pipeline never invalidates a generation,
	// and a value that isn't well formed reads as absent instead of failing the
	// manifest. Older servers don't send them.
	VersionNumber     displayNumber `json:"version_number,omitempty"`
	ConfigurationName displayName   `json:"configuration_name,omitempty"`
}
type Manifest struct {
	ProtocolVersion  int       `json:"protocol_version"`
	DeviceID         string    `json:"device_id"`
	Nonce            string    `json:"nonce"`
	IssuedAt         time.Time `json:"issued_at"`
	ExpiresAt        time.Time `json:"expires_at"`
	Generation       uint64    `json:"generation"`
	PolicyGeneration uint64    `json:"policy_generation"`
	Policy           Policy    `json:"policy"`
	Desired          *Desired  `json:"desired,omitempty"`
	// Features lists additive heartbeat fields this server accepts. Older
	// servers omit it, and the agent then sends the original heartbeat shape.
	Features []string `json:"features,omitempty"`
	// Validation asks this device to check a candidate version without applying
	// it (validation.go). It stays raw so that a block this agent can't read
	// never keeps the manifest itself from being verified and applied.
	Validation json.RawMessage `json:"validation,omitempty"`
	// AgentUpdate offers this device a build of the agent (update_offer.go). It
	// stays raw for the same reason: nothing in it is acted on before the release
	// it carries is verified against the keys this host pins, and a member this
	// agent can't read never keeps the manifest itself from being verified.
	AgentUpdate json.RawMessage `json:"agent_update,omitempty"`
}
type Envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type Credentials struct {
	DeviceID             string    `json:"device_id"`
	CertificatePEM       string    `json:"certificate_pem"`
	CAPEM                string    `json:"ca_pem"`
	SigningPublicKey     string    `json:"signing_public_key"`
	CertificateExpiresAt time.Time `json:"certificate_expires_at"`
}
type Enrollment struct {
	ProtocolVersion   int    `json:"protocol_version"`
	RequestID         string `json:"request_id"`
	Token             string `json:"token"`
	Name              string `json:"name"`
	CSRPEM            string `json:"csr_pem"`
	OS                string `json:"os"`
	Arch              string `json:"arch"`
	AgentVersion      string `json:"agent_version"`
	VectorVersion     string `json:"vector_version"`
	ConfigurationMode string `json:"configuration_mode"`
	// ServiceManager is what keeps the agent running (systemd, launchd,
	// windows or none), sent by setup. Servers that predate it ignore it.
	ServiceManager string `json:"service_manager,omitempty"`
}
type Heartbeat struct {
	ProtocolVersion         int                   `json:"protocol_version"`
	RequestID               string                `json:"request_id"`
	Nonce                   string                `json:"nonce"`
	BootID                  string                `json:"boot_id"`
	AgentVersion            string                `json:"agent_version"`
	VectorVersion           string                `json:"vector_version"`
	ConfigurationMode       string                `json:"configuration_mode"`
	ReportedGeneration      uint64                `json:"reported_generation"`
	PolicyGeneration        uint64                `json:"policy_generation"`
	ActualSHA256            string                `json:"actual_sha256"`
	ApplyState              string                `json:"apply_state"`
	LocalPaused             bool                  `json:"local_paused"`
	RemotePauseAcknowledged bool                  `json:"remote_pause_acknowledged"`
	Error                   *Issue                `json:"error,omitempty"`
	Telemetry               *Telemetry            `json:"telemetry,omitempty"`
	AppliedTemplateSHA256   string                `json:"applied_template_sha256,omitempty"`
	SecretRevision          uint64                `json:"secret_revision,omitempty"`
	ConfigurationAttempt    *ConfigurationAttempt `json:"configuration_attempt,omitempty"`
	HostRuntime             *HostRuntime          `json:"host_runtime,omitempty"`
	// VectorLogSummary is nil for servers without the feature; an empty list
	// tells a supporting server there is nothing to report.
	VectorLogSummary *[]LogSummary `json:"vector_log_summary,omitempty"`
	// SecretNames are the names bound with configure-secrets (never files or
	// values), for servers with the secret_names feature.
	SecretNames *[]string `json:"secret_names,omitempty"`
	// ServiceManager says what keeps this agent process running: systemd,
	// launchd or windows when it runs as that service, none otherwise.
	// VectorRunning says whether the Vector process the agent supervises is
	// running. Both go only to servers that list them in features.
	ServiceManager string `json:"service_manager,omitempty"`
	VectorRunning  *bool  `json:"vector_running,omitempty"`
	// AgentSHA256 is the SHA-256 of the running agent executable and
	// StateDir the agent's state directory, a local path and not a secret.
	// Both go only to servers that list them in features.
	AgentSHA256 string `json:"agent_sha256,omitempty"`
	StateDir    string `json:"state_dir,omitempty"`
	// AgentFeatures announces what this agent can do, ValidationResult answers a
	// request to check a candidate and Readiness reports facts about this host
	// (validation.go). Each goes only to servers whose manifest lists
	// "validation", and AgentFeatures and Readiness in every such heartbeat:
	// the server reads a heartbeat without them as "not announced now".
	AgentFeatures    []string          `json:"agent_features,omitempty"`
	ValidationResult *ValidationResult `json:"validation_result,omitempty"`
	Readiness        *Readiness        `json:"readiness,omitempty"`
	// AgentUpdate says what this host consented to for agent updates, and where
	// an offer of one stands (update_report.go). It goes only to servers whose
	// manifest lists "agent_update", and is the first report left out when a
	// server refuses a heartbeat.
	AgentUpdate *AgentUpdateReport `json:"agent_update,omitempty"`
}

// ConfigurationAttempt identifies an observed result for an authenticated
// candidate. It never substitutes for ReportedGeneration or last-good evidence.
// SHA256 is the signed template digest, not materialized secret-bearing content.
type ConfigurationAttempt struct {
	Generation     uint64 `json:"generation"`
	VersionID      string `json:"version_id"`
	SHA256         string `json:"sha256"`
	State          string `json:"state"`
	SecretRevision uint64 `json:"secret_revision,omitempty"`
	Error          *Issue `json:"error,omitempty"`
}

// Telemetry is one bounded sample. Rates are averages over the interval since
// the previous sample; Errors and Discarded* are cumulative since Vector
// started. A nil value is unavailable, never zero.
type Telemetry struct {
	SampledAt            time.Time            `json:"sampled_at"`
	EventsPerSecond      *float64             `json:"events_per_second,omitempty"`
	EventsOutPerSecond   *float64             `json:"events_out_per_second,omitempty"`
	BytesInPerSecond     *float64             `json:"bytes_in_per_second,omitempty"`
	BytesOutPerSecond    *float64             `json:"bytes_out_per_second,omitempty"`
	Errors               *float64             `json:"errors,omitempty"`
	ErrorsPerMinute      *float64             `json:"errors_per_minute,omitempty"`
	UptimeSeconds        *float64             `json:"uptime_seconds,omitempty"`
	MemoryBytes          *float64             `json:"memory_bytes,omitempty"`
	CPUSeconds           *float64             `json:"cpu_seconds,omitempty"`
	DiscardedEvents      *float64             `json:"discarded_events,omitempty"`
	DiscardedIntentional *float64             `json:"discarded_intentional,omitempty"`
	DiscardedError       *float64             `json:"discarded_error,omitempty"`
	FilteredPerMinute    *float64             `json:"filtered_per_minute,omitempty"`
	DroppedPerMinute     *float64             `json:"dropped_per_minute,omitempty"`
	BufferBytes          *float64             `json:"buffer_bytes,omitempty"`
	BufferEvents         *float64             `json:"buffer_events,omitempty"`
	BufferUtilization    *float64             `json:"buffer_utilization,omitempty"`
	Components           []ComponentTelemetry `json:"components,omitempty"`
}
type ComponentTelemetry struct {
	ID                      string             `json:"id"`
	Type                    string             `json:"type,omitempty"`
	Kind                    string             `json:"kind,omitempty"`
	EventsPerSecond         *float64           `json:"events_per_second,omitempty"`
	ReceivedEventsPerSecond *float64           `json:"received_events_per_second,omitempty"`
	SentByOutput            map[string]float64 `json:"sent_by_output,omitempty"`
	ReceivedBytesPerSecond  *float64           `json:"received_bytes_per_second,omitempty"`
	SentBytesPerSecond      *float64           `json:"sent_bytes_per_second,omitempty"`
	Errors                  *float64           `json:"errors,omitempty"`
	ErrorsPerMinute         *float64           `json:"errors_per_minute,omitempty"`
	DiscardedEvents         *float64           `json:"discarded_events,omitempty"`
	DiscardedIntentional    *float64           `json:"discarded_intentional,omitempty"`
	DiscardedError          *float64           `json:"discarded_error,omitempty"`
	FilteredPerMinute       *float64           `json:"filtered_per_minute,omitempty"`
	DroppedPerMinute        *float64           `json:"dropped_per_minute,omitempty"`
	BufferBytes             *float64           `json:"buffer_bytes,omitempty"`
	BufferEvents            *float64           `json:"buffer_events,omitempty"`
	BufferMaxEvents         *float64           `json:"buffer_max_events,omitempty"`
	BufferMaxBytes          *float64           `json:"buffer_max_bytes,omitempty"`
	BufferUtilization       *float64           `json:"buffer_utilization,omitempty"`
	Utilization             *float64           `json:"utilization,omitempty"`
	LatencyMeanSeconds      *float64           `json:"latency_mean_seconds,omitempty"`
}
type Issue struct {
	Code    string `json:"code"`
	Stage   string `json:"stage"`
	Message string `json:"message"`
	// Diagnostics are redacted, structured findings from Vector's own output.
	Diagnostics []Diagnostic `json:"diagnostics,omitempty"`
}
type Settings struct {
	Server             string            `json:"server"`
	CAFile             string            `json:"ca_file,omitempty"`
	Name               string            `json:"name"`
	VectorBinary       string            `json:"vector_binary"`
	VectorBinarySHA256 string            `json:"vector_binary_sha256"`
	ManagedConfig      string            `json:"managed_config"`
	Adopted            bool              `json:"adopted"`
	CapabilityPolicy   CapabilityPolicy  `json:"capability_policy"`
	ValidationSeconds  int               `json:"validation_seconds"`
	StartupSeconds     int               `json:"startup_seconds"`
	MetricsURL         string            `json:"metrics_url,omitempty"`
	SecretFiles        map[string]string `json:"secret_files,omitempty"`
	// VectorDataDir is the host-owned data directory offered to pipelines
	// that do not set data_dir (install --vector-data-dir). Empty: resolved.
	VectorDataDir string `json:"vector_data_dir,omitempty"`
	// GracefulShutdownSeconds bounds Vector's drain on stop (default 60).
	GracefulShutdownSeconds int `json:"graceful_shutdown_seconds,omitempty"`
	// VectorVersion is what the adopted binary reported at adoption. The
	// binary's SHA-256 is pinned, so it can't change without re-adoption.
	VectorVersion string `json:"vector_version,omitempty"`
	// NoWake: never hold a wait open between check-ins, for networks that cut
	// idle connections (setup or install --no-wake). The agent then learns of
	// changes at its next check-in, as older agents do.
	NoWake bool `json:"no_wake,omitempty"`
}

// adoptedVectorVersion is the adopted binary's version, or the release this
// agent is built with for installations adopted before it was recorded.
func (s Settings) adoptedVectorVersion() string {
	if release, series, ok := vectorRelease(s.VectorVersion); ok && series == vectorSupportedSeries {
		return release
	}
	return VectorVersion
}

type State struct {
	DeviceID                string                `json:"device_id"`
	HighestGeneration       uint64                `json:"highest_generation"`
	HighestPolicyGeneration uint64                `json:"highest_policy_generation"`
	DesiredIdentity         string                `json:"desired_identity"`
	PolicyIdentity          string                `json:"policy_identity"`
	Accepted                bool                  `json:"accepted"`
	Desired                 *Desired              `json:"desired,omitempty"`
	Policy                  Policy                `json:"policy"`
	ReportedGeneration      uint64                `json:"reported_generation"`
	ApplyState              string                `json:"apply_state"`
	ActualSHA256            string                `json:"actual_sha256"`
	LastGoodSHA256          string                `json:"last_good_sha256"`
	FailedGeneration        *uint64               `json:"failed_generation,omitempty"`
	Error                   *Issue                `json:"error,omitempty"`
	LastHeartbeat           *time.Time            `json:"last_heartbeat,omitempty"`
	LastSigningRefresh      *time.Time            `json:"last_signing_refresh,omitempty"`
	RemotePauseAcknowledged bool                  `json:"remote_pause_acknowledged"`
	Telemetry               *Telemetry            `json:"telemetry,omitempty"`
	AppliedTemplateSHA256   string                `json:"applied_template_sha256,omitempty"`
	SecretRevision          uint64                `json:"secret_revision"`
	AppliedSecretRevision   uint64                `json:"applied_secret_revision"`
	MaterializationSHA256   string                `json:"materialization_sha256,omitempty"`
	FailedEffectiveSHA256   string                `json:"failed_effective_sha256,omitempty"`
	ConfigurationAttempt    *ConfigurationAttempt `json:"configuration_attempt,omitempty"`
	ServerFeatures          []string              `json:"server_features,omitempty"`
	// Agent is the build of the agent process that last saved this state.
	// Setup compares it with the installed file to restart an outdated service.
	Agent *AgentBuild `json:"agent,omitempty"`
	// CheckInFailure is the latest failed check-in since the last success.
	CheckInFailure *CheckInFailure `json:"check_in_failure,omitempty"`
	// Applied is the pipeline version this device last verified as running, as
	// the signed manifest that delivered it named it. Only `vectory status`
	// reads it.
	Applied *AppliedVersion `json:"applied,omitempty"`
	// Wake is what the run loop last saw of wake-ups when it differs from the
	// ordinary: wakeOffRun or wakeFailed (wake.go). Only `vectory status` reads
	// it.
	Wake string `json:"wake,omitempty"`
}

// CheckInFailure records why the agent couldn't check in. The message is a
// classified, secret-free explanation.
type CheckInFailure struct {
	Since   time.Time `json:"since"`
	Message string    `json:"message"`
	// Code is the failure's classification, such as CONNECTION_REFUSED or
	// CREDENTIAL_REJECTED (the server answers but refuses this agent).
	Code string `json:"code,omitempty"`
}

// AgentBuild identifies an agent executable.
type AgentBuild struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

type Journal struct {
	Stage          string `json:"stage"`
	Generation     uint64 `json:"generation"`
	DesiredSHA256  string `json:"desired_sha256"`
	PreviousSHA256 string `json:"previous_sha256"`
	// PreviousAbsent: the managed file didn't exist before this attempt, so
	// withdrawing a failed first version removes it again.
	PreviousAbsent       bool                  `json:"previous_absent,omitempty"`
	SecretRevision       uint64                `json:"secret_revision,omitempty"`
	ConfigurationAttempt *ConfigurationAttempt `json:"configuration_attempt,omitempty"`
}
