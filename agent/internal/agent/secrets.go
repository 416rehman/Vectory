package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const secretPrefix = "vectory-secret:"
const MaxSecret = 16 * 1024

// maxSecretNames bounds the distinct names one configuration may reference and
// the bindings one host may hold.
const maxSecretNames = 64

var secretName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

// secretStep is one step of a configuration path: an object field, or a list
// item (item is true and key is empty). Keeping the two apart means an object
// field literally named "[]" is never taken for a list item.
type secretStep struct {
	key  string
	item bool
}

// secretFields holds the agent's own table (secret_fields_generated.go),
// indexed by "section/type". The server never chooses these fields.
var secretFields = func() map[string][][]secretStep {
	fields := map[string][][]secretStep{}
	for _, row := range secretFieldTable {
		key := row[0] + "/" + row[1]
		fields[key] = append(fields[key], parseSecretField(row[2]))
	}
	return fields
}()

// parseSecretField reads the table's path syntax: "a.b" for fields, a "[]"
// suffix for list items and "*" for any map key.
func parseSecretField(path string) []secretStep {
	var steps []secretStep
	for _, field := range strings.Split(path, ".") {
		items := 0
		for strings.HasSuffix(field, "[]") {
			field = strings.TrimSuffix(field, "[]")
			items++
		}
		steps = append(steps, secretStep{key: field})
		for ; items > 0; items-- {
			steps = append(steps, secretStep{item: true})
		}
	}
	return steps
}

