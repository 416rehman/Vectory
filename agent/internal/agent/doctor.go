package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// DoctorCheck is one line of the doctor checklist.
type DoctorCheck struct {
	ID     string `json:"id"`
	Status string `json:"status"` // ok, info, warn or fail
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Fix    string `json:"fix,omitempty"`
}

// DoctorReport is the checklist plus the established machine-readable fields.
type DoctorReport struct {
	StateDir  string
	Name      string
	Checks    []DoctorCheck
	legacy    map[string]any
	legacyErr error
}

// Failed reports whether any check failed.
func (r *DoctorReport) Failed() bool {
	for _, check := range r.Checks {
		if check.Status == "fail" {
			return true
		}
	}
	return false
}

func (r *DoctorReport) add(id, status, title, detail, fix string) {
	r.Checks = append(r.Checks, DoctorCheck{ID: id, Status: status, Title: title, Detail: detail, Fix: fix})
}

func (r *DoctorReport) addError(id, title string, err error) {
	if ce, ok := AsConnectionError(err); ok {
		r.add(id, "fail", title, ce.Message, ce.Fix)
		return
	}
	r.add(id, "fail", title, sentence(err.Error()), "")
}

// RunDoctor checks the local installation and the connection to the server.
// It never changes local state, and it sends no heartbeat.
func RunDoctor(ctx context.Context, dir string) (*DoctorReport, error) {
	if err := CheckInstalled(dir); err != nil {
		return nil, err
	}
	report := &DoctorReport{StateDir: dir}
	report.legacy, report.legacyErr = Doctor(ctx, dir)
	s, err := LoadSettings(dir)
	if err != nil {
		return nil, err
	}
	st, stateErr := LoadState(dir)
	report.Name = s.Name
	now := time.Now()

	if info, err := os.Stat(dir); err == nil {
		detail := fmt.Sprintf("%s (%04o%s)", dir, info.Mode().Perm(), ownerSuffix(info))
		if info.Mode().Perm()&0077 != 0 {
			report.add("state", "warn", "State directory", detail+" is readable by other accounts", "Restrict it: chmod 700 "+quoteArg(dir))
		} else {
			report.add("state", "ok", "State directory", detail, "")
		}
	}

	switch {
	case report.legacy != nil && report.legacy["binary_integrity"] == false:
		report.add("vector", "fail", "Vector", "The adopted binary at "+s.VectorBinary+" changed or is missing since adoption.", "Restore it, or stop the agent and approve the new binary: vectory re-adopt --expected-sha256 SHA256")
	case report.legacyErr != nil && report.legacy != nil && report.legacy["vector_version"] == "":
		report.add("vector", "fail", "Vector", "Vector at "+s.VectorBinary+" didn't report a "+VectorSeries+" version.", "Install Vector "+VectorSeries+" (https://vector.dev/download/), then approve it with vectory re-adopt.")
	default:
		report.add("vector", "ok", "Vector", s.adoptedVectorVersion()+" at "+s.VectorBinary+" (adopted binary unchanged)", "")
	}

	if err := SafePath(s.ManagedConfig); err != nil {
		report.add("managed", "fail", "Managed config", s.ManagedConfig+": "+err.Error()+".", "Use a real directory for the managed configuration.")
	} else if info, err := os.Stat(s.ManagedConfig); err == nil {
		report.add("managed", "ok", "Managed config", fmt.Sprintf("%s (%s)", s.ManagedConfig, byteSize(info.Size())), "")
	} else {
		report.add("managed", "ok", "Managed config", s.ManagedConfig+" (no workload yet)", "")
	}

	mode := s.CapabilityPolicy.ConfigurationMode()
	allowances := ""
	if mode == "restricted" {
		p := s.CapabilityPolicy
		allowances = fmt.Sprintf(" · %d file roots, %d destinations, %d listeners approved", len(p.AllowedFileRoots), len(p.AllowedNetworkHosts), len(p.AllowedListenAddresses))
	}
	report.add("mode", "ok", "Mode", mode+allowances, "")

	cred, key, identityErr := ReadIdentity(dir)
	enrolled := identityErr == nil && cred.DeviceID != ""
	server, caFile := s.Server, s.CAFile
	if enrolled {
		days := int(math.Floor(cred.CertificateExpiresAt.Sub(now).Hours() / 24))
		id := cred.DeviceID
		if len(id) > 8 {
			id = id[:8]
		}
		switch {
		case !now.Before(cred.CertificateExpiresAt):
			report.add("identity", "fail", "Identity", fmt.Sprintf("device %s · credential expired on %s", id, cred.CertificateExpiresAt.Local().Format("Jan 2 2006")), "An administrator can authorize recovery from the device page; then run vectory recover-enrollment.")
		case cred.CertificateExpiresAt.Sub(now) < 72*time.Hour:
			report.add("identity", "warn", "Identity", fmt.Sprintf("device %s · credential expires %s", id, cred.CertificateExpiresAt.Local().Format("Jan 2 15:04")), "It renews automatically while the agent runs and reaches the server.")
		default:
			report.add("identity", "ok", "Identity", fmt.Sprintf("device %s · credential valid until %s (%d days)", id, cred.CertificateExpiresAt.Local().Format("Jan 2 2006"), days), "")
		}
	} else if pending, _ := ReadPendingEnrollment(dir); pending != nil {
		server = pending.Server
		switch pending.Delivery {
		case "refused":
			report.add("identity", "fail", "Identity", "Not enrolled: the server refused the last attempt as "+pending.Name+".", "An administrator can see why on the Add device page. Fix it, then run setup again; a new token is fine.")
		case "no":
			report.add("identity", "fail", "Identity", "Not enrolled: the last attempt never reached the server ("+strings.ToLower(strings.ReplaceAll(pending.LastFailure, "_", " "))+").", "Fix the connection problem below, then run the command again.")
		default:
			report.add("identity", "fail", "Identity", "Not enrolled: the last attempt as "+pending.Name+" wasn't confirmed.", "Run the same command again with --name "+pending.Name+" (a new token is fine).")
		}
	} else {
		report.add("identity", "fail", "Identity", "Not enrolled.", "Copy the command from Add device in the dashboard.")
	}

	if server != "" {
		var credentials *Credentials
		if enrolled {
			credentials = &cred
		}
		var lastAnswered *time.Time
		if enrolled && stateErr == nil {
			lastAnswered = st.LastHeartbeat
		}
		report.Checks = append(report.Checks, networkChecks(ctx, server, caFile, credentials, key, lastAnswered)...)
	}

	svc := ServiceStatus(ctx)
	if svc.StateDir != "" && filepath.Clean(svc.StateDir) != filepath.Clean(dir) {
		svc = ServiceInfo{Manager: svc.Manager, Name: svc.Name}
	}
	foreground := !svc.Running() && agentLockHeld(dir)
	switch {
	case svc.Running():
		report.add("service", "ok", "Service", svc.Name+" running", "")
	case svc.Installed:
		// Only systemd keeps the agent's output; see serviceCheckHint.
		service := map[string]string{"systemd": "systemd", "launchd": "launchd", "Windows services": "windows"}[svc.Manager]
		fix := "Start it: " + adminCommand(service, "vectory service-start") + "."
		if service == "systemd" {
			fix += " Its log: journalctl -u vectory.service -n 50"
		}
		report.add("service", "fail", "Service", svc.Name+" is "+firstNonEmpty(svc.State, "stopped")+".", fix)
	case foreground:
		report.add("service", "ok", "Service", "none · the agent is running in the foreground", "")
	case svc.Manager == "":
		report.add("service", "warn", "Service", "Not registered, and no service manager was detected.", "Run the agent under your supervisor: vectory run --state-dir "+quoteArg(dir))
	default:
		report.add("service", "warn", "Service", "Not registered, and the agent isn't running.", "Register and start it: sudo vectory setup (or vectory service-install and service-start).")
	}

	if enrolled && stateErr == nil {
		limit := 3 * time.Duration(max(st.Policy.HeartbeatSeconds, 10)) * time.Second
		switch {
		case st.LastHeartbeat == nil:
			report.add("checkin", "warn", "Check-in", "No check-in recorded yet.", "Start the agent; it checks in immediately.")
		case now.Sub(*st.LastHeartbeat) > limit:
			report.add("checkin", "warn", "Check-in", "Last check-in "+ago(now, *st.LastHeartbeat)+".", "Start the agent, and fix any connection problem above.")
		default:
			report.add("checkin", "ok", "Check-in", "last check-in "+ago(now, *st.LastHeartbeat), "")
		}
		if LocalPaused(dir) {
			report.add("pause", "warn", "Sync", "Paused on this host.", "Resume when ready: sudo vectory resume --state-dir "+quoteArg(dir))
		}
		if st.Error != nil {
			status := "warn"
			if st.ApplyState == "failed" || st.ApplyState == "rolled_back" {
				status = "fail"
			}
			report.add("apply", status, "Last apply", fmt.Sprintf("%s during %s: %s", st.Error.Code, st.Error.Stage, st.Error.Message), applyNextAction(st))
			for _, problem := range problemRows(st.Error.Diagnostics) {
				report.add("apply", "info", "Problem", problem.Message, problem.Hint)
			}
		}
	}
	return report, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" && v != "dead" {
			return v
		}
	}
	return ""
}

