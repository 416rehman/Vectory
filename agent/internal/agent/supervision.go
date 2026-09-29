package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const workloadCheckInterval = 5 * time.Second
const workloadStableInterval = time.Minute

var errWorkloadPaused = errors.New("local workload recovery paused before activation")

// workloadSupervisor is owned by Run's single goroutine, like Engine. It never
// races an apply transaction or performs network requests. Its timer is separate
// from heartbeat backoff; an in-flight bounded network/native call can delay it.
type workloadSupervisor struct {
	nextAttempt  time.Time
	healthySince time.Time
	attempts     int
}

func (e *Engine) observeProcessExit() error {
	// An adopted-but-never-started file is not evidence of a lost process.
	if !e.Settings.Adopted || e.State.LastGoodSHA256 == "" || e.Driver.Alive() {
		return nil
	}
	if e.State.ApplyState == "verification_unknown" && e.State.Error != nil && e.State.Error.Code == "PROCESS_EXITED" {
		return nil
	}
	// Retain the specific reason a local restart/recovery failed during backoff.
	// A newer candidate's validation error remains in ConfigurationAttempt instead.
	issue := e.State.Error
	if issue == nil || (issue.Stage != "startup" && issue.Stage != "recovery" && !(issue.Stage == "rollback" && (issue.Code == "ROLLBACK_FAILED" || issue.Code == "ROLLBACK_UNAVAILABLE"))) {
		issue = &Issue{Code: "PROCESS_EXITED", Stage: "observation", Message: "Owned Vector process is not running; local recovery waits for sync resume or its bounded retry interval"}
	}
	if e.State.ApplyState == "verification_unknown" && e.State.Error == issue {
		return nil
	}
	e.State.ApplyState, e.State.Error = "verification_unknown", issue
	// A different failed candidate keeps its original failure snapshot.
	e.observeVerifiedAttempt("verification_unknown", e.State.Error)
	return e.save()
}

func (s *workloadSupervisor) check(ctx context.Context, e *Engine) error {
	if ctx.Err() != nil || !e.Settings.Adopted || e.State.LastGoodSHA256 == "" {
		return nil
	}
	now := e.now()
	if e.Driver.Alive() {
		if s.healthySince.IsZero() {
			s.healthySince = now
		}
		// A child that repeatedly dies just after startup must not reset backoff.
		if now.Sub(s.healthySince) >= workloadStableInterval {
			s.attempts = 0
			s.nextAttempt = time.Time{}
		}
		return nil
	}
	s.healthySince = time.Time{}
	if err := e.observeProcessExit(); err != nil {
		return err
	}
	if e.paused() || now.Before(s.nextAttempt) {
		return nil
	}
	s.attempts = min(s.attempts+1, 6)
	defer func() {
		s.nextAttempt = e.now().Add(time.Duration(min(5<<s.attempts, 300)) * time.Second)
	}()
	// Startup transaction recovery runs before supervision. A still-unresolved
	// journal needs that recovery path, not a new startup over staged content.
	if _, err := os.Lstat(filepath.Join(e.Dir, "journal.json")); !os.IsNotExist(err) {
		return errors.New("local workload recovery waits for the unresolved apply journal; preserve state and inspect recovery diagnostics")
	}
	err := e.startExisting(ctx, true)
	if errors.Is(err, errWorkloadPaused) {
		return nil
	}
	if err == nil && e.Driver.Alive() {
		s.healthySince = e.now()
	}
	return err
}

func (s *workloadSupervisor) wait(ctx context.Context, e *Engine, delay time.Duration, report func(string)) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	tick := time.NewTicker(workloadCheckInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return true
		case <-tick.C:
			if err := s.check(ctx, e); err != nil {
				report(err.Error())
			}
			// A retry asked for on this host doesn't wait for the next
			// scheduled check-in.
			if _, err := os.Lstat(filepath.Join(e.Dir, retryRequestName)); err == nil {
				return true
			}
		}
	}
}

func (s *workloadSupervisor) poll(ctx context.Context, e *Engine, report func(string)) error {
	if err := s.check(ctx, e); err != nil {
		report(err.Error())
	}
	if err := e.renew(ctx); err != nil {
		report("Credential renewal failed; keeping the current workload")
	}
	// Renewal can consume its whole request deadline. Check local health before
	// starting a second outbound operation, without racing mutable Engine state.
	if err := s.check(ctx, e); err != nil {
		report(err.Error())
	}
	return e.Poll(ctx)
}
