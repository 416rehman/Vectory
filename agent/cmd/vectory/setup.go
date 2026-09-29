package main

import (
	"errors"
	"fmt"
	"io"
	"os"
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
resumes where it stopped. Restricted mode is the default; full mode only
when you pass --mode full.`,
	examples: []string{
		"curl -fsSL https://vectory.example.com:8443/agent/v1/install.sh | sudo sh -s -- --create-user",
		"sudo vectory setup --server https://vectory.example.com:8443 --ca-sha256 1F3C...9AB0 --create-user",
		"sudo vectory setup --server https://vectory.example.com:8443 --token-file /run/secrets/vectory-token --service none",
		"sudo vectory setup --server https://vectory.example.com:8443 --dry-run",
	},
	define: defineSetup,
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
	tokenFile := c.String("token-file", "", "PATH", "Read the enrollment token from a private file")
	tokenStdin := c.Bool("token-stdin", "Read the enrollment token from standard input")
	dashboard := c.HiddenString("dashboard-url", "dashboard address for the device link (set by the installer)")
	dryRun := c.Bool("dry-run", "Check everything and show the plan without changing anything")
	c.JSON("Print one JSON document instead of progress lines")
	return func() int {
		if *pin != "" && c.supplied("ca-file") {
			fmt.Fprintln(c.stderr, "vectory setup: choose one of --ca-sha256 or --ca-file")
			return exitUsage
		}
		if *tokenStdin && *tokenFile != "" {
			fmt.Fprintln(c.stderr, "vectory setup: choose one of --token-file or --token-stdin")
			return exitUsage
		}
		options := agent.SetupOptions{
			Server: *server, CASHA256: *pin, Name: *name, Mode: *mode, Service: *service,
			CreateUser: *createUser, KeepExistingVector: *keep, DashboardURL: *dashboard, DryRun: *dryRun,
		}
		if c.supplied("state-dir") {
			options.StateDir = *c.state
		}
		if c.supplied("service-user") {
			options.ServiceUser = *account
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
		if human {
			fmt.Fprintf(c.stdout, "Vectory agent setup %s%s\n", agent.Version, map[bool]string{true: " (dry run: nothing will change)"}[*dryRun])
			options.Progress = func(step agent.SetupStep) { printStep(c.stdout, step, color) }
		}
		options.Token = func() (string, error) {
			switch {
			case *tokenStdin:
				return readToken(os.Stdin)
			case *tokenFile != "":
				path, ok := c.resolvePath("token-file", *tokenFile)
				if !ok {
					return "", errors.New("invalid --token-file")
				}
				f, err := agent.OpenEnrollmentTokenFile(path)
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
			if err != nil {
				return exitFailed
			}
			return exitOK
		}
		if err != nil {
			return exitFailed
		}
		if result.DeviceURL != "" {
			fmt.Fprintf(c.stdout, "Connected: %s\n", result.DeviceURL)
		} else if result.Device != nil && !result.DryRun {
			fmt.Fprintf(c.stdout, "Connected: %s is in Devices in the dashboard.\n", result.Device.Name)
		}
		if result.Next != "" {
			fmt.Fprintf(c.stdout, "Next: %s\n", result.Next)
		}
		return exitOK
	}
}

var stepMarks = map[string]string{"ok": "[ok]", "info": "[i] ", "warn": "[!!]", "fail": "[!!]", "plan": "[..]"}
var stepColors = map[string]string{"ok": "\x1b[32m", "info": "\x1b[36m", "warn": "\x1b[33m", "fail": "\x1b[31m", "plan": "\x1b[36m"}

func printStep(w io.Writer, step agent.SetupStep, color bool) {
	mark := stepMarks[step.Status]
	if color {
		mark = stepColors[step.Status] + mark + "\x1b[0m"
	}
	fmt.Fprintf(w, "%s %-12s %s\n", mark, step.Label, step.Detail)
	if step.Fix != "" {
		fix := "     " + strings.Repeat(" ", 13) + step.Fix
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
