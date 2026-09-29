package agent

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"unicode/utf8"
)

// readOperatorJSON reads newly supplied local input, never saved settings/state.
// Callers retain their own object, duplicate-key, type and value requirements.
func readOperatorJSON(path string) ([]byte, error) {
	invalid := errors.New("operator input must be a bounded regular local UTF-8 JSON file")
	if err := regularPath(path); err != nil {
		return nil, invalid
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, invalid
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, invalid
	}
	raw, err := io.ReadAll(io.LimitReader(f, 2*MaxArtifact+1))
	// Raw UTF-8 is checked before any decoder can substitute U+FFFD. Establish
	// JSON syntax before callers inspect Unicode escapes or decode fields.
	if err != nil || len(raw) > 2*MaxArtifact || !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, invalid
	}
	return raw, nil
}

// JSON syntax has already been checked. This works on a complete document or
// one string token: valid JSON permits backslash escapes only within strings.
// Reject lone UTF-16 surrogates instead of silently replacing them with U+FFFD.
func pairedJSONSurrogates(value []byte) bool {
	for i := 0; i < len(value); i++ {
		if value[i] != '\\' {
			continue
		}
		i++
		if i >= len(value) || value[i] != 'u' {
			continue
		}
		if i+4 >= len(value) {
			return false
		}
		code, err := strconv.ParseUint(string(value[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if code >= 0xdc00 && code <= 0xdfff {
			return false
		}
		if code < 0xd800 || code > 0xdbff {
			continue
		}
		if i+6 >= len(value) || value[i+1] != '\\' || value[i+2] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(value[i+3:i+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}
