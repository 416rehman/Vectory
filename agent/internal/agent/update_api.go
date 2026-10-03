package agent

import (
	"context"
	"errors"
)

// The privileged step's API, which the agent's host side (setup, `vectory update`
// and the offer handling) calls and the step's own code fills. The signatures are
// frozen: callers are written against them, so a change to one needs the callers'
// authors. The bodies here say the step isn't built into this binary; the code
// that implements the step replaces them.
//
// dir is the agent's state directory throughout.

// errUpdateHelperUnavailable is what every function here answers until the step
// is built for the operating system.
var errUpdateHelperUnavailable = errors.New("the privileged update step isn't available in this build")

// InstallUpdateHelper makes the host ready to apply updates: it makes the step's
// directory (UpdateLocations), copies executable, the running agent, into it as
// the helper the step runs from, records the build that is installed, and
// registers and starts the step's units (a timer, a launch daemon, a service). It
// is called by setup when the host consents, after the policy is written, and may
// be called again: it leaves a helper that is already the executable as it is.
func InstallUpdateHelper(dir, executable string) error { return errUpdateHelperUnavailable }

// RemoveUpdateHelper stops and removes the step's units and its directory. It is
// refused while a trial runs (the step's journal says swapping or trial), with
// the time it ends. Called by `vectory update off` and by service uninstall.
func RemoveUpdateHelper() error { return errUpdateHelperUnavailable }

// ApplyStagedUpdate applies the build the agent staged now, in the foreground, for
// a host whose level is ask: it runs the step's work through the same code the
// step runs, and says each stage it reaches through progress. force says the
// person has already been shown that the offer may be gone or stale and chose to
// go on. What authorizes the install is never the request or force: the step
// verifies the signed manifest, the pins and the policy itself.
func ApplyStagedUpdate(ctx context.Context, dir string, force bool, progress func(string)) error {
	return errUpdateHelperUnavailable
}

// RunUpdateHelper is one run of the privileged step: the hidden `update-helper`
// command calls it every 30 seconds and at boot. It reads its journal, takes the
// next step, writes status.json and returns.
func RunUpdateHelper(ctx context.Context, dir string) error { return errUpdateHelperUnavailable }

// UpdateEligibility is UpdateEligible when this host can take an agent update, and
// otherwise the code that says why not: PACKAGE_MANAGED, NO_SERVICE,
// UNTRUSTED_LOCATION, READ_ONLY, HELPER_NOT_RUNNING, SERVICE_DEFINITION_OUTDATED
// or PLATFORM_NOT_IN_RELEASE. Until the step is built for an operating system, it
// says PLATFORM_NOT_IN_RELEASE, so setup refuses to consent there and the agent
// reports that hosts of this kind update by hand.
func UpdateEligibility(dir string) string { return "PLATFORM_NOT_IN_RELEASE" }
