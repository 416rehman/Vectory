package agent

import "strconv"

// What `vectory doctor` says about agent updates, from the same view `vectory
// status` and `vectory update status` print, so that the three agree. It reads and
// changes nothing. A host that never consented gets one line saying so; a host that
// did is checked for what an update needs: a policy this agent may trust, an update
// step that ran lately, a host that can take a build, no fork of a pinned key, and
// what the last update came to. Every fix goes through CommandFor, so that a state
// directory with a space or a quote stays one argument.

// updateChecks are the doctor's checks of agent updates for a host.
func updateChecks(v UpdateView) []DoctorCheck {
	var checks []DoctorCheck
	add := func(id, status, title, detail, fix string) {
		checks = append(checks, DoctorCheck{ID: id, Status: status, Title: title, Detail: detail, Fix: fix})
	}
	upgrade := "Run the Upgrade agent command from the dashboard again" // it carries the update flags
	repin := repinCommand(v.StateDir, v.Policy)

	switch {
	case v.PolicyProblem != "":
		add("updates", "fail", "Updates", "The update policy can't be used, so this host takes no update: "+v.PolicyProblem+".",
			"Make "+onTheWay("it, and every directory above it,", "the directory the message names")+" writable by "+updateRootWord()+" alone, or write it again: "+lowerFirst(upgrade)+" with updates on.")
		return checks
	case v.Policy.Consent == UpdateConsentOff:
		fix := ""
		if v.Eligibility == UpdateEligible {
			fix = "To take updates from the dashboard, " + lowerFirst(upgrade) + " with updates on, once."
		}
		add("updates", "info", "Updates", v.Headline(), fix)
		return checks
	}
	add("updates", "ok", "Updates", v.PolicyLine(), "")

	// The privileged step: it ran in the last two minutes, or nothing applies a build.
	switch {
	case v.StatusProblem != "":
		add("updates-step", "fail", "Update step", "Its status can't be read: "+v.StatusProblem+".",
			onTheWay("Make every directory on its path root's alone.", "Make the directory the message names "+updateRootWord()+"'s alone."))
	case v.Status == nil:
		add("updates-step", "fail", "Update step", "It hasn't run on this host: it has written no status.", "Run "+repin+": it installs the update step.")
	case !v.StepRunning:
		add("updates-step", "fail", "Update step", "Not running: it last ran "+ago(v.ReadAt, v.Status.RunAt)+", and it runs every 30 seconds.", "If it doesn't start by itself, run "+repin+": it installs the update step again.")
	default:
		add("updates-step", "ok", "Update step", "running · last ran "+ago(v.ReadAt, v.Status.RunAt)+" · service definition "+strconv.Itoa(v.Status.ServiceDefinition), "")
	}

	// Whether the host can take a build, in the step's words.
	if v.StepRunning && v.Eligibility != UpdateEligible {
		status := "fail"
		if v.Eligibility == "PLATFORM_NOT_IN_RELEASE" {
			status = "info"
		}
		add("updates-host", status, "Update host", updateEligibilityWords(v.Eligibility)+" ("+v.Eligibility+").", updateEligibilityFix(v))
	}

	if conflict := v.Conflict(); conflict != nil {
		add("updates-key", "fail", "Update key", "Stopped: "+conflictSentence(conflict)+".", upgrade+" with the right key; it pins that key and ends the stop.")
	}

	// A rollback that keeps showing while the agent's service isn't running is one that
	// can't start the previous build yet.
	if v.startingThePreviousBuild() {
		add("updates-rollback", "warn", "Update rollback", "The update step is putting the previous build back, and the agent's service isn't running. It tries to start the previous build again every 30 seconds, and goes on until it can.",
			"Look at "+lookAtWords()+": the step logs why each try failed.")
	}

	if v.Staged != nil && v.Staged.Complete && v.Policy.Consent == UpdateConsentAsk && v.Status != nil && v.Status.Stage == UpdateStageIdle {
		what := "an update"
		if v.Staged.Version != "" {
			what = v.Staged.Version
		}
		add("updates-staged", "info", "Staged update", "Staged "+what+", offered "+humanDayClock(v.Staged.OfferedAt, v.ReadAt)+", and waiting for someone on this host.", "Apply it: "+AdminCommandFor(v.StateDir, "vectory update apply"))
	}

	if words, ok := v.LastResultWords(); ok {
		last := v.Status.Last
		switch {
		case last.Outcome == UpdateOutcomeCommitted:
			add("updates-last", "ok", "Last update", words, "")
		case last.Code == "ROLLBACK_UNHEALTHY":
			add("updates-last", "fail", "Last update", sentence(words), "Look at the agent's service ("+agentServiceLook()+") and the update step's log ("+updateStepLogWords()+"), then at the network and the server: the Service, Check-in and connection checks above show them.")
		default:
			add("updates-last", "warn", "Last update", sentence(words), "Nothing to do here: the next release reaches this host. The dashboard shows how the rollout went.")
		}
	}
	return checks
}

// updateEligibilityFix says what to do about a code that says why a host can't take
// an update.
func updateEligibilityFix(v UpdateView) string {
	dir := v.StateDir
	switch v.Eligibility {
	case "PACKAGE_MANAGED":
		return "Update the agent with its package manager. Agent updates from the dashboard need an agent that the Add device command installed."
	case "NO_SERVICE":
		return "Register the agent as a service with the Add device command, or " + AdminCommandFor(dir, "vectory service-install") + ", and make sure the service runs this executable for this state directory."
	case "UNTRUSTED_LOCATION":
		return onTheWay("Make every directory on the path of the agent, of the update policy and of the update step writable by root alone, and keep them so.",
			"Make the install directory, %ProgramData%\\Vectory and the directories in it that hold the update policy and the update step writable by "+updateRootWord()+" alone, and keep them so. The directories above them may let other accounts create entries, as a default Windows install does in C:\\ and in C:\\ProgramData, but none may delete, rename or take over what it holds.")
	case "READ_ONLY":
		return "Install the agent in a directory the update step can write (--install-dir), or make the install directory writable by it. " +
			"If the agent or its directory has an immutable or append-only flag, clear it (" + clearFlagWords() + "); the update step's log (" + updateStepLogWords() + ") names the path."
	case "HELPER_NOT_RUNNING":
		return "Run " + repinCommand(dir, v.Policy) + ": it installs the update step again."
	case "SERVICE_DEFINITION_OUTDATED":
		return "Run the Upgrade agent command from the dashboard again: it writes the newer service definition."
	}
	return ""
}

// repinCommand is the command that installs the update step again and changes
// nothing else the host agreed to: setup with the key or keys the host pins now,
// which its own policy names. On an enrolled host it needs no --server. A command
// that carries no update flag leaves the step alone, so the Upgrade agent command
// of a host that already agreed, which carries none, can't do this.
func repinCommand(dir string, policy UpdatePolicy) string {
	words := "vectory setup"
	for _, fingerprint := range policy.Fingerprints() {
		words += " --update-key-sha256 " + fingerprint
	}
	return AdminCommandFor(dir, words)
}

// lowerFirst makes the first letter of a sentence lower case, to continue it.
func lowerFirst(text string) string {
	if text == "" || text[0] < 'A' || text[0] > 'Z' {
		return text
	}
	return string(text[0]+'a'-'A') + text[1:]
}
