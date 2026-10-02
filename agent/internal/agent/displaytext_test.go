package agent

import (
	"fmt"
	"testing"
)

func TestHostileTextHelpers(t *testing.T) {
	// The characters under test are built from their code points, so the source
	// holds none of them.
	str := func(code rune) string { return string(code) }
	escape := func(code rune) string { return fmt.Sprintf("%c%c%04x", 0x5c, 'u', code) }
	var (
		lineSep, paraSep = str(0x2028), str(0x2029)
		rlo, pdf         = str(0x202e), str(0x202c)
		lri, pdi         = str(0x2066), str(0x2069)
		c1csi, nel       = str(0x9b), str(0x85)
		lrm, rlm         = str(0x200e), str(0x200f)
		replacement      = str(0xfffd)
	)
	for _, c := range []struct{ name, in, line, visible, escaped string }{
		{"plain text", "plain text", "plain text", "plain text", "plain text"},
		{"extra spaces", "  two   spaces ", "two spaces", "  two   spaces ", "  two   spaces "},
		{"BEL", "a\x07b", "a b", `a\x07b`, "a\x07b"},
		{"a control sequence", "a\x1b[2Jb", "a [2Jb", `a\x1b[2Jb`, "a\x1b[2Jb"},
		{"CR and LF", "a\nb\r\nc", "a b c", `a\x0ab\x0d\x0ac`, "a\nb\r\nc"},
		{"DEL", "del\x7f", "del", `del\x7f`, `del` + escape(0x7f)},
		{"C1 CSI", "c1" + c1csi, "c1", `c1\x9b`, "c1" + escape(0x9b)},
		{"NEL", "nel" + nel, "nel", `nel\x85`, "nel" + escape(0x85)},
		{"line and paragraph separators", "ls" + lineSep + "ps" + paraSep, "ls ps", "ls" + escape(0x2028) + "ps" + escape(0x2029), "ls" + escape(0x2028) + "ps" + escape(0x2029)},
		{"an override", "rlo" + rlo + "txt" + pdf, "rlo txt", "rlo" + escape(0x202e) + "txt" + escape(0x202c), "rlo" + escape(0x202e) + "txt" + escape(0x202c)},
		{"an isolate", "iso" + lri + "x" + pdi, "iso x", "iso" + escape(0x2066) + "x" + escape(0x2069), "iso" + escape(0x2066) + "x" + escape(0x2069)},
		{"an invalid byte", "bad\x9bbyte", "badbyte", "bad" + replacement + "byte", "bad" + replacement + "byte"},
		{"text in other scripts", "émoji 🙂 and 日本語", "émoji 🙂 and 日本語", "émoji 🙂 and 日本語", "émoji 🙂 and 日本語"},
		{"direction marks stay", "marks " + lrm + rlm + " stay", "marks " + lrm + rlm + " stay", "marks " + lrm + rlm + " stay", "marks " + lrm + rlm + " stay"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := singleLine(c.in); got != c.line {
				t.Errorf("singleLine = %q, want %q", got, c.line)
			}
			if got := visibleText(c.in); got != c.visible {
				t.Errorf("visibleText = %q, want %q", got, c.visible)
			}
			if got := escapeJSONText(c.in); got != c.escaped {
				t.Errorf("escapeJSONText = %q, want %q", got, c.escaped)
			}
		})
	}
}

// A pipeline name is held to the same rule as the text of a report.
func TestPipelineNamesRefuseWhatReportsReplace(t *testing.T) {
	for r := rune(0); r < 0x3000; r++ {
		if got, want := wellFormedName("a"+string(r)+"b"), !unsafeRune(r); got != want {
			t.Fatalf("wellFormedName with %U = %v, want %v", r, got, want)
		}
	}
}
