package agent

import "time"

const Version = "0.1.0-dev"
const VectorVersion = "0.58.0"
const MaxArtifact = 1024 * 1024

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
	ProtocolVersion int    `json:"protocol_version"`
	RequestID       string `json:"request_id"`
	Token           string `json:"token"`
	Name            string `json:"name"`
	CSRPEM          string `json:"csr_pem"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	AgentVersion    string `json:"agent_version"`
	VectorVersion   string `json:"vector_version"`
}
type Heartbeat struct {
	ProtocolVersion         int        `json:"protocol_version"`
	RequestID               string     `json:"request_id"`
	Nonce                   string     `json:"nonce"`
	BootID                  string     `json:"boot_id"`
	AgentVersion            string     `json:"agent_version"`
	VectorVersion           string     `json:"vector_version"`
	ReportedGeneration      uint64     `json:"reported_generation"`
	PolicyGeneration        uint64     `json:"policy_generation"`
	ActualSHA256            string     `json:"actual_sha256"`
	ApplyState              string     `json:"apply_state"`
	LocalPaused             bool       `json:"local_paused"`
	RemotePauseAcknowledged bool       `json:"remote_pause_acknowledged"`
	Error                   *Issue     `json:"error,omitempty"`
	Telemetry               *Telemetry `json:"telemetry,omitempty"`
	AppliedTemplateSHA256   string     `json:"applied_template_sha256,omitempty"`
	SecretRevision          uint64     `json:"secret_revision,omitempty"`
}
type Telemetry struct {
	SampledAt       time.Time            `json:"sampled_at"`
	EventsPerSecond *float64             `json:"events_per_second,omitempty"`
	Errors          *float64             `json:"errors,omitempty"`
	UptimeSeconds   *float64             `json:"uptime_seconds,omitempty"`
	MemoryBytes     *float64             `json:"memory_bytes,omitempty"`
	CPUSeconds      *float64             `json:"cpu_seconds,omitempty"`
	DiscardedEvents *float64             `json:"discarded_events,omitempty"`
	BufferBytes     *float64             `json:"buffer_bytes,omitempty"`
	Components      []ComponentTelemetry `json:"components,omitempty"`
}
type ComponentTelemetry struct {
	ID              string   `json:"id"`
	Type            string   `json:"type,omitempty"`
	EventsPerSecond *float64 `json:"events_per_second,omitempty"`
	Errors          *float64 `json:"errors,omitempty"`
	DiscardedEvents *float64 `json:"discarded_events,omitempty"`
	BufferBytes     *float64 `json:"buffer_bytes,omitempty"`
}
type Issue struct {
	Code    string `json:"code"`
	Stage   string `json:"stage"`
	Message string `json:"message"`
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
}
type State struct {
	DeviceID                string     `json:"device_id"`
	HighestGeneration       uint64     `json:"highest_generation"`
	HighestPolicyGeneration uint64     `json:"highest_policy_generation"`
	DesiredIdentity         string     `json:"desired_identity"`
	PolicyIdentity          string     `json:"policy_identity"`
	Accepted                bool       `json:"accepted"`
	Desired                 *Desired   `json:"desired,omitempty"`
	Policy                  Policy     `json:"policy"`
	ReportedGeneration      uint64     `json:"reported_generation"`
	ApplyState              string     `json:"apply_state"`
	ActualSHA256            string     `json:"actual_sha256"`
	LastGoodSHA256          string     `json:"last_good_sha256"`
	FailedGeneration        *uint64    `json:"failed_generation,omitempty"`
	Error                   *Issue     `json:"error,omitempty"`
	LastHeartbeat           *time.Time `json:"last_heartbeat,omitempty"`
	LastSigningRefresh      *time.Time `json:"last_signing_refresh,omitempty"`
	RemotePauseAcknowledged bool       `json:"remote_pause_acknowledged"`
	Telemetry               *Telemetry `json:"telemetry,omitempty"`
	AppliedTemplateSHA256   string     `json:"applied_template_sha256,omitempty"`
	SecretRevision          uint64     `json:"secret_revision"`
	AppliedSecretRevision   uint64     `json:"applied_secret_revision"`
	MaterializationSHA256   string     `json:"materialization_sha256,omitempty"`
	FailedEffectiveSHA256   string     `json:"failed_effective_sha256,omitempty"`
}
type Journal struct {
	Stage          string `json:"stage"`
	Generation     uint64 `json:"generation"`
	DesiredSHA256  string `json:"desired_sha256"`
	PreviousSHA256 string `json:"previous_sha256"`
	SecretRevision uint64 `json:"secret_revision,omitempty"`
}
