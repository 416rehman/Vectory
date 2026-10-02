package agent

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The signed manifest names the pipeline version it delivers (a version number
// and the pipeline's display name) so `vectory status` can say what runs. Both
// are for people only: nothing the agent decides depends on them. They are
// read leniently, so a value the agent can't use is absent rather than a reason
// to refuse a manifest, and they stay out of Identity, so a rename on the
// server never looks like the same generation changing its content.

// maxDisplayName bounds a pipeline name in Unicode scalars, as the server does.
const maxDisplayName = 120

// displayNumber is a version number: a positive safe integer, or zero when the
// manifest carried none or something else.
type displayNumber uint64

func (n *displayNumber) UnmarshalJSON(raw []byte) error {
	*n = 0
	if v, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64); err == nil && v >= 1 && v <= MaxJSONCounter {
		*n = displayNumber(v)
	}
	return nil
}

// displayName is a pipeline name that is safe to print: one to maxDisplayName
// characters with no control character, line or paragraph separator, or
// text-direction override. Anything else reads as no name.
type displayName string

func (n *displayName) UnmarshalJSON(raw []byte) error {
	*n = ""
	var text string
	if json.Unmarshal(raw, &text) == nil && wellFormedName(text) {
		*n = displayName(text)
	}
	return nil
}

func wellFormedName(text string) bool {
	if count := utf8.RuneCountInString(text); count < 1 || count > maxDisplayName || strings.TrimSpace(text) == "" {
		return false
	}
	return !strings.ContainsFunc(text, hostileRune)
}

// desiredIdentity is what makes a desired version the same one across
// manifests: the five fields every agent has always compared, in their original
// order, so a state file written by an earlier build still compares equal.
type desiredIdentity struct {
	VersionID     string `json:"version_id"`
	SHA256        string `json:"sha256"`
	Size          int64  `json:"size"`
	ArtifactPath  string `json:"artifact_path"`
	VectorVersion string `json:"vector_version"`
}

func (d *Desired) identity() desiredIdentity {
	return desiredIdentity{d.VersionID, d.SHA256, d.Size, d.ArtifactPath, d.VectorVersion}
}

// pipeline is the name and number the manifest gave this version, when it gave
// both.
func (d *Desired) pipeline() (name string, number uint64, ok bool) {
	if d == nil || d.ConfigurationName == "" || d.VersionNumber == 0 {
		return "", 0, false
	}
	return string(d.ConfigurationName), uint64(d.VersionNumber), true
}

// AppliedVersion is the pipeline version this device last verified as running,
// as the signed manifest that delivered it named it. The state keeps it beside
// the desired version because a version that failed and was rolled back leaves
// the desired one ahead of what runs.
type AppliedVersion struct {
	VersionID         string        `json:"version_id"`
	Generation        uint64        `json:"generation"`
	ConfigurationName displayName   `json:"configuration_name,omitempty"`
	VersionNumber     displayNumber `json:"version_number,omitempty"`
}

// pipeline is the applied version's name and number, when both are known.
func (a *AppliedVersion) pipeline() (name string, number uint64, ok bool) {
	if a == nil || a.ConfigurationName == "" || a.VersionNumber == 0 {
		return "", 0, false
	}
	return string(a.ConfigurationName), uint64(a.VersionNumber), true
}

// noteApplied records what the verified manifest called the version that now
// runs. The same version confirmed again refreshes its name, which is how a
// rename reaches a device without a new generation.
func (e *Engine) noteApplied(generation uint64, d *Desired) {
	e.State.Applied = &AppliedVersion{VersionID: d.VersionID, Generation: generation, ConfigurationName: d.ConfigurationName, VersionNumber: d.VersionNumber}
}
