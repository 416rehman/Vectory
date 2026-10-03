package agent

import (
	"slices"
	"strings"
	"testing"
	"time"
	// The zones the daylight-saving tests use come with the test binary, so they
	// load on every machine and the binary that ships carries none of them.
	_ "time/tzdata"
)

func zone(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

func utcAt(t *testing.T, text string) time.Time {
	t.Helper()
	instant, err := time.Parse(time.RFC3339, text)
	if err != nil {
		t.Fatal(err)
	}
	return instant
}

// localAt reads a wall-clock time in a zone, for times that exist once there.
func localAt(t *testing.T, loc *time.Location, text string) time.Time {
	t.Helper()
	instant, err := time.ParseInLocation("2006-01-02T15:04:05", text, loc)
	if err != nil {
		t.Fatal(err)
	}
	return instant
}

func mustWindows(t *testing.T, specs ...string) UpdateWindows {
	t.Helper()
	windows, err := ParseUpdateWindows(specs)
	if err != nil {
		t.Fatal(err)
	}
	return windows
}

func TestParseUpdateWindowAcceptsTheGrammar(t *testing.T) {
	week := []time.Weekday{time.Sunday, time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday, time.Saturday}
	for _, tc := range []struct {
		spec       string
		days       []time.Weekday
		start, end int
		utc        bool
	}{
		{"daily 01:00-03:00 UTC", week, 60, 180, true},
		{"Mon-Fri 02:00-04:00", []time.Weekday{time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday}, 120, 240, false},
		{"Sat,Sun 00:00-06:00", []time.Weekday{time.Saturday, time.Sunday}, 0, 360, false},
		{"Sun,Sat 10:00-11:00", []time.Weekday{time.Saturday, time.Sunday}, 600, 660, false},
		{"Sat-Mon 22:00-02:00", []time.Weekday{time.Saturday, time.Sunday, time.Monday}, 1320, 120, false},
		{"Sun-Sat 00:00-23:59", week, 0, 1439, false},
		{"Wed-Tue 03:00-04:00 UTC", week, 180, 240, true},
		{"Mon 23:59-00:00", []time.Weekday{time.Monday}, 1439, 0, false},
		{"Mon,Tue,Wed,Thu,Fri,Sat,Sun 02:00-04:00", week, 120, 240, false},
	} {
		window, err := ParseUpdateWindow(tc.spec)
		if err != nil {
			t.Errorf("%q: %v", tc.spec, err)
			continue
		}
		var days []time.Weekday
		for day, in := range window.days {
			if in {
				days = append(days, time.Weekday(day))
			}
		}
		slices.Sort(tc.days)
		if !slices.Equal(days, tc.days) || window.start != tc.start || window.end != tc.end || window.utc != tc.utc || window.String() != tc.spec {
			t.Errorf("%q parsed as days %v, %d-%d, utc %v", tc.spec, days, window.start, window.end, window.utc)
		}
	}
}

func TestParseUpdateWindowRefusesAnythingElse(t *testing.T) {
	for _, tc := range []struct{ spec, why string }{
		{"", "needs days, then times"},
		{" Mon 02:00-04:00", "needs days, then times"},
		{"Mon  02:00-04:00", "needs days, then times"},
		{"Mon 02:00-04:00 ", "needs days, then times"},
		{"Mon 02:00-04:00 UTC extra", "needs days, then times"},
		{"Mon", "needs days, then times"},
		{"Mon\t02:00-04:00", "printable ASCII"},
		{"Mon 02:00–04:00", "printable ASCII"},
		{"mon 02:00-04:00", `"mon" isn't a day`},
		{"Monday 02:00-04:00", `"Monday" isn't a day`},
		{"MON-FRI 02:00-04:00", `"MON" isn't a day`},
		{"Mon-Fry 02:00-04:00", `"Fry" isn't a day`},
		{"Mon-Mon 02:00-04:00", "write one day as Mon, not Mon-Mon"},
		{"Mon-Wed,Fri 02:00-04:00", "write a range and a list as separate windows"},
		{"Mon,Mon 02:00-04:00", "Mon is listed twice"},
		{"Mon, 02:00-04:00", `"" isn't a day`},
		{",Mon 02:00-04:00", `"" isn't a day`},
		{"Mon- 02:00-04:00", `"" isn't a day`},
		{"-Mon 02:00-04:00", `"" isn't a day`},
		{"daily,Mon 02:00-04:00", `"daily" isn't a day`},
		{"weekdays 02:00-04:00", `"weekdays" isn't a day`},
		{"Mon-Fri 2:00-4:00", "HH:MM-HH:MM"},
		{"Mon-Fri 02:00-04:0", "HH:MM-HH:MM"},
		{"Mon-Fri 02:00", "HH:MM-HH:MM"},
		{"Mon-Fri 0a:00-04:00", "HH:MM-HH:MM"},
		{"Mon-Fri 02.00-04.00", "HH:MM-HH:MM"},
		{"Mon-Fri 02:00 04:00", "only UTC, in capitals"},
		{"Mon-Fri 02:00-02:00", "can't end when it starts"},
		{"Mon-Fri 24:00-02:00", "hours run from 00 to 23"},
		{"Mon-Fri 02:00-24:00", "hours run from 00 to 23"},
		{"Mon-Fri 02:60-03:00", "minutes from 00 to 59"},
		{"Mon-Fri 02:00-04:00 utc", "only UTC, in capitals"},
		{"Mon-Fri 02:00-04:00 Z", "only UTC, in capitals"},
		{"Mon-Fri 02:00-04:00 GMT", "only UTC, in capitals"},
		{"Mon,Tue,Wed,Thu,Fri,Sat,Sun 02:00-04:00 UTC", "longer than 40 characters"},
		{strings.Repeat("a", 41), "longer than 40 characters"},
	} {
		_, err := ParseUpdateWindow(tc.spec)
		if err == nil || !IsInputError(err) || !strings.Contains(err.Error(), tc.why) {
			t.Errorf("%q: %v, want an input error that says %q", tc.spec, err, tc.why)
		}
	}
	// An error says how to write one.
	_, err := ParseUpdateWindow("Mon-Fri 2:00-4:00")
	if err == nil || !strings.Contains(err.Error(), "'Mon-Fri 02:00-04:00' or 'daily 01:00-03:00 UTC'") {
		t.Errorf("the example is missing from %v", err)
	}
}

func TestAHostTakesAtMostSevenWindows(t *testing.T) {
	seven := []string{"Mon 01:00-02:00", "Tue 01:00-02:00", "Wed 01:00-02:00", "Thu 01:00-02:00", "Fri 01:00-02:00", "Sat 01:00-02:00", "Sun 01:00-02:00"}
	windows, err := ParseUpdateWindows(seven)
	if err != nil || len(windows) != 7 || !slices.Equal(windows.Specs(), seven) {
		t.Fatalf("seven windows: %v, %v", windows, err)
	}
	if _, err := ParseUpdateWindows(append(seven, "daily 03:00-04:00")); err == nil || !IsInputError(err) || !strings.Contains(err.Error(), "at most 7") {
		t.Errorf("eight windows: %v", err)
	}
	if _, err := ParseUpdateWindows([]string{"Mon 01:00-02:00", "nonsense"}); err == nil {
		t.Error("a window that doesn't parse was accepted")
	}
	none, err := ParseUpdateWindows(nil)
	if err != nil || len(none) != 0 || !none.OpenAt(time.Now()) {
		t.Errorf("no windows: %v, %v", none, err)
	}
	if _, ok := none.NextStart(time.Now()); ok {
		t.Error("a host with no windows has a next start")
	}
}

func TestAWindowIsOpenFromItsStartToItsEnd(t *testing.T) {
	berlin := zone(t, "Europe/Berlin")
	weekdays := mustWindows(t, "Mon-Fri 02:00-04:00")
	for _, tc := range []struct {
		at   string
		want bool
	}{
		{"2026-10-05T01:59:59", false}, // Monday
		{"2026-10-05T02:00:00", true},
		{"2026-10-05T02:00:01", true},
		{"2026-10-05T03:59:59", true},
		{"2026-10-05T04:00:00", false},
		{"2026-10-09T03:00:00", true},  // Friday
		{"2026-10-10T03:00:00", false}, // Saturday
		{"2026-10-11T03:00:00", false}, // Sunday
		{"2026-10-04T03:00:00", false}, // the Sunday before
	} {
		if got := weekdays.OpenAt(localAt(t, berlin, tc.at)); got != tc.want {
			t.Errorf("Berlin %s: %v, want %v", tc.at, got, tc.want)
		}
	}
}

func TestAUTCWindowIgnoresTheZoneOfTheTimeItIsAsked(t *testing.T) {
	windows := mustWindows(t, "daily 02:00-03:00 UTC")
	for _, name := range []string{"UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata"} {
		loc := zone(t, name)
		for _, tc := range []struct {
			at   string
			want bool
		}{
			{"2026-10-05T01:59:59Z", false},
			{"2026-10-05T02:00:00Z", true},
			{"2026-10-05T02:59:59Z", true},
			{"2026-10-05T03:00:00Z", false},
		} {
			if got := windows.OpenAt(utcAt(t, tc.at).In(loc)); got != tc.want {
				t.Errorf("%s at %s: %v, want %v", name, tc.at, got, tc.want)
			}
		}
	}
	// A window with no UTC reads the clock of the zone it is asked in.
	local := mustWindows(t, "daily 02:00-03:00")
	instant := utcAt(t, "2026-10-05T02:30:00Z")
	if !local.OpenAt(instant.In(zone(t, "UTC"))) || local.OpenAt(instant.In(zone(t, "Europe/Berlin"))) {
		t.Error("a local window didn't read the clock of the zone it was asked in")
	}
}

func TestAWindowThatEndsBeforeItStartsCrossesMidnightAndBelongsToTheDayItStarts(t *testing.T) {
	utc := zone(t, "UTC")
	friday := mustWindows(t, "Fri 22:00-02:00")
	for _, tc := range []struct {
		at   string
		want bool
	}{
		{"2026-10-09T21:59:00", false}, // Friday
		{"2026-10-09T22:00:00", true},
		{"2026-10-09T23:59:59", true},
		{"2026-10-10T00:00:00", true}, // Saturday morning
		{"2026-10-10T01:59:59", true},
		{"2026-10-10T02:00:00", false},
		{"2026-10-10T22:30:00", false}, // Saturday evening: not a Friday
		{"2026-10-09T01:00:00", false}, // Friday morning belongs to Thursday
		{"2026-10-08T23:00:00", false}, // Thursday evening
	} {
		if got := friday.OpenAt(localAt(t, utc, tc.at)); got != tc.want {
			t.Errorf("Fri 22:00-02:00 at %s: %v, want %v", tc.at, got, tc.want)
		}
	}
	weekend := mustWindows(t, "Sat-Mon 22:00-02:00")
	for _, tc := range []struct {
		at   string
		want bool
	}{
		{"2026-10-11T23:00:00", true},  // Sunday evening
		{"2026-10-12T01:00:00", true},  // Monday morning, from Sunday
		{"2026-10-12T23:00:00", true},  // Monday evening
		{"2026-10-13T01:00:00", true},  // Tuesday morning, from Monday
		{"2026-10-13T02:00:00", false}, // the window ended
		{"2026-10-14T01:00:00", false}, // Wednesday morning: Tuesday isn't in it
		{"2026-10-09T23:00:00", false}, // Friday evening
		{"2026-10-10T01:00:00", false}, // Saturday morning: Friday isn't in it
		{"2026-10-10T22:00:00", true},  // Saturday evening
	} {
		if got := weekend.OpenAt(localAt(t, utc, tc.at)); got != tc.want {
			t.Errorf("Sat-Mon 22:00-02:00 at %s: %v, want %v", tc.at, got, tc.want)
		}
	}
}

func TestAnyWindowOfTheListOpensTheHost(t *testing.T) {
	utc := zone(t, "UTC")
	windows := mustWindows(t, "Mon 02:00-03:00", "Wed 14:00-15:00", "daily 23:00-23:30 UTC")
	for at, want := range map[string]bool{
		"2026-10-05T02:30:00": true,  // Monday
		"2026-10-07T14:30:00": true,  // Wednesday
		"2026-10-06T23:10:00": true,  // the UTC window
		"2026-10-06T02:30:00": false, // Tuesday
		"2026-10-07T02:30:00": false,
	} {
		if got := windows.OpenAt(localAt(t, utc, at)); got != want {
			t.Errorf("%s: %v, want %v", at, got, want)
		}
	}
}

func TestNextStartIsTheNextTimeTheHostBecomesOpen(t *testing.T) {
	utc := zone(t, "UTC")
	weekdays := mustWindows(t, "Mon-Fri 02:00-04:00")
	for _, tc := range []struct{ from, want string }{
		{"2026-10-05T05:00:00", "2026-10-06T02:00:00"}, // Monday after the window
		{"2026-10-05T01:00:00", "2026-10-05T02:00:00"}, // Monday before it
		{"2026-10-05T02:00:00", "2026-10-06T02:00:00"}, // exactly at its start: it is open, so the next one
		{"2026-10-05T03:00:00", "2026-10-06T02:00:00"}, // inside it
		{"2026-10-05T01:59:59", "2026-10-05T02:00:00"},
		{"2026-10-09T05:00:00", "2026-10-12T02:00:00"}, // Friday after the window: Monday
		{"2026-10-10T12:00:00", "2026-10-12T02:00:00"}, // Saturday
	} {
		got, ok := weekdays.NextStart(localAt(t, utc, tc.from))
		if !ok || !got.Equal(localAt(t, utc, tc.want)) {
			t.Errorf("from %s: %v, %v; want %s", tc.from, got, ok, tc.want)
		}
	}
	// The answer is in the zone of the time asked.
	berlin := zone(t, "Europe/Berlin")
	got, _ := weekdays.NextStart(localAt(t, berlin, "2026-10-05T05:00:00"))
	if got.Location() != berlin || got.Format("2006-01-02T15:04:05") != "2026-10-06T02:00:00" {
		t.Errorf("in Berlin: %v", got)
	}
	// A UTC window's start is a UTC time, shown in the zone asked.
	utcWindow := mustWindows(t, "daily 02:00-03:00 UTC")
	got, _ = utcWindow.NextStart(localAt(t, berlin, "2026-10-05T10:00:00"))
	if want := utcAt(t, "2026-10-06T02:00:00Z"); !got.Equal(want) || got.Location() != berlin {
		t.Errorf("a UTC window seen from Berlin: %v, want %v", got, want)
	}
}

func TestNextStartMergesWindowsThatTouchOrOverlap(t *testing.T) {
	utc := zone(t, "UTC")
	touching := mustWindows(t, "daily 02:00-04:00", "daily 04:00-06:00")
	got, ok := touching.NextStart(localAt(t, utc, "2026-10-05T03:00:00"))
	if !ok || !got.Equal(localAt(t, utc, "2026-10-06T02:00:00")) {
		t.Errorf("windows that touch, from inside the first: %v, %v", got, ok)
	}
	got, ok = touching.NextStart(localAt(t, utc, "2026-10-05T01:00:00"))
	if !ok || !got.Equal(localAt(t, utc, "2026-10-05T02:00:00")) {
		t.Errorf("windows that touch, from before: %v, %v", got, ok)
	}
	overlapping := mustWindows(t, "daily 02:00-05:00", "daily 04:00-07:00")
	got, ok = overlapping.NextStart(localAt(t, utc, "2026-10-05T04:30:00"))
	if !ok || !got.Equal(localAt(t, utc, "2026-10-06T02:00:00")) {
		t.Errorf("windows that overlap: %v, %v", got, ok)
	}
	// A host that is open all the time never becomes open.
	always := mustWindows(t, "daily 00:00-12:00", "daily 12:00-00:00")
	if _, ok := always.NextStart(localAt(t, utc, "2026-10-05T03:00:00")); ok {
		t.Error("a host open at every minute has a next start")
	}
	// A gap of one minute is a gap.
	almost := mustWindows(t, "daily 00:00-23:59")
	got, ok = almost.NextStart(localAt(t, utc, "2026-10-05T23:59:30"))
	if !ok || !got.Equal(localAt(t, utc, "2026-10-06T00:00:00")) {
		t.Errorf("a gap of a minute: %v, %v", got, ok)
	}
}

func TestWindowsFollowTheSpringForwardInBerlin(t *testing.T) {
	berlin := zone(t, "Europe/Berlin")
	// On 29 March 2026 the clock goes from 02:00 CET to 03:00 CEST, at 01:00 UTC.
	late := mustWindows(t, "daily 02:30-04:00")
	for _, tc := range []struct {
		at   string
		want bool
	}{
		{"2026-03-29T00:30:00Z", false}, // 01:30 CET
		{"2026-03-29T00:59:59Z", false}, // 01:59:59 CET
		{"2026-03-29T01:00:00Z", true},  // 03:00 CEST: the clock skipped past 02:30
		{"2026-03-29T01:59:59Z", true},  // 03:59:59 CEST
		{"2026-03-29T02:00:00Z", false}, // 04:00 CEST
		{"2026-03-30T00:30:00Z", true},  // the next day, 02:30 CEST
	} {
		if got := late.OpenAt(utcAt(t, tc.at).In(berlin)); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.at, got, tc.want)
		}
	}
	got, ok := late.NextStart(utcAt(t, "2026-03-28T12:00:00Z").In(berlin))
	if want := utcAt(t, "2026-03-29T01:00:00Z"); !ok || !got.Equal(want) {
		t.Errorf("the next start on the skipped night: %v, %v; want %v", got, ok, want)
	}
	// A window that lies entirely in the skipped hour doesn't open that day.
	skipped := mustWindows(t, "daily 02:00-03:00")
	got, ok = skipped.NextStart(utcAt(t, "2026-03-29T00:00:00Z").In(berlin))
	if want := utcAt(t, "2026-03-30T00:00:00Z"); !ok || !got.Equal(want) {
		t.Errorf("a window inside the skipped hour: %v, %v; want %v", got, ok, want)
	}
	for _, at := range []string{"2026-03-29T00:30:00Z", "2026-03-29T01:00:00Z", "2026-03-29T01:30:00Z"} {
		if skipped.OpenAt(utcAt(t, at).In(berlin)) {
			t.Errorf("a window inside the skipped hour was open at %s", at)
		}
	}
}

