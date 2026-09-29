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
// value (use only system trust). CASHA256 pins the server CA by fingerprint
// instead; the verified certificate becomes the saved trust file. Recovery may
// omit the saved server and name.
type EnrollmentOptions struct {
	Server, Name, Token string
	CAFile              *string
	CASHA256            string
	Recover             bool
	// ServiceManager is what setup registered to keep the agent running
	// (systemd, launchd, windows or none); empty when enroll runs alone.
	ServiceManager string
}

// OpenEnrollmentTokenFile pins and verifies the local file before the CLI
// reads the one-time input. In particular, a readable Windows file is not
// necessarily private: its DACL must be checked on the opened handle. Local
// path validation also excludes Windows alternate data stream syntax.
func OpenEnrollmentTokenFile(path string) (*os.File, error) {
	if err := adoptionLocalPath(path); err != nil {
		return nil, tokenFileRefusal(path, "isn't a plain path on a local disk", "")
	}
	if err := SafePath(path); err != nil {
		return nil, tokenFileRefusal(path, "is reached through a symbolic link", "Pass the real file's path.")
	}
	f, err := openPrivateFile(path)
	if err != nil {
		problem, fix := privateFileProblem(path, err)
		return nil, tokenFileRefusal(path, problem, fix)
	}
	return f, nil
}

// tokenFileRefusal names the check a token file failed and how to fix it.
// The file must be private, regular, single-linked, and owned by this account
// or an administrator.
func tokenFileRefusal(path, problem, fix string) error {
	message := "Token file " + path + " " + problem + "."
	if fix != "" {
		message += " " + fix
	}
	return errors.New(message)
}

type enrollmentPending struct {
	RequestID string `json:"request_id"`
	Name      string `json:"name"`
	Server    string `json:"server"`
	// Delivery records what the server can have seen of this request: "no"
	// (no attempt left this host), "maybe" (an attempt may have reached it) or
	// "refused" (the server definitively refused it, so nothing was enrolled).
	// Records written by earlier builds have no value and count as "maybe".
	Delivery string `json:"delivery,omitempty"`
	// LastFailure is the classified code of the most recent failed attempt.
	LastFailure string `json:"last_failure,omitempty"`
}

// A request the server never saw, or definitively refused, cannot have
// created a device; its server, name and token may change. Anything else keeps
// the idempotent binding so a lost reply can still return the same identity.
func (p enrollmentPending) rebindable() bool {
	return p.Delivery == "no" || p.Delivery == "refused"
}

// PendingEnrollment describes an unfinished enrollment for status and doctor.
type PendingEnrollment struct {
	Name        string `json:"name"`
	Server      string `json:"server"`
	Delivery    string `json:"delivery"`
	LastFailure string `json:"last_failure,omitempty"`
}

// ReadPendingEnrollment returns the unfinished enrollment in dir, if any.
func ReadPendingEnrollment(dir string) (*PendingEnrollment, error) {
	var pending enrollmentPending
	exists, err := readOptionalEnrollmentJSON(filepath.Join(dir, "enrollment.json"), &pending)
	if err != nil || !exists {
		return nil, err
	}
	delivery := pending.Delivery
	if delivery == "" {
		delivery = "maybe"
	}
	return &PendingEnrollment{Name: pending.Name, Server: pending.Server, Delivery: delivery, LastFailure: pending.LastFailure}, nil
}

func pendingBindingError(pending enrollmentPending) error {
	return fmt.Errorf("an earlier enrollment of %q with %s may have reached the server. Run the command again with that server and name (a new token is fine) so this host gets its identity back", pending.Name, pending.Server)
}

// enrollmentFailure adds what happens next to a classified request failure.
func enrollmentFailure(err error) error {
	ce, ok := AsConnectionError(err)
	if !ok {
		return err
	}
	next := *ce
	switch {
	case ce.Delivery == NotSent:
		next.Fix = strings.TrimSpace(ce.Fix + " Nothing was sent to the server, so you can change the address, name or token and run the command again.")
	case ce.Code == "ENROLLMENT_REFUSED":
		return err
	default:
		next.Fix = strings.TrimSpace(ce.Fix + " The server may have received the request: run the same command again to finish (keep the server and name; a new token is fine).")
		if ce.Fix == "Run the same command again; it picks up where it stopped." {
			next.Fix = "The server may have received the request: run the same command again to finish (keep the server and name; a new token is fine)."
		}
	}
	return &next
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

// CheckEnrollmentToken refuses, before anything is sent, a paste that can't
// be a token: the server issues 64 hexadecimal characters (enrollment and
// recovery tokens alike), so a short or mangled paste would only be refused.
func CheckEnrollmentToken(token string) error {
	token = strings.TrimSpace(token)
	switch {
	case len(token) != 64:
		return fmt.Errorf("that isn't a whole enrollment token: tokens are 64 characters, and this one has %d. Copy it again with Copy token on Add device", len(token))
	case strings.Trim(token, "0123456789abcdef") != "":
		return errors.New("that isn't an enrollment token: tokens use only the characters 0-9 and a-f. Copy it again with Copy token on Add device")
	}
	return nil
}

// ValidateDeviceName applies the server's device-name rules locally, so a bad
// name is reported before anyone types a token.
func ValidateDeviceName(name string) error {
	_, _, err := enrollmentInput(Settings{Server: "https://name-check.invalid", Name: name}, "placeholder")
	return err
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
	if exists && (pending.RequestID == "" || len(pending.RequestID) > 128) {
		return errors.New("the pending enrollment record is invalid; preserve enrollment.json and private-key.pem for inspection")
	}
	if exists && !pending.rebindable() && (pending.Name != s.Name || pending.Server != s.Server) {
		return pendingBindingError(pending)
	}
	keyPath := filepath.Join(dir, "private-key.pem")
	if err = regularPath(keyPath); os.IsNotExist(err) {
		if exists && !pending.rebindable() {
			return errors.New("the pending enrollment's private key is missing; restore private-key.pem from backup before retrying, because the server may already hold this request")
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
	var pin []byte
	if options.CASHA256 != "" {
		if options.CAFile != nil {
			return errors.New("choose one of --ca-sha256 or --ca-file")
		}
		if options.Recover {
			return errors.New("--ca-sha256 applies to new enrollments; recovery keeps the saved server trust")
		}
		var err error
		if pin, err = ParseCAFingerprint(options.CASHA256); err != nil {
			return err
		}
	}
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
	if pin != nil {
		// Trust preflight: nothing is saved unless the presented chain verifies
		// against the pinned CA for this host name.
		certificate, err := ProbePinnedCA(ctx, s.Server, pin)
		if err != nil {
			return err
		}
		if s.CAFile, err = savePinnedCA(dir, certificate); err != nil {
			return err
		}
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
		err = enrollPreparedAs(ctx, dir, s, token, client, options.ServiceManager)
	}
	return enrollmentFailure(err)
}
