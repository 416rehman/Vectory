package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/vectory/vectory/agent/internal/agent"
)

var commands []command

func init() {
	commands = []command{
		setupCommand,
		{name: "status", group: "Get started", summary: "Show this device's connection, service and pipeline",
			usage:    "status [--state-dir PATH] [--json]",
			about:    "Reads local state only; it never contacts the server. Use doctor to test the connection.",
			examples: []string{"sudo vectory status", "sudo vectory status --json"},
			define:   defineStatus},
		{name: "doctor", group: "Get started", summary: "Check the setup and the connection, and say what to fix",
			usage:    "doctor [--state-dir PATH] [--json]",
			about:    "Checks the installation, then DNS, TCP, TLS, clock and credential against the server. It sends no heartbeat and changes nothing. Exits 1 if a check fails.",
			examples: []string{"sudo vectory doctor", "sudo vectory doctor --json"},
			define:   defineDoctor},
		{name: "run", group: "Run the agent", summary: "Run in the foreground (Ctrl-C stops it and its Vector)",
			usage:    "run [--state-dir PATH] [--no-wake] [--json]",
			about:    "Keeps checking in and applying configuration until stopped. Exits 78 when the agent isn't installed or enrolled, so service managers don't restart it in a loop.",
			examples: []string{"sudo vectory run", "sudo vectory run --state-dir /srv/vectory/agent"},
			define:   defineRun("run")},
		{name: "service", group: "Run the agent", hidden: true, summary: "Service entry point", usage: "service [--state-dir PATH]", define: defineRun("service")},
		{name: "service-install", group: "Run the agent", summary: "Register the agent as a system service",
			usage:    "service-install [--state-dir PATH] [--service-user NAME]",
			about:    "Registers systemd (Linux), launchd (macOS) or a Windows service that runs `vectory run` as an unprivileged account, and hands it the state and managed-config directories. It doesn't start the service.",
			examples: []string{"sudo vectory service-install --service-user vectory", "sudo vectory service-start"},
			define:   defineServiceInstall},
		{name: "service-start", group: "Run the agent", summary: "Start the registered service", usage: "service-start", define: defineServiceControl("start")},
		{name: "service-stop", group: "Run the agent", summary: "Stop the registered service (and its Vector)", usage: "service-stop", define: defineServiceControl("stop")},
		{name: "service-uninstall", group: "Run the agent", summary: "Remove the service registration; state is kept", usage: "service-uninstall", define: defineServiceControl("uninstall")},
		{name: "install", group: "Step by step", summary: "Adopt a Vector binary and the file the agent manages",
			usage: "install --vector-binary PATH --managed-config PATH --adopt [flags]",
			about: "Creates the private state directory and records the Vector binary (pinned by SHA-256) and the one JSON file the agent manages. It doesn't start Vector. On an existing installation it updates only the options you pass; the agent must be stopped.",
			examples: []string{
				"sudo vectory install --vector-binary /usr/bin/vector --managed-config /etc/vectory/managed/vector.json --adopt",
				"sudo vectory install --capability-policy /etc/vectory/allowances.json",
			},
			define: defineInstall},
		{name: "enroll", group: "Step by step", summary: "Connect this host to a Vectory server with a token",
			usage: "enroll --server URL [--ca-sha256 HEX | --ca-file PATH] [--name NAME] [flags]",
			about: "Verifies the server first, then exchanges the token for this device's own identity. The token is read from a hidden prompt unless you use --token-file or --token-stdin. If the server may have received a request, run the same command again: it retries that request, and a new token is fine.",
			examples: []string{
				"sudo vectory enroll --server https://vectory.example.com:8443 --ca-sha256 <64-hex-fingerprint>",
				"sudo vectory enroll --server https://vectory.example.com:8443 --name web-01 --token-file /run/secrets/vectory-token",
			},
			define: defineEnroll(false)},
		{name: "pause", group: "Day to day", summary: "Stop applying changes from the server on this host",
			usage: "pause [--state-dir PATH]", about: "The current configuration keeps running and the agent keeps checking in. The dashboard can't lift this pause.",
			define: definePause(true)},
		{name: "resume", group: "Day to day", summary: "Apply changes from the server again", usage: "resume [--state-dir PATH]", define: definePause(false)},
		{name: "retry", group: "Day to day", summary: "Allow a failed configuration to be tried again", usage: "retry [--state-dir PATH]",
			about:  "Lifts this host's hold on the version that failed, so the agent tries it again. While the agent runs, the request is queued and the agent tries again within a few seconds; when it is stopped, it tries at its next start. When nothing has failed here, it says so and changes nothing. Retry on the device page does the same from the dashboard.",
			define: defineRetry},
		{name: "allow", group: "Day to day", summary: "Approve a destination, listener or file root in restricted mode",
			usage:    "allow [--network HOST:PORT]... [--listener ADDR:PORT]... [--file-root PATH]... [--state-dir PATH]",
			about:    "Adds to this host's restricted-mode allowances and keeps everything already allowed. Only a host operator can do this; the dashboard can't. Run it while the agent is stopped. A version this host refused is tried again when the agent starts. The change is noted in `vectory logs`.",
			examples: []string{"sudo vectory service-stop && sudo vectory allow --network logs.example.net:443 && sudo vectory service-start", "sudo vectory allow --listener 0.0.0.0:514 --file-root /var/log/nginx"},
			define:   defineAllow},
		{name: "logs", group: "Day to day", summary: "Show Vector's own log on this host",
			usage:    "logs [--lines N] [--follow] [--raw | --json] [--state-dir PATH]",
			about:    "Prints Vector's recent log lines (startup, reloads, component warnings and errors) from the agent's rotated log file. It never streams your events, but a pipeline that logs event fields (VRL log()) shows them. Control characters in that text show as escapes such as \\x1b, and --json escapes them too; --raw prints the file's lines unchanged and can hold terminal escape sequences. Works while the service runs. --json prints one JSON object per line: Vector's records as they are, and the agent's notes with the same timestamp, target and message keys.",
			examples: []string{"sudo vectory logs --follow", "sudo vectory logs --lines 500 --json"},
			define:   defineLogs},
		{name: "configure-metrics", group: "Day to day", summary: "Set or clear the local Vector metrics URL",
			usage: "configure-metrics (--metrics-url URL | --clear-metrics-url) [--state-dir PATH]", about: "Run it while the agent is stopped.",
			examples: []string{"sudo vectory configure-metrics --metrics-url http://127.0.0.1:9598/metrics"},
			define:   defineConfigureMetrics},
		{name: "configure-secrets", group: "Day to day", summary: "Map vectory-secret:NAME references to local files",
			usage: "configure-secrets --secret-files PATH [--state-dir PATH]", about: "PATH is a JSON object of names to private absolute file paths; {} removes every binding. Run it while the agent is stopped.",
			define: defineConfigureSecrets},
		{name: "re-adopt", group: "Day to day", summary: "Approve a Vector binary you replaced on purpose",
			usage:    "re-adopt --expected-sha256 SHA256 [--vector-binary PATH] [--state-dir PATH]",
			about:    "Run it while the agent is stopped. The binary must match the SHA-256 you approved independently; the existing configuration is validated with it.",
			examples: []string{"sudo vectory re-adopt --expected-sha256 \"$(sha256sum /usr/bin/vector | cut -d' ' -f1)\""},
			define:   defineReAdopt},
		{name: "unenroll", group: "Remove or recover", summary: "Delete this host's credentials (also revoke it in the dashboard)", usage: "unenroll [--state-dir PATH]", define: defineUnenroll},
		{name: "recover-enrollment", group: "Remove or recover", summary: "Re-enroll with an administrator's recovery token",
			usage: "recover-enrollment [--token-file PATH | --token-stdin] [--state-dir PATH]", about: "Replaces this host's identity using a one-use recovery token that an administrator issued on the device page.",
			define: defineEnroll(true)},
		{name: "uninstall", group: "Remove or recover", summary: "Keep state for a reinstall, or delete it with --purge",
			usage:    "uninstall [--purge --state-dir PATH]",
			about:    "Without --purge nothing is deleted. With --purge the exact state directory is deleted after the service is removed; Vector and the managed configuration stay.",
			examples: []string{"sudo vectory service-uninstall", "sudo vectory uninstall --purge --state-dir /var/lib/vectory-agent"},
			define:   defineUninstall},
	}
}

