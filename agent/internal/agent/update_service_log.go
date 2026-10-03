package agent

// maxUpdateStepLog is how long the step's log may be when it is opened before it
// starts again. On Windows the step's service writes its standard error to a file in its
// private directory, and starts the file again when it has grown past this (a megabyte)
// as it opens it: a handle that can only append can't be made shorter, so the one that
// is judged and kept is the one that shortens it (update_helper_windows.go).
const maxUpdateStepLog = 1 << 20

// stepLogStartsAgain says whether a log of size bytes starts again when it is opened.
// A log at its limit is kept.
func stepLogStartsAgain(size int64) bool { return size > maxUpdateStepLog }
