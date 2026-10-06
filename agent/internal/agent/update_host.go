package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"runtime"
	"time"
)

var (
	// errUpdateStepBusy is what taking the step's lock says when another run holds it.
	errUpdateStepBusy = errors.New("another run of the update step holds its lock")
	// errServiceFileTooLarge says a file the service account wrote is larger than
	// the step reads. The caller names the refusal, because what the file is
	// decides it.
	errServiceFileTooLarge = errors.New("is larger than the step reads")
	// errUpdateReadOnly marks a failure to write beside the executable because the
	// file system is mounted read-only: the host's answer is READ_ONLY.
	errUpdateReadOnly = errors.New("the file system is read-only")
)

// What the privileged step asks of the operating system. The reconciler
// (update_helper.go) is the same on every platform: it reads the journal and takes
// the next step, and everything that differs between systemd, launchd and the
// Windows Service Control Manager, or between a rename over a file and two
// journaled renames, is behind updateHost and updateInstall. Linux implements them
// in update_service_linux.go and macOS in update_launchd.go, both over the Unix
// primitives of update_helper_unix.go and update_swap_unix.go. A platform whose
// update step isn't built, or isn't shipped in this build (update_gate.go), has no
// host (currentUpdateHost returns nil), and every function of the step's API says
// so.

// updateAccount is who the agent's service runs as: an account the step never
// trusts with anything but what it wrote itself, and the one the probe runs as.
type updateAccount struct {
	Name string
	// UID and GID are the numeric identity on Linux and macOS. The step refuses a
	// service that runs as root.
	UID, GID uint32
}

// registeredService is what the service manager has registered for the agent: the
// executable it runs, the state directory it runs for and the account.
type registeredService struct {
	// Executable is the absolute path of the installed agent as the service
	// definition names it.
	Executable string
	StateDir   string
	Account    updateAccount
}

// updateServiceState is the service manager's view of the agent service.
type updateServiceState struct {
	// State is the manager's own word: "active" (running), "activating" (starting,
	// or waiting to restart), "failed" or "inactive".
	State string
	// Restarts counts the automatic restarts since the service was last started. A
	// manager that was told to load the service again counts from the start: the
	// count can go down.
	Restarts int
	// PID is the main process, 0 when there is none.
	PID int
	// CountsFromStart says Restarts counts from the start the step made, so that a
	// restart seen at the first look is a restart of this watch and not one that came
	// before it.
	CountsFromStart bool
	// Unloaded says the manager has no such service at all (launchd: no such job); State
	// is "inactive" then. A unit that merely stopped is "inactive" and loaded.
	Unloaded bool
	// Detail is what the manager said, in words for the step's log when a build
	// doesn't stay up. Nothing reads it to decide anything.
	Detail string
}

func (s updateServiceState) running() bool { return s.State == "active" }
func (s updateServiceState) failed() bool  { return s.State == "failed" }

// updateServiceFile is a file the service account wrote, opened and judged: a
// regular file of that account, with no link in any component of its path, and the
// size it had when it was judged.
type updateServiceFile struct {
	File *os.File
	Size int64
	// ModTime is when the file was last written, as the file system says.
	ModTime time.Time
}

// updateUnitSpec is what the step's service definition is made from.
type updateUnitSpec struct {
	// StateDir is the agent's state directory, which the step is told about.
	StateDir string
	// InstallDir is the directory that holds the agent's executable, the one place
	// besides its own directory the step may write.
	InstallDir string
	// Helper is the copy of the last committed build the step runs from.
	Helper string
}

