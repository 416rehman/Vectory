//go:build linux

package agent

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// The privileged step on Linux: two systemd units, a timer and the service it
// starts, and the service manager calls the step makes on the agent's own unit.
//
// A timer, not a file watch: every 30 seconds and at boot the step runs, finds its
// journal idle and no request, and exits in milliseconds. Polling needs no inotify
// semantics, survives any crash between runs, and gives the recovery run at boot
// the same entry point as every other. An update waits at most 30 seconds for it.

const (
	updateServiceUnit = "vectory-update.service"
	updateTimerUnit   = "vectory-update.timer"

	// maxUnitFile bounds the agent's unit as the step reads it.
	maxUnitFile = 64 * 1024
)

// linuxUpdateHost is updateHost on a Linux host with systemd.
type linuxUpdateHost struct {
	unixUpdateHost
	// unitDir is where the units are, /etc/systemd/system.
	unitDir string
	// dpkgList is the list of the files of the vectory package, when there is one.
	dpkgList string
	// systemctl runs the service manager's command, and systemdRunning says whether
	// systemd is the running service manager. The tests that don't run on a host
	// with systemd replace them.
	systemctl      func(ctx context.Context, args ...string) ([]byte, error)
	systemdRunning func() bool
}

func newLinuxUpdateHost() *linuxUpdateHost {
	return &linuxUpdateHost{
		unitDir: "/etc/systemd/system", dpkgList: "/var/lib/dpkg/info/vectory.list",
		systemctl: runSystemctl, systemdRunning: SystemdAvailable,
	}
}

// platformUpdateHost is the host of this platform. A Linux host without systemd
// (OpenRC, a container) has a host too: it says NO_SERVICE, which is the truth,
// where PLATFORM_NOT_IN_RELEASE would say the operating system isn't supported.
func platformUpdateHost() updateHost { return newLinuxUpdateHost() }

var _ updateHost = (*linuxUpdateHost)(nil)

// ---------------------------------------------------------------- the step's units

// updateUnitValue is a value the step's units name (a path, an argument), refused
// when it holds a control character, a line or paragraph separator, a dollar sign
// or isn't text: it is written inside quotes by unitArg, and a value that could end
// the line or the quotes is never written. A dollar sign is refused because
// ExecStart= reads it as the start of a variable and the lists of paths read it as
// itself, so one escape can't be right in both.
func updateUnitValue(what, value string) (string, error) {
	if value == "" || !utf8.ValidString(value) {
		return "", fmt.Errorf("%s isn't text a unit file can hold", what)
	}
	for _, r := range value {
		switch {
		case unicode.IsControl(r) || r == ' ' || r == ' ':
			return "", fmt.Errorf("%s holds a control character, so it isn't written into a unit file", what)
		case r == '$':
			return "", fmt.Errorf("%s holds a dollar sign, which a unit file reads differently in different settings, so it isn't written into one", what)
		}
	}
	return unitArg(value), nil
}

// systemdUpdateUnits makes the text of the step's two units. The service runs as
// root with a clean environment (no Environment=, and the step passes
// cleanEnvironment to every process it starts) and the sandbox of the design:
//
//   - ProtectSystem=strict makes the whole file system read-only for it, and
//     ReadWritePaths names the three places it writes: the directory that holds the
//     agent's executable (what --install-dir chose), its own directory, and the
//     policy directory, for the pins that follow a rollover. A strict file system
//     with the install directory writable is what lets the sandbox and the swap
//     coexist: an install directory under /usr would be read-only otherwise, and
//     every update would end READ_ONLY.
//   - It does no network I/O: AF_UNIX is all it may open, and systemctl reaches the
//     service manager over one.
//   - CapabilityBoundingSet is the four capabilities the step uses, each for one
//     thing. It runs the probe as the service account (CAP_SETUID, CAP_SETGID),
//     reads that account's private directory and the files in it, which the account
//     owns and closes to everyone else (CAP_DAC_OVERRIDE), and ends a probe that
//     doesn't answer in ten seconds (CAP_KILL: a process may signal another
//     account's process only with it, and the probe is the service account's).
//     It has no CAP_CHOWN and no CAP_FOWNER. Everything it makes, root makes and
//     keeps: it changes no file's owner, the only modes it sets are on files
//     and directories it has just made, and its links, renames and removals are of
//     names root made in directories root owns. A capability is added only when a
//     native test shows the step needs it.
//
// The step has no User=: it runs as root.
func systemdUpdateUnits(spec updateUnitSpec) (service, timer string, err error) {
	paths := UpdateLocations()
	var values [5]string
	for i, item := range []struct{ what, value string }{
		{"the step's executable", spec.Helper},
		{"the agent's state directory", spec.StateDir},
		{"the install directory", spec.InstallDir},
		{"the step's directory", paths.StepDir},
		{"the policy directory", paths.PolicyDir},
	} {
		if values[i], err = updateUnitValue(item.what, item.value); err != nil {
			return "", "", err
		}
	}
	service = "[Unit]\nDescription=Vectory agent update step\n\n" +
		"[Service]\nType=oneshot\n" +
		"ExecStart=" + values[0] + " update-helper --state-dir " + values[1] + "\n" +
		"TimeoutStartSec=1200\n" +
		"ProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\nNoNewPrivileges=true\nProtectControlGroups=true\n" +
		"RestrictAddressFamilies=AF_UNIX\nSystemCallFilter=@system-service\n" +
		"ReadWritePaths=" + values[2] + " " + values[3] + " " + values[4] + "\n" +
		"CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_DAC_OVERRIDE CAP_KILL\n"
	timer = "[Unit]\nDescription=Vectory agent update step schedule\n\n" +
		"[Timer]\nOnBootSec=15s\nOnUnitInactiveSec=30s\nAccuracySec=5s\n\n" +
		"[Install]\nWantedBy=timers.target\n"
	return service, timer, nil
}

