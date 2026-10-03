package agent

import (
	"fmt"
	"runtime"
	"strings"
	"time"
)

// The words the agent uses for an update policy wherever a person reads it:
// setup's last line, `vectory status`, `vectory update status` and the doctor.
// They are kept in one place so that every command says the same thing the same
// way, and so that the dashboard's wording of the same facts can be compared.

// UpdateConsentWords is how a level reads in a sentence.
func UpdateConsentWords(consent string) string {
	switch consent {
	case UpdateConsentAuto:
		return "automatic"
	case UpdateConsentAsk:
		return "ask on this host"
	}
	return "off"
}

// UpdateTrackWords is how a version track reads in a sentence.
func UpdateTrackWords(track string) string {
	if track == UpdateTrackMinor {
		return "minor and patch releases"
	}
	return "patch releases"
}

// DisplayUpdateWindow writes a window as people read it: the spelling of the
// policy with a dash between the days and between the times.
func DisplayUpdateWindow(spec string) string { return strings.ReplaceAll(spec, "-", "–") }

// UpdateWindowsWords lists the windows of a policy, or says that there are none.
func UpdateWindowsWords(windows []string) string {
	if len(windows) == 0 {
		return "any time"
	}
	shown := make([]string, len(windows))
	for i, spec := range windows {
		shown[i] = DisplayUpdateWindow(spec)
	}
	return strings.Join(shown, ", ")
}

// UpdateKeysWords names the pinned keys by their short IDs: "key 3f9a1c0277de9b41",
// or "keys 3f9a1c0277de9b41, 05cc6c02351af0cb".
func UpdateKeysWords(keys []ReleaseKey) string {
	switch len(keys) {
	case 0:
		return "no key pinned"
	case 1:
		return "key " + keys[0].ShortID()
	}
	ids := make([]string, len(keys))
	for i, key := range keys {
		ids[i] = key.ShortID()
	}
	return "keys " + strings.Join(ids, ", ")
}

// UpdatePolicyWords is the one line that says what a host consented to, such as
// "automatic · patch releases · Mon–Fri 02:00–04:00 · key 3f9a1c0277de9b41".
func UpdatePolicyWords(p UpdatePolicy) string {
	return strings.Join([]string{UpdateConsentWords(p.Consent), UpdateTrackWords(p.Track), UpdateWindowsWords(p.Windows), UpdateKeysWords(p.PinnedKeys())}, " · ")
}

// AdminCommandFor is CommandFor for a command that needs root. words is the
// command as it is written on every system ("vectory update resume"). On Linux and
// macOS a person runs it with sudo, so it is printed with it; on Windows a person
// runs it from an elevated PowerShell, where sudo isn't how it is run, so it is
// printed without. Either way the state directory is named, quoted for the shell
// of the system, when it isn't the default one.
func AdminCommandFor(dir, words string) string {
	if runtime.GOOS != "windows" {
		words = "sudo " + words
	}
	return CommandFor(dir, words)
}

// platformName is an operating system as a person names it.
func platformName(goos string) string {
	switch goos {
	case "darwin":
		return "macOS"
	case "windows":
		return "Windows"
	case "linux":
		return "Linux"
	}
	return goos
}

// byHand is the sentence that goes with an operating system whose updates are
// not in this release.
func byHand() string { return "Hosts of this kind update by hand in this release." }

// updateRootWord is who may change what an update trusts, in the words of the
// operating system.
func updateRootWord() string {
	if runtime.GOOS == "windows" {
		return "an administrator"
	}
	return "root"
}

// onTheWay is what a fix says is to be made root's alone when a directory on the way
// to what decides an install can be changed by others: unix where every directory on
// the way must be (the directory and each one above it), and windows where a drive
// root and ProgramData let accounts create entries, and are left as they are, so that
// the one to put right is the directory the message names.
func onTheWay(unix, windows string) string {
	if runtime.GOOS == "windows" {
		return windows
	}
	return unix
}

// humanClock is a time of day as the agent's other commands print it.
func humanClock(t time.Time) string { return t.Local().Format("15:04") }

// humanDayClock is a moment as a person reads it: the time alone for today, and
// the day before it for any other.
func humanDayClock(t, now time.Time) string {
	t, now = t.Local(), now.Local()
	if t.Year() == now.Year() && t.YearDay() == now.YearDay() {
		return humanClock(t)
	}
	return t.Format("2 Jan 15:04")
}

