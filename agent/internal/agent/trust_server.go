package agent

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// TrustServerOptions is an explicit, local repair of an enrolled device's
// server trust. Exactly one of CASHA256 or CAFile must be selected; a pointer
// to an empty CAFile deliberately selects the host's system roots.
type TrustServerOptions struct {
	Server   string
	CASHA256 string
	CAFile   *string
}

type TrustServerResult struct {
	Server string `json:"server"`
	Trust  string `json:"trust"`
}

// TrustServer changes only settings.ca_file. It holds the same maintenance
// lock as other stopped-agent changes, and verifies the candidate against the
// exact saved origin before activating it. It never sends a device credential
// or enrollment token during the probe.
func TrustServer(ctx context.Context, dir string, choice TrustServerOptions) (TrustServerResult, error) {
	var result TrustServerResult
	if choice.Server == "" {
		return result, errors.New("trust-server requires --server with the exact enrolled address")
	}
	if (choice.CASHA256 != "") == (choice.CAFile != nil) {
		return result, errors.New("choose exactly one of --ca-sha256 or --ca-file (use --ca-file= for system roots)")
	}
	unlock, err := lockSettingsMaintenance(dir)
	if err != nil {
		return result, err
	}
	defer unlock()
	doc, err := loadSettingsDocument(dir)
	if err != nil {
		return result, err
	}
	saved := doc.value.Server
	if normalized, err := NormalizeServer(saved); err != nil || normalized != saved {
		return result, errors.New("saved server address is missing or ambiguous; inspect settings before changing trust")
	}
	if choice.Server != saved {
		return result, fmt.Errorf("this host is enrolled with %q, not %q; trust-server never moves a device to another address", saved, choice.Server)
	}
	identity, key, err := ReadIdentity(dir)
	if err != nil || identity.DeviceID == "" || len(key) == 0 {
		return result, errors.New("trust-server requires an existing readable device identity; it never enrolls a new device")
	}
	result.Server = saved
	var candidate []byte
	if choice.CASHA256 != "" {
		pin, err := ParseCAFingerprint(choice.CASHA256)
		if err != nil {
			return result, err
		}
		certificate, err := ProbePinnedCA(ctx, saved, pin)
		if err != nil {
			return result, err
		}
		candidate = PinnedCAPEM(certificate)
		result.Trust = "pinned CA"
	} else if *choice.CAFile == "" {
		if err := ProbeServer(ctx, saved, ""); err != nil {
			return result, err
		}
		next := doc.value
		next.CAFile = ""
		if err := doc.save(next); err != nil {
			return result, err
		}
		result.Trust = "system certificate store"
		return result, nil
	} else {
		candidate, err = readCandidateCA(*choice.CAFile)
		if err != nil {
			return result, err
		}
		result.Trust = "supplied CA file"
	}

	// Snapshot the selected certificate bytes into private state. The service
	// can read it with exactly the access it has to settings.json, and an
	// operator changing the source file later cannot silently change trust.
	path, err := stageServerCA(dir, doc.path, candidate)
	if err != nil {
		return result, err
	}
	if choice.CAFile != nil {
		if err := ProbeServer(ctx, saved, path); err != nil {
			_ = os.Remove(path)
			return result, err
		}
	}
	next := doc.value
	next.CAFile = path
	if err := doc.save(next); err != nil {
		// A failed durability sync can occur after replacement. Keep the CA
		// whenever the current settings may already point to it.
		if current, readErr := LoadSettings(dir); readErr == nil && current.CAFile != path {
			_ = os.Remove(path)
		}
		return result, err
	}
	return result, nil
}

func readCandidateCA(path string) ([]byte, error) {
	if err := regularPath(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 2*MaxArtifact+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 2*MaxArtifact {
		return nil, errors.New("CA file exceeds local maintenance limit")
	}
	var certificates []byte
	for rest := bytes.TrimSpace(data); len(rest) > 0; {
		if !bytes.HasPrefix(rest, []byte("-----BEGIN CERTIFICATE-----")) {
			return nil, errors.New("CA file must contain only PEM certificate blocks, with no private keys or other data")
		}
		block, next := pem.Decode(rest)
		if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 {
			return nil, errors.New("CA file must contain only PEM certificate blocks, with no private keys or other data")
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return nil, errors.New("CA file contains an invalid certificate")
		}
		certificates = append(certificates, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: block.Bytes})...)
		rest = bytes.TrimSpace(next)
	}
	if len(certificates) == 0 {
		return nil, errors.New("CA file has no PEM certificates")
	}
	return certificates, nil
}

func stageServerCA(dir, securitySource string, data []byte) (string, error) {
	f, err := os.CreateTemp(dir, "server-ca-*.pem")
	if err != nil {
		return "", err
	}
	path := f.Name()
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(path)
		}
	}()
	if err = protect(path, false); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err = preserveSettingsSecurity(securitySource, path); err != nil {
		return "", fmt.Errorf("cannot give the service account access to the new CA: %w", err)
	}
	if err = syncDir(filepath.Dir(path)); err != nil {
		return "", err
	}
	committed = true
	return path, nil
}
