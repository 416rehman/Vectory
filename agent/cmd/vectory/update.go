package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"runtime"
	"strings"
	"time"

	"github.com/vectory/vectory/agent/internal/agent"
)

// updateEnv is everything `vectory update` does to the host and learns from it.
// The shipped command is built from the agent's own functions
// (productionUpdateEnv); a test builds one from fakes, so the command's words
// and exit codes are tested without writing under /etc.
type updateEnv struct {
	elevated func() bool
	now      func() time.Time
	// view reads what the host says about updates, and change edits the host's
	// policy as root.
	view   func(dir string, now time.Time) agent.UpdateView
	change func(edit func(*agent.UpdatePolicy) error) error
	// withdraw turns updates off, and apply runs the privileged step's work in the
	// foreground, saying each stage it reaches.
	withdraw func(dir string) (agent.UpdateWithdrawal, error)
	apply    func(ctx context.Context, dir string, force bool, progress func(string)) error
}

func productionUpdateEnv() updateEnv {
	return updateEnv{
		elevated: agent.Elevated,
		now:      time.Now,
		view:     agent.ReadUpdateView,
		change:   agent.ChangeUpdatePolicy,
		withdraw: agent.WithdrawUpdates,
		apply:    agent.ApplyStagedUpdate,
	}
}

// updateCommand is `vectory update`: where agent updates stand on this host, and
// the few things a person here can do about them.
var updateCommand = newUpdateCommand(productionUpdateEnv())

func newUpdateCommand(env updateEnv) command {
	return command{
		name:    "update",
		group:   "Day to day",
		summary: "Show, apply, pause or turn off agent updates on this host",
		usage:   "update <verb> [flags]",
		about: `A host takes agent updates only when it consented to them, once, in the setup
command that installed or upgraded it (--updates). These verbs show where
updates stand on this host and let someone here hold them back, take them over
or turn them off. The dashboard can't change what this host consented to. Every
verb but status needs root (an Administrator on Windows).`,
		examples: []string{
			"sudo vectory update status",
			"sudo vectory update apply",
			"sudo vectory update pause",
			"sudo vectory update off",
		},
		verbs: []command{
			{name: "status", summary: "Show what this host consented to and where an update stands",
				usage: "update status [--state-dir PATH] [--json]",
				about: `Shows the level this host takes updates at, the version track, the windows an
update may start in and the release keys it pins, whether it can take an update
and why not, what the privileged update step did last, a build the agent
staged, and how the last update ended. Reads only. It needs root when the
state directory is private to the agent's account, as it is on a default
install.`,
				examples: []string{"sudo vectory update status", "sudo vectory update status --json"},
				define:   env.defineStatus},
			{name: "apply", summary: "Apply the staged update now (hosts that ask first)",
				usage: "update apply [--force] [--state-dir PATH] [--json]",
				about: `For a host that asks first: applies the build the agent staged now, in the
foreground, through the same update step, and prints each step. Before it starts
it shows what the agent last reported about the offer and how old that is.
When the report says the offer was withdrawn (a paused or cancelled rollout, or
Stop all updates) or is more than 5 minutes old, it refuses. --force then asks
you to confirm on a terminal, and refuses without one. That check is advice
only: whatever you confirm, the update step verifies the signed release, the
pinned keys and this host's policy again before it installs anything.`,
				examples: []string{"sudo vectory update apply"},
				define:   env.defineApply},
			{name: "pause", summary: "Stop downloading and applying updates until you resume",
				usage: "update pause [--state-dir PATH] [--json]",
				about: `Keeps what this host consented to and stops every download and apply until
you run update resume. It takes effect at the agent's next check-in, with no
restart. A build the update step is already applying finishes.`,
				examples: []string{"sudo vectory update pause"},
				define:   env.definePause(true)},
			{name: "resume", summary: "Take updates again after a pause",
				usage: "update resume [--state-dir PATH] [--json]",
				about: `Lifts a pause set with update pause. The agent downloads and applies updates
again at its next check-in, inside its window if it has one. vectory pause, which
holds back every change on this host, is separate.`,
				examples: []string{"sudo vectory update resume"},
				define:   env.definePause(false)},
			{name: "off", summary: "Withdraw this host's consent and remove the update step",
				usage: "update off [--state-dir PATH] [--json]",
				about: `Withdraws this host's consent: the policy says off, the build the agent staged
is deleted and the privileged update step is removed. The pinned keys are kept.
It refuses while an update is being applied or tried, and says when that ends.
The Upgrade agent command with --updates turns updates on again.`,
				examples: []string{"sudo vectory update off"},
				define:   env.defineOff},
		},
	}
}

