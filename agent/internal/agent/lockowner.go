package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

// lockOwnerOffset is where the lock holder records itself in agent.lock. The
// first bytes are the ones Windows locks; past them, another process can read
// the record while the lock is held.
const lockOwnerOffset = 16

// LockOwner is the process that holds the agent lock, as it recorded itself.
type LockOwner struct {
	PID int `json:"pid"`
	// Command is the vectory command it runs: run, setup, install...
	Command string `json:"command"`
}

// recordLockOwner writes this process into the held lock file. Best effort:
// the record only explains a refusal, it never decides one.
func recordLockOwner(f *os.File) {
	command := ""
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	data, err := json.Marshal(LockOwner{PID: os.Getpid(), Command: safeText(command, 32)})
	if err != nil {
		return
	}
	if f.Truncate(lockOwnerOffset) == nil {
		_, _ = f.WriteAt(append(data, '\n'), lockOwnerOffset)
	}
}

// clearLockOwner removes the record before the lock is released, so no
// later reader names a process that has let go.
func clearLockOwner(f *os.File) { _ = f.Truncate(lockOwnerOffset) }

// readLockOwner is the recorded holder of dir's agent lock while that
// process still runs; nil when unknown.
func readLockOwner(dir string) *LockOwner {
	f, err := os.Open(filepath.Join(dir, "agent.lock"))
	if err != nil {
		return nil
	}
	defer f.Close()
	buf := make([]byte, 256)
	n, _ := f.ReadAt(buf, lockOwnerOffset)
	record, _, _ := bytes.Cut(buf[:n], []byte("\n"))
	var owner LockOwner
	if json.Unmarshal(bytes.TrimSpace(record), &owner) != nil || owner.PID <= 0 || !processAlive(owner.PID) {
		return nil
	}
	return &owner
}

// LockHeldError refuses a command that needs the agent stopped (install,
// uninstall --purge, configure-*, re-adopt) while it runs, and says which
// process holds the state directory and how to stop it.
type LockHeldError struct {
	StateDir string
	Owner    *LockOwner
	// Service is the name of the registered service running this state
	// directory, when that is the holder.
	Service string
}

func lockHeld(dir string) *LockHeldError {
	e := &LockHeldError{StateDir: dir, Owner: readLockOwner(dir)}
	if service := ServiceStatus(context.Background()); service.Running() && (service.StateDir == "" || filepath.Clean(service.StateDir) == filepath.Clean(dir)) &&
		(e.Owner == nil || service.PID == 0 || service.PID == e.Owner.PID) {
		e.Service = service.Name
		if e.Owner == nil && service.PID > 0 {
			e.Owner = &LockOwner{PID: service.PID, Command: "run"}
		}
	}
	return e
}

func (e *LockHeldError) Error() string {
	sudo := "sudo "
	kill := "sudo kill "
	if runtime.GOOS == "windows" {
		sudo, kill = "", "Stop-Process -Id "
	}
	pid := func() string {
		if e.Owner == nil {
			return ""
		}
		return ", pid " + strconv.Itoa(e.Owner.PID)
	}
	switch {
	case e.Service != "":
		return fmt.Sprintf("The agent service is running (%s%s), and this command needs the agent stopped. Stop it with `%svectory service-stop`, run this command again, then start it with `%svectory service-start`.", e.Service, pid(), sudo, sudo)
	case e.Owner != nil && (e.Owner.Command == "run" || e.Owner.Command == "service"):
		return fmt.Sprintf("The agent is running (vectory %s%s), and this command needs it stopped. Stop it with Ctrl-C where it runs, or `%s%d`; run this command again, then start the agent again.", e.Owner.Command, pid(), kill, e.Owner.PID)
	case e.Owner != nil && e.Owner.Command != "":
		return fmt.Sprintf("Another vectory command is using %s (vectory %s%s). Wait for it to finish, then run this command again.", e.StateDir, e.Owner.Command, pid())
	}
	return fmt.Sprintf("The agent or another vectory command is using %s. Stop the agent (`%svectory service-stop`, or Ctrl-C where `vectory run` runs) or wait for the other command, then run this command again.", e.StateDir, sudo)
}
