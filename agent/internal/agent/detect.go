package agent

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// PlatformInfo describes the host for setup and status output.
type PlatformInfo struct {
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	Distribution   string `json:"distribution,omitempty"`
	ServiceManager string `json:"service_manager,omitempty"`
}

// Summary is one line such as "linux/amd64 · Ubuntu 24.04 · systemd 255".
func (p PlatformInfo) Summary() string {
	parts := []string{p.OS + "/" + p.Arch}
	if p.Distribution != "" {
		parts = append(parts, p.Distribution)
	}
	if p.ServiceManager != "" {
		parts = append(parts, p.ServiceManager)
	}
	return strings.Join(parts, " · ")
}

// DetectPlatform reports the operating system, distribution and service manager.
func DetectPlatform(ctx context.Context) PlatformInfo {
	info := PlatformInfo{OS: runtime.GOOS, Arch: runtime.GOARCH}
	info.Distribution, info.ServiceManager = platformDetails(ctx)
	return info
}

// commandOutput runs a fixed local tool (never a shell) with a clean
// environment and returns up to max bytes of its output; failures yield "".
func commandOutput(ctx context.Context, max int, name string, args ...string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = cleanEnvironment()
	cmd.WaitDelay = time.Second
	out := &limitedWriter{max: max}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	if cmd.Run() != nil {
		return ""
	}
	return out.b.String()
}

// commandLine returns the first line of commandOutput.
func commandLine(ctx context.Context, name string, args ...string) string {
	line, _, _ := strings.Cut(commandOutput(ctx, 4096, name, args...), "\n")
	return strings.TrimSpace(line)
}

// VectorBinary is a Vector executable found on this host.
type VectorBinary struct {
	Path    string `json:"path"`
	Linked  string `json:"linked_from,omitempty"`
	Version string `json:"version,omitempty"`
	Problem string `json:"problem,omitempty"`
}

// vectorVersionLine captures the whole version token of `vector --version`,
// pre-release or build suffix included ("0.58.1-rc1"), so SupportedVectorVersion
// refuses what Vector's own startup record would later fail to match.
var vectorVersionLine = regexp.MustCompile(`^vector ([0-9]+\.[0-9]+\.[0-9]+\S*)(?:\s|$)`)

// InspectVector resolves a candidate path (following links, which is safe for
// executables because adoption pins the resolved file's SHA-256) and asks it
// for its version.
func InspectVector(ctx context.Context, path string) VectorBinary {
	resolved, err := ResolveExecutablePath(path)
	if err != nil {
		return VectorBinary{Path: path, Problem: err.Error()}
	}
	candidate := VectorBinary{Path: resolved.Path}
	if resolved.Resolved {
		candidate.Linked = path
	}
	info, err := os.Stat(resolved.Path)
	switch {
	case os.IsNotExist(err):
		candidate.Problem = "not found"
		return candidate
	case err != nil:
		candidate.Problem = "not readable"
		return candidate
	case !info.Mode().IsRegular():
		candidate.Problem = "not a regular file"
		return candidate
	case runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0:
		candidate.Problem = "not executable"
		return candidate
	}
	base := strings.ToLower(filepath.Base(resolved.Path))
	if base != "vector" && base != "vector.exe" {
		candidate.Problem = "not named vector"
		return candidate
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, resolved.Path, "--version")
	cmd.Env = cleanEnvironment()
	cmd.WaitDelay = time.Second
	out := &limitedWriter{max: 1024}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	if cmd.Run() != nil {
		candidate.Problem = "didn't run (vector --version failed)"
		return candidate
	}
	match := vectorVersionLine.FindStringSubmatch(strings.TrimSpace(out.b.String()))
	if match == nil {
		candidate.Problem = "didn't report a Vector version"
		return candidate
	}
	candidate.Version = match[1]
	if !SupportedVectorVersion(candidate.Version) {
		candidate.Problem = "this agent requires Vector " + VectorSeries
	}
	return candidate
}

