package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strings"

	"github.com/vectory/vectory/agent/internal/agent"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "__vector-host" {
		os.Exit(agent.VectorHostMain(os.Args[2:]))
	}
	os.Exit(run(os.Args[1:]))
}

// Exit codes: 0 success, 1 the operation or a preflight check failed, 2 the
// command line was invalid, 78 the agent isn't installed or enrolled (so a
// service manager doesn't restart-loop it).
const (
	exitOK       = 0
	exitFailed   = 1
	exitUsage    = 2
	exitNotReady = 78
)

func run(args []string) int { return runWith(args, os.Stdout, os.Stderr) }

func runWith(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printGeneralHelp(stderr)
		return exitUsage
	}
	switch args[0] {
	case "help", "-h", "-help", "--help":
		if args[0] == "help" && len(args) > 1 {
			cmd := findCommand(args[1])
			if cmd == nil || cmd.hidden {
				return unknownCommand(stderr, args[1])
			}
			c := newCLI(cmd, stdout, stderr)
			cmd.define(c)
			printCommandHelp(stdout, cmd, c.specs, flagDefaults(c.fs))
			return exitOK
		}
		printGeneralHelp(stdout)
		return exitOK
	case "version", "-v", "-version", "--version":
		if len(args) > 1 && (args[1] == "--json" || args[1] == "-json") {
			writeJSON(stdout, map[string]string{"version": agent.Version, "vector_version": agent.VectorVersion, "go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH})
		} else {
			fmt.Fprintf(stdout, "vectory %s (for Vector %s, %s, %s/%s)\n", agent.Version, agent.VectorSeries, runtime.Version(), runtime.GOOS, runtime.GOARCH)
		}
		return exitOK
	}
	name, rest := args[0], args[1:]
	if strings.HasPrefix(name, "-") {
		// Compatibility form: vectory -ip <server> -id <name> -token <token>.
		name, rest = "enroll", args
	}
	cmd := findCommand(name)
	if cmd == nil {
		return unknownCommand(stderr, name)
	}
	return execute(cmd, rest, stdout, stderr)
}

func unknownCommand(stderr io.Writer, name string) int {
	message := fmt.Sprintf("vectory: unknown command %q.", name)
	if suggestion := suggest(name); suggestion != "" {
		message += fmt.Sprintf(" Did you mean %q?", suggestion)
	}
	fmt.Fprintln(stderr, message)
	fmt.Fprintln(stderr, "Run 'vectory help' for the list of commands.")
	return exitUsage
}

func newCLI(cmd *command, stdout, stderr io.Writer) *cli {
	fs := flag.NewFlagSet(cmd.name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return &cli{cmd: cmd, fs: fs, stdout: stdout, stderr: stderr}
}

func flagDefaults(fs *flag.FlagSet) map[string]string {
	defaults := map[string]string{}
	fs.VisitAll(func(f *flag.Flag) { defaults[f.Name] = f.DefValue })
	return defaults
}

func execute(cmd *command, args []string, stdout, stderr io.Writer) int {
	c := newCLI(cmd, stdout, stderr)
	action := cmd.define(c)
	if err := c.fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			printCommandHelp(stdout, cmd, c.specs, flagDefaults(c.fs))
			return exitOK
		}
		fmt.Fprintf(stderr, "vectory %s: %s\nRun 'vectory help %s' for usage.\n", cmd.name, flagError(err), cmd.name)
		return exitUsage
	}
	if c.fs.NArg() != 0 {
		fmt.Fprintf(stderr, "vectory: %s accepts flags only; unexpected positional arguments\n", cmd.name)
		return exitUsage
	}
	if c.state != nil {
		resolved, ok := c.resolvePath("state-dir", *c.state)
		if !ok {
			return exitUsage
		}
		*c.state = resolved
	}
	return action()
}

// resolvePath makes a path flag absolute and canonical, noting any symbolic
// link it followed. It reports false after printing a usage error.
func (c *cli) resolvePath(flagName, value string) (string, bool) {
	resolved, err := agent.ResolveOperatorPath(value)
	if err != nil {
		fmt.Fprintf(c.stderr, "vectory %s: --%s %s: %s\n", c.cmd.name, flagName, value, err)
		return "", false
	}
	if resolved.Resolved {
		fmt.Fprintf(c.stderr, "Using %s for --%s (%s is a symbolic link).\n", resolved.Path, flagName, value)
	}
	return resolved.Path, true
}

func flagError(err error) string {
	message := err.Error()
	switch {
	case strings.HasPrefix(message, "flag provided but not defined: "):
		return "unknown flag -" + strings.TrimPrefix(message, "flag provided but not defined: ")
	case strings.HasPrefix(message, "flag needs an argument: "):
		return "-" + strings.TrimPrefix(message, "flag needs an argument: ") + " needs a value"
	}
	return message
}

// Kept for tests and command implementations: parse helpers that report
// trailing operands the same way for every command.
func parseFlagsOnly(fs *flag.FlagSet, args []string, command string) bool {
	if fs.Parse(args) != nil {
		return false
	}
	if fs.NArg() != 0 {
		fmt.Fprintf(os.Stderr, "vectory: %s accepts flags only; unexpected positional arguments\n", command)
		return false
	}
	return true
}

func flagSupplied(fs *flag.FlagSet, name string) bool {
	found := false
	fs.Visit(func(option *flag.Flag) { found = found || option.Name == name })
	return found
}

func readToken(r io.Reader) (string, error) {
	line, err := bufio.NewReader(io.LimitReader(r, 4097)).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	if len(line) > 4096 {
		return "", errors.New("token exceeds input limit")
	}
	return strings.TrimSpace(line), nil
}

func writeJSON(w io.Writer, v any) {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func (c *cli) output(v any) { writeJSON(c.stdout, v) }

// fail prints err for people (stderr) or scripts (a JSON document on stdout).
func (c *cli) fail(err error) int {
	if c.json != nil && *c.json {
		document := map[string]any{"error": err.Error()}
		if ce, ok := agent.AsConnectionError(err); ok {
			document["code"], document["message"], document["fix"] = ce.Code, ce.Message, ce.Fix
		}
		c.output(document)
	} else {
		fmt.Fprintln(c.stderr, "vectory:", err.Error())
	}
	return exitFailed
}

func interruptible() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), terminationSignals()...)
}