// updateHost is the operating system as the step sees it.
type updateHost interface {
	// Registered says what the agent's service runs and as whom. A service that
	// isn't registered, or doesn't run this state directory, is refused with
	// NO_SERVICE.
	Registered(stateDir string) (registeredService, error)
	// PackageManaged reports whether a package manager owns the executable, and
	// says how it knows.
	PackageManaged(executable string) (reason string, managed bool)
	// StateDirReachable refuses (UNTRUSTED_LOCATION) a state directory the step
	// couldn't read from its sandbox.
	StateDirReachable(stateDir string) error

	// ServiceState, StopService and StartService are the service manager. Stopping
	// waits for Vector's graceful drain and returns only when the service is
	// stopped, and starting returns nil only when the manager shows the service
	// started, whatever it is doing. A start that fails or can't be shown is an error,
	// which the step reads as "start again at the next run": it never ends a request
	// on one.
	//
	// A service that is still on its way out is not one that started. A stop that gave
	// up leaves it listed for a while: launchd lists a job it is removing as running,
	// with the process it had, and the Service Control Manager says stop pending;
	// systemd holds a start back until the stop is done. A start that finds only that
	// waits for it to end within its own bound, and is an error if it doesn't. So a
	// request whose stop failed ends on a start only when the manager shows the service
	// started, whatever it is doing (after the stop, or never stopped, which is the old
	// build running), and otherwise stays open as a failed start does: the journal stays
	// where it was, the run ends with an error and the next run tries again.
	ServiceState(ctx context.Context) (updateServiceState, error)
	StopService(ctx context.Context) error
	StartService(ctx context.Context) error

	// OpenInstall opens the directory that holds executable and the executable in
	// it, checks every component (openRootOwned) and holds both open: every later
	// use of the install goes through them.
	OpenInstall(executable string) (updateInstall, error)
	// FreeSpace is how many bytes the step may still write on the file system
	// that holds a directory it has open.
	FreeSpace(dir *rootOwned) (uint64, error)
	// Lock takes the step's lock in its private directory without waiting: a
	// second run gets errUpdateStepBusy.
	Lock(private *rootOwned) (release func(), err error)
	// CheckPrivate refuses (UNTRUSTED_LOCATION) a private directory that anyone
	// but root could enter: the step's copies of what the service account wrote
	// are there, and so are the counter floors.
	CheckPrivate(private *rootOwned) error
	// CopyInto makes a new file called name in a directory the step holds open,
	// with the access perm names, writes exactly size bytes from src, syncs it and
	// returns the SHA-256 of what it reads back from the file. A file that is there
	// is not replaced, and a failure removes the new file. A src that holds more
	// or fewer than size bytes is an error; a negative size takes a src of any
	// length up to MaxAgentBuild.
	CopyInto(dir *rootOwned, name string, perm rootFilePerm, src io.Reader, size int64) (digest string, err error)
	// RemoveFrom removes a file of a directory the step holds open. A file that
	// isn't there is not an error. EmptyDir removes everything in the directory.
	RemoveFrom(dir *rootOwned, name string) error
	EmptyDir(dir *rootOwned) error
	// Replace renames a file of a directory the step holds open over another,
	// atomically, and syncs the directory. A running executable of that name keeps
	// running from the file it was started from.
	Replace(dir *rootOwned, from, to string) error
	// OpenServiceFile opens name in directory, a path inside the agent's state
	// directory, for reading, without following a link at any depth and without
	// waiting for a writer. It refuses what isn't a regular file of the service
	// account, and a file larger than limit.
	OpenServiceFile(directory, name string, account updateAccount, limit int64) (*updateServiceFile, error)
	// RunProbe runs `version --json` of the build at path as the service account,
	// from a clean environment, for at most 10 seconds, and returns at most 4 KiB
	// of what it printed. path is inside the probe directory.
	RunProbe(ctx context.Context, path string, account updateAccount) ([]byte, error)

	// InstallUnits registers and starts the step's timer and service. RemoveUnits
	// stops and removes them, and reports whether there were any and the install
	// directory they named, so that the step can remove what it left beside the
	// executable.
	InstallUnits(spec updateUnitSpec) error
	RemoveUnits() (installDir string, removed bool, err error)
}

// serviceReloader is implemented by a host whose service manager can lose the agent's
// service without anyone having asked it to remove it (launchd, when a removal that
// was already under way takes a job that was loaded in the meantime, or when an
// administrator boots it out): the other managers keep a service they were told to
// start, or say it stopped. The watch of a trial calls it when the manager says the
// service is "inactive".
type serviceReloader interface {
	// ReloadService loads the agent's service again when the manager doesn't know it,
	// and says whether it did. A manager that knows the service is left alone.
	ReloadService(ctx context.Context) (reloaded bool, err error)
}

// agentLocator is implemented by every host that can say which executable the agent's
// service runs without being told the agent's state directory, which the removal of the
// step (service-uninstall) isn't. The removal reads it to see whether a rollback that
// waits for a start has already put the previous build back.
type agentLocator interface {
	// AgentExecutable is the absolute path of the executable the agent's service is
	// registered to run, read from the registration the way Registered reads it, or an
	// error when there is none or it isn't the one setup writes. An error that wraps
	// errAgentNotRegistered says there is no registration at all: the definition, the unit
	// or the service is gone.
	AgentExecutable() (string, error)
}

// errAgentNotRegistered is what a locator wraps when the agent's service has no registration:
// nothing the step could start, and the one thing that gives it one again is the command that
// registers the service (`vectory service-install`).
var errAgentNotRegistered = errors.New("the agent's service isn't registered")

