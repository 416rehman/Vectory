package agent

import (
	"fmt"
	"strings"
)

// The directory the agent keeps its own directories in under ProgramData on
// Windows. %ProgramData%\Vectory holds the agent's state directory and its managed
// configuration (by default), and the update policy's and the update step's
// directories, so one rule covers them all: it belongs to SYSTEM, the Administrators
// or TrustedInstaller, and no other account can add to it or change it.
//
// C:\ProgramData lets every account create folders, and the owner of a folder is the
// account that made it, with full control of it and the right to replace what is
// below it. An account that makes %ProgramData%\Vectory before the agent is first
// installed would hold the directory the agent's identity and settings are kept
// under. So whatever makes or reuses that directory on the agent's state path
// (setup, the function that makes a private directory, the one that makes a fresh
// state directory) judges it first, for every install, whether or not updates are on:
//
//   - one that isn't there is made closed;
//   - one that belongs to root and that another account can add to or change has its
//     access list replaced, through the handle that judged it;
//   - one that another account owns is refused, by that account's name, before
//     anything is written under it;
//   - a state directory that isn't under it (a custom --state-dir) needs none of this.
//
// The decisions are below as plain values, so that every platform can judge them.
// What reads the directory and changes it is in update_root_windows.go.

// windowsUpdateRoot is %ProgramData%\Vectory for the ProgramData given ("" is the
// usual C:\ProgramData).
func windowsUpdateRoot(programData string) string {
	if programData == "" {
		programData = `C:\ProgramData`
	}
	return strings.TrimRight(programData, `\/`) + `\Vectory`
}

// underWindowsRoot reports whether the clean path is root or is below it, comparing
// as Windows does, without regard to case.
func underWindowsRoot(path, root string) bool {
	lower, base := strings.ToLower(path), strings.ToLower(root)
	return lower == base || strings.HasPrefix(lower, base+`\`)
}

// stateRootKept says whether a state path is kept in the update root in the sense of
// the rule above: it is below the root. Nothing in the root can exempt it, a file an
// account plants there least of all: any account can make the folder before setup
// does, and the folder's owner could then make any answer true. The root itself is
// not kept in it, and no earlier layout is adopted there (legacyStateDirs).
func stateRootKept(path, root string) bool {
	return !strings.EqualFold(path, root) && underWindowsRoot(path, root)
}

// rootVerdict is what a directory that holds the agent's own directories is, judged
// from its owner and its access list.
type rootVerdict int

const (
	// rootClosed: root's, and no other account can add to it or change it.
	rootClosed rootVerdict = iota + 1
	// rootOpen: root's, and another account can add to it or change it, as ProgramData
	// lets one that a new folder inherits.
	rootOpen
	// rootForeign: another account's, or nobody's. Its owner can change its access list
	// whatever the list says, so nothing about the list makes it safe.
	rootForeign
)

// judgeRoot judges a directory that holds the agent's own directories. It is as strict
// as the directories below it (windowsHolds): the right to add an entry is what a
// squatter needs. extra is one more account whose ownership and entries pass (a
// test's own).
func judgeRoot(owner string, hasACL bool, entries []aclEntry, extra string) rootVerdict {
	switch {
	case !rootAccount(owner, extra):
		return rootForeign
	case aclProblem(owner, hasACL, entries, windowsHolds, extra, nil) == "":
		return rootClosed
	}
	return rootOpen
}

// stateRootAction is what the code that makes or reuses the agent's state directory
// does with the directory that holds it under ProgramData.
type stateRootAction int

const (
	// stateRootUntouched: the state path isn't kept there, or this process can't make or
	// change what root owns, so it does what it did before.
	stateRootUntouched stateRootAction = iota + 1
	// stateRootMake: it isn't there: it is made closed.
	stateRootMake
	// stateRootKeep: it is root's and closed.
	stateRootKeep
	// stateRootClose: it is root's and open: its access list is replaced.
	stateRootClose
	// stateRootRefuse: another account owns it: nothing is written under it.
	stateRootRefuse
)

// stateRootFacts is what decides the action. Kept says the state path is kept in the
// update root (stateRootKept) and Elevated that this process can write what root owns
// (an Administrator or SYSTEM). The rest describes the directory when it is there;
// Extra is one more account that counts as root.
type stateRootFacts struct {
	Kept, Elevated bool
	Exists         bool
	Owner          string
	HasACL         bool
	Entries        []aclEntry
	Extra          string
}

// decide is the whole decision. A process that is not elevated can't make the
// Administrators the owner of what it makes, can't change the list of a directory root
// owns, and may be a person's foreground agent that keeps its own directory there; it
// leaves everything as it was, and the path check judges the directory when the update
// step looks.
func (f stateRootFacts) decide() stateRootAction {
	switch {
	case !f.Kept, !f.Elevated:
		return stateRootUntouched
	case !f.Exists:
		return stateRootMake
	}
	switch judgeRoot(f.Owner, f.HasACL, f.Entries, f.Extra) {
	case rootClosed:
		return stateRootKeep
	case rootOpen:
		return stateRootClose
	}
	return stateRootRefuse
}

// stateRootError is the refusal to keep the agent's state in a directory that another
// account owns.
type stateRootError struct {
	// Path is the directory, and Owner the account that owns it as a person reads it
	// (empty when the system names none).
	Path, Owner string
}

// words are what a person reads: what was found, and what to do about it. The
// refusal is not something to go past: the account that owns the directory can replace
// what the agent keeps in it.
func (e *stateRootError) words() (detail, fix string) {
	owner := e.Owner
	if owner == "" {
		owner = "an account the system doesn't name"
	}
	return fmt.Sprintf("%s belongs to %s, not to SYSTEM or the Administrators, so that account can replace what the agent keeps in it.", e.Path, owner),
		"Look at what it holds, then remove it or make the Administrators its owner, and run setup again."
}

func (e *stateRootError) Error() string {
	detail, fix := e.words()
	return detail + " " + fix
}
