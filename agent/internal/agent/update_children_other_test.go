//go:build !windows

package agent

// runAsChildProgram is where the Windows tests' helper programs, which are copies of
// the test binary, take over: there are none on other systems.
func runAsChildProgram() {}