// InstallUnits writes the two units, loads them and starts the timer, and has the
// service run once at once, so that status.json is there for the agent to read.
func (h *linuxUpdateHost) InstallUnits(spec updateUnitSpec) error {
	service, timer, err := systemdUpdateUnits(spec)
	if err != nil {
		return err
	}
	for name, text := range map[string]string{updateServiceUnit: service, updateTimerUnit: timer} {
		path := filepath.Join(h.unitDir, name)
		if err := AtomicWrite(path, []byte(text)); err != nil {
			return err
		}
		if err := os.Chmod(path, 0o644); err != nil {
			return err
		}
	}
	ctx := context.Background()
	for _, args := range [][]string{
		{"daemon-reload"},
		{"enable", "--now", updateTimerUnit},
		{"start", "--no-block", updateServiceUnit},
	} {
		if _, err := h.systemctl(ctx, args...); err != nil {
			return err
		}
	}
	return nil
}

// RemoveUnits stops the timer and the service, and removes both units. It reports
// whether there was anything to remove, and the install directory the service's
// ReadWritePaths named.
func (h *linuxUpdateHost) RemoveUnits() (string, bool, error) {
	timer, service := filepath.Join(h.unitDir, updateTimerUnit), filepath.Join(h.unitDir, updateServiceUnit)
	present := false
	for _, path := range []string{timer, service} {
		if _, err := os.Lstat(path); err == nil {
			present = true
		}
	}
	if !present {
		return "", false, nil
	}
	installDir := ""
	if text, err := os.ReadFile(service); err == nil {
		installDir = installDirOfStepUnit(string(text))
	}
	ctx := context.Background()
	for _, args := range [][]string{{"disable", "--now", updateTimerUnit}, {"stop", updateServiceUnit}} {
		if _, err := h.systemctl(ctx, args...); err != nil {
			return installDir, true, err
		}
	}
	for _, path := range []string{timer, service} {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return installDir, true, err
		}
	}
	if _, err := h.systemctl(ctx, "daemon-reload"); err != nil {
		return installDir, true, err
	}
	_, _ = h.systemctl(ctx, "reset-failed", updateServiceUnit)
	return installDir, true, nil
}

// installDirOfStepUnit is the first path of the step's ReadWritePaths=, the
// directory that holds the agent's executable, or "" when the unit says none.
func installDirOfStepUnit(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if value, found := strings.CutPrefix(line, "ReadWritePaths="); found {
			first, err := strconv.QuotedPrefix(value)
			if err != nil {
				return ""
			}
			path, _ := undoUnitArg(first)
			return path
		}
	}
	return ""
}

// ---------------------------------------------------------------- the agent's service

// runSystemctl runs the service manager's command as the step does: with a clean
// environment, with the limits the agent's own calls have (a stop waits for
// Vector's graceful drain), and with what it prints bounded.
func runSystemctl(ctx context.Context, args ...string) ([]byte, error) {
	limit := 30 * time.Second
	for _, arg := range args {
		if arg == "stop" || arg == "restart" || arg == "--now" {
			limit = serviceStopLimit
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "systemctl", args...)
	cmd.Env = cleanEnvironment()
	stdout, stderr := &limitedWriter{max: 8192}, &limitedWriter{max: 2048}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		message := "systemctl " + strings.Join(args, " ") + " failed"
		if detail := lastLine(stderr.b.String()); detail != "" {
			message += ": " + safeText(detail, 200)
		}
		return nil, errors.New(message)
	}
	return stdout.b.Bytes(), nil
}

