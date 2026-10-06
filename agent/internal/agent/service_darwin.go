//go:build darwin

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
)

const serviceDefinition = "/Library/LaunchDaemons/" + launchdLabel + ".plist"
const serviceStopRecord = "/Library/LaunchDaemons/" + launchdLabel + ".stop.json"

// ServiceName is how launchd knows the agent.
const ServiceName = launchdLabel

var agentJob = launchdJob{
	definition: serviceDefinition,
	run:        runLaunchctl,
	installed: func() bool {
		_, err := os.Stat(serviceDefinition)
		return err == nil
	},
	now:   time.Now,
	sleep: time.Sleep,
	// A stop ends when launchd no longer lists the job and the process it had is gone.
	alive:          processExists,
	uninstallGuard: &launchdStopGuard{path: serviceStopRecord, identity: macProcessIdentity},
}

// The start time distinguishes the agent from a later process that reuses its
// PID after launchd has unloaded the job. An unreadable process fails closed.
func macProcessIdentity(pid int) (string, bool, error) {
	if !processExists(pid) {
		return "", false, nil
	}
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if errors.Is(err, unix.ESRCH) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if info.Proc.P_pid != int32(pid) {
		return "", false, errors.New("launchd process identity changed while checking it")
	}
	started := info.Proc.P_starttime
	return fmt.Sprintf("%d:%d", started.Sec, started.Usec), true, nil
}

// runLaunchctl runs /bin/launchctl, a fixed local tool, with a clean
// environment and bounded output.
func runLaunchctl(ctx context.Context, args ...string) launchctlResult {
	cmd := exec.CommandContext(ctx, "/bin/launchctl", args...)
	cmd.Env = cleanEnvironment()
	cmd.WaitDelay = time.Second
	stdout, stderr := &limitedWriter{max: 65536}, &limitedWriter{max: 2048}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	status := 0
	if err := cmd.Run(); err != nil {
		status = -1
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() > 0 {
			status = exit.ExitCode()
		}
	}
	return launchctlResult{status: status, stdout: stdout.b.String(), stderr: stderr.b.String()}
}

// ServiceInstall registers the running executable.
func ServiceInstall(dir, account string) (ServiceRegistration, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return ServiceInstallFor(exe, dir, account)
}

func registeredElsewhere() error {
	return errors.New(serviceDefinition + " already exists for another account, binary or state directory; review it, then remove it with `vectory service-uninstall` before registering again")
}

// serviceRegistrationCheck reports, reading only, whether the existing
// definition belongs to another account, executable or state directory,
// which ServiceInstallFor refuses; setup checks it before it changes anything.
func serviceRegistrationCheck(exe, dir, account string) error {
	// A value a definition can't hold as it is would be refused when it is written;
	// setup says so before it changes anything.
	plist, err := launchdPlist(exe, dir, account)
	if err != nil {
		return err
	}
	old, err := os.ReadFile(serviceDefinition)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if plistIdentity(string(old)) != plistIdentity(plist) {
		return registeredElsewhere()
	}
	return nil
}

// ServiceInstallFor registers exe as the agent's launch daemon for dir. An
// existing definition for the same account, executable and state directory
// is brought up to date; any other existing definition is refused.
func ServiceInstallFor(exe, dir, account string) (ServiceRegistration, error) {
	if os.Geteuid() != 0 {
		return "", errors.New("registering a launchd daemon requires root; run with sudo (the daemon itself runs as the unprivileged account)")
	}
	if err := CheckServiceAccountName(account); err != nil {
		return "", err
	}
	releaseLifecycle, err := lockLifecycle(dir)
	if err != nil {
		return "", err
	}
	defer releaseLifecycle()
	// Service control locks the stable LaunchDaemons directory. Take that lock
	// after the state-parent lock and keep it through the plist read/write.
	releaseService, err := lockLifecycle(serviceDefinition)
	if err != nil {
		return "", err
	}
	defer releaseService()
	if err := checkNoPendingPurge(dir); err != nil {
		return "", err
	}
	u, err := user.Lookup(account)
	if err != nil {
		return "", errors.New("account " + account + " doesn't exist; create it (vectory setup --create-user does) or pass --service-user")
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return "", err
	}
	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return "", err
	}
	s, err := LoadSettings(dir)
	if err != nil {
		return "", err
	}
	if err = CheckManagedDirectory(s.ManagedConfig, dir); err != nil {
		return "", err
	}
	// The account owns both folders; every directory above them must let it in.
	for _, path := range []string{dir, filepath.Dir(s.ManagedConfig)} {
		if err = checkServiceCanReach(path, account, uid, gid); err != nil {
			return "", err
		}
	}
	plist, err := launchdPlist(exe, dir, account)
	if err != nil {
		return "", err
	}
	registration := ServiceCreated
	if old, err := os.ReadFile(serviceDefinition); err == nil {
		switch {
		case string(old) == plist:
			registration = ServiceUnchanged
		case plistIdentity(string(old)) == plistIdentity(plist):
			registration = ServiceUpdated
		default:
			return "", registeredElsewhere()
		}
	}
	if err = filepath.WalkDir(dir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := SafePath(path); err != nil {
			return err
		}
		return os.Chown(path, uid, gid)
	}); err != nil {
		return "", err
	}
	if err = os.Chown(filepath.Dir(s.ManagedConfig), uid, gid); err != nil {
		return "", err
	}
	if err = os.Chown(s.ManagedConfig, uid, gid); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if registration == ServiceUnchanged {
		return registration, nil
	}
	if err = AtomicWrite(serviceDefinition, []byte(plist)); err != nil {
		return "", err
	}
	return registration, os.Chmod(serviceDefinition, 0644)
}

func ServiceControl(action string) error {
	control := func(removeUpdate func() error) error {
		return controlLaunchdService(action, agentJob, func() (func(), error) {
			return lockLifecycle(serviceDefinition)
		}, removeUpdate, func() error {
			if err := os.Remove(serviceDefinition); err != nil && !os.IsNotExist(err) {
				return err
			}
			return nil
		})
	}
	if action == "uninstall" {
		return withUpdateLifecycle(func() error {
			return control(func() error { return removeStepWith(removalUpdateHost()) })
		})
	}
	return control(RemoveUpdateHelper)
}

// ServiceStatus asks launchd about the agent daemon without changing it.
func ServiceStatus(ctx context.Context) ServiceInfo { return agentJob.status(ctx) }