func defineStatus(c *cli) func() int {
	c.StateDir()
	c.JSON("Print one JSON document")
	return func() int {
		ctx, stop := interruptible()
		defer stop()
		view, err := agent.ReadStatus(ctx, *c.state)
		if err != nil {
			return c.fail(err)
		}
		if *c.json {
			c.output(agent.StatusJSON(view))
		} else {
			fmt.Fprint(c.stdout, agent.RenderStatus(view, time.Now()))
		}
		return exitOK
	}
}

func defineDoctor(c *cli) func() int {
	c.StateDir()
	c.JSON("Print one JSON document")
	return func() int {
		ctx, stop := interruptible()
		defer stop()
		report, err := agent.RunDoctor(ctx, *c.state)
		if err != nil {
			if *c.json {
				c.output(map[string]any{"ok": false, "state_dir": *c.state, "error": err.Error()})
				return exitFailed
			}
			return c.fail(err)
		}
		if *c.json {
			c.output(agent.DoctorJSON(report))
		} else {
			fmt.Fprint(c.stdout, agent.RenderDoctor(report))
		}
		if report.Failed() {
			return exitFailed
		}
		return exitOK
	}
}

// noWakeHelp describes --no-wake on setup, run and install.
const noWakeHelp = "Check in on schedule only: don't keep a connection open to hear about changes at once (for networks that cut idle connections)"

