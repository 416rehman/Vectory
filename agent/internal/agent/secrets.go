package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const secretPrefix = "vectory-secret:"
const MaxSecret = 16 * 1024

var secretName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

// secretReferenceError says which typed reference failed, by name and
// location only. Values and file paths never leave the host.
type secretReferenceError struct {
	name, sink, field, code string
	err                     error
}

func (e *secretReferenceError) Error() string { return e.err.Error() }
func (e *secretReferenceError) Unwrap() error { return e.err }

// ResolveLocalSecrets only replaces complete typed JSON string leaves at known
// authentication fields. It cannot interpolate text, alter structure or choose
// executable/providers/paths. Return values must never be logged or exported.
func ResolveLocalSecrets(template []byte, bindings map[string]string) (effective []byte, used bool, err error) {
	return resolveLocalSecrets(template, bindings, false)
}

func resolveLocalSecrets(template []byte, bindings map[string]string, fullVector bool) (effective []byte, used bool, err error) {
	decoder := json.NewDecoder(bytes.NewReader(template))
	decoder.UseNumber()
	var root map[string]any
	if err = decoder.Decode(&root); err != nil || root == nil {
		return nil, false, errors.New("configuration must be a JSON object")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return nil, false, errors.New("configuration has trailing data")
	}
	values := map[string]string{}
	var walk func(any, []string) (any, error)
	walk = func(value any, path []string) (any, error) {
		switch v := value.(type) {
		case map[string]any:
			for key, child := range v {
				next, e := walk(child, append(append([]string(nil), path...), key))
				if e != nil {
					return nil, e
				}
				v[key] = next
			}
			return v, nil
		case []any:
			for i, child := range v {
				next, e := walk(child, append(append([]string(nil), path...), "[]"))
				if e != nil {
					return nil, e
				}
				v[i] = next
			}
			return v, nil
		case string:
			if !strings.Contains(v, secretPrefix) {
				return v, nil
			}
			if !strings.HasPrefix(v, secretPrefix) || len(path) != 4 || path[0] != "sinks" || path[2] != "auth" || (path[3] != "user" && path[3] != "password" && path[3] != "token") {
				return nil, errors.New("local secret references are allowed only in supported sink auth fields")
			}
			sinks, ok := root["sinks"].(map[string]any)
			if !ok {
				return nil, errors.New("invalid local secret reference")
			}
			sink, ok := sinks[path[1]].(map[string]any)
			if !ok {
				return nil, errors.New("invalid local secret reference")
			}
			typ, _ := sink["type"].(string)
			if typ != "http" && typ != "loki" && typ != "elasticsearch" {
				return nil, errors.New("local secret references are unsupported for this sink type")
			}
			name := strings.TrimPrefix(v, secretPrefix)
			if !secretName.MatchString(name) {
				return nil, errors.New("invalid local secret reference name")
			}
			used = true
			if cached, ok := values[name]; ok {
				return cached, nil
			}
			if len(values) >= 64 {
				return nil, errors.New("local secret reference limit exceeded")
			}
			file, ok := bindings[name]
			if !ok {
				return nil, &secretReferenceError{name, path[1], path[3], "SECRET_BINDING_MISSING", errors.New("a local secret reference has no host-operator binding")}
			}
			secret, e := readLocalSecret(file)
			if e != nil {
				return nil, &secretReferenceError{name, path[1], path[3], "SECRET_FILE_UNREADABLE", e}
			}
			// Full Vector interpolation runs after typed materialization. A local
			// credential must remain literal, never become another provider/env
			// reference or be changed by Vector's dollar escaping.
			if fullVector && (environmentVariable.MatchString(secret) || strings.Contains(secret, "${") || strings.Contains(secret, "$$") || strings.Contains(secret, "SECRET[")) {
				return nil, &secretReferenceError{name, path[1], path[3], "SECRET_VALUE_REJECTED", errors.New("local credential contains native interpolation syntax; use a native provider directly for that credential")}
			}
			values[name] = secret
			return secret, nil
		}
		return value, nil
	}
	if _, err = walk(root, nil); err != nil {
		return nil, false, err
	}
	if !used {
		return template, false, nil
	}
	effective, err = json.Marshal(root)
	if err != nil {
		return nil, false, errors.New("cannot render local secret references")
	}
	if len(effective) > MaxArtifact {
		return nil, false, errors.New("effective configuration exceeds artifact limit")
	}
	return effective, true, nil
}
func readLocalSecret(path string) (string, error) {
	if !filepath.IsAbs(path) || SafePath(path) != nil {
		return "", errors.New("local secret file must use a safe absolute path")
	}
	f, err := openPrivateFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", errors.New("local secret file does not exist: " + path)
		}
		return "", errors.New("local secret file must be private to the agent account; " + privateFileFix(path))
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, MaxSecret+1))
	if err != nil || len(b) > MaxSecret {
		return "", errors.New("local secret file cannot be read within the size limit")
	}
	if !utf8.Valid(b) || bytes.IndexByte(b, 0) >= 0 {
		return "", errors.New("local secret file must contain UTF-8 text without NUL")
	}
	value := string(b)
	if strings.HasSuffix(value, "\n") {
		value = strings.TrimSuffix(strings.TrimSuffix(value, "\n"), "\r")
	}
	if value == "" {
		return "", errors.New("local secret file is empty")
	}
	return value, nil
}
func validateSecretFiles(bindings map[string]string) error {
	if bindings == nil {
		return errors.New("secret bindings must be an explicit object; use {} to remove all bindings")
	}
	if len(bindings) > 64 {
		return errors.New("local secret binding limit exceeded")
	}
	for name, path := range bindings {
		if !secretName.MatchString(name) {
			return errors.New("invalid local secret binding name")
		}
		if !utf8.ValidString(path) || strings.ContainsRune(path, 0) || adoptionLocalPath(path) != nil {
			return errors.New("local secret file must use a valid UTF-8 absolute local path without NUL")
		}
		if _, err := readLocalSecret(path); err != nil {
			return err
		}
	}
	return nil
}
func ConfigureSecretFiles(dir string, bindings map[string]string) error {
	if err := validateSecretFiles(bindings); err != nil {
		return err
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
	s.SecretFiles = bindings
	return doc.save(s)
}
