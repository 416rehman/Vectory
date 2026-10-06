package main

import (
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"

	"github.com/vectory/vectory/agent/internal/agent"
	"golang.org/x/term"
)

var setupCommand = command{
	name:    "setup",
	group:   "Get started",
	summary: "Install, enroll and start the agent in one step",
	usage:   "setup --server URL [--ca-sha256 HEX | --ca-file PATH] [flags]",
	about: `Checks this host, adopts Vector, enrolls with your server, registers the
service and waits for the first check-in. Nothing on the host changes until
every check has passed and you've entered the token. Safe to run again: it
resumes where it stopped, and restarts a running service on this build.
Restricted mode is the default; full mode only when you pass --mode full.
Ctrl-C during the wait for the check-in leaves the service running (exit 130).
Without a service manager (a container, WSL, Alpine's OpenRC), setup checks
in once and exits 3, because nothing keeps the agent running: run it under
your own supervisor with the command setup prints, and pass --service none
to say you will. Copy the whole command from Add device: it verifies the
download and your server's certificate, and keeps staging files private.
Linux and macOS use install.sh; Windows uses install.ps1 in administrator
PowerShell. Both download a prebuilt agent, with no compiler required.
Never use curl -k, which turns certificate checks off; use the reviewed CA
certificate or the system trust store instead.
Setup never takes over a Vector that is running. It records how that Vector
was started, copies every configuration file it loads into the state
directory (adoption-inventory, private to this account) and stops. When the
Vector loads several files, a directory, includes or configuration chosen by
an environment variable, setup names them: merge them into the one JSON file
the agent manages, or adopt them as they are with --adopt-existing.
Agent updates are opt-in, once, here: --updates auto or ask, with the
fingerprint of the release key to pin, lets the dashboard update this agent
with builds that key signed. Setup checks the fingerprint against the server's
own list of keys before it changes anything, and keeps the choice in a file
only root can write. Without any update flag setup leaves that choice as it
is, and a host that never agreed never updates itself. On a host that agreed,
--update-key-sha256, --update-track and --update-window without --updates
change only what they name (a new key re-pins the host) and keep the rest:
the level, the other parts and a pause. On a host that agreed to nothing they
are refused, with no other effect.
Pinning a key trusts its holder with root on this host.`,
	examples: setupExamples(runtime.GOOS),
	define:   defineSetup,
}

// Setup examples follow the platform of the prebuilt agent. A Windows user
// should not have to translate sudo, shell quoting or Unix paths to get started.
func setupExamples(platform string) []string {
	if platform == "windows" {
		return []string{
			"# Download the Windows installer from Add device. Open PowerShell as administrator in its folder.",
			`if ((Get-FileHash -LiteralPath .\vectory-install.ps1 -Algorithm SHA256).Hash -ne '<SHA-256 from Add device>') { throw 'Installer checksum mismatch' }`,
			`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\vectory-install.ps1 --name edge-01 --mode full`,
			`& .\vectory.exe setup --server https://vectory.example.com:8443 --ca-sha256 <64-hex-fingerprint>`,
			`& .\vectory.exe setup --server https://vectory.example.com:8443 --ca-file C:\Vectory\server-ca.pem --dry-run`,
			`& 'C:\Program Files\Vectory\vectory.exe' status`,
		}
	}
	checksum := "echo '<SHA-256 from Add device>  vectory-install.sh' | sha256sum -c -"
	if platform == "darwin" {
		checksum = "echo '<SHA-256 from Add device>  vectory-install.sh' | shasum -a 256 -c -"
	}
	return []string{
		`cd "$(mktemp -d)"`,
		"curl -fsSL --proto '=https' --proto-redir '=https' --cacert vectory-ca.pem -o vectory-install.sh https://vectory.example.com:8443/agent/v1/install.sh",
		checksum,
		"sudo sh vectory-install.sh --create-user",
		"sudo vectory setup --server https://vectory.example.com:8443 --ca-sha256 <64-hex-fingerprint> --create-user",
		"sudo vectory setup --server https://vectory.example.com:8443 --ca-file /etc/vectory/server-ca.pem",
		"sudo vectory setup --server https://vectory.example.com:8443 --token-file /run/secrets/vectory-token --service none",
		"sudo vectory setup --server https://vectory.example.com:8443 --dry-run",
		"sudo vectory setup --server https://vectory.example.com:8443 --ca-sha256 <64-hex-fingerprint> --updates auto --update-key-sha256 <64-hex-fingerprint> --update-window 'Mon-Fri 02:00-04:00'",
		"sudo vectory setup --server https://vectory.example.com:8443 --update-key-sha256 <64-hex-fingerprint>",
		"sudo vectory setup --server https://vectory.example.com:8443 --update-track minor",
		"sudo vectory setup --server https://vectory.example.com:8443 --updates off",
	}
}

