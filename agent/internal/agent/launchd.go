package agent

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// launchdLabel is how launchd knows the agent on macOS. Its definition file
// carries the same name, packaged or written by setup, so installing both
// ways can't leave two definitions of one label.
const launchdLabel = "io.vectory.agent"

// launchctlInProgress is launchctl's "Operation now in progress": bootout
// stopped waiting while the job is still stopping. launchctlNoSuchProcess is "No such
// process": a bootout of a job that launchd no longer has, or that is already being
// removed.
const (
	launchctlInProgress    = 36
	launchctlNoSuchProcess = 3
)

const (
	launchctlLimit     = 30 * time.Second
	launchdStatusLimit = 5 * time.Second
	// launchdUnloadPoll is how often a stop looks again at whether launchd still
	// lists the job it was told to boot out.
	launchdUnloadPoll = 250 * time.Millisecond
)

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// plistText makes a value fit for a string of a definition, or refuses it: a value
// that isn't text, that holds a control character or that XML 1.0 can't carry
// would be changed on the way in (the XML escaper writes U+FFFD for NUL and for
// U+FFFE, and a control character is read back as another one), and what launchd read
// would not be what was meant. xmlText escapes the rest.
func plistText(what, value string) (string, error) {
	if value == "" || !utf8.ValidString(value) {
		return "", fmt.Errorf("%s isn't text a definition can hold", what)
	}
	for _, r := range value {
		if unicode.IsControl(r) || r == '\ufffe' || r == '\uffff' {
			return "", fmt.Errorf("%s holds a control or invalid character, so it isn't written into a definition", what)
		}
	}
	return xmlText(value), nil
}

