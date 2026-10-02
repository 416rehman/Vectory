//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// tripwire is a named pipe standing in for a file a pipeline names. A writer's
// open returns only when something opens the pipe for reading, so opened says
// whether anything tried to read the path.
type tripwire struct {
	path   string
	opened atomic.Bool
}

func newTripwire(t *testing.T, dir, name string) *tripwire {
	t.Helper()
	wire := &tripwire{path: filepath.Join(dir, name)}
	if err := mkfifo(wire.path); err != nil {
		t.Fatal(err)
	}
	go func() {
		if file, err := os.OpenFile(wire.path, os.O_WRONLY, 0); err == nil {
			wire.opened.Store(true)
			file.Close()
		}
	}()
	// A read-write open of a pipe does not block, and lets a writer that
	// nothing opened for reading end.
	t.Cleanup(func() {
		if file, err := os.OpenFile(wire.path, os.O_RDWR, 0); err == nil {
			file.Close()
		}
	})
	return wire
}

func (wire *tripwire) wasOpened() bool {
	time.Sleep(150 * time.Millisecond)
	return wire.opened.Load()
}

// The checks beyond the two the fixtures name.
const (
	fileCheckRefused = "3a6c9e12-7b4d-4f21-8c35-5d0e1f2a3b4c"
	fileCheckInline  = "8d2f4a6b-1c3e-4b5a-9d7f-2e4a6c8b0d1f"
)

// groksFrom is a pipeline whose remap step passes alias_sources to parse_groks.
func groksFrom(path string) []byte {
	return nativePipeline(nil, nil, `.x = parse_groks!(.message, ["[a-z]+"], alias_sources: [`+strconv.Quote(path)+`])`)
}

// A restricted device refuses a VRL call that passes a file before Vector runs,
// so Vector never opens the file; the same device in full mode lets Vector read
// it. Measured with the pinned Vector, through the check a device runs on its
// own host before a version is applied.
func TestNativeARestrictedDeviceNeverLetsVectorOpenTheFileAVRLCallPasses(t *testing.T) {
	withoutSpacing(t)
	d := nativeCheckDevice(t)
	d.poll()
	aliases := filepath.Join(d.root, "aliases.json")
	if err := os.WriteFile(aliases, []byte(`{"WORDS": "[a-z]+"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	// Control: in full mode Vector reads the alias file when it compiles the
	// program. A file that is not there is its own finding, and a file that is
	// there is accepted.
	d.e.Settings.CapabilityPolicy.FullVectorConfig = true
	missing := d.checkedAs(checkID, groksFrom(filepath.Join(d.root, "no-such-aliases.json")), false)
	diagnostics, _ := missing["diagnostics"].([]any)
	if missing["valid"] != false || len(diagnostics) == 0 {
		t.Fatalf("Vector did not read the file in full mode, so this test proves nothing: %v", missing)
	}
	if first, _ := diagnostics[0].(map[string]any); first["code"] == "DYNAMIC_CAPABILITY_DENIED" {
		t.Fatalf("full mode refused the call: %v", first)
	}
	if res := d.checkedAs(checkID2, groksFrom(aliases), false); res["valid"] != true {
		t.Fatalf("full mode did not accept a call that passes a real file: %v", res)
	}

	// Restricted: the same call is refused, naming the function and the
	// argument, and nothing opens the path.
	d.e.Settings.CapabilityPolicy.FullVectorConfig = false
	wire := newTripwire(t, d.root, "aliases-pipe")
	refused := d.checkedAs(fileCheckRefused, groksFrom(wire.path), false)
	diagnostics, _ = refused["diagnostics"].([]any)
	if refused["valid"] != false || len(diagnostics) != 1 {
		t.Fatalf("a restricted device did not refuse the call: %v", refused)
	}
	first, _ := diagnostics[0].(map[string]any)
	if first["code"] != "DYNAMIC_CAPABILITY_DENIED" || first["component_id"] != "tag" || first["field"] != "source" ||
		first["message"] != `Transform "tag" (remap) reads a file with parse_groks (alias_sources), which restricted mode doesn't allow.` ||
		!strings.HasPrefix(first["hint"].(string), "Remove the alias_sources argument, or deploy to a full-mode device.") {
		t.Fatalf("diagnostic %v", first)
	}
	if wire.wasOpened() {
		t.Fatal("a restricted device let Vector open the file a call passed")
	}
	if d.driver.starts != 0 {
		t.Fatal("a check started Vector")
	}

	// The same function without a file is ordinary, and the pinned Vector runs it.
	inline := nativePipeline(nil, nil, `.x = parse_groks!(.message, ["[a-z]+"], aliases: {"WORDS": "[a-z]+"})`)
	if res := d.checkedAs(fileCheckInline, inline, false); res["valid"] != true {
		t.Fatalf("a restricted device refused parse_groks without a file: %v", res)
	}
}
