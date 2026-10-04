package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var approvedDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type ReAdoptionReport struct {
	VectorBinary    string   `json:"vector_binary"`
	SHA256          string   `json:"sha256"`
	VectorVersion   string   `json:"vector_version"`
	Changed         bool     `json:"changed"`
	Validated       []string `json:"validated"`
	WorkloadStarted bool     `json:"workload_started"`
	NextAction      string   `json:"next_action"`
}

type adoptionChecks struct {
	probe    func(context.Context, Settings) (string, error)
	validate func(context.Context, Settings, string) error
}

// ReAdopt is an explicit stopped-agent host operation, never a remote command.
// Approval changes only the executable path/digest. Historical verification and
// failed-candidate suppression remain untouched; validation is not activation.
func ReAdopt(ctx context.Context, dir, binary, expected string) (ReAdoptionReport, error) {
	return reAdopt(ctx, dir, binary, expected, adoptionChecks{ProbeVector, func(ctx context.Context, s Settings, path string) error {
		// Re-adoption must validate with the same host runtime overlay as an
		// ordinary apply. A candidate check removes any directory or overlay it
		// had to create; approving a binary does not start Vector.
		_, err := (&VectorDriver{Settings: s, Dir: dir}).CheckCandidate(ctx, path, true)
		return err
	}})
}

func regularPath(path string) error {
	if err := adoptionLocalPath(path); err != nil {
		return err
	}
	if err := SafePath(path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("local maintenance requires regular files")
	}
	return nil
}

func adoptionObject(data []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return nil, errors.New("expected an existing JSON object")
	}
	result := map[string]json.RawMessage{}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		name, ok := key.(string)
		if !ok {
			return nil, errors.New("invalid JSON key")
		}
		if _, exists := result[name]; exists {
			return nil, errors.New("duplicate settings/state key")
		}
		var value json.RawMessage
		if err = decoder.Decode(&value); err != nil {
			return nil, err
		}
		result[name] = value
	}
	if _, err = decoder.Token(); err != nil {
		return nil, err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New("unexpected trailing JSON")
	}
	return result, nil
}

func noAdoptionTransition(dir string) error {
	for _, name := range []string{"journal.json", "recovery-commit.json"} {
		_, err := os.Lstat(filepath.Join(dir, name))
		if err == nil || !os.IsNotExist(err) {
			return errors.New("an apply or identity recovery is unfinished; restore the previously approved binary and complete recovery before re-adoption")
		}
	}
	return nil
}

// SaveState has always emitted these fields. Missing/null counters or policy
// cannot serve as evidence of a never-established installation.
func validAdoptionState(data []byte) (State, error) {
	var state State
	fields, err := adoptionObject(data)
	if err != nil || json.Unmarshal(data, &state) != nil {
		return state, errors.New("invalid durable state")
	}
	required := []string{"device_id", "highest_generation", "highest_policy_generation", "reported_generation", "apply_state", "actual_sha256", "last_good_sha256", "policy", "accepted", "remote_pause_acknowledged"}
	for _, key := range required {
		value, ok := fields[key]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return state, errors.New("durable state is incomplete")
		}
	}
	switch state.ApplyState {
	case "unmanaged", "desired", "downloaded", "validated", "written", "reload_requested", "verified_applied", "verification_unknown", "failed", "rolled_back", "paused":
	default:
		return state, errors.New("durable apply state is invalid")
	}
	policy, err := adoptionObject(fields["policy"])
	if err != nil {
		return state, err
	}
	for _, key := range []string{"heartbeat_seconds", "sync_paused", "telemetry_enabled"} {
		value, ok := policy[key]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return state, errors.New("durable policy is incomplete")
		}
	}
	if state.Policy.HeartbeatSeconds < 10 || state.Policy.HeartbeatSeconds > 3600 {
		return state, errors.New("durable policy interval is invalid")
	}
	if state.HighestGeneration > MaxJSONCounter || state.HighestPolicyGeneration > MaxJSONCounter || state.ReportedGeneration > MaxJSONCounter || state.SecretRevision > MaxJSONCounter || state.AppliedSecretRevision > MaxJSONCounter {
		return state, errors.New("durable counter exceeds the supported range")
	}
	return state, nil
}

