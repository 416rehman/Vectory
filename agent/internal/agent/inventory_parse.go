package agent

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
)

// Parsers for what each operating system says about how a process was
// started. They only read bytes and text, so they run (and are tested) on
// every platform; the collectors that feed them are per platform.

// splitNUL splits a block of NUL-terminated strings, such as a process's
// command line or environment.
func splitNUL(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	parts := strings.Split(string(data), "\x00")
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}

// selectedEnvironment keeps, from NAME=VALUE entries, only the variables that
// select Vector's configuration. Windows treats names as case-insensitive.
func selectedEnvironment(entries []string, foldCase bool) map[string]string {
	wanted := map[string]bool{}
	for _, name := range configEnvironment() {
		wanted[name] = true
	}
	out := map[string]string{}
	for _, entry := range entries {
		name, value, ok := strings.Cut(entry, "=")
		if foldCase {
			name = strings.ToUpper(name)
		}
		if ok && wanted[name] {
			out[name] = value
		}
	}
	return out
}

// systemdUnitInfo is what systemctl show says about a unit.
type systemdUnitInfo struct {
	// ExecStart is the command's arguments, split at spaces: systemctl doesn't
	// quote them, so an argument that contains a space comes back in pieces.
	ExecStart        []string
	Environment      []string
	EnvironmentFiles []systemdEnvironmentFile
	WorkingDirectory string
	FragmentPath     string
}

type systemdEnvironmentFile struct {
	Path string
	// Optional: the unit starts without it when it's missing (a "-" prefix).
	Optional bool
}

// parseSystemdShow reads the KEY=VALUE lines of `systemctl show`.
func parseSystemdShow(output string) systemdUnitInfo {
	var info systemdUnitInfo
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(strings.TrimRight(line, "\r"), "=")
		if !ok {
			continue
		}
		switch key {
		case "ExecStart":
			if len(info.ExecStart) == 0 {
				info.ExecStart = parseExecStart(value)
			}
		case "Environment":
			info.Environment = append(info.Environment, splitAssignments(value)...)
		case "EnvironmentFiles":
			path, rest, _ := strings.Cut(value, " (ignore_errors=")
			if path != "" {
				info.EnvironmentFiles = append(info.EnvironmentFiles, systemdEnvironmentFile{Path: path, Optional: strings.HasPrefix(rest, "yes")})
			}
		case "WorkingDirectory":
			info.WorkingDirectory = strings.TrimPrefix(value, "!")
		case "FragmentPath":
			info.FragmentPath = value
		}
	}
	return info
}

// parseExecStart reads the arguments out of systemctl's rendering of a command:
// { path=/usr/bin/vector ; argv[]=/usr/bin/vector --config /etc/vector/v.yaml ; ignore_errors=no ; ... }
func parseExecStart(value string) []string {
	_, rest, ok := strings.Cut(value, "argv[]=")
	if !ok {
		return nil
	}
	if end := strings.Index(rest, " ; "); end >= 0 {
		rest = rest[:end]
	}
	return strings.Fields(strings.TrimSuffix(strings.TrimSpace(rest), "}"))
}

// splitAssignments splits systemd's Environment= value at unquoted spaces:
// A=1 "B=two words" C=3.
func splitAssignments(value string) []string {
	var out []string
	var current strings.Builder
	quoted, started := false, false
	flush := func() {
		if started {
			out = append(out, current.String())
		}
		current.Reset()
		started = false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c == '\\' && i+1 < len(value) && (value[i+1] == '"' || value[i+1] == '\\'):
			i++
			current.WriteByte(value[i])
			started = true
		case c == '"':
			quoted, started = !quoted, true
		case (c == ' ' || c == '\t') && !quoted:
			flush()
		default:
			current.WriteByte(c)
			started = true
		}
	}
	flush()
	return out
}

// parseEnvironmentFile reads the NAME=VALUE lines of a systemd EnvironmentFile.
func parseEnvironmentFile(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		out = append(out, strings.TrimSpace(name)+"="+value)
	}
	return out
}