func TestWindowsFollowTheFallBackInBerlin(t *testing.T) {
	berlin := zone(t, "Europe/Berlin")
	// On 25 October 2026 the clock goes from 03:00 CEST back to 02:00 CET, at
	// 01:00 UTC: the hour from 02:00 to 03:00 is on the clock twice.
	window := mustWindows(t, "daily 02:30-04:00")
	for _, tc := range []struct {
		at   string
		want bool
	}{
		{"2026-10-25T00:29:00Z", false}, // 02:29 CEST
		{"2026-10-25T00:30:00Z", true},  // 02:30 CEST
		{"2026-10-25T00:59:59Z", true},  // 02:59:59 CEST
		{"2026-10-25T01:00:00Z", false}, // 02:00 CET: the clock went back before the window
		{"2026-10-25T01:29:59Z", false},
		{"2026-10-25T01:30:00Z", true}, // 02:30 CET: open again
		{"2026-10-25T02:59:59Z", true}, // 03:59:59 CET
		{"2026-10-25T03:00:00Z", false},
	} {
		if got := window.OpenAt(utcAt(t, tc.at).In(berlin)); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.at, got, tc.want)
		}
	}
	got, ok := window.NextStart(utcAt(t, "2026-10-25T00:45:00Z").In(berlin))
	if want := utcAt(t, "2026-10-25T01:30:00Z"); !ok || !got.Equal(want) {
		t.Errorf("the second opening of the repeated hour: %v, %v; want %v", got, ok, want)
	}
	got, ok = window.NextStart(utcAt(t, "2026-10-24T12:00:00Z").In(berlin))
	if want := utcAt(t, "2026-10-25T00:30:00Z"); !ok || !got.Equal(want) {
		t.Errorf("the first opening: %v, %v; want %v", got, ok, want)
	}
}

