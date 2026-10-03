//go:build windows

package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Squatting. C:\ProgramData lets every account create entries, and the owner of
// what it creates is the account that made it, so a local user could make
// %ProgramData%\Vectory\updates or \update-state before setup does: the path check
// would then refuse that directory for good (it is not root's), and agent updates
// would never work on the host. The directory both are made in is therefore
// closed to every account but root before either is made, whether setup is the
// one that makes it (with a descriptor of its own, owned by the Administrators;
// the agent's state directory and its managed configuration are made in the same
// directory, and whichever of them is made first makes it so: makeSharedDirectory)
// or an installation that already has it, made earlier with what ProgramData gives
// a new folder. An existing directory is judged first: one that belongs to root is
// closed; one that belongs to anyone else is left for the path check to refuse,
// with the name of its owner, because it is not this code's to take.
//
// The directory is judged as strictly as the directories below it (windowsHolds): a
// folder that ProgramData's default entries let an account add to is open to a
// squatter, and a path that reaches the step's files through it is refused until it
// is closed. Setup's first look (untrustedPrefix) judges only who owns it, because
// setup closes it itself.

// updateRootFor is the directory the policy's and the step's directories are made
// in, when path is one of them or is below one of them and the locations in use
// are the system's own (a test that moves them builds a tree of its own).
func updateRootFor(path string) (string, bool) {
	paths := UpdateLocations()
	if paths != updateLocationsFor("windows", os.Getenv("ProgramData")) {
		return "", false
	}
	root := filepath.Dir(paths.StepDir)
	if !strings.EqualFold(filepath.Dir(paths.PolicyDir), root) {
		return "", false
	}
	lower, base := strings.ToLower(path), strings.ToLower(root)
	if lower != base && !strings.HasPrefix(lower, base+`\`) {
		return "", false
	}
	return root, true
}

// ensureUpdateRoot closes the directory the update directories are made in, if
// path is one of them or below one.
func ensureUpdateRoot(path string) error {
	root, ok := updateRootFor(path)
	if !ok {
		return nil
	}
	return closeDirectoryToOthers(root, updateRootSDDL(ServiceName))
}

// closeDirectoryToOthers makes the directory at path with the security descriptor
// sddl when it is not there, and closes it to everyone but root when it is and
// root owns it but another account can add entries to it or change it. It judges
// the directory from its handle, and changes its access list through the same
// handle, so that nothing can take its place in between. A directory that is
// already closed is left alone, and so is one that another account owns.
func closeDirectoryToOthers(path, sddl string) error {
	h, err := openComponent(path, rootOwnedDirectory)
	if notExist(err) {
		return makeDirectory(path, sddl)
	}
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	if err := checkHandle(h, path, rootOwnedDirectory); err != nil {
		return err
	}
	found, err := readSecurity(h, path)
	if err != nil {
		return err
	}
	if found.owner == "" || !rootAccount(found.owner, rootOwnedTrust.sid) {
		return nil
	}
	if aclProblem(found.owner, found.hasACL, found.entries, windowsHolds, rootOwnedTrust.sid, accountName) == "" {
		return nil
	}
	// Root's, and open to others: the descriptor is changed through a second handle
	// that may write it, opened while the first still holds the directory in place.
	writable, err := openComponentWith(path, rootOwnedDirectory, windows.WRITE_DAC)
	if err != nil {
		return fmt.Errorf("%s can be changed by others, and it can't be closed: %w", path, err)
	}
	defer func() { _ = windows.CloseHandle(writable) }()
	if err := checkHandle(writable, path, rootOwnedDirectory); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetSecurityInfo(writable, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		return fmt.Errorf("%s can be changed by others, and it can't be closed: %w", path, err)
	}
	return nil
}

// rootAccount reports whether a SID is SYSTEM, the Administrators or
// TrustedInstaller, or the one more account a test trusts.
func rootAccount(sid, extra string) bool {
	return sid == sidSystem || sid == sidAdministrators || sid == sidTrustedInstaller || (extra != "" && sid == extra)
}
