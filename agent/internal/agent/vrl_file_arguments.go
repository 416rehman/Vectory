package agent

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// fileArgumentFunction is a VRL function that reads a file only when a call
// passes one.
type fileArgumentFunction struct {
	name     string // the function
	argument string // its named file argument
	position int    // the argument count at which the file is a positional one
	label    string // how a refusal names the call
}

// fileArgumentFunctions lists them: parse_groks takes alias_sources (JSON files
// of grok aliases) and parse_etld takes psl (a public suffix list). Vector 0.58
// opens the file when it compiles the program, in whichever command compiles
// it and on a branch that never runs, and the file is any the service account
// can read, which no file root covers. So restricted mode refuses a call that
// passes one, however the argument is written. Without one, both functions are
// ordinary.
//
// The server's FILE_ARGUMENT_FUNCTIONS (server/src/validation.rs) and the
// dashboard's fileArgumentFunctions (dashboard/src/vrlFileArguments.ts) are the
// same table, with the same scan: tests/security/test_vrl_function_lists.py
// fails when the three drift, and the programs in
// vector-catalog/fixtures/vrl-file-arguments.json are judged alike by all.
var fileArgumentFunctions = []fileArgumentFunction{
	{name: "parse_groks", argument: "alias_sources", position: 4, label: "parse_groks with alias_sources"},
	{name: "parse_etld", argument: "psl", position: 3, label: "parse_etld with psl"},
}

// The most calls to one function, the most text of one call, and the most text
// in all that are read. A program past any of them is taken to pass a file: no
// real one is. The text in all is maxScanFactor times the program's length and
// maxCallBytes more, counting every reading of every call: ordinary calls read
// each byte of the program three times at most, so only calls nested in each
// other, or left open so that each reads the rest again, reach it. It keeps the
// work of a scan in step with the size of what it scans, however the calls are
// arranged.
const (
	maxFileArgumentCalls = 256
	maxCallBytes         = 32 * 1024
	maxScanFactor        = 4
)

// quoteReading is how a scan reads quotes. VRL ends a string or literal
// ("...", s'...', r'...') at the first quote that no backslash escapes. A
// second reading ends a single-quoted one at the next ' whatever precedes it,
// and a third ignores quotes and comments, so a program that one reading
// misjudges can't hide an argument from all of them: every call is read each
// way.
type quoteReading int

const (
	escapedQuotes quoteReading = iota
	rawQuotes
	ignoredQuotes
)

func trimSpace(text string) string { return strings.TrimFunc(text, unicode.IsSpace) }

func trimLeftSpace(text string) string { return strings.TrimLeftFunc(text, unicode.IsSpace) }

// callArguments are the arguments of one call, from the text after its opening
// parenthesis up to the matching one: top-level, trimmed, split on commas that
// are not inside brackets, braces, parentheses, strings or comments. closed
// says whether the call closed before the text ended, and read how many bytes of
// the text the reading went through: up to and including the closing
// parenthesis, or all of it when the call never closed.
func callArguments(body string, quotes quoteReading) (arguments []string, closed bool, read int) {
	var current strings.Builder
	depth := 0
	for i := 0; i < len(body); i++ {
		c := body[i]
		switch {
		case (c == '"' || c == '\'') && quotes != ignoredQuotes:
			current.WriteByte(c)
			for i++; i < len(body); i++ {
				inner := body[i]
				current.WriteByte(inner)
				if inner == '\\' && (c == '"' || quotes == escapedQuotes) {
					if i+1 < len(body) {
						i++
						current.WriteByte(body[i])
					}
				} else if inner == c {
					break
				}
			}
		case c == '#' && quotes != ignoredQuotes:
			for i++; i < len(body) && body[i] != '\n'; i++ {
			}
			current.WriteByte(' ')
		case c == '(' || c == '[' || c == '{':
			depth++
			current.WriteByte(c)
		case (c == ')' || c == ']' || c == '}') && depth == 0:
			if argument := trimSpace(current.String()); argument != "" {
				arguments = append(arguments, argument)
			}
			return arguments, true, i + 1
		case c == ')' || c == ']' || c == '}':
			depth--
			current.WriteByte(c)
		case c == ',' && depth == 0:
			arguments = append(arguments, trimSpace(current.String()))
			current.Reset()
		default:
			current.WriteByte(c)
		}
	}
	if argument := trimSpace(current.String()); argument != "" {
		arguments = append(arguments, argument)
	}
	return arguments, false, len(body)
}

// partOfAName says whether the byte before a function's name makes it part of
// a longer name or a field path: an ASCII letter, a digit, an underscore or a
// dot.
func partOfAName(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_' || b == '.'
}

// namesArgument says whether an argument is written `name: value`.
func namesArgument(argument, name string) bool {
	after, found := strings.CutPrefix(argument, name)
	return found && strings.HasPrefix(trimLeftSpace(after), ":")
}

// passesAFile says whether text calls the function with a file, by name or by
// position. A call that is read ambiguously counts as passing one.
func (function fileArgumentFunction) passesAFile(text string) bool {
	read, scanned := 0, 0
	budget := maxScanFactor*len(text) + maxCallBytes
	for from := 0; ; {
		offset := strings.Index(text[from:], function.name)
		if offset < 0 {
			return false
		}
		start := from + offset
		from = start + len(function.name)
		if start > 0 && partOfAName(text[start-1]) {
			continue
		}
		// A call is the name, an optional bang and a parenthesis. VRL allows no
		// space between them; the scan tolerates white space and never misses one.
		rest := trimLeftSpace(strings.TrimPrefix(trimLeftSpace(text[from:]), "!"))
		body, isCall := strings.CutPrefix(rest, "(")
		if !isCall {
			continue
		}
		read++
		if read > maxFileArgumentCalls {
			return true
		}
		end := min(len(body), maxCallBytes)
		for end < len(body) && !utf8.RuneStart(body[end]) {
			end--
		}
		window := body[:end]
		for _, quotes := range []quoteReading{escapedQuotes, rawQuotes, ignoredQuotes} {
			arguments, closed, went := callArguments(window, quotes)
			scanned += went
			cutOff := !closed && end < len(body)
			if cutOff || scanned > budget || len(arguments) >= function.position {
				return true
			}
			for _, argument := range arguments {
				if namesArgument(argument, function.argument) {
					return true
				}
			}
		}
	}
}

// fileArgumentCalls are the functions text calls with a file argument, in the
// order of fileArgumentFunctions.
func fileArgumentCalls(text string) []fileArgumentFunction {
	var found []fileArgumentFunction
	for _, function := range fileArgumentFunctions {
		if function.passesAFile(text) {
			found = append(found, function)
		}
	}
	return found
}

// fileArgumentCategory is the fixed category of the refusal: the function and
// its argument come from the table, never from the pipeline.
const fileArgumentCategory = "capability denied: VRL that reads a file"

func (function fileArgumentFunction) category() string {
	return fileArgumentCategory + " (" + function.name + " " + function.argument + ")"
}