func TestWindowsFollowBothChangesInNewYork(t *testing.T) {
	newYork := zone(t, "America/New_York")
	// 8 March 2026: 02:00 EST becomes 03:00 EDT at 07:00 UTC.
	spring := mustWindows(t, "daily 02:30-04:00")
	for at, want := range map[string]bool{
		"2026-03-08T06:59:59Z": false, // 01:59:59 EST
		"2026-03-08T07:00:00Z": true,  // 03:00 EDT
		"2026-03-08T07:59:59Z": true,
		"2026-03-08T08:00:00Z": false, // 04:00 EDT
	} {
		if got := spring.OpenAt(utcAt(t, at).In(newYork)); got != want {
			t.Errorf("spring, %s: %v, want %v", at, got, want)
		}
	}
	if got, ok := spring.NextStart(utcAt(t, "2026-03-07T15:00:00Z").In(newYork)); !ok || !got.Equal(utcAt(t, "2026-03-08T07:00:00Z")) {
		t.Errorf("spring next start: %v, %v", got, ok)
	}
	// 1 November 2026: 02:00 EDT becomes 01:00 EST at 06:00 UTC.
	fall := mustWindows(t, "daily 01:30-03:30")
	for at, want := range map[string]bool{
		"2026-11-01T05:29:59Z": false, // 01:29:59 EDT
		"2026-11-01T05:30:00Z": true,  // 01:30 EDT
		"2026-11-01T05:59:59Z": true,  // 01:59:59 EDT
		"2026-11-01T06:00:00Z": false, // 01:00 EST: back before the window
		"2026-11-01T06:29:59Z": false,
		"2026-11-01T06:30:00Z": true,  // 01:30 EST
		"2026-11-01T08:29:59Z": true,  // 03:29:59 EST
		"2026-11-01T08:30:00Z": false, // 03:30 EST
	} {
		if got := fall.OpenAt(utcAt(t, at).In(newYork)); got != want {
			t.Errorf("fall, %s: %v, want %v", at, got, want)
		}
	}
	if got, ok := fall.NextStart(utcAt(t, "2026-11-01T05:45:00Z").In(newYork)); !ok || !got.Equal(utcAt(t, "2026-11-01T06:30:00Z")) {
		t.Errorf("fall next start: %v, %v", got, ok)
	}
}