func defineRun(name string) func(c *cli) func() int {
	return func(c *cli) func() int {
		c.StateDir()
		c.JSON("Log one JSON object per line")
		verbose := c.Bool("verbose", "Also log every check-in, not only what changed")
		once := c.HiddenBool("once", "one reconciliation, then stop the owned Vector (tests only)")
		noWake := new(bool)
		if name == "run" {
			noWake = c.Bool("no-wake", noWakeHelp)
		}
		return func() int {
			dir := *c.state
			if err := agent.CheckInstalled(dir); err != nil {
				c.fail(err)
				return exitNotReady
			}
			if _, _, err := agent.ReadIdentity(dir); err != nil {
				if os.IsNotExist(err) {
					c.fail(errors.New("this agent isn't enrolled yet. Enroll it with the command from Add device (vectory setup or vectory enroll), then start it again"))
					return exitNotReady
				}
				return c.fail(err)
			}
			report := func(message string) {
				if *c.json {
					c.output(map[string]string{"time": time.Now().UTC().Format(time.RFC3339), "message": message})
				} else {
					fmt.Fprintf(c.stderr, "%s %s\n", time.Now().Format("15:04:05"), message)
				}
			}
			if settings, err := agent.LoadSettings(dir); err == nil {
				report(fmt.Sprintf("Vectory agent %s · %s · %s · %s mode · Vector at %s", agent.Version, settings.Name, settings.Server, settings.CapabilityPolicy.ConfigurationMode(), settings.VectorBinary))
			}
			ctx, stop := interruptible()
			defer stop()
			var err error
			switch {
			case name == "service":
				err = service(ctx, dir, report)
			case (*noWake || *verbose) && !*once:
				err = agent.RunContinuous(ctx, dir, *noWake, *verbose, report)
			default:
				err = agent.Run(ctx, dir, *once, report)
			}
			if err != nil {
				// A second agent on one state directory is refused; this isn't a
				// maintenance command waiting for the first to stop.
				var held *agent.LockHeldError
				if errors.As(err, &held) {
					err = errors.New(held.AlreadyRunning())
				}
				return c.fail(err)
			}
			return exitOK
		}
	}
}

func defineServiceInstall(c *cli) func() int {
	c.StateDir()
	account := c.String("service-user", agent.DefaultPaths().ServiceUser, "NAME", "Unprivileged account the service runs as (Windows always uses NT SERVICE\\Vectory)")
	return func() int {
		if err := agent.CheckInstalled(*c.state); err != nil {
			return c.fail(err)
		}
		registration, err := agent.ServiceInstall(*c.state, *account)
		if err != nil {
			return c.fail(err)
		}
		switch registration {
		case agent.ServiceUpdated:
			fmt.Fprintf(c.stdout, "Updated the %s definition for %s (runs as %s).\nA running service uses it from its next restart: sudo vectory service-stop && sudo vectory service-start\n", agent.ServiceName, *c.state, *account)
		case agent.ServiceUnchanged:
			fmt.Fprintf(c.stdout, "%s is already registered for %s (runs as %s).\n", agent.ServiceName, *c.state, *account)
		default:
			fmt.Fprintf(c.stdout, "Registered %s for %s (runs as %s).\nNext: sudo vectory service-start\n", agent.ServiceName, *c.state, *account)
		}
		return exitOK
	}
}

func defineServiceControl(action string) func(c *cli) func() int {
	return func(c *cli) func() int {
		c.HiddenString("state-dir", "not accepted: service commands act on the registered service")
		return func() int {
			if flagSupplied(c.fs, "state-dir") {
				fmt.Fprintln(c.stderr, "vectory: service control targets the fixed Vectory service; --state-dir cannot select another service")
				return exitUsage
			}
			if err := agent.ServiceControl(action); err != nil {
				return c.fail(err)
			}
			switch action {
			case "start":
				// The service runs for the state directory it was registered with.
				fmt.Fprintf(c.stdout, "Started %s.\nCheck it: %s\n", agent.ServiceName, agent.CommandFor(agent.ServiceStatus(context.Background()).StateDir, "sudo vectory status"))
			case "stop":
				fmt.Fprintf(c.stdout, "Stopped %s. Its Vector is stopped too; the configuration is kept.\n", agent.ServiceName)
			default:
				fmt.Fprintf(c.stdout, "Removed %s. State and identity are kept; delete them with: vectory uninstall --purge --state-dir PATH\n", agent.ServiceName)
			}
			return exitOK
		}
	}
}

