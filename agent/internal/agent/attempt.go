package agent

import (
	"strings"
	"unicode/utf8"
)

// selectAttempt is called only for a successfully authenticated manifest (or
// by Reconcile after its caller has persisted that manifest). Old installations
// do not infer an attempt from FailedGeneration or a generic startup error.
func (e *Engine) selectAttempt(m Manifest) {
	if m.Desired == nil {
		e.State.ConfigurationAttempt = nil
		e.State.ApplyState = "unmanaged"
		e.State.Error = nil
		e.State.FailedGeneration = nil
		e.State.FailedEffectiveSHA256 = ""
		return
	}
	a := e.State.ConfigurationAttempt
	if a != nil && a.Generation == m.Generation && a.VersionID == m.Desired.VersionID && a.SHA256 == m.Desired.SHA256 {
		return
	}
	e.State.ConfigurationAttempt = &ConfigurationAttempt{Generation: m.Generation, VersionID: m.Desired.VersionID, SHA256: m.Desired.SHA256, State: "desired", SecretRevision: e.State.SecretRevision}
	e.State.ApplyState = "desired"
	e.State.Error = nil
	// Preserve legacy suppression at the same generation; it is not evidence of
	// a newly observed failure. A genuinely new generation permits another try.
	if e.State.FailedGeneration != nil && *e.State.FailedGeneration != m.Generation {
		e.State.FailedGeneration = nil
		e.State.FailedEffectiveSHA256 = ""
	}
}

func cloneAttempt(a *ConfigurationAttempt) *ConfigurationAttempt {
	if a == nil {
		return nil
	}
	copy := *a
	copy.Error = cloneIssue(a.Error)
	return &copy
}

// cloneIssue copies an issue for a heartbeat or for the state. The server
// refuses a whole heartbeat for a report past one of its bounds, so what the
// state holds, whichever build wrote it, never reaches a heartbeat unless the
// server accepts it: the message is at most maxIssueMessage characters, there
// are at most maxDiagnostics diagnostics, and each is one the server accepts
// (reportableDiagnostic). A diagnostic that can't be made to fit is left out.
func cloneIssue(issue *Issue) *Issue {
	if issue == nil {
		return nil
	}
	copy := *issue
	copy.Message = limitMessage(issue.Message, maxIssueMessage)
	copy.Diagnostics = nil
	for _, d := range issue.Diagnostics {
		if d, ok := reportableDiagnostic(d); ok {
			copy.Diagnostics = append(copy.Diagnostics, d)
		}
		if len(copy.Diagnostics) == maxDiagnostics {
			break
		}
	}
	return &copy
}

// reportableDiagnostic is d as the server accepts it in a heartbeat, or false
// when no part of it fits. A state file an earlier build wrote can hold
// diagnostics from before the agent replaced control characters in them, from
// before the bounds below, or with an ID the server's rule refuses, so every
// text goes through truncateText (one line, within its bound) and every ID
// through reportableID again, and the record's size is measured as the server
// measures it (fitDiagnostic).
func reportableDiagnostic(d Diagnostic) (Diagnostic, bool) {
	d.Message = truncateText(d.Message, maxDiagnosticMessage)
	d.Hint = truncateText(d.Hint, maxDiagnosticHint)
	d.Field = truncateText(d.Field, maxDiagnosticField)
	if d.Message == "" {
		d.Message = noPrintableDiagnostic
	}
	if !reportableID(d.ComponentID) {
		d.ComponentID = ""
	}
	if d.ComponentID == "" || !reportableID(d.RouteOutput) {
		d.RouteOutput = ""
	}
	return fitDiagnostic(d)
}

// limitMessage is text without NUL, which the server refuses, and at most max
// characters, the last an ellipsis when it cut.
func limitMessage(text string, max int) string {
	text = strings.ReplaceAll(text, "\x00", "")
	if utf8.RuneCountInString(text) <= max {
		return text
	}
	return string([]rune(text)[:max-1]) + "…"
}
func (e *Engine) currentAttempt() *ConfigurationAttempt {
	a, d := e.State.ConfigurationAttempt, e.State.Desired
	if a == nil || d == nil || a.Generation != e.State.HighestGeneration || a.VersionID != d.VersionID || a.SHA256 != d.SHA256 {
		return nil
	}
	return a
}
func (e *Engine) attemptProgress(state string) {
	e.State.ApplyState = state
	e.State.Error = nil
	if a := e.currentAttempt(); a != nil {
		a.State, a.Error, a.SecretRevision = state, nil, e.State.SecretRevision
	}
}
func (e *Engine) attemptOutcome(attempt *ConfigurationAttempt, state string, issue *Issue) {
	a := e.currentAttempt()
	if a != nil && attempt != nil && a.Generation == attempt.Generation && a.VersionID == attempt.VersionID && a.SHA256 == attempt.SHA256 && a.SecretRevision == attempt.SecretRevision {
		a.State, a.Error = state, cloneIssue(issue)
	}
}
func (e *Engine) failAttempt(code, stage, message string) error {
	return e.failAttemptWith(code, stage, message, nil)
}

// failAttemptWith records a candidate failure with redacted diagnostics.
func (e *Engine) failAttemptWith(code, stage, message string, diagnostics []Diagnostic) error {
	e.attemptOutcome(e.currentAttempt(), "failed", &Issue{Code: code, Stage: stage, Message: message, Diagnostics: diagnostics})
	return e.failWith(code, stage, message, diagnostics)
}
func (e *Engine) pauseAttempt() {
	e.State.ApplyState = "paused"
	e.State.RemotePauseAcknowledged = e.State.Policy.SyncPaused
	if a := e.currentAttempt(); a != nil {
		switch a.State {
		case "desired", "downloaded", "validated", "written", "reload_requested":
			a.State = "paused"
		}
	}
}

// A last-good process observation may update only its exact, already verified
// attempt. Starting or failing an older retained workload cannot relabel a newer
// candidate's error/result, including after a crash at manifest acceptance.
func (e *Engine) observeVerifiedAttempt(state string, issue *Issue) {
	if a := e.currentAttempt(); a != nil && a.Generation == e.State.ReportedGeneration &&
		(a.State == "verified_applied" || a.State == "verification_unknown") {
		e.attemptOutcome(a, state, issue)
	}
}
