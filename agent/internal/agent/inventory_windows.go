//go:build windows

package agent

import (
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc/mgr"
)

// The offsets of what is read from another process's memory, taken from the
// layouts x/sys/windows declares for the process environment block (PEB) and
// its process parameters. The addresses inside them belong to that process, so
// they are read as plain integers and never held as pointers.
const (
	pointerSize             = unsafe.Sizeof(uintptr(0))
	offsetProcessParameters = unsafe.Offsetof(windows.PEB{}.ProcessParameters)
	offsetCurrentDirectory  = unsafe.Offsetof(windows.RTL_USER_PROCESS_PARAMETERS{}.CurrentDirectory)
	offsetCommandLine       = unsafe.Offsetof(windows.RTL_USER_PROCESS_PARAMETERS{}.CommandLine)
	offsetEnvironment       = unsafe.Offsetof(windows.RTL_USER_PROCESS_PARAMETERS{}.Environment)
	offsetEnvironmentSize   = unsafe.Offsetof(windows.RTL_USER_PROCESS_PARAMETERS{}.EnvironmentSize)
	offsetStringLength      = unsafe.Offsetof(windows.NTUnicodeString{}.Length)
	offsetStringBuffer      = unsafe.Offsetof(windows.NTUnicodeString{}.Buffer)

	maxRemoteString      = 2 * windows.MAX_LONG_PATH
	maxRemoteEnvironment = 4 << 20
)

// processBasicInformation is PROCESS_BASIC_INFORMATION with every field a plain
// integer of the size Windows gives it on a 64-bit system.
type processBasicInformation struct {
	ExitStatus                   uintptr
	PebBaseAddress               uintptr
	AffinityMask                 uintptr
	BasePriority                 uintptr
	UniqueProcessID              uintptr
	InheritedFromUniqueProcessID uintptr
}

// remoteProcess is what a process's own parameters say about it.
type remoteProcess struct {
	commandLine      string
	currentDirectory string
	// environment is the process's environment when it could be read.
	environment      []string
	environmentKnown bool
}

// readRemote reads size bytes at an address of another process.
func readRemote(handle windows.Handle, address, size uintptr) ([]byte, error) {
	if address == 0 || size == 0 {
		return nil, errors.New("nothing to read")
	}
	buf := make([]byte, size)
	var read uintptr
	if err := windows.ReadProcessMemory(handle, address, &buf[0], size, &read); err != nil {
		return nil, err
	}
	if read != size {
		return nil, errors.New("the process memory was only partly readable")
	}
	return buf, nil
}

// remoteString reads the UNICODE_STRING that starts at offset in block, whose
// text lives in the other process's memory.
func remoteString(handle windows.Handle, block []byte, offset uintptr) string {
	length := uintptr(binary.LittleEndian.Uint16(block[offset+offsetStringLength:]))
	address := uintptr(binary.LittleEndian.Uint64(block[offset+offsetStringBuffer:]))
	if length == 0 || length > maxRemoteString {
		return ""
	}
	data, err := readRemote(handle, address, length)
	if err != nil {
		return ""
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(data[2*i:])
	}
	return windows.UTF16ToString(units)
}

