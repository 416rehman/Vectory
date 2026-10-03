package agent

import "strings"

// invalidPolicyWords is why a policy file that is there can't be used, without the
// path in front of it.
func invalidPolicyWords(err error) string {
	text := err.Error()
	if _, after, found := strings.Cut(text, ErrUpdatePolicyInvalid.Error()+": "); found {
		text = after
	}
	return strings.TrimSuffix(text, ".")
}

// UpdateStatusJSON is the view for --json: every member is present, null where
// nothing applies.
func UpdateStatusJSON(v UpdateView) map[string]any {
	p := v.Policy
	windows := p.Windows
	if windows == nil {
		windows = []string{}
	}
	keys := make([]map[string]any, 0, len(p.Keys))
	for _, pinned := range p.Keys {
		keys = append(keys, map[string]any{
			"fingerprint": pinned.Key.Fingerprint(), "short_id": pinned.Key.ShortID(), "name": pinned.Key.Name(),
			"pinned_at": pinned.PinnedAt.UTC().Format(updateSecondsLayout),
		})
	}
	open, next, hasNext := v.windowState()
	out := map[string]any{
		"state_dir":         v.StateDir,
		"consent":           p.Consent,
		"paused":            p.Paused,
		"local_pause":       v.LocalPaused,
		"track":             p.Track,
		"windows":           windows,
		"window_open":       open,
		"next_window_at":    nil,
		"keys":              keys,
		"policy_problem":    nil,
		"eligibility":       v.Eligibility,
		"step":              nil,
		"staged":            nil,
		"in_progress":       nil,
		"last":              nil,
		"rollover_conflict": nil,
		"line":              v.Headline(),
	}
	if hasNext {
		out["next_window_at"] = next.UTC().Format(updateSecondsLayout)
	}
	if v.PolicyProblem != "" {
		out["policy_problem"] = v.PolicyProblem
	}
	if s := v.Status; s != nil {
		out["step"] = map[string]any{"running": v.StepRunning, "run_at": s.RunAt.UTC().Format(updateSecondsLayout), "stage": s.Stage, "service_definition": s.ServiceDefinition}
		if s.Stage != UpdateStageIdle {
			progress := map[string]any{"stage": s.Stage, "release": nil, "from_version": nil, "to_version": nil, "deadline": nil}
			if s.Release != "" {
				progress["release"] = s.Release
			}
			if s.FromVersion != "" {
				progress["from_version"] = s.FromVersion
			}
			if s.ToVersion != "" {
				progress["to_version"] = s.ToVersion
			}
			if !s.Deadline.IsZero() {
				progress["deadline"] = s.Deadline.UTC().Format(updateSecondsLayout)
			}
			out["in_progress"] = progress
		}
		if s.Last != nil {
			out["last"] = s.Last
		}
	}
	if conflict := v.Conflict(); conflict != nil {
		out["rollover_conflict"] = conflict
	}
	if staged := v.Staged; staged != nil {
		entry := map[string]any{"manifest_sha256": staged.ManifestSHA256, "offered_at": staged.OfferedAt.UTC().Format(updateSecondsLayout), "complete": staged.Complete, "version": nil, "size": nil}
		if staged.Version != "" {
			entry["version"] = staged.Version
		}
		if staged.Complete {
			entry["size"] = staged.Size
		}
		out["staged"] = entry
	}
	return out
}
