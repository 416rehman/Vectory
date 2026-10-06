//go:build windows

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// RunProbe runs `version --json` of the build at path, with the time limit the
// step allows (updateProbeTimeout). Windows has no switch of account that
// doesn't need the account's password, so the probe runs as the step does: as
// LocalSystem under the service, as the administrator who runs `vectory setup` or
// `vectory update apply` otherwise. No restricted token is built, and the network
// and the file system stay open to it. What bounds it is the time, the size of its
// output, a clean environment, the system's directory as its working directory, and
// a job object that ends it with everything it started (runProbe). The build is the
// verified copy of the step's own, in the probe directory, which only SYSTEM and the
// Administrators can write, and what it prints decides nothing but whether the step
// goes on.
func (h *windowsUpdateHost) RunProbe(ctx context.Context, path string, account updateAccount) ([]byte, error) {
	return runProbe(ctx, path, updateProbeTimeout)
}

// probeKilled is the exit code of the processes of a job that is ended.
const probeKilled = 1

// runProbe runs the build from a directory of the system's, with a clean environment
// and nothing on standard input, in a job object of its own (probeJobLimits), ends it
// and everything it started when the time is up or the step is stopped, and reads its
// output to at most 4 KiB, dropping the rest without blocking the writer.
//
// The build is made suspended and put in the job before its first thread runs, so
// that it can't start a process that isn't in the job. The standard library makes a
// process and gives no way to put it in a job as it is made, and keeps no handle of
// its first thread, so the process is created suspended (CREATE_SUSPENDED), assigned
// through the handle the library holds for it, and then let run by resuming the one
// thread it has. A build that can't be put in the job is not run: it is ended and the
// probe fails, because a probe that ran outside its job would be one the job doesn't
// bound.
//
// The job is closed when the probe returns, and that ends whatever the build left
// running (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).
func runProbe(ctx context.Context, path string, limit time.Duration) ([]byte, error) {
	runCtx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	job, err := newJob(probeJobLimits())
	if err != nil {
		return nil, fmt.Errorf("couldn't make the job the build runs in: %w", err)
	}
	defer job.close()

	cmd := exec.CommandContext(runCtx, path, "version", "--json")
	cmd.Dir = systemDirectory()
	cmd.Env = cleanEnvironment()
	output := &boundedOutput{limit: updateProbeOutput}
	cmd.Stdout = output
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_SUSPENDED}
	// The time is up, or the step is stopped: everything in the job ends, and the build
	// itself when it isn't in the job yet. Whichever of the two finds the build ended
	// already says so in words that mean nothing here.
	cmd.Cancel = func() error {
		ended := job.end()
		killed := cmd.Process.Kill()
		if ended == nil || killed == nil || errors.Is(killed, os.ErrProcessDone) {
			return nil
		}
		return killed
	}
	cmd.WaitDelay = 2 * time.Second
	err = cmd.Start()
	if err == nil {
		if err = job.adopt(cmd.Process); err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			err = fmt.Errorf("it couldn't be put in a job of its own before it ran: %w", err)
		} else {
			err = cmd.Wait()
		}
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		if runCtx.Err() != nil {
			return nil, fmt.Errorf("the build didn't finish within %s", limit)
		}
		if errors.Is(err, exec.ErrWaitDelay) {
			return nil, errors.New("the build left a process running after it ended")
		}
		return nil, fmt.Errorf("the build failed: %w", err)
	}
	if output.overflow {
		return nil, errProbeOutputTooLong
	}
	return output.buffer.Bytes(), nil
}

// job is a job object: a set of processes the system keeps together, with limits.
type job struct{ handle windows.Handle }

// newJob makes a job object with the limits given. Its handle is not inheritable, so
// nothing a process starts holds it open.
func newJob(limits jobLimits) (*job, error) {
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = limits.Flags
	info.BasicLimitInformation.ActiveProcessLimit = limits.ActiveProcesses
	if _, err := windows.SetInformationJobObject(handle, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	return &job{handle: handle}, nil
}

// end ends every process in the job now.
func (j *job) end() error { return windows.TerminateJobObject(j.handle, probeKilled) }

// close lets go of the job. The system ends every process that is still in it.
func (j *job) close() { _ = windows.CloseHandle(j.handle) }

// adopt puts a process that was made suspended in the job and lets it run, through the
// handle the library holds for it, which stays that process's until the library lets
// go of it, so a process id can't be another's meanwhile.
func (j *job) adopt(process *os.Process) error {
	var assigned error
	if err := process.WithHandle(func(handle uintptr) {
		assigned = windows.AssignProcessToJobObject(j.handle, windows.Handle(handle))
	}); err != nil {
		return err
	}
	if assigned != nil {
		return fmt.Errorf("assigning it to the job: %w", assigned)
	}
	return resumeNewProcess(uint32(process.Pid))
}

// resumeNewProcess lets the one thread of a process that was made suspended run. The
// library closes the handle of that thread when it makes the process, so the thread
// is found from the list of the system's threads by the id of the process, which no
// other process can have while the library holds the handle of this one. The thread
// has been suspended once, and is let run once: a thread that was suspended more than
// that, or not at all, is not what the step made.
func resumeNewProcess(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fmt.Errorf("listing the threads of the system: %w", err)
	}
	defer func() { _ = windows.CloseHandle(snapshot) }()
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	if err := windows.Thread32First(snapshot, &entry); err != nil {
		return fmt.Errorf("listing the threads of the system: %w", err)
	}
	resumed := 0
	for {
		if entry.OwnerProcessID == pid {
			if err := resumeThread(entry.ThreadID); err != nil {
				return err
			}
			resumed++
		}
		err := windows.Thread32Next(snapshot, &entry)
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			break
		}
		if err != nil {
			return fmt.Errorf("listing the threads of the system: %w", err)
		}
	}
	if resumed == 0 {
		return errors.New("it has no thread to let run")
	}
	return nil
}

// resumeThread lets a thread that was made suspended run.
func resumeThread(id uint32) error {
	thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, id)
	if err != nil {
		return fmt.Errorf("opening its thread: %w", err)
	}
	defer func() { _ = windows.CloseHandle(thread) }()
	previous, err := windows.ResumeThread(thread)
	if err != nil {
		return fmt.Errorf("letting its thread run: %w", err)
	}
	if previous != 1 {
		return fmt.Errorf("its thread had been suspended %d times, not once", previous)
	}
	return nil
}

// systemDirectory is Windows's own directory of programs, which only root can
// write: a build that is asked its version has no business anywhere else.
func systemDirectory() string {
	if dir, err := windows.GetSystemDirectory(); err == nil && dir != "" {
		return dir
	}
	if root := os.Getenv("SystemRoot"); root != "" {
		return root + `\System32`
	}
	return `C:\Windows\System32`
}