// FindVector looks for Vector on PATH and in the usual package locations and
// returns the first supported one, plus everything inspected.
func FindVector(ctx context.Context) (*VectorBinary, []VectorBinary) {
	var candidates []string
	if path, err := exec.LookPath("vector"); err == nil {
		candidates = append(candidates, path)
	}
	candidates = append(candidates, vectorLocations()...)
	seen := map[string]bool{}
	var inspected []VectorBinary
	for _, path := range candidates {
		absolute, err := filepath.Abs(path)
		if err != nil || seen[absolute] {
			continue
		}
		seen[absolute] = true
		if _, err := os.Lstat(absolute); err != nil {
			continue
		}
		found := InspectVector(ctx, absolute)
		if seen[found.Path] && found.Path != absolute {
			continue
		}
		seen[found.Path] = true
		inspected = append(inspected, found)
		if found.Problem == "" {
			return &inspected[len(inspected)-1], inspected
		}
	}
	return nil, inspected
}

func vectorLocations() []string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		programFiles := os.Getenv("ProgramFiles")
		if programFiles == "" {
			programFiles = `C:\Program Files`
		}
		return []string{filepath.Join(programFiles, "Vector", "bin", "vector.exe")}
	case "darwin":
		locations := []string{"/opt/homebrew/bin/vector", "/usr/local/bin/vector"}
		for _, cellar := range []string{"/opt/homebrew/Cellar/vector", "/usr/local/Cellar/vector"} {
			matches, _ := filepath.Glob(filepath.Join(cellar, "*", "bin", "vector"))
			locations = append(locations, matches...)
		}
		if home != "" {
			locations = append(locations, filepath.Join(home, ".vector", "bin", "vector"))
		}
		return locations
	default:
		locations := []string{"/usr/bin/vector", "/usr/local/bin/vector", "/opt/vector/bin/vector", "/usr/local/vector/bin/vector", "/root/.vector/bin/vector"}
		if home != "" {
			locations = append(locations, filepath.Join(home, ".vector", "bin", "vector"))
		}
		return locations
	}
}

// vectorSubcommands run briefly and never host a pipeline, such as the
// validator's `vector validate` children.
var vectorSubcommands = map[string]bool{"validate": true, "test": true, "generate": true, "generate-schema": true, "list": true, "graph": true, "top": true, "tap": true, "vrl": true, "config": true, "convert-config": true, "openapi": true, "help": true}

// runsPipeline reports whether Vector arguments (after argv[0]) start a
// pipeline rather than a one-shot subcommand.
func runsPipeline(args []string) bool {
	for _, arg := range args {
		if arg == "--version" || arg == "-V" || arg == "--help" || arg == "-h" {
			return false
		}
		if !strings.HasPrefix(arg, "-") {
			return !vectorSubcommands[arg]
		}
	}
	return true
}

// RunningVector is a Vector process not supervised by a Vectory agent.
type RunningVector struct {
	PID     int    `json:"pid"`
	Binary  string `json:"binary,omitempty"`
	Service string `json:"service,omitempty"`
}

// Describe returns "vector.service (pid 812)" or "pid 812 (/usr/bin/vector)".
func (v RunningVector) Describe() string {
	switch {
	case v.Service != "":
		return v.Service + " (pid " + strconv.Itoa(v.PID) + ")"
	case v.Binary != "":
		return "pid " + strconv.Itoa(v.PID) + " (" + v.Binary + ")"
	default:
		return "pid " + strconv.Itoa(v.PID)
	}
}

// readOSRelease returns PRETTY_NAME from an os-release file.
func readOSRelease(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(io.LimitReader(f, 16384))
	for scanner.Scan() {
		if value, ok := strings.CutPrefix(scanner.Text(), "PRETTY_NAME="); ok {
			return safeText(strings.Trim(value, `"'`), 60)
		}
	}
	return ""
}
