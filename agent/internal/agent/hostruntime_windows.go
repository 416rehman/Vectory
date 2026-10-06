//go:build windows

package agent

// Vector's default data directory is a Unix path; Windows hosts always use
// the host or agent data directory.
func directoryWritable(string) bool { return false }
