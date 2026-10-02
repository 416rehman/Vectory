package agent

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fullDisk makes the disk fill up: every atomic write from the n-th on fails
// at one step of the write, until free is called. It records the destination
// of every write it sees, so a test can name what failed.
type fullDisk struct {
	mu       sync.Mutex
	writes   []string
	from     int
	step     string
	freed    bool
	previous func(string) (atomicFile, error)
}

// The steps of writing a file at which a full disk can show itself: creating
// the temporary file (no room for a directory entry), the write (none, or half
// of it), and the sync or close that flush what the file system delayed.
var fullDiskSteps = []string{"create", "write", "partial", "sync", "close"}

// fillDisk installs a full disk that starts failing at write number from
// (1-based; 0 only records) at step, and removes it when the test ends.
func fillDisk(t *testing.T, from int, step string) *fullDisk {
	t.Helper()
	d := &fullDisk{from: from, step: step, previous: createAtomicTemp}
	createAtomicTemp = func(dest string) (atomicFile, error) {
		d.mu.Lock()
		d.writes = append(d.writes, dest)
		failing := d.from > 0 && len(d.writes) >= d.from && !d.freed
		d.mu.Unlock()
		if failing && d.step == "create" {
			return nil, &os.PathError{Op: "open", Path: dest, Err: errDiskFull}
		}
		file, err := d.previous(dest)
		if err != nil || !failing {
			return file, err
		}
		return &fullFile{atomicFile: file, step: d.step}, nil
	}
	t.Cleanup(d.remove)
	return d
}

// remove takes the disk out again.
func (d *fullDisk) remove() { createAtomicTemp = d.previous }

// free gives the disk its space back.
func (d *fullDisk) free() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.freed = true
}

// destinations lists the files written so far, in order.
func (d *fullDisk) destinations() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.writes...)
}

// fullFile is a temporary file on the full disk.
type fullFile struct {
	atomicFile
	step string
}

func (f *fullFile) Write(p []byte) (int, error) {
	switch f.step {
	case "write":
		return 0, &os.PathError{Op: "write", Path: f.Name(), Err: errDiskFull}
	case "partial":
		n, err := f.atomicFile.Write(p[:len(p)/2])
		if err != nil {
			return n, err
		}
		return n, &os.PathError{Op: "write", Path: f.Name(), Err: errDiskFull}
	}
	return f.atomicFile.Write(p)
}

func (f *fullFile) Sync() error {
	if f.step == "sync" {
		return &os.PathError{Op: "sync", Path: f.Name(), Err: errDiskFull}
	}
	return f.atomicFile.Sync()
}

func (f *fullFile) Close() error {
	err := f.atomicFile.Close()
	if err == nil && f.step == "close" {
		return &os.PathError{Op: "close", Path: f.Name(), Err: errDiskFull}
	}
	return err
}

// writeLabel names a written file for a test name: the random parts of the
// agent's own file names are replaced.
func writeLabel(dest string) string {
	name := filepath.Base(dest)
	for _, prefix := range []string{".vectory-stage-", "template-", "good-", "host-runtime-stage-"} {
		if strings.HasPrefix(name, prefix) {
			return prefix + "x"
		}
	}
	return name
}

// leftovers lists the agent's own transient files in dir: atomic-write
// temporaries and staged candidates.
func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, entry := range entries {
		if agentLeftover(entry.Name()) {
			found = append(found, entry.Name())
		}
	}
	return found
}
