package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Withdrawing consent is the same act wherever it is asked for: `vectory update
// off` and `vectory setup --updates off`. The policy says off (the pinned keys
// stay, so that turning updates on again with the same key needs no new pin), what
// the agent staged is deleted, and the privileged step is removed. It is refused
// while the step applies or tries a build, because taking the step away then could
// leave a build that was never proven in place of the one that was.
//
// What the agent staged is deleted by root, from a directory the service account
// owns, so root deletes only through a path the service account can't change: the
// directory that holds the state directory must pass the root-owned path check.
// Where it doesn't, the withdrawal still takes the consent and the step away, and
// says that the staged files were left, which is for a person to delete.

// UpdateWithdrawal is what withdrawing consent changed.
type UpdateWithdrawal struct {
	// PolicyOff: the policy now says off where it took updates (or couldn't be
	// read).
	PolicyOff bool
	// Discarded: the agent's directory of staged builds and requests was deleted.
	Discarded bool
	// StagedLeft is set when that directory is there and was not deleted, because
	// the directory above the state directory could not be trusted with a delete
	// by root.
	StagedLeft *UpdateLeft
	// StepRemoved: the privileged step was removed.
	StepRemoved bool
	// RollbackEnded: the step was taking an update back and had put the previous build
	// in place, and was trying to start the agent's service, and the removal ended that
	// rollback: nothing tries to start the service now. It is what the removal did, never
	// what was expected of it when it was asked: a run of the step that ended the rollback
	// itself in between leaves it false.
	RollbackEnded bool
	// KeysKept is how many pinned keys the policy keeps.
	KeysKept int
}

// UpdateLeft says that the agent's staged files were left where they are, and why:
// root won't delete through a path that an account other than root can change.
type UpdateLeft struct {
	// Path is the directory of the agent's staged builds, requests and health
	// records.
	Path string
	// Code is UNTRUSTED_LOCATION, as for every refusal of the path check.
	Code string
	// Detail is what the path check found: the component that failed and why.
	Detail string
}

// Message says in words that the files were left, for a person to delete.
func (l UpdateLeft) Message() string {
	root := updateRootWord()
	return "The staged files in " + l.Path + " were not deleted: the directory above the agent's state isn't owned by " + root + ", so " + root + " won't delete through it. Delete them yourself."
}

// MarshalJSON writes what --json says about files that were left: where they are,
// the code and what the path check found, and the sentence a person reads.
func (l UpdateLeft) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Path    string `json:"path"`
		Code    string `json:"code"`
		Detail  string `json:"detail"`
		Message string `json:"message"`
	}{l.Path, l.Code, l.Detail, l.Message()})
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
	if w.RollbackEnded {
		parts = append(parts, "the rollback that was waiting for the agent's service to start is over")
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

// DoneSoFar says what a withdrawal that stopped halfway had already done, for the command that
// reports why it stopped, or "" when it had changed nothing: a command that is refused for what
// it finds before it changes anything has done nothing, and says no more than the refusal.
func (w UpdateWithdrawal) DoneSoFar() string {
	if len(w.Parts()) == 0 {
		return ""
	}
	return w.saved()
}

// updateInProgress refuses while the privileged step applies, tries or takes back a
// build, naming when a trial ends. A step that never ran, or whose status can't be read,
// has nothing in progress that anyone can know of. A rollback that has put the previous
// build back and only waits for the agent's service to start isn't one that refuses: the
// removal ends it (endRollbackWaitingForAStart). One whose start can't be made because the
// agent's service isn't registered refuses with the words that say so and what to run
// (rollbackWithoutRegistration). It is advice, given before anything is changed, and the
// removal decides again under the lock: what it refuses after the policy was turned off says
// what was done (the command that reports it uses DoneSoFar).
//
// A rollback is looked at through the step's lock (lockStepForRemoval, which waits for the run
// that is trying to start the previous build), because a rollback whose run is under way isn't
// waiting for a start: the step is putting the previous build back or watching it. wait says
// that it may: a dry run takes no lock and waits for nothing, and reads the journal as it is.
func updateInProgress(wait bool) error {
	status, err := ReadUpdateStatus()
	if err != nil {
		return nil
	}
	busy := updateStageBusy(status)
	if busy == nil || status.Stage != UpdateStageRollingBack {
		return busy
	}
	ends, refusal := removalOfARollback(wait)
	switch {
	case ends:
		return nil
	case refusal != nil:
		return refusal
	}
	return busy
}

// removalOfARollback says what a removal of the step would find in the rollback the step's
// journal holds: that it ends it, because the previous build is already in place and only its
// start is missing, or the refusal that says the agent's service isn't registered. Neither is
// the answer for a rollback that is mid-way or being watched. A run of the step that holds the lock
// for the whole wait is at work, and what it is doing decides nothing here: only a lock that was
// taken says that no run is, and so that the rollback only waits for a start. The registration
// doesn't need it: a service that isn't registered is as it is whatever the step does.
func removalOfARollback(wait bool) (ends bool, refusal error) {
	host := removalUpdateHost()
	if host == nil {
		return false, nil
	}
	private, err := openRootOwned(UpdateLocations().Private, rootOwnedDirectory)
	if err != nil {
		return false, nil
	}
	defer private.Close()
	idle := false
	if wait {
		if release, err := lockStepForRemoval(host, private); err == nil {
			defer release()
			idle = true
		}
	} else {
		// Without the lock, the service says what a run is doing, as lockStepForRemoval reads it: a
		// previous build that runs is being watched, and one that doesn't is waiting for its start.
		state, stateErr := host.ServiceState(context.Background())
		idle = stateErr != nil || !state.running()
	}
	journal, found, err := readUpdateJournal(private)
	if err != nil || !found || !journal.active() {
		return false, nil
	}
	if idle && rollbackWaitsForAStart(host, journal) {
		return true, nil
	}
	return false, rollbackWithoutRegistration(host, journal)
}

// UpdateBusyError says that an update is being applied, tried or taken back, so
// what it works on can't be withdrawn now. Its text says when that ends, where there
// is a time to say.
type UpdateBusyError struct{ Message string }

func (e *UpdateBusyError) Error() string { return e.Message }

// rollbackBusyWords is what a rollback in progress is, true of one that is putting the
// previous build back, of one that has put it back and waits for the agent's service to
// start, and of one that is watching the build it started: the journal says rolling_back
// through all three. It names no time at which that ends, because none is known: the step
// tries every 30 seconds until it can start the build, and the watch's five minutes begin
// when the build does.
const rollbackBusyWords = "an update is being rolled back on this host; the update step puts the previous build back and starts it, tries every 30 seconds until it can, and then watches it for up to 5 minutes"

// swapBusyWords is what an update is while the step has stopped, or is stopping, the agent's
// service to replace the executable: it goes on to the trial, or back to the build it had,
// and starts the service either way, so it is over when a start is shown, which the step
// tries every 30 seconds until it can. It names no time for the same reason.
const swapBusyWords = "an update is being applied on this host; the update step stops the agent's service, replaces the executable and starts the service again, and tries every 30 seconds if it can't"

// updateStageBusy is the error for a status that shows the step at work, or nil.
func updateStageBusy(status UpdateStatus) error {
	switch status.Stage {
	case UpdateStageTrial:
		if !status.Deadline.IsZero() {
			return &UpdateBusyError{fmt.Sprintf("an update is being tried on this host; it ends by %s", humanClock(status.Deadline))}
		}
		return &UpdateBusyError{"an update is being tried on this host; it ends within 5 minutes"}
	case UpdateStagePreparing:
		return &UpdateBusyError{"an update is being applied on this host; it takes a few minutes"}
	case UpdateStageSwapping:
		return &UpdateBusyError{swapBusyWords}
	case UpdateStageRollingBack:
		return &UpdateBusyError{rollbackBusyWords}
	}
	return nil
}

// WithdrawUpdates turns agent updates off on this host. dir is the agent's state
// directory. It needs root, and it never starts while an update is in progress.
func WithdrawUpdates(dir string) (UpdateWithdrawal, error) {
	return withdrawUpdatesReporting(dir, func() (bool, error) { return removeStepReporting(removalUpdateHost()) })
}

// withdrawUpdatesReporting is WithdrawUpdates with the step's removal passed in, which says
// whether it ended a rollback that waited for the agent's service to start.
func withdrawUpdatesReporting(dir string, removeStep func() (endedARollback bool, err error)) (UpdateWithdrawal, error) {
	var done UpdateWithdrawal
	if err := updateInProgress(true); err != nil {
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
		discarded, left, err := removeUpdateExchange(dir)
		if err != nil {
			return done, err
		}
		done.Discarded, done.StagedLeft = discarded, left
	}
	if _, err := os.Lstat(paths.StepDir); err == nil {
		ended, err := removeStep()
		done.RollbackEnded = ended
		if err != nil {
			return done, err
		}
		// The step is reported removed only when it is gone: a removal that returned
		// and left its directory is one that didn't happen.
		if _, err := os.Lstat(paths.StepDir); err == nil {
			return done, fmt.Errorf("the update step's directory %s is still there, so the step is not removed", paths.StepDir)
		}
		done.StepRemoved = true
	}
	return done, nil
}

// removeUpdateExchange deletes the agent's directory of staged builds, requests
// and health records (<state>/updates), as root, and reports whether it was there
// and was deleted. A link in its place is removed, never followed.
//
// os.RemoveAll finds the directory that holds the one it deletes by its name, and
// follows a link on the way. The state directory belongs to the service account,
// and where the directory that holds it can also be changed by that account (a
// state directory under a path that isn't root's), the account could put a link
// in the state directory's place and have root delete what the link names. So
// root deletes only when every component down to the directory that holds the
// state directory passes the root-owned path check: opened by handle, root's, and
// not writable by its group or by everyone (on Windows, by the rule of that
// check). Nothing but root can then change that path, and what is below it is
// removed without following a link. Where the check refuses, nothing is deleted
// and the answer says so: the staged files were left, for a person to delete. A
// state directory or a directory above it that isn't there holds nothing to
// delete, and is no refusal.
func removeUpdateExchange(state string) (deleted bool, left *UpdateLeft, err error) {
	path := UpdateExchangeFor(state).Dir
	// The check comes first, so that nothing that leads to a delete is decided on a
	// path that wasn't judged.
	problem := stateHolderProblem(state)
	info, err := os.Lstat(path)
	switch {
	case os.IsNotExist(err):
		return false, nil, nil
	case err != nil:
		return false, nil, err
	case problem != nil && notExist(problem):
		return false, nil, nil
	case problem != nil:
		return false, &UpdateLeft{Path: path, Code: codeUntrustedLocation, Detail: untrustedDetail(problem)}, nil
	case info.IsDir():
		return true, nil, os.RemoveAll(path)
	}
	return true, nil, os.Remove(path)
}

// stateHolderProblem is why root may not delete through the directory that holds
// the state directory, or nil when it may: the path check of that directory, which
// is judged as a whole path from the root of the file system.
func stateHolderProblem(state string) error {
	holder, err := filepath.Abs(filepath.Dir(state))
	if err != nil {
		return err
	}
	held, err := openRootOwned(holder, rootOwnedDirectory)
	if err != nil {
		return err
	}
	return held.Close()
}
