package agent

import (
	"fmt"
	"strings"
	"unicode"
)

// Text that came from Vector's output or from an event is untrusted. Two readers
// get it: the server and the dashboard, through the heartbeat's reports, and a
// person at a terminal, through `vectory logs`. Neither may receive a character
// that moves a cursor, sets a window title, starts another line or reorders the
// text around it. The server also refuses a report that holds a control
// character, so one bad byte in a log line would otherwise cost the device its
// check-in.

// noPrintableDiagnostic is what a diagnostic's message says when nothing is left
// of it: the server needs a message for every finding.
const noPrintableDiagnostic = "Vector reported an error."

// hostileRune reports a character that can't be shown safely in one line of
// text: a control character (C0, DEL or C1), a line or paragraph separator, or
// a text-direction embedding, override or isolate. A pipeline name is held to
// the same rule.
func hostileRune(r rune) bool {
	switch {
	case unicode.IsControl(r), unicode.Is(unicode.Zl, r), unicode.Is(unicode.Zp, r):
		return true
	case r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
		// Embedding, override and isolate controls reorder what follows them.
		return true
	}
	return false
}

// refusedInName reports a character a member that names or identifies something
// may not hold: whatever hostileRune names, and the byte order mark. It is the
// server's rule for those members (db::refused_in_name): component IDs and
// output names, versions, request and boot IDs, and directories. The agent sends
// no such member that holds one, so the server never has to refuse a check-in
// for it.
func refusedInName(r rune) bool { return hostileRune(r) || r == 0xfeff }

func spaceHostile(r rune) rune {
	if hostileRune(r) {
		return ' '
	}
	return r
}

// singleLine is text for a report: invalid UTF-8 is dropped, each hostile
// character becomes a space and runs of white space collapse to one.
func singleLine(text string) string {
	text = strings.ToValidUTF8(text, "")
	return strings.Join(strings.Fields(strings.Map(spaceHostile, text)), " ")
}

// escapeRune is how a message shows a hostile character: `\x1b` for ESC,
// `\x0a` for a newline, `\uNNNN` above U+00FF (U+202E, a right-to-left override, shows as `\u202e`).
func escapeRune(r rune) string {
	if r <= 0xff {
		return fmt.Sprintf(`\x%02x`, r)
	}
	return fmt.Sprintf(`\u%04x`, r)
}

// visibleText is text for a terminal: each hostile character shows as an escape
// (escapeRune), so it can neither act nor pass unseen.
func visibleText(text string) string {
	var b strings.Builder
	for _, r := range strings.ToValidUTF8(text, "\uFFFD") {
		if hostileRune(r) {
			b.WriteString(escapeRune(r))
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// escapeJSONText rewrites what JSON's own escaping leaves bare (DEL, C1
// controls, line and paragraph separators and text-direction controls) as
// \uXXXX escapes, and turns invalid UTF-8 into U+FFFD. The text is one valid
// JSON document, where such a character can only stand inside a string, so the
// document stays valid and decodes to the same value. The control characters
// below U+0020 are escaped by the encoder, Vector's included.
func escapeJSONText(document string) string {
	var b strings.Builder
	for _, r := range document {
		if r >= 0x7f && hostileRune(r) {
			fmt.Fprintf(&b, `\u%04x`, r)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