func TestAWindowCrossingMidnightFollowsAChangeInsideIt(t *testing.T) {
	berlin := zone(t, "Europe/Berlin")
	// Sat 22:00-04:00 holds the night the clock goes forward (Sunday 29 March).
	window := mustWindows(t, "Sat 22:00-04:00")
	for at, want := range map[string]bool{
		"2026-03-28T20:59:59Z": false, // 21:59:59 CET
		"2026-03-28T21:00:00Z": true,  // 22:00 CET
		"2026-03-29T00:59:59Z": true,  // 01:59:59 CET
		"2026-03-29T01:00:00Z": true,  // 03:00 CEST
		"2026-03-29T01:59:59Z": true,  // 03:59:59 CEST
		"2026-03-29T02:00:00Z": false, // 04:00 CEST
	} {
		if got := window.OpenAt(utcAt(t, at).In(berlin)); got != want {
			t.Errorf("%s: %v, want %v", at, got, want)
		}
	}
}

func TestWindowsInAZoneWithAHalfHourOffset(t *testing.T) {
	kolkata := zone(t, "Asia/Kolkata")
	window := mustWindows(t, "daily 02:00-04:00")
	for at, want := range map[string]bool{
		"2026-10-04T20:29:59Z": false, // 01:59:59 IST
		"2026-10-04T20:30:00Z": true,  // 02:00 IST
		"2026-10-04T22:29:59Z": true,
		"2026-10-04T22:30:00Z": false,
	} {
		if got := window.OpenAt(utcAt(t, at).In(kolkata)); got != want {
			t.Errorf("%s: %v, want %v", at, got, want)
		}
	}
	if got, ok := window.NextStart(utcAt(t, "2026-10-04T23:00:00Z").In(kolkata)); !ok || !got.Equal(utcAt(t, "2026-10-05T20:30:00Z")) {
		t.Errorf("next start: %v, %v", got, ok)
	}
}

