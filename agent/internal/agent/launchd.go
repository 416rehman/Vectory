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
// stopped waiting while the job is still stopping.
const launchctlInProgress = 36

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
		if launchdNotLoaded(j.launchctl(ctx, launchdStatusLimit, "print", j.target())) {
			return nil
		}
		return j.bootoutContext(ctx)
	}
	return errors.New("invalid service operation")
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

// bootoutContext is bootout, which stops waiting when ctx ends.
func (j launchdJob) bootoutContext(ctx context.Context) error {
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
			return launchctlFailure(args, result)
		}
	}
	return j.waitUnloaded(ctx, deadline)
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
