package agent

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
)

// The heartbeat member `agent_update` is sent only to a server that lists the
// feature, and no report may take a device off the control plane: a server that
// refuses a heartbeat that carries it is sent the heartbeat again without it
// before any other report is left out, and for the rest of the process.

const memberRefusedLine = "The server refused a check-in; the agent sent it again without the agent update report."

// withAgentUpdate has the server list the feature and the agent know it does.
func withAgentUpdate(t *testing.T, d *checkDevice) {
	t.Helper()
	requireRootOwnedWriter(t) // a test that sets the policy makes what only root may use
	useUpdateRoots(t)
	features := []string{featureValidation, featureAgentUpdate}
	d.plane.with(func(m *Manifest) { m.Features = features })
	d.e.State.ServerFeatures = features
}

// carriesWithUpdate lists the reports a heartbeat holds, the member included.
func carriesWithUpdate(beat map[string]any) []string {
	held := carries(beat)
	if beat["agent_update"] != nil {
		held = append(held, reportAgentUpdate)
	}
	return held
}

// refuseTheMember has the plane answer 400 to every heartbeat that holds the
// member.
func jsonLine(v any) (string, error) {
	data, err := json.Marshal(v)
	return string(data), err
}

func refuseTheMember(d *checkDevice) {
	refuseWhen(d, func(beat map[string]any) bool { return beat["agent_update"] != nil })
}

func TestTheMemberIsSentOnlyToAServerThatListsTheFeature(t *testing.T) {
	useUpdateRoots(t)
	d := newCheckDevice(t)
	// Until a verified manifest lists the feature, the heartbeat has the shape it
	// always had.
	d.poll()
	if _, held := d.plane.last()["agent_update"]; held {
		t.Fatalf("the member went to a server that doesn't list the feature: %v", d.plane.last())
	}
	// The same server, listing it now: the next heartbeat carries the member.
	d.plane.with(func(m *Manifest) { m.Features = []string{featureValidation, featureAgentUpdate} })
	d.poll()
	if _, held := d.plane.last()["agent_update"]; held {
		t.Fatal("the member went before the manifest that lists the feature was verified")
	}
	d.poll()
	member, _ := d.plane.last()["agent_update"].(map[string]any)
	if member == nil || member["consent"] != "off" || member["state"] != "idle" || member["code"] != "UPDATES_OFF" {
		t.Fatalf("a host that never consented says %v", member)
	}
	// And a server that stops listing it stops getting it.
	d.plane.with(func(m *Manifest) { m.Features = []string{featureValidation} })
	d.poll()
	d.poll()
	if _, held := d.plane.last()["agent_update"]; held {
		t.Fatal("the member went to a server that no longer lists the feature")
	}
}

// Old servers see today's heartbeat, byte for byte: the member is the last field,
// and absent unless a verified manifest lists the feature.
func TestAHeartbeatWithoutTheMemberIsWhatItAlwaysWas(t *testing.T) {
	// This golden describes the historical wire shape, with fixed data rather
	// than the changing version of the agent compiled to run the test.
	heartbeat := Heartbeat{
		ProtocolVersion: 1, RequestID: "request", Nonce: "nonce", BootID: "boot", AgentVersion: "0.1.0", VectorVersion: VectorVersion,
		ConfigurationMode: "restricted", ReportedGeneration: 2, PolicyGeneration: 3, ActualSHA256: "actual", ApplyState: "verified_applied",
		ServiceManager: "systemd", AgentSHA256: "build", StateDir: "/var/lib/vectory",
	}
	got, err := jsonLine(heartbeat)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"protocol_version":1,"request_id":"request","nonce":"nonce","boot_id":"boot","agent_version":"0.1.0","vector_version":"0.58.0","configuration_mode":"restricted","reported_generation":2,"policy_generation":3,"actual_sha256":"actual","apply_state":"verified_applied","local_paused":false,"remote_pause_acknowledged":false,"service_manager":"systemd","agent_sha256":"build","state_dir":"/var/lib/vectory"}`
	if got != want {
		t.Fatalf("the heartbeat changed for servers that don't know the member:\n%s\nwant\n%s", got, want)
	}
	report := okReport()
	heartbeat.AgentUpdate = &report
	with, err := jsonLine(heartbeat)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(with, strings.TrimSuffix(want, "}")+`,"agent_update":{"consent":"auto","paused":false,"track":"patch","windows":[],"window_open":true,"keys":["aaaa`) {
		t.Fatalf("the member isn't the last member of a heartbeat that has it:\n%s", with)
	}
}