// referenceOpen decides the same question another way: by date arithmetic on
// the clock on the wall, with no weekday or minute-of-day bookkeeping.
func referenceOpen(window UpdateWindow, at time.Time) bool {
	if window.utc {
		at = at.UTC()
	}
	wall := time.Date(at.Year(), at.Month(), at.Day(), at.Hour(), at.Minute(), 0, 0, time.UTC)
	length := time.Duration((window.end-window.start+1440)%1440) * time.Minute
	for back := 0; back <= 1; back++ {
		startDay := wall.AddDate(0, 0, -back)
		if !window.days[startDay.Weekday()] {
			continue
		}
		start := time.Date(startDay.Year(), startDay.Month(), startDay.Day(), window.start/60, window.start%60, 0, 0, time.UTC)
		if !wall.Before(start) && wall.Before(start.Add(length)) {
			return true
		}
	}
	return false
}

func TestOpenAtAgreesWithAReferenceInEveryMinuteAroundEveryChangeInEveryZone(t *testing.T) {
	specs := []string{
		"daily 02:00-04:00", "Mon-Fri 02:30-03:30", "Sat,Sun 00:00-06:00", "Fri 22:00-02:00", "Sat-Mon 23:30-01:15 UTC",
		"daily 01:30-03:30", "daily 23:00-00:30", "Sun 02:00-03:00", "Wed-Tue 12:00-12:01", "daily 02:00-03:00 UTC",
	}
	// Four days around each change of the clock in the four zones that have one
	// (New York in March, Berlin in March, Lord Howe, which moves by half an
	// hour, in April and October, Berlin and New York in the autumn), and an
	// ordinary week.
	spans := []struct {
		from string
		days int
	}{
		{"2026-03-06T00:00:00Z", 4}, {"2026-03-27T00:00:00Z", 4}, {"2026-04-03T00:00:00Z", 4}, {"2026-10-02T00:00:00Z", 4},
		{"2026-10-23T00:00:00Z", 4}, {"2026-10-30T00:00:00Z", 4}, {"2026-05-04T00:00:00Z", 7},
	}
	for _, name := range []string{"UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"} {
		loc := zone(t, name)
		for _, span := range spans {
			start := utcAt(t, span.from)
			for _, spec := range specs {
				windows := mustWindows(t, spec)
				for i := 0; i < span.days*24*60; i++ {
					at := start.Add(time.Duration(i) * time.Minute).In(loc)
					if got, want := windows.OpenAt(at), referenceOpen(windows[0], at); got != want {
						t.Fatalf("%s %q at %s: OpenAt %v, reference %v", name, spec, at, got, want)
					}
				}
			}
		}
	}
}

