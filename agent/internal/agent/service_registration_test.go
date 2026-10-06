package agent

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestServiceRegistrationRetryFinishesAfterDefinitionWasWritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vectory.service")
	const desired = "ExecStart=/usr/bin/vectory run\n"
	writes, reconciles := 0, 0
	write := func() error {
		writes++
		return AtomicWrite(path, []byte(desired))
	}
	reconcile := func() error {
		reconciles++
		if reconciles == 1 {
			return errors.New("service manager did not load the new definition")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if string(data) != desired {
			return errors.New("service manager was given the wrong definition")
		}
		return nil
	}
	registration, err := finishServiceRegistration(ServiceCreated, write, reconcile)
	if err == nil || registration != "" || writes != 1 || reconciles != 1 {
		t.Fatalf("first registration: %q, %v; writes %d, reconciles %d", registration, err, writes, reconciles)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != desired {
		t.Fatalf("failed manager reload did not leave the written definition for a retry: %q, %v", data, err)
	}
	registration, err = finishServiceRegistration(ServiceUnchanged, write, reconcile)
	if err != nil || registration != ServiceUnchanged || writes != 1 || reconciles != 2 {
		t.Fatalf("retry: %q, %v; writes %d, reconciles %d", registration, err, writes, reconciles)
	}
}
