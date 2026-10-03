package agent

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

// An update window is when a host lets the privileged step start an apply:
//
//	DAYS HH:MM-HH:MM [UTC]
//
// DAYS is daily, a day (Mon), a range of days (Mon-Fri, which wraps the week:
// Sat-Mon is Saturday, Sunday and Monday) or a list of distinct days (Sat,Sun).
// The times are 24-hour, and the end differs from the start. They are in the
// host's local time unless UTC follows. A window that ends before it starts
// crosses midnight and belongs to the day it starts: Fri 22:00-02:00 is open
// from Friday 22:00 to Saturday 02:00. A window gates the start of an apply; a
// trial that started inside it may finish after it. A host with no window is
// always open.
//
// Daylight-saving changes follow the host's time zone, by the clock on the
// wall: a window is open while the clock shows a time inside it. On the night
// the clock goes back, the hour that repeats counts twice, and on the night it
// goes forward, a window that starts in the hour that is skipped opens when the
// clock reaches the next hour, and one that lies entirely inside it doesn't
// open that day.

const (
	maxUpdateWindows     = 7
	maxUpdateWindowChars = 40
	// updateWindowHorizon is how far NextStart looks, in minutes: two weeks and
	// three hours. Every window recurs weekly, and the one week in which a window
	// lies entirely inside the hour a change of the clock skips it doesn't open,
	// so the start after that is the week after.
	updateWindowHorizon = (15*24 + 3) * 60
	updateWindowExample = "Write days and times like 'Mon-Fri 02:00-04:00' or 'daily 01:00-03:00 UTC'."
)

// UpdateWindow is one parsed window.
type UpdateWindow struct {
	spec       string
	days       [7]bool // by time.Weekday: Sunday is 0
	start, end int     // minutes after midnight
	utc        bool
}

// UpdateWindows is the windows of a host. Empty means any time.
type UpdateWindows []UpdateWindow

var updateDayNames = map[string]time.Weekday{
	"Sun": time.Sunday, "Mon": time.Monday, "Tue": time.Tuesday, "Wed": time.Wednesday,
	"Thu": time.Thursday, "Fri": time.Friday, "Sat": time.Saturday,
}

func badUpdateWindow(spec, reason string) error {
	return inputError(fmt.Sprintf("%q isn't an update window: %s %s", spec, reason, updateWindowExample))
}

// ParseUpdateWindow parses one window as the policy and --update-window write
// it. The spelling is exact: single spaces, Mon for Monday, UTC in capitals.
func ParseUpdateWindow(spec string) (UpdateWindow, error) {
	if len(spec) > maxUpdateWindowChars {
		return UpdateWindow{}, badUpdateWindow(spec, fmt.Sprintf("it is longer than %d characters. Write daily for every day, or split it into two windows.", maxUpdateWindowChars))
	}
	for i := 0; i < len(spec); i++ {
		if spec[i] < 0x20 || spec[i] > 0x7e {
			return UpdateWindow{}, badUpdateWindow(spec, "it holds a character other than printable ASCII.")
		}
	}
	fields := strings.Split(spec, " ")
	if len(fields) != 2 && len(fields) != 3 || slices.Contains(fields, "") {
		return UpdateWindow{}, badUpdateWindow(spec, "it needs days, then times, then UTC if they are UTC, each after one space.")
	}
	window := UpdateWindow{spec: spec}
	if len(fields) == 3 {
		if fields[2] != "UTC" {
			return UpdateWindow{}, badUpdateWindow(spec, "only UTC, in capitals, can follow the times.")
		}
		window.utc = true
	}
	if reason := window.parseDays(fields[0]); reason != "" {
		return UpdateWindow{}, badUpdateWindow(spec, reason)
	}
	if reason := window.parseTimes(fields[1]); reason != "" {
		return UpdateWindow{}, badUpdateWindow(spec, reason)
	}
	return window, nil
}

func (w *UpdateWindow) parseDays(days string) string {
	notADay := func(text string) string {
		return fmt.Sprintf("%q isn't a day. Use Mon, Tue, Wed, Thu, Fri, Sat or Sun, or daily.", text)
	}
	switch {
	case days == "daily":
		for i := range w.days {
			w.days[i] = true
		}
	case strings.Contains(days, ",") && strings.Contains(days, "-"):
		return "write a range and a list as separate windows."
	case strings.Contains(days, ","):
		for _, name := range strings.Split(days, ",") {
			day, ok := updateDayNames[name]
			if !ok {
				return notADay(name)
			}
			if w.days[day] {
				return fmt.Sprintf("%s is listed twice.", name)
			}
			w.days[day] = true
		}
	case strings.Contains(days, "-"):
		from, to, _ := strings.Cut(days, "-")
		first, ok := updateDayNames[from]
		if !ok {
			return notADay(from)
		}
		last, ok := updateDayNames[to]
		if !ok {
			return notADay(to)
		}
		if first == last {
			return fmt.Sprintf("write one day as %s, not %s.", from, days)
		}
		// A range wraps the week: Sat-Mon is Saturday, Sunday and Monday.
		for day := first; ; day = (day + 1) % 7 {
			w.days[day] = true
			if day == last {
				break
			}
		}
	default:
		day, ok := updateDayNames[days]
		if !ok {
			return notADay(days)
		}
		w.days[day] = true
	}
	return ""
}

