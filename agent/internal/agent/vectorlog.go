package agent

import (
	"bufio"
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
	message string // unredacted, bounded; redacted when reported
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
	now       func() time.Time
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
	switch {
	case rec.Message == "Vector has started." && rec.Target == "vector" && rec.Version == VectorVersion:
		l.signals.started++
		l.notify()
	case rec.Message == "Vector has reloaded.":
		l.signals.reloaded++
		l.notify()
	case rec.Message == "Reload was not successful.":
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

func (l *vectorLog) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

// beginCapture starts collecting records for one start or reload attempt and
// returns the signal counters to wait beyond.
func (l *vectorLog) beginCapture() logSignals {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.line, l.dropping = l.line[:0], false
	l.capturing, l.captured = true, nil
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
		if len(text) > 1024 {
			text = text[:1024]
		}
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
		if entry.summary.LastSeen.Before(cutoff) {
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

// WriteVectorLog prints the last lines of the local Vector log and, with
// follow, streams new lines until ctx ends. It reads files only; it never
// needs the agent lock, so it works while the service runs.
func WriteVectorLog(ctx context.Context, dir string, lines int, follow, raw bool, w io.Writer) error {
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
		fmt.Fprintln(w, formatLogLine(line, raw))
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
				fmt.Fprintln(w, formatLogLine(strings.TrimRight(line, "\r\n"), raw))
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

// formatLogLine renders one JSON log line for people:
// "02:44:21  WARN  sink web  HTTP error. error=…".
func formatLogLine(line string, raw bool) string {
	if raw || !strings.HasPrefix(line, "{") {
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