// needRoot refuses, with the command to run, when this process can't change what
// only root may. It reports whether the verb may go on.
func (e updateEnv) needRoot(c *cli, verb string) (int, bool) {
	if e.elevated() {
		return exitOK, true
	}
	how := "Run it with sudo: "
	if runtime.GOOS == "windows" {
		how = "Run it from an elevated PowerShell: "
	}
	return c.fail(errors.New("this changes what only an administrator can change. " + how + agent.AdminCommandFor(*c.state, "vectory update "+verb))), false
}

func printUpdateRows(w io.Writer, rows []agent.UpdateRow) {
	for _, row := range rows {
		fmt.Fprintf(w, "%-12s %s\n", row.Label, row.Value)
	}
}

func (e updateEnv) defineStatus(c *cli) func() int {
	c.StateDir()
	c.JSON("Print one JSON document")
	return func() int {
		if err := agent.CheckInstalled(*c.state); err != nil {
			return c.fail(err)
		}
		view := e.view(*c.state, e.now())
		if *c.json {
			c.output(agent.UpdateStatusJSON(view))
			return exitOK
		}
		printUpdateRows(c.stdout, view.Rows())
		return exitOK
	}
}

func (e updateEnv) defineApply(c *cli) func() int {
	c.StateDir()
	force := c.Bool("force", "Apply although the agent's last report says the offer is gone or is more than 5 minutes old; asks you to confirm on a terminal")
	c.JSON("Print one JSON document")
	return func() int {
		if code, ok := e.needRoot(c, "apply"); !ok {
			return code
		}
		dir := *c.state
		if err := agent.CheckInstalled(dir); err != nil {
			return c.fail(err)
		}
		view := e.view(dir, e.now())
		if err := applyBlocker(dir, view); err != nil {
			return c.fail(err)
		}
		human := !*c.json
		advice := view.Advice()
		what := "the staged build"
		if view.Staged.Version != "" {
			what = view.Staged.Version
		}
		if human {
			fmt.Fprintf(c.stdout, "Staged: %s (%s), offered %s.\n", what, agentByteSize(view.Staged.Size), view.Staged.OfferedAt.Local().Format("2 Jan 15:04"))
			fmt.Fprintln(c.stdout, advice.Words(view.Staged.Version))
		}
		forced := false
		if advice.Refuses() {
			advisory := " This check is advice: the update step verifies the signed release, the pinned keys and this host's policy again before it installs anything."
			if !*force {
				return c.fail(errors.New("not applying. " + advice.Words(view.Staged.Version) + advisory + " If you know the offer stands, run it again with --force."))
			}
			answer, terminal := c.ask("Apply it anyway? [y/N] ")
			if !terminal {
				return c.fail(errors.New("not applying: there is no terminal to ask on, and --force needs your answer. Check in the dashboard that the rollout still includes this host, then run the command from a terminal."))
			}
			if answer = strings.ToLower(answer); answer != "y" && answer != "yes" {
				return c.fail(errors.New("not applied"))
			}
			forced = true
		}
		ctx, stop := interruptible()
		defer stop()
		progress := func(step string) {
			if human {
				fmt.Fprintln(c.stdout, "  "+step)
			}
		}
		if err := e.apply(ctx, dir, forced, progress); err != nil {
			return c.fail(err)
		}
		// What happened is what the update step recorded, never what this command
		// assumes: a build that was applied and a build that was taken back are
		// both a return without an error.
		after := e.view(dir, e.now())
		outcome, words := "", ""
		if after.Status != nil && after.Status.Last != nil && after.Status.Last.Release == view.Staged.ManifestSHA256 {
			outcome = after.Status.Last.Outcome
			words, _ = after.LastResultWords()
		}
		if *c.json {
			c.output(map[string]any{"status": map[bool]string{true: "ok", false: "failed"}[outcome == "" || outcome == agent.UpdateOutcomeCommitted], "command": "update apply", "outcome": nullable(outcome), "result": nullable(words), "forced": forced})
		}
		switch outcome {
		case "":
			if human {
				fmt.Fprintf(c.stdout, "Done. %s shows how it went.\n", agent.AdminCommandFor(dir, "vectory update status"))
			}
		case agent.UpdateOutcomeCommitted:
			if human {
				fmt.Fprintf(c.stdout, "Updated: %s.\nThe dashboard shows this device as updated once the server has seen the new build check in.\n", words)
			}
		default:
			if human {
				fmt.Fprintf(c.stderr, "vectory: %s.\n", words)
			}
			return exitFailed
		}
		return exitOK
	}
}

func nullable(text string) any {
	if text == "" {
		return nil
	}
	return text
}

