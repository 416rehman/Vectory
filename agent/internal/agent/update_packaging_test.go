package agent

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestInstallerGUIDsArePackedTheWayWindowsInstallerPacksThem(t *testing.T) {
	for _, tc := range []struct{ guid, want string }{
		// A published product code and the key name Windows Installer gives it.
		{"{AC76BA86-7AD7-1033-7B44-AC0F074E4100}", "68AB67CA7DA73301B744CAF070E41400"},
		// Written out by hand from the rule: the first three groups reversed, the last
		// two with the two characters of every byte swapped.
		{"{12345678-9ABC-DEF0-1234-56789ABCDEF0}", "87654321CBA90FED21436587A9CBED0F"},
		// The agent's own package.
		{vectoryUpgradeCode, "915C849A6D7EF8E4EA58D370420A2D7D"},
		// Braces, case and spaces around it don't matter.
		{" a948c519-e7d6-4e8f-ae85-3d0724a0d2d7 ", "915C849A6D7EF8E4EA58D370420A2D7D"},
	} {
		got, err := packInstallerGUID(tc.guid)
		if err != nil || got != tc.want {
			t.Errorf("%s: %q, %v, want %q", tc.guid, got, err, tc.want)
		}
	}
}

func TestSomethingThatIsNotAGUIDIsNotPacked(t *testing.T) {
	for _, guid := range []string{
		"", "{}", "A948C519-E7D6-4E8F-AE85", "{A948C519E7D64E8FAE853D0724A0D2D7}", "{A948C519-E7D6-4E8F-AE85-3D0724A0D2D}",
		"{A948C519-E7D6-4E8F-AE85-3D0724A0D2D7-00}", "{G948C519-E7D6-4E8F-AE85-3D0724A0D2D7}", "{A948C519-E7D6-4E8F-AE85-3D0724A0D2D7\x00}",
	} {
		if got, err := packInstallerGUID(guid); err == nil {
			t.Errorf("%q was packed as %q", guid, got)
		}
	}
}

// The code this build looks for is the one the package registers, or a package's
// agent would be updated behind its back.
func TestTheUpgradeCodeIsThePackagesOwn(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "packaging", "windows", "vectory.wxs"))
	if err != nil {
		t.Fatalf("the package's definition: %v", err)
	}
	match := regexp.MustCompile(`UpgradeCode="([0-9A-Fa-f-]+)"`).FindSubmatch(data)
	if match == nil {
		t.Fatal("the package's definition names no upgrade code")
	}
	if got := "{" + strings.ToUpper(string(match[1])) + "}"; got != vectoryUpgradeCode {
		t.Errorf("the package registers %s, and the agent looks for %s", got, vectoryUpgradeCode)
	}
}