func defineInstall(c *cli) func() int {
	c.StateDir()
	binary := c.String("vector-binary", "", "PATH", "Vector binary to adopt (pinned by its SHA-256)")
	config := c.String("managed-config", "", "PATH", "The one JSON file the agent manages, in a directory of its own")
	adopt := c.Bool("adopt", "Confirm the agent takes over this Vector binary and file (fresh installations)")
	policyPath := c.String("capability-policy", "", "PATH", "Restricted-mode allowances: file roots, destinations and listeners (JSON)")
	full := c.Bool("allow-full-vector-config", "Grant full mode: pipelines get every Vector feature with Vector's host permissions; =false returns to restricted")
	metrics := c.String("metrics-url", "", "URL", "Local Vector metrics endpoint, such as http://127.0.0.1:9598/metrics")
	clearMetrics := c.Bool("clear-metrics-url", "Remove the local metrics endpoint setting")
	secretFiles := c.String("secret-files", "", "PATH", "JSON map of vectory-secret names to private files")
	dataDir := c.String("vector-data-dir", "", "PATH", "Data directory for pipelines that don't set data_dir; empty restores the automatic choice")
	graceful := c.Int("graceful-shutdown-seconds", 0, "SECONDS", "Seconds Vector may drain on stop or restart, 5-300 (default 60)")
	noWake := c.Bool("no-wake", noWakeHelp+"; =false turns wake-ups back on")
	c.JSON("Print one JSON document")
	return func() int {
		if err := metricsOptionUsage(c.fs, *clearMetrics, false); err != nil {
			fmt.Fprintln(c.stderr, "vectory:", err)
			return exitUsage
		}
		ctx, stop := interruptible()
		defer stop()
		opts := agent.InstallOptions{Adopt: *adopt, ClearMetricsURL: *clearMetrics}
		var err error
		c.fs.Visit(func(f *flag.Flag) {
			if err != nil {
				return
			}
			switch f.Name {
			case "vector-binary":
				var resolved agent.ResolvedPath
				if resolved, err = agent.ResolveExecutablePath(*binary); err == nil {
					if resolved.Resolved {
						fmt.Fprintf(c.stderr, "Adopting %s (%s is a symbolic link). After upgrading Vector, approve the new binary with %s.\n", resolved.Path, *binary, agent.CommandFor(*c.state, "vectory re-adopt"))
					}
					*binary = resolved.Path
					opts.VectorBinary = binary
				}
			case "managed-config":
				if *config != "" {
					var ok bool
					if *config, ok = c.resolvePath("managed-config", *config); !ok {
						err = errors.New("invalid --managed-config")
						return
					}
				}
				opts.ManagedConfig = config
			case "allow-full-vector-config":
				opts.FullVectorConfig = full
			case "metrics-url":
				opts.MetricsURL = metrics
			case "capability-policy":
				opts.CapabilityPolicy, err = agent.ReadInstallPolicy(*policyPath)
			case "secret-files":
				opts.SecretFiles, err = agent.ReadSecretBindings(*secretFiles)
			case "vector-data-dir":
				if *dataDir != "" {
					var ok bool
					if *dataDir, ok = c.resolvePath("vector-data-dir", *dataDir); !ok {
						err = errors.New("invalid --vector-data-dir")
						return
					}
				}
				opts.VectorDataDir = dataDir
			case "graceful-shutdown-seconds":
				opts.GracefulShutdownSeconds = graceful
			case "no-wake":
				opts.NoWake = noWake
			}
		})
		if err == nil {
			err = agent.InstallWithOptions(ctx, *c.state, opts)
		}
		if err != nil {
			return c.fail(err)
		}
		if opts.MetricsURL != nil || opts.ClearMetricsURL {
			reportMetricsConfiguration(c, "install", opts.ClearMetricsURL)
			return exitOK
		}
		if *c.json {
			c.output(map[string]string{"status": "ok", "command": "install", "state_dir": *c.state})
			return exitOK
		}
		settings, _ := agent.LoadSettings(*c.state)
		fmt.Fprintf(c.stdout, "Installed in %s · Vector at %s · %s mode.\n", *c.state, settings.VectorBinary, settings.CapabilityPolicy.ConfigurationMode())
		if opts.CapabilityPolicy != nil {
			// The file replaced the allowance lists: say what they are now.
			fmt.Fprintf(c.stdout, "This host allows %s.\n", agent.DescribeAllowances(settings.CapabilityPolicy))
			agent.NoteLocally(*c.state, "Host operator replaced the allowances: "+agent.DescribeAllowances(settings.CapabilityPolicy)+" (vectory install --capability-policy)")
		}
		if _, _, err := agent.ReadIdentity(*c.state); err != nil {
			fmt.Fprintln(c.stdout, "Next: enroll this host with the command from Add device (vectory enroll --server URL ...).")
		}
		return exitOK
	}
}

