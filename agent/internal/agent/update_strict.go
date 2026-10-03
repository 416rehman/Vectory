package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"unicode/utf8"
)

// The files of an update are strict JSON: one object with exactly the members
// the contract lists, each once, spelled exactly. encoding/json is lenient in
// three ways that matter when the writer is not trusted (a request and a health
// record are written by the service account and read by root): it keeps the last
// of two members with one name without a word, it matches a member to a field
// whatever the case, and it ignores what a struct doesn't name unless asked.
// decodeStrictJSON closes all three, then lets encoding/json check the types.

var jsonUnmarshalerType = reflect.TypeOf((*json.Unmarshaler)(nil)).Elem()

// decodeStrictJSON decodes data, which must be one JSON object and nothing
// else, into out, a pointer to a struct. Every exported field with a json tag is
// a member: it must be present unless the tag says omitempty, and no other
// member, however it is spelled, is accepted. Members of nested structs follow
// the same rule, except that a value whose type decodes itself (a json.Unmarshaler)
// is checked by that type.
func decodeStrictJSON(data []byte, out any) error {
	if !utf8.Valid(data) {
		return errors.New("isn't UTF-8 text")
	}
	target := reflect.TypeOf(out)
	if target == nil || target.Kind() != reflect.Pointer || target.Elem().Kind() != reflect.Struct {
		return errors.New("decodeStrictJSON needs a pointer to a struct")
	}
	walker := json.NewDecoder(bytes.NewReader(data))
	token, err := walker.Token()
	if err != nil {
		return err
	}
	if token != json.Delim('{') {
		return errors.New("isn't a JSON object")
	}
	if err := walkMembers(walker, target.Elem()); err != nil {
		return err
	}
	if _, err := walker.Token(); err != io.EOF {
		return errors.New("has data after the object")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(out)
}

// memberFields maps each member name of a struct to whether it is required.
func memberFields(t reflect.Type) map[string]bool {
	members := map[string]bool{}
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		if !field.IsExported() {
			continue
		}
		name, options, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "-" || name == "" {
			continue
		}
		members[name] = !strings.Contains(options, "omitempty")
	}
	return members
}

// walkMembers reads the members of an object whose opening brace was read, and
// its closing brace. t is the struct type that describes it.
func walkMembers(decoder *json.Decoder, t reflect.Type) error {
	members := memberFields(t)
	fields := map[string]reflect.Type{}
	for i := 0; i < t.NumField(); i++ {
		name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		if _, known := members[name]; known {
			fields[name] = t.Field(i).Type
		}
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		name, _ := token.(string)
		fieldType, known := fields[name]
		switch {
		case !known:
			return fmt.Errorf("has a member %q that this format doesn't have", name)
		case seen[name]:
			return fmt.Errorf("has the member %q twice", name)
		}
		seen[name] = true
		if err := walkValue(decoder, fieldType); err != nil {
			return err
		}
	}
	if _, err := decoder.Token(); err != nil { // the closing brace
		return err
	}
	for name, required := range members {
		if required && !seen[name] {
			return fmt.Errorf("lacks the member %q", name)
		}
	}
	return nil
}

// walkValue reads one value of the type t describes.
func walkValue(decoder *json.Decoder, t reflect.Type) error {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return nil
	}
	if reflect.PointerTo(t).Implements(jsonUnmarshalerType) || t.Implements(jsonUnmarshalerType) {
		return skipRest(decoder)
	}
	switch {
	case delim == '{' && t.Kind() == reflect.Struct:
		return walkMembers(decoder, t)
	case delim == '{' && t.Kind() == reflect.Map:
		seen := map[string]bool{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return err
			}
			name, _ := key.(string)
			if seen[name] {
				return fmt.Errorf("has the member %q twice", name)
			}
			seen[name] = true
			if err := walkValue(decoder, t.Elem()); err != nil {
				return err
			}
		}
		_, err := decoder.Token()
		return err
	case delim == '[' && (t.Kind() == reflect.Slice || t.Kind() == reflect.Array):
		for decoder.More() {
			if err := walkValue(decoder, t.Elem()); err != nil {
				return err
			}
		}
		_, err := decoder.Token()
		return err
	}
	return skipRest(decoder)
}

// skipRest reads to the end of the object or array whose opening delimiter was
// just read.
func skipRest(decoder *json.Decoder) error {
	for depth := 1; depth > 0; {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		if delim, ok := token.(json.Delim); ok {
			if delim == '{' || delim == '[' {
				depth++
			} else {
				depth--
			}
		}
	}
	return nil
}

// marshalLine encodes v as one line with no spaces and a final line feed, in the
// order of its fields, and leaves <, > and & as they are.
func marshalLine(v any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
