//go:build darwin

package agent

import (
	"strings"
	"testing"
)

func TestLaunchdDefinitionUpdatesInPlaceOnlyForTheSameService(t *testing.T) {
	plist := `<dict><key>Label</key><string>io.vectory.agent</string><key>UserName</key><string>_vectory</string><key>ProgramArguments</key><array><string>/usr/local/bin/vectory</string><string>run</string><string>--state-dir</string><string>/var/lib/vectory-agent</string></array><key>ExitTimeOut</key><integer>330</integer></dict>`
	if plistIdentity(strings.Replace(plist, "330", "400", 1)) != plistIdentity(plist) {
		t.Fatal("a timeout change must be an in-place update")
	}
	for _, other := range []string{
		strings.Replace(plist, "_vectory", "_other", 1),
		strings.Replace(plist, "/usr/local/bin/vectory", "/opt/bin/vectory", 1),
		strings.Replace(plist, "/var/lib/vectory-agent", "/srv/agent", 1),
	} {
		if plistIdentity(other) == plistIdentity(plist) {
			t.Fatalf("a different service was treated as the same: %s", other)
		}
	}
}
