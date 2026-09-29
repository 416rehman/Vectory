package agent

import (
	"encoding/hex"
	"path/filepath"
)

// LocalDiagnostics is a read-only snapshot, not a new manifest authorization,
// native validation, connectivity test or proof that Vector is running.
type LocalDiagnostics struct {
	NextAction           string                  `json:"next_action"`
	RetryStatus          string                  `json:"retry_status"`
	DesiredConfiguration ConfigurationDiagnostic `json:"desired_configuration"`
}

type ConfigurationDiagnostic struct {
	Check      string `json:"check"`
	Reason     string `json:"reason,omitempty"`
	NextAction string `json:"next_action,omitempty"`
}

func localDiagnostics(dir string, settings Settings, state State) LocalDiagnostics {
	d := LocalDiagnostics{NextAction: applyNextAction(state), RetryStatus: "not_suppressed", DesiredConfiguration: ConfigurationDiagnostic{Check: "unmanaged"}}
	if LocalPaused(dir) {
		d.NextAction = "Local pause is active. Review any manual changes before running resume; remote pause still applies."
	} else if state.Policy.SyncPaused {
		d.NextAction = "Remote pause is active. An authorized operator must resume synchronization in the dashboard."
	}
	if state.Desired == nil {
		return d
	}
	if state.FailedGeneration != nil && *state.FailedGeneration == state.HighestGeneration {
		d.RetryStatus = "unknown"
	}
	// Never derive a path from unchecked metadata or inspect a corrupted cache.
	wanted := state.Desired
	hash, err := hex.DecodeString(wanted.SHA256)
	if err != nil || len(hash) != 32 || wanted.Size < 1 || wanted.Size > MaxArtifact {
		d.DesiredConfiguration = unavailableTemplate()
		return d
	}
	template, err := readArtifact(filepath.Join(dir, "template-"+wanted.SHA256+".json"))
	if err != nil || int64(len(template)) != wanted.Size || Digest(template) != wanted.SHA256 {
		d.DesiredConfiguration = unavailableTemplate()
		return d
	}
	// Only typed, locally approved Vectory references are materialized. Native
	// providers/environment are deliberately not executed by a diagnostic command.
	effective, usesSecrets, err := resolveLocalSecrets(template, settings.SecretFiles, settings.CapabilityPolicy.FullVectorConfig)
	if err != nil {
		d.DesiredConfiguration = ConfigurationDiagnostic{Check: "materialization_failed", Reason: "LOCAL_SECRET_REFERENCE_UNAVAILABLE", NextAction: "Check the approved secret-file bindings and private file permissions under the service account. Do not share secret files or rendered configuration."}
		return d
	}
	if state.FailedGeneration != nil && *state.FailedGeneration == state.HighestGeneration {
		if state.FailedEffectiveSHA256 == Digest(effective) || (state.FailedEffectiveSHA256 == "" && !usesSecrets) {
			d.RetryStatus = "suppressed"
		} else {
			d.RetryStatus = "not_suppressed"
		}
	}
	if err = settings.CapabilityPolicy.Check(effective); err != nil {
		d.DesiredConfiguration = capabilityDiagnostic(err.Error())
		return d
	}
	d.DesiredConfiguration = ConfigurationDiagnostic{Check: "capability_allowed", NextAction: "Current local capability checks pass. Native Vector validation, environment, tests and activation have not been rechecked by this command."}
	return d
}

func unavailableTemplate() ConfigurationDiagnostic {
	return ConfigurationDiagnostic{Check: "unavailable", Reason: "VERIFIED_TEMPLATE_UNAVAILABLE", NextAction: "The accepted desired template is not cached with its expected size and digest. Check the agent connection log and next authorized download; the managed file may still contain the last working configuration."}
}

