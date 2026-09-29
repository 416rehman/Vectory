//go:build linux

package agent

import (
	"os"
	"strings"
	"testing"
)

// Units written by earlier releases (KillMode=control-group) must be updated
// in place by setup, while a unit for another account, binary or state
// directory is still refused.
func TestSystemdUnitUpdatesInPlaceOnlyForTheSameService(t *testing.T) {
	unit := systemdUnitFile("/usr/local/bin/vectory", "/var/lib/vectory-agent", "/etc/vectory/managed", "vectory", "998")
	if !strings.Contains(unit, "\nKillMode=mixed\n") {
		t.Fatal("generated unit must stop only the agent, which drains Vector once")
	}
	earlier := strings.Replace(unit, "KillMode=mixed", "KillMode=control-group", 1)
	if unitIdentity(earlier) != unitIdentity(unit) {
		t.Fatal("a stop-policy change must be an in-place update")
	}
	for _, other := range []string{
		systemdUnitFile("/opt/bin/vectory", "/var/lib/vectory-agent", "/etc/vectory/managed", "vectory", "998"),
		systemdUnitFile("/usr/local/bin/vectory", "/srv/agent", "/etc/vectory/managed", "vectory", "998"),
		systemdUnitFile("/usr/local/bin/vectory", "/var/lib/vectory-agent", "/etc/vectory/managed", "vector", "998"),
	} {
		if unitIdentity(other) == unitIdentity(unit) {
			t.Fatalf("a different service was treated as the same:\n%s", other)
		}
	}
	packaged, err := os.ReadFile("../../../packaging/systemd/vectory.service")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(packaged), "\nKillMode=mixed\n") {
		t.Fatal("packaging/systemd/vectory.service must use KillMode=mixed like the generated unit")
	}
}
