package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// A nil option is omitted. Explicit false and an empty binding map are changes.
// A supplied policy changes allowances only; it never grants full mode.
type InstallOptions struct {
	VectorBinary, ManagedConfig *string
	Adopt                       bool
	CapabilityPolicy            *CapabilityPolicy
	FullVectorConfig            *bool
	MetricsURL                  *string
	ClearMetricsURL             bool
	SecretFiles                 *map[string]string
	// Host runtime settings; an empty data directory restores the automatic choice.
	VectorDataDir           *string
	GracefulShutdownSeconds *int
}

func ReadInstallPolicy(path string) (*CapabilityPolicy, error) {
	raw, err := readOperatorJSON(path)
	invalid := errors.New("capability policy must be a bounded regular local UTF-8 JSON object with valid Unicode, no duplicate keys and no trailing data")
	if err != nil || !pairedJSONSurrogates(raw) {
		return nil, invalid
	}
	fields, err := adoptionObject(raw)
	if err != nil {
		return nil, invalid
	}
	for key := range fields {
		if key != "full_vector_config" && key != "allowed_file_roots" && key != "allowed_network_hosts" && key != "allowed_listen_addresses" {
			return nil, errors.New("capability policy contains an unsupported field")
		}
	}
	if value, exists := fields["full_vector_config"]; exists && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return nil, errors.New("capability policy full_vector_config must be a boolean")
	}
	var policy CapabilityPolicy
	if err = json.Unmarshal(raw, &policy); err != nil {
		return nil, errors.New("capability policy has invalid field types")
	}
	if err = validateInstallPolicy(policy); err != nil {
		return nil, err
	}
	return &policy, nil
}

func validInstallAddress(value string) bool {
	host, port, err := net.SplitHostPort(value)
	if err != nil || host == "" || strings.TrimSpace(host) != host || strings.ContainsAny(host, "/\\@#?*%\x00\r\n\t ") {
		return false
	}
	number, err := strconv.Atoi(port)
	return err == nil && number >= 1 && number <= 65535 && strings.Trim(port, "0123456789") == ""
}

func validateInstallPolicy(policy CapabilityPolicy) error {
	for _, values := range [][]string{policy.AllowedFileRoots, policy.AllowedNetworkHosts, policy.AllowedListenAddresses} {
		if len(values) > 1024 {
			return errors.New("capability allowance list exceeds 1024 entries")
		}
		for _, value := range values {
			if value == "" || len(value) > 32768 || !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
				return errors.New("capability allowance must be a nonempty bounded UTF-8 string without NUL")
			}
		}
	}
	for _, root := range policy.AllowedFileRoots {
		if !filepath.IsAbs(root) || strings.ContainsAny(root, "*?[") {
			return errors.New("capability file roots must be absolute paths without wildcard patterns")
		}
	}
	for _, value := range append(slices.Clone(policy.AllowedNetworkHosts), policy.AllowedListenAddresses...) {
		if !validInstallAddress(value) {
			return errors.New("capability destinations and listeners require an exact host:port with port 1..65535")
		}
	}
	return nil
}

func (options InstallOptions) validate() error {
	for _, path := range []*string{options.VectorBinary, options.ManagedConfig} {
		if path != nil && (adoptionLocalPath(*path) != nil || strings.ContainsRune(*path, 0)) {
			return errors.New("explicit binary and managed-config options require absolute local paths")
		}
	}
	if options.ManagedConfig != nil && filepath.Ext(*options.ManagedConfig) != ".json" {
		return errors.New("managed configuration must use a .json path")
	}
	if options.CapabilityPolicy != nil {
		if err := validateInstallPolicy(*options.CapabilityPolicy); err != nil {
			return err
		}
	}
	if err := validateMetricsChange(options.MetricsURL, options.ClearMetricsURL); err != nil {
		return err
	}
	if options.SecretFiles != nil {
		if err := validateSecretFiles(*options.SecretFiles); err != nil {
			return err
		}
	}
	if options.VectorDataDir != nil && *options.VectorDataDir != "" {
		if err := validateVectorDataDir(*options.VectorDataDir); err != nil {
			return err
		}
	}
	if n := options.GracefulShutdownSeconds; n != nil && (*n < minGracefulShutdownSeconds || *n > maxGracefulShutdownSeconds) {
		return errors.New("--graceful-shutdown-seconds must be between 5 and 300")
	}
	return nil
}

func (options InstallOptions) compose(current Settings) Settings {
	if options.CapabilityPolicy != nil {
		current.CapabilityPolicy.AllowedFileRoots = slices.Clone(options.CapabilityPolicy.AllowedFileRoots)
		current.CapabilityPolicy.AllowedNetworkHosts = slices.Clone(options.CapabilityPolicy.AllowedNetworkHosts)
		current.CapabilityPolicy.AllowedListenAddresses = slices.Clone(options.CapabilityPolicy.AllowedListenAddresses)
	}
	if options.FullVectorConfig != nil {
		current.CapabilityPolicy.FullVectorConfig = *options.FullVectorConfig
	}
	if options.MetricsURL != nil {
		current.MetricsURL = *options.MetricsURL
	} else if options.ClearMetricsURL {
		current.MetricsURL = ""
	}
	if options.SecretFiles != nil {
		current.SecretFiles = make(map[string]string, len(*options.SecretFiles))
		for name, path := range *options.SecretFiles {
			current.SecretFiles[name] = path
		}
	}
	if options.VectorDataDir != nil {
		current.VectorDataDir = filepath.Clean(*options.VectorDataDir)
		if *options.VectorDataDir == "" {
			current.VectorDataDir = ""
		}
	}
	if options.GracefulShutdownSeconds != nil {
		current.GracefulShutdownSeconds = *options.GracefulShutdownSeconds
	}
	return current
}

