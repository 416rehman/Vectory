package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// CAFile distinguishes omission (retain current trust) from an explicit empty
// value (use only system trust). Recovery may omit the saved server and name.
type EnrollmentOptions struct {
	Server, Name, Token string
	CAFile              *string
	Recover             bool
}

// OpenEnrollmentTokenFile pins and verifies the local file before the CLI
// reads the one-time input. In particular, a readable Windows file is not
// necessarily private: its DACL must be checked on the opened handle. Local
// path validation also excludes Windows alternate data stream syntax.
func OpenEnrollmentTokenFile(path string) (*os.File, error) {
	const refused = "token file must be private, regular, single-linked and owned by this account or administrator at a safe absolute local path"
	if err := adoptionLocalPath(path); err != nil {
		return nil, errors.New(refused)
	}
	if err := SafePath(path); err != nil {
		return nil, errors.New(refused)
	}
	f, err := openPrivateFile(path)
	if err != nil {
		return nil, errors.New(refused)
	}
	return f, nil
}

type enrollmentPending struct {
	RequestID string `json:"request_id"`
	Name      string `json:"name"`
	Server    string `json:"server"`
}

func enrollmentInput(s Settings, token string) (Settings, string, error) {
	token = strings.TrimSpace(token)
	if token == "" || len(token) > 4096 {
		return s, token, errors.New("invalid enrollment token")
	}
	origin, err := NormalizeServer(s.Server)
	if err != nil {
		return s, token, err
	}
	s.Server = origin
	// Validate the server's accepted spelling without rewriting a frozen retry.
	name := strings.TrimSpace(s.Name)
	if len(s.Name) > 100 || name == "" {
		return s, token, errors.New("machine name must contain at most 100 bytes and use ASCII letters, digits, hyphens, underscores or dots, starting with a letter or digit")
	}
	for i, c := range []byte(name) {
		alnum := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
		if !alnum && (i == 0 || c != '-' && c != '_' && c != '.') {
			return s, token, errors.New("machine name must contain at most 100 bytes and use ASCII letters, digits, hyphens, underscores or dots, starting with a letter or digit")
		}
	}
	return s, token, nil
}

func readOptionalEnrollmentJSON(path string, value any) (bool, error) {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	doc, err := loadMaintenanceDocument(path)
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(doc.raw, value)
}

// This read-only check precedes settings, key and request writes. A legacy
// pending request may already have reached the server; its key is never rebuilt.
func enrollmentPreflight(dir string, s Settings) error {
	if _, _, err := ReadIdentity(dir); err == nil {
		return errors.New("already enrolled; identity and settings are preserved")
	} else if !os.IsNotExist(err) {
		return err
	}
	for _, name := range []string{"identity.json", "credentials.json"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); err == nil {
			return errors.New("existing identity is incomplete; preserve its credentials and original key before recovery")
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	var pending enrollmentPending
	exists, err := readOptionalEnrollmentJSON(filepath.Join(dir, "enrollment.json"), &pending)
	if err != nil {
		return err
	}
	if exists && (pending.RequestID == "" || len(pending.RequestID) > 128 || pending.Name != s.Name || pending.Server != s.Server) {
		return errors.New("pending enrollment belongs to a different server or name or is invalid; preserve its key and request and retry the original intent")
	}
	keyPath := filepath.Join(dir, "private-key.pem")
	if err = regularPath(keyPath); os.IsNotExist(err) {
		if exists {
			return errors.New("pending enrollment key is missing; preserve the request and restore its original key before retrying")
		}
		return nil
	} else if err != nil {
		return err
	}
	f, err := os.Open(keyPath)
	if err != nil {
		return err
	}
	defer f.Close()
	key, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(key) > 65536 {
		return errors.New("existing enrollment key cannot be read safely")
	}
	_, err = enrollmentCSR(key)
	return err
}

// EnrollWithOptions holds one maintenance lock from the fresh settings read
// through request completion. It saves the prepared intent before any request
// may be sent, and never rolls that intent back on a network/protocol failure.
func EnrollWithOptions(ctx context.Context, dir string, options EnrollmentOptions) error {
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
	if options.Server != "" || !options.Recover {
		s.Server = options.Server
	}
	if options.Name != "" || !options.Recover {
		s.Name = options.Name
	}
	if options.CAFile != nil {
		s.CAFile = *options.CAFile
	}
	s, token, err := enrollmentInput(s, options.Token)
	if err != nil {
		return err
	}
	stateDoc, err := loadMaintenanceDocument(filepath.Join(dir, "state.json"))
	if err != nil {
		return errors.New("existing durable state is required; preserve local files and restore it before enrollment")
	}
	state, err := validAdoptionState(stateDoc.raw)
	if err != nil {
		return errors.New("existing durable state cannot be read safely; preserve it before enrollment")
	}
	if options.Recover {
		if doc.value.Server != s.Server || doc.value.Name != s.Name {
			return errors.New("recovery must preserve the enrolled server and machine name")
		}
		err = recoveryEnrollmentPreflight(dir, s, token)
	} else {
		err = enrollmentPreflight(dir, s)
		if err == nil && state.DeviceID != "" {
			err = errors.New("durable state belongs to an existing device; preserve its identity and use explicit recovery")
		}
	}
	if err != nil {
		return err
	}
	client, err := NewClient(s, nil, nil)
	if err != nil {
		return err
	}
	defer client.Close()
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = doc.save(s); err != nil {
		return err
	}
	if options.Recover {
		err = recoverEnrollmentPrepared(ctx, dir, s, token, client)
	} else {
		err = enrollPrepared(ctx, dir, s, token, client)
	}
	if err != nil {
		return fmt.Errorf("enrollment preparation was saved; preserve this state and retry the same server, name and token after resolving the error: %w", err)
	}
	return nil
}
