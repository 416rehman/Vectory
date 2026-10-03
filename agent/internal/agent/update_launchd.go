//go:build !windows

package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// The privileged step on macOS: a launch daemon of its own, io.vectory.update, and
// the calls the step makes to launchd about the agent's, io.vectory.agent. Every
// decision of the step (the journal, the floors, the swap, the trial and the
// rollback) is the shared reconciler's; this file is only what launchd and a
// property list add to it. It has no build constraint beyond the Unix one, so that
// the text it writes and reads, and the way it reads launchctl, are tested on
// every Unix system; update_service_darwin.go binds it to the real launchctl.
//
// A launch daemon with StartInterval, not a file watch: every 30 seconds and at
// boot (RunAtLoad), the step runs, finds its journal idle and no request, and
// exits in milliseconds. Polling needs no launchd watch semantics, survives any
// crash between runs, and gives the recovery run at boot the same entry point as
// every other. An update waits at most 30 seconds for it.

const (
	// updateLaunchdLabel is how launchd knows the step. Its definition carries the
	// same name.
	updateLaunchdLabel = "io.vectory.update"
	// updateStepInterval is StartInterval: how often launchd starts the step.
	updateStepInterval = 30
	// updateStepPath is the whole environment the step is given: the system's own
	// PATH. The step passes cleanEnvironment to every process it starts as well.
	updateStepPath = "/usr/bin:/bin:/usr/sbin:/sbin"
	// updateStepLogFile is where launchd keeps the step's standard error, in the
	// step's private directory. `vectory update-helper` keeps it short.
	updateStepLogFile = "step.log"

	// launchDaemonsDir is where launchd reads the definitions of system daemons.
	launchDaemonsDir = "/Library/LaunchDaemons"
	// macosPackageReceipt is what the installer package leaves when it installs the
	// agent (packaging/macos/build-pkg.sh: identifier com.vectory.agent).
	macosPackageReceipt = "/var/db/receipts/com.vectory.agent.bom"

	// maxPlistFile bounds a definition as the step reads it.
	maxPlistFile = 64 * 1024

	// A start of the agent's job that launchd refuses (a bootstrap that answers
	// "Input/output error", for one) or that doesn't show afterwards is tried again,
	// every launchdStartPause, for launchdStartBound in all.
	launchdStartBound = 60 * time.Second
	launchdStartPause = 2 * time.Second
)

// macosUpdateHost is updateHost on a Mac: launchd runs the agent and the step.
type macosUpdateHost struct {
	unixUpdateHost
	// daemonDir is where the two definitions are, /Library/LaunchDaemons.
	daemonDir string
	// receipt is the installer package's receipt.
	receipt string
	// agent drives the agent's launch daemon, and step the step's own.
	agent, step launchdJob
	// startBound is how long a start of the agent's job keeps trying to have launchd
	// show it. alive says whether a process is still there; a test replaces it.
	startBound time.Duration
	alive      func(pid int) bool
	// bootSession names this boot of the Mac ("" when the system doesn't say) and uptime says
	// for how long it has been awake (false when it doesn't say): the record of a job launchd
	// was told to remove carries both (leavingJob). A test replaces them.
	bootSession func() string
	uptime      func() (time.Duration, bool)
}

var _ updateHost = (*macosUpdateHost)(nil)
var _ serviceReloader = (*macosUpdateHost)(nil)

// newMacOSUpdateHost builds the host over a launchctl runner: the real one, or a
// recorder in a test.
func newMacOSUpdateHost(run func(ctx context.Context, args ...string) launchctlResult) *macosUpdateHost {
	h := &macosUpdateHost{daemonDir: launchDaemonsDir, receipt: macosPackageReceipt, startBound: launchdStartBound, alive: processExists, bootSession: currentBootSession, uptime: currentUptime}
	h.agent = h.job("", run)
	h.step = h.job(updateLaunchdLabel, run)
	return h
}

// processExists says whether a process with this ID is there: kill with signal 0
// sends nothing and only looks. EPERM says it exists and isn't this process's to
// signal; only ESRCH says it is gone.
func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := unix.Kill(pid, 0)
	return err == nil || errors.Is(err, unix.EPERM)
}

