//go:build windows

package agent

import "os"

// directoryAcceptsFiles reports whether this process may create entries in the
// directory. Windows has no access check that honors the account's rights
// reliably, so it creates a file and removes it again at once.
func directoryAcceptsFiles(path string) bool {
	f, err := os.CreateTemp(path, ".vectory-probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}