// untilWords says how long until a moment: "in 6 h", "in 25 min".
func untilWords(until time.Duration) string {
	if until < time.Minute {
		return "in under a minute"
	}
	return "in " + humanDuration(until)
}

// updateCodeWords says what an agent code means, in a clause that follows "it":
// "couldn't be verified", "didn't check in within 5 minutes". The unknown code
// is named as it is.
func updateCodeWords(code string) string {
	switch code {
	case "START_FAILED":
		return "the new build didn't start"
	case "NO_CHECK_IN":
		return "it didn't check in within 5 minutes"
	case "UNHEALTHY":
		return "it started but wasn't healthy"
	case "INTERRUPTED":
		return "the update was interrupted"
	case "PROBE_FAILED":
		return "the new build didn't report the version and platform it was signed for"
	case "ARTIFACT_MISMATCH":
		return "the build that arrived doesn't match its signed size and digest"
	case "DISK_FULL":
		return "there wasn't room for it"
	case "BINARY_CHANGED":
		return "the agent was replaced by hand while the update waited"
	case "ROLLBACK_UNHEALTHY":
		return "the previous build didn't check in either"
	case "DOWNLOAD_FAILED":
		return "the download didn't finish"
	case "RELEASE_ALREADY_TRIED":
		return "this build was tried here and rolled back"
	case "COUNTER_REPLAYED":
		return "its release counter is at or below one this host already attempted"
	case "KEY_NOT_PINNED":
		return "no key this host pins signed it"
	case "SIGNATURE_INVALID":
		return "the signature doesn't verify"
	case "MANIFEST_INVALID":
		return "the release file breaks the format"
	case "MANIFEST_EXPIRED":
		return "the release has expired"
	case "KEY_ROLLOVER_CONFLICT":
		return "two successors of a pinned key were seen"
	case "DOWNGRADE_REFUSED":
		return "it is older than the agent that runs here"
	case "ALREADY_RUNNING":
		return "this host already runs it"
	case "VERSION_NOT_ON_TRACK":
		return "it is outside the release track this host takes"
	case "AGENT_TOO_OLD":
		return "this agent is older than the release can be taken from"
	case "SERVICE_DEFINITION_OUTDATED":
		return "the release needs a newer service definition than this host has"
	case "PLATFORM_NOT_IN_RELEASE":
		return "the release has no build for this platform"
	case "PACKAGE_MANAGED":
		return "the agent belongs to a package manager"
	case "NO_SERVICE":
		return "no service runs this agent"
	case "UNTRUSTED_LOCATION":
		return "a directory on its path can be changed by other accounts"
	case "READ_ONLY":
		return "the install directory is read-only"
	case "HELPER_NOT_RUNNING":
		return "the update step isn't running"
	case "UPDATES_OFF":
		return "updates are off on this host"
	case "UPDATES_PAUSED":
		return "updates are paused on this host"
	}
	return "code " + code
}

// updateEligibilityWords says why a host can't take an update, as a sentence
// without its final period.
func updateEligibilityWords(code string) string {
	switch code {
	case UpdateEligible:
		return "this host can take updates"
	case "PACKAGE_MANAGED":
		return "this agent is installed from a package, so the package manager owns its file"
	case "NO_SERVICE":
		return "no service manager runs this agent, or the registered service doesn't run this executable for this state directory"
	case "UNTRUSTED_LOCATION":
		return "a directory on the path of the agent, the policy or the update step can be changed by other accounts"
	case "READ_ONLY":
		return "the update step can't write to the install directory"
	case "HELPER_NOT_RUNNING":
		return "the update step hasn't run in the last two minutes"
	case "SERVICE_DEFINITION_OUTDATED":
		return "this host's service definition is older than the one the next release needs"
	case "PLATFORM_NOT_IN_RELEASE":
		return "agent updates aren't in this release for " + platformName(runtime.GOOS) + ": hosts of this kind update by hand"
	}
	return "code " + code
}

// fingerprintLines writes a fingerprint in groups of eight, as people compare
// it, on one line.
func fingerprintLine(fingerprint string) string { return GroupFingerprint(fingerprint) }

// quoteList writes names as "a, b and c".
func quoteList(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	return fmt.Sprintf("%s and %s", strings.Join(items[:len(items)-1], ", "), items[len(items)-1])
}
