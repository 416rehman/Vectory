//go:build !windows

package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// The service account is a stranger to root's files: a private home or a
// binary installed under a restrictive umask keeps it from running Vector or
// the agent, and setup must say so instead of registering a broken service.
func TestAccountAccessNamesWhatBlocksTheServiceAccount(t *testing.T) {
	old := syscall.Umask(0)
	defer syscall.Umask(old)
	root := t.TempDir()
	for _, dir := range []string{filepath.Dir(root), root} {
		if err := os.Chmod(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	mk := func(dirMode, fileMode os.FileMode, name string) string {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Join(dir, "bin"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(dir, dirMode); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, "bin", "vector")
		if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), fileMode); err != nil {
			t.Fatal(err)
		}
		return path
	}
	stranger := "vectory-test-no-such-account"
	private := mk(0700, 0755, "home")
	if problem := accountAccessProblem(context.Background(), stranger, private, true, "--version"); !strings.Contains(problem, filepath.Join(root, "home")+" is private (mode 0700") {
		t.Fatalf("private home: %q", problem)
	}
	umask027 := mk(0755, 0750, "umask")
	if problem := accountAccessProblem(context.Background(), stranger, umask027, false, "version"); !strings.Contains(problem, umask027+" isn't executable for it (mode 0750") {
		t.Fatalf("umask 027 binary: %q", problem)
	}
	execOnly := mk(0755, 0711, "execonly")
	if problem := accountAccessProblem(context.Background(), stranger, execOnly, true, "--version"); !strings.Contains(problem, "isn't readable and executable") {
		t.Fatalf("unreadable Vector: %q", problem)
	}
	if problem := accountAccessProblem(context.Background(), stranger, execOnly, false, "version"); problem != "" {
		t.Fatalf("an executable agent was refused: %q", problem)
	}
	fine := mk(0755, 0755, "system")
	if problem := accountAccessProblem(context.Background(), stranger, fine, true, "--version"); problem != "" {
		t.Fatalf("a system-wide binary was refused: %q", problem)
	}
	// An existing account is asked for real, as root, when the bits say no:
	// nobody still can't enter a private directory.
	if os.Geteuid() == 0 {
		if nobody, ok := lookupAccountIDs("nobody"); ok {
			if !runsAs(context.Background(), nobody, fine, "--version") {
				t.Fatal("nobody could not run a system-wide binary")
			}
			if problem := accountAccessProblem(context.Background(), "nobody", private, false, "--version"); problem == "" {
				t.Fatal("nobody was allowed through a private directory")
			}
		}
	}
}
