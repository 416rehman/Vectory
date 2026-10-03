package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type identityTransition struct {
	OldDeviceID string `json:"old_device_id"`
	NewDeviceID string `json:"new_device_id"`
}
type pendingRecovery struct {
	OldDeviceID string `json:"old_device_id"`
	NewDeviceID string `json:"new_device_id,omitempty"`
	TokenSHA256 string `json:"token_sha256"`
}

func cleanupPendingRecovery(pending string) error {
	if err := SafePath(pending); err != nil {
		return err
	}
	for _, name := range []string{"identity.json", "credentials.json", "private-key.pem", "enrollment.json", "state.json", "agent.lock", "origin.json"} {
		if err := os.Remove(filepath.Join(pending, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.Remove(pending); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// unissuedRecoveryRequest reports whether the pending recovery request cannot
// have created a replacement identity: nothing under pending-recovery holds
// one, and the request's record (the one vectory enroll keeps) says the server
// refused it or that it never left this host. Such a request may be replaced
// by one with another token. Any other record, a missing one or an identity
// keeps the original token required, so a reply lost after sending still
// returns the identity it issued.
func unissuedRecoveryRequest(pending string) bool {
	for _, name := range []string{"identity.json", "credentials.json"} {
		if _, err := os.Lstat(filepath.Join(pending, name)); !os.IsNotExist(err) {
			return false
		}
	}
	var request enrollmentPending
	exists, err := readOptionalEnrollmentJSON(filepath.Join(pending, "enrollment.json"), &request)
	return err == nil && exists && request.rebindable()
}

func resetForReplacement(s State, newID string) State {
	return State{DeviceID: newID, ApplyState: "unmanaged", ActualSHA256: s.ActualSHA256, LastGoodSHA256: s.LastGoodSHA256, Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}
}
func recoverIdentityTransition(dir string, cred Credentials, st State) (State, error) {
	var transition identityTransition
	err := ReadJSON(filepath.Join(dir, "recovery-commit.json"), &transition)
	if os.IsNotExist(err) {
		if st.DeviceID != "" && st.DeviceID != cred.DeviceID {
			return st, errors.New("credential identity differs from durable generation owner; explicit recovery required")
		}
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if cred.DeviceID == transition.OldDeviceID {
		return st, nil
	}
	if cred.DeviceID != transition.NewDeviceID {
		return st, errors.New("recovery identity journal does not match credential")
	}
	next := resetForReplacement(st, cred.DeviceID)
	if err = SaveState(dir, next); err != nil {
		return st, err
	}
	if err = os.Remove(filepath.Join(dir, "journal.json")); err != nil && !os.IsNotExist(err) {
		return st, err
	}
	if err = os.Remove(filepath.Join(dir, "recovery-commit.json")); err != nil {
		return st, err
	}
	return next, nil
}

func Unenroll(dir string) error {
	unlock, err := lockSettingsMaintenance(dir)
	if err != nil {
		return err
	}
	defer unlock()
	doc, err := loadSettingsDocument(dir)
	if err != nil {
		return err
	}
	s := doc.value
	stateDoc, err := loadMaintenanceDocument(filepath.Join(dir, "state.json"))
	if err != nil {
		return err
	}
	var st State
	if err = json.Unmarshal(stateDoc.raw, &st); err != nil {
		return err
	}
	s.Name, s.Server = "", ""
	settingsUpdate, err := doc.prepare(s)
	if err != nil {
		return err
	}
	defer settingsUpdate.close()
	nextState, err := json.MarshalIndent(resetForReplacement(st, ""), "", "  ")
	if err != nil {
		return err
	}
	stateUpdate, err := prepareMaintenanceWrite(stateDoc.path, stateDoc.raw, append(nextState, '\n'))
	if err != nil {
		return err
	}
	defer stateUpdate.close()
	if err = settingsUpdate.check(); err != nil {
		return err
	}
	// Both file replacements and metadata are prepared before identity removal.
	// Deletion and two renames are not a multi-file transaction; later failures
	// must not be represented as an untouched installation.
	partial := func(err error) error {
		return fmt.Errorf("unenrollment may be partially applied; preserve local files and inspect settings and status before continuing: %w", err)
	}
	for _, name := range []string{"identity.json", "credentials.json", "private-key.pem", "enrollment.json", "renewal-key.pem", "recovery-commit.json", "journal.json"} {
		if err = os.Remove(filepath.Join(dir, name)); err != nil && !os.IsNotExist(err) {
			return partial(err)
		}
	}
	if err = cleanupPendingRecovery(filepath.Join(dir, "pending-recovery")); err != nil {
		return partial(err)
	}
	if err = stateUpdate.commit(); err != nil {
		return partial(err)
	}
	if err = settingsUpdate.commit(); err != nil {
		return partial(err)
	}
	return nil
}

// Recovery requires an administrator-issued single-device recovery token and
// this explicit stopped-daemon command. Authentication failure never calls it.
func RecoverEnrollment(ctx context.Context, dir string, s Settings, token string) error {
	unlock, err := Lock(dir)
	if err != nil {
		return err
	}
	defer unlock()
	s, token, err = enrollmentInput(s, token)
	if err != nil {
		return err
	}
	if err = recoveryEnrollmentPreflight(dir, s, token); err != nil {
		return err
	}
	client, err := NewClient(s, nil, nil)
	if err != nil {
		return err
	}
	defer client.Close()
	return recoverEnrollmentPrepared(ctx, dir, s, token, client)
}

// Validate local recovery ownership without completing an old transition,
// removing staging files, rewriting settings or allocating a new identity.
func recoveryEnrollmentPreflight(dir string, s Settings, token string) error {
	old, _, err := ReadIdentity(dir)
	if err != nil || old.DeviceID == "" {
		return errors.New("existing device identity is required for recovery")
	}
	stateDoc, err := loadMaintenanceDocument(filepath.Join(dir, "state.json"))
	if err != nil {
		return errors.New("existing durable state is required for recovery")
	}
	var st State
	if err = json.Unmarshal(stateDoc.raw, &st); err != nil {
		return err
	}
	var transition identityTransition
	transitionExists, err := readOptionalEnrollmentJSON(filepath.Join(dir, "recovery-commit.json"), &transition)
	if err != nil {
		return err
	}
	if transitionExists {
		if transition.OldDeviceID == "" || transition.NewDeviceID == "" || transition.OldDeviceID == transition.NewDeviceID || old.DeviceID != transition.OldDeviceID && old.DeviceID != transition.NewDeviceID {
			return errors.New("recovery identity journal does not match credential")
		}
		if old.DeviceID == transition.NewDeviceID {
			st = resetForReplacement(st, old.DeviceID)
		}
	} else if st.DeviceID != "" && st.DeviceID != old.DeviceID {
		return errors.New("credential identity differs from durable generation owner; explicit recovery required")
	}
	pending := filepath.Join(dir, "pending-recovery")
	var origin pendingRecovery
	exists, err := readOptionalEnrollmentJSON(filepath.Join(pending, "origin.json"), &origin)
	if err != nil {
		return err
	}
	if exists {
		if origin.OldDeviceID == "" || !approvedDigest.MatchString(origin.TokenSHA256) {
			return errors.New("pending recovery origin is invalid; preserve local files")
		}
		if origin.OldDeviceID != old.DeviceID {
			if origin.NewDeviceID != old.DeviceID || st.DeviceID != old.DeviceID {
				return errors.New("pending recovery belongs to a different identity; inspect local state")
			}
			// An already committed recovery is cleaned by the existing commit
			// path only after all prospective input/trust checks have succeeded.
			return nil
		}
		if origin.TokenSHA256 != Digest([]byte(token)) && !unissuedRecoveryRequest(pending) {
			return errors.New("pending recovery must retry its original token before starting another request")
		}
	} else {
		for _, name := range []string{"identity.json", "credentials.json", "private-key.pem", "enrollment.json"} {
			if _, err := os.Lstat(filepath.Join(pending, name)); err == nil {
				return errors.New("pending recovery files have no origin; preserve them for inspection")
			} else if !os.IsNotExist(err) {
				return err
			}
		}
	}
	next, key, err := ReadIdentity(pending)
	if err == nil {
		if !exists || next.DeviceID == old.DeviceID {
			return errors.New("pending replacement identity has no matching recovery origin")
		}
		return validateCredentials(next, key, "")
	}
	if !os.IsNotExist(err) {
		return err
	}
	return enrollmentPreflight(pending, s)
}

func recoverEnrollmentPrepared(ctx context.Context, dir string, s Settings, token string, client *Client) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	old, _, err := ReadIdentity(dir)
	if err != nil {
		return errors.New("existing device identity is required for recovery")
	}
	st, err := LoadState(dir)
	if err != nil {
		return err
	}
	st, err = recoverIdentityTransition(dir, old, st)
	if err != nil {
		return err
	}
	pending := filepath.Join(dir, "pending-recovery")
	var origin pendingRecovery
	err = ReadJSON(filepath.Join(pending, "origin.json"), &origin)
	if err == nil && origin.OldDeviceID != old.DeviceID {
		if origin.NewDeviceID != old.DeviceID || st.DeviceID != old.DeviceID {
			return errors.New("pending recovery belongs to a different identity; inspect local state")
		}
		if err = cleanupPendingRecovery(pending); err != nil {
			return err
		}
		if origin.TokenSHA256 == Digest([]byte(token)) {
			return nil
		}
		origin = pendingRecovery{}
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	if origin.OldDeviceID != "" && origin.TokenSHA256 != Digest([]byte(token)) {
		if !unissuedRecoveryRequest(pending) {
			return errors.New("pending recovery must retry its original token before starting another request")
		}
		// The earlier request issued nothing: the new token starts a new one.
		if err = cleanupPendingRecovery(pending); err != nil {
			return err
		}
		origin = pendingRecovery{}
	}
	if err = PrivateDir(pending); err != nil {
		return err
	}
	if origin.OldDeviceID == "" {
		origin = pendingRecovery{OldDeviceID: old.DeviceID, TokenSHA256: Digest([]byte(token))}
		if err = WriteJSON(filepath.Join(pending, "origin.json"), origin); err != nil {
			return err
		}
	}
	next, key, err := ReadIdentity(pending)
	if os.IsNotExist(err) {
		// The caller owns the root lock and has validated prospective trust.
		// Retain the staging lock for direct frozen-settings API callers.
		unlock, lockErr := Lock(pending)
		if lockErr != nil {
			return lockErr
		}
		err = enrollmentPreflight(pending, s)
		if err == nil {
			err = enrollPrepared(ctx, pending, s, token, client)
		}
		unlock()
		if err != nil {
			return err
		}
		next, key, err = ReadIdentity(pending)
	}
	if err != nil {
		return err
	}
	if next.DeviceID == old.DeviceID {
		return errors.New("recovery must issue a replacement identity")
	}
	if err = validateCredentials(next, key, ""); err != nil {
		return err
	}
	origin.NewDeviceID = next.DeviceID
	if err = WriteJSON(filepath.Join(pending, "origin.json"), origin); err != nil {
		return err
	}
	if err = WriteJSON(filepath.Join(dir, "recovery-commit.json"), identityTransition{OldDeviceID: old.DeviceID, NewDeviceID: next.DeviceID}); err != nil {
		return err
	}
	if err = StoreIdentity(dir, next, key); err != nil {
		return err
	}
	if _, err = recoverIdentityTransition(dir, next, st); err != nil {
		return err
	}
	return cleanupPendingRecovery(pending)
}
