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
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/vectory/vectory/agent/internal/agent"
	"golang.org/x/term"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "__vector-host" {
		os.Exit(agent.VectorHostMain(os.Args[2:]))
	}
	os.Exit(run(os.Args[1:]))
}

// Exit codes: 0 success, 1 the operation or a preflight check failed, 2 the
// command line was invalid, 3 setup finished but nothing keeps the agent
// running (no service manager, and --service none wasn't passed), 78 the
// agent isn't installed or enrolled (so a service manager doesn't
// restart-loop it), 130 setup was interrupted.
const (
	exitOK          = 0
	exitFailed      = 1
	exitUsage       = 2
	exitAttention   = 3
	exitNotReady    = 78
	exitInterrupted = 130
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
			switch args[1] {
			case "help":
				fmt.Fprint(stdout, "Usage:  vectory help [command]\n\nShow the list of commands, or the flags and examples of one command.\n")
				return exitOK
			case "version":
				fmt.Fprint(stdout, versionUsage)
				return exitOK
			}
			cmd := findCommand(args[1])
			if cmd == nil || cmd.hidden {
				return unknownCommand(stderr, args[1])
			}
			if len(cmd.verbs) > 0 {
				return helpForGroup(cmd, args[2:], stdout, stderr)
			}
			c := newCLI(cmd, stdout, stderr)
			cmd.define(c)
			printCommandHelp(stdout, cmd, c.specs, flagDefaults(c.fs))
			return exitOK
		}
		printGeneralHelp(stdout)
		return exitOK
	case "version", "-v", "-version", "--version":
		return versionCommand(args[1:], stdout, stderr)
	}
	name, rest := args[0], args[1:]
	if strings.HasPrefix(name, "-") {
		if corrected := misplacedCommand(args); corrected != "" {
			fmt.Fprintf(stderr, "vectory: put the command first: %s\n", corrected)
			return exitUsage
		}
		// Compatibility form: vectory -ip <server> -id <name> -token <token>.
		name, rest = "enroll", args
	}
	cmd := findCommand(name)
	if cmd == nil {
		return unknownCommand(stderr, name)
	}
	if len(cmd.verbs) > 0 {
		return executeGroup(cmd, rest, stdout, stderr)
	}
	return execute(cmd, rest, stdout, stderr)
}

// executeGroup runs `vectory <group> <verb> [flags]`. A group with no verb
// prints its verbs and exits 2, as vectory with no command does; the help flags
// print them and exit 0.
func executeGroup(group *command, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printCommandHelp(stderr, group, nil, nil)
		return exitUsage
	}
	switch args[0] {
	case "-h", "-help", "--help":
		printCommandHelp(stdout, group, nil, nil)
		return exitOK
	case "help":
		return helpForGroup(group, args[1:], stdout, stderr)
	}
	if strings.HasPrefix(args[0], "-") {
		fmt.Fprintf(stderr, "vectory %s: put the verb first, as in vectory %s <verb> [flags].\nRun 'vectory help %s' for the list of verbs.\n", group.name, group.name, group.name)
		return exitUsage
	}
	verb := group.verb(args[0])
	if verb == nil {
		return unknownVerb(stderr, group, args[0])
	}
	return execute(verb, args[1:], stdout, stderr)
}

// helpForGroup answers `vectory help <group> [verb]`.
func helpForGroup(group *command, rest []string, stdout, stderr io.Writer) int {
	if len(rest) == 0 {
		printCommandHelp(stdout, group, nil, nil)
		return exitOK
	}
	verb := group.verb(rest[0])
	if verb == nil || verb.hidden {
		return unknownVerb(stderr, group, rest[0])
	}
	printVerbHelp(stdout, verb)
	return exitOK
}

func unknownVerb(stderr io.Writer, group *command, name string) int {
	message := fmt.Sprintf("vectory %s: unknown verb %q.", group.name, name)
	if suggestion := suggestAmong(group.verbs, name); suggestion != "" {
		message += fmt.Sprintf(" Did you mean %q?", suggestion)
	}
	fmt.Fprintln(stderr, message)
	fmt.Fprintf(stderr, "Run 'vectory help %s' for the list of verbs.\n", group.name)
	return exitUsage
}

const versionUsage = "Usage:  vectory version [--json]\n\nPrint the agent version, the Vector releases it supports, and the Go\nversion and platform it was built for. --json prints one JSON document.\n"