func reAdopt(ctx context.Context, dir, binary, expected string, checks adoptionChecks) (ReAdoptionReport, error) {
	var report ReAdoptionReport
	expected = strings.ToLower(expected)
	switch {
	case expected == "":
		return report, inputError("--expected-sha256 is required: pass the SHA-256 of the Vector binary you trust, 64 hexadecimal characters (sha256sum shows it)")
	case !approvedDigest.MatchString(expected):
		return report, inputError(fmt.Sprintf("--expected-sha256 needs the whole SHA-256: 64 hexadecimal characters, and %s has %d", safeText(expected, 80), len(expected)))
	}
	if err := adoptionLocalPath(dir); err != nil {
		return report, err
	}
	if err := SafePath(dir); err != nil {
		return report, err
	}
	unlock, err := Lock(dir)
	if err != nil {
		return report, err
	}
	defer unlock()
	if err = noAdoptionTransition(dir); err != nil {
		return report, err
	}
	snapshots := map[string][]byte{}
	read := func(path string) ([]byte, error) {
		if err := regularPath(path); err != nil {
			return nil, err
		}
		data, err := readArtifact(path)
		if err == nil {
			snapshots[path] = data
		}
		return data, err
	}
	settingsPath := filepath.Join(dir, "settings.json")
	settingsBytes, err := read(settingsPath)
	if err != nil {
		return report, errors.New("existing protected settings are required for re-adoption")
	}
	fields, err := adoptionObject(settingsBytes)
	if err != nil {
		return report, errors.New("existing settings cannot be read safely")
	}
	var settings Settings
	if json.Unmarshal(settingsBytes, &settings) != nil || !settings.Adopted || !approvedDigest.MatchString(settings.VectorBinarySHA256) || !filepath.IsAbs(settings.VectorBinary) || !filepath.IsAbs(settings.ManagedConfig) {
		return report, errors.New("existing settings do not describe an adopted binary and managed configuration")
	}
	stateBytes, err := read(filepath.Join(dir, "state.json"))
	if err != nil {
		return report, errors.New("existing durable state is required; preserve and recover it before re-adoption")
	}
	state, err := validAdoptionState(stateBytes)
	if err != nil {
		return report, errors.New("existing durable state cannot be read safely")
	}
	if binary == "" {
		binary = settings.VectorBinary
	}
	if !filepath.IsAbs(binary) {
		return report, errors.New("candidate binary requires an absolute local path")
	}
	binary = filepath.Clean(binary)
	checkCandidate := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := regularPath(binary); err != nil {
			return err
		}
		digest, err := FileDigest(binary)
		if err != nil {
			return fmt.Errorf("can't read %s to check its SHA-256: %w; no binary was approved", binary, err)
		}
		if digest != expected {
			return fmt.Errorf("the SHA-256 of %s is %s, not the %s you passed; no binary was approved", binary, digest, expected)
		}
		return nil
	}
	if err = checkCandidate(); err != nil {
		return report, err
	}
	candidate := settings
	candidate.VectorBinary, candidate.VectorBinarySHA256 = binary, expected
	version, err := checks.probe(ctx, candidate)
	if err != nil {
		return report, err
	}
	if err = checkCandidate(); err != nil {
		return report, err
	}
	if !SupportedVectorVersion(version) {
		return report, errors.New("candidate is not a supported Vector version (" + VectorSeries + ")")
	}
	artifacts := []struct {
		label, path string
		data        []byte
	}{}
	managed, err := read(settings.ManagedConfig)
	missingManaged := os.IsNotExist(err)
	if err != nil && !(missingManaged && state.LastGoodSHA256 == "" && state.ReportedGeneration == 0 && state.ActualSHA256 == "" && state.AppliedTemplateSHA256 == "") {
		return report, errors.New("existing managed configuration is missing or unreadable; restore it before re-adoption")
	}
	if err == nil {
		artifacts = append(artifacts, struct {
			label, path string
			data        []byte
		}{"managed", settings.ManagedConfig, managed})
	}
	if state.LastGoodSHA256 != "" {
		if !approvedDigest.MatchString(state.LastGoodSHA256) {
			return report, errors.New("last-good identity is invalid")
		}
		path := filepath.Join(dir, "good-"+state.LastGoodSHA256+".json")
		good, err := read(path)
		if err != nil || Digest(good) != state.LastGoodSHA256 {
			return report, errors.New("last-good artifact is missing or corrupted; preserve recovery data before re-adoption")
		}
		artifacts = append(artifacts, struct {
			label, path string
			data        []byte
		}{"last_good", path, good})
	}
	report.Validated = []string{}
	for _, artifact := range artifacts {
		if err = candidate.CapabilityPolicy.Check(artifact.data); err != nil {
			return report, fmt.Errorf("%s configuration violates the unchanged local capability policy", artifact.label)
		}
		if err = checkCandidate(); err != nil {
			return report, err
		}
		// Validate exact snapshotted bytes next to the source so filesystem context
		// is unchanged. The original documents are never rewritten or restored.
		f, err := os.CreateTemp(filepath.Dir(artifact.path), ".vectory-stage-readopt-*.json")
		if err != nil {
			return report, errors.New("cannot prepare private validation snapshot")
		}
		path := f.Name()
		defer os.Remove(path)
		if err = protect(path, false); err == nil {
			_, err = f.Write(artifact.data)
		}
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			return report, errors.New("cannot write private validation snapshot")
		}
		if err = checks.validate(ctx, candidate, path); err != nil {
			return report, fmt.Errorf("%s configuration did not pass candidate validation: %w", artifact.label, err)
		}
		if err = checkCandidate(); err != nil {
			return report, err
		}
		report.Validated = append(report.Validated, artifact.label)
	}
	if err = noAdoptionTransition(dir); err != nil {
		return report, err
	}
	for path, original := range snapshots {
		if err = regularPath(path); err != nil {
			return report, errors.New("preserved file changed during re-adoption; no settings were approved")
		}
		current, readErr := readArtifact(path)
		if readErr != nil || !bytes.Equal(current, original) {
			return report, errors.New("preserved file changed during re-adoption; no settings were approved")
		}
	}
	if missingManaged {
		if _, err = os.Lstat(settings.ManagedConfig); !os.IsNotExist(err) {
			return report, errors.New("managed file appeared during re-adoption; review it before continuing")
		}
	}
	if err = checkCandidate(); err != nil {
		return report, err
	}
	report.VectorBinary, report.SHA256, report.VectorVersion = binary, expected, version
	report.Changed = binary != settings.VectorBinary || expected != settings.VectorBinarySHA256
	report.NextAction = "Binary identity approved; no workload started. Restart the agent and verify current status. A previously rejected candidate still requires a separate explicit retry while stopped."
	if len(report.Validated) == 0 {
		report.NextAction = "Binary identity approved; no existing workload was available to validate and no workload started. Restart the agent and review its status."
	}
	if !report.Changed {
		return report, nil
	}
	fields["vector_binary"], _ = json.Marshal(binary)
	fields["vector_binary_sha256"], _ = json.Marshal(expected)
	fields["vector_version"], _ = json.Marshal(version)
	updated, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return report, err
	}
	if err = replaceAdoptionSettings(settingsPath, snapshots[settingsPath], append(updated, '\n')); err != nil {
		return report, err
	}
	return report, nil
}

func replaceAdoptionSettings(path string, original, data []byte) error {
	prepared, err := prepareMaintenanceWrite(path, original, data)
	if err != nil {
		return err
	}
	defer prepared.close()
	return prepared.commit()
}