// parseProcArgs2 reads what macOS returns for the kern.procargs2 request: the
// argument count, the executable's path, the arguments and the environment.
func parseProcArgs2(data []byte) (path string, args, environment []string, err error) {
	if len(data) < 4 {
		return "", nil, nil, errors.New("the process arguments are too short")
	}
	argc := int(binary.LittleEndian.Uint32(data))
	rest := data[4:]
	end := bytes.IndexByte(rest, 0)
	if end < 0 {
		return "", nil, nil, errors.New("the process arguments have no executable path")
	}
	path, rest = string(rest[:end]), bytes.TrimLeft(rest[end:], "\x00")
	if argc < 0 || argc > 1<<16 {
		return "", nil, nil, errors.New("the process arguments have an impossible count")
	}
	for i := 0; i < argc && len(rest) > 0; i++ {
		end := bytes.IndexByte(rest, 0)
		if end < 0 {
			args, rest = append(args, string(rest)), nil
			break
		}
		args, rest = append(args, string(rest[:end])), rest[end+1:]
	}
	for len(rest) > 0 {
		end := bytes.IndexByte(rest, 0)
		if end == 0 {
			break
		}
		if end < 0 {
			environment = append(environment, string(rest))
			break
		}
		environment, rest = append(environment, string(rest[:end])), rest[end+1:]
	}
	return path, args, environment, nil
}

// plistJob is the part of a launchd property list that says how a job starts.
type plistJob struct {
	Label                string
	Program              string
	ProgramArguments     []string
	WorkingDirectory     string
	EnvironmentVariables map[string]string
}

// Command is the job's argument vector.
func (j plistJob) Command() []string {
	if len(j.ProgramArguments) > 0 {
		return j.ProgramArguments
	}
	if j.Program != "" {
		return []string{j.Program}
	}
	return nil
}

