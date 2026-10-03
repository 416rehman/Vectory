package agent

// Which operating systems ship agent updates in this build.
//
// An operating system is listed only when the privileged step's native proof on a
// real service of that kind is green at the cut (ADR 0015, "Platforms"). One that
// is not listed has no step in this build: its hosts report PLATFORM_NOT_IN_RELEASE
// with "Hosts of this kind update by hand in this release", setup refuses
// --updates there, and the review lists those devices. That is a refusal, never a
// weaker mechanism: the same journal, the same verification and the same checks run
// on every operating system that is listed, and none of it runs on one that isn't.
// Linux must ship.
//
// Closing an operating system is one line below: set its constant to false.
//
// Windows is closed until the windows job of .github/workflows/platforms.yml is green
// at the cut. That job builds every agent it uses with this line changed to true in a
// copy of the source (openWindowsGate in tests/platform/update-lib.mjs), so it proves
// the step as it ships; opening Windows for the release is changing this line, in the
// commit that cites the green run.
const (
	linuxUpdatesInRelease   = true
	macosUpdatesInRelease   = true
	windowsUpdatesInRelease = false
)

// updateGateOverride replaces the table below. It is a seam like updateHostOverride:
// tests assign it, to see what a build that doesn't ship an operating system says
// there, and nothing else does.
var updateGateOverride func(goos string) bool

// updatesInRelease says whether this build ships agent updates on goos.
func updatesInRelease(goos string) bool {
	if updateGateOverride != nil {
		return updateGateOverride(goos)
	}
	switch goos {
	case "linux":
		return linuxUpdatesInRelease
	case "darwin":
		return macosUpdatesInRelease
	case "windows":
		return windowsUpdatesInRelease
	}
	return false
}
