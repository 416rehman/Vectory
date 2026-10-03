package agent

import (
	"fmt"
	"strings"
)

// vectoryUpgradeCode is the upgrade code of the Windows Installer package of the
// agent (packaging/windows/vectory.wxs). A host where Windows Installer has a
// product registered under it belongs to the package: the installer owns the
// executable, and an update behind its back would be undone by a repair or
// reported as a modified file. TestTheUpgradeCodeIsThePackagesOwn keeps this equal
// to the package's.
const vectoryUpgradeCode = "{A948C519-E7D6-4E8F-AE85-3D0724A0D2D7}"

// packInstallerGUID writes a GUID the way Windows Installer names it in the
// registry: the first three groups with their characters in reverse order, and
// the last two with the two characters of each byte swapped, with no braces and
// no hyphens. {AC76BA86-7AD7-1033-7B44-AC0F074E4100} becomes
// 68AB67CA7DA73301B744CAF070E41400.
func packInstallerGUID(guid string) (string, error) {
	text := strings.ToUpper(strings.TrimSpace(guid))
	text = strings.TrimSuffix(strings.TrimPrefix(text, "{"), "}")
	groups := strings.Split(text, "-")
	invalid := fmt.Errorf("%q isn't a GUID like {A948C519-E7D6-4E8F-AE85-3D0724A0D2D7}", guid)
	if len(groups) != 5 {
		return "", invalid
	}
	for i, width := range []int{8, 4, 4, 4, 12} {
		if len(groups[i]) != width {
			return "", invalid
		}
		for _, c := range groups[i] {
			if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'F') {
				return "", invalid
			}
		}
	}
	reverse := func(s string) string {
		out := []byte(s)
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
		return string(out)
	}
	swapped := func(s string) string {
		out := []byte(s)
		for i := 0; i+1 < len(out); i += 2 {
			out[i], out[i+1] = out[i+1], out[i]
		}
		return string(out)
	}
	return reverse(groups[0]) + reverse(groups[1]) + reverse(groups[2]) + swapped(groups[3]) + swapped(groups[4]), nil
}