func TestNextStartIsTheFirstMomentTheHostOpensAfterTheTimeAsked(t *testing.T) {
	groups := [][]string{
		{"daily 02:00-04:00"}, {"Mon-Fri 02:30-03:30"}, {"Fri 22:00-02:00"}, {"Sat-Mon 23:30-01:15 UTC"},
		{"Mon 02:00-03:00", "Thu 14:00-15:00"}, {"daily 01:30-03:30", "daily 03:30-05:00"}, {"Sun 02:00-03:00"},
	}
	const span = 17 * 24 * 60
	minutes := func(n int) time.Duration { return time.Duration(n) * time.Minute }
	for _, name := range []string{"UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata"} {
		loc := zone(t, name)
		// 17 days from the 25th of March: the changes of the clock in Berlin and
		// New York are inside them.
		start := utcAt(t, "2026-03-25T00:00:00Z")
		for _, group := range groups {
			windows := mustWindows(t, group...)
			// Whether the host is open at every minute, and a week beyond.
			open := make([]bool, span+updateWindowHorizon+1)
			for i := range open {
				open[i] = windows.OpenAt(start.Add(minutes(i)).In(loc))
			}
			for i := 1; i < span; i += 101 {
				at := start.Add(minutes(i)).In(loc)
				if i%2 == 1 {
					at = at.Add(37 * time.Second) // a time that isn't on a minute
				}
				want := -1
				for j := i + 1; j < len(open); j++ {
					if open[j] && !open[j-1] {
						want = j
						break
					}
				}
				next, ok := windows.NextStart(at)
				switch {
				case want < 0 && ok:
					t.Fatalf("%s %v at %s: next start %s, but the host doesn't open", name, group, at, next)
				case want >= 0 && (!ok || !next.Equal(start.Add(minutes(want)))):
					t.Fatalf("%s %v at %s: next start %v, %v; want %s", name, group, at, next, ok, start.Add(minutes(want)).In(loc))
				}
			}
		}
	}
}
