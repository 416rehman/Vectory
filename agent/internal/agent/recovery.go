package agent

import (
	"context"
	"errors"
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
	unlock, err := Lock(dir)
	if err != nil {
		return err
	}
	defer unlock()
	s, err := LoadSettings(dir)
	if err != nil {
		return err
	}
	st, err := LoadState(dir)
	if err != nil {
		return err
	}
	for _, name := range []string{"identity.json", "credentials.json", "private-key.pem", "enrollment.json", "renewal-key.pem", "recovery-commit.json", "journal.json"} {
		if err = os.Remove(filepath.Join(dir, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err = cleanupPendingRecovery(filepath.Join(dir, "pending-recovery")); err != nil {
		return err
	}
	if err = SaveState(dir, resetForReplacement(st, "")); err != nil {
		return err
	}
	s.Name = ""
	s.Server = ""
	return WriteJSON(filepath.Join(dir, "settings.json"), s)
}

// Recovery requires an administrator-issued single-device recovery token and
// this explicit stopped-daemon command. Authentication failure never calls it.
func RecoverEnrollment(ctx context.Context, dir string, s Settings, token string) error {
	unlock, err := Lock(dir)
	if err != nil {
		return err
	}
	defer unlock()
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
		return errors.New("pending recovery must retry its original token before starting another request")
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
		if err = Enroll(ctx, pending, s, token); err != nil {
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
