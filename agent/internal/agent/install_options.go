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
	// NoWake turns wake-ups off (true) or back on (false); nil keeps them.
	NoWake *bool
	// AddAllowances adds entries to the current allowance lists and never
	// removes one (vectory allow); CapabilityPolicy replaces them instead.
	AddAllowances *CapabilityPolicy
}

// fileRoots lists the file roots this call adds or replaces: roots it leaves
// alone are not judged again, so an installation that allowed one earlier can
// still change anything else.
func (options InstallOptions) fileRoots() []string {
	switch {
	case options.CapabilityPolicy != nil:
		return options.CapabilityPolicy.AllowedFileRoots
	case options.AddAllowances != nil:
		return options.AddAllowances.AllowedFileRoots
	}
	return nil
}

// mergeAllowances adds each entry that isn't there yet, in order.
func mergeAllowances(current, add []string) []string {
	out := slices.Clone(current)
	for _, value := range add {
		if !slices.Contains(out, value) {
			out = append(out, value)
		}
	}
	return out
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
		if !filepath.IsAbs(root) {
			return inputError(fmt.Sprintf("file root %s isn't an absolute path: name the whole directory, such as %s", safeText(root, 120), exampleFileRoot()))
		}
		if strings.ContainsAny(root, "*?[") {
			return inputError(fmt.Sprintf("file root %s has a wildcard: name the directory itself, such as %s, which covers everything under it", safeText(root, 120), exampleFileRoot()))
		}
		// A filesystem or volume root covers every file. What a root may not
		// overlap (the agent's own directories, a bound secret file) needs the
		// installation: checkFileRoots judges that where it is known.
		if problem := fileRootProblem(hostPathStyle(), root, nil); problem != "" {
			return errors.New(problem)
		}
	}
	for _, value := range append(slices.Clone(policy.AllowedNetworkHosts), policy.AllowedListenAddresses...) {
		if !validInstallAddress(value) {
			return inputError(fmt.Sprintf("%s isn't an exact host:port: a destination or listener names a host and a port from 1 to 65535, such as logs.example.net:443", safeText(value, 120)))
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
	if options.AddAllowances != nil {
		if options.CapabilityPolicy != nil {
			return errors.New("choose either a complete capability policy or allowances to add, not both")
		}
		if options.AddAllowances.FullVectorConfig {
			return errors.New("allowances never grant full mode")
		}
		if err := validateInstallPolicy(*options.AddAllowances); err != nil {
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
		return inputError(fmt.Sprintf("--graceful-shutdown-seconds %d is out of range: Vector may drain for a whole number of seconds from %d to %d", *n, minGracefulShutdownSeconds, maxGracefulShutdownSeconds))
	}
	return nil
}

func (options InstallOptions) compose(current Settings) Settings {
	if options.CapabilityPolicy != nil {
		current.CapabilityPolicy.AllowedFileRoots = slices.Clone(options.CapabilityPolicy.AllowedFileRoots)
		current.CapabilityPolicy.AllowedNetworkHosts = slices.Clone(options.CapabilityPolicy.AllowedNetworkHosts)
		current.CapabilityPolicy.AllowedListenAddresses = slices.Clone(options.CapabilityPolicy.AllowedListenAddresses)
	}
	if add := options.AddAllowances; add != nil {
		current.CapabilityPolicy.AllowedFileRoots = mergeAllowances(current.CapabilityPolicy.AllowedFileRoots, add.AllowedFileRoots)
		current.CapabilityPolicy.AllowedNetworkHosts = mergeAllowances(current.CapabilityPolicy.AllowedNetworkHosts, add.AllowedNetworkHosts)
		current.CapabilityPolicy.AllowedListenAddresses = mergeAllowances(current.CapabilityPolicy.AllowedListenAddresses, add.AllowedListenAddresses)
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
	if options.NoWake != nil {
		current.NoWake = *options.NoWake
	}
	return current
}

func capabilityChanged(before, after CapabilityPolicy) bool {
	return before.FullVectorConfig != after.FullVectorConfig ||
		!slices.Equal(before.AllowedFileRoots, after.AllowedFileRoots) ||
		!slices.Equal(before.AllowedNetworkHosts, after.AllowedNetworkHosts) ||
		!slices.Equal(before.AllowedListenAddresses, after.AllowedListenAddresses)
}

// vectorMissing explains a missing Vector binary and points at one it found.
func vectorMissing(ctx context.Context, binary string) error {
	message := "Vector isn't at " + binary + "."
	if found, _ := FindVector(ctx); found != nil {
		return fmt.Errorf("%s Found Vector %s at %s: use --vector-binary %s", message, found.Version, found.Path, quoteArg(found.Path))
	}
	return errors.New(message + " Install Vector " + VectorSeries + " (https://vector.dev/download/) or pass the right --vector-binary")
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
		if options.VectorBinary == nil || options.ManagedConfig == nil {
			return errors.New("a new installation needs --vector-binary PATH and --managed-config PATH (absolute paths), plus --adopt; vectory setup finds them for you")
		}
		binary, config := *options.VectorBinary, *options.ManagedConfig
		if !options.Adopt {
			return fmt.Errorf("add --adopt to confirm that the agent takes over Vector at %s and manages %s; stop any other Vector that uses this configuration first", binary, config)
		}
		if err = regularPath(binary); err != nil {
			if os.IsNotExist(err) {
				return vectorMissing(ctx, binary)
			}
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
		if err = checkFileRoots(options.fileRoots(), dir, s.ManagedConfig, s.SecretFiles); err != nil {
			return err
		}
		if s.VectorVersion, err = probe(ctx, s); err != nil {
			if found := InspectVector(ctx, binary); found.Version != "" && !SupportedVectorVersion(found.Version) {
				reason := "this agent requires " + VectorSeries
				if vectorPrerelease(found.Version) {
					reason = "pre-releases aren't supported, so install a " + VectorSeries + " release"
				}
				return fmt.Errorf("found Vector %s at %s; %s. Install it from https://vector.dev/download/ or pass --vector-binary", found.Version, binary, reason)
			}
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
		if err = checkFileRoots(options.fileRoots(), dir, next.ManagedConfig, next.SecretFiles); err != nil {
			return err
		}
		policy := next.CapabilityPolicy
		for _, list := range [][]string{policy.AllowedFileRoots, policy.AllowedNetworkHosts, policy.AllowedListenAddresses} {
			if len(list) > 1024 {
				return errors.New("capability allowance list exceeds 1024 entries")
			}
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
