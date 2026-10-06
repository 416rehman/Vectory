package agent

import "strings"

// The flags of a file system that stop the update step from replacing the agent
// although the volume is writable: a file or a directory that is immutable or
// append-only. The step stops the agent's service, links the executable as the build it
// keeps and renames the new one over it, and either flag makes link(2) or rename(2)
// fail with EPERM after the service has stopped and the release's counter is spent:
// the old build starts again and the request ends as interrupted. So the step looks at
// the flags of the executable and of its directory before anything is raised or
// stopped, and refuses the host with READ_ONLY, the code for a directory the step can't
// write, naming the flag. unixInstall.Immutable reads them (Linux: the inode flags,
// through FS_IOC_GETFLAGS; macOS: st_flags); what each value means is decided here, on
// plain numbers, so that every case runs on every system.

// A flag that stops the step, as a person reads it.
type fileFlag struct {
	// Name says what the flag is and the command that sets it: "the immutable attribute
	// (chattr +i)".
	Name string
	// Clear is the command that clears it, which a person runs on the path.
	Clear string
}

// Linux inode flags (linux/fs.h).
const (
	linuxImmutableFlag = 0x00000010 // FS_IMMUTABLE_FL
	linuxAppendFlag    = 0x00000020 // FS_APPEND_FL
)

// macOS st_flags (sys/stat.h): the flags a file's owner may set, and the superuser's.
const (
	darwinUserImmutable   = 0x00000002 // UF_IMMUTABLE: uchg
	darwinUserAppend      = 0x00000004 // UF_APPEND: uappnd
	darwinSystemImmutable = 0x00020000 // SF_IMMUTABLE: schg
	darwinSystemAppend    = 0x00040000 // SF_APPEND: sappnd
)

// linuxFileFlags names the flags of a Linux inode that stop the step.
func linuxFileFlags(flags uint32) []fileFlag {
	var found []fileFlag
	if flags&linuxImmutableFlag != 0 {
		found = append(found, fileFlag{"the immutable attribute (chattr +i)", "sudo chattr -i"})
	}
	if flags&linuxAppendFlag != 0 {
		found = append(found, fileFlag{"the append-only attribute (chattr +a)", "sudo chattr -a"})
	}
	return found
}

// darwinFileFlags names the st_flags of a file or a directory on macOS that stop the
// step.
func darwinFileFlags(flags uint32) []fileFlag {
	var found []fileFlag
	for _, flag := range []struct {
		bit  uint32
		flag fileFlag
	}{
		{darwinUserImmutable, fileFlag{"the user immutable flag (chflags uchg)", "sudo chflags nouchg"}},
		{darwinUserAppend, fileFlag{"the user append-only flag (chflags uappnd)", "sudo chflags nouappnd"}},
		{darwinSystemImmutable, fileFlag{"the system immutable flag (chflags schg)", "sudo chflags noschg"}},
		{darwinSystemAppend, fileFlag{"the system append-only flag (chflags sappnd)", "sudo chflags nosappnd"}},
	} {
		if flags&flag.bit != 0 {
			found = append(found, flag.flag)
		}
	}
	return found
}

// immutableWords is the sentence for a path that has flags that stop the step: which
// path and flag, what the step can't do because of it, and the command that clears the
// flag. "" when there are none. effect finishes "so the update step can't ...".
func immutableWords(path, effect string, flags []fileFlag) string {
	if len(flags) == 0 {
		return ""
	}
	names := make([]string, len(flags))
	clears := make([]string, len(flags))
	for i, flag := range flags {
		names[i], clears[i] = flag.Name, flag.Clear+" "+ShellQuote(path)
	}
	return path + " has " + quoteList(names) + ", so the update step can't " + effect + ". Clear it first: " + strings.Join(clears, "; ")
}
