//go:build !windows && !darwin

package agent

// platformVolume says nothing off macOS: the kernel enforces the file owner and the mode
// a Linux or BSD file system reports, whatever options it was mounted with, so what the
// check reads of a handle is what decides who can change it.
func platformVolume(int) (volumeFacts, bool, error) { return volumeFacts{}, false, nil }
