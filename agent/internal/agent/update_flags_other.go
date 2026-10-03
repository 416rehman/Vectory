//go:build !windows && !linux && !darwin

package agent

import "os"

// fileFlagsOf has nothing to read where no update step is written for the system.
func fileFlagsOf(*os.File) []fileFlag { return nil }
