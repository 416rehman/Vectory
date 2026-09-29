//go:build !windows

package main

import (
	"os"
	"os/signal"
	"slices"
	"syscall"
	"testing"
	"time"
)

// Closing the terminal hangs up a foreground command: it must stop the way
// Ctrl-C does (state saved, Vector drained), not die mid-write.
func TestClosingTheTerminalStopsACommandCleanly(t *testing.T) {
	ctx, stop := interruptible()
	defer stop()
	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("SIGHUP didn't stop the command")
	}
}

// Under nohup SIGHUP is ignored, and it stays ignored.
func TestAnIgnoredHangupStaysIgnored(t *testing.T) {
	signal.Ignore(syscall.SIGHUP)
	defer signal.Reset(syscall.SIGHUP)
	if slices.Contains(terminationSignals(), os.Signal(syscall.SIGHUP)) {
		t.Fatal("nohup's ignored SIGHUP would be caught again")
	}
}