// parsePlist reads an XML property list. A binary one is converted first
// (plutil -convert xml1 -o -).
func parsePlist(data []byte) (plistJob, error) {
	if bytes.HasPrefix(data, []byte("bplist")) {
		return plistJob{}, errors.New("the property list is in binary form")
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = false
	if start, err := nextPlistStart(decoder); err != nil || start.Name.Local != "plist" {
		return plistJob{}, errors.New("the property list has no plist element")
	}
	start, err := nextPlistStart(decoder)
	if err != nil {
		return plistJob{}, errors.New("the property list has no dictionary")
	}
	value, err := plistValue(decoder, start)
	if err != nil {
		return plistJob{}, err
	}
	root, ok := value.(map[string]any)
	if !ok {
		return plistJob{}, errors.New("the property list isn't a dictionary")
	}
	var job plistJob
	job.Label, _ = root["Label"].(string)
	job.Program, _ = root["Program"].(string)
	job.WorkingDirectory, _ = root["WorkingDirectory"].(string)
	if list, ok := root["ProgramArguments"].([]any); ok {
		for _, item := range list {
			if text, ok := item.(string); ok {
				job.ProgramArguments = append(job.ProgramArguments, text)
			}
		}
	}
	if variables, ok := root["EnvironmentVariables"].(map[string]any); ok {
		job.EnvironmentVariables = map[string]string{}
		for name, item := range variables {
			if text, ok := item.(string); ok {
				job.EnvironmentVariables[name] = text
			}
		}
	}
	return job, nil
}

// nextPlistStart returns the next opening tag.
func nextPlistStart(decoder *xml.Decoder) (xml.StartElement, error) {
	for {
		token, err := decoder.Token()
		if err != nil {
			return xml.StartElement{}, err
		}
		if start, ok := token.(xml.StartElement); ok {
			return start, nil
		}
	}
}

// plistValue reads the element that start opened, and what is inside it:
// dictionaries become maps, arrays slices, true and false booleans, and every
// other scalar its text.
func plistValue(decoder *xml.Decoder, start xml.StartElement) (any, error) {
	switch start.Name.Local {
	case "dict":
		out := map[string]any{}
		for {
			token, err := decoder.Token()
			if err != nil {
				return nil, fmt.Errorf("the property list ended early: %w", err)
			}
			switch element := token.(type) {
			case xml.StartElement:
				if element.Name.Local != "key" {
					return nil, fmt.Errorf("the property list has %s where a key belongs", element.Name.Local)
				}
				var key string
				if err := decoder.DecodeElement(&key, &element); err != nil {
					return nil, err
				}
				valueStart, err := nextPlistStart(decoder)
				if err != nil {
					return nil, fmt.Errorf("the property list ended early: %w", err)
				}
				if out[key], err = plistValue(decoder, valueStart); err != nil {
					return nil, err
				}
			case xml.EndElement:
				return out, nil
			}
		}
	case "array":
		out := []any{}
		for {
			token, err := decoder.Token()
			if err != nil {
				return nil, fmt.Errorf("the property list ended early: %w", err)
			}
			switch element := token.(type) {
			case xml.StartElement:
				item, err := plistValue(decoder, element)
				if err != nil {
					return nil, err
				}
				out = append(out, item)
			case xml.EndElement:
				return out, nil
			}
		}
	case "true", "false":
		if err := decoder.Skip(); err != nil {
			return nil, err
		}
		return start.Name.Local == "true", nil
	}
	var text string
	if err := decoder.DecodeElement(&text, &start); err != nil {
		return nil, err
	}
	return text, nil
}

// splitWindowsCommandLine splits a Windows command line into arguments by the
// rules CommandLineToArgvW documents: the first argument ends at the first
// space, or at the closing quote when it starts with one; then 2n backslashes
// before a quote make n backslashes and toggle quoting, and 2n+1 make n
// backslashes and a literal quote.
func splitWindowsCommandLine(line string) []string {
	blank := func(c byte) bool { return c == ' ' || c == '\t' }
	var args []string
	i, n := 0, len(line)
	for i < n && blank(line[i]) {
		i++
	}
	if i >= n {
		return nil
	}
	if line[i] == '"' {
		end := strings.IndexByte(line[i+1:], '"')
		if end < 0 {
			return []string{line[i+1:]}
		}
		args = append(args, line[i+1:i+1+end])
		i += end + 2
	} else {
		start := i
		for i < n && !blank(line[i]) {
			i++
		}
		args = append(args, line[start:i])
	}
	for {
		for i < n && blank(line[i]) {
			i++
		}
		if i >= n {
			return args
		}
		var arg strings.Builder
		quoted := false
	argument:
		for i < n {
			c := line[i]
			switch {
			case c == '\\':
				run := i
				for run < n && line[run] == '\\' {
					run++
				}
				count := run - i
				if run < n && line[run] == '"' {
					arg.WriteString(strings.Repeat(`\`, count/2))
					if count%2 == 1 {
						arg.WriteByte('"')
						run++
					}
				} else {
					arg.WriteString(strings.Repeat(`\`, count))
				}
				i = run
			case c == '"':
				if quoted && i+1 < n && line[i+1] == '"' {
					arg.WriteByte('"')
					i += 2
				} else {
					quoted = !quoted
					i++
				}
			case blank(c) && !quoted:
				break argument
			default:
				arg.WriteByte(c)
				i++
			}
		}
		args = append(args, arg.String())
	}
}

// escapeWindowsArgument writes an argument the way a Windows command line holds
// it, so CommandLineToArgvW reads it back: quoted only when it is empty or has a
// space, tab or quote, with the backslashes before a quote doubled.
func escapeWindowsArgument(s string) string {
	if s == "" {
		return `""`
	}
	if !strings.ContainsAny(s, " \t\"") {
		return s
	}
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\\':
			slashes++
			b.WriteByte(c)
		case '"':
			b.WriteString(strings.Repeat(`\`, slashes+1))
			b.WriteByte('"')
			slashes = 0
		default:
			slashes = 0
			b.WriteByte(c)
		}
	}
	b.WriteString(strings.Repeat(`\`, slashes))
	b.WriteByte('"')
	return b.String()
}

// parseImagePath reads a Windows service's ImagePath: a command line, whose
// executable may be unquoted although its folder has spaces ("C:\Program
// Files\Vector\bin\vector.exe --config ..."), which Windows accepts.
func parseImagePath(image string) []string {
	image = strings.TrimSpace(image)
	if image == "" || image[0] == '"' {
		return splitWindowsCommandLine(image)
	}
	lower := strings.ToLower(image)
	for offset := 0; ; {
		at := strings.Index(lower[offset:], ".exe")
		if at < 0 {
			break
		}
		end := offset + at + len(".exe")
		if end == len(image) || image[end] == ' ' || image[end] == '\t' {
			return append([]string{image[:end]}, splitWindowsCommandLine("x " + image[end:])[1:]...)
		}
		offset = end
	}
	return splitWindowsCommandLine(image)
}

// parseWindowsEnvironment splits a UTF-16 environment block (NAME=VALUE,
// each ended by a NUL, the block by an empty entry) read from a process.
func parseWindowsEnvironment(block []uint16) []string {
	var out []string
	start := 0
	for i, unit := range block {
		if unit != 0 {
			continue
		}
		if i == start {
			break
		}
		out = append(out, string(utf16.Decode(block[start:i])))
		start = i + 1
	}
	return out
}