func defineSetup(c *cli) func() int {
	defaults := agent.DefaultPaths()
	server := c.String("server", "", "URL", "Agent address of your Vectory server, such as https://vectory.example.com:8443")
	pin := c.String("ca-sha256", "", "HEX", "Trust the server's CA with this SHA-256 fingerprint (shown on Add device)")
	ca := c.String("ca-file", "", "PATH", "Trust the server through this CA certificate (PEM); --ca-file= uses the system store")
	name := c.String("name", "", "NAME", "Device name (default: this host's name)")
	mode := c.String("mode", "", "MODE", "restricted (default) or full")
	policy := c.String("capability-policy", "", "PATH", "Restricted-mode allowances: file roots, destinations and listeners (JSON)")
	vector := c.String("vector-binary", "", "PATH", "Vector to adopt (default: found on PATH or in the usual locations)")
	c.StateDir()
	managed := c.String("managed-config", defaults.ManagedConfig, "PATH", "The one configuration file the agent manages")
	service := c.String("service", "auto", "KIND", "auto, systemd, launchd, windows or none")
	account := c.String("service-user", defaults.ServiceUser, "NAME", "Account the service runs as")
	createUser := c.Bool("create-user", "Create the service account if it's missing (no login shell)")
	keep := c.Bool("keep-existing-vector", "Continue although another Vector is running; it's left untouched")
	adopt := c.Bool("adopt-existing", "Adopt the Vector that ran here as it is: the agent manages one JSON file and doesn't run the other files it loaded (backed up)")
	tokenFile := c.String("token-file", "", "PATH", "Read the enrollment token from a private file")
	tokenStdin := c.Bool("token-stdin", "Read the enrollment token from standard input")
	dashboard := c.HiddenString("dashboard-url", "dashboard address for the device link (set by the installer)")
	agentPath := c.HiddenString("agent-path", "where the service runs the agent from (set by the installer)")
	installerPreflight := c.HiddenString("installer-preflight", "staged candidate checked by the installer before replacing the agent")
	dryRun := c.Bool("dry-run", "Check everything and show the plan without changing anything")
	noWake := c.Bool("no-wake", noWakeHelp)
	updates := c.String("updates", "", "LEVEL", "Agent updates this host takes from the dashboard: auto, ask (wait for sudo vectory update apply) or off; leave it out to keep what the host agreed to")
	updateKeys := c.Strings("update-key-sha256", "HEX", "SHA-256 fingerprint of a release key to pin, as Add device shows it; repeat for up to 4 keys. Required with --updates auto or ask; without --updates it re-pins a host that already agreed")
	updateTrack := c.String("update-track", "", "TRACK", "Which releases the host takes: patch or minor (default patch); without --updates it changes only the track of a host that already agreed")
	updateWindows := c.Strings("update-window", "SPEC", "When an update may start, such as 'Mon-Fri 02:00-04:00' or 'daily 01:00-03:00 UTC'; repeat for up to 7, leave it out for any time; without --updates it replaces only the windows of a host that already agreed")
	c.JSON("Print one JSON document instead of progress lines")
	return func() int {
		if c.supplied("installer-preflight") && *installerPreflight == "" {
			fmt.Fprintln(c.stderr, "vectory setup: --installer-preflight needs the absolute staged candidate path")
			return exitUsage
		}
		if *pin != "" && c.supplied("ca-file") {
			fmt.Fprintln(c.stderr, "vectory setup: choose one of --ca-sha256 or --ca-file")
			return exitUsage
		}
		if *tokenStdin && *tokenFile != "" {
			fmt.Fprintln(c.stderr, "vectory setup: choose one of --token-file or --token-stdin")
			return exitUsage
		}
		if *adopt && *keep {
			fmt.Fprintln(c.stderr, "vectory setup: choose one of --adopt-existing or --keep-existing-vector")
			return exitUsage
		}
		options := agent.SetupOptions{
			Server: *server, CASHA256: *pin, Name: *name, Mode: *mode, Service: *service,
			CreateUser: *createUser, KeepExistingVector: *keep, AdoptExisting: *adopt, DashboardURL: *dashboard, DryRun: *dryRun, InstallerPreflight: *installerPreflight,
			Updates: *updates, UpdateKeys: *updateKeys, UpdateTrack: *updateTrack, UpdateWindows: *updateWindows,
		}
		if err := options.CheckUpdates(); err != nil {
			fmt.Fprintln(c.stderr, "vectory setup: "+err.Error())
			return exitUsage
		}
		if c.supplied("state-dir") {
			options.StateDir = *c.state
		}
		if c.supplied("service-user") {
			options.ServiceUser = *account
		}
		if c.supplied("no-wake") {
			options.NoWake = noWake
		}
		for flagName, target := range map[string]*string{"managed-config": &options.ManagedConfig, "capability-policy": &options.CapabilityPolicy} {
			value := map[string]string{"managed-config": *managed, "capability-policy": *policy}[flagName]
			if c.supplied(flagName) && value != "" {
				resolved, ok := c.resolvePath(flagName, value)
				if !ok {
					return exitUsage
				}
				*target = resolved
			}
		}
		if *vector != "" {
			options.VectorBinary = *vector
		}
		if *agentPath != "" {
			resolved, ok := c.resolvePath("agent-path", *agentPath)
			if !ok {
				return exitUsage
			}
			options.AgentPath = resolved
		}
		if c.supplied("ca-file") {
			value := *ca
			if value != "" {
				resolved, ok := c.resolvePath("ca-file", value)
				if !ok {
					return exitUsage
				}
				value = resolved
			}
			options.CAFile = &value
		}
		human := !*c.json
		color := human && colorEnabled(c.stdout)
		// Refuse an unsafe token file before any check or change; the token
		// itself is read only when enrollment needs it.
		tokenPath := ""
		if *tokenFile != "" {
			var ok bool
			if tokenPath, ok = c.resolvePath("token-file", *tokenFile); !ok {
				return exitUsage
			}
			f, err := agent.OpenEnrollmentTokenFile(tokenPath)
			if err != nil {
				return c.fail(err)
			}
			_ = f.Close()
		}
		if human {
			fmt.Fprintf(c.stdout, "Vectory agent setup %s%s\n", agent.Version, map[bool]string{true: " (dry run: nothing will change)"}[*dryRun || *installerPreflight != ""])
			options.Progress = func(step agent.SetupStep) { printStep(c.stdout, step, color) }
		}
		options.Token = func() (token string, err error) {
			// A short or mangled paste never reaches the server.
			defer func() {
				if err == nil {
					err = agent.CheckEnrollmentToken(token)
				}
			}()
			switch {
			case *tokenStdin:
				return readToken(os.Stdin)
			case tokenPath != "":
				f, err := agent.OpenEnrollmentTokenFile(tokenPath)
				if err != nil {
					return "", err
				}
				defer f.Close()
				return readToken(f)
			}
			return promptSecret("     Paste the enrollment token from Add device (input is hidden): ")
		}
		ctx, stop := interruptible()
		defer stop()
		result, err := agent.Setup(ctx, options)
		if !human {
			c.output(result)
		}
		code := setupExitCode(result, err, ctx.Err() != nil)
		if err != nil || !human {
			return code
		}
		connected := closingLabel(result)
		if result.DeviceURL != "" {
			fmt.Fprintf(c.stdout, "%s: %s\n", connected, result.DeviceURL)
		} else if result.Device != nil && !result.DryRun {
			fmt.Fprintf(c.stdout, "%s: %s is in Devices in the dashboard.\n", connected, result.Device.Name)
		}
		if result.Next != "" {
			fmt.Fprintf(c.stdout, "Next: %s\n", result.Next)
		}
		return code
	}
}

