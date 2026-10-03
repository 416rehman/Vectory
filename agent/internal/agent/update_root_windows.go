//go:build windows

package agent

import (
	"errors"
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
// would never work on the host. The same account could make %ProgramData%\Vectory
// itself before the agent is installed, and the agent's state directory and its
// managed configuration, which are kept in it, would be inside a directory that
// account owns and can replace what is below.
//
// The directory they are all made in is therefore closed to every account but root
// before anything is made in it, whether setup is the one that makes it (with a
// descriptor of its own, owned by the Administrators; the agent's state directory and
// its managed configuration are made in the same directory, and whichever of them is
// made first makes it so) or an installation already has it, made earlier with what
// ProgramData gives a new folder. An existing directory is judged first, through a
// handle (state_root.go says what is done for each answer): one that belongs to root
// is closed; one that belongs to anyone else is not this code's to take, and is
// refused with the name of its owner.
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
	if !underWindowsRoot(path, root) {
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
// already closed is left alone, and so is one that another account owns: the walk
// that follows refuses that one with the name of its owner.
func closeDirectoryToOthers(path, sddl string) error {
	_, _, err := closeRoot(path, sddl)
	return err
}

// closeRoot makes the directory at path with sddl when it isn't there, opens what is
// there and judges it from the handle (stateRootFacts.decide for a process that can
// write what root owns), and closes it to everyone but root when it is root's and open.
// It says what it found, and who owned it: stateRootKeep for a directory that was
// closed, stateRootClose for one that was open and is closed now, stateRootRefuse for
// one that another account owns, which it changes in no way. The answer is about the
// directory that is there once the call returns, and not about what the call did: one
// that an account made between the failed open and the creation is the one that is
// judged.
func closeRoot(path, sddl string) (stateRootAction, string, error) {
	h, err := openComponent(path, rootOwnedDirectory)
	if notExist(err) {
		// An account that makes it first is not an error here: whatever is there is judged
		// through a handle below, so the answer never rests on who made it.
		if err = makeDirectory(path, sddl); err == nil {
			h, err = openComponent(path, rootOwnedDirectory)
		}
	}
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	if err := checkHandle(h, path, rootOwnedDirectory); err != nil {
		return 0, "", err
	}
	found, err := readSecurity(h, path)
	if err != nil {
		return 0, "", err
	}
	action := stateRootFacts{Kept: true, Elevated: true, Exists: true, Owner: found.owner, HasACL: found.hasACL, Entries: found.entries, Extra: rootOwnedTrust.sid}.decide()
	if action != stateRootClose {
		return action, found.owner, nil
	}
	// Root's, and open to others: the descriptor is changed through a second handle
	// that may write it, opened while the first still holds the directory in place.
	writable, err := openComponentWith(path, rootOwnedDirectory, windows.WRITE_DAC)
	if err != nil {
		return action, found.owner, fmt.Errorf("%s can be changed by others, and it can't be closed: %w", path, err)
	}
	defer func() { _ = windows.CloseHandle(writable) }()
	if err := checkHandle(writable, path, rootOwnedDirectory); err != nil {
		return action, found.owner, err
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return action, found.owner, err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return action, found.owner, err
	}
	if err := windows.SetSecurityInfo(writable, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		return action, found.owner, fmt.Errorf("%s can be changed by others, and it can't be closed: %w", path, err)
	}
	return action, found.owner, nil
}

// stateRootFor is the update root, when the state path (the agent's state directory,
// its managed configuration, or something below one of them) is kept in it in the
// sense of stateRootKept. A custom --state-dir elsewhere is not, and neither is a
// state directory that is the root itself, which an earlier layout used.
func stateRootFor(path string) (string, bool) {
	path = filepath.Clean(path)
	root, ok := updateRootFor(path)
	if !ok || !stateRootKept(path, root, Installed(root)) {
		return "", false
	}
	return root, true
}

// plainRefusal gives what a person reads for a refusal of the path check: the code
// is for what the update step reports.
func plainRefusal(err error) error {
	var refusal *UpdateRefusal
	if errors.As(err, &refusal) {
		return errors.New(refusal.Detail)
	}
	return err
}

// ensureStateRoot is what the code that makes or reuses the agent's state directory
// does first, for every install, whether or not updates are on: it makes the update
// root closed when it isn't there, closes it when root owns it and another account can
// add to it or change it, and refuses it, by its owner's name and before anything is
// written under it, when another account owns it (stateRootFacts.decide).
//
// A process that can't write what root owns (it isn't elevated) does none of it: it
// can't make the Administrators the owner of what it makes or change the list of a
// directory they own, and it may be a person's foreground agent that keeps its own
// directory there. makeSharedDirectory makes the directory for it with what ProgramData
// gives a new folder, as it always did, and the path check judges what it made when the
// update step looks.
func ensureStateRoot(path string) error {
	root, kept := stateRootFor(path)
	if (stateRootFacts{Kept: kept, Elevated: canWriteRootOwned()}).decide() == stateRootUntouched {
		return nil
	}
	if err := SafePath(path); err != nil {
		return err
	}
	action, owner, err := closeRoot(root, updateRootSDDL(ServiceName))
	if err != nil {
		return plainRefusal(err)
	}
	if action == stateRootRefuse {
		return &stateRootError{Path: root, Owner: ownerName(owner)}
	}
	return nil
}

// stateRootProblem is setup's first look at the update root for the state directory dir,
// which changes nothing: it says what ensureStateRoot would refuse, so that setup stops
// before it changes anything, and a dry run says so too. elevated is whether the process
// that will make the directories can write what root owns: one that can't refuses nothing.
func stateRootProblem(dir string, elevated bool) error {
	root, kept := stateRootFor(dir)
	facts := stateRootFacts{Kept: kept, Elevated: elevated, Extra: rootOwnedTrust.sid}
	if facts.decide() == stateRootUntouched {
		return nil
	}
	h, err := openComponent(root, rootOwnedDirectory)
	if notExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	if err := checkHandle(h, root, rootOwnedDirectory); err != nil {
		return plainRefusal(err)
	}
	found, err := readSecurity(h, root)
	if err != nil {
		return err
	}
	facts.Exists, facts.Owner, facts.HasACL, facts.Entries = true, found.owner, found.hasACL, found.entries
	if facts.decide() == stateRootRefuse {
		return &stateRootError{Path: root, Owner: ownerName(found.owner)}
	}
	return nil
}

// ownerName is the account that owns a directory as a person reads it, or "" when
// the system names none.
func ownerName(sid string) string {
	if sid == "" {
		return ""
	}
	return accountName(sid)
}
