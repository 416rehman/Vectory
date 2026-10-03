package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// launchd keeps the step's standard error in a file and never shortens it; the step
// does, so that a host that waits for someone to apply an update doesn't fill a disk.
func TestTheStepsLogIsStartedAgainOnlyWhenItIsLongerThanItsLimit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a file opened for appending can't be shortened on Windows, and nothing keeps the step's log that way there: the step's own service starts its log again when it opens it")
	}
	open := func(size int) (*os.File, string) {
		path := filepath.Join(t.TempDir(), "step.log")
		if err := os.WriteFile(path, []byte(strings.Repeat("x", size)), 0o600); err != nil {
			t.Fatal(err)
		}
		// launchd opens it for appending.
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { f.Close() })
		return f, path
	}

	f, path := open(stepLogLimit)
	keepStepLogShort(f)
	if info, _ := os.Stat(path); info.Size() != stepLogLimit {
		t.Errorf("a log at its limit was shortened to %d bytes", info.Size())
	}

	f, path = open(stepLogLimit + 1)
	keepStepLogShort(f)
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "update step: this log passed 256 KiB and was started again\n" {
		t.Errorf("a log past its limit: %q, %v", data, err)
	}
	// What the step says next is written after it.
	if _, err := f.WriteString("update step: next\n"); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); !strings.HasSuffix(string(data), "was started again\nupdate step: next\n") {
		t.Errorf("after a line was added: %q", data)
	}

	// A pipe, which standard error is under a service manager that keeps it elsewhere,
	// is left alone.
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	keepStepLogShort(write)
}
