package agent

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// Withdrawing consent is the same act wherever it is asked for: `vectory update
// off` and `vectory setup --updates off`. The policy says off (the pinned keys
// stay, so that turning updates on again with the same key needs no new pin), what
// the agent staged is deleted, and the privileged step is removed. It is refused
// while the step applies or tries a build, because taking the step away then could
// leave a build that was never proven in place of the one that was.

// UpdateWithdrawal is what withdrawing consent changed.
type UpdateWithdrawal struct {
	// PolicyOff: the policy now says off where it took updates (or couldn't be
	// read).
	PolicyOff bool
	// Discarded: the agent's directory of staged builds and requests was deleted.
	Discarded bool
	// StepRemoved: the privileged step was removed.
	StepRemoved bool
	// KeysKept is how many pinned keys the policy keeps.
	KeysKept int
}

// Nothing reports whether there was nothing to withdraw.
func (w UpdateWithdrawal) Nothing() bool { return !w.PolicyOff && !w.Discarded && !w.StepRemoved }

// Parts lists what was done, as clauses.
func (w UpdateWithdrawal) Parts() []string {
	var parts []string
	if w.PolicyOff {
		parts = append(parts, "the policy says off")
	}
	if w.Discarded {
		parts = append(parts, "the staged build is deleted")
	}
	if w.StepRemoved {
		parts = append(parts, "the update step is removed")
	}
	return parts
}

// line is the Updates step of setup after updates were turned off.
func (w UpdateWithdrawal) line() string {
	if w.Nothing() {
		return "off on this host"
	}
	parts := append([]string{"off"}, w.Parts()...)
	switch {
	case w.KeysKept == 1:
		parts = append(parts, "the pinned key is kept")
	case w.KeysKept > 1:
		parts = append(parts, "the pinned keys are kept")
	}
	return strings.Join(parts, " · ")
}

// saved says what a withdrawal that stopped halfway had already done.
func (w UpdateWithdrawal) saved() string {
	parts := w.Parts()
	if len(parts) == 0 {
		return "Nothing was changed."
	}
	return "Done so far: " + strings.Join(parts, ", ") + "."
}

// updateInProgress refuses while the privileged step applies or tries a build,
// naming when a trial ends. A step that never ran, or whose status can't be read,
// has nothing in progress that anyone can know of.
func updateInProgress() error {
	status, err := ReadUpdateStatus()
	if err != nil {
		return nil
	}
	return updateStageBusy(status)
}

// updateStageBusy is the error for a status that shows the step at work, or nil.
func updateStageBusy(status UpdateStatus) error {
	switch status.Stage {
	case UpdateStageTrial:
		if !status.Deadline.IsZero() {
			return fmt.Errorf("an update is being tried on this host; it ends by %s", humanClock(status.Deadline))
		}
		return errors.New("an update is being tried on this host; it ends within 5 minutes")
	case UpdateStagePreparing, UpdateStageSwapping:
		return errors.New("an update is being applied on this host; it takes a few minutes")
	case UpdateStageRollingBack:
		return errors.New("an update is being rolled back on this host; it takes a few minutes")
	}
	return nil
}

// WithdrawUpdates turns agent updates off on this host. dir is the agent's state
// directory. It needs root, and it never starts while an update is in progress.
func WithdrawUpdates(dir string) (UpdateWithdrawal, error) {
	return withdrawUpdates(dir, RemoveUpdateHelper)
}

// withdrawUpdates is WithdrawUpdates with the step's removal passed in.
func withdrawUpdates(dir string, removeStep func() error) (UpdateWithdrawal, error) {
	var done UpdateWithdrawal
	if err := updateInProgress(); err != nil {
		return done, err
	}
	paths := UpdateLocations()
	policy, basis, err := readUpdatePolicy(paths)
	switch {
	case errors.Is(err, ErrUpdatePolicyInvalid):
		// A policy no reader accepts says off already; replacing it makes that true
		// for the next person who reads it.
		if err := WriteUpdatePolicy(DefaultUpdatePolicy()); err != nil {
			return done, err
		}
		done.PolicyOff = true
	case err != nil:
		return done, err
	case basis != "" && policy.Consent != UpdateConsentOff:
		if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { p.Consent = UpdateConsentOff; return nil }); err != nil {
			return done, err
		}
		done.PolicyOff = true
	}
	done.KeysKept = len(policy.Keys)
	if dir != "" {
		discarded, err := removeUpdateExchange(UpdateExchangeFor(dir).Dir)
		if err != nil {
			return done, err
		}
		done.Discarded = discarded
	}
	if _, err := os.Lstat(paths.StepDir); err == nil {
		if err := removeStep(); err != nil {
			return done, err
		}
		done.StepRemoved = true
	}
	return done, nil
}

// removeUpdateExchange deletes the agent's directory of staged builds, requests
// and health records, and reports whether it was there. A link in its place is
// removed, never followed.
func removeUpdateExchange(path string) (bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if info.IsDir() {
		return true, os.RemoveAll(path)
	}
	return true, os.Remove(path)
}