// readProcessInfo reads a process's command line, current directory and
// environment from its process parameters. It needs the right to read that
// process's memory: the same account, or an administrator for most others.
func readProcessInfo(pid uint32) (remoteProcess, error) {
	if pointerSize != 8 {
		return remoteProcess{}, errors.New("process parameters are read only in 64-bit form")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ, false, pid)
	if err != nil {
		return remoteProcess{}, err
	}
	defer windows.CloseHandle(handle)
	var basic processBasicInformation
	if err := windows.NtQueryInformationProcess(handle, windows.ProcessBasicInformation, unsafe.Pointer(&basic), uint32(unsafe.Sizeof(basic)), nil); err != nil {
		return remoteProcess{}, err
	}
	pointer, err := readRemote(handle, basic.PebBaseAddress+offsetProcessParameters, pointerSize)
	if err != nil {
		return remoteProcess{}, err
	}
	parameters := uintptr(binary.LittleEndian.Uint64(pointer))
	block, err := readRemote(handle, parameters, offsetEnvironment+pointerSize)
	if err != nil {
		return remoteProcess{}, err
	}
	info := remoteProcess{
		commandLine:      remoteString(handle, block, offsetCommandLine),
		currentDirectory: remoteString(handle, block, offsetCurrentDirectory),
	}
	if len(info.currentDirectory) > 3 {
		info.currentDirectory = strings.TrimSuffix(info.currentDirectory, `\`)
	}
	if info.commandLine == "" {
		return remoteProcess{}, errors.New("the process has no command line")
	}
	if size, err := readRemote(handle, parameters+offsetEnvironmentSize, pointerSize); err == nil {
		length := uintptr(binary.LittleEndian.Uint64(size))
		address := uintptr(binary.LittleEndian.Uint64(block[offsetEnvironment:]))
		if length > 0 && length <= maxRemoteEnvironment {
			if data, err := readRemote(handle, address, length); err == nil {
				units := make([]uint16, len(data)/2)
				for i := range units {
					units[i] = binary.LittleEndian.Uint16(data[2*i:])
				}
				info.environment, info.environmentKnown = parseWindowsEnvironment(units), true
			}
		}
	}
	return info, nil
}

// runningServiceNames maps the process ids of running services to their names.
func runningServiceNames() map[uint32]string {
	names := map[uint32]string{}
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT|windows.SC_MANAGER_ENUMERATE_SERVICE)
	if err != nil {
		return names
	}
	defer windows.CloseServiceHandle(scm)
	var buf []byte
	var needed, returned uint32
	for {
		var first *byte
		if len(buf) > 0 {
			first = &buf[0]
		}
		err = windows.EnumServicesStatusEx(scm, windows.SC_ENUM_PROCESS_INFO, windows.SERVICE_WIN32, windows.SERVICE_ACTIVE, first, uint32(len(buf)), &needed, &returned, nil, nil)
		if err == nil {
			break
		}
		if err != syscall.ERROR_MORE_DATA || needed <= uint32(len(buf)) {
			return names
		}
		buf = make([]byte, needed)
	}
	if returned == 0 {
		return names
	}
	for _, service := range unsafe.Slice((*windows.ENUM_SERVICE_STATUS_PROCESS)(unsafe.Pointer(&buf[0])), int(returned)) {
		if pid := service.ServiceStatusProcess.ProcessId; pid != 0 && names[pid] == "" {
			names[pid] = windows.UTF16PtrToString(service.ServiceName)
		}
	}
	return names
}

// serviceDefinition reads how the service manager starts a service: the command
// line of its executable (ImagePath), and the selecting environment variables
// that its registry entry and the machine environment give it. The last result
// is false when either couldn't be read.
func serviceDefinition(name string) (string, map[string]string, bool) {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return "", nil, false
	}
	defer windows.CloseServiceHandle(scm)
	namePointer, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return "", nil, false
	}
	handle, err := windows.OpenService(scm, namePointer, windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		return "", nil, false
	}
	service := &mgr.Service{Name: name, Handle: handle}
	defer service.Close()
	config, err := service.Config()
	if err != nil {
		return "", nil, false
	}
	entries, machineKnown := machineEnvironment()
	own, ownKnown := serviceEnvironment(name)
	return config.BinaryPathName, selectedEnvironment(append(entries, own...), true), machineKnown && ownKnown
}

// machineEnvironment lists the machine-wide variables that select configuration.
func machineEnvironment() ([]string, bool) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`, registry.QUERY_VALUE)
	if err != nil {
		return nil, false
	}
	defer key.Close()
	names, err := key.ReadValueNames(-1)
	if err != nil {
		return nil, false
	}
	wanted := map[string]bool{}
	for _, name := range configEnvironment() {
		wanted[name] = true
	}
	var entries []string
	for _, name := range names {
		if wanted[strings.ToUpper(name)] {
			if value, _, err := key.GetStringValue(name); err == nil {
				entries = append(entries, name+"="+value)
			}
		}
	}
	return entries, true
}

// serviceEnvironment lists the variables a service's registry entry sets (a
// REG_MULTI_SZ value named Environment, which some service wrappers write).
func serviceEnvironment(name string) ([]string, bool) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\`+name, registry.QUERY_VALUE)
	if err != nil {
		return nil, false
	}
	defer key.Close()
	entries, _, err := key.GetStringsValue("Environment")
	if err == registry.ErrNotExist {
		return nil, true
	}
	return entries, err == nil
}

// collectStartup reads how one Vector process was started: its command line,
// current directory and environment from the process itself, and, when it is a
// service, the service manager's definition of it.
func collectStartup(ctx context.Context, running RunningVector) VectorStartup {
	startup := VectorStartup{PID: running.PID, Service: running.Service}
	if info, err := readProcessInfo(uint32(running.PID)); err == nil {
		startup.Command, startup.Source = splitWindowsCommandLine(info.commandLine), "process"
		startup.WorkDir = info.currentDirectory
		if info.environmentKnown {
			startup.Environment, startup.EnvironmentKnown = selectedEnvironment(info.environment, true), true
		}
	}
	if running.Service != "" {
		image, environment, known := serviceDefinition(running.Service)
		startup.ServiceCommand = parseImagePath(image)
		if !startup.EnvironmentKnown {
			startup.Environment, startup.EnvironmentKnown = environment, known
		}
	}
	if len(startup.Command) == 0 && len(startup.ServiceCommand) > 0 {
		startup.Command, startup.Source = startup.ServiceCommand, "service"
	}
	return startup
}
