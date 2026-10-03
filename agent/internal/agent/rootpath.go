package agent

import (
	"errors"
	"io"
	"io/fs"
)

// The path check. The files that decide what an agent installs (the update
// policy, the privileged step's own state, the install directory and the
// executable in it) are trusted only when nobody but root (SYSTEM and
// Administrators on Windows) can have changed them. openRootOwned, in
// rootpath_unix.go and rootpath_windows.go, opens every directory on the path
// and the final file through handles, checks each handle, and keeps them: every
// later use goes through the handles, never through a path resolved again, so
// nothing can change between the check and the use.
//
// openPrivateFile (platform_unix.go) is not enough here. It walks from the root
// without following links, as this does, but it judges only the final file, which
// is right for a token file that its reader owns and wrong for a path that
// decides what code runs as root: a file owned by root in a directory that
// another account can write is a file that account can replace.

// codeUntrustedLocation is the agent code for a path that others can write or
// have owned: the host can't take an update from there.
const codeUntrustedLocation = "UNTRUSTED_LOCATION"

// untrustedLocation is the refusal for a path that isn't root's alone. detail
// names the component and says why, as a person reads it.
func untrustedLocation(detail string) *UpdateRefusal {
	return &UpdateRefusal{Code: codeUntrustedLocation, Detail: detail}
}

// rootOwnedKind says what the last component of a path must be.
type rootOwnedKind int

const (
	// rootOwnedFile: a regular file. The value then holds the file and the
	// directory that contains it.
	rootOwnedFile rootOwnedKind = iota + 1
	// rootOwnedDirectory: a directory, which the value then holds.
	rootOwnedDirectory
)

// rootFilePerm says who may do what with a file a root-owned directory gets.
type rootFilePerm int

const (
	// rootPrivate: root reads and writes it, and nobody else (0600; Windows:
	// SYSTEM and Administrators).
	rootPrivate rootFilePerm = iota + 1
	// rootReadable: root writes it and others read it (0644; Windows: SYSTEM and
	// Administrators write, and the agent's service reads).
	rootReadable
	// rootExecutable: root writes it and others read and run it (0755; Windows:
	// the access the directory gives).
	rootExecutable
)

// errRootOwnedTooLarge is what a bounded read says when the file is longer than
// its bound.
var errRootOwnedTooLarge = errors.New("is larger than its bound")

// readBounded reads at most limit bytes and refuses a longer input without
// reading the rest of it.
func readBounded(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errRootOwnedTooLarge
	}
	return data, nil
}

// notExist reports whether err says that something on the path isn't there.
func notExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
