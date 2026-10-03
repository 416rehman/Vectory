package agent

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The readers of the update files take bytes that another account wrote, so
// they must never panic, and whatever one accepts the writer must write back as
// a file the reader accepts, byte for byte the same when it goes round again.

type updateFormat struct {
	name   string
	prefix string // the names of the golden files that seed it
	parse  func(data []byte) (any, error)
	write  func(value any) ([]byte, error)
}

var updateFormats = []updateFormat{
	{"request", "request",
		func(d []byte) (any, error) { return ParseUpdateRequest(d) },
		func(v any) ([]byte, error) { return MarshalUpdateRequest(v.(UpdateRequest)) }},
	{"health", "health",
		func(d []byte) (any, error) { return ParseUpdateHealth(d) },
		func(v any) ([]byte, error) { return MarshalUpdateHealth(v.(UpdateHealth)) }},
	{"rollovers", "rollovers",
		func(d []byte) (any, error) { return ParseUpdateRollovers(d) },
		func(v any) ([]byte, error) { return MarshalUpdateRollovers(v.([]RolloverEnvelope)) }},
	{"status", "status",
		func(d []byte) (any, error) { return ParseUpdateStatus(d) },
		func(v any) ([]byte, error) { return MarshalUpdateStatus(v.(UpdateStatus)) }},
	{"policy", "policy",
		func(d []byte) (any, error) { return ParseUpdatePolicy(d) },
		func(v any) ([]byte, error) { return MarshalUpdatePolicy(v.(UpdatePolicy)) }},
}

func FuzzUpdateFiles(f *testing.F) {
	for kind, format := range updateFormats {
		matches, err := filepath.Glob(filepath.Join("testdata", "update", format.prefix+"*.json"))
		if err != nil || len(matches) == 0 {
			f.Fatalf("no golden files for %s: %v", format.name, err)
		}
		for _, path := range matches {
			data, err := os.ReadFile(path)
			if err != nil {
				f.Fatal(err)
			}
			f.Add(uint8(kind), data)
			// A seed that is nearly right is where a reader goes wrong.
			f.Add(uint8(kind), bytes.Replace(data, []byte(`":`), []byte(`" :`), 1))
			f.Add(uint8(kind), []byte(strings.Replace(string(data), "{", `{"schema":1,`, 1)))
		}
	}
	f.Fuzz(func(t *testing.T, kind uint8, data []byte) {
		format := updateFormats[int(kind)%len(updateFormats)]
		value, err := format.parse(data)
		if err != nil {
			return
		}
		first, err := format.write(value)
		if err != nil {
			t.Fatalf("%s: the reader accepted %q and the writer refused what it read: %v", format.name, data, err)
		}
		again, err := format.parse(first)
		if err != nil {
			t.Fatalf("%s: the reader refuses what the writer wrote from %q: %v\n%s", format.name, data, err, first)
		}
		second, err := format.write(again)
		if err != nil {
			t.Fatalf("%s: the writer refused what the reader read from its own file: %v\n%s", format.name, err, first)
		}
		if !bytes.Equal(first, second) {
			t.Fatalf("%s: writing again changed the file:\n%s\n%s", format.name, first, second)
		}
	})
}

var fuzzZones = []string{"UTC", "Europe/Berlin", "America/New_York", "Australia/Lord_Howe", "Asia/Kolkata"}

// A window the parser accepts is the text it was given, and from any moment in
// any zone the next start is a moment after it at which the host is open and was
// not a minute before.
func FuzzUpdateWindow(f *testing.F) {
	for _, spec := range []string{
		"daily 02:00-04:00", "Mon-Fri 22:00-02:00 UTC", "Sat,Sun 00:00-23:59", "Sat-Mon 01:30-02:30",
		"Sun 02:00-03:00", "Fri 00:01-00:00", "Tue,Thu 23:30-00:30",
	} {
		f.Add(spec, int64(1774742400), uint8(1)) // the night the clocks go forward in Berlin, 2026
		f.Add(spec, int64(1793336400), uint8(2)) // and back in New York
	}
	f.Fuzz(func(t *testing.T, spec string, seconds int64, zone uint8) {
		window, err := ParseUpdateWindow(spec)
		if err != nil {
			return
		}
		if window.String() != spec {
			t.Fatalf("%q was read as %q", spec, window.String())
		}
		if again, err := ParseUpdateWindow(window.String()); err != nil || again != window {
			t.Fatalf("%q doesn't parse to the same window again: %v", spec, err)
		}
		loc, err := time.LoadLocation(fuzzZones[int(zone)%len(fuzzZones)])
		if err != nil {
			t.Fatal(err)
		}
		// Any moment between 2000 and 2100.
		const span = 100 * 365 * 24 * 3600
		if seconds < 0 {
			seconds = -(seconds + 1)
		}
		at := time.Unix(946684800+seconds%span, 0).In(loc)
		windows := UpdateWindows{window}
		windows.OpenAt(at)
		next, ok := windows.NextStart(at)
		if !ok {
			return
		}
		if !next.After(at) || !windows.OpenAt(next) || windows.OpenAt(next.Add(-time.Minute)) {
			t.Fatalf("%q from %v in %v: the next start %v is not a moment the window opens", spec, at, loc, next)
		}
	})
}
