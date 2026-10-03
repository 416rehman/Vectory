//go:build darwin

package agent

import (
	"fmt"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// currentBootSession names this boot of the Mac. kern.bootsessionuuid is a UUID the kernel
// makes at each boot. Where the system doesn't give it, the time the Mac booted at
// (kern.boottime) stands in, and where it gives neither the answer is "" and the record of a
// job told to leave is judged by its age alone. Each is prefixed with what it is, so that two
// sessions are compared only with one of their own kind (sameBoot).
func currentBootSession() string {
	if id, err := unix.Sysctl("kern.bootsessionuuid"); err == nil {
		if id = strings.TrimSpace(id); id != "" {
			return "uuid:" + id
		}
	}
	if booted, err := unix.SysctlTimeval("kern.boottime"); err == nil {
		return fmt.Sprintf("boottime:%d", booted.Sec)
	}
	return ""
}

// currentUptime is how long the Mac has been awake. CLOCK_UPTIME_RAW is mach_absolute_time,
// which doesn't advance while the Mac sleeps, so a record's age isn't spent by a night with the
// lid shut, and never runs ahead of launchd's removal, whether its timers stand still while the
// Mac sleeps or not.
func currentUptime() (time.Duration, bool) {
	var now unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_UPTIME_RAW, &now); err != nil {
		return 0, false
	}
	return time.Duration(now.Nano()), true
}