func capabilityChanged(before, after CapabilityPolicy) bool {
	return before.FullVectorConfig != after.FullVectorConfig ||
		!slices.Equal(before.AllowedFileRoots, after.AllowedFileRoots) ||
		!slices.Equal(before.AllowedNetworkHosts, after.AllowedNetworkHosts) ||
		!slices.Equal(before.AllowedListenAddresses, after.AllowedListenAddresses)
}

func InstallWithOptions(ctx context.Context, dir string, options InstallOptions) error {
	return installWithOptions(ctx, dir, options, ProbeVector)
}

func installWithOptions(ctx context.Context, dir string, options InstallOptions, probe func(context.Context, Settings) (string, error)) error {
	return installWithOptionsAndState(ctx, dir, options, probe, SaveState)
}

func installWithOptionsAndState(ctx context.Context, dir string, options InstallOptions, probe func(context.Context, Settings) (string, error), initialize func(string, State) error) error {
	if err := options.validate(); err != nil {
		return err
	}
	if err := adoptionLocalPath(dir); err != nil {
		return err
	}
	if err := CheckFreshStateDirectory(dir); err != nil {
		return err
	}
	var fresh *Settings
	if _, err := os.Lstat(filepath.Join(dir, "settings.json")); os.IsNotExist(err) {
		if !options.Adopt {
			return errors.New("explicit --adopt is required; stop the previous Vector service and inventory all existing config/include paths first")
		}
		if options.VectorBinary == nil || options.ManagedConfig == nil {
			return errors.New("provide absolute Vector binary and sole managed .json configuration paths")
		}
		binary, config := *options.VectorBinary, *options.ManagedConfig
		if err = regularPath(binary); err != nil {
			return err
		}
		if err = SafePath(config); err != nil {
			return err
		}
		if err = CheckManagedDirectory(config, dir); err != nil {
			return err
		}
		if _, err = os.Lstat(config); err == nil {
			if err = regularPath(config); err != nil {
				return err
			}
			if _, err = readArtifact(config); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		s := options.compose(Settings{VectorBinary: binary, ManagedConfig: config, Adopted: true, ValidationSeconds: 30, StartupSeconds: 20})
		if _, err = probe(ctx, s); err != nil {
			return err
		}
		if s.VectorBinarySHA256, err = FileDigest(binary); err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		fresh = &s
		// Bootstrap only after all input/native preflight succeeds. A purge
		// keeps the lifecycle guard through rmdir, so creation must pass it too.
		if err = createFreshStateDirectory(dir); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	unlock, err := lockSettingsMaintenance(dir)
	if err != nil {
		return err
	}
	defer unlock()
	doc, err := loadSettingsDocument(dir)
	if err == nil {
		state, stateErr := loadMaintenanceDocument(filepath.Join(dir, "state.json"))
		var existingState State
		if stateErr != nil || json.Unmarshal(state.raw, &existingState) != nil {
			return errors.New("existing installation state is missing or unreadable; preserve local files and inspect the incomplete installation before continuing")
		}
		if options.VectorBinary != nil && *options.VectorBinary != doc.value.VectorBinary || options.ManagedConfig != nil && *options.ManagedConfig != doc.value.ManagedConfig {
			return errors.New("installation already exists; stop the agent and use re-adopt with a trusted expected SHA256 to approve a replacement Vector binary")
		}
		next := options.compose(doc.value)
		if err = ctx.Err(); err != nil {
			return err
		}
		if capabilityChanged(doc.value.CapabilityPolicy, next.CapabilityPolicy) {
			return commitSettingsWithRetryReset(dir, doc, next)
		}
		return doc.save(next)
	}
	if !os.IsNotExist(err) || fresh == nil {
		return err
	}
	if err = CheckFreshStateDirectory(dir); err != nil {
		return err
	}
	if err = CheckManagedDirectory(fresh.ManagedConfig, dir); err != nil {
		return err
	}
	if digest, err := FileDigest(fresh.VectorBinary); err != nil || digest != fresh.VectorBinarySHA256 {
		return errors.New("Vector binary changed during installation preflight")
	}
	var backup []byte
	if _, err = os.Lstat(fresh.ManagedConfig); err == nil {
		if err = regularPath(fresh.ManagedConfig); err != nil {
			return err
		}
		backup, err = readArtifact(fresh.ManagedConfig)
		if err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = PrivateDir(dir); err != nil {
		return err
	}
	if err = PrivateDir(filepath.Dir(fresh.ManagedConfig)); err != nil {
		return err
	}
	if backup != nil {
		if err = AtomicWrite(filepath.Join(dir, "adoption-backup.json"), backup); err != nil {
			return err
		}
	}
	if err = WriteJSON(filepath.Join(dir, "settings.json"), *fresh); err != nil {
		return err
	}
	if err = initialize(dir, State{ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
		return fmt.Errorf("installation settings were saved, but state initialization is incomplete; keep the agent stopped and preserve local files for inspection: %w", err)
	}
	return nil
}
