package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// These helpers are for explicitly locked local settings maintenance only.
// State/credential writers keep their existing transaction semantics.
type maintenanceDocument struct {
	path   string
	raw    []byte
	fields map[string]json.RawMessage
}

type settingsDocument struct {
	*maintenanceDocument
	value Settings
	known map[string]json.RawMessage
}

func lockSettingsMaintenance(dir string) (func(), error) {
	if err := adoptionLocalPath(dir); err != nil {
		return nil, err
	}
	if err := SafePath(dir); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return nil, errors.New("local maintenance requires an existing state directory")
	}
	if _, err = os.Lstat(filepath.Join(dir, "agent.lock")); err == nil {
		if err = regularPath(filepath.Join(dir, "agent.lock")); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return Lock(dir)
}

func loadMaintenanceDocument(path string) (*maintenanceDocument, error) {
	if err := regularPath(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 2*MaxArtifact+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 2*MaxArtifact {
		return nil, errors.New("local maintenance file exceeds limit")
	}
	fields, err := adoptionObject(raw)
	if err != nil {
		return nil, err
	}
	return &maintenanceDocument{path: path, raw: raw, fields: fields}, nil
}

func loadSettingsDocument(dir string) (*settingsDocument, error) {
	doc, err := loadMaintenanceDocument(filepath.Join(dir, "settings.json"))
	if err != nil {
		return nil, err
	}
	var s Settings
	if err = json.Unmarshal(doc.raw, &s); err != nil {
		return nil, err
	}
	knownBytes, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	known, err := adoptionObject(knownBytes)
	if err != nil {
		return nil, err
	}
	return &settingsDocument{maintenanceDocument: doc, value: s, known: known}, nil
}

// Diff only fields understood by this build. Unknown nested capability fields
// survive; arrays and the caller-owned secret binding map are replacements.
func patchSettingsFields(raw, before, after map[string]json.RawMessage) error {
	for key, old := range before {
		next, exists := after[key]
		if !exists {
			delete(raw, key)
			continue
		}
		if bytes.Equal(old, next) {
			continue
		}
		if key != "secret_files" && len(old) > 0 && old[0] == '{' && len(next) > 0 && next[0] == '{' {
			oldFields, err := adoptionObject(old)
			if err != nil {
				return err
			}
			nextFields, err := adoptionObject(next)
			if err != nil {
				return err
			}
			current := map[string]json.RawMessage{}
			if value := bytes.TrimSpace(raw[key]); len(value) != 0 && !bytes.Equal(value, []byte("null")) {
				current, err = adoptionObject(value)
				if err != nil {
					return errors.New("existing settings object cannot be preserved")
				}
			}
			if err = patchSettingsFields(current, oldFields, nextFields); err != nil {
				return err
			}
			raw[key], err = json.Marshal(current)
			if err != nil {
				return err
			}
		} else {
			raw[key] = next
		}
	}
	for key, next := range after {
		if _, exists := before[key]; !exists {
			raw[key] = next
		}
	}
	return nil
}

func (doc *settingsDocument) prepare(next Settings) (*preparedMaintenanceWrite, error) {
	encoded, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	after, err := adoptionObject(encoded)
	if err != nil {
		return nil, err
	}
	before, _ := json.Marshal(doc.known)
	afterCanonical, _ := json.Marshal(after)
	if bytes.Equal(before, afterCanonical) {
		return prepareMaintenanceWrite(doc.path, doc.raw, doc.raw)
	}
	fields, err := adoptionObject(doc.raw)
	if err != nil {
		return nil, err
	}
	if err = patchSettingsFields(fields, doc.known, after); err != nil {
		return nil, err
	}
	updated, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return nil, err
	}
	return prepareMaintenanceWrite(doc.path, doc.raw, append(updated, '\n'))
}

func (doc *settingsDocument) save(next Settings) error {
	prepared, err := doc.prepare(next)
	if err != nil {
		return err
	}
	defer prepared.close()
	return prepared.commit()
}

type preparedMaintenanceWrite struct {
	path, temporary string
	original        []byte
}

func (p *preparedMaintenanceWrite) close() {
	if p.temporary != "" {
		_ = os.Remove(p.temporary)
	}
}

func (p *preparedMaintenanceWrite) check() error {
	doc, err := loadMaintenanceDocument(p.path)
	if err != nil || !bytes.Equal(doc.raw, p.original) {
		return errors.New("local maintenance file changed; review current settings and status before retrying")
	}
	return nil
}