// ServiceState reads the agent service's state from systemd.
func (h *linuxUpdateHost) ServiceState(ctx context.Context) (updateServiceState, error) {
	out, err := h.systemctl(ctx, "show", ServiceName, "--no-pager", "-p", "ActiveState", "-p", "SubState", "-p", "NRestarts", "-p", "MainPID")
	if err != nil {
		return updateServiceState{}, err
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		if key, value, ok := strings.Cut(line, "="); ok {
			values[key] = strings.TrimSpace(value)
		}
	}
	state := updateServiceState{State: values["ActiveState"]}
	if state.State == "" {
		return updateServiceState{}, errors.New("systemctl show didn't say whether the agent service is active")
	}
	// A manager that doesn't count restarts (systemd before 235) can't show that a
	// build stayed up, and a build is never taken as healthy on a guess.
	restarts, err := strconv.Atoi(values["NRestarts"])
	if err != nil || restarts < 0 {
		return updateServiceState{}, errors.New("systemctl show didn't say how often the agent service was restarted")
	}
	state.Restarts = restarts
	state.PID, _ = strconv.Atoi(values["MainPID"])
	return state, nil
}

// StopService stops the agent service, which waits for Vector's graceful drain.
func (h *linuxUpdateHost) StopService(ctx context.Context) error {
	_, err := h.systemctl(ctx, "stop", ServiceName)
	return err
}

// StartService starts the agent service. A service that systemd gave up on (too
// many starts, or a failed state it keeps) is reset first, so that the start is
// one the manager acts on.
func (h *linuxUpdateHost) StartService(ctx context.Context) error {
	_, _ = h.systemctl(ctx, "reset-failed", ServiceName)
	_, err := h.systemctl(ctx, "start", ServiceName)
	return err
}

// agentUnit is what the step reads from the agent's unit.
type agentUnit struct {
	User, Group string
	Executable  string
	StateDir    string
}

// parseAgentUnit reads the three lines of the agent's unit that decide who runs
// what: User=, Group= and ExecStart=, which must be exactly the line setup writes
// for an executable and a state directory (`"<exe>" run --state-dir "<dir>"`).
// Each must appear once. A unit that is anything else isn't the one setup
// registered.
func parseAgentUnit(text string) (agentUnit, error) {
	var unit agentUnit
	var user, group, start []string
	for _, line := range strings.Split(text, "\n") {
		switch {
		case strings.HasPrefix(line, "User="):
			user = append(user, strings.TrimPrefix(line, "User="))
		case strings.HasPrefix(line, "Group="):
			group = append(group, strings.TrimPrefix(line, "Group="))
		case strings.HasPrefix(line, "ExecStart="):
			start = append(start, strings.TrimPrefix(line, "ExecStart="))
		}
	}
	if len(user) != 1 || len(group) != 1 || len(start) != 1 || user[0] == "" || group[0] == "" {
		return unit, errors.New("it doesn't name one User=, one Group= and one ExecStart=")
	}
	unit.User, unit.Group = user[0], group[0]
	var ok bool
	if unit.Executable, unit.StateDir, ok = parseAgentExecStart(start[0]); !ok {
		return unit, errors.New("its ExecStart= isn't the line `vectory service-install` writes")
	}
	// What setup writes for this account, executable and state directory must be
	// what is there: the same quoting, the same words.
	if unitIdentity(text) != unitIdentity(systemdUnitFile(unit.Executable, unit.StateDir, "", unit.User, unit.Group)) {
		return unit, errors.New("it isn't the unit `vectory service-install` writes for that account, executable and state directory")
	}
	return unit, nil
}

// parseAgentExecStart reads `"<exe>" run --state-dir "<dir>"`, the two arguments
// written by unitArg.
func parseAgentExecStart(line string) (executable, stateDir string, ok bool) {
	first, err := strconv.QuotedPrefix(line)
	if err != nil {
		return "", "", false
	}
	rest, found := strings.CutPrefix(line[len(first):], " run --state-dir ")
	if !found {
		return "", "", false
	}
	second, err := strconv.QuotedPrefix(rest)
	if err != nil || len(second) != len(rest) {
		return "", "", false
	}
	if executable, ok = undoUnitArg(first); !ok {
		return "", "", false
	}
	if stateDir, ok = undoUnitArg(second); !ok {
		return "", "", false
	}
	return executable, stateDir, filepath.IsAbs(executable) && filepath.IsAbs(stateDir)
}