func (w *UpdateWindow) parseTimes(times string) string {
	const shape = "write the times as HH:MM-HH:MM in 24 hours, like 02:00-04:00."
	if len(times) != 11 || times[2] != ':' || times[5] != '-' || times[8] != ':' {
		return shape
	}
	// clock reads HH:MM as minutes after midnight.
	clock := func(text string) (minutes int, digits, inRange bool) {
		if !isDigits(text[0:2]) || !isDigits(text[3:5]) {
			return 0, false, false
		}
		hours, past := int(text[0]-'0')*10+int(text[1]-'0'), int(text[3]-'0')*10+int(text[4]-'0')
		return hours*60 + past, true, hours <= 23 && past <= 59
	}
	start, startDigits, startOK := clock(times[:5])
	end, endDigits, endOK := clock(times[6:])
	switch {
	case !startDigits || !endDigits:
		return shape
	case !startOK || !endOK:
		return "hours run from 00 to 23 and minutes from 00 to 59."
	case start == end:
		return "a window can't end when it starts."
	}
	w.start, w.end = start, end
	return ""
}

func isDigits(text string) bool {
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return false
		}
	}
	return true
}

// ParseUpdateWindows parses a host's windows, at most seven.
func ParseUpdateWindows(specs []string) (UpdateWindows, error) {
	if len(specs) > maxUpdateWindows {
		return nil, inputError(fmt.Sprintf("A host takes at most %d update windows, and %d were given. Use daily, a range of days or a list of days to cover more than one day in a window.", maxUpdateWindows, len(specs)))
	}
	windows := make(UpdateWindows, 0, len(specs))
	for _, spec := range specs {
		window, err := ParseUpdateWindow(spec)
		if err != nil {
			return nil, err
		}
		windows = append(windows, window)
	}
	return windows, nil
}

// String is the window as it was written.
func (w UpdateWindow) String() string { return w.spec }

// Specs lists the windows as they were written, for the policy and the report.
func (w UpdateWindows) Specs() []string {
	specs := make([]string, len(w))
	for i, window := range w {
		specs[i] = window.spec
	}
	return specs
}

// openAt reports whether the clock on the wall shows a time inside the window,
// given the day of the week and the minute of the day it shows.
func (w UpdateWindow) openAt(day time.Weekday, minute int) bool {
	if w.start < w.end {
		return w.days[day] && minute >= w.start && minute < w.end
	}
	// The window crosses midnight and belongs to the day it starts: the evening
	// of a day that is in it, and the morning after.
	return w.days[day] && minute >= w.start || w.days[(day+6)%7] && minute < w.end
}

// OpenAt reports whether t is inside a window, or there are none. A window that
// doesn't say UTC reads t on the clock of t's own location: pass time.Now(),
// which is in the host's zone, and a test passes a time in the zone it wants.
func (w UpdateWindows) OpenAt(t time.Time) bool {
	if len(w) == 0 {
		return true
	}
	utc := t.UTC()
	for _, window := range w {
		clock := t
		if window.utc {
			clock = utc
		}
		if window.openAt(clock.Weekday(), clock.Hour()*60+clock.Minute()) {
			return true
		}
	}
	return false
}

// NextStart is the first moment after t when the host becomes open: the start
// of the window that comes next, in t's location. It is false when there are no
// windows (the host is always open) and when they leave no gap in the next week.
// Where windows touch or overlap, the start is the start of the whole stretch.
func (w UpdateWindows) NextStart(t time.Time) (time.Time, bool) {
	if len(w) == 0 {
		return time.Time{}, false
	}
	// A window opens and closes on a whole minute of its clock, which is a whole
	// minute of absolute time in every zone in use, so the search steps by minutes.
	cursor := t.Truncate(time.Minute)
	open := w.OpenAt(cursor)
	for i := 0; i < updateWindowHorizon; i++ {
		next := cursor.Add(time.Minute)
		nextOpen := w.OpenAt(next)
		if nextOpen && !open {
			return next, true
		}
		cursor, open = next, nextOpen
	}
	return time.Time{}, false
}
