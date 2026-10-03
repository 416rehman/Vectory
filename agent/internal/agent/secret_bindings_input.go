package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// ReadSecretBindings is the shared operator-input boundary for install and
// configure-secrets. It never normalizes ambiguous JSON into another intent.
// The returned nonnil empty map deliberately removes all existing bindings.
// A path that can't be what the operator meant says which it is; what a file
// holds is never echoed, because the bindings point at secrets.
func ReadSecretBindings(path string) (*map[string]string, error) {
	if !filepath.IsAbs(path) {
		return nil, inputError("--secret-files " + safeText(path, 120) + " isn't an absolute path: give the whole path of the JSON file, such as /etc/vectory/secret-bindings.json")
	}
	if _, err := os.Lstat(path); err != nil {
		reason := err.Error()
		var pathError *os.PathError
		if errors.As(err, &pathError) {
			reason = pathError.Err.Error()
		}
		return nil, errors.New(safeText(path, 120) + " can't be read: " + safeText(reason, 120))
	}
	invalidObject := errors.New(`secret bindings must be a bounded regular local UTF-8 JSON object without duplicate keys or trailing data, such as {"DB_PASSWORD": "/etc/vectory/db-password"}; use {} to remove all bindings`)
	raw, err := readOperatorJSON(path)
	if err != nil {
		return nil, invalidObject
	}
	fields, err := adoptionObject(raw)
	if err != nil {
		return nil, invalidObject
	}
	bindings := make(map[string]string, len(fields))
	for name, value := range fields {
		value = bytes.TrimSpace(value)
		var path string
		if len(value) == 0 || value[0] != '"' || !pairedJSONSurrogates(value) || json.Unmarshal(value, &path) != nil {
			return nil, errors.New("secret bindings must map names to path strings with valid Unicode; null and other value types are not allowed")
		}
		bindings[name] = path
	}
	if err = validateSecretFiles(bindings); err != nil {
		return nil, err
	}
	return &bindings, nil
}
