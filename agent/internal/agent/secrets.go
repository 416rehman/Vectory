package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const secretPrefix = "vectory-secret:"
const MaxSecret = 16 * 1024

var secretName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

// ResolveLocalSecrets only replaces complete typed JSON string leaves at known
// authentication fields. It cannot interpolate text, alter structure or choose
// executable/providers/paths. Return values must never be logged or exported.
func ResolveLocalSecrets(template []byte, bindings map[string]string) (effective []byte, used bool, err error) {
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
				return nil, errors.New("a local secret reference has no host-operator binding")
			}
			secret, e := readLocalSecret(file)
			if e != nil {
				return nil, e
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
		return "", errors.New("local secret file must be available, private, unlinked and owned by the agent account or system administrator")
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
func ConfigureSecretFiles(dir string, bindings map[string]string) error {
	if len(bindings) > 64 {
		return errors.New("local secret binding limit exceeded")
	}
	for name, path := range bindings {
		if !secretName.MatchString(name) {
			return errors.New("invalid local secret binding name")
		}
		if _, err := readLocalSecret(path); err != nil {
			return err
		}
	}
	unlock, err := Lock(dir)
	if err != nil {
		return err
	}
	defer unlock()
	s, err := LoadSettings(dir)
	if err != nil {
		return err
	}
	s.SecretFiles = bindings
	return WriteJSON(filepath.Join(dir, "settings.json"), s)
}
