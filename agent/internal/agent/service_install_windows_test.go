//go:build windows

package agent

import (
	"errors"
	"testing"

	"golang.org/x/sys/windows/svc/mgr"
)

type recoverySetupFailure struct {
	attempts int
	actions  []mgr.RecoveryAction
	reset    uint32
}

func (f *recoverySetupFailure) SetRecoveryActions(actions []mgr.RecoveryAction, reset uint32) error {
	f.attempts++
	if f.attempts == 1 {
		return errors.New("SCM refused recovery settings")
	}
	f.actions = append([]mgr.RecoveryAction(nil), actions...)
	f.reset = reset
	return nil
}

func TestRetryCompletesRecoveryAfterWindowsServiceCreation(t *testing.T) {
	// The service has already been created when the final SCM call fails. A
	// retry sees the same registration and must install recovery before it can
	// report success.
	service := &recoverySetupFailure{}
	registration, err := finishWindowsServiceRegistration(service, ServiceCreated)
	if err == nil || registration != "" || service.attempts != 1 {
		t.Fatalf("first registration: %q, %v, %d recovery calls", registration, err, service.attempts)
	}
	registration, err = finishWindowsServiceRegistration(service, ServiceUnchanged)
	if err != nil || registration != ServiceUnchanged || service.attempts != 2 {
		t.Fatalf("retry: %q, %v, %d recovery calls", registration, err, service.attempts)
	}
	if service.reset != 24*60*60 || len(service.actions) != len(agentServiceRestartDelays) {
		t.Fatalf("retry installed incomplete recovery policy: %+v, reset %d", service.actions, service.reset)
	}
	for i, action := range service.actions {
		if action.Type != mgr.ServiceRestart || action.Delay != agentServiceRestartDelays[i] {
			t.Errorf("recovery action %d: %+v", i, action)
		}
	}
}