// versionCommand prints the version. Like every command it takes flags and no
// other arguments; --state-dir is accepted and has no effect.
func versionCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	asJSON := fs.Bool("json", false, "")
	fs.String("state-dir", "", "")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(stdout, versionUsage)
			return exitOK
		}
		fmt.Fprintf(stderr, "vectory version: %s\nRun 'vectory help version' for usage.\n", flagError(err))
		return exitUsage
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(stderr, "vectory: version accepts flags only; unexpected positional arguments")
		return exitUsage
	}
	if *asJSON {
		writeJSON(stdout, map[string]string{"version": agent.Version, "vector_version": agent.VectorVersion, "go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH})
	} else {
		fmt.Fprintf(stdout, "vectory %s (for Vector %s, %s, %s/%s)\n", agent.Version, agent.VectorSeries, runtime.Version(), runtime.GOOS, runtime.GOARCH)
	}
	return exitOK
}

// misplacedCommand answers `vectory --json status`: flags came before the
// command, so the compatibility form would take them for an enrollment. It
// returns the command line with the command first, or "" when the arguments
// are not that mistake.
func misplacedCommand(args []string) string {
	enroll := findCommand("enroll")
	probe := newCLI(enroll, io.Discard, io.Discard)
	enroll.define(probe)
	if probe.fs.Parse(args) != nil || probe.fs.NArg() == 0 {
		return ""
	}
	command := findCommand(probe.fs.Arg(0))
	if command == nil || command.hidden {
		return ""
	}
	words := []string{"vectory", command.name}
	after := probe.fs.Args()[1:]
	// A group's verb belongs next to the group's name, ahead of the flags.
	if len(command.verbs) > 0 && len(after) > 0 {
		if verb := command.verb(after[0]); verb != nil {
			words = append(words, verb.name)
			after = after[1:]
		}
	}
	for _, word := range append(append([]string{}, args[:len(args)-probe.fs.NArg()]...), after...) {
		words = append(words, agent.ShellQuote(word))
	}
	return strings.Join(words, " ")
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
	fs := flag.NewFlagSet(cmd.words(), flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return &cli{cmd: cmd, fs: fs, stdout: stdout, stderr: stderr, ask: askOnTerminal}
}

func flagDefaults(fs *flag.FlagSet) map[string]string {
	defaults := map[string]string{}
	fs.VisitAll(func(f *flag.Flag) { defaults[f.Name] = f.DefValue })
	return defaults
}

func execute(cmd *command, args []string, stdout, stderr io.Writer) int {
	return executeWith(newCLI(cmd, stdout, stderr), cmd, args)
}

// executeWith runs a command with the cli it was given, so a test can replace
// the terminal a command asks on.
func executeWith(c *cli, cmd *command, args []string) int {
	stdout, stderr := c.stdout, c.stderr
	action := cmd.define(c)
	if err := c.fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			printCommandHelp(stdout, cmd, c.specs, flagDefaults(c.fs))
			return exitOK
		}
		fmt.Fprintf(stderr, "vectory %s: %s\nRun 'vectory help %s' for usage.\n", cmd.words(), flagError(err), cmd.words())
		return exitUsage
	}
	if code, ok := c.takeOperands(); !ok {
		return code
	}
	if c.state != nil {
		if flagSupplied(c.fs, "state-dir") {
			switch {
			case strings.TrimSpace(*c.state) == "":
				fmt.Fprintf(stderr, "vectory %s: --state-dir needs a path. Give the agent's state directory in full, or leave the flag out to use %s.\n", cmd.words(), agent.DefaultPaths().StateDir)
				return exitUsage
			case !filepath.IsAbs(*c.state):
				fmt.Fprintf(stderr, "vectory %s: --state-dir must be an absolute path, and %s isn't. Write the whole path, such as %s.\n", cmd.words(), agent.ShellQuote(*c.state), agent.DefaultPaths().StateDir)
				return exitUsage
			}
		}
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
		fmt.Fprintf(c.stderr, "vectory %s: --%s %s: %s\n", c.cmd.words(), flagName, value, err)
		return "", false
	}
	if resolved.Resolved {
		fmt.Fprintf(c.stderr, "Using %s for --%s (%s is a symbolic link).\n", resolved.Path, flagName, value)
	}
	return resolved.Path, true
}

