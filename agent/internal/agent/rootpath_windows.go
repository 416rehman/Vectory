//go:build windows

package agent

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The path check on Windows. A path is opened one component at a time from the
// root of its drive, each with FILE_FLAG_OPEN_REPARSE_POINT so that a link is
// opened as the link and refused, and judged from its own handle: it is the
// directory or file that was asked for, its final path is the path that was asked
// for (so no alias, short name, substituted drive or mount point is on it), and
// its owner and access list belong to SYSTEM, the Administrators and
// TrustedInstaller alone (aclProblem, rootpath_acl.go, says what that means for
// each component).
//
// What keeps a component from changing between the check and the use is that
// rule, which refuses every directory above the one that holds the object if
// another account may delete, rename or take over what it holds, and the holder
// and the object if another account may change them at all. Every handle stays
// open besides, a directory with the right to list it and without delete sharing,
// so that nothing that respects sharing, root included, can rename or remove one
// of the directories while the value is in use. (A directory opened for its
// attributes and its access list alone is not subject to sharing at all, which is
// why the handles ask for the right to list.) Windows has no open-relative-to-a-
// handle call that Go exposes, so the *At methods name the entry inside the held
// directory by path, which nothing but root can change.

// ownerTrust says whose ownership and access entries pass the path check. The
// zero value is what ships: SYSTEM, the Administrators and TrustedInstaller.
type ownerTrust struct {
	// sid is one more account that passes. A test that builds its tree under
	// its own account's profile sets it to that account's SID.
	sid string
	// anchor is a directory that the check starts below: it and every directory
	// above it are opened and checked for links and aliases but their access
	// lists are not judged. A test sets it to the temporary directory it builds in.
	anchor string
	// unjudged says no access list is judged: the walk still refuses links, aliases
	// and the wrong kind of file. openPlainFile uses it.
	unjudged bool
}

// rootOwnedTrust is what openRootOwned checks against. It is the one seam of the
// path check: tests that need a tree they own assign it, and nothing else does,
// so the binary that ships always trusts root alone (see
// TestTheUpdateSeamsAreAssignedOnlyByTests).
var rootOwnedTrust ownerTrust

