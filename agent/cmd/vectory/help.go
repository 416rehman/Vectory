package main

import (
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/vectory/vectory/agent/internal/agent"
)

// command describes one CLI command for dispatch and help.
type command struct {
	name     string
	group    string
	summary  string
	usage    string
	about    string
	examples []string
	hidden   bool
	// define declares the command's flags and returns its action, which runs
	// after the flags parsed successfully.
	define func(c *cli) func() int
}

var groups = []string{"Get started", "Run the agent", "Step by step", "Day to day", "Remove or recover"}

type flagSpec struct {
	name, arg, help string
	hidden          bool
}

// cli is one invocation: its flags, output streams and shared options.
type cli struct {
	cmd    *command
	fs     *flag.FlagSet
	specs  []flagSpec
	stdout io.Writer
	stderr io.Writer
	state  *string
	json   *bool
}

func (c *cli) record(name, arg, help string, hidden bool) {
	c.specs = append(c.specs, flagSpec{name: name, arg: arg, help: help, hidden: hidden})
}
func (c *cli) String(name, value, arg, help string) *string {
	c.record(name, arg, help, false)
	return c.fs.String(name, value, help)
}
func (c *cli) Bool(name, help string) *bool {
	c.record(name, "", help, false)
	return c.fs.Bool(name, false, help)
}
func (c *cli) Int(name string, value int, arg, help string) *int {
	c.record(name, arg, help, false)
	return c.fs.Int(name, value, help)
}

// stringList is a flag that may be given several times.
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

// Strings declares a repeatable flag.
func (c *cli) Strings(name, arg, help string) *[]string {
	values := &stringList{}
	c.record(name, arg, help, false)
	c.fs.Var(values, name, help)
	return (*[]string)(values)
}
func (c *cli) HiddenString(name, help string) *string {
	c.record(name, "", help, true)
	return c.fs.String(name, "", help)
}
func (c *cli) HiddenBool(name, help string) *bool {
	c.record(name, "", help, true)
	return c.fs.Bool(name, false, help)
}

// StateDir declares the common --state-dir flag with the platform default.
func (c *cli) StateDir() *string {
	c.state = c.String("state-dir", agent.DefaultPaths().StateDir, "PATH", "Agent state directory")
	return c.state
}

// JSON declares the common --json flag.
func (c *cli) JSON(help string) *bool {
	c.json = c.Bool("json", help)
	return c.json
}

func (c *cli) supplied(name string) bool { return flagSupplied(c.fs, name) }

// wrap reflows text to lines of at most width characters.
func wrap(text string, width int) string {
	var lines []string
	line := ""
	for _, word := range strings.Fields(text) {
		if line != "" && len(line)+1+len(word) > width {
			lines = append(lines, line)
			line = ""
		}
		if line != "" {
			line += " "
		}
		line += word
	}
	if line != "" {
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func printCommandHelp(w io.Writer, cmd *command, specs []flagSpec, defaults map[string]string) {
	summary := strings.ToLower(cmd.summary[:1]) + cmd.summary[1:]
	fmt.Fprintf(w, "vectory %s: %s\n\nUsage:\n  vectory %s\n", cmd.name, summary, cmd.usage)
	if cmd.about != "" {
		fmt.Fprintf(w, "\n%s\n", wrap(cmd.about, 78))
	}
	var rows [][2]string
	width := 0
	for _, spec := range specs {
		if spec.hidden {
			continue
		}
		left := "--" + spec.name
		if spec.arg != "" {
			left += " " + spec.arg
		}
		help := spec.help
		if value := defaults[spec.name]; value != "" && value != "false" && !strings.Contains(help, "default") {
			help += " (default " + value + ")"
		}
		rows = append(rows, [2]string{left, help})
		width = max(width, len(left))
	}
	if len(rows) > 0 {
		fmt.Fprintln(w, "\nFlags:")
		for _, row := range rows {
			fmt.Fprintf(w, "  %-*s  %s\n", width, row[0], row[1])
		}
	}
	if len(cmd.examples) > 0 {
		fmt.Fprintln(w, "\nExamples:")
		for _, example := range cmd.examples {
			fmt.Fprintf(w, "  %s\n", example)
		}
	}
}

func printGeneralHelp(w io.Writer) {
	fmt.Fprintf(w, "Vectory agent %s keeps one Vector %s process in sync with your Vectory server.\n\n", agent.Version, agent.VectorSeries)
	fmt.Fprintln(w, "Usage:  vectory <command> [flags]")
	for _, group := range groups {
		fmt.Fprintf(w, "\n%s\n", group)
		for _, cmd := range commands {
			if cmd.group == group && !cmd.hidden {
				fmt.Fprintf(w, "  %-19s %s\n", cmd.name, cmd.summary)
			}
		}
	}
	fmt.Fprintln(w, "\nOther\n  help [command]      Show help for a command\n  version             Print the agent version")
	fmt.Fprintln(w, "\nExamples (Add device writes these for your server; never use curl -k, which turns certificate checks off)")
	fmt.Fprintln(w, "  curl -fsSL --cacert vectory-ca.pem -o vectory-install.sh https://vectory.example.com:8443/agent/v1/install.sh")
	fmt.Fprintln(w, "  echo '<SHA-256 from Add device>  vectory-install.sh' | sha256sum -c -")
	fmt.Fprintln(w, "  sudo sh vectory-install.sh")
	fmt.Fprintln(w, "  sudo vectory setup --server https://vectory.example.com:8443 --ca-sha256 <64-hex-fingerprint>")
	fmt.Fprintln(w, "  sudo vectory status")
	fmt.Fprintln(w, "\nRun 'vectory help <command>' for details. Exit codes: 0 ok, 1 failed, 2 usage error, 130 setup interrupted.")
}

func findCommand(name string) *command {
	for i := range commands {
		if commands[i].name == name {
			return &commands[i]
		}
	}
	return nil
}

// suggest returns the closest visible command name, or "".
func suggest(name string) string {
	best, bestDistance := "", 3
	for _, cmd := range commands {
		if cmd.hidden {
			continue
		}
		if strings.HasPrefix(cmd.name, name) && len(name) >= 3 {
			return cmd.name
		}
		if d := editDistance(name, cmd.name); d < bestDistance {
			best, bestDistance = cmd.name, d
		}
	}
	return best
}

func editDistance(a, b string) int {
	previous := make([]int, len(b)+1)
	for j := range previous {
		previous[j] = j
	}
	for i := 1; i <= len(a); i++ {
		current := make([]int, len(b)+1)
		current[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			current[j] = min(previous[j]+1, current[j-1]+1, previous[j-1]+cost)
		}
		previous = current
	}
	return previous[len(b)]
}