func defineEnroll(recover bool) func(c *cli) func() int {
	return func(c *cli) func() int {
		c.StateDir()
		var server, name, pin *string
		if !recover {
			server = c.String("server", "", "URL", "Agent address of your Vectory server, such as https://vectory.example.com:8443")
			pin = c.String("ca-sha256", "", "HEX", "Trust the server's CA with this SHA-256 fingerprint (shown on Add device)")
		} else {
			server = c.HiddenString("server", "recovery keeps the enrolled server")
			pin = new(string)
		}
		ca := c.String("ca-file", "", "PATH", "Trust the server through this CA certificate (PEM); --ca-file= uses the system store; omit it to keep the saved trust")
		if !recover {
			name = c.String("name", "", "NAME", "Device name, unique in your fleet")
		} else {
			name = c.HiddenString("name", "recovery keeps the enrolled name")
		}
		id := c.HiddenString("id", "compatibility alias for --name")
		compatServer := c.HiddenString("ip", "compatibility alias for --server")
		tokenFile := c.String("token-file", "", "PATH", "Read the token from a private file")
		stdin := c.Bool("token-stdin", "Read the token from standard input")
		token := c.HiddenString("token", "compatibility token argument (visible in process listings)")
		c.JSON("Print one JSON document")
		return func() int {
			if *name == "" {
				*name = *id
			}
			if *server == "" {
				*server = *compatServer
			}
			var caOption *string
			if c.supplied("ca-file") {
				if *ca != "" {
					var ok bool
					if *ca, ok = c.resolvePath("ca-file", *ca); !ok {
						return exitUsage
					}
				}
				caOption = ca
			}
			count := 0
			for _, used := range []bool{*stdin, *tokenFile != "", *token != ""} {
				if used {
					count++
				}
			}
			if count > 1 {
				return c.fail(errors.New("choose only one token input"))
			}
			// Token input is checked before any state is touched: a public or
			// alternate-stream token file is refused at input preflight.
			var fileToken string
			if *tokenFile != "" {
				path, ok := c.resolvePath("token-file", *tokenFile)
				if !ok {
					return exitUsage
				}
				f, err := agent.OpenEnrollmentTokenFile(path)
				if err != nil {
					return c.fail(err)
				}
				fileToken, err = readToken(f)
				_ = f.Close()
				if err != nil {
					return c.fail(err)
				}
			}
			dir := *c.state
			if err := agent.CheckInstalled(dir); err != nil {
				var missing *agent.NotInstalledError
				if errors.As(err, &missing) {
					return c.fail(errors.New("install the agent first: vectory install ... (or use vectory setup, which installs and enrolls)"))
				}
				return c.fail(err)
			}
			// Before a hidden prompt, check everything that doesn't need the token,
			// so nobody types a secret only to hear the address was wrong.
			prompt := !*stdin && *tokenFile == "" && *token == ""
			if prompt {
				if _, _, err := agent.ReadIdentity(dir); err == nil && !recover {
					return c.fail(errors.New("already enrolled; identity and settings are preserved"))
				}
				if !recover {
					if *server != "" {
						if _, err := agent.NormalizeServer(*server); err != nil {
							return c.fail(err)
						}
					}
					if *name != "" {
						if err := agent.ValidateDeviceName(*name); err != nil {
							return c.fail(err)
						}
					}
					if *pin != "" {
						if _, err := agent.ParseCAFingerprint(*pin); err != nil {
							return c.fail(err)
						}
					}
				}
				if caOption != nil && *caOption != "" {
					if _, err := os.Stat(*caOption); err != nil {
						return c.fail(fmt.Errorf("cannot read trusted CA file %s; check the path and the agent account's read access", *caOption))
					}
				}
			}
			var value string
			var err error
			switch {
			case *stdin:
				value, err = readToken(os.Stdin)
			case *tokenFile != "":
				value = fileToken
			case *token != "":
				fmt.Fprintln(c.stderr, "Warning: command-line tokens may appear in shell history and process listings; prefer --token-stdin.")
				value = *token
			default:
				value, err = promptSecret("Enrollment token (input hidden): ")
			}
			if err == nil {
				// A short or mangled paste never reaches the server.
				err = agent.CheckEnrollmentToken(value)
			}
			if err != nil {
				return c.fail(err)
			}
			ctx, stop := interruptible()
			defer stop()
			if err = agent.EnrollWithOptions(ctx, dir, agent.EnrollmentOptions{Server: *server, Name: *name, CAFile: caOption, CASHA256: *pin, Token: value, Recover: recover}); err != nil {
				return c.fail(err)
			}
			credentials, _, _ := agent.ReadIdentity(dir)
			settings, _ := agent.LoadSettings(dir)
			if *c.json {
				c.output(map[string]string{"status": "ok", "command": c.cmd.name, "device_id": credentials.DeviceID, "name": settings.Name, "server": settings.Server})
				return exitOK
			}
			verb := "Enrolled"
			if recover {
				verb = "Recovered"
			}
			fmt.Fprintf(c.stdout, "%s as %s (device %s) with %s.\nNext: start the agent with %s, or run it as a service with %s.\n", verb, settings.Name, shortID(credentials.DeviceID), settings.Server, agent.RunCommandFor(dir), agent.CommandFor(dir, "sudo vectory setup"))
			return exitOK
		}
	}
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func definePause(pause bool) func(c *cli) func() int {
	return func(c *cli) func() int {
		c.StateDir()
		c.JSON("Print one JSON document")
		return func() int {
			if err := agent.SetPause(*c.state, pause); err != nil {
				return c.fail(err)
			}
			name := map[bool]string{true: "pause", false: "resume"}[pause]
			if *c.json {
				c.output(map[string]string{"status": "ok", "command": name})
			} else if pause {
				fmt.Fprintln(c.stdout, "Paused on this host. The current configuration keeps running and the agent keeps checking in; changes from the server wait until you run: "+agent.CommandFor(*c.state, "sudo vectory resume"))
			} else {
				fmt.Fprintln(c.stdout, "Resumed. At its next check-in the agent applies the latest configuration from the server, replacing local edits to the managed file. A pause set from the dashboard still applies.")
			}
			return exitOK
		}
	}
}

// maxLogLines bounds --lines: two rotated log files hold far fewer.
const maxLogLines = 100000

func defineLogs(c *cli) func() int {
	c.StateDir()
	follow := c.Bool("follow", "Keep printing new lines until interrupted (also -f)")
	c.fs.BoolVar(follow, "f", false, "Shorthand for --follow")
	lines := c.Int("lines", 100, "N", "Number of recent lines to print")
	raw := c.Bool("raw", "Print the log file's lines unchanged (they can hold terminal escape sequences)")
	c.JSON("Print one JSON object per line")
	c.oneLine = true
	return func() int {
		if *lines < 1 || *lines > maxLogLines {
			fmt.Fprintf(c.stderr, "vectory logs: --lines needs a whole number from 1 to %d, and %d isn't one\n", maxLogLines, *lines)
			return exitUsage
		}
		// A mistyped --state-dir is "no agent here", not "no Vector log yet".
		if err := agent.CheckInstalled(*c.state); err != nil {
			return c.fail(err)
		}
		ctx, stop := interruptible()
		defer stop()
		format := agent.LogText
		switch {
		case *c.json:
			format = agent.LogJSON
		case *raw:
			format = agent.LogRaw
		}
		if err := agent.WriteVectorLog(ctx, *c.state, *lines, *follow, format, c.stdout); err != nil {
			return c.fail(err)
		}
		return exitOK
	}
}

func defineRetry(c *cli) func() int {
	c.StateDir()
	c.JSON("Print one JSON document")
	return func() int {
		// Only a version that failed here is held back; without one, a retry
		// would change nothing, so it says so instead of promising an attempt.
		if nothingFailed(*c.state) {
			if *c.json {
				c.output(map[string]any{"status": "ok", "command": "retry", "nothing_failed": true})
			} else {
				fmt.Fprintln(c.stdout, "Nothing to retry: no version has failed on this host. `"+agent.CommandFor(*c.state, "vectory status")+"` shows what it runs.")
			}
			return exitOK
		}
		err := agent.Retry(*c.state)
		var held *agent.LockHeldError
		switch {
		case errors.As(err, &held) && held.Owner != nil && (held.Owner.Command == "run" || held.Owner.Command == "service"):
			// The agent runs: leave the request for it, as pause does.
			if err := agent.QueueRetry(*c.state); err != nil {
				return c.fail(err)
			}
			if *c.json {
				c.output(map[string]any{"status": "ok", "command": "retry", "queued": true, "agent_pid": held.Owner.PID})
			} else {
				fmt.Fprintf(c.stdout, "Retry queued. The running agent (pid %d) tries the failed version again within a few seconds; `%s` and the device page show the result.\n", held.Owner.PID, agent.CommandFor(*c.state, "vectory logs"))
			}
			return exitOK
		case err != nil:
			return c.fail(err)
		}
		if *c.json {
			c.output(map[string]string{"status": "ok", "command": "retry"})
		} else {
			fmt.Fprintln(c.stdout, "Retry allowed. Start the agent; it tries the failed version again at its first check-in.")
		}
		return exitOK
	}
}

// nothingFailed reports whether this host's state records no failed version,
// so a retry has nothing to lift. A missing or unreadable state is left to
// Retry, which explains it.
func nothingFailed(dir string) bool {
	if info, err := os.Lstat(filepath.Join(dir, "state.json")); err != nil || !info.Mode().IsRegular() {
		return false
	}
	state, err := agent.LoadState(dir)
	return err == nil && state.FailedGeneration == nil && state.FailedEffectiveSHA256 == ""
}

func defineAllow(c *cli) func() int {
	c.StateDir()
	network := c.Strings("network", "HOST:PORT", "A destination pipelines may send to, exactly host:port (repeat for more)")
	listener := c.Strings("listener", "ADDR:PORT", "An address pipelines may listen on (repeat for more)")
	roots := c.Strings("file-root", "PATH", "A directory pipelines may read and write under (repeat for more)")
	c.JSON("Print one JSON document")
	return func() int {
		if len(*network)+len(*listener)+len(*roots) == 0 {
			fmt.Fprintln(c.stderr, "vectory allow: name at least one --network, --listener or --file-root")
			return exitUsage
		}
		dir := *c.state
		if err := agent.CheckInstalled(dir); err != nil {
			return c.fail(err)
		}
		before, err := agent.LoadSettings(dir)
		if err != nil {
			return c.fail(err)
		}
		add := agent.CapabilityPolicy{AllowedNetworkHosts: *network, AllowedListenAddresses: *listener, AllowedFileRoots: *roots}
		ctx, stop := interruptible()
		defer stop()
		// The same locked, access-preserving writer as install: only a host
		// operator changes local policy, and nothing already allowed goes away.
		if err := agent.InstallWithOptions(ctx, dir, agent.InstallOptions{AddAllowances: &add}); err != nil {
			return c.fail(err)
		}
		after, err := agent.LoadSettings(dir)
		if err != nil {
			return c.fail(err)
		}
		added := agent.CapabilityPolicy{
			AllowedNetworkHosts:    newEntries(before.CapabilityPolicy.AllowedNetworkHosts, after.CapabilityPolicy.AllowedNetworkHosts),
			AllowedListenAddresses: newEntries(before.CapabilityPolicy.AllowedListenAddresses, after.CapabilityPolicy.AllowedListenAddresses),
			AllowedFileRoots:       newEntries(before.CapabilityPolicy.AllowedFileRoots, after.CapabilityPolicy.AllowedFileRoots),
		}
		changed := len(added.AllowedNetworkHosts)+len(added.AllowedListenAddresses)+len(added.AllowedFileRoots) > 0
		if changed {
			agent.NoteLocally(dir, "Host operator allowed "+agent.DescribeAllowances(added)+" (vectory allow)")
		}
		if *c.json {
			c.output(map[string]any{"status": "ok", "command": "allow", "changed": changed, "added": allowanceLists(added), "allowances": allowanceLists(after.CapabilityPolicy)})
			return exitOK
		}
		if changed {
			fmt.Fprintf(c.stdout, "Allowed %s.\n", agent.DescribeAllowances(added))
		} else {
			fmt.Fprintln(c.stdout, "Already allowed; nothing changed.")
		}
		fmt.Fprintf(c.stdout, "This host allows %s.\n", agent.DescribeAllowances(after.CapabilityPolicy))
		if after.CapabilityPolicy.FullVectorConfig {
			fmt.Fprintln(c.stdout, "It runs in full mode, which doesn't need allowances; they apply if it returns to restricted mode.")
		} else if changed {
			fmt.Fprintln(c.stdout, "Start the agent again; a version this host refused is tried again.")
		}
		return exitOK
	}
}

// allowanceLists is a policy for --json with only the lists that hold entries:
// an empty list is absent, not null.
func allowanceLists(p agent.CapabilityPolicy) map[string]any {
	out := map[string]any{}
	if len(p.AllowedFileRoots) > 0 {
		out["allowed_file_roots"] = p.AllowedFileRoots
	}
	if len(p.AllowedNetworkHosts) > 0 {
		out["allowed_network_hosts"] = p.AllowedNetworkHosts
	}
	if len(p.AllowedListenAddresses) > 0 {
		out["allowed_listen_addresses"] = p.AllowedListenAddresses
	}
	if p.FullVectorConfig {
		out["full_vector_config"] = true
	}
	return out
}

// newEntries lists what after has that before hadn't, in order.
func newEntries(before, after []string) []string {
	var out []string
	for _, value := range after {
		if !slices.Contains(before, value) {
			out = append(out, value)
		}
	}
	return out
}

func defineConfigureMetrics(c *cli) func() int {
	c.StateDir()
	metrics := c.String("metrics-url", "", "URL", "Local Vector metrics endpoint, such as http://127.0.0.1:9598/metrics")
	clearMetrics := c.Bool("clear-metrics-url", "Remove the local metrics endpoint setting")
	c.JSON("Print one JSON document")
	return func() int {
		if err := metricsOptionUsage(c.fs, *clearMetrics, true); err != nil {
			fmt.Fprintln(c.stderr, "vectory:", err)
			return exitUsage
		}
		var err error
		if *clearMetrics {
			err = agent.ClearMetrics(*c.state)
		} else {
			err = agent.ConfigureMetrics(*c.state, *metrics)
		}
		if err != nil {
			return c.fail(err)
		}
		reportMetricsConfiguration(c, "configure-metrics", *clearMetrics)
		return exitOK
	}
}

func defineConfigureSecrets(c *cli) func() int {
	c.StateDir()
	secretFiles := c.String("secret-files", "", "PATH", "JSON map of approved names to private absolute files; {} removes all bindings")
	c.JSON("Print one JSON document")
	return func() int {
		if *secretFiles == "" {
			fmt.Fprintln(c.stderr, "vectory: configure-secrets requires --secret-files with a nonempty absolute JSON file path; use {} to remove all bindings")
			return exitUsage
		}
		bindings, err := agent.ReadSecretBindings(*secretFiles)
		if err == nil {
			err = agent.ConfigureSecretFiles(*c.state, *bindings)
		}
		if err != nil {
			return c.fail(err)
		}
		if *c.json {
			c.output(map[string]string{"status": "ok", "command": "configure-secrets"})
		} else {
			switch len(*bindings) {
			case 0:
				fmt.Fprintln(c.stdout, "Removed all secret-file bindings. Start the agent to apply this; Vector uses it with the next verified configuration.")
			case 1:
				fmt.Fprintln(c.stdout, "Saved 1 secret-file binding. Start the agent to use it; Vector applies it with the next verified configuration.")
			default:
				fmt.Fprintf(c.stdout, "Saved %d secret-file bindings. Start the agent to use them; Vector applies them with the next verified configuration.\n", len(*bindings))
			}
		}
		return exitOK
	}
}

func defineReAdopt(c *cli) func() int {
	c.StateDir()
	binary := c.String("vector-binary", "", "PATH", "Replacement Vector binary (default: the adopted path)")
	expected := c.String("expected-sha256", "", "SHA256", "SHA-256 of the replacement, approved independently")
	c.JSON("Print one JSON document")
	return func() int {
		if *binary != "" {
			resolved, err := agent.ResolveExecutablePath(*binary)
			if err != nil {
				return c.fail(err)
			}
			*binary = resolved.Path
		}
		ctx, stop := interruptible()
		defer stop()
		result, err := agent.ReAdopt(ctx, *c.state, *binary, *expected)
		if err != nil {
			return c.fail(err)
		}
		if *c.json {
			c.output(result)
		} else {
			fmt.Fprintf(c.stdout, "Approved Vector %s at %s\nSHA256: %s\n%s\n", result.VectorVersion, result.VectorBinary, result.SHA256, result.NextAction)
		}
		return exitOK
	}
}

func defineUnenroll(c *cli) func() int {
	c.StateDir()
	c.JSON("Print one JSON document")
	return func() int {
		_, _, identityErr := agent.ReadIdentity(*c.state)
		hadCredentials := identityErr == nil
		pending, _ := agent.ReadPendingEnrollment(*c.state)
		if err := agent.Unenroll(*c.state); err != nil {
			return c.fail(err)
		}
		if *c.json {
			c.output(map[string]any{"status": "ok", "command": "unenroll", "credentials_removed": hadCredentials})
			return exitOK
		}
		switch {
		case hadCredentials:
			fmt.Fprintln(c.stdout, "Local credentials removed. Also revoke this device in the dashboard: the server can't be told from here.")
		case pending != nil:
			fmt.Fprintln(c.stdout, "This host has no credentials: it never finished enrolling. The unfinished enrollment is cleared.")
		default:
			fmt.Fprintln(c.stdout, "This host has no credentials: it isn't enrolled, so there was nothing to remove.")
		}
		return exitOK
	}
}

func defineUninstall(c *cli) func() int {
	c.StateDir()
	purge := c.Bool("purge", "Delete this exact state directory (stop and remove the service first)")
	c.JSON("Print one JSON document")
	return func() int {
		dir := *c.state
		if *purge && !c.supplied("state-dir") {
			fmt.Fprintln(c.stderr, "vectory: uninstall --purge requires an explicit --state-dir")
			return exitUsage
		}
		// A purge that was interrupted is run again, and finds nothing left.
		if _, err := os.Lstat(dir); os.IsNotExist(err) {
			if *c.json {
				c.output(map[string]any{"status": "ok", "command": "uninstall", "removed": false})
			} else {
				fmt.Fprintf(c.stdout, "Nothing to remove: %s doesn't exist.\n", dir)
			}
			return exitOK
		}
		if *purge {
			if err := agent.PurgeState(dir); err != nil {
				return c.fail(err)
			}
			if *c.json {
				c.output(map[string]any{"status": "ok", "command": "uninstall", "removed": true})
			} else {
				fmt.Fprintf(c.stdout, "Deleted %s. Vector and the managed configuration were left in place.\n", dir)
			}
			return exitOK
		}
		unlock, err := agent.Lock(dir)
		if err != nil {
			return c.fail(err)
		}
		unlock()
		if *c.json {
			c.output(map[string]any{"status": "ok", "command": "uninstall", "removed": false})
		} else {
			fmt.Fprintf(c.stdout, "Nothing was deleted. State and identity stay in %s for a reinstall.\nTo remove the agent: sudo vectory service-uninstall, remove the binary, then vectory uninstall --purge --state-dir %s\n", dir, agent.ShellQuote(filepath.Clean(dir)))
		}
		return exitOK
	}
}

func metricsOptionUsage(fs *flag.FlagSet, clear, required bool) error {
	urlSupplied, clearSupplied := false, false
	fs.Visit(func(f *flag.Flag) {
		urlSupplied = urlSupplied || f.Name == "metrics-url"
		clearSupplied = clearSupplied || f.Name == "clear-metrics-url"
	})
	if clearSupplied && (!clear || urlSupplied) || required && !urlSupplied && !clearSupplied {
		return errors.New("choose exactly one of --metrics-url URL or --clear-metrics-url; omit --clear-metrics-url instead of setting it false")
	}
	return nil
}

func reportMetricsConfiguration(c *cli, command string, cleared bool) {
	next := "Start or restart the agent through its intended supervisor to use this setting. The pipeline and exporter are unchanged."
	if c.json != nil && *c.json {
		c.output(map[string]any{"command": command, "status": "ok", "metrics_collection_configured": !cleared, "next_action": next})
		return
	}
	if cleared {
		fmt.Fprintln(c.stdout, "Metrics collection setting cleared.", next)
	} else {
		fmt.Fprintln(c.stdout, "Metrics endpoint setting saved.", next)
	}
}