// job makes the driver of one of the two daemons: label is empty for the agent's.
func (h *macosUpdateHost) job(label string, run func(ctx context.Context, args ...string) launchctlResult) launchdJob {
	job := launchdJob{label: label, run: run, now: time.Now, sleep: time.Sleep}
	job.definition = h.definitionOf(job.name())
	job.installed = func() bool {
		_, err := os.Stat(job.definition)
		return err == nil
	}
	if label == "" {
		job.leaving = h.rememberLeaving
	}
	return job
}

func (h *macosUpdateHost) definitionOf(label string) string {
	return h.daemonDir + "/" + label + ".plist"
}

// ---------------------------------------------------------------- the step's definition

// launchdUpdatePlist is the step's launch daemon, in the compact form launchdPlist
// uses for the agent's. It runs as root (no UserName, no GroupName) from the
// helper, the copy of the last committed build, with the system's own PATH and
// nothing else in its environment. It is started at load and every 30 seconds, and
// does no network I/O. Its standard error is a file in the step's private
// directory; its standard output is nowhere. UpdateInstallDir isn't named: a launch
// daemon has no sandbox to name it in.
func launchdUpdatePlist(spec updateUnitSpec, paths UpdatePaths) (string, error) {
	helper, err := plistText("the step's executable", spec.Helper)
	if err != nil {
		return "", err
	}
	state, err := plistText("the agent's state directory", spec.StateDir)
	if err != nil {
		return "", err
	}
	if _, err := plistText("the install directory", spec.InstallDir); err != nil {
		return "", err
	}
	log, err := plistText("the step's log", paths.Private+"/"+updateStepLogFile)
	if err != nil {
		return "", err
	}
	return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>` +
		`<key>Label</key><string>` + updateLaunchdLabel + `</string>` +
		`<key>ProgramArguments</key><array><string>` + helper + `</string><string>update-helper</string><string>--state-dir</string><string>` + state + `</string></array>` +
		`<key>RunAtLoad</key><true/>` +
		`<key>StartInterval</key><integer>` + strconv.Itoa(updateStepInterval) + `</integer>` +
		`<key>EnvironmentVariables</key><dict><key>PATH</key><string>` + updateStepPath + `</string></dict>` +
		`<key>StandardOutPath</key><string>/dev/null</string>` +
		`<key>StandardErrorPath</key><string>` + log + `</string>` +
		"</dict></plist>\n", nil
}

// InstallUnits writes the step's definition, loads it and has it start at once
// (RunAtLoad), so that status.json is there for the agent to read. A job that is
// loaded keeps what it loaded, so it is unloaded first and read again.
func (h *macosUpdateHost) InstallUnits(spec updateUnitSpec) error {
	plist, err := launchdUpdatePlist(spec, UpdateLocations())
	if err != nil {
		return err
	}
	ctx := context.Background()
	if _, loaded := h.step.loaded(ctx); loaded {
		if err := h.step.bootoutContext(ctx); err != nil {
			return err
		}
	}
	if err := AtomicWrite(h.step.definition, []byte(plist)); err != nil {
		return err
	}
	if err := os.Chmod(h.step.definition, 0o644); err != nil {
		return err
	}
	// A job a person disabled stays disabled until it is enabled again, and refuses
	// to load; setup's consent is the person's word. A host where this fails still
	// loads it, and fails there with launchd's own reason.
	_ = h.step.do(ctx, launchctlLimit, "enable", h.step.target())
	return h.step.do(ctx, launchctlLimit, "bootstrap", "system", h.step.definition)
}

// RemoveUnits unloads the step's job and removes its definition. It reports
// whether there was anything to remove, and the install directory the agent runs
// from, which it learns from the agent's own definition before it removes anything:
// the step left its previous build there.
func (h *macosUpdateHost) RemoveUnits() (string, bool, error) {
	ctx := context.Background()
	_, statErr := os.Lstat(h.step.definition)
	_, loaded := h.step.loaded(ctx)
	if notExist(statErr) && !loaded {
		return "", false, nil
	}
	installDir := h.installDirBehind(h.step.definition)
	if loaded {
		if err := h.step.bootoutContext(ctx); err != nil {
			return installDir, true, err
		}
	}
	if err := os.Remove(h.step.definition); err != nil && !notExist(err) {
		return installDir, true, err
	}
	return installDir, true, nil
}

// installDirBehind is the directory that holds the agent's executable: the step's
// definition names the state directory, and the agent's definition for that
// directory names the executable. "" when either can't be read.
func (h *macosUpdateHost) installDirBehind(stepDefinition string) string {
	text, err := readDefinition(stepDefinition)
	if err != nil {
		return ""
	}
	dict, err := parsePropertyList([]byte(text))
	if err != nil {
		return ""
	}
	arguments, _ := dict["ProgramArguments"].([]any)
	if len(arguments) != 4 || arguments[2] != "--state-dir" {
		return ""
	}
	state, _ := arguments[3].(string)
	agent, err := h.readAgentDefinition()
	if err != nil || filepath.Clean(agent.StateDir) != filepath.Clean(state) {
		return ""
	}
	return filepath.Dir(agent.Executable)
}

// readDefinition reads a launch daemon's definition through the path check: every
// directory above it and the file are root's and closed to everyone else.
func readDefinition(path string) (string, error) {
	held, err := openRootOwned(path, rootOwnedFile)
	if err != nil {
		return "", err
	}
	defer held.Close()
	data, err := held.ReadFile(maxPlistFile)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ---------------------------------------------------------------- the agent's service

// serviceState is what the step reads of it. launchd keeps a job that has
// KeepAlive loaded when its process ends or is killed, and starts it again no sooner
// than its ThrottleInterval (10 s in the agent's definition): `print` then says "spawn
// scheduled" or "not running", the count of runs goes up and the last exit code or the
// signal that ended it is shown. So there is no failed state to read: a job that is
// running with a process is "active", and a job that is loaded and isn't (waiting out
// its throttle, or starting) is "activating". A build that can't start is seen as
// runs that count up, which the step ends at three, or as a deadline. A job launchd
// doesn't know (updateServiceState.Unloaded) is "inactive": that is what a bootout
// leaves, by the manager or by a person.
func (p launchdPrinted) serviceState() updateServiceState {
	state := updateServiceState{State: "activating", PID: p.PID, Restarts: max(p.Runs-1, 0)}
	if p.State == "running" && p.PID > 0 {
		state.State = "active"
	}
	state.Detail = fmt.Sprintf("launchd says the job is %q with pid %d, %d run(s), last exit code %s, immediate reason %s", safeText(p.State, 40), p.PID, p.Runs, orDash(p.LastExit), orDash(p.Reason))
	return state
}

// orDash is a word launchd didn't print, as a dash.
func orDash(word string) string {
	if word == "" {
		return "-"
	}
	return word
}

// ServiceState reads the agent's job from launchd.
func (h *macosUpdateHost) ServiceState(ctx context.Context) (updateServiceState, error) {
	result := h.agent.launchctl(ctx, launchdStatusLimit, "print", h.agent.target())
	switch {
	case result.status == 0:
		printed, err := parseLaunchdPrint(result.stdout)
		if err != nil {
			return updateServiceState{}, err
		}
		return printed.serviceState(), nil
	case launchdNotLoaded(result):
		return updateServiceState{State: "inactive", Unloaded: true, Detail: fmt.Sprintf("launchd doesn't know the job (launchctl print exited %d: %s)", result.status, safeText(strings.TrimSpace(result.stderr), 120))}, nil
	case ctx.Err() != nil:
		return updateServiceState{}, ctx.Err()
	}
	return updateServiceState{}, launchctlFailure([]string{"print", h.agent.target()}, result)
}

// StopService unloads the agent's job (launchctl bootout), which waits for the agent
// to drain Vector, and reports it stopped only when launchd no longer lists the job
// and the process the job had is gone. launchctl bootout returns when launchd has begun
// to remove the job, not when it has (launchdJob.bootout), so the first of the two
// waits is the job's, and the second is for the process: its ID is read from `print`
// before the bootout, and `kill(pid, 0)` says ESRCH once it is gone. Both are bounded by
// the stop limit.
//
// A stop that gives up, is cut short or dies while launchctl waits leaves a job that
// launchd goes on listing as running, with the process it had, until the removal is done,
// and nothing in what `print` says tells it from a job that was started. So the step writes
// a record of the job it is about to tell launchd to remove before launchctl is asked
// (rememberLeaving), and a bootout whose record can't be written isn't asked for: the stop
// fails with that error. The record stays whatever launchd answers and wherever the stop
// ends. Only `print` saying that launchd has no such job ends it, here or in the start that
// follows, and so does a listing of another process or the record's age (leavingJob).
// StartService never takes a listing of the job the record names for a start.
func (h *macosUpdateHost) StopService(ctx context.Context) error {
	deadline := h.agent.now().Add(serviceStopLimit)
	pid := 0
	if result, loaded := h.agent.loaded(ctx); loaded {
		if printed, err := parseLaunchdPrint(result.stdout); err == nil {
			pid = printed.PID
		}
	}
	if err := h.agent.controlContext(ctx, "stop"); err != nil {
		return err
	}
	// launchd says it has no such job, so there is none left to wait for.
	h.forgetLeaving()
	for pid > 0 && h.alive(pid) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !h.agent.now().Before(deadline) {
			return fmt.Errorf("the agent's process %d is still there after launchd unloaded its job, and %s have passed", pid, humanDuration(serviceStopLimit))
		}
		h.agent.sleep(launchdUnloadPoll)
	}
	return nil
}

// StartService has launchd load the agent's job and show it. It doesn't go through the
// agent's own `service-start`, which acts on what `print` says at that instant: a job
// still listed as running is taken for the agent and a bootstrap launchd accepts while
// it removes a label disappears with it. It bootstraps the definition when `print`
// says launchd has no such job, tries a refusal again every two seconds for a minute in
// all, and confirms with `print` that launchd lists the job (loaded, whatever it is
// doing: a job that is waiting out its throttle has started, and the watch judges it by
// its runs); a job that isn't shown is bootstrapped again within the same minute. Only
// a job that is shown ends it with nil.
//
// A job that is listed is the new instance only if it isn't the one the step told launchd
// to remove: the stop waits until launchd has removed the old job, but a stop that gave up,
// was cut short or died leaves it listed, as running, with the process it had
// (StopService). While the step holds a record of that job, a listing of its process, of no
// process or (when the record names none) of any process is not a start: the start waits for
// launchd to finish within its minute, bootstraps once `print` says there is no such job,
// and otherwise ends with an error that says what it found. The step never ends a request on
// it.
func (h *macosUpdateHost) StartService(ctx context.Context) error {
	job := h.agent
	deadline := job.now().Add(h.startBound)
	leaving, leavingKnown := h.leavingRecord()
	var last error
	// gaveUp is the error of a start that has run out of its minute, with what launchd
	// said last.
	gaveUp := func() error {
		if last == nil {
			last = errors.New("launchd accepted the bootstrap and then didn't list the job")
		}
		return fmt.Errorf("launchd doesn't show the agent's job after %s: %w", humanDuration(h.startBound), last)
	}
	for {
		printed := job.launchctl(ctx, launchdStatusLimit, "print", job.target())
		pause := launchdStartPause
		departing := leavingKnown && printed.status == 0 && leaving.listedIn(printed.stdout)
		switch {
		case printed.status == 0 && !departing:
			// A job that is listed and isn't the one the step told to leave: nothing was
			// recorded, or the listing is of another process, which is a job started since.
			h.forgetLeaving()
			return nil
		case ctx.Err() != nil:
			return ctx.Err()
		case !job.now().Before(deadline):
			// No new try after the minute; a job a bootstrap just made is still looked at
			// once more, above.
			return gaveUp()
		case departing:
			last, pause = fmt.Errorf("it lists only the job it was told to remove%s", leaving.of()), launchdUnloadPoll
		case launchdNotLoaded(printed):
			// launchd has finished removing the job it was told to remove; what is listed from
			// here on is what this start makes.
			h.forgetLeaving()
			leavingKnown = false
			args := []string{"bootstrap", "system", job.definition}
			if result := job.launchctl(ctx, launchctlLimit, args...); result.status == 0 {
				// Accepted: a moment for launchd to settle, then a look at what it kept.
				last, pause = nil, launchdUnloadPoll
			} else if err := ctx.Err(); err != nil {
				return err
			} else {
				last = launchctlFailure(args, result)
			}
		default:
			last = launchctlFailure([]string{"print", job.target()}, printed)
		}
		job.sleep(pause)
	}
}

// updateLeavingFile is where the step keeps the record of the agent's job it is telling
// launchd to remove (leavingJob), in its private directory, for as long as launchd may
// still list that job. The step is a new process every 30 seconds, and the removal can last
// longer than a run.
const updateLeavingFile = "agent-job-leaving"

// leavingLife is how long a record of a job the step told launchd to remove can hold, counted
// in the time the Mac has been awake. launchd sends SIGKILL to the job's process when the
// job's exit timeout has passed (330 s in the agent's definition) and drops the job at once, so
// the removal is over by then. The stop limit is that and 30 seconds more, and the record is
// written before launchctl is asked, so it ages from just before launchd began. The two minutes
// added are for launchd to reap the process and drop the job, for a start that began just
// before the stop limit and waits a minute of its own, and for a clock that runs a little slow.
// A listing of the job after that is not one that was told to leave.
const leavingLife = serviceStopLimit + 2*time.Minute

// leavingJob is the record of the agent's job the step is telling launchd to remove. It is
// written before launchctl is asked, so that it is there whatever becomes of the step while
// launchctl waits for the agent to drain, and it says enough for a later run, which is a new
// process, to tell whether a listing of the job is that job.
type leavingJob struct {
	// PID is the process `print` listed for the job just before the bootout, and null when it
	// listed none ("unknown"): any listing of the job is then the job that was told to leave,
	// until `print` says that launchd has no such job.
	PID *int `json:"pid"`
	// Boot is the boot session of the Mac, empty when the system doesn't say; Awake is how long
	// the Mac had been awake, in nanoseconds, and 0 when the system doesn't say; At is the time
	// the record was written, by the wall clock.
	Boot  string    `json:"boot"`
	Awake int64     `json:"awake_ns"`
	At    time.Time `json:"at"`
}

func (h *macosUpdateHost) leavingPath() string {
	return filepath.Join(UpdateLocations().Private, updateLeavingFile)
}

// of says which process the record names, for an error: ", of the process 4242", or nothing
// when it names none.
func (r leavingJob) of() string {
	if r.PID == nil {
		return ""
	}
	return fmt.Sprintf(", of the process %d", *r.PID)
}

// listedIn says whether a listing of the agent's job is the job the record names: one that lists
// the process it had, or none, because launchd goes on listing a job as running while it
// removes it, and a job it removed leaves its process; or any listing at all when the record
// names no process. A listing of another process is a job that was started since. A listing that
// can't be read can't show that it is.
func (r leavingJob) listedIn(listing string) bool {
	printed, err := parseLaunchdPrint(listing)
	if err != nil {
		return true
	}
	return r.PID == nil || printed.PID == 0 || printed.PID == *r.PID
}

// rememberLeaving writes the record of the job launchd is about to be told to remove: pid is
// the process `print` listed for it, 0 when it listed none. It is on disk, synced, before this
// returns, and an error is the reason launchctl must not be asked: a bootout that nothing
// records can leave a job that the next run takes for a start.
func (h *macosUpdateHost) rememberLeaving(pid int) error {
	record := leavingJob{Boot: h.bootSession(), At: h.agent.now().UTC()}
	if pid > 0 {
		record.PID = &pid
	}
	if awake, known := h.uptime(); known && awake > 0 {
		record.Awake = int64(awake)
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err := AtomicWrite(h.leavingPath(), append(data, '\n')); err != nil {
		return fmt.Errorf("couldn't write the record of the agent's job before launchd is told to remove it, so launchctl wasn't asked to: %w", err)
	}
	return nil
}

// forgetLeaving removes the record: launchd says it doesn't know the job, or lists a job that
// was started since. A record that can't be removed is judged again by what it says (the boot,
// the age, the process it names) wherever it is read, so there is nothing to do about it
// here; a record that is left holds no longer than it would have.
func (h *macosUpdateHost) forgetLeaving() {
	_ = os.Remove(h.leavingPath())
}

// leavingRecord is the record of the job the step told launchd to remove, when there is one
// that still holds. A file that isn't a record is none: only the step writes it, in a directory
// only root can enter.
func (h *macosUpdateHost) leavingRecord() (leavingJob, bool) {
	record, ok := readLeavingJob(h.leavingPath())
	if !ok || !h.leavingHolds(record) {
		return leavingJob{}, false
	}
	return record, true
}

// leavingHolds says whether a record still names a job that launchd may be removing. A record
// from another boot session names a process of a Mac that was restarted since, and a restart
// sets the uptime back, so an uptime below the record's says the same where the boot session
// can't be read; neither is the job. Older than leavingLife is not either. Age is counted in
// the time the Mac has been awake, which a Mac that sleeps doesn't spend: a night with the lid
// shut in the middle of a stop doesn't age a record while the job is still being removed, and
// that age never runs ahead of the removal's, whether launchd's own timers stand still while the
// Mac sleeps or not. The wall clock stands in where the system doesn't say.
func (h *macosUpdateHost) leavingHolds(r leavingJob) bool {
	if !sameBoot(r.Boot, h.bootSession()) {
		return false
	}
	if awake, known := h.uptime(); known && r.Awake > 0 {
		if awake < time.Duration(r.Awake) {
			return false
		}
		return awake-time.Duration(r.Awake) <= leavingLife
	}
	return h.agent.now().Sub(r.At) <= leavingLife
}

// sameBoot says whether two boot sessions are one boot. A session the system didn't say, or two
// of different kinds (a UUID and a boot time, which the system gave at different moments), can't
// be told apart: they are taken for one boot, and the record holds as long as its age allows.
// Holding a record too long costs a wait that ends; dropping one early is what a record is for.
func sameBoot(recorded, now string) bool {
	if recorded == "" || now == "" {
		return true
	}
	kind, _, _ := strings.Cut(recorded, ":")
	nowKind, _, _ := strings.Cut(now, ":")
	return kind != nowKind || recorded == now
}

// readLeavingJob reads the record file, bounded and strictly: what isn't exactly what
// rememberLeaving writes is no record.
func readLeavingJob(path string) (leavingJob, bool) {
	file, err := os.Open(path)
	if err != nil {
		return leavingJob{}, false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1025))
	if err != nil || len(data) > 1024 {
		return leavingJob{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var record leavingJob
	if err := decoder.Decode(&record); err != nil {
		return leavingJob{}, false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return leavingJob{}, false
	}
	if record.At.IsZero() || (record.PID != nil && *record.PID <= 0) || record.Awake < 0 {
		return leavingJob{}, false
	}
	return record, true
}

// ReloadService loads the agent's job again when launchd doesn't know it, and says
// whether it did. A job that launchd lists needs nothing. This is for a job that went
// while a build was being tried (an administrator's bootout, or a removal that took the
// job with it): the trial goes on with the job loaded again.
func (h *macosUpdateHost) ReloadService(ctx context.Context) (bool, error) {
	result := h.agent.launchctl(ctx, launchdStatusLimit, "print", h.agent.target())
	if !launchdNotLoaded(result) {
		return false, nil
	}
	if err := h.StartService(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// ---------------------------------------------------------------- reading the agent's definition

// agentDefinition is what the step reads from the agent's launch daemon.
type agentDefinition struct {
	Account    string
	Executable string
	StateDir   string
}

// parseAgentDefinition reads the agent's definition: the account that runs it, and
// ProgramArguments, which must be exactly `<exe> run --state-dir <dir>`, the line
// setup writes for an executable and a state directory. There must be no Program
// key, which would run another file than the one the arguments name. A definition
// that is anything else isn't the one setup registered, and what it runs is no
// longer what the step replaces.
func parseAgentDefinition(text string) (agentDefinition, error) {
	var agent agentDefinition
	dict, err := parsePropertyList([]byte(text))
	if err != nil {
		return agent, fmt.Errorf("it isn't a property list the step reads: %v", err)
	}
	if label, _ := dict["Label"].(string); label != launchdLabel {
		return agent, fmt.Errorf("its label isn't %s", launchdLabel)
	}
	if _, found := dict["Program"]; found {
		return agent, errors.New("it names a Program, which would run another file than its arguments name")
	}
	agent.Account, _ = dict["UserName"].(string)
	if agent.Account == "" {
		return agent, errors.New("it doesn't name the account that runs it (UserName)")
	}
	arguments, _ := dict["ProgramArguments"].([]any)
	if len(arguments) != 4 || arguments[1] != "run" || arguments[2] != "--state-dir" {
		return agent, errors.New("its ProgramArguments aren't the line `vectory service-install` writes")
	}
	agent.Executable, _ = arguments[0].(string)
	agent.StateDir, _ = arguments[3].(string)
	for _, path := range []string{agent.Executable, agent.StateDir} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return agent, errors.New("its executable and state directory aren't clean absolute paths")
		}
	}
	// What setup writes for this account, executable and state directory must be
	// what is there: the same text for what identifies the service. Values setup
	// refuses to write can't be what it wrote.
	written, err := launchdPlist(agent.Executable, agent.StateDir, agent.Account)
	if err != nil || plistIdentity(text) != plistIdentity(written) {
		return agent, errors.New("it isn't the definition `vectory service-install` writes for that account, executable and state directory")
	}
	return agent, nil
}

// readAgentDefinition reads the agent's definition through the path check.
func (h *macosUpdateHost) readAgentDefinition() (agentDefinition, error) {
	text, err := readDefinition(h.agent.definition)
	if err != nil {
		return agentDefinition{}, err
	}
	return parseAgentDefinition(text)
}

// AgentExecutable is the executable the agent's definition runs. A definition that isn't
// there is errAgentNotRegistered.
func (h *macosUpdateHost) AgentExecutable() (string, error) {
	definition, err := h.readAgentDefinition()
	if notExist(err) {
		return "", fmt.Errorf("%w (%s doesn't exist)", errAgentNotRegistered, h.agent.definition)
	}
	if err != nil {
		return "", err
	}
	return definition.Executable, nil
}

var _ agentLocator = (*macosUpdateHost)(nil)

// Registered reads the agent's definition through the path check and says what it
// runs and as whom. The definition must be root's alone, name an account that
// exists, and run this state directory.
func (h *macosUpdateHost) Registered(stateDir string) (registeredService, error) {
	path := h.agent.definition
	definition, err := h.readAgentDefinition()
	switch {
	case notExist(err):
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "no agent service is registered (%s doesn't exist)", path)
	case err != nil:
		// A definition somebody other than root could have written is refused as
		// that; one that can't be read as the agent's is no service this step knows.
		var refusal *UpdateRefusal
		if errors.As(err, &refusal) {
			return registeredService{}, err
		}
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "%s isn't an agent service this step can update: %v", path, err)
	}
	if filepath.Clean(definition.StateDir) != filepath.Clean(stateDir) {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the registered service runs the state directory %s, not %s", definition.StateDir, stateDir)
	}
	account, err := user.Lookup(definition.Account)
	if err != nil {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the service account %s doesn't exist", definition.Account)
	}
	uid, uidErr := strconv.ParseUint(account.Uid, 10, 32)
	gid, gidErr := strconv.ParseUint(account.Gid, 10, 32)
	if uidErr != nil || gidErr != nil {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the service account %s has no numeric user and group", definition.Account)
	}
	return registeredService{
		Executable: definition.Executable, StateDir: definition.StateDir,
		Account: updateAccount{Name: definition.Account, UID: uint32(uid), GID: uint32(gid)},
	}, nil
}

// ---------------------------------------------------------------- what can't be updated

// PackageManaged says whether a package manager owns the executable: the installer
// package left its receipt, or the executable (with links resolved) is in a
// directory a package manager owns, Homebrew's among them.
func (h *macosUpdateHost) PackageManaged(executable string) (string, bool) {
	if directory, managed := underPackageDirectory(packageCandidates(executable), macosPackageDirectories); managed {
		return "it is under " + directory, true
	}
	if _, err := os.Lstat(h.receipt); err == nil {
		return "the installer package left its receipt (" + h.receipt + ")", true
	}
	return "", false
}

// StateDirReachable says yes: nothing hides a directory from a launch daemon that
// runs as root.
func (h *macosUpdateHost) StateDirReachable(string) error { return nil }

// OpenInstall opens the install directory and the executable, after the path check:
// a directory an administrator account owns refuses here, and /usr/local/bin is one
// on a Mac where Homebrew took it. That refusal says so, and what to do: the update
// step needs a directory only root can write, and Homebrew needs this one.
func (h *macosUpdateHost) OpenInstall(executable string) (updateInstall, error) {
	install, err := h.unixUpdateHost.OpenInstall(executable)
	return install, explainInstallRefusal(err)
}

// homebrewBinDir is the directory Homebrew on an Intel Mac makes its own.
const homebrewBinDir = "/usr/local/bin"

// explainInstallRefusal adds to the refusal of /usr/local/bin for belonging to
// an account other than root what a person on a Mac needs to know: Homebrew is why,
// and the agent belongs where only root can write. Every other error is returned as
// it is.
func explainInstallRefusal(err error) error {
	var refusal *UpdateRefusal
	if errors.As(err, &refusal) && refusal.Code == codeUntrustedLocation && strings.HasPrefix(refusal.Detail, homebrewBinDir+" belongs to uid ") {
		return untrustedLocation(refusal.Detail + " (Homebrew on an Intel Mac takes " + homebrewBinDir + "). Install the agent where only root can write")
	}
	return err
}

// ---------------------------------------------------------------- a small property list reader

// parsePropertyList reads an XML property list of the kinds a launch daemon's
// definition holds: a dict at the top, and in it strings, booleans, numbers,
// arrays and dicts. Strings become string, booleans bool, an array []any and a
// dict map[string]any; numbers, dates and data stay as their text, as plistScalar.
// A duplicate key, a value without a key, an element it doesn't know, nesting
// deeper than eight levels and more than 4096 elements are refused.
func parsePropertyList(data []byte) (map[string]any, error) {
	if len(data) > maxPlistFile {
		return nil, errRootOwnedTooLarge
	}
	reader := &plistReader{decoder: xml.NewDecoder(bytes.NewReader(data))}
	for {
		token, err := reader.decoder.Token()
		if err == io.EOF {
			return nil, errors.New("there is no <plist>")
		}
		if err != nil {
			return nil, err
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if start.Name.Local != "plist" {
			return nil, fmt.Errorf("it starts with <%s>, not <plist>", start.Name.Local)
		}
		first, err := reader.next()
		if err != nil {
			return nil, err
		}
		dict, ok := first.(map[string]any)
		if !ok {
			return nil, errors.New("its top level isn't a dict")
		}
		return dict, nil
	}
}

// plistScalar is a number, a date or data, kept as the text it was written as.
type plistScalar string

type plistReader struct {
	decoder  *xml.Decoder
	elements int
}

const (
	plistMaxDepth    = 8
	plistMaxElements = 4096
)

// next reads the next value inside the element the decoder is in: the first start
// element is the value.
func (r *plistReader) next() (any, error) {
	for {
		token, err := r.decoder.Token()
		if err != nil {
			return nil, err
		}
		switch t := token.(type) {
		case xml.StartElement:
			return r.value(t, 1)
		case xml.EndElement:
			return nil, errors.New("it has no value")
		}
	}
}

func (r *plistReader) value(start xml.StartElement, depth int) (any, error) {
	if depth > plistMaxDepth {
		return nil, errors.New("it nests too deeply")
	}
	if r.elements++; r.elements > plistMaxElements {
		return nil, errors.New("it has too many elements")
	}
	switch start.Name.Local {
	case "string":
		return r.text()
	case "integer", "real", "date", "data":
		text, err := r.text()
		return plistScalar(text), err
	case "true", "false":
		return start.Name.Local == "true", r.decoder.Skip()
	case "array":
		items := []any{}
		for {
			token, err := r.decoder.Token()
			if err != nil {
				return nil, err
			}
			switch t := token.(type) {
			case xml.StartElement:
				item, err := r.value(t, depth+1)
				if err != nil {
					return nil, err
				}
				items = append(items, item)
			case xml.EndElement:
				return items, nil
			}
		}
	case "dict":
		dict := map[string]any{}
		key, haveKey := "", false
		for {
			token, err := r.decoder.Token()
			if err != nil {
				return nil, err
			}
			switch t := token.(type) {
			case xml.StartElement:
				if t.Name.Local == "key" {
					if haveKey {
						return nil, fmt.Errorf("the key %q has no value", key)
					}
					text, err := r.text()
					if err != nil {
						return nil, err
					}
					if _, duplicate := dict[text]; duplicate {
						return nil, fmt.Errorf("the key %q is there twice", text)
					}
					key, haveKey = text, true
					continue
				}
				if !haveKey {
					return nil, errors.New("a value has no key")
				}
				item, err := r.value(t, depth+1)
				if err != nil {
					return nil, err
				}
				dict[key], haveKey = item, false
			case xml.EndElement:
				if haveKey {
					return nil, fmt.Errorf("the key %q has no value", key)
				}
				return dict, nil
			}
		}
	}
	return nil, fmt.Errorf("it holds <%s>, which a service definition doesn't", start.Name.Local)
}

// text reads the characters of the element the decoder is in, up to its end.
func (r *plistReader) text() (string, error) {
	var text strings.Builder
	for {
		token, err := r.decoder.Token()
		if err != nil {
			return "", err
		}
		switch t := token.(type) {
		case xml.CharData:
			text.Write(t)
		case xml.StartElement:
			return "", fmt.Errorf("<%s> inside a text", t.Name.Local)
		case xml.EndElement:
			return text.String(), nil
		}
	}
}
