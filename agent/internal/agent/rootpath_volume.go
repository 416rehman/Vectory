package agent

import "fmt"

// The macOS side of the path check that looks at the volume, as plain values.
// rootpath_volume_darwin.go reads what fstatfs says of the file system that holds each
// handle the check holds, and volumeFacts.problem decides; keeping the decision free of
// macOS calls lets every case run on every platform, as the access list's does.
//
// Why the check reads it. A file's owner and mode decide who may change it only where
// the volume keeps owners. A volume mounted with MNT_IGNORE_OWNERSHIP (the default for
// an external disk and for a disk image a user attaches, and what `mount -o noowners`
// and the "Ignore ownership on this volume" setting make) hands every account but root
// an owner's rights on every file: the kernel reports the caller's own user as an owner
// of whatever it asks about (vnode_attr_handle_uid_and_gid in bsd/vfs/kpi_vfs.c), so the
// permission bits an owner has apply to it, while root sees whichever owner is on the
// disk. The check, which runs as root, then sees uid 0 and a mode that forbids writing,
// and passes, and the service account writes the file. An administrator who puts the
// agent's directory on such a volume (an install directory of one's own on an Intel Mac,
// say) would make the executable that root runs through `sudo vectory`, and the helper
// copy that launchd runs as root, writable by the service account. A volume that isn't
// local (MNT_LOCAL clear: a network share) gets its owners from another machine and can
// be changed behind the host's back, so it isn't trusted either.

// What a mounted volume says of itself in f_flags (bsd/sys/mount.h).
const (
	mountLocal           = 0x00001000 // MNT_LOCAL: the file system is stored on this machine
	mountIgnoreOwnership = 0x00200000 // MNT_IGNORE_OWNERSHIP, also MNT_UNKNOWNPERMISSIONS
)

// volumeFacts is what the check reads of the volume that holds a handle.
type volumeFacts struct {
	// flags is f_flags of fstatfs.
	flags uint32
	// mountedOn is where the volume is mounted (f_mntonname), for the message; "" when
	// it isn't known.
	mountedOn string
}

// problem says why the path may not be trusted because of the volume it is on, as the
// end of a sentence about the path ("is on the volume mounted at /Volumes/Tools, which
// ..."), or "" when the volume keeps owners and is local.
func (v volumeFacts) problem() string {
	where := "a volume"
	command := "sudo diskutil enableOwnership <the volume's mount point>"
	if v.mountedOn != "" {
		where = "the volume mounted at " + v.mountedOn
		command = "sudo diskutil enableOwnership " + ShellQuote(v.mountedOn)
	}
	switch {
	case v.flags&mountIgnoreOwnership != 0:
		return fmt.Sprintf("is on %s, which doesn't keep file owners (it is mounted with ownership ignored): the system treats every account as an owner of every file there, so nothing on it is root's alone. Put it on the system volume, or mount the volume with ownership on (%s)", where, command)
	case v.flags&mountLocal == 0:
		return fmt.Sprintf("is on %s, which isn't stored on this Mac (a network share, for one), so what it holds can be changed behind this host's back. Put it on the system volume", where)
	}
	return ""
}
