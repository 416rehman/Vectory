package agent

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Paths is the single set of default locations shared by the CLI, setup, the
// packaged service definitions and the documentation. The state directory and
// the managed configuration are always separate trees: purging state never
// deletes the managed workload, and the agent server's own data directory
// (/var/lib/vectory) never collides with a co-located agent.
type Paths struct {
	StateDir      string `json:"state_dir"`
	ManagedConfig string `json:"managed_config"`
	Binary        string `json:"binary"`
	ServiceUser   string `json:"service_user"`
}

// DefaultPaths returns the defaults for the running operating system.
func DefaultPaths() Paths {
	return defaultPathsFor(runtime.GOOS, os.Getenv("ProgramData"), os.Getenv("ProgramFiles"))
}

func defaultPathsFor(goos, programData, programFiles string) Paths {
	switch goos {
	case "windows":
		if programData == "" {
			programData = `C:\ProgramData`
		}
		if programFiles == "" {
			programFiles = `C:\Program Files`
		}
		base := strings.TrimRight(programData, `\/`) + `\Vectory`
		return Paths{
			StateDir:      base + `\agent`,
			ManagedConfig: base + `\managed\vector.json`,
			Binary:        strings.TrimRight(programFiles, `\/`) + `\Vectory\vectory.exe`,
			ServiceUser:   `NT SERVICE\Vectory`,
		}
	case "darwin":
		return Paths{
			StateDir:      "/Library/Application Support/Vectory/agent",
			ManagedConfig: "/Library/Application Support/Vectory/managed/vector.json",
			Binary:        "/usr/local/bin/vectory",
			ServiceUser:   "_vectory",
		}
	default:
		return Paths{
			StateDir:      "/var/lib/vectory-agent",
			ManagedConfig: "/etc/vectory/managed/vector.json",
			Binary:        "/usr/local/bin/vectory",
			ServiceUser:   "vectory",
		}
	}
}

// legacyStateDirs are the default state directories of earlier development
// builds. Status and setup point at them instead of silently creating a second
// installation next to (or inside) an existing one.
func legacyStateDirs(goos, programData string) []string {
	switch goos {
	case "windows":
		if programData == "" {
			programData = `C:\ProgramData`
		}
		return []string{strings.TrimRight(programData, `\/`) + `\Vectory`}
	case "darwin":
		return []string{"/Library/Application Support/Vectory"}
	default:
		return []string{"/var/lib/vectory"}
	}
}

// LegacyInstallation returns an earlier default state directory that holds an
// installed agent, or "" when there is none. Only a regular settings.json
// counts: the server's own data directory never contains one.
func LegacyInstallation() string {
	for _, dir := range legacyStateDirs(runtime.GOOS, os.Getenv("ProgramData")) {
		info, err := os.Lstat(filepath.Join(dir, "settings.json"))
		if err == nil && info.Mode().IsRegular() {
			return dir
		}
	}
	return ""
}

// Installed reports whether dir holds an installed agent.
func Installed(dir string) bool {
	info, err := os.Lstat(filepath.Join(dir, "settings.json"))
	return err == nil && info.Mode().IsRegular()
}

// ResolvedPath is an operator-supplied path made absolute, with symbolic links
// among its existing components resolved.
type ResolvedPath struct {
	Given    string
	Path     string
	Resolved bool // a symbolic link was followed
}

// ResolveOperatorPath makes an operator-supplied path absolute and resolves
// symbolic links in its existing components once, so the strict checks that
// follow (which refuse any link) see the real location, such as /private/var
// on macOS. A link is followed only when it is owned by root or by this
// account; a link another account could have planted is refused. Components
// that do not exist yet are kept as typed.
func ResolveOperatorPath(path string) (ResolvedPath, error) {
	return resolveOperatorPath(path, false)
}

// ResolveExecutablePath resolves an executable path, following links owned by
// any account (for example Homebrew's /opt/homebrew/bin/vector). This is safe
// for executables only because adoption pins the resolved file's SHA-256 and
// checks it before every run.
func ResolveExecutablePath(path string) (ResolvedPath, error) {
	return resolveOperatorPath(path, true)
}

func resolveOperatorPath(path string, anyOwner bool) (ResolvedPath, error) {
	if strings.TrimSpace(path) == "" || strings.ContainsRune(path, 0) {
		return ResolvedPath{Given: path}, errors.New("path is empty")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return ResolvedPath{Given: path}, err
	}
	resolved, followed, err := resolveLinks(absolute, anyOwner)
	if err != nil {
		return ResolvedPath{Given: path, Path: absolute}, err
	}
	return ResolvedPath{Given: path, Path: resolved, Resolved: followed}, nil
}
