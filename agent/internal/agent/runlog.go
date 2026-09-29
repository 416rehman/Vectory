package agent

import (
	"fmt"
	"strings"
	"time"
)

// The agent's own log says what happened, once, in words an operator reads:
// a version applied, rolled back or refused, a reconnection after an outage,
// and how Vector stopped. The per-check-in line is for --verbose.

// versionLabel is "version b898b48f (generation 2)" for the desired version.
func versionLabel(s State, generation uint64) string {
	id := ""
	if s.Desired != nil {
		id = s.Desired.VersionID
		if len(id) > 8 {
			id = id[:8]
		}
	}
	if id == "" {
		return fmt.Sprintf("generation %d", generation)
	}
	return fmt.Sprintf("version %s (generation %d)", id, generation)
}

// problemText is the failure in the words of its leading diagnostic, with
// its code, falling back to the recorded message.
func problemText(issue *Issue) string {
	var lead *Diagnostic
	for i := range issue.Diagnostics {
		if issue.Diagnostics[i].Severity == "error" {
			lead = &issue.Diagnostics[i]
			break
		}
	}
	if lead == nil && len(issue.Diagnostics) > 0 {
		lead = &issue.Diagnostics[0]
	}
	text, code := issue.Message, issue.Code
	if lead != nil && lead.Message != "" {
		text = lead.Message
		if lead.Code != "" {
			code = lead.Code
		}
	}
	text = strings.TrimSuffix(strings.TrimSpace(text), ".")
	if lead != nil && lead.Hint != "" {
		text += ". " + strings.TrimSuffix(lead.Hint, ".")
	}
	return text + " (" + code + ")."
}

// outcomeLine says what the last reconciliation did: key identifies the
// outcome, so the log says it once; "" when there is nothing to say.
func outcomeLine(s State) (key, line string) {
	switch s.ApplyState {
	case "verified_applied":
		if s.Desired == nil {
			return "", ""
		}
		return fmt.Sprintf("applied/%d/%s", s.ReportedGeneration, s.ActualSHA256), "Applied " + versionLabel(s, s.ReportedGeneration) + "; Vector runs it."
	case "failed", "rolled_back":
		if s.Error == nil {
			return "", ""
		}
		generation := s.HighestGeneration
		if s.FailedGeneration != nil {
			generation = *s.FailedGeneration
		}
		key = fmt.Sprintf("%s/%d/%s", s.ApplyState, generation, s.Error.Code)
		version := versionLabel(s, generation)
		version = strings.ToUpper(version[:1]) + version[1:]
		switch {
		case s.ApplyState == "rolled_back":
			return key, version + " didn't apply: " + problemText(s.Error) + " Vector runs the last working configuration again."
		case s.Error.Code == "ROLLBACK_UNAVAILABLE":
			return key, version + " couldn't start: " + problemText(s.Error) + " Vector is stopped: this was the device's first version, so there is nothing earlier to go back to."
		case s.LastGoodSHA256 != "":
			return key, version + " was refused: " + problemText(s.Error) + " Vector keeps running the last working configuration."
		default:
			return key, version + " was refused: " + problemText(s.Error)
		}
	}
	return "", ""
}

// startupLine says what Vector runs once the agent started it, or that
// nothing runs yet.
func startupLine(s State, alive bool) string {
	switch {
	case alive && s.ApplyState == "verified_applied" && s.Desired != nil:
		return "Vector runs " + versionLabel(s, s.ReportedGeneration) + ", the last verified configuration."
	case alive:
		return "Vector runs the configuration adopted at setup."
	case s.LastGoodSHA256 == "":
		return "Nothing to run yet: Vector starts when a pipeline is deployed to this device."
	}
	return ""
}

// preciseDuration is "1 min 12 s" (humanDuration rounds to minutes).
func preciseDuration(d time.Duration) string {
	seconds := int(d.Round(time.Second) / time.Second)
	switch {
	case seconds < 60:
		return fmt.Sprintf("%d s", max(seconds, 1))
	case seconds < 3600 && seconds%60 == 0:
		return fmt.Sprintf("%d min", seconds/60)
	case seconds < 3600:
		return fmt.Sprintf("%d min %d s", seconds/60, seconds%60)
	}
	return fmt.Sprintf("%d h %d min", seconds/3600, seconds%3600/60)
}

// stoppedLine says how Vector's drain ended: within its limit, at the limit
// (Vector ends the remaining components itself), or not at all.
func stoppedLine(took time.Duration, limit int, err error) string {
	switch {
	case err != nil:
		return "Vector didn't stop in time and its supervisor was killed: " + sentence(err.Error())
	case took >= time.Duration(limit)*time.Second:
		return fmt.Sprintf("Drain limit reached after %d s; Vector was terminated before it finished its in-flight events.", limit)
	}
	return "Vector stopped after " + humanLatency(took) + "."
}
