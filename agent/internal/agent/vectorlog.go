package agent

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Vector's JSON internal log (its stdout) is kept locally: a bounded in-memory
// ring, a size-rotated private file for `vectory logs`, and WARN/ERROR
// summaries grouped by fingerprint. Only redacted summaries leave the host.
// Vector's stderr carries console-sink event payloads and is never persisted.
const (
	vectorLogName        = "vector.log"
	vectorLogRingLines   = 500
	vectorLogMaxLine     = 16 << 10
	logSummaryMax        = 20
	logSummaryTracked    = 64
	logSummaryWindow     = time.Hour
	activationRecordsMax = 200
)

// noPrintableText stands for a summary message that has nothing left once its
// control characters are gone.
const noPrintableText = "Vector logged a message with no printable text."

// vectorLogMaxBytes rotates vector.log to vector.log.1 (one rotated file).
var vectorLogMaxBytes int64 = 10 << 20

type logSignals struct{ started, reloaded, reloadFailed uint64 }

// LogSummary is one group of similar Vector warnings or errors.
type LogSummary struct {
	Fingerprint   string    `json:"fingerprint"`
	Level         string    `json:"level"`
	ComponentID   string    `json:"component_id,omitempty"`
	ComponentKind string    `json:"component_kind,omitempty"`
	ComponentType string    `json:"component_type,omitempty"`
	Message       string    `json:"message"`
	ErrorType     string    `json:"error_type,omitempty"`
	Stage         string    `json:"stage,omitempty"`
	Reason        string    `json:"reason,omitempty"`
	Count         uint64    `json:"count"`
	FirstSeen     time.Time `json:"first_seen"`
	LastSeen      time.Time `json:"last_seen"`
}

type logEntry struct {
	summary LogSummary
	message string // unredacted, at most one log line; redacted when reported
	// epoch is the activation (start or reload) the entry was last seen in.
	epoch uint64
}

type vectorLog struct {
	mu        sync.Mutex
	path      string
	file      *os.File
	size      int64
	ring      []string
	head      int
	line      []byte
	dropping  bool
	signals   logSignals
	changed   chan struct{}
	capturing bool
	captured  []vectorRecord
	entries   map[string]*logEntry
	// epoch counts activations: the summary reports only what Vector logged
	// since it last started or reloaded a configuration, never errors of a
	// configuration it no longer runs.
	epoch uint64
	now   func() time.Time
}

func newVectorLog(dir string) *vectorLog {
	l := &vectorLog{changed: make(chan struct{}), entries: map[string]*logEntry{}, now: time.Now}
	if dir != "" {
		l.path = filepath.Join(dir, vectorLogName)
	}
	return l
}

// Write receives Vector's stdout. It never fails: log handling must not be
// able to block or kill the supervised process.
func (l *vectorLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, c := range p {
		if c == '\n' {
			if len(l.line) > 0 {
				l.handle(l.line)
			}
			l.line = l.line[:0]
			l.dropping = false
			continue
		}
		if l.dropping {
			continue
		}
		if len(l.line) >= vectorLogMaxLine {
			l.handle(append(l.line, []byte(" …[truncated]")...))
			l.line = l.line[:0]
			l.dropping = true
			continue
		}
		l.line = append(l.line, c)
	}
	return len(p), nil
}

func (l *vectorLog) handle(line []byte) {
	text := string(line)
	l.remember(text)
	l.persist(text)
	rec, ok := parseVectorRecord(line)
	if !ok {
		return
	}
	// Verdicts count only from Vector's own targets: a pipeline's VRL log()
	// writes arbitrary messages to the same stream (target vrl::stdlib::log).
	switch {
	case rec.Message == "Vector has started." && rec.Target == "vector" && SupportedVectorVersion(rec.Version):
		l.signals.started++
		l.notify()
	case rec.Message == "Vector has reloaded." && rec.Target == "vector":
		l.signals.reloaded++
		l.notify()
	case (rec.Message == "Reload was not successful." || rec.Message == "Failed to load config files, reload aborted.") && rec.Target == "vector::internal_events::process":
		// The second is a reload whose configuration doesn't even load.
		l.signals.reloadFailed++
		l.notify()
	}
	if l.capturing && len(l.captured) < activationRecordsMax {
		l.captured = append(l.captured, rec)
	}
	if rec.Level == "WARN" || rec.Level == "ERROR" {
		l.summarize(rec)
	}
}

func (l *vectorLog) notify() {
	close(l.changed)
	l.changed = make(chan struct{})
}