// updateInstall is the install directory and the executable in it, checked once
// and held. The swap is made relative to the held directory, so that no component
// of the path can change between the check and the use.
type updateInstall interface {
	// Path is the executable's path as it was asked for, for messages. It is never
	// resolved again.
	Path() string
	// Name is the executable's name in the directory.
	Name() string
	// Style is how the new build takes the executable's place: updateSwapRename or
	// updateSwapTwoRenames.
	Style() string
	// ReadOnly says that the file system is mounted read-only.
	ReadOnly() bool
	// Immutable says, in words that name the flag, why the file system won't let the
	// step replace the executable although it is writable: the executable, its
	// directory, or a name the swap renames over or removes (the build an earlier update
	// kept, and the link the swap makes first) has a flag that forbids it (the immutable
	// or append-only attribute of a Linux file system, uchg or schg on macOS). It is ""
	// when none has one.
	Immutable() string
	// FreeSpace is how many bytes the step may still write in the directory.
	FreeSpace() (uint64, error)

	// Digest hashes the file called name in the directory through the held
	// handle. A file that isn't there is reported as present false.
	Digest(name string) (digest string, present bool, err error)
	// Open opens a file of the directory for reading.
	Open(name string) (io.ReadCloser, error)
	// Stage makes a new file called name beside the executable (mode 0755, never
	// replacing a file, never following a link), writes size bytes from src, syncs
	// it and returns the SHA-256 of what it reads back from the file. A failure
	// removes the file.
	Stage(name string, src io.Reader, size int64) (digest string, err error)
	// Swap makes the staged file the executable and keeps the executable it
	// replaces as previous, so that the directory always holds a complete
	// executable, and syncs the directory.
	Swap(staged, previous string) error
	// Restore puts the build kept as previous back in the executable's place and
	// syncs the directory.
	Restore(previous string) error
	// Remove removes a file of the directory. A file that isn't there is not an
	// error.
	Remove(name string) error
	Close() error
}

// ---------------------------------------------------------------- the clock

// updateClock is the time the step reads and the pauses it takes. Tests replace it
// with one that moves by itself.
type updateClock interface {
	Now() time.Time
	// Sleep waits for d, or until ctx ends, and says why it stopped early.
	Sleep(ctx context.Context, d time.Duration) error
}

type systemUpdateClock struct{}

func (systemUpdateClock) Now() time.Time { return time.Now() }

func (systemUpdateClock) Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ---------------------------------------------------------------- seams

// The step's three seams are declared here and assigned only in test files
// (TestTheUpdateSeamsAreAssignedOnlyByTests, and
// TestProductionAgentContainsNoTestHooks in cmd/vectory, check it): the host
// replaces the service manager, the probe and the facts of the operating system,
// the clock replaces time, and the fault hook stops the step at a named boundary
// so that a test can kill it there. The binary that ships has none of them set.
// A fourth, updateGateOverride (update_gate.go), replaces the table of the operating
// systems whose updates this build ships.
var (
	updateHostOverride  updateHost
	updateClockOverride updateClock
	updateFault         func(point string)
)

// currentUpdateHost is the operating system's host, or nil when this platform has
// no update step: its native proof isn't part of this build (updatesInRelease), or
// no step is written for it yet. A test that replaced the gate's table is asking what a
// build with that table does, so the table decides before the test's host (which
// otherwise stands for the platform's and needs no gate).
func currentUpdateHost() updateHost {
	switch {
	case updateGateOverride != nil && !updatesInRelease(runtime.GOOS):
		return nil
	case updateHostOverride != nil:
		return updateHostOverride
	case !updatesInRelease(runtime.GOOS):
		return nil
	}
	return platformUpdateHost()
}

// removalUpdateHost is the operating system's host for taking a step away: the one
// that an earlier build may have installed it with, whether or not this build ships
// updates here. The gate says what a build may start, never what it may leave behind:
// a build that doesn't ship updates on this system must still be able to remove a step
// (and the launch daemon or service that runs it as root) that an earlier one made.
// Only removal and uninstall use it. It is nil where no step is written for the
// operating system at all.
func removalUpdateHost() updateHost {
	if updateHostOverride != nil {
		return updateHostOverride
	}
	return platformUpdateHost()
}

func currentUpdateClock() updateClock {
	if updateClockOverride != nil {
		return updateClockOverride
	}
	return systemUpdateClock{}
}

// faultPoint names a boundary of the step. It does nothing unless a test set the
// hook.
func faultPoint(point string) {
	if updateFault != nil {
		updateFault(point)
	}
}

// digestOfReader is the SHA-256 of everything r holds, as lowercase hexadecimal.
func digestOfReader(r io.Reader) (string, error) {
	hash := sha256.New()
	if _, err := io.Copy(hash, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
