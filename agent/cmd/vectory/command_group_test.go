package main

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

// withDemoGroup registers a group of verbs for one test: `vectory demo alpha`,
// `beta` (one file operand) and a hidden `gamma`. The shipped groups are tested
// through their own verbs; this one pins the plumbing.
func withDemoGroup(t *testing.T) {
	t.Helper()
	saved := commands
	t.Cleanup(func() { commands = saved })
	commands = append(append([]command(nil), commands...), command{
		name: "demo", group: "Day to day", summary: "Try the verbs of a group", usage: "demo <verb> [flags]",
		about: "Runs one verb.",
		verbs: []command{
			{name: "alpha", summary: "Say a name", usage: "demo alpha [--name NAME]", about: "Prints the name.",
				examples: []string{"vectory demo alpha --name x"},
				define: func(c *cli) func() int {
					name := c.String("name", "world", "NAME", "Who to greet")
					return func() int { fmt.Fprintf(c.stdout, "alpha %s\n", *name); return exitOK }
				}},
			{name: "beta", summary: "Take a file", usage: "demo beta [--flag] FILE", operands: []string{"FILE"},
				define: func(c *cli) func() int {
					flag := c.Bool("flag", "A switch")
					return func() int { fmt.Fprintf(c.stdout, "beta %s %v\n", c.operands[0], *flag); return exitOK }
				}},
			{name: "gamma", summary: "Not listed", usage: "demo gamma", hidden: true,
				define: func(c *cli) func() int { return func() int { fmt.Fprintln(c.stdout, "gamma"); return exitOK } }},
		},
	})
	linkVerbs(commands)
}