func (l *vectorLog) remember(text string) {
	if len(l.ring) < vectorLogRingLines {
		l.ring = append(l.ring, text)
		return
	}
	l.ring[l.head] = text
	l.head = (l.head + 1) % vectorLogRingLines
}

// recent returns the in-memory ring, oldest first.
func (l *vectorLog) recent() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append(append([]string(nil), l.ring[l.head:]...), l.ring[:l.head]...)
}

// persist appends to the private local log, rotating once at the size bound.
// Failures are ignored: the ring and summaries keep working without disk.
func (l *vectorLog) persist(text string) {
	if l.path == "" {
		return
	}
	if l.file != nil && l.size+int64(len(text))+1 > vectorLogMaxBytes {
		_ = l.file.Close()
		l.file = nil
		_ = os.Remove(l.path + ".1")
		_ = os.Rename(l.path, l.path+".1")
	}
	if l.file == nil {
		if SafePath(l.path) != nil {
			return
		}
		_, statErr := os.Lstat(l.path)
		f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return
		}
		if os.IsNotExist(statErr) {
			_ = protect(l.path, false)
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			return
		}
		l.file, l.size = f, info.Size()
	}
	n, _ := io.WriteString(l.file, text+"\n")
	l.size += int64(n)
}

// note records agent-side context (for example, a failed `vector validate`)
// in the local log so `vectory logs` shows the complete story.
func (l *vectorLog) note(title string, output []byte) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	stamp := l.now().UTC().Format(time.RFC3339)
	l.persist("[vectory " + stamp + "] " + title)
	for _, line := range strings.Split(strings.TrimRight(string(output), "\n"), "\n") {
		if len(line) > vectorLogMaxLine {
			line = line[:vectorLogMaxLine]
		}
		l.persist("  " + line)
	}
}

// NoteLocally records a host operator's change in the agent's local log, so
// `vectory logs` shows who changed what and when: a local audit trail. Where
// Vector has not run yet there is no log, so it creates one: private, and
// owned by whoever owns the state directory, so the service account that
// writes Vector's own lines later can still append to it. A file it could not
// hand over that way is removed again, never left for root alone.
func NoteLocally(dir, title string) {
	path := filepath.Join(dir, vectorLogName)
	if SafePath(path) != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	switch {
	case err == nil:
		if ownedLikeParent(path) != nil {
			_ = f.Close()
			_ = os.Remove(path)
			return
		}
	case os.IsExist(err):
		if f, err = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0); err != nil {
			return
		}
	default:
		return
	}
	defer f.Close()
	_, _ = io.WriteString(f, "[vectory "+time.Now().UTC().Format(time.RFC3339)+"] "+safeText(title, vectorLogMaxLine)+"\n")
}

func (l *vectorLog) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

// beginCapture starts collecting records for one start or reload attempt and
// returns the signal counters to wait beyond. A new process starts a new
// stream, so an unterminated line left by the previous one is dropped; a
// reload keeps the line Vector is writing.
func (l *vectorLog) beginCapture(newProcess bool) logSignals {
	l.mu.Lock()
	defer l.mu.Unlock()
	if newProcess {
		l.line, l.dropping = l.line[:0], false
	}
	l.capturing, l.captured = true, nil
	l.epoch++
	return l.signals
}

func (l *vectorLog) endCapture() []vectorRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	records := l.captured
	l.capturing, l.captured = false, nil
	return records
}

// await waits until pred holds for the signal counters, the process exits,
// the context ends, or the timeout passes.
func (l *vectorLog) await(ctx context.Context, done <-chan struct{}, timeout time.Duration, pred func(logSignals) bool) (logSignals, string) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		l.mu.Lock()
		signals, changed := l.signals, l.changed
		l.mu.Unlock()
		if pred(signals) {
			return signals, ""
		}
		select {
		case <-ctx.Done():
			return signals, "cancelled"
		case <-done:
			// The process may have logged its final line just before exiting.
			l.mu.Lock()
			signals = l.signals
			l.mu.Unlock()
			if pred(signals) {
				return signals, ""
			}
			return signals, "exited"
		case <-timer.C:
			return signals, "timeout"
		case <-changed:
		}
	}
}

var suppressedLog = regexp.MustCompile(`^Internal log \[(.+)\] has been suppressed (\d+) times\.$`)

