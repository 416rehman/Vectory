//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestLifecycleFenceUsesCanonicalDirectoryAcrossShortNameAlias(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "long vectory state directory")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]uint16, 32768)
	n, err := windows.GetShortPathName(p, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 || n >= uint32(len(buf)) {
		t.Skipf("filesystem does not expose an 8.3 alias: %v", err)
	}
	alias := windows.UTF16ToString(buf[:n])
	if strings.EqualFold(alias, dir) {
		t.Skip("filesystem does not expose a distinct 8.3 alias")
	}
	fullKey, err := canonicalLifecyclePath(dir)
	if err != nil {
		t.Fatal(err)
	}
	aliasKey, err := canonicalLifecyclePath(alias)
	if err != nil {
		t.Fatal(err)
	}
	if fullKey != aliasKey {
		t.Fatalf("same directory selected different lifecycle guards: %q != %q", fullKey, aliasKey)
	}
	release, err := lockLifecycle(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	entered := make(chan bool, 1)
	go func() {
		unlock, err := Lock(alias)
		if err == nil {
			unlock()
			entered <- true
			return
		}
		entered <- false
	}()
	if <-entered {
		t.Fatal("short-name operation entered while canonical path was fenced")
	}
}