// resolveFilePath makes the path of a file this command reads as private or
// creates: absolute, with the links in its directory resolved and its own name
// kept, so a link in the file's place is never followed.
func (c *cli) resolveFilePath(flagName, value string) (string, bool) {
	if strings.TrimSpace(value) == "" {
		fmt.Fprintf(c.stderr, "vectory %s: --%s needs a file name.\n", c.cmd.words(), flagName)
		return "", false
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		fmt.Fprintf(c.stderr, "vectory %s: --%s %s: %s\n", c.cmd.words(), flagName, value, err)
		return "", false
	}
	directory, ok := c.resolvePath(flagName, filepath.Dir(absolute))
	if !ok {
		return "", false
	}
	return filepath.Join(directory, filepath.Base(absolute)), true
}

// takeOperands checks the arguments after the flags against the operands the
// command declares: a command with none takes flags only. It reports false,
// with the exit code, after printing a usage error.
func (c *cli) takeOperands() (int, bool) {
	args := c.fs.Args()
	want := c.cmd.operands
	if len(want) == 0 {
		if len(args) != 0 {
			fmt.Fprintf(c.stderr, "vectory: %s accepts flags only; unexpected positional arguments\n", c.cmd.words())
			return exitUsage, false
		}
		return exitOK, true
	}
	switch {
	case len(args) < len(want):
		fmt.Fprintf(c.stderr, "vectory %s: missing %s.\nRun 'vectory help %s' for usage.\n", c.cmd.words(), want[len(args)], c.cmd.words())
		return exitUsage, false
	case len(args) > len(want) && strings.HasPrefix(args[len(want)], "-") && args[len(want)] != "-":
		fmt.Fprintf(c.stderr, "vectory %s: put the flags before %s: %q came after it.\nRun 'vectory help %s' for usage.\n", c.cmd.words(), want[len(want)-1], args[len(want)], c.cmd.words())
		return exitUsage, false
	case len(args) > len(want):
		fmt.Fprintf(c.stderr, "vectory %s: unexpected argument %q.\nRun 'vectory help %s' for usage.\n", c.cmd.words(), args[len(want)], c.cmd.words())
		return exitUsage, false
	}
	c.operands = args
	return exitOK, true
}

// askOnTerminal asks a question on standard error and reads the answer from
// standard input, when both are terminals. Without a terminal nobody can be
// asked, and a command that needs a yes has to be told with a flag.
func askOnTerminal(question string) (string, bool) {
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stderr.Fd())) {
		return "", false
	}
	fmt.Fprint(os.Stderr, question)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.TrimSpace(line), true
}

// wholeNumbers says what a flag that takes a count accepts.
var wholeNumbers = map[string]string{
	"lines":                     "from 1 to 100000",
	"graceful-shutdown-seconds": "of seconds from 5 to 300",
}

// invalidNumber is the flag package's refusal of a value that isn't a number:
// invalid value "abc" for flag -lines: parse error.
var invalidNumber = regexp.MustCompile(`^invalid value (".*") for flag -([a-z-]+): parse error$`)

func flagError(err error) string {
	message := err.Error()
	switch {
	case strings.HasPrefix(message, "flag provided but not defined: "):
		return "unknown flag -" + strings.TrimPrefix(message, "flag provided but not defined: ")
	case strings.HasPrefix(message, "flag needs an argument: "):
		return "-" + strings.TrimPrefix(message, "flag needs an argument: ") + " needs a value"
	}
	if match := invalidNumber.FindStringSubmatch(message); match != nil {
		return "--" + match[2] + " needs a whole number " + strings.TrimSpace(wholeNumbers[match[2]]) + ", and " + match[1] + " isn't one"
	}
	return message
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

func (c *cli) output(v any) {
	if c.oneLine {
		_ = json.NewEncoder(c.stdout).Encode(v)
		return
	}
	writeJSON(c.stdout, v)
}

// fail prints err for people (stderr) or scripts (a JSON document on stdout).
func (c *cli) fail(err error) int {
	var full *agent.DiskFullError
	isFull := errors.As(err, &full)
	if c.json != nil && *c.json {
		document := map[string]any{"error": err.Error()}
		if ce, ok := agent.AsConnectionError(err); ok {
			document["code"], document["message"], document["fix"] = ce.Code, ce.Message, ce.Fix
		}
		if isFull {
			document["code"], document["fix"] = "DISK_FULL", full.Fix("run the command again")
		}
		c.output(document)
	} else {
		message := err.Error()
		if isFull {
			message += ". " + full.Fix("run the command again")
		}
		fmt.Fprintln(c.stderr, "vectory:", agent.IndentLines(message, len("vectory: ")))
	}
	// A value that can't work on any host is a usage error, like an unknown flag.
	if agent.IsInputError(err) {
		return exitUsage
	}
	return exitFailed
}

func interruptible() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), terminationSignals()...)
}