func (l *vectorLog) summarize(rec vectorRecord) {
	message, add := rec.Message, uint64(1)
	if strings.HasPrefix(message, "Internal log [") {
		m := suppressedLog.FindStringSubmatch(message)
		if m == nil {
			return // "is being suppressed" markers carry no new occurrence
		}
		message = m[1]
		add, _ = strconv.ParseUint(m[2], 10, 32)
		rec.Error = ""
	}
	reason := classifyNetwork(rec.Error)
	// Vector's rate-limit summaries ("has been suppressed N times") carry only
	// the message and component, so the error type and stage stay out of the
	// fingerprint: suppressed repeats count toward their original group.
	sum := sha256.Sum256([]byte(strings.Join([]string{rec.Level, rec.ComponentID, rec.ComponentType, message}, "\x00")))
	fingerprint := hex.EncodeToString(sum[:8])
	now := l.now().UTC()
	entry := l.entries[fingerprint]
	if entry == nil {
		if len(l.entries) >= logSummaryTracked {
			l.evictOldest()
		}
		entry = &logEntry{summary: LogSummary{Fingerprint: fingerprint, Level: strings.ToLower(rec.Level), ComponentID: rec.ComponentID, ComponentKind: rec.ComponentKind, ComponentType: rec.ComponentType, ErrorType: rec.ErrorType, Stage: rec.Stage, FirstSeen: now}}
		l.entries[fingerprint] = entry
	}
	if rec.Error != "" || entry.message == "" {
		text := message
		if rec.Error != "" {
			text += " " + rec.Error
		}
		// Kept whole (the line is already bounded by vectorLogMaxLine):
		// summaries redact before they truncate, and a secret cut in half
		// here would no longer match its redaction.
		entry.message = text
	}
	if reason != "" {
		entry.summary.Reason = reason
	}
	if entry.summary.ErrorType == "" {
		entry.summary.ErrorType = rec.ErrorType
	}
	if entry.summary.Stage == "" {
		entry.summary.Stage = rec.Stage
	}
	if entry.epoch != l.epoch {
		// The same message under a newer activation starts a new count.
		entry.summary.Count, entry.summary.FirstSeen, entry.epoch = 0, now, l.epoch
	}
	entry.summary.Count += add
	entry.summary.LastSeen = now
}

func (l *vectorLog) evictOldest() {
	var oldest string
	for key, entry := range l.entries {
		if oldest == "" || entry.summary.LastSeen.Before(l.entries[oldest].summary.LastSeen) {
			oldest = key
		}
	}
	delete(l.entries, oldest)
}

// summaries reports recent WARN/ERROR groups, redacted, errors first.
func (l *vectorLog) summaries(r *redactor) []LogSummary {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := l.now().UTC().Add(-logSummaryWindow)
	var out []LogSummary
	for key, entry := range l.entries {
		// Stale, or logged under a configuration Vector no longer runs.
		if entry.summary.LastSeen.Before(cutoff) || entry.epoch != l.epoch {
			delete(l.entries, key)
			continue
		}
		s := entry.summary
		s.ComponentID = r.identifier(s.ComponentID)
		if s.ComponentID == "" {
			s.ComponentKind = ""
			s.ComponentType = ""
		}
		s.ComponentType = boundedToken(s.ComponentType, 64)
		s.ErrorType = boundedToken(s.ErrorType, 64)
		s.Stage = boundedToken(s.Stage, 32)
		if s.ComponentKind != "source" && s.ComponentKind != "transform" && s.ComponentKind != "sink" {
			s.ComponentKind = ""
		}
		s.Message = truncateText(r.text(entry.message), maxDiagnosticMessage)
		if s.Message == "" {
			// A line of only control characters: the server needs a message.
			s.Message = noPrintableText
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Level == "error") != (out[j].Level == "error") {
			return out[i].Level == "error"
		}
		return out[i].LastSeen.After(out[j].LastSeen)
	})
	if len(out) > logSummaryMax {
		out = out[:logSummaryMax]
	}
	return out
}

var boundedTokenPattern = regexp.MustCompile(`^[a-z0-9_]+$`)

func boundedToken(value string, max int) string {
	if len(value) > max || !boundedTokenPattern.MatchString(value) {
		return ""
	}
	return value
}

// ---- `vectory logs` ----

// Output formats of WriteVectorLog.
const (
	LogText = "text" // for people
	LogRaw  = "raw"  // the file's lines unchanged
	LogJSON = "json" // one JSON object per line
)

var agentNote = regexp.MustCompile(`^\[vectory (\S+)\] (.*)$`)