func TestAGroupWithoutAVerbListsItsVerbsAndExitsTwo(t *testing.T) {
	withDemoGroup(t)
	code, stdout, stderr := invoke("demo")
	if code != 2 || stdout != "" || !strings.Contains(stderr, "Usage:\n  vectory demo <verb> [flags]") || !strings.Contains(stderr, "alpha  Say a name") || !strings.Contains(stderr, "beta   Take a file") {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	if strings.Contains(stderr, "gamma") {
		t.Errorf("a hidden verb is listed:\n%s", stderr)
	}
}

func TestGroupHelpEveryWay(t *testing.T) {
	withDemoGroup(t)
	for _, args := range [][]string{{"demo", "--help"}, {"demo", "-h"}, {"demo", "-help"}, {"help", "demo"}} {
		code, stdout, stderr := invoke(args...)
		if code != 0 || stderr != "" || !strings.HasPrefix(stdout, "vectory demo: try the verbs of a group\n") ||
			!strings.Contains(stdout, "Verbs:\n  alpha  Say a name\n  beta   Take a file\n") ||
			!strings.Contains(stdout, "Run 'vectory help demo <verb>' for the flags and examples of one verb.") {
			t.Errorf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	for _, args := range [][]string{{"help", "demo", "alpha"}, {"demo", "alpha", "--help"}, {"demo", "alpha", "-h"}} {
		code, stdout, stderr := invoke(args...)
		if code != 0 || stderr != "" || !strings.HasPrefix(stdout, "vectory demo alpha: say a name\n\nUsage:\n  vectory demo alpha [--name NAME]\n") ||
			!strings.Contains(stdout, "--name NAME  Who to greet (default world)") || !strings.Contains(stdout, "Examples:\n  vectory demo alpha --name x") {
			t.Errorf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	// `vectory demo help [verb]` is `vectory help demo [verb]`.
	for _, args := range [][]string{{"demo", "help"}, {"demo", "help", "alpha"}} {
		want := map[bool]string{true: "vectory demo alpha: ", false: "vectory demo: "}[len(args) == 3]
		if code, stdout, stderr := invoke(args...); code != 0 || stderr != "" || !strings.HasPrefix(stdout, want) {
			t.Errorf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	if code, _, stderr := invoke("demo", "help", "nope"); code != 2 || !strings.Contains(stderr, `unknown verb "nope"`) {
		t.Errorf("%d %q", code, stderr)
	}
	// A verb's operands are in its usage, and a hidden verb has no help.
	if _, stdout, _ := invoke("help", "demo", "beta"); !strings.Contains(stdout, "vectory demo beta [--flag] FILE") {
		t.Errorf("%s", stdout)
	}
	if code, stdout, stderr := invoke("help", "demo", "gamma"); code != 2 || stdout != "" || !strings.Contains(stderr, `unknown verb "gamma"`) {
		t.Errorf("a hidden verb has no help: %d %q %q", code, stdout, stderr)
	}
}

func TestGroupVerbsRunWithTheirOwnFlags(t *testing.T) {
	withDemoGroup(t)
	for args, want := range map[string]string{
		"demo alpha":                "alpha world\n",
		"demo alpha --name x":       "alpha x\n",
		"demo alpha --name=x":       "alpha x\n",
		"demo beta file.txt":        "beta file.txt false\n",
		"demo beta --flag file.txt": "beta file.txt true\n",
		"demo beta -flag file.txt":  "beta file.txt true\n",
		"demo gamma":                "gamma\n",
	} {
		code, stdout, stderr := invoke(strings.Fields(args)...)
		if code != 0 || stdout != want || stderr != "" {
			t.Errorf("%s: %d %q %q", args, code, stdout, stderr)
		}
	}
}

func TestGroupVerbMistakesAreUsageErrors(t *testing.T) {
	withDemoGroup(t)
	for _, c := range []struct {
		args string
		want string
	}{
		{"demo nope", `vectory demo: unknown verb "nope".`},
		{"demo alhpa", `Did you mean "alpha"?`},
		{"demo --json", "put the verb first, as in vectory demo <verb> [flags]"},
		{"demo alpha --bogus", "vectory demo alpha: unknown flag --bogus"},
		{"demo alpha extra", "vectory: demo alpha accepts flags only; unexpected positional arguments"},
		{"demo beta", "vectory demo beta: missing FILE."},
		{"demo beta a b", `vectory demo beta: unexpected argument "b".`},
		{"demo beta file --flag", `vectory demo beta: put the flags before FILE: "--flag" came after it.`},
		{"demo beta file -x", `put the flags before FILE`},
		{"help demo nope", `vectory demo: unknown verb "nope".`},
	} {
		code, stdout, stderr := invoke(strings.Fields(c.args)...)
		if code != 2 || stdout != "" || !strings.Contains(stderr, c.want) {
			t.Errorf("%s: %d %q %q", c.args, code, stdout, stderr)
		}
	}
	// The message points at the help of the verb, which exists.
	_, _, stderr := invoke("demo", "alpha", "--bogus")
	if !strings.Contains(stderr, "Run 'vectory help demo alpha' for usage.") {
		t.Errorf("%s", stderr)
	}
	if code, _, _ := invoke("help", "demo", "alpha"); code != 0 {
		t.Error("the help the message names exists")
	}
}

// A group is a command in the lists: the general help names it under its group,
// and a mistyped group is suggested like a mistyped command.
func TestGroupsAreListedAndSuggested(t *testing.T) {
	withDemoGroup(t)
	_, stdout, _ := invoke("help")
	if !strings.Contains(stdout, "  demo                Try the verbs of a group\n") {
		t.Errorf("the general help lacks the group:\n%s", stdout)
	}
	if code, _, stderr := invoke("dem"); code != 2 || !strings.Contains(stderr, `Did you mean "demo"?`) {
		t.Errorf("%d %q", code, stderr)
	}
}

// Flags in front of the command are said so, and the corrected command keeps a
// group's verb next to the group's name.
func TestFlagsBeforeAGroupVerbAreCorrected(t *testing.T) {
	withDemoGroup(t)
	for args, want := range map[string]string{
		"--json demo alpha --name x": "vectory demo alpha --json --name x",
		"--json demo beta f":         "vectory demo beta --json f",
		"--json demo":                "vectory demo --json",
	} {
		code, stdout, stderr := invoke(strings.Fields(args)...)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "put the command first: "+want) {
			t.Errorf("%s: %d %q %q", args, code, stdout, stderr)
		}
	}
}

// What parsed before still parses the same way: commands take flags only.
func TestCommandsWithoutOperandsStillTakeFlagsOnly(t *testing.T) {
	for _, args := range [][]string{{"status", "extra"}, {"doctor", "a", "b"}, {"pause", "now"}} {
		code, stdout, stderr := invoke(args...)
		want := "vectory: " + args[0] + " accepts flags only; unexpected positional arguments\n"
		if code != 2 || stdout != "" || stderr != want {
			t.Errorf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	// A group's name is not a verb of another command.
	if code, _, stderr := invoke("status", "release"); code != 2 || !strings.Contains(stderr, "status accepts flags only") {
		t.Errorf("%d %q", code, stderr)
	}
}

// A command whose help group is not in the list would be missing from the
// general help, and a verb without a summary or a usage line would print a bare
// help page: every command and verb that ships is described.
func TestEveryCommandAndVerbIsListedAndDescribed(t *testing.T) {
	seen := map[string]bool{}
	for _, cmd := range commands {
		if seen[cmd.name] {
			t.Errorf("the command %q is defined twice", cmd.name)
		}
		seen[cmd.name] = true
		if cmd.hidden {
			continue
		}
		if !slices.Contains(groups, cmd.group) {
			t.Errorf("%s is in the help group %q, which the general help doesn't list (%v)", cmd.name, cmd.group, groups)
		}
		if cmd.summary == "" || cmd.usage == "" {
			t.Errorf("%s has no summary or no usage", cmd.name)
		}
		if len(cmd.verbs) > 0 && (cmd.define != nil || !strings.HasPrefix(cmd.usage, cmd.name+" <verb>")) {
			t.Errorf("the group %s has no flags or action of its own, and its usage is %q", cmd.name, cmd.usage)
		}
		names := map[string]bool{}
		for _, verb := range cmd.verbs {
			if names[verb.name] {
				t.Errorf("%s has the verb %q twice", cmd.name, verb.name)
			}
			names[verb.name] = true
			if verb.parent != cmd.name {
				t.Errorf("the verb %s of %s isn't linked to its group", verb.name, cmd.name)
			}
			if verb.hidden {
				continue
			}
			if verb.summary == "" || verb.define == nil || !strings.HasPrefix(verb.usage, cmd.name+" "+verb.name) {
				t.Errorf("the verb %s %s needs a summary, an action and a usage that starts with its words (%q)", cmd.name, verb.name, verb.usage)
			}
			// Every verb's help is reachable the two ways the usage errors point to.
			for _, args := range [][]string{{"help", cmd.name, verb.name}, {cmd.name, verb.name, "--help"}} {
				if code, stdout, stderr := invoke(args...); code != 0 || stderr != "" || !strings.HasPrefix(stdout, "vectory "+cmd.name+" "+verb.name+": ") {
					t.Errorf("%v: %d %q %q", args, code, stdout, stderr)
				}
			}
		}
	}
}