func TestAServerThatRefusesTheMemberStillGetsTheCheckInsWithItLeftOutFirst(t *testing.T) {
	d := newCheckDevice(t)
	withAgentUpdate(t, d)
	refuseTheMember(d)
	var said []string
	d.e.Notice = func(line string) { said = append(said, line) }

	// The first check-in: the whole heartbeat, refused, then the same without the
	// member, and nothing else left out.
	h := fullHeartbeat()
	h.ValidationResult = nil
	report := okReport()
	h.AgentUpdate = &report
	before := len(d.plane.sent())
	_, nonce, err := d.e.exchange(t.Context(), h)
	if err != nil {
		t.Fatalf("the check-in did not go through: %v", err)
	}
	beats := d.plane.sent()[before:]
	if len(beats) != 2 {
		t.Fatalf("%d requests", len(beats))
	}
	whole := []string{reportLogSummary, reportDiagnostics, reportHostRuntime, reportStateDir, reportSecretNames, reportMetrics, reportAnnouncements, reportAgentUpdate}
	if got := carriesWithUpdate(beats[0]); !slices.Equal(got, whole) {
		t.Fatalf("the first request carried %v, want %v", got, whole)
	}
	if got := carriesWithUpdate(beats[1]); !slices.Equal(got, whole[:len(whole)-1]) {
		t.Fatalf("the retry carried %v: the member goes first and nothing else with it, want %v", got, whole[:len(whole)-1])
	}
	if nonce != beats[1]["nonce"] || beats[0]["nonce"] == beats[1]["nonce"] || beats[0]["request_id"] == beats[1]["request_id"] {
		t.Fatalf("the retry reused a nonce or request id, or the answer is for another: %v %v", beats[0]["nonce"], beats[1]["nonce"])
	}
	if !d.e.update.memberRefused {
		t.Fatal("the member isn't kept out for the rest of the process")
	}
	if !slices.Equal(said, []string{memberRefusedLine}) {
		t.Fatalf("the log said %q", said)
	}

	// Every later check-in leaves it out from the start: one request each, and the
	// log says nothing more.
	for i := 0; i < 3; i++ {
		before = len(d.plane.sent())
		d.poll()
		beats = d.plane.sent()[before:]
		if len(beats) != 1 || beats[0]["agent_update"] != nil {
			t.Fatalf("check-in %d: %d requests, the first carried %v", i+2, len(beats), carriesWithUpdate(beats[0]))
		}
	}
	if d.e.State.CheckInFailure != nil || d.e.State.LastHeartbeat == nil || !d.e.State.Accepted {
		t.Fatalf("the device was taken off the control plane: %+v", d.e.State)
	}
	if len(said) != 1 {
		t.Fatalf("the log said it again: %q", said)
	}
}

// The same through a real check-in: the member is built by the agent itself.
func TestACheckInWhoseMemberTheServerRefusesIsStillAnswered(t *testing.T) {
	d := newCheckDevice(t)
	withAgentUpdate(t, d)
	refuseTheMember(d)
	var said []string
	d.e.Notice = func(line string) { said = append(said, line) }
	d.poll()
	beats := d.plane.sent()
	if len(beats) != 2 {
		t.Fatalf("%d requests", len(beats))
	}
	if beats[0]["agent_update"] == nil || beats[1]["agent_update"] != nil {
		t.Fatalf("the member was built and left out the other way round: %v / %v", carriesWithUpdate(beats[0]), carriesWithUpdate(beats[1]))
	}
	// What else the agent reports is as it was, request for request.
	if a, b := carries(beats[0]), carries(beats[1]); !slices.Equal(a, b) {
		t.Fatalf("the retry changed what else is reported: %v then %v", a, b)
	}
	if d.e.State.LastHeartbeat == nil || !slices.Equal(said, []string{memberRefusedLine}) {
		t.Fatalf("%v %q", d.e.State.LastHeartbeat, said)
	}
}

// A refusal the member doesn't explain is an ordinary failed check-in: nothing is
// marked, nothing is said.
func TestARefusalTheMemberDoesNotExplainLeavesNoMark(t *testing.T) {
	d := newCheckDevice(t)
	withAgentUpdate(t, d)
	refuseWhen(d, func(map[string]any) bool { return true })
	var said []string
	d.e.Notice = func(line string) { said = append(said, line) }
	h := fullHeartbeat()
	report := okReport()
	h.AgentUpdate = &report
	if _, _, err := d.e.exchange(t.Context(), h); err == nil {
		t.Fatal("a heartbeat the server always refuses went through")
	}
	if d.e.update.memberRefused || len(said) != 0 {
		t.Fatalf("a refusal that leaving the member out doesn't end left a mark: %v %q", d.e.update.memberRefused, said)
	}
}

