package agent

import (
	"errors"
	"runtime"
)

// exampleFileRoot is a directory to show in a message about file roots.
func exampleFileRoot() string {
	if runtime.GOOS == "windows" {
		return `C:\logs\app`
	}
	return "/var/log/app"
}

// InputError is a value the operator gave that can't work on any host: an
// address without a port, a number out of range, a digest of the wrong length.
// A command ends with the usage exit code for it, the same as for a flag it
// doesn't know, not with the code for an operation that failed.
type InputError struct{ message string }

func (e *InputError) Error() string { return e.message }

func inputError(message string) error { return &InputError{message} }

// IsInputError reports whether err is the operator's input being refused.
func IsInputError(err error) bool {
	var input *InputError
	return errors.As(err, &input)
}