// undoUnitArg reads a value unitArg wrote.
func undoUnitArg(quoted string) (string, bool) {
	value, err := strconv.Unquote(quoted)
	if err != nil {
		return "", false
	}
	return strings.ReplaceAll(strings.ReplaceAll(value, "%%", "%"), "$$", "$"), true
}

// Registered reads the agent's unit through the path check and says what it runs
// and as whom. The unit must be root's alone, name an account that exists and
// isn't root, and run this state directory.
func (h *linuxUpdateHost) Registered(stateDir string) (registeredService, error) {
	if !h.systemdRunning() {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "systemd isn't the running service manager here, so there is no service to update")
	}
	path := filepath.Join(h.unitDir, ServiceName)
	held, err := openRootOwned(path, rootOwnedFile)
	if notExist(err) {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "no agent service is registered (%s doesn't exist)", path)
	}
	if err != nil {
		return registeredService{}, err
	}
	defer held.Close()
	data, err := held.ReadFile(maxUnitFile)
	if err != nil {
		return registeredService{}, err
	}
	unit, err := parseAgentUnit(string(data))
	if err != nil {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "%s isn't an agent service this step can update: %v", path, err)
	}
	if filepath.Clean(unit.StateDir) != filepath.Clean(stateDir) {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the registered service runs the state directory %s, not %s", unit.StateDir, stateDir)
	}
	account, err := user.Lookup(unit.User)
	if err != nil {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the service account %s doesn't exist", unit.User)
	}
	uid, uidErr := strconv.ParseUint(account.Uid, 10, 32)
	gid, gidErr := strconv.ParseUint(unit.Group, 10, 32)
	if uidErr != nil || gidErr != nil {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the service account %s has no numeric user and group", unit.User)
	}
	return registeredService{
		Executable: unit.Executable, StateDir: unit.StateDir,
		Account: updateAccount{Name: unit.User, UID: uint32(uid), GID: uint32(gid)},
	}, nil
}

// ---------------------------------------------------------------- what can't be updated

// PackageManaged says whether a package manager owns the executable: it is in one
// of the package directories (with links resolved), or the vectory package's list
// of files holds it.
func (h *linuxUpdateHost) PackageManaged(executable string) (string, bool) {
	candidates := packageCandidates(executable)
	if directory, managed := underPackageDirectory(candidates); managed {
		return "it is under " + directory, true
	}
	file, err := os.Open(h.dpkgList)
	if err != nil {
		return "", false
	}
	defer file.Close()
	list, err := readBounded(file, 4<<20)
	if err != nil {
		return "", false
	}
	for _, line := range strings.Split(string(list), "\n") {
		for _, candidate := range candidates {
			if strings.TrimSpace(line) == candidate {
				return "the vectory package lists it", true
			}
		}
	}
	return "", false
}

// hiddenFromTheStep are the places the step's sandbox makes inaccessible
// (ProtectHome=true hides the first three, PrivateTmp=true gives the step its own
// empty /tmp and /var/tmp): an agent whose state directory or executable is there
// couldn't be updated, whatever the file permissions say.
var hiddenFromTheStep = []string{"/home", "/root", "/run/user", "/tmp", "/var/tmp"}

func hiddenPath(path string) (string, bool) {
	cleaned := filepath.Clean(path)
	for _, directory := range hiddenFromTheStep {
		if cleaned == directory || strings.HasPrefix(cleaned, directory+"/") {
			return directory, true
		}
	}
	return "", false
}

// StateDirReachable refuses a state directory the sandbox of the step hides.
func (h *linuxUpdateHost) StateDirReachable(stateDir string) error {
	if directory, hidden := hiddenPath(stateDir); hidden {
		return untrustedLocation(fmt.Sprintf("the agent's state directory %s is under %s, which the update step's sandbox can't read", stateDir, directory))
	}
	return nil
}

// OpenInstall opens the install directory and the executable, after refusing a
// path the sandbox hides.
func (h *linuxUpdateHost) OpenInstall(executable string) (updateInstall, error) {
	if directory, hidden := hiddenPath(executable); hidden {
		return nil, untrustedLocation(fmt.Sprintf("the agent's executable %s is under %s, which the update step's sandbox can't write", executable, directory))
	}
	return h.unixUpdateHost.OpenInstall(executable)
}
