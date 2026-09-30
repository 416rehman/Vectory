package agent

import (
	"errors"
	"io/fs"
	"path/filepath"
)

// DiskFullError says that a write failed because the disk (or the account's
// quota on it) is full. It wraps the operating system's error, so
// errors.Is(err, syscall.ENOSPC) keeps working where that applies.
type DiskFullError struct {
	// Dir is the directory the write was aimed at.
	Dir   string
	cause error
}

func (e *DiskFullError) Error() string {
	return "the disk that holds " + e.Dir + " is full (" + diskFullReason(e.cause) + ")"
}

func (e *DiskFullError) Unwrap() error { return e.cause }

// Fix is what to do about it. again names how the failed work is retried.
func (e *DiskFullError) Fix(again string) string {
	return "Free some space on that disk, then " + again + "."
}

// diskFullReason is the operating system's own words for the failure without
// the file name it was writing.
func diskFullReason(err error) string {
	var pathErr *fs.PathError
	switch {
	case err == nil:
		return "no space left on the device"
	case errors.As(err, &pathErr):
		return pathErr.Err.Error()
	}
	return err.Error()
}

// storageError classifies a failed write into dir: a full disk becomes a
// DiskFullError, anything else is returned as it is.
func storageError(dir string, err error) error {
	if err == nil || !isDiskFull(err) {
		return err
	}
	var already *DiskFullError
	if errors.As(err, &already) {
		return err
	}
	return &DiskFullError{Dir: filepath.Clean(dir), cause: err}
}

// diskFullFrom returns the DiskFullError inside err, if any.
func diskFullFrom(err error) (*DiskFullError, bool) {
	var full *DiskFullError
	return full, errors.As(err, &full)
}

// Labels for the two places the agent writes, used where a path must not
// leave the device.
const (
	storageLabelManaged = "the managed configuration"
	storageLabelState   = "the agent state directory"
)

// storageLabelFor names what the folder dir holds.
func storageLabelFor(s Settings, dir string) string {
	if s.ManagedConfig != "" && filepath.Clean(dir) == filepath.Clean(filepath.Dir(s.ManagedConfig)) {
		return storageLabelManaged
	}
	return storageLabelState
}

// storageDiagnostic explains a failed write to the device's operator, or is
// nil when the failure isn't a full disk. The folder is named by what it
// holds, not by its path: diagnostics leave the device. `vectory status` on
// the device names the path.
func (e *Engine) storageDiagnostic(err error) []Diagnostic {
	full, ok := diskFullFrom(err)
	if !ok {
		return nil
	}
	return []Diagnostic{newRedactor().finalize(Diagnostic{
		Code:    "DISK_FULL",
		Message: "The disk that holds " + storageLabelFor(e.Settings, full.Dir) + " is full.",
		Hint:    "Free some space on that disk. The agent applies this version at its next check-in; there is nothing else to do.",
	})}
}

// storageMessage is base, and says so when the cause is a full disk.
func storageMessage(base string, err error) string {
	if _, ok := diskFullFrom(err); ok {
		return base + ": the disk is full"
	}
	return base
}