// setupExitCode is 0 when setup finished and something keeps the agent
// running, 3 when it finished but nothing does (no service manager, and
// --service none wasn't passed), 130 when interrupted and 1 when it failed.
func setupExitCode(result agent.SetupResult, err error, interrupted bool) int {
	switch {
	case err != nil && interrupted:
		return exitInterrupted
	case err != nil:
		return exitFailed
	case result.NeedsAttention:
		return exitAttention
	}
	return exitOK
}

// closingLabel is "Connected" only when this run saw the agent check in (its
// own check-in, or a service or running agent that did); otherwise the line
// only points at the device. An upgrade that leaves an existing workload for
// the operator to start never checked in.
func closingLabel(result agent.SetupResult) string {
	if result.NeedsAttention {
		return "Device"
	}
	for _, step := range result.Steps {
		if step.Status == "ok" && (step.ID == "checkin" || step.ID == "service") {
			return "Connected"
		}
	}
	return "Device"
}

var stepMarks = map[string]string{"ok": "[ok]", "info": "[i] ", "warn": "[!!]", "fail": "[!!]", "plan": "[..]"}
var stepColors = map[string]string{"ok": "\x1b[32m", "info": "\x1b[36m", "warn": "\x1b[33m", "fail": "\x1b[31m", "plan": "\x1b[36m"}

func printStep(w io.Writer, step agent.SetupStep, color bool) {
	mark := stepMarks[step.Status]
	if color {
		mark = stepColors[step.Status] + mark + "\x1b[0m"
	}
	// Continuation lines (a fingerprint comparison) stay under the detail.
	fmt.Fprintf(w, "%s %-12s %s\n", mark, step.Label, agent.IndentLines(step.Detail, 18))
	if step.Fix != "" {
		fix := "     " + strings.Repeat(" ", 13) + agent.IndentLines(step.Fix, 18)
		if color {
			fix = "\x1b[2m" + fix + "\x1b[0m"
		}
		fmt.Fprintln(w, fix)
	}
}

func colorEnabled(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && term.IsTerminal(int(f.Fd())) && os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
}