// launchdPlist is the agent's launch daemon definition. ExitTimeOut outlasts
// Vector's longest graceful drain, and Umask 63 (0077) keeps what the agent
// creates private, as in packaging/launchd/io.vectory.agent.plist. A value that a
// definition can't hold as it is (plistText) is refused, never written changed.
func launchdPlist(exe, dir, account string) (string, error) {
	user, err := plistText("the service account", account)
	if err != nil {
		return "", err
	}
	program, err := plistText("the agent's executable", exe)
	if err != nil {
		return "", err
	}
	state, err := plistText("the agent's state directory", dir)
	if err != nil {
		return "", err
	}
	return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>` + launchdLabel + `</string><key>UserName</key><string>` + user + `</string><key>ProgramArguments</key><array><string>` + program + `</string><string>run</string><string>--state-dir</string><string>` + state + `</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>330</integer><key>AbandonProcessGroup</key><false/><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`, nil
}

// plistIdentity is what a definition must keep for setup to update it in
// place: the account and the program arguments (executable and state directory).
func plistIdentity(plist string) string {
	var keep []string
	for _, key := range []string{"UserName", "ProgramArguments"} {
		if m := regexp.MustCompile(`<key>` + key + `</key>(<string>[^<]*</string>|<array>.*?</array>)`).FindString(plist); m != "" {
			keep = append(keep, m)
		}
	}
	return strings.Join(keep, "")
}

// launchctlResult is one launchctl run: its exit status (-1 when it didn't
// run or was killed) and its output.
type launchctlResult struct {
	status         int
	stdout, stderr string
}

// launchdPrinted is what `launchctl print` says about a job that launchd knows.
type launchdPrinted struct {
	// State is launchd's word: "running", "not running", "waiting", "spawn
	// scheduled" and a few more.
	State string
	// PID is the process, 0 when there is none.
	PID int
	// Runs counts the times launchd has started the job since it loaded it.
	Runs int
	// LastExit is launchd's words for how the process last ended ("(never exited)",
	// "0", "78", "9: Killed: 9") and Reason why launchd started the job.
	LastExit, Reason string
}

// parseLaunchdPrint reads the top-level lines of `launchctl print system/<label>`:
//
//	system/io.vectory.agent = {
//		active count = 1
//		state = running
//		arguments = {
//			...
//		}
//		runs = 1
//		pid = 4242
//		...
//	}
//
// Only the lines directly inside the job's braces count: a block inside it
// (arguments, environment, endpoints) has lines of its own that look alike. A job
// with no state, or no count of its runs, is an error: a manager that doesn't say
// how often it started a job can't show that a build stayed up, and a build is
// never taken as healthy on a guess.
func parseLaunchdPrint(text string) (launchdPrinted, error) {
	var printed launchdPrinted
	var haveState, haveRuns bool
	depth := 0
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
			continue
		case line == "}":
			depth--
			continue
		case strings.HasSuffix(line, "{"):
			depth++
			continue
		}
		if depth != 1 {
			continue
		}
		key, value, ok := strings.Cut(line, " = ")
		if !ok {
			continue
		}
		switch key {
		case "state":
			printed.State, haveState = value, true
		case "pid":
			pid, err := strconv.Atoi(value)
			if err != nil || pid < 0 {
				return launchdPrinted{}, fmt.Errorf("launchctl print gave the pid %q", safeText(value, 40))
			}
			printed.PID = pid
		case "last exit code":
			printed.LastExit = safeText(value, 60)
		case "immediate reason":
			printed.Reason = safeText(value, 60)
		case "runs":
			runs, err := strconv.Atoi(value)
			if err != nil || runs < 0 {
				return launchdPrinted{}, fmt.Errorf("launchctl print gave the count of runs %q", safeText(value, 40))
			}
			printed.Runs, haveRuns = runs, true
		}
	}
	if !haveState {
		return launchdPrinted{}, errors.New("launchctl print didn't say what state the agent service is in")
	}
	if !haveRuns {
		return launchdPrinted{}, errors.New("launchctl print didn't say how often the agent service was started")
	}
	return printed, nil
}

// launchdJob drives a launch daemon through launchctl: the agent's, unless label
// names another (the update step's own, update_launchd.go). The command runner
// and the clock are fields, so the stop and restart logic is tested on every
// platform.
type launchdJob struct {
	// label is the job's name; empty means the agent's.
	label      string
	definition string
	run        func(ctx context.Context, args ...string) launchctlResult
	installed  func() bool
	now        func() time.Time
	sleep      func(time.Duration)
	// alive, when it is set, says whether a process is still there (kill with signal 0),
	// and a stop made by control waits for the process the job had to be gone as well as
	// for launchd to stop listing the job: that is what the agent's own service-stop and
	// service-uninstall do. The update step's host looks for the process itself, so its
	// jobs leave this unset.
	alive func(pid int) bool
	// accepted, when it is set, is told that launchd took a bootout of the job in hand
	// (it answered, or answered that it keeps removing the job), with the process the job
	// had, before the job is gone. The update step's host remembers it, because launchd
	// goes on listing the job as running until the removal is done.
	accepted func(pid int)
}

func (j launchdJob) name() string {
	if j.label != "" {
		return j.label
	}
	return launchdLabel
}

func (j launchdJob) target() string { return "system/" + j.name() }

func (j launchdJob) launchctl(ctx context.Context, limit time.Duration, args ...string) launchctlResult {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	return j.run(ctx, args...)
}

func launchctlFailure(args []string, result launchctlResult) error {
	message := "launchctl " + strings.Join(args, " ") + " failed"
	if detail := strings.TrimSpace(result.stderr); detail != "" {
		message += ": " + safeText(detail, 200)
	}
	return errors.New(message)
}

func (j launchdJob) do(ctx context.Context, limit time.Duration, args ...string) error {
	if result := j.launchctl(ctx, limit, args...); result.status != 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		return launchctlFailure(args, result)
	}
	return nil
}

// loaded reports whether launchd knows the job, with its description.
func (j launchdJob) loaded(ctx context.Context) (launchctlResult, bool) {
	result := j.launchctl(ctx, launchdStatusLimit, "print", j.target())
	return result, result.status == 0
}

// status asks launchd about the daemon without changing it.
func (j launchdJob) status(ctx context.Context) ServiceInfo {
	info := ServiceInfo{Manager: "launchd", Name: j.name()}
	if !j.installed() {
		return info
	}
	info.Installed = true
	info.State = "stopped"
	result, loaded := j.loaded(ctx)
	if !loaded {
		return info
	}
	for _, line := range strings.Split(result.stdout, "\n") {
		line = strings.TrimSpace(line)
		if value, ok := strings.CutPrefix(line, "state = "); ok {
			info.State = value
		} else if value, ok := strings.CutPrefix(line, "pid = "); ok {
			info.PID, _ = strconv.Atoi(value)
		}
	}
	info.Enabled = true
	return info
}

func (j launchdJob) control(action string) error {
	return j.controlContext(context.Background(), action)
}

// controlContext is control, which stops waiting when ctx ends: the privileged
// step stops and starts the agent through it.
func (j launchdJob) controlContext(ctx context.Context, action string) error {
	switch action {
	case "start":
		status := j.status(ctx)
		switch {
		case status.Running():
			return nil
		case status.Enabled:
			// Loaded but not running (crashed, throttled or spawn scheduled):
			// bootstrap would fail with an I/O error.
			return j.do(ctx, launchctlLimit, "kickstart", j.target())
		}
		return j.do(ctx, launchctlLimit, "bootstrap", "system", j.definition)
	case "restart":
		// kickstart -k stops the agent, which drains Vector within ExitTimeOut,
		// and starts it again from the loaded definition. Setup loads an
		// updated definition with stop and start instead.
		if _, loaded := j.loaded(ctx); loaded {
			return j.do(ctx, serviceStopLimit, "kickstart", "-k", j.target())
		}
		return j.do(ctx, launchctlLimit, "bootstrap", "system", j.definition)
	case "stop":
		// Only an answer that says launchd has no such job lets the stop skip the
		// bootout: a print that timed out or failed in another way says nothing about it.
		result := j.launchctl(ctx, launchdStatusLimit, "print", j.target())
		if launchdNotLoaded(result) {
			return nil
		}
		return j.bootoutFrom(ctx, j.listedPID(result))
	}
	return errors.New("invalid service operation")
}

// listedPID is the process of the job in an answer to `launchctl print`, or 0 when the
// answer lists none. It is only looked for where someone uses it: a job that waits for its
// process (alive) or tells what it took in hand (accepted).
func (j launchdJob) listedPID(result launchctlResult) int {
	if (j.alive == nil && j.accepted == nil) || result.status != 0 {
		return 0
	}
	printed, err := parseLaunchdPrint(result.stdout)
	if err != nil {
		return 0
	}
	return printed.PID
}

// launchdNotLoaded says that launchctl print found no such job: exit status 113,
// "Could not find service".
func launchdNotLoaded(result launchctlResult) bool {
	return result.status == 113 || strings.Contains(result.stderr, "Could not find service")
}

// bootout unloads the daemon and returns once launchd no longer knows it.
//
// launchctl bootout returns when launchd has begun to remove the job, not when it has
// finished: launchd's own log shows the removal about half a second after the command
// ended, and `launchctl print` lists the job as running until then. A caller that went
// on at once would meet the departing job: a start would take it for a running agent,
// and a bootstrap of its label can be refused, or accepted and dropped along with the
// job. The stop therefore ends when `launchctl print` says there is no such job.
//
// launchd stops the agent, which drains Vector first (up to ExitTimeOut). When that
// takes a while, launchctl stops waiting with 36 "Operation now in progress" while the
// job keeps stopping, and the stop waits all the same.
func (j launchdJob) bootout() error { return j.bootoutContext(context.Background()) }

// bootoutContext is bootout, which stops waiting when ctx ends. It doesn't know the
// process the job has, so it doesn't wait for one.
func (j launchdJob) bootoutContext(ctx context.Context) error {
	return j.bootoutFrom(ctx, 0)
}

// bootoutRefused is a bootout that launchd answered with an error: it didn't take the
// removal of the job in hand, and the job it was asked to remove is what it was. A
// bootout that launchd answered, or that it kept removing the job for, is not one.
type bootoutRefused struct{ error }

func (e bootoutRefused) Unwrap() error { return e.error }

// bootoutFrom boots the job out, waits until launchd no longer lists it and, when it has
// a way to look for a process and pid says which one the job had, until that process is
// gone: both within the stop limit.
func (j launchdJob) bootoutFrom(ctx context.Context, pid int) error {
	deadline := j.now().Add(serviceStopLimit)
	args := []string{"bootout", j.target()}
	result := j.launchctl(ctx, serviceStopLimit, args...)
	if result.status != 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		if result.status != launchctlInProgress && !strings.Contains(result.stderr, "Operation now in progress") {
			// A job that launchd no longer has needs no bootout: it is stopped.
			if launchdNotLoaded(j.launchctl(ctx, launchdStatusLimit, "print", j.target())) {
				return nil
			}
			failure := launchctlFailure(args, result)
			if result.status > 0 && result.status != launchctlNoSuchProcess {
				return bootoutRefused{failure}
			}
			if j.accepted != nil {
				// No answer, or "no such process" for a job that is still listed: it may be
				// leaving, so what the caller keeps for a job that is must be kept.
				j.accepted(pid)
			}
			return failure
		}
	}
	if j.accepted != nil {
		j.accepted(pid)
	}
	if err := j.waitUnloaded(ctx, deadline); err != nil {
		return err
	}
	return j.waitProcessGone(ctx, pid, deadline)
}

// waitProcessGone waits until the process the job had is gone: launchd lists a job that
// was booted out for a moment longer than it takes the process to end, and the process
// can outlast the listing.
func (j launchdJob) waitProcessGone(ctx context.Context, pid int, deadline time.Time) error {
	for pid > 0 && j.alive != nil && j.alive(pid) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !j.now().Before(deadline) {
			return fmt.Errorf("the process %d of %s is still there after launchd unloaded its job, and %s have passed", pid, j.name(), humanDuration(serviceStopLimit))
		}
		j.sleep(launchdUnloadPoll)
	}
	return nil
}

// waitUnloaded polls `launchctl print` until it says launchd has no such job. Only
// that answer ends the wait: a print that timed out or failed in another way doesn't
// show that the job is gone.
func (j launchdJob) waitUnloaded(ctx context.Context, deadline time.Time) error {
	for {
		if launchdNotLoaded(j.launchctl(ctx, launchdStatusLimit, "print", j.target())) {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !j.now().Before(deadline) {
			return errors.New(j.name() + " is still stopping after " + humanDuration(serviceStopLimit) + "; check it with sudo launchctl print " + j.target())
		}
		j.sleep(launchdUnloadPoll)
	}
}