// secretFieldMatches reports whether a concrete path within a component is one
// of the table's fields for that component's section and type.
func secretFieldMatches(section, typ string, path []secretStep) bool {
	for _, field := range secretFields[section+"/"+typ] {
		if len(field) != len(path) {
			continue
		}
		matched := true
		for i, want := range field {
			got := path[i]
			switch {
			case want.item:
				matched = got.item
			case want.key == "*":
				matched = !got.item
			default:
				matched = !got.item && got.key == want.key
			}
			if !matched {
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// secretLocation names where a configuration value sits: its component, when
// it belongs to one, and the field inside it.
type secretLocation struct {
	section, kind, id, typ string
	field                  []secretStep
	inComponent            bool
}

// locateSecretField places a path from the configuration root.
func locateSecretField(root map[string]any, path []secretStep) secretLocation {
	if len(path) < 3 || path[0].item || path[1].item || componentKind(path[0].key) == "" {
		return secretLocation{field: path}
	}
	section := path[0].key
	components, _ := root[section].(map[string]any)
	component, ok := components[path[1].key].(map[string]any)
	if !ok {
		return secretLocation{field: path}
	}
	typ, _ := component["type"].(string)
	return secretLocation{section: section, kind: componentKind(section), id: path[1].key, typ: typ, field: path[2:], inComponent: true}
}

// credential reports whether the location is a device-secret field.
func (l secretLocation) credential() bool {
	return l.inComponent && l.typ != "" && secretFieldMatches(l.section, l.typ, l.field)
}

func countItems(steps []secretStep) int {
	n := 0
	for _, step := range steps {
		if step.item {
			n++
		}
	}
	return n
}

// fieldPath renders a field for people: "auth.token", "valid_tokens[1]".
func fieldPath(steps []secretStep, indexes []int) string {
	var b strings.Builder
	item := 0
	for _, step := range steps {
		if step.item {
			b.WriteString("[" + strconv.Itoa(indexes[item]) + "]")
			item++
			continue
		}
		if b.Len() > 0 {
			b.WriteByte('.')
		}
		b.WriteString(step.key)
	}
	return b.String()
}

// secretReferenceError says which typed reference failed, by name and
// location only. Values and file paths never leave the host.
type secretReferenceError struct {
	name, kind, id, field, code string
	err                         error
}

func (e *secretReferenceError) Error() string { return e.err.Error() }
func (e *secretReferenceError) Unwrap() error { return e.err }

// ResolveLocalSecrets only replaces complete typed JSON string leaves at the
// agent's own table of credential fields for each component type. It cannot
// interpolate text, alter structure or choose executables, providers or paths.
// Return values must never be logged or exported.
func ResolveLocalSecrets(template []byte, bindings map[string]string) (effective []byte, used bool, err error) {
	return resolveLocalSecrets(template, bindings, false)
}

func resolveLocalSecrets(template []byte, bindings map[string]string, fullVector bool) (effective []byte, used bool, err error) {
	effective, used, _, err = resolveSecretReferences(template, bindings, fullVector, false)
	return effective, used, err
}

// resolveSecretReferences is resolveLocalSecrets, and the one place references
// are resolved. With collect set it doesn't stop at the first reference it can't
// resolve: it walks the whole configuration (in a fixed order) and returns each
// one in problems, so a check can name every missing binding at once. Nothing
// is materialized then. Without collect, problems is nil and the first
// reference that fails is the error, as an apply reports it.
func resolveSecretReferences(template []byte, bindings map[string]string, fullVector, collect bool) (effective []byte, used bool, problems []*secretReferenceError, err error) {
	decoder := json.NewDecoder(bytes.NewReader(template))
	decoder.UseNumber()
	var root map[string]any
	if err = decoder.Decode(&root); err != nil || root == nil {
		return nil, false, nil, errors.New("configuration must be a JSON object")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return nil, false, nil, errors.New("configuration has trailing data")
	}
	values := map[string]string{}
	// unresolved holds the names that failed, in collect mode: a name is
	// reported once, at its first place.
	unresolved := map[string]bool{}
	// path holds the steps from the root; indexes the position of each list
	// item on it, for messages.
	var walk func(value any, path []secretStep, indexes []int) (any, error)
	walk = func(value any, path []secretStep, indexes []int) (any, error) {
		switch v := value.(type) {
		case map[string]any:
			for _, key := range sortedKeys(v) {
				next, e := walk(v[key], append(path[:len(path):len(path)], secretStep{key: key}), indexes)
				if e != nil {
					return nil, e
				}
				v[key] = next
			}
			return v, nil
		case []any:
			for i, child := range v {
				next, e := walk(child, append(path[:len(path):len(path)], secretStep{item: true}), append(indexes[:len(indexes):len(indexes)], i))
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
			at := locateSecretField(root, path)
			fieldIndexes := indexes[len(indexes)-countItems(at.field):]
			field := fieldPath(at.field, fieldIndexes)
			// fails is how a reference that can't be resolved ends the walk, or,
			// when collecting, is noted while the walk goes on.
			fails := func(ref *secretReferenceError) (any, error) {
				if !collect {
					return nil, ref
				}
				if ref.name != "" {
					unresolved[ref.name] = true
				}
				problems = append(problems, ref)
				return v, nil
			}
			refused := func(message string) (any, error) {
				return fails(&secretReferenceError{"", at.kind, at.id, field, "SECRET_REFERENCE_REFUSED", errors.New(message)})
			}
			if !at.credential() {
				where := field
				if at.inComponent {
					where = at.section + "." + at.id + "." + field
				}
				return refused("local secret references are allowed only in supported credential fields; " + where + " is not one")
			}
			name, whole := strings.CutPrefix(v, secretPrefix)
			if !whole {
				return refused("a local secret reference must be the whole value of " + field)
			}
			if !secretName.MatchString(name) {
				return refused("invalid local secret reference name in " + field)
			}
			used = true
			if cached, ok := values[name]; ok {
				return cached, nil
			}
			if unresolved[name] {
				return v, nil
			}
			if len(values)+len(unresolved) >= maxSecretNames {
				return nil, errors.New("local secret reference limit exceeded")
			}
			file, ok := bindings[name]
			if !ok {
				return fails(&secretReferenceError{name, at.kind, at.id, field, "SECRET_BINDING_MISSING", errors.New("a local secret reference has no host-operator binding")})
			}
			secret, e := readLocalSecret(file)
			if e != nil {
				return fails(&secretReferenceError{name, at.kind, at.id, field, "SECRET_FILE_UNREADABLE", e})
			}
			// Full Vector interpolation runs after typed materialization. A local
			// credential must remain literal, never become another provider/env
			// reference or be changed by Vector's dollar escaping.
			if fullVector && (environmentVariable.MatchString(secret) || strings.Contains(secret, "${") || strings.Contains(secret, "$$") || strings.Contains(secret, "SECRET[")) {
				return fails(&secretReferenceError{name, at.kind, at.id, field, "SECRET_VALUE_REJECTED", errors.New("local credential contains native interpolation syntax; use a native provider directly for that credential")})
			}
			values[name] = secret
			return secret, nil
		}
		return value, nil
	}
	if _, err = walk(root, nil, nil); err != nil {
		return nil, false, nil, err
	}
	if len(problems) > 0 {
		return nil, false, problems, problems[0]
	}
	if !used {
		return template, false, nil, nil
	}
	effective, err = json.Marshal(root)
	if err != nil {
		return nil, false, nil, errors.New("cannot render local secret references")
	}
	if len(effective) > MaxArtifact {
		return nil, false, nil, errors.New("effective configuration exceeds artifact limit")
	}
	return effective, true, nil, nil
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

// boundSecretNames lists the names this host binds, sorted and bounded: names
// only, never files or values. Heartbeats report them so the dashboard can say
// which secrets a device still needs before a version applies.
func boundSecretNames(bindings map[string]string) []string {
	names := make([]string, 0, len(bindings))
	for name := range bindings {
		if secretName.MatchString(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) > maxSecretNames {
		names = names[:maxSecretNames]
	}
	return names
}

func validateSecretFiles(bindings map[string]string) error {
	if bindings == nil {
		return errors.New("secret bindings must be an explicit object; use {} to remove all bindings")
	}
	if len(bindings) > maxSecretNames {
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