// These messages are fixed local categories. Never return error text from a
// parser, subprocess, secret file or configuration value through diagnostics.
func capabilityDiagnostic(reason string) ConfigurationDiagnostic {
	d := ConfigurationDiagnostic{Check: "capability_denied", Reason: "CAPABILITY_DENIED", NextAction: "Correct the pipeline to meet the host's restricted policy, or have the host operator review local allowances. Do not clear state or change generation counters."}
	switch reason {
	case "capability denied: network destination is not locally allowed", "capability denied: invalid network destination":
		d.Reason = "NETWORK_DESTINATION_DENIED"
		d.NextAction = "Review explicit HTTP(S) destinations and the host-owned allowed_network_hosts list (exact hostname:port). Correct the pipeline or update approved allowances with install --capability-policy while the agent is stopped."
	case "capability denied: listener is not locally allowed", "capability denied: source needs an explicit authorized listener", "capability denied: OpenTelemetry requires explicit HTTP and gRPC listener configuration", "capability denied: OpenTelemetry listener address required":
		d.Reason = "LISTENER_DENIED"
		d.NextAction = "Set explicit listener addresses and review allowed_listen_addresses. Correct the pipeline or update approved allowances with install --capability-policy while the agent is stopped."
	case "capability denied: file root is not locally allowed", "capability denied: resource path must be absolute", "capability denied: resource has unsafe path", "capability denied: resource links are forbidden", "invalid resource glob":
		d.Reason = "FILE_ACCESS_DENIED"
		d.NextAction = "Check absolute data/resource paths, allowed_file_roots and links under the service account. Correct the pipeline or update approved allowances with install --capability-policy while the agent is stopped."
	case "capability denied: unsupported sources component", "capability denied: unsupported transforms component", "capability denied: unsupported sinks component", "capability denied: unsupported top-level setting", "capability denied: executable, provider, or external code setting":
		d.Reason = "UNSUPPORTED_LOCAL_CAPABILITY"
		d.NextAction = "This pipeline requires capabilities outside restricted mode. Use supported settings, or ask the host operator to review the explicit full-configuration trust grant; a deployment cannot enable it remotely."
	case "capability denied: substitution and dynamic resource templates are unsupported", "capability denied: external VRL capability":
		d.Reason = "DYNAMIC_CAPABILITY_DENIED"
		d.NextAction = "Restricted mode denies dynamic resource templates, environment substitutions and external VRL lookups. Use fixed approved settings or review the explicit local full-configuration trust grant."
	case "TLS verification cannot be disabled":
		d.Reason = "TLS_VERIFICATION_REQUIRED"
		d.NextAction = "Enable certificate and hostname verification and provision the correct trusted CA for the destination."
	case "capability denied: console requires explicit stderr target to isolate JSON startup logs":
		d.Reason = "CONSOLE_TARGET_DENIED"
		d.NextAction = "Set the restricted-mode console sink target to stderr so event output cannot impersonate Vector startup logs."
	}
	return d
}

func applyNextAction(state State) string {
	if state.Error == nil {
		return "Compare the cached apply state and last heartbeat with the dashboard. This local report does not prove current process liveness or server connectivity."
	}
	switch state.Error.Code {
	case "CAPABILITY_DENIED":
		return "Allow what the problem names on this host, or change the pipeline and deploy again. Vector keeps running the last working configuration."
	case "VALIDATION_FAILED":
		return "Fix what the problem names, then deploy again or choose Retry in the dashboard. `vectory logs` shows Vector's full output. Vector keeps running the last working configuration."
	case "SECRET_RESOLUTION_FAILED":
		return "Check the host's secret bindings and the files' permissions for the service account. Never share the rendered managed configuration."
	case "APPLY_ROLLED_BACK":
		return "The attempted version did not become the active version; the last verified configuration was restored. Check host resources and destination health before requesting Retry or deploying a corrected version."
	case "ROLLBACK_FAILED", "ROLLBACK_UNAVAILABLE", "RECOVERY_INVALID":
		return "Recovery needs host-operator intervention. Preserve the private state directory and journal; inspect the original failure and last-good availability before restarting. Do not delete identity or generation counters."
	case "WRITE_FAILED", "PATH_UNSAFE":
		return "Check managed/state directory ownership, free space, permissions and links under the service account. Keep the private recovery files intact."
	case "ACTIVATION_FAILED", "PROCESS_EXITED", "PROCESS_STOPPED":
		return "Check the agent service and host resources. A file digest alone does not prove activation; restart the agent service if stopped and wait for a newly verified apply."
	case "INCOMPATIBLE":
		return "Compare the desired Vector version with the explicitly adopted binary. This agent does not install or upgrade Vector."
	case "ADOPTION_REQUIRED":
		return "The host operator must inventory and stop the previous Vector instance, then explicitly adopt the fixed binary and sole managed configuration."
	default:
		return "Review the reported failure code and stage with the host operator. Keep private state and last-good files intact; do not share credentials or rendered configuration."
	}
}
