package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"runtime"
	"time"
)

// The probe. Before the step stops anything, it runs the build it is about to
// install, as the service account, and asks it who it is: `version --json`. A
// build that can't print its own version on this platform will not be able to
// check in, and finding that out costs nothing now and a rollback later.
//
// The build is the verified copy of the step's own (never the service account's
// file) and is run from the probe directory, which belongs to root, is closed to
// everyone else for writing and is readable and searchable by the service
// account. That is the one place the service account is let to run a build from:
//
//   - not from the step's private directory, which the service account can't
//     traverse (EACCES, and it must stay that way);
//   - not through a descriptor passed to fexecve, which is harder to get right on
//     three platforms than a root-owned directory the account may read and run
//     from;
//   - not from the state directory, which the account owns and can change between
//     any check and any run.
//
// The step copies the verified build there, checks the digest of the copy, runs
// it, and removes it. What the build says decides nothing but whether the step
// goes on: it never authorizes anything, because the signature already did.

const (
	// updateProbeTimeout bounds the run, and updateProbeOutput what is read from
	// it.
	updateProbeTimeout = 10 * time.Second
	updateProbeOutput  = 4 * 1024
)

var errProbeOutputTooLong = errors.New("printed more than 4 KiB")

// probeReport is what `version --json` prints. The members the probe reads are
// three; a build may print more.
type probeReport struct {
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// checkProbeOutput compares what the build printed with what the release says the
// build is and what this host is. Anything else is PROBE_FAILED.
func checkProbeOutput(output []byte, version string) *UpdateRefusal {
	failed := func(format string, args ...any) *UpdateRefusal {
		return newUpdateRefusal("PROBE_FAILED", format, args...)
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	var report probeReport
	if err := decoder.Decode(&report); err != nil {
		return failed("the build didn't print a version document: %v", err)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return failed("the build printed more than one document")
	}
	switch {
	case report.Version != version:
		return failed("the build says it is version %s, and the release says %s", safeText(report.Version, 40), version)
	case report.OS != runtime.GOOS || report.Arch != runtime.GOARCH:
		return failed("the build says it is for %s/%s, and this host is %s/%s", safeText(report.OS, 20), safeText(report.Arch, 20), runtime.GOOS, runtime.GOARCH)
	}
	return nil
}

// probeVersionOf reads the version a build printed, for the installed build whose
// version the step records. It judges nothing else.
func probeVersionOf(output []byte) (string, error) {
	var report probeReport
	if err := json.Unmarshal(output, &report); err != nil {
		return "", err
	}
	if !validUpdateText(report.Version) {
		return "", errors.New("the build's version isn't 1 to 128 bytes of text without control characters")
	}
	return report.Version, nil
}

// boundedOutput keeps the first limit bytes a process prints and remembers that
// there were more. It never blocks the writer: a build that prints a great deal
// is a failed probe, not a stuck one.
type boundedOutput struct {
	limit    int
	buffer   bytes.Buffer
	overflow bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if room := b.limit - b.buffer.Len(); len(p) > room {
		b.buffer.Write(p[:room])
		b.overflow = true
	} else {
		b.buffer.Write(p)
	}
	return len(p), nil
}