// logJSON renders the log file as JSON lines. Vector's records stay as they
// are; the agent's notes ("[vectory <time>] title", then indented output)
// and anything else become objects with the same keys, so every line parses.
// A control character in an event reaches a reader as a \u escape, never as a
// byte: the encoders escape the ones below U+0020 and escapeJSONText the rest.
func logJSON() func(string) string {
	var noted string
	return func(line string) string {
		if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "{") && json.Valid([]byte(trimmed)) {
			var compact bytes.Buffer
			if json.Compact(&compact, []byte(trimmed)) == nil {
				return escapeJSONText(compact.String())
			}
		}
		record := struct {
			Timestamp string `json:"timestamp,omitempty"`
			Target    string `json:"target,omitempty"`
			Message   string `json:"message"`
		}{Message: line}
		switch m := agentNote.FindStringSubmatch(line); {
		case m != nil:
			noted = m[1]
			record.Timestamp, record.Target, record.Message = m[1], "vectory", m[2]
		case strings.HasPrefix(line, "  "):
			record.Timestamp, record.Target, record.Message = noted, "vectory", strings.TrimPrefix(line, "  ")
		}
		encoded, _ := json.Marshal(record)
		return escapeJSONText(string(encoded))
	}
}

// WriteVectorLog prints the last lines of the local Vector log in format and,
// with follow, streams new lines until ctx ends. It reads files only; it
// never needs the agent lock, so it works while the service runs.
func WriteVectorLog(ctx context.Context, dir string, lines int, follow bool, format string, w io.Writer) error {
	render := func(line string) string { return formatLogLine(line, format == LogRaw) }
	if format == LogJSON {
		render = logJSON()
	}
	if err := adoptionLocalPath(dir); err != nil {
		return err
	}
	path := filepath.Join(dir, vectorLogName)
	if err := SafePath(path); err != nil {
		return err
	}
	if lines < 1 {
		lines = 1
	}
	tail := tailLines(path+".1", nil, lines)
	tail = tailLines(path, tail, lines)
	if len(tail) == 0 && !follow {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return errors.New("no Vector log yet: the agent writes " + path + " after it starts Vector")
		}
	}
	for _, line := range tail {
		fmt.Fprintln(w, render(line))
	}
	if !follow {
		return nil
	}
	var offset int64
	var identity os.FileInfo
	if info, err := os.Stat(path); err == nil {
		offset, identity = info.Size(), info
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if identity == nil || !os.SameFile(identity, info) || info.Size() < offset {
			offset, identity = 0, info
		}
		if info.Size() == offset {
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		if _, err = f.Seek(offset, io.SeekStart); err == nil {
			reader := bufio.NewReader(f)
			for {
				line, err := reader.ReadString('\n')
				if err != nil {
					break // an incomplete final line is read on the next tick
				}
				offset += int64(len(line))
				fmt.Fprintln(w, render(strings.TrimRight(line, "\r\n")))
			}
		}
		f.Close()
	}
}

func tailLines(path string, previous []string, limit int) []string {
	f, err := os.Open(path)
	if err != nil {
		return previous
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), vectorLogMaxLine+64)
	lines := previous
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if len(lines) > limit*2 {
			lines = append([]string(nil), lines[len(lines)-limit:]...)
		}
	}
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return lines
}

// formatLogLine renders one log line for people:
// "02:44:21  WARN  sink web  HTTP error. error=…". Unless raw, the line shows
// every control character, line separator and text-direction control as an
// escape (visibleText): an event can't draw on the terminal or pass itself off
// as another line.
func formatLogLine(line string, raw bool) string {
	if raw {
		return line
	}
	return visibleText(formatRecord(line))
}

// formatRecord is a JSON record laid out for people, and any other line as it is.
func formatRecord(line string) string {
	if !strings.HasPrefix(line, "{") {
		return line
	}
	var fields map[string]any
	if json.Unmarshal([]byte(line), &fields) != nil {
		return line
	}
	rec, ok := parseVectorRecord([]byte(line))
	if !ok {
		return line
	}
	stamp := rec.Timestamp
	if t, err := time.Parse(time.RFC3339Nano, rec.Timestamp); err == nil {
		stamp = t.UTC().Format("2006-01-02 15:04:05Z")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s  %-5s  ", stamp, rec.Level)
	if rec.ComponentID != "" {
		fmt.Fprintf(&b, "%s %s  ", rec.ComponentKind, rec.ComponentID)
	}
	b.WriteString(rec.Message)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		switch key {
		case "timestamp", "level", "message", "msg", "target", "span", "spans", "component_id", "component_kind", "component_type", "internal_log_rate_limit":
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Fprintf(&b, " %s=%s", key, jsonText(fields[key]))
	}
	return b.String()
}