// agentByteSize writes a size as people read it.
func agentByteSize(n int64) string {
	switch {
	case n <= 0:
		return "size unknown"
	case n < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(n)/1024/1024)
}

// applyBlocker says why there is nothing for apply to apply, or nil.
func applyBlocker(dir string, view agent.UpdateView) error {
	switch {
	case view.PolicyProblem != "":
		return errors.New("the update policy can't be used (" + view.PolicyProblem + "), so this host takes no update")
	case view.Policy.Consent == agent.UpdateConsentOff:
		return errors.New("updates are off on this host. Turn them on with the Upgrade agent command from the dashboard")
	case view.Policy.Paused:
		return errors.New("updates are paused on this host. Resume them first: " + agent.AdminCommandFor(dir, "vectory update resume"))
	case view.LocalPaused:
		return errors.New("vectory pause holds back every change on this host, updates included. Resume it first: " + agent.AdminCommandFor(dir, "vectory resume"))
	case view.Staged == nil:
		return errors.New("nothing is staged on this host. The agent stages a build when an update rollout reaches it; " + agent.AdminCommandFor(dir, "vectory update status") + " shows where things stand")
	case !view.Staged.Complete:
		return errors.New("the staged build isn't complete: the agent is still downloading it. Try again in a minute")
	}
	return nil
}

func (e updateEnv) definePause(pause bool) func(c *cli) func() int {
	return func(c *cli) func() int {
		c.StateDir()
		c.JSON("Print one JSON document")
		verb := map[bool]string{true: "pause", false: "resume"}[pause]
		return func() int {
			if code, ok := e.needRoot(c, verb); !ok {
				return code
			}
			dir := *c.state
			view := e.view(dir, e.now())
			if view.PolicyProblem != "" {
				return c.fail(errors.New("the update policy can't be used (" + view.PolicyProblem + "), so this host takes no update"))
			}
			say := func(changed bool, message string) int {
				if *c.json {
					paused := view.Policy.Paused
					if changed {
						paused = pause
					}
					c.output(map[string]any{"status": "ok", "command": "update " + verb, "changed": changed, "paused": paused})
				} else {
					fmt.Fprintln(c.stdout, message)
				}
				return exitOK
			}
			switch {
			case view.Policy.Consent == agent.UpdateConsentOff:
				return say(false, "Agent updates are off on this host, so there is nothing to "+verb+". The Upgrade agent command with --updates turns them on.")
			case view.Policy.Paused == pause:
				return say(false, map[bool]string{true: "Updates are already paused. Nothing changed.", false: "Updates aren't paused. Nothing changed."}[pause])
			}
			if err := e.change(func(p *agent.UpdatePolicy) error { p.Paused = pause; return nil }); err != nil {
				return c.fail(err)
			}
			if pause {
				return say(true, "Paused. The agent stops downloading and applying agent updates at its next check-in; no restart is needed. A build the update step is already applying finishes.\nResume with: "+agent.AdminCommandFor(dir, "vectory update resume"))
			}
			message := "Resumed. At its next check-in the agent downloads and applies updates again" + map[bool]string{true: ", inside its window.", false: "."}[len(view.Policy.Windows) > 0]
			if view.LocalPaused {
				message += "\nvectory pause is also in force and still holds updates back: " + agent.AdminCommandFor(dir, "vectory resume")
			}
			return say(true, message)
		}
	}
}

func (e updateEnv) defineOff(c *cli) func() int {
	c.StateDir()
	c.JSON("Print one JSON document")
	return func() int {
		if code, ok := e.needRoot(c, "off"); !ok {
			return code
		}
		done, err := e.withdraw(*c.state)
		var busy *agent.UpdateBusyError
		if errors.As(err, &busy) {
			return c.fail(errors.New(busy.Error() + ". Run the command again after that"))
		}
		if err != nil {
			return c.fail(err)
		}
		if *c.json {
			c.output(map[string]any{"status": "ok", "command": "update off", "changed": !done.Nothing(), "policy_off": done.PolicyOff, "discarded": done.Discarded, "step_removed": done.StepRemoved, "keys_kept": done.KeysKept})
			return exitOK
		}
		if done.Nothing() {
			fmt.Fprintln(c.stdout, "Agent updates are already off on this host. Nothing changed.")
			return exitOK
		}
		fmt.Fprintf(c.stdout, "Agent updates are off on this host: %s.\n", strings.Join(done.Parts(), ", "))
		if done.KeysKept > 0 {
			fmt.Fprintf(c.stdout, "The pinned %s kept. To turn updates on again, run the Upgrade agent command with --updates.\n", map[bool]string{true: "key is", false: "keys are"}[done.KeysKept == 1])
		}
		return exitOK
	}
}