func byteSize(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d bytes", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1f MB", float64(n)/1024/1024)
	}
}

// networkChecks runs DNS, TCP, TLS, clock and credential checks. It sends one
// read-only request; with credentials it proves the server still accepts them.
func networkChecks(ctx context.Context, server, caFile string, credentials *Credentials, key []byte, lastAnswered *time.Time) []DoctorCheck {
	var checks []DoctorCheck
	add := func(id, status, title, detail, fix string) {
		checks = append(checks, DoctorCheck{ID: id, Status: status, Title: title, Detail: detail, Fix: fix})
	}
	fail := func(id, title string, err error) {
		if ce, ok := AsConnectionError(err); ok {
			if lastAnswered != nil {
				ce = ce.forKnownServer(*lastAnswered, time.Now())
			}
			add(id, "fail", title, ce.Message, ce.Fix)
		} else {
			add(id, "fail", title, sentence(err.Error()), "")
		}
	}
	origin, err := NormalizeServer(server)
	if err != nil {
		fail("dns", "Server", err)
		return checks
	}
	target, _ := url.Parse(origin)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/agent/v1/identity", nil)
	if err != nil {
		fail("dns", "Server", err)
		return checks
	}
	proxy, _ := http.ProxyFromEnvironment(request)
	if proxy != nil {
		add("proxy", "info", "Proxy", "Connecting through "+proxy.Host+" (HTTPS_PROXY).", "")
	} else {
		host := target.Hostname()
		if net.ParseIP(host) != nil {
			add("dns", "ok", "DNS", host+" is an IP address", "")
		} else {
			lookup, cancel := context.WithTimeout(ctx, 5*time.Second)
			addresses, err := net.DefaultResolver.LookupHost(lookup, host)
			cancel()
			if err != nil {
				fail("dns", "DNS", classifyTransport(target, nil, false, err))
				return checks
			}
			if len(addresses) > 3 {
				addresses = append(addresses[:3], "...")
			}
			add("dns", "ok", "DNS", host+" -> "+strings.Join(addresses, ", "), "")
		}
		started := time.Now()
		connection, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", hostPort(target))
		if err != nil {
			fail("tcp", "TCP", classifyTransport(target, nil, false, err))
			return checks
		}
		add("tcp", "ok", "TCP", connection.RemoteAddr().String()+" reachable ("+humanLatency(time.Since(started))+")", "")
		_ = connection.Close()
	}
	settings := Settings{Server: origin, CAFile: caFile}
	client, err := NewClient(settings, credentials, key)
	if err != nil {
		fail("tls", "TLS", err)
		return checks
	}
	defer client.Close()
	request.Header.Set("User-Agent", "Vectory/"+Version)
	response, err := client.HTTP.Do(request)
	if err != nil {
		fail("tls", "TLS", classifyTransport(target, proxy, false, err))
		return checks
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	verified := "verified"
	if response.TLS != nil {
		verified += " · TLS " + map[uint16]string{0x0304: "1.3", 0x0303: "1.2"}[response.TLS.Version]
		if len(response.TLS.PeerCertificates) > 0 {
			verified += " · issued by " + issuerName(response.TLS.PeerCertificates[0])
		}
	}
	if caFile != "" {
		verified += " · trust file " + caFile
	}
	add("tls", "ok", "TLS", verified, "")
	if date, err := http.ParseTime(response.Header.Get("Date")); err == nil {
		skew := time.Until(date)
		direction := "behind"
		if skew < 0 {
			direction, skew = "ahead of", -skew
		}
		switch {
		case skew <= 30*time.Second:
			add("clock", "ok", "Clock", fmt.Sprintf("within %d s of the server", max(int(skew.Round(time.Second)/time.Second), 1)), "")
		case skew <= 60*time.Second:
			add("clock", "warn", "Clock", "this host is "+humanLatency(skew)+" "+direction+" the server", "Enable time synchronization (for example: sudo timedatectl set-ntp true).")
		default:
			add("clock", "fail", "Clock", "this host is "+humanDuration(skew)+" "+direction+" the server; signed updates are refused beyond 60 s", "Enable time synchronization (for example: sudo timedatectl set-ntp true).")
		}
	}
	if credentials == nil {
		return checks
	}
	switch response.StatusCode {
	case http.StatusOK:
		var identity struct {
			DeviceID string `json:"device_id"`
			Name     string `json:"name"`
		}
		if json.Unmarshal(body, &identity) == nil && identity.DeviceID == credentials.DeviceID {
			add("credential", "ok", "Credential", "accepted by the server as "+safeText(identity.Name, 100), "")
		} else {
			add("credential", "warn", "Credential", "The server answered for a different device.", "Check that --server points to the server this host enrolled with.")
		}
	case http.StatusNotFound:
		add("credential", "info", "Credential", "Not confirmed: this server predates the identity check.", "")
	default:
		ce := classifyStatus(target, "/agent/v1/identity", response.StatusCode, 0, body)
		add("credential", "fail", "Credential", ce.Message, ce.Fix)
	}
	return checks
}

// RenderDoctor is the human checklist.
func RenderDoctor(r *DoctorReport) string {
	var b strings.Builder
	title := "Vectory doctor"
	if r.Name != "" {
		title += " · " + r.Name
	}
	b.WriteString(title + " · " + r.StateDir + "\n\n")
	warnings, failures := 0, 0
	for _, check := range r.Checks {
		fmt.Fprintf(&b, "  %-5s %-16s %s\n", check.Status, check.Title, check.Detail)
		if check.Fix != "" && check.Status != "ok" {
			fmt.Fprintf(&b, "        %-16s Fix: %s\n", "", check.Fix)
		}
		switch check.Status {
		case "warn":
			warnings++
		case "fail":
			failures++
		}
	}
	b.WriteString("\n")
	switch {
	case failures == 0 && warnings == 0:
		b.WriteString("All checks passed.\n")
	case failures == 0:
		b.WriteString(plural(warnings, "warning") + "; nothing is broken.\n")
	default:
		summary := plural(failures, "problem") + " need attention"
		if failures == 1 {
			summary = "1 problem needs attention"
		}
		if warnings > 0 {
			summary += " (" + plural(warnings, "warning") + ")"
		}
		b.WriteString(summary + ".\n")
	}
	return b.String()
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// DoctorJSON keeps the established fields and adds the checklist.
func DoctorJSON(r *DoctorReport) map[string]any {
	out := map[string]any{}
	for k, v := range r.legacy {
		out[k] = v
	}
	out["ok"] = !r.Failed()
	out["checks"] = r.Checks
	out["state_dir"] = r.StateDir
	if r.legacyErr != nil {
		out["error"] = r.legacyErr.Error()
	}
	return out
}
