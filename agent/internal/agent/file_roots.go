package agent

import (
	"errors"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// A file root is a directory restricted pipelines may read and write under. A
// root that covers what the agent keeps private would hand it to every
// publisher: the state directory holds the device's key and settings, the
// managed configuration directory holds rendered pipelines with their resolved
// device secrets, a bound secret file holds a secret's value, and the root of a
// file system holds everything. `vectory allow`, `install` and `setup` refuse
// such a root, with the paths compared the way the host's file system compares
// them.

// pathStyle is how a file system spells and compares paths: Windows has drive
// letters, UNC shares and backslashes, and Windows and macOS usually treat names
// that differ only in case as the same file. The rules take a style, so one test
// binary checks all three.
type pathStyle struct {
	windows  bool
	foldCase bool
}

var (
	posixPaths   = pathStyle{}
	macPaths     = pathStyle{foldCase: true}
	windowsPaths = pathStyle{windows: true, foldCase: true}
)

// hostPathStyle is the style of the operating system the agent runs on.
func hostPathStyle() pathStyle {
	switch runtime.GOOS {
	case "windows":
		return windowsPaths
	case "darwin":
		return macPaths
	}
	return posixPaths
}

// absolutePath is a path read in a style: where it starts (the empty volume
// for POSIX, `C:` or `\\server\share` for Windows) and the names below that.
type absolutePath struct {
	volume   string
	share    bool // the volume is a UNC share
	segments []string
}

func asciiLetter(b byte) bool { return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' }

// parse reads an absolute path lexically. `.` and `..` are resolved (never
// above the root), repeated separators collapse, and on Windows both separators,
// the `\\?\` and `\\.\` prefixes and the trailing dots and spaces that Win32
// drops from a name are understood. ok is false for a path that isn't absolute
// in this style, such as `C:logs` or a device path other than a drive or share.
func (s pathStyle) parse(path string) (absolutePath, bool) {
	var parsed absolutePath
	rest := path
	separator := "/"
	if s.windows {
		separator = `\`
		rest = strings.ReplaceAll(path, "/", `\`)
		for _, prefix := range []string{`\\?\`, `\\.\`} {
			if strings.HasPrefix(rest, prefix) {
				rest = rest[len(prefix):]
				if len(rest) >= 4 && strings.EqualFold(rest[:4], `UNC\`) {
					rest = `\\` + rest[4:]
				}
				break
			}
		}
		switch {
		case len(rest) >= 3 && asciiLetter(rest[0]) && rest[1] == ':' && rest[2] == '\\':
			parsed.volume, rest = strings.ToUpper(rest[:2]), rest[3:]
		case strings.HasPrefix(rest, `\\`) && !strings.HasPrefix(rest, `\\\`):
			names := strings.SplitN(rest[2:], `\`, 3)
			if len(names) < 2 || names[0] == "" || names[1] == "" {
				return absolutePath{}, false
			}
			parsed.volume, parsed.share = strings.ToLower(`\\`+names[0]+`\`+names[1]), true
			rest = ""
			if len(names) == 3 {
				rest = names[2]
			}
		default:
			return absolutePath{}, false
		}
	} else if !strings.HasPrefix(rest, "/") {
		return absolutePath{}, false
	}
	for _, name := range strings.Split(rest, separator) {
		if s.windows {
			if name != ".." {
				name = strings.TrimRight(name, ". ")
			}
		}
		switch name {
		case "", ".":
		case "..":
			if len(parsed.segments) > 0 {
				parsed.segments = parsed.segments[:len(parsed.segments)-1]
			}
		default:
			parsed.segments = append(parsed.segments, name)
		}
	}
	return parsed, true
}

// same compares two names the way the file system does.
func (s pathStyle) same(a, b string) bool {
	if s.foldCase {
		return strings.EqualFold(a, b)
	}
	return a == b
}

type pathRelation int

const (
	relationNone pathRelation = iota
	relationSame
	relationContains // the first path holds the second
	relationInside   // the first path lies in the second
)

// relation says how a lies against b: the same place, above it, below it, or
// neither.
func (s pathStyle) relation(a, b absolutePath) pathRelation {
	if a.volume != b.volume {
		return relationNone
	}
	for i := 0; i < len(a.segments) && i < len(b.segments); i++ {
		if !s.same(a.segments[i], b.segments[i]) {
			return relationNone
		}
	}
	switch {
	case len(a.segments) == len(b.segments):
		return relationSame
	case len(a.segments) < len(b.segments):
		return relationContains
	}
	return relationInside
}

// protectedPath is something a file root may not cover, and the forms in which
// the host knows it: as written and with links followed.
type protectedPath struct {
	what  string   // "the agent's state directory"
	path  string   // as the settings or the operator wrote it
	forms []string // the spellings to compare; empty means path alone
	file  bool     // a file: a root may be it or hold it, and nothing lies below it
}

// exampleRoot is a directory in this style, offered as what to allow instead.
func (s pathStyle) exampleRoot() string {
	if s.windows {
		return `C:\Logs\app`
	}
	return "/var/log/app"
}

const rootAdvice = "Allow the directory that holds the files pipelines need, such as "

// fileRootProblem says why root can't be an allowed file root, in words an
// operator can act on, or "" when it can. It compares the root as written with
// each protected path as written.
func fileRootProblem(s pathStyle, root string, protected []protectedPath) string {
	return fileRootFormsProblem(s, root, []string{root}, protected)
}

// fileRootFormsProblem is fileRootProblem for a root the host knows in several
// spellings (rootForms, which include the root as written): every spelling is
// compared with every spelling of each protected path, and the root is named as
// the operator wrote it.
func fileRootFormsProblem(s pathStyle, root string, rootForms []string, protected []protectedPath) string {
	advice := rootAdvice + s.exampleRoot() + "."
	for _, form := range rootForms {
		parsed, ok := s.parse(form)
		if !ok {
			if form == root {
				return "File root " + root + " isn't an absolute path. " + advice
			}
			continue
		}
		if len(parsed.segments) == 0 {
			what := "the filesystem root"
			if s.windows {
				what = "the root of a drive"
				if parsed.share {
					what = "the root of a network share"
				}
			}
			return "File root " + root + " is " + what + ", so pipelines could read and write every file on it. " + advice
		}
	}
	for _, p := range protected {
		known := p.forms
		if len(known) == 0 {
			known = []string{p.path}
		}
		for _, spelling := range known {
			against, ok := s.parse(spelling)
			if !ok {
				continue
			}
			for _, form := range rootForms {
				parsed, ok := s.parse(form)
				if !ok {
					continue
				}
				relation := s.relation(parsed, against)
				if p.file && relation == relationInside {
					continue
				}
				if relation == relationNone {
					continue
				}
				return overlapProblem(root, relation, p) + " " + advice
			}
		}
	}
	return ""
}

func overlapProblem(root string, relation pathRelation, p protectedPath) string {
	var sentence string
	switch relation {
	case relationSame:
		sentence = "File root " + root + " is " + p.what + "."
	case relationContains:
		sentence = "File root " + root + " contains " + p.what + ", " + p.path + "."
	default:
		sentence = "File root " + root + " lies inside " + p.what + ", " + p.path + "."
	}
	switch {
	case p.file:
		return sentence + " The file holds a device secret's value, so no pipeline may read it."
	case strings.Contains(p.what, "state directory"):
		return sentence + " It holds this host's identity key and settings, so no pipeline may read or write there."
	}
	return sentence + " It holds the rendered pipelines, which carry resolved device secrets, so no pipeline may read or write there."
}

// resolveExisting follows links and settles the case of the part of path that
// exists, and keeps the rest as typed: a root can be named before it is created.
func resolveExisting(path string) string {
	clean := filepath.Clean(path)
	rest := ""
	for p := clean; ; {
		if resolved, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Join(resolved, rest)
		}
		parent := filepath.Dir(p)
		if parent == p {
			return clean
		}
		rest = filepath.Join(filepath.Base(p), rest)
		p = parent
	}
}

// hostForms are the spellings the host knows a path by: as written, and with
// links followed, so a root named through a link is judged by where it leads.
func hostForms(path string) []string {
	forms := []string{path}
	if resolved := resolveExisting(path); resolved != path {
		forms = append(forms, resolved)
	}
	return forms
}

// checkFileRoots refuses the first root that is a filesystem or volume root, or
// that is, contains or lies inside the agent's state directory, the managed
// configuration directory or a file bound to a device secret. Paths that aren't
// absolute (a settings file written by hand) can't be compared and are left out.
func checkFileRoots(roots []string, stateDir, managedConfig string, secretFiles map[string]string) error {
	if len(roots) == 0 {
		return nil
	}
	var protected []protectedPath
	add := func(what, path string, file bool) {
		if path != "" && filepath.IsAbs(path) {
			protected = append(protected, protectedPath{what: what, path: path, forms: hostForms(path), file: file})
		}
	}
	add("the agent's state directory", stateDir, false)
	if managedConfig != "" && filepath.IsAbs(managedConfig) {
		add("the managed configuration directory", filepath.Dir(managedConfig), false)
	}
	names := make([]string, 0, len(secretFiles))
	for name := range secretFiles {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		add(`the file bound to secret "`+name+`"`, secretFiles[name], true)
	}
	style := hostPathStyle()
	for _, root := range roots {
		if problem := fileRootFormsProblem(style, root, hostForms(root), protected); problem != "" {
			return errors.New(problem)
		}
	}
	return nil
}