// judged reports whether the access list of the directory at path is judged.
func (t ownerTrust) judged(path string) bool {
	switch {
	case t.unjudged:
		return false
	case t.anchor == "":
		return true
	}
	anchor, here := strings.ToLower(t.anchor), strings.ToLower(path)
	return !(here == anchor || strings.HasPrefix(anchor, strings.TrimSuffix(here, `\`)+`\`))
}

// checkLocalPath accepts a clean path on a local drive.
func checkLocalPath(path string) error {
	if err := adoptionLocalPath(path); err != nil {
		return err
	}
	if filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
		return fmt.Errorf("%q isn't an absolute path with no . or .. or doubled separators", path)
	}
	return nil
}

// windowsPrefixes lists the root of a drive and every directory down to path:
// C:\, C:\ProgramData, C:\ProgramData\Vectory.
func windowsPrefixes(path string) []string {
	volume := filepath.VolumeName(path)
	prefixes := []string{volume + `\`}
	rest := strings.TrimPrefix(path[len(volume):], `\`)
	if rest == "" {
		return prefixes
	}
	current := volume
	for _, part := range strings.Split(rest, `\`) {
		current += `\` + part
		prefixes = append(prefixes, current)
	}
	return prefixes
}

// openComponent opens one directory or file for the check. A directory is opened
// to list it and to read its attributes and its access list, shared for reading
// and writing but not for deletion: another opener that asks to delete or rename
// it is refused while it is held. Without the right to list it the open would be
// outside sharing altogether, and nothing would be refused. A file is opened for
// reading, shared with readers and with a rename over it, so that a writer that
// replaces it atomically isn't kept waiting by a reader.
func openComponent(path string, want rootOwnedKind) (windows.Handle, error) {
	return openComponentWith(path, want, 0)
}

// openComponentWith is openComponent with more access: the caller that closes a
// directory's access list asks for the right to change it.
func openComponentWith(path string, want rootOwnedKind, more uint32) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	access := uint32(windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES) | more
	share := uint32(windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE)
	if want == rootOwnedFile {
		access |= windows.FILE_GENERIC_READ
		share = windows.FILE_SHARE_READ | windows.FILE_SHARE_DELETE
	} else {
		access |= windows.FILE_LIST_DIRECTORY
	}
	h, err := windows.CreateFile(name, access, share, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, &fs.PathError{Op: "open", Path: path, Err: err}
	}
	return h, nil
}

// finalPathOfHandle is the path the system gives an open handle, without the
// \\?\ prefix.
func finalPathOfHandle(h windows.Handle) (string, error) {
	buf := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if err != nil {
		return "", err
	}
	if n == 0 || n >= uint32(len(buf)) {
		return "", errors.New("the path of an open handle is too long to read")
	}
	return strings.TrimPrefix(windows.UTF16ToString(buf[:n]), `\\?\`), nil
}

// checkHandle refuses a handle that isn't the kind of object the path needs at
// that place, is a link, or is reached through another name.
func checkHandle(h windows.Handle, path string, want rootOwnedKind) error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return &fs.PathError{Op: "stat", Path: path, Err: err}
	}
	switch attributes := info.FileAttributes; {
	case attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0:
		return untrustedLocation(path + " is a symbolic link or a junction")
	case want == rootOwnedDirectory && attributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0:
		return untrustedLocation(path + " isn't a directory (it is a file)")
	case want == rootOwnedFile && attributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0:
		return untrustedLocation(path + " isn't a regular file (it is a directory)")
	}
	if want == rootOwnedFile {
		if kind, err := windows.GetFileType(h); err != nil || kind != windows.FILE_TYPE_DISK {
			return untrustedLocation(path + " isn't a regular file (it is a device or a pipe)")
		}
	}
	resolved, err := finalPathOfHandle(h)
	if err != nil {
		return &fs.PathError{Op: "resolve", Path: path, Err: err}
	}
	if !strings.EqualFold(filepath.Clean(resolved), path) {
		return untrustedLocation(path + " is reached through another name (" + resolved + ")")
	}
	return nil
}

// accountName is what a person reads for a SID: DOMAIN\name when the system
// knows the account, the SID otherwise.
func accountName(sid string) string {
	parsed, err := windows.StringToSid(sid)
	if err != nil {
		return sid
	}
	account, domain, _, err := parsed.LookupAccount("")
	if err != nil {
		return sid
	}
	if domain != "" {
		return domain + `\` + account
	}
	return account
}

// securityOf is who owns an open object and what its access list grants: the
// owning account's SID (empty when there is none), whether there is an access list
// at all, and its entries as aclProblem reads them.
type securityOf struct {
	owner   string
	hasACL  bool
	entries []aclEntry
}

// readSecurity reads the owning account and the access list from a handle.
func readSecurity(h windows.Handle, path string) (securityOf, error) {
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil || sd == nil {
		if err == nil {
			err = errors.New("no security descriptor")
		}
		return securityOf{}, &fs.PathError{Op: "read the access list of", Path: path, Err: err}
	}
	var found securityOf
	if owner, _, err := sd.Owner(); err == nil && owner != nil {
		found.owner = owner.String()
	}
	acl, _, aclErr := sd.DACL()
	found.hasACL = aclErr == nil && acl != nil
	if found.hasACL {
		for i := uint32(0); i < uint32(acl.AceCount); i++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			if err := windows.GetAce(acl, i, &ace); err != nil {
				return securityOf{}, &fs.PathError{Op: "read the access list of", Path: path, Err: err}
			}
			entry := aclEntry{Type: ace.Header.AceType, Flags: ace.Header.AceFlags, Mask: uint32(ace.Mask)}
			// Allow and deny entries share one layout. Any other kind has its
			// own, and the check refuses it without reading further.
			if entry.Type == windows.ACCESS_ALLOWED_ACE_TYPE || entry.Type == windows.ACCESS_DENIED_ACE_TYPE {
				entry.SID = (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
			}
			found.entries = append(found.entries, entry)
		}
	}
	return found, nil
}

// judgeHandle reads the owning account and the access list from a handle and
// refuses it, with UNTRUSTED_LOCATION, unless aclProblem finds nothing wrong.
func judgeHandle(h windows.Handle, path string, role windowsRole, trust ownerTrust) error {
	found, err := readSecurity(h, path)
	if err != nil {
		return err
	}
	if found.owner == "" {
		return untrustedLocation(path + " has no owner")
	}
	if problem := aclProblem(found.owner, found.hasACL, found.entries, role, trust.sid, accountName); problem != "" {
		return untrustedLocation(path + " " + problem)
	}
	return nil
}

// sddl is the security descriptor a made directory gets: the access leaf names
// for the last, and what the parent gives for the ones above.
func (c createSpec) sddl(last bool) string {
	if !last {
		return ""
	}
	return windowsSDDL(c.leaf, true, ServiceName)
}

func securityAttributes(sddl string) (*windows.SecurityAttributes, error) {
	if sddl == "" {
		return nil, nil
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, err
	}
	return &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}, nil
}

func makeDirectory(path, sddl string) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa, err := securityAttributes(sddl)
	if err != nil {
		return err
	}
	if err := windows.CreateDirectory(name, sa); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return &fs.PathError{Op: "mkdir", Path: path, Err: err}
	}
	return nil
}

// walkOwned opens path from the root of its drive, one component at a time. See
// the comment at the top of the file.
func walkOwned(path string, kind rootOwnedKind, trust ownerTrust, create *createSpec) (*rootOwned, error) {
	if err := checkLocalPath(path); err != nil {
		return nil, err
	}
	prefixes := windowsPrefixes(path)
	n := len(prefixes)
	if kind == rootOwnedFile && n < 2 {
		return nil, fmt.Errorf("%q isn't a file", path)
	}
	held := &rootOwned{path: path, trust: trust}
	fail := func(err error) (*rootOwned, error) {
		_ = held.Close()
		return nil, err
	}
	for i, prefix := range prefixes {
		last := i == n-1
		want, role := rootOwnedDirectory, windowsAbove
		switch {
		case last && kind == rootOwnedFile:
			want, role = rootOwnedFile, windowsObject
		case last, kind == rootOwnedFile && i == n-2:
			role = windowsHolds
		}
		h, err := openComponent(prefix, want)
		if err != nil && notExist(err) && create != nil && want == rootOwnedDirectory {
			if err = makeDirectory(prefix, create.sddl(last)); err == nil {
				h, err = openComponent(prefix, want)
			}
		}
		if err != nil {
			return fail(err)
		}
		if err := checkHandle(h, prefix, want); err != nil {
			_ = windows.CloseHandle(h)
			return fail(err)
		}
		if trust.judged(prefix) {
			if err := judgeHandle(h, prefix, role, trust); err != nil {
				_ = windows.CloseHandle(h)
				return fail(err)
			}
		}
		if want == rootOwnedFile {
			held.file = os.NewFile(uintptr(h), prefix)
		} else {
			held.handles = append(held.handles, h)
			held.dirPath = prefix
		}
	}
	return held, nil
}

// rootOwned is a path that was checked and is held open: every directory from
// the root of the drive down to the last, each held without delete sharing, and
// the file when the path names one. Its methods read and write the entries of the
// held directory.
type rootOwned struct {
	handles []windows.Handle
	file    *os.File
	path    string // as asked, for messages
	dirPath string // the held directory
	trust   ownerTrust
}

// openRootOwned opens path and checks every component of it: each directory
// from the root of the drive down must have no link and no alias on it, and
// must belong to SYSTEM, the Administrators or TrustedInstaller with no access
// entry that lets any other account change it (the rights are in aclProblem); a
// file must be a regular file with the same two properties. A path that fails is
// refused with UNTRUSTED_LOCATION and a detail that names the component and says
// why; a component that is missing is the system's own not-exist error.
func openRootOwned(path string, kind rootOwnedKind) (*rootOwned, error) {
	return walkOwned(path, kind, rootOwnedTrust, nil)
}

// ensureRootOwnedDir is openRootOwned for a directory, which it makes with any
// missing directory above it: the last with the access leaf names, the others
// with what their parent gives. A directory that exists is judged, never changed,
// with one exception: the directory the update directories are made in is closed
// to other accounts first (ensureUpdateRoot).
func ensureRootOwnedDir(path string, leaf rootFilePerm) (*rootOwned, error) {
	if err := ensureUpdateRoot(path); err != nil {
		return nil, err
	}
	return walkOwned(path, rootOwnedDirectory, rootOwnedTrust, &createSpec{leaf: leaf})
}

// openPlainFile opens a regular file that has no link or alias in its path. It
// judges no access list: the file may belong to anyone.
func openPlainFile(path string) (*os.File, error) {
	r, err := walkOwned(path, rootOwnedFile, ownerTrust{unjudged: true}, nil)
	if err != nil {
		return nil, err
	}
	file := r.file
	r.file = nil
	_ = r.Close()
	return file, nil
}

// canWriteRootOwned reports whether this process may write what openRootOwned
// trusts: it runs elevated, as an Administrator or as SYSTEM.
func canWriteRootOwned() bool {
	return rootOwnedTrust.sid != "" || windows.GetCurrentProcessToken().IsElevated()
}

// Path is the path as it was asked for.
func (r *rootOwned) Path() string { return r.path }

// directoryHandle is the handle of the held directory: the last directory of the
// path, which holds the file when the path names one.
func (r *rootOwned) directoryHandle() (windows.Handle, error) {
	if len(r.handles) == 0 {
		return 0, fmt.Errorf("%s holds no directory", r.path)
	}
	return r.handles[len(r.handles)-1], nil
}

// File is the held file, or nil when the path named a directory.
func (r *rootOwned) File() *os.File { return r.file }

// Close releases the handles.
func (r *rootOwned) Close() error {
	var first error
	if r.file != nil {
		first = r.file.Close()
		r.file = nil
	}
	for i := len(r.handles) - 1; i >= 0; i-- {
		if err := windows.CloseHandle(r.handles[i]); err != nil && first == nil {
			first = err
		}
	}
	r.handles = nil
	return first
}

// ReadFile reads the held file from its start, at most limit bytes: a longer
// file is refused. It can be called again.
func (r *rootOwned) ReadFile(limit int64) ([]byte, error) {
	if r.file == nil {
		return nil, fmt.Errorf("%s isn't a file", r.path)
	}
	data, err := readBounded(io.NewSectionReader(r.file, 0, math.MaxInt64), limit)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", r.path, err)
	}
	return data, nil
}

func (r *rootOwned) entryPath(name string) string {
	if strings.HasSuffix(r.dirPath, `\`) {
		return r.dirPath + name
	}
	return r.dirPath + `\` + name
}

// checkEntryName accepts one plain name in the directory (checkWindowsEntryName).
func checkEntryName(name string) error { return checkWindowsEntryName(name) }

// OpenAt opens a regular file of the held directory for reading, as the check
// opens the file of a path: no link, no alias, and SYSTEM's and the
// Administrators' alone.
func (r *rootOwned) OpenAt(name string) (*os.File, error) {
	if err := checkEntryName(name); err != nil {
		return nil, err
	}
	path := r.entryPath(name)
	h, err := openComponent(path, rootOwnedFile)
	if err != nil {
		return nil, err
	}
	if err := checkHandle(h, path, rootOwnedFile); err != nil {
		_ = windows.CloseHandle(h)
		return nil, err
	}
	if r.trust.judged(path) {
		if err := judgeHandle(h, path, windowsObject, r.trust); err != nil {
			_ = windows.CloseHandle(h)
			return nil, err
		}
	}
	return os.NewFile(uintptr(h), path), nil
}

// ReadFileAt reads a file of the held directory as OpenAt opens it, at most
// limit bytes.
func (r *rootOwned) ReadFileAt(name string, limit int64) ([]byte, error) {
	f, err := r.OpenAt(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := readBounded(io.NewSectionReader(f, 0, math.MaxInt64), limit)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", r.entryPath(name), err)
	}
	return data, nil
}

// moveOver renames from over to, retrying for a few seconds when another
// program has either open: a virus scanner holds a new file for a moment.
func moveOver(from, to string) error {
	f, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	t, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	for attempt := 0; ; attempt++ {
		err = windows.MoveFileEx(f, t, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
		if err == nil || attempt >= 25 || !(errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_ACCESS_DENIED)) {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// WriteFile replaces name in the held directory with data, so that a crash
// leaves the old file or the new one and never part of either: the bytes are
// written and flushed to a new file beside it, which is then renamed over it
// with write-through. The new file has exactly the access perm names, in an access
// list of its own that nothing is inherited into (windowsSDDL).
func (r *rootOwned) WriteFile(name string, data []byte, perm rootFilePerm) error {
	if err := checkEntryName(name); err != nil {
		return err
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	tmpName := "." + name + ".tmp-" + hex.EncodeToString(suffix[:])
	if len(tmpName) > 255 {
		return fmt.Errorf("%q is too long a name to replace", name)
	}
	tmpPath, finalPath := r.entryPath(tmpName), r.entryPath(name)
	tmp, err := windows.UTF16PtrFromString(tmpPath)
	if err != nil {
		return err
	}
	sa, err := securityAttributes(windowsSDDL(perm, false, ServiceName))
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(tmp, windows.GENERIC_WRITE, 0, sa, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return &fs.PathError{Op: "create", Path: tmpPath, Err: err}
	}
	f := os.NewFile(uintptr(h), tmpPath)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = moveOver(tmpPath, finalPath)
	}
	if err != nil {
		if removeErr := windows.DeleteFile(tmp); removeErr != nil && !errors.Is(removeErr, windows.ERROR_FILE_NOT_FOUND) {
			return fmt.Errorf("%w (and %v)", err, removeErr)
		}
		return err
	}
	return nil
}