func (p *preparedMaintenanceWrite) commit() error {
	if err := p.check(); err != nil {
		return err
	}
	if p.temporary == "" {
		return nil
	}
	// Another local administrator may have changed access without changing
	// bytes since preparation. Preserve the latest policy, then recheck bytes.
	if err := preserveSettingsSecurity(p.path, p.temporary); err != nil {
		return errors.New("cannot preserve current ownership and access permissions; local maintenance was not committed")
	}
	if err := p.check(); err != nil {
		return err
	}
	if err := replaceFile(p.temporary, p.path); err != nil {
		return err
	}
	p.temporary = ""
	if err := syncDir(filepath.Dir(p.path)); err != nil {
		return fmt.Errorf("local maintenance file was replaced, but durability confirmation failed; inspect settings and status before continuing: %w", err)
	}
	return nil
}

func prepareMaintenanceWrite(path string, original, data []byte) (*preparedMaintenanceWrite, error) {
	return prepareMaintenanceWriteWithSecurity(path, original, data, preserveSettingsSecurity)
}

func prepareMaintenanceWriteWithSecurity(path string, original, data []byte, preserve func(string, string) error) (*preparedMaintenanceWrite, error) {
	p := &preparedMaintenanceWrite{path: path, original: original}
	if err := p.check(); err != nil {
		return nil, err
	}
	if bytes.Equal(original, data) {
		return p, nil
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".vectory-settings-*")
	if err != nil {
		return nil, err
	}
	p.temporary = f.Name()
	passed := false
	defer func() {
		if !passed {
			p.close()
		}
	}()
	if err = protect(p.temporary, false); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err = preserve(path, p.temporary); err != nil {
		return nil, errors.New("cannot preserve existing ownership and access permissions; local maintenance was not committed")
	}
	if err = p.check(); err != nil {
		return nil, err
	}
	passed = true
	return p, nil
}

// Mode/allowance changes permit a previously suppressed candidate to be
// reassessed. Patch only these fields; never reserialize unrelated state.
func prepareSettingsRetryReset(dir string) (*preparedMaintenanceWrite, error) {
	doc, err := loadMaintenanceDocument(filepath.Join(dir, "state.json"))
	if err != nil {
		return nil, err
	}
	var state State
	if err = json.Unmarshal(doc.raw, &state); err != nil {
		return nil, err
	}
	if state.FailedGeneration == nil && state.FailedEffectiveSHA256 == "" {
		return prepareMaintenanceWrite(doc.path, doc.raw, doc.raw)
	}
	delete(doc.fields, "failed_generation")
	delete(doc.fields, "failed_effective_sha256")
	updated, err := json.MarshalIndent(doc.fields, "", "  ")
	if err != nil {
		return nil, err
	}
	return prepareMaintenanceWrite(doc.path, doc.raw, append(updated, '\n'))
}

func commitSettingsWithRetryReset(dir string, doc *settingsDocument, next Settings) error {
	settings, err := doc.prepare(next)
	if err != nil {
		return err
	}
	defer settings.close()
	state, err := prepareSettingsRetryReset(dir)
	if err != nil {
		return err
	}
	defer state.close()
	if err = settings.check(); err != nil {
		return err
	}
	if err = state.check(); err != nil {
		return err
	}
	if err = settings.commit(); err != nil {
		return err
	}
	if err = state.commit(); err != nil {
		return fmt.Errorf("settings were saved, but retry-suppression reset is incomplete; inspect status and use stopped-agent retry after resolving the local file error: %w", err)
	}
	return nil
}

// retryRequestName marks a retry asked for on this host while the agent ran;
// the running agent takes it at its next loop (see Engine.takeQueuedRetry).
const retryRequestName = "retry-requested"

// QueueRetry leaves a retry request for the running agent, which holds the
// agent lock. Like the local pause, it only takes the lifecycle guard, so it
// never races a purge of the state directory.
func QueueRetry(dir string) error {
	releaseLifecycle, err := lockLifecycle(dir)
	if err != nil {
		return err
	}
	defer releaseLifecycle()
	if err := checkNoPendingPurge(dir); err != nil {
		return err
	}
	if info, err := os.Lstat(filepath.Join(dir, "state.json")); err != nil || !info.Mode().IsRegular() {
		return errors.New("retry requires existing agent state")
	}
	return AtomicWrite(filepath.Join(dir, retryRequestName), []byte("retry requested on this host\n"))
}

// Retry is explicit local maintenance, not a runtime reconciliation state save.
func Retry(dir string) error {
	unlock, err := lockSettingsMaintenance(dir)
	if err != nil {
		return err
	}
	defer unlock()
	state, err := prepareSettingsRetryReset(dir)
	if err != nil {
		return err
	}
	defer state.close()
	if err = state.commit(); err != nil {
		return err
	}
	// A request queued while the agent ran is answered by this reset.
	if err = os.Remove(filepath.Join(dir, retryRequestName)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
