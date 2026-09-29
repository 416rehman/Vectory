package agent

import (
	"bytes"
	"encoding/json"
	"errors"
)

// ReadSecretBindings is the shared operator-input boundary for install and
// configure-secrets. It never normalizes ambiguous JSON into another intent.
// The returned nonnil empty map deliberately removes all existing bindings.
func ReadSecretBindings(path string) (*map[string]string, error) {
	invalidObject := errors.New("secret bindings must be a bounded regular local UTF-8 JSON object without duplicate keys or trailing data; use {} to remove all bindings")
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
