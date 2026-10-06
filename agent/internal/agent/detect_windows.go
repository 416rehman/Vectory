//go:build windows

package agent

import (
	"context"
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func platformDetails(ctx context.Context) (string, string) {
	v := windows.RtlGetVersion()
	return fmt.Sprintf("Windows %d.%d (build %d)", v.MajorVersion, v.MinorVersion, v.BuildNumber), "Windows services"
}

// SystemdAvailable is false on Windows.
func SystemdAvailable() bool { return false }

// windowsProcess is one entry of the process list.
type windowsProcess struct {
	pid, parent uint32
	name        string
}

// windowsProcesses lists every running process (a snapshot of the process
// table). The second result is false when the list can't be taken.
func windowsProcesses() ([]windowsProcess, bool) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, false
	}
	defer windows.CloseHandle(snapshot)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return nil, false
	}
	var out []windowsProcess
	for {
		out = append(out, windowsProcess{pid: entry.ProcessID, parent: entry.ParentProcessID, name: windows.UTF16ToString(entry.ExeFile[:])})
		if windows.Process32Next(snapshot, &entry) != nil {
			return out, true
		}
	}
}

// DetectRunningVector lists running Vector processes that no Vectory agent
// supervises: vector.exe processes that run a pipeline, other than the child of
// an agent's `__vector-host`. The second result is false when processes
// couldn't be listed.
func DetectRunningVector(ctx context.Context) ([]RunningVector, bool) {
	processes, ok := windowsProcesses()
	if !ok {
		return nil, false
	}
	byID := map[uint32]windowsProcess{}
	for _, process := range processes {
		byID[process.pid] = process
	}
	var services map[uint32]string
	var found []RunningVector
	for _, process := range processes {
		if !strings.EqualFold(process.name, "vector.exe") {
			continue
		}
		if info, err := readProcessInfo(process.pid); err == nil {
			if args := splitWindowsCommandLine(info.commandLine); len(args) > 0 && !runsPipeline(args[1:]) {
				continue
			}
		}
		// The child of an agent's `__vector-host` is already managed. The agent is
		// vectory.exe; its command line says so too, when this account may read it.
		if parent, ok := byID[process.parent]; ok {
			if strings.EqualFold(parent.name, "vectory.exe") {
				continue
			}
			if info, err := readProcessInfo(parent.pid); err == nil && strings.Contains(info.commandLine, "__vector-host") {
				continue
			}
		}
		running := RunningVector{PID: int(process.pid), Binary: processImagePath(process.pid)}
		if services == nil {
			services = runningServiceNames()
		}
		running.Service = services[process.pid]
		found = append(found, running)
	}
	return found, true
}

// processImagePath is the path of the executable a process runs, or "".
func processImagePath(pid uint32) string {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if windows.QueryFullProcessImageName(handle, 0, &buf[0], &size) != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:size])
}
