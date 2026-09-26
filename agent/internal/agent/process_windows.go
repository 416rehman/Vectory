//go:build windows

package agent

import (
	"golang.org/x/sys/windows"
	"os/exec"
	"unsafe"
)

func supervisorGuard() (func(), error) {
	job, e := windows.CreateJobObject(nil, nil)
	if e != nil {
		return nil, e
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, e = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); e != nil {
		windows.CloseHandle(job)
		return nil, e
	}
	if e = windows.AssignProcessToJobObject(job, windows.CurrentProcess()); e != nil {
		windows.CloseHandle(job)
		return nil, e
	}
	return func() { windows.CloseHandle(job) }, nil
}
func childPlatformOptions(cmd *exec.Cmd) {}
func stopChild(cmd *exec.Cmd)            { _ = cmd.Process.Kill() } // Windows forced termination is explicit; no lossless claim.