// The member goes first and every other report goes in the order it always did:
// a server that refuses both the member and a log summary sees the member go
// first.
func TestTheMemberIsLeftOutBeforeEveryOtherReport(t *testing.T) {
	d := newCheckDevice(t)
	withAgentUpdate(t, d)
	refuseWhen(d, func(beat map[string]any) bool {
		return beat["agent_update"] != nil || beat["vector_log_summary"] != nil
	})
	h := fullHeartbeat()
	h.ValidationResult = nil
	report := okReport()
	h.AgentUpdate = &report
	before := len(d.plane.sent())
	if _, _, err := d.e.exchange(t.Context(), h); err != nil {
		t.Fatal(err)
	}
	var got [][]string
	for _, beat := range d.plane.sent()[before:] {
		got = append(got, carriesWithUpdate(beat))
	}
	if len(got) != 3 || !slices.Contains(got[0], reportAgentUpdate) || slices.Contains(got[1], reportAgentUpdate) || !slices.Contains(got[1], reportLogSummary) || slices.Contains(got[2], reportLogSummary) {
		t.Fatalf("the reports went out in this order: %v", got)
	}
}

// A member the agent builds wrong is never sent: the guard in front of the
// exchange leaves it out of the check-in, so the server has nothing to refuse.
func TestAMemberTheAgentCannotBuildRightIsNeverSent(t *testing.T) {
	d := newCheckDevice(t)
	withAgentUpdate(t, d)
	if err := WriteUpdatePolicy(viewPolicy(t, UpdateConsentAuto)); err != nil {
		t.Fatal(err)
	}
	d.e.update.decision = updateDecision{state: UpdateStateRefused} // a refusal with no code
	var said []string
	d.e.Notice = func(line string) { said = append(said, line) }
	d.poll()
	// One request, and without the member: there was nothing for the server to
	// refuse. The decision is the agent's own and the next check-in's step puts it
	// right, so the one after that carries a member again.
	if beats := d.plane.sent(); len(beats) != 1 || beats[0]["agent_update"] != nil || d.e.update.memberRefused {
		t.Fatalf("%d requests, the first carried %v, refused %v", len(beats), beats[0]["agent_update"], d.e.update.memberRefused)
	}
	if len(said) != 1 || !strings.Contains(said[0], "The agent update report was left out of a check-in") {
		t.Fatalf("the log said %q", said)
	}
	d.poll()
	if beats := d.plane.sent(); len(beats) != 2 || beats[1]["agent_update"] == nil {
		t.Fatalf("the member didn't come back once the agent had it right: %v", beats[len(beats)-1])
	}
}

// The report notices a result at once: the supervisor asks every few seconds
// while a build is on trial, and a heartbeat that carries the result is the end
// of that.
func TestTheSupervisorNoticesTheStepsVerdictOnABuildOnTrial(t *testing.T) {
	d := newCheckDevice(t)
	withAgentUpdate(t, d)
	paths := UpdateLocations()
	if err := WriteUpdatePolicy(viewPolicy(t, UpdateConsentAuto)); err != nil {
		t.Fatal(err)
	}
	release := strings.Repeat("e", 64)
	now := time.Now().UTC().Truncate(time.Second)
	writeStatus := func(change func(*UpdateStatus)) {
		t.Helper()
		status := freshStatus(now, change)
		status.RunAt = time.Now().UTC().Truncate(time.Second)
		dir, err := ensureRootOwnedDir(paths.StepDir, rootReadable)
		if err != nil {
			t.Fatal(err)
		}
		defer dir.Close()
		if err := WriteUpdateStatus(dir, *status); err != nil {
			t.Fatal(err)
		}
	}
	trial := func(s *UpdateStatus) {
		s.Stage, s.Release, s.FromVersion, s.ToVersion, s.Deadline = UpdateStageTrial, release, "0.0.9", Version, time.Now().UTC().Add(5*time.Minute).Truncate(time.Second)
	}
	writeStatus(trial)
	if d.e.updateAttention() {
		t.Fatal("asked for a check-in before any report said a build is on trial")
	}
	d.poll() // the member is built, and says: trial
	member, _ := d.plane.last()["agent_update"].(map[string]any)
	if member == nil {
		d.poll()
		member, _ = d.plane.last()["agent_update"].(map[string]any)
	}
	if member == nil || member["state"] != "trial" || member["release"] != release {
		t.Fatalf("the report says %v", member)
	}
	if d.e.updateAttention() {
		t.Fatal("asked for a check-in while nothing changed")
	}
	// The step commits: a result, and an idle stage.
	writeStatus(func(s *UpdateStatus) {
		s.Last = &UpdateLast{Release: release, Outcome: UpdateOutcomeCommitted, At: time.Now().UTC().Truncate(time.Second), FromVersion: "0.0.9", ToVersion: Version}
	})
	if !d.e.updateAttention() {
		t.Fatal("the step's verdict wasn't noticed")
	}
	// The check-in that follows carries it, and the supervisor stops asking.
	d.poll()
	member, _ = d.plane.last()["agent_update"].(map[string]any)
	if last, _ := member["last"].(map[string]any); last == nil || last["outcome"] != "committed" || last["release"] != release {
		t.Fatalf("the check-in after the verdict says %v", member)
	}
	if d.e.updateAttention() {
		t.Fatal("kept asking for a check-in after the verdict was reported")
	}
}
