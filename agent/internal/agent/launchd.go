package agent

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
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
	// launchdStopPoll is how often a stop asks launchd whether it still knows the job.
	launchdStopPoll = 250 * time.Millisecond
)

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// launchdPlist is the agent's launch daemon definition. ExitTimeOut outlasts
// Vector's longest graceful drain, and Umask 63 (0077) keeps what the agent
// creates private, as in packaging/launchd/io.vectory.agent.plist.
func launchdPlist(exe, dir, account string) string {
	return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>` + launchdLabel + `</string><key>UserName</key><string>` + xmlText(account) + `</string><key>ProgramArguments</key><array><string>` + xmlText(exe) + `</string><string>run</string><string>--state-dir</string><string>` + xmlText(dir) + `</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>330</integer><key>AbandonProcessGroup</key><false/><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`
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
		if _, loaded := j.loaded(ctx); !loaded {
			return nil
		}
		return j.bootoutContext(ctx)
	}
	return errors.New("invalid service operation")
}

// bootout unloads the daemon and returns once it has stopped: once launchd no
// longer knows the job. launchd stops the agent, which drains Vector first (up
// to ExitTimeOut).
//
// launchctl bootout returns when launchd has begun to remove the job, not when it
// has: launchd's own log shows "removing service" about half a second after
// "bootout initiated", and until then launchctl print still lists the job with the
// process it is stopping. A start in that time finds a running job and leaves it
// alone, and the job is gone a moment later with nothing started. When the drain
// takes longer, launchctl stops waiting with 36 "Operation now in progress" while
// the job keeps stopping. Either way the stop is complete when print says the job
// is unknown.
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
			return launchctlFailure(args, result)
		}
	}
	for {
		// A real failure (the job isn't known) ends the wait; a timeout doesn't.
		if j.launchctl(ctx, launchdStatusLimit, "print", j.target()).status > 0 {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !j.now().Before(deadline) {
			return errors.New(j.name() + " is still stopping after " + humanDuration(serviceStopLimit) + "; check it with sudo launchctl print " + j.target())
		}
		j.sleep(launchdStopPoll)
	}
}
