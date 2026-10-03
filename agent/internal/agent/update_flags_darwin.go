//go:build darwin

package agent

import "os"

// fileFlagsOf reads st_flags of an open file or directory (fstat, through the handle
// and never through the path) and names the ones that stop the step (update_flags.go).
// A handle that can't be asked has none that stop it.
func fileFlagsOf(f *os.File) []fileFlag {
	st, err := fstatFile(f)
	if err != nil {
		return nil
	}
	return darwinFileFlags(st.Flags)
}
