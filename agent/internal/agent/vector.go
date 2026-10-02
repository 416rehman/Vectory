package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Driver exclusively owns the explicitly adopted Vector child. An arbitrary
// existing Vector process or a healthy HTTP endpoint can never satisfy Alive.
type Driver interface {
	Validate(context.Context, string) error
	// CheckCandidate checks a staged candidate the way Validate does, on request
	// and without applying it (see validation.go). It never starts, reloads or
	// signals Vector.
	CheckCandidate(ctx context.Context, path string, runTests bool) (candidateRun, error)
	Activate(context.Context, string) error
	Alive() bool
	Stop() error
}

// candidateRun is what checking a candidate learned beyond pass or fail: what
// `vector test` printed, which names each test and whether it passed.
type candidateRun struct {
	// TestsRan says `vector test` ran.
	TestsRan   bool
	TestOutput []byte
}

// checkMode says how a configuration is checked. An apply runs the
// configuration's tests whenever it has some; a check on request does only when
// it was asked to, writes nothing to the local Vector log, and leaves the host
// as it found it: a data directory it had to create is removed again.
type checkMode struct {
	tests  bool
	dryRun bool
}

// Activation methods reported on the heartbeat.
const (
	activationReload  = "reload"
	activationRestart = "restart"
)

type VectorDriver struct {
	Settings Settings
	// Dir is the agent state directory: it holds the host runtime overlay and
	// the local Vector log. Empty disables both (tests).
	Dir      string
	Log      *vectorLog
	mu       sync.Mutex
	child    *exec.Cmd
	lifetime io.WriteCloser
	done     chan struct{}
	verified bool
	method   string
}

// limitedWriter keeps at most max bytes of a child's output. Once output
// exceeds the bound it keeps only complete lines: a line cut mid-way could
// carry part of a secret that redaction, which matches whole values, would
// no longer recognize.
type limitedWriter struct {
	b    bytes.Buffer
	max  int
	full bool
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	n := len(p)
	if w.full {
		return n, nil
	}
	if left := w.max - w.b.Len(); len(p) > left {
		w.b.Write(p[:left])
		w.full = true
		w.b.Truncate(bytes.LastIndexByte(w.b.Bytes(), '\n') + 1)
		return n, nil
	}
	w.b.Write(p)
	return n, nil
}
func cleanEnvironment() []string {
	var env []string
	for _, k := range []string{"SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "PATH", "SSL_CERT_FILE", "SSL_CERT_DIR"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}
func vectorEnvironment(full bool) []string {
	if !full {
		return cleanEnvironment()
	}
	// Full mode intentionally exposes the host service environment to Vector's
	// native integrations. Keep launcher configuration and acknowledgment logging
	// under agent control; environment may not add extra managed input files.
	env := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if strings.HasPrefix(key, "VECTOR_CONFIG") || key == "VECTOR_WATCH_CONFIG" || key == "VECTOR_LOG" || key == "VECTOR_LOG_FORMAT" || key == "VECTOR_REQUIRE_HEALTHY" || key == "VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION" || key == "VECTOR_GRACEFUL_SHUTDOWN_LIMIT_SECS" || key == "VECTOR_NO_GRACEFUL_SHUTDOWN_LIMIT" {
			continue
		}
		env = append(env, entry)
	}
	return env
}

// vectorConfigArgs lists the managed configuration and, when present, the
// host runtime overlay. Vector merges the files and rejects conflicts.
func vectorConfigArgs(command string, paths []string, full bool, options ...string) []string {
	args := []string{}
	if command != "" {
		args = append(args, command)
	}
	args = append(args, options...)
	for _, path := range paths {
		if path != "" {
			args = append(args, "--config-json", path)
		}
	}
	if full {
		args = append(args, "--dangerously-allow-env-var-interpolation")
	}
	return args
}
func (d *VectorDriver) checkBinary() error {
	h, e := FileDigest(d.Settings.VectorBinary)
	switch {
	case os.IsNotExist(e):
		return errors.New("the adopted Vector binary " + d.Settings.VectorBinary + " is missing; restore it or stop the agent and use re-adopt with a trusted expected SHA256")
	case os.IsPermission(e):
		return errors.New("the agent's account can't read the adopted Vector binary " + d.Settings.VectorBinary + "; make it and its folders readable for the service account, or install Vector system-wide and use re-adopt")
	case e != nil:
		return errors.New("the agent can't use the adopted Vector binary " + d.Settings.VectorBinary + " (" + e.Error() + "); restore it or stop the agent and use re-adopt with a trusted expected SHA256")
	case h != d.Settings.VectorBinarySHA256:
		return errors.New("adopted Vector binary changed; restore it or stop the agent and use re-adopt with a trusted expected SHA256")
	}
	return nil
}

// nativeOutputLimit bounds the Vector output kept for diagnostics.
const nativeOutputLimit = 16 << 10

func (d *VectorDriver) run(ctx context.Context, command string, paths []string, options ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, d.Settings.VectorBinary, vectorConfigArgs(command, paths, d.Settings.CapabilityPolicy.FullVectorConfig, options...)...)
	// Native providers may start children that inherit output handles. Do
	// not let an inherited pipe extend the validation deadline indefinitely.
	cmd.WaitDelay = time.Second
	cmd.Env = vectorEnvironment(d.Settings.CapabilityPolicy.FullVectorConfig)
	out := &limitedWriter{max: nativeOutputLimit}
	cmd.Stdout = out
	cmd.Stderr = out
	err := cmd.Run()
	return out.b.Bytes(), err
}

func dataDirFailure(path string) *VectorFailure {
	return &VectorFailure{Phase: "prepare", Summary: "The device's Vector data directory could not be prepared", Diagnostics: []Diagnostic{{Code: "DATA_DIR_UNAVAILABLE", Field: "data_dir", Message: "The agent could not create the data directory \"" + path + "\" on this device."}}}
}

// stageOverlay writes a temporary host runtime overlay for validating a
// candidate, so the running process's overlay is never touched by a
// candidate that may be rejected. The overlay goes into the directory into.
// For a check on request the returned cleanup also removes the data directory
// that preparing the overlay had to create, so the host is left as it was.
func (d *VectorDriver) stageOverlay(data []byte, into string, dryRun bool) (string, func(), error) {
	if d.Dir == "" {
		return "", func() {}, nil
	}
	var created []string
	if dryRun {
		created = dataDirsToCreate(hostRuntimeFor(d.Settings, d.Dir, data))
	}
	// Directories go deepest first, and only while they are empty: Remove never
	// takes anything that holds a file.
	removeCreated := func() {
		for i := len(created) - 1; i >= 0; i-- {
			_ = os.Remove(created[i])
		}
	}
	overlay, _, err := runtimeOverlay(d.Settings, d.Dir, data)
	if err != nil {
		return "", removeCreated, err
	}
	path := filepath.Join(into, "host-runtime-stage-"+RandomID()[:16]+".json")
	if err = AtomicWrite(path, overlay); err != nil {
		return "", removeCreated, err
	}
	return path, func() { _ = os.Remove(path); removeCreated() }, nil
}

// dataDirsToCreate lists the directories that preparing the host's data
// directory would create, shallowest first: the ones that don't exist yet. The
// agent creates only the directories it chooses itself; a pipeline's own
// data_dir and Vector's default are left to Vector and the host.
func dataDirsToCreate(h HostRuntime) []string {
	if h.DataDirSource == dataDirPipeline || h.DataDirSource == dataDirVectorDefault || !filepath.IsAbs(h.DataDir) {
		return nil
	}
	var missing []string
	for p := filepath.Clean(h.DataDir); ; p = filepath.Dir(p) {
		if _, err := os.Lstat(p); err == nil {
			break
		} else if !os.IsNotExist(err) {
			return nil
		}
		missing = append([]string{p}, missing...)
		if filepath.Dir(p) == p {
			break
		}
	}
	return missing
}

// Validate is the check an apply makes: Vector validates the staged
// configuration and, when it has tests, runs them.
func (d *VectorDriver) Validate(ctx context.Context, path string) error {
	_, err := d.check(ctx, path, checkMode{tests: true})
	return err
}

// CheckCandidate is the same check on request: the tests run only when asked.
// Whatever goes wrong comes back as a *VectorFailure or a full disk, so the
// result can always say what; the agent's own error texts, which can name the
// Vector binary or a staged file, are replaced by fixed words here.
func (d *VectorDriver) CheckCandidate(ctx context.Context, path string, runTests bool) (candidateRun, error) {
	return d.check(ctx, path, checkMode{tests: runTests, dryRun: true})
}

// prepareFailure is a check that couldn't start, in fixed words.
func prepareFailure(code, message, hint string) *VectorFailure {
	return &VectorFailure{Phase: "prepare", Summary: message, Diagnostics: []Diagnostic{{Code: code, Message: message, Hint: hint}}}
}

func (d *VectorDriver) check(ctx context.Context, path string, mode checkMode) (candidateRun, error) {
	var run candidateRun
	// A check on request reports its own words for what can't run; an apply keeps
	// the errors as they are.
	unready := func(err error, code, message, hint string) (candidateRun, error) {
		if !mode.dryRun {
			return run, err
		}
		if _, full := diskFullFrom(err); full {
			return run, err
		}
		return run, prepareFailure(code, message, hint)
	}
	if e := d.checkBinary(); e != nil {
		return unready(e, "VECTOR_BINARY_UNAVAILABLE", "The Vector binary this agent approved is missing, unreadable or changed.", "Run vectory doctor on the host. Restore the binary, or stop the agent and approve a new one with vectory re-adopt.")
	}
	if e := SafePath(path); e != nil {
		return unready(e, "CHECK_UNAVAILABLE", "The agent couldn't prepare this check.", "Run it again. If it keeps failing, run vectory doctor on the host.")
	}
	seconds := d.Settings.ValidationSeconds
	if seconds < 1 || seconds > 120 {
		seconds = 30
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	data, e := readArtifact(path)
	if e != nil {
		return unready(errors.New("cannot securely read staged configuration"), "CHECK_UNAVAILABLE", "The agent couldn't read its staged copy of this version.", "Run it again. If it keeps failing, run vectory doctor on the host.")
	}
	var document struct {
		Tests []json.RawMessage `json:"tests"`
	}
	if json.Unmarshal(data, &document) != nil {
		return unready(errors.New("configuration or tests must use the expected JSON structure"), "VALIDATION_ERROR", "The configuration or its tests don't have the structure Vector expects.", "Open the pipeline's Tests and check them.")
	}
	into := d.Dir
	if mode.dryRun {
		into = filepath.Dir(path)
	}
	overlay, cleanup, e := d.stageOverlay(data, into, mode.dryRun)
	defer cleanup()
	if e != nil {
		if _, full := diskFullFrom(e); full {
			return run, fmt.Errorf("cannot stage the host runtime settings: %w", e)
		}
		return run, dataDirFailure(hostRuntimeFor(d.Settings, d.Dir, data).DataDir)
	}
	// note keeps a failure in the private local log, for apply only: a check on
	// request leaves nothing behind but its result.
	note := func(title string, output []byte) {
		if !mode.dryRun {
			d.Log.note(title, output)
		}
	}
	paths := []string{path, overlay}
	timeout := &VectorFailure{Phase: "timeout", Summary: fmt.Sprintf("Vector did not finish validating this version within %d s.", seconds)}
	out, err := d.run(ctx, "validate", paths)
	if err != nil {
		if ctx.Err() != nil {
			return run, timeout
		}
		// Healthchecks are not a safety control: they only probe whether a
		// destination answers right now. Refusing a configuration because a
		// destination is down would keep a device on its old configuration,
		// or keep Vector stopped after a restart, and block the very deploy
		// that routes around the outage. Vector buffers and retries at
		// runtime, so only configuration errors may reject a candidate. Rerun
		// without healthchecks; a remaining failure is a real error.
		checked, recheck := d.run(ctx, "validate", paths, "--skip-healthchecks")
		if recheck != nil {
			if ctx.Err() != nil {
				return run, timeout
			}
			note("vector validate rejected the configuration", checked)
			return run, &VectorFailure{Phase: "validate", Summary: "Vector rejected the configuration", Output: checked}
		}
		note("vector validate: configuration valid; some health checks failed", out)
	}
	if mode.tests && len(document.Tests) > 0 {
		out, err = d.run(ctx, "test", paths)
		run = candidateRun{TestsRan: true, TestOutput: out}
		if err != nil {
			if ctx.Err() != nil {
				return run, timeout
			}
			note("vector test reported failing configuration tests", out)
			return run, &VectorFailure{Phase: "test", Summary: "Vector configuration tests failed", Output: out}
		}
	}
	return run, nil
}
func (d *VectorDriver) Alive() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.aliveLocked()
}
func (d *VectorDriver) aliveLocked() bool {
	if d.done == nil || !d.verified {
		return false
	}
	select {
	case <-d.done:
		return false
	default:
		return true
	}
}

// ActivationMethod reports how the current process last took its config.
func (d *VectorDriver) ActivationMethod() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.method
}

// stopGrace is how long the agent waits for the supervisor to finish
// Vector's graceful drain before forcing it.
func (d *VectorDriver) stopGrace() time.Duration {
	return time.Duration(d.Settings.gracefulShutdownSeconds()+10) * time.Second
}

func (d *VectorDriver) Stop() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.verified = false
	if d.child == nil {
		return nil
	}
	_ = d.lifetime.Close()
	select {
	case <-d.done:
	case <-time.After(d.stopGrace()):
		_ = d.child.Process.Kill()
		select {
		case <-d.done:
		case <-time.After(5 * time.Second):
			return errors.New("Vector supervisor did not exit")
		}
	}
	d.child = nil
	return nil
}

func (d *VectorDriver) startupTimeout() time.Duration {
	seconds := d.Settings.StartupSeconds
	if seconds < 3 || seconds > 120 {
		seconds = 20
	}
	return time.Duration(seconds) * time.Second
}

// Activate makes the managed configuration active. On Unix a live, verified
// process is reloaded in place (SIGHUP) and success requires Vector's own
// "Vector has reloaded." acknowledgment followed by a liveness observation;
// otherwise, or if the reload is refused (for example a changed data_dir),
// the process is restarted and must acknowledge startup again.
func (d *VectorDriver) Activate(ctx context.Context, path string) error {
	if !d.Settings.Adopted {
		return errors.New("Vector instance has not been explicitly adopted")
	}
	if e := d.checkBinary(); e != nil {
		return e
	}
	if d.Log == nil {
		d.Log = newVectorLog(d.Dir)
	}
	overlay := ""
	if d.Dir != "" {
		data, err := readArtifact(path)
		if err != nil {
			return errors.New("cannot securely read the managed configuration")
		}
		content, host, err := runtimeOverlay(d.Settings, d.Dir, data)
		if err != nil {
			return dataDirFailure(hostRuntimeFor(d.Settings, d.Dir, data).DataDir)
		}
		overlay = hostRuntimePath(d.Dir)
		if err = writeRuntimeOverlay(overlay, content); err != nil {
			return fmt.Errorf("cannot write the host runtime settings: %w", err)
		}
		if err = rememberHostDataDir(d.Dir, host); err != nil {
			return fmt.Errorf("cannot record the device's Vector data directory: %w", err)
		}
	}
	if d.canReload() {
		if err := d.reload(ctx); err == nil {
			return nil
		} else if ctx.Err() != nil {
			return err
		}
	}
	return d.restart(ctx, path, overlay)
}

func (d *VectorDriver) canReload() bool {
	if runtime.GOOS == "windows" || d.Dir == "" {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.aliveLocked()
}

// reload asks the supervisor to send SIGHUP and waits for Vector's verdict.
func (d *VectorDriver) reload(ctx context.Context) error {
	d.mu.Lock()
	lifetime, done := d.lifetime, d.done
	d.mu.Unlock()
	since := d.Log.beginCapture(false)
	if _, err := lifetime.Write([]byte{hostCommandReload}); err != nil {
		d.Log.endCapture()
		return errors.New("Vector supervisor is not accepting reload requests")
	}
	signals, reason := d.Log.await(ctx, done, d.startupTimeout(), func(s logSignals) bool {
		return s.reloaded > since.reloaded || s.reloadFailed > since.reloadFailed
	})
	records := d.Log.endCapture()
	if reason != "" || signals.reloadFailed > since.reloadFailed {
		if reason == "cancelled" {
			return errors.New("Vector reload cancelled")
		}
		return &VectorFailure{Phase: "reload", Summary: "Vector did not reload the configuration", Records: records}
	}
	if err := observeLiveness(ctx, done); err != nil {
		return err
	}
	d.mu.Lock()
	d.method = activationReload
	d.mu.Unlock()
	return nil
}

func observeLiveness(ctx context.Context, done <-chan struct{}) error {
	live := time.NewTimer(2 * time.Second)
	defer live.Stop()
	select {
	case <-ctx.Done():
		return errors.New("Vector observation cancelled")
	case <-done:
		return errors.New("Vector exited during startup observation")
	case <-live.C:
		return nil
	}
}

func (d *VectorDriver) restart(ctx context.Context, path, overlay string) error {
	if e := d.Stop(); e != nil {
		return e
	}
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	args := []string{"__vector-host", d.Settings.VectorBinary, path, d.Settings.CapabilityPolicy.ConfigurationMode()}
	if overlay != "" {
		args = append(args, overlay, strconv.Itoa(d.Settings.gracefulShutdownSeconds()))
	}
	cmd := exec.Command(exe, args...)
	cmd.Env = vectorEnvironment(d.Settings.CapabilityPolicy.FullVectorConfig)
	supervisorPlatformOptions(cmd)
	// Where no parent-death signal exists (macOS), a Vector orphaned by a
	// killed supervisor keeps the log pipe open; stop waiting for it so the
	// driver sees the exit instead of hanging.
	cmd.WaitDelay = 2 * time.Second
	in, e := cmd.StdinPipe()
	if e != nil {
		return e
	}
	since := d.Log.beginCapture(true)
	cmd.Stdout = d.Log
	cmd.Stderr = io.Discard
	if e = cmd.Start(); e != nil {
		in.Close()
		d.Log.endCapture()
		return errors.New("cannot start Vector supervisor")
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	d.mu.Lock()
	d.child = cmd
	d.lifetime = in
	d.done = done
	d.mu.Unlock()
	fail := func(summary string) error {
		_ = d.Stop()
		return &VectorFailure{Phase: "start", Summary: summary, Records: d.Log.endCapture()}
	}
	_, reason := d.Log.await(ctx, done, d.startupTimeout(), func(s logSignals) bool { return s.started > since.started })
	switch reason {
	case "cancelled":
		_ = d.Stop()
		d.Log.endCapture()
		return errors.New("Vector startup cancelled")
	case "exited":
		return fail("Vector exited before startup acknowledgment")
	case "timeout":
		return fail("Vector startup acknowledgment timed out")
	}
	if err := observeLiveness(ctx, done); err != nil {
		if ctx.Err() != nil {
			_ = d.Stop()
			d.Log.endCapture()
			return err
		}
		return fail("Vector exited during startup observation")
	}
	d.Log.endCapture()
	d.mu.Lock()
	d.verified = true
	d.method = activationRestart
	d.mu.Unlock()
	return nil
}

// Supervisor stdin protocol: EOF stops Vector gracefully; this byte reloads.
const hostCommandReload = 'r'

// VectorHostMain runs the internal supervisor for `vectory __vector-host`.
// Arguments: <binary> <managed-config> <restricted|full> [<overlay> <graceful-seconds>].
// The three-argument form is what older agents pass after an in-place upgrade.
func VectorHostMain(args []string) int {
	if len(args) != 3 && len(args) != 5 {
		return 2
	}
	// The supervisor is controlled only through stdin. Termination signals
	// meant for the agent (a stray kill, a terminal's Ctrl-C) must neither kill
	// it (which SIGKILLs Vector) nor make it signal Vector a second time, which
	// Vector treats as "quit now, skip the drain". Handled, not ignored:
	// ignored signals would be inherited by Vector across exec.
	discard := make(chan os.Signal, 4)
	signal.Notify(discard, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		for range discard {
		}
	}()
	if args[2] != "restricted" && args[2] != "full" {
		return 2
	}
	paths := []string{args[1]}
	graceful := defaultGracefulShutdownSeconds
	if len(args) == 5 {
		n, err := strconv.Atoi(args[4])
		if err != nil || n < minGracefulShutdownSeconds || n > maxGracefulShutdownSeconds || !filepath.IsAbs(args[3]) {
			return 2
		}
		paths, graceful = append(paths, args[3]), n
	}
	return vectorHost(args[0], paths, args[2] == "full", graceful)
}

// vectorHost is internal local process supervision, never a remotely selected
// command. Its stdin pipe is kept open by the agent; EOF stops its exact child.
func vectorHost(binary string, paths []string, full bool, graceful int) int {
	// Linux parent-death signals are tied to the creating thread. Keep it alive
	// for the child's complete lifetime, not merely until exec.Start returns.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	cleanup, e := supervisorGuard()
	if e != nil {
		return 1
	}
	defer cleanup()
	// No --require-healthy: the pipeline's own `healthchecks` settings decide.
	// Healthchecks are not a safety control, and forcing them would keep
	// Vector down whenever a destination is unreachable.
	args := append(vectorConfigArgs("", paths, full), "--log-format", "json", "--graceful-shutdown-limit-secs", strconv.Itoa(graceful))
	cmd := exec.Command(binary, args...)
	cmd.Env = vectorEnvironment(full)
	// Vector 0.58 JSON tracing uses stdout (src/trace.rs); policy excludes console
	// stdout in restricted mode. Full mode explicitly trusts publishers with
	// process capabilities, including event output and executable providers.
	cmd.Stdout = os.Stdout
	cmd.Stderr = io.Discard
	childPlatformOptions(cmd)
	if e = cmd.Start(); e != nil {
		return 1
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	commands := make(chan byte)
	go func() {
		defer close(commands)
		buf := make([]byte, 1)
		for {
			if _, err := os.Stdin.Read(buf); err != nil {
				return
			}
			commands <- buf[0]
		}
	}()
	for {
		select {
		case e := <-done:
			if e != nil {
				return 1
			}
			return 0
		case command, ok := <-commands:
			if ok {
				if command == hostCommandReload {
					reloadChild(cmd)
				}
				continue
			}
			// Vector drains in-flight events for up to its graceful limit; allow
			// a short margin before forcing the exact child.
			stopChild(cmd)
			select {
			case <-done:
			case <-time.After(time.Duration(graceful+5) * time.Second):
				_ = cmd.Process.Kill()
				<-done
			}
			return 0
		}
	}
}
func ProbeVector(ctx context.Context, s Settings) (string, error) {
	if !strings.HasSuffix(strings.ToLower(s.VectorBinary), "vector") && !strings.HasSuffix(strings.ToLower(s.VectorBinary), "vector.exe") {
		return "", errors.New("binary must be a local Vector executable")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.VectorBinary, "--version")
	cmd.WaitDelay = time.Second
	cmd.Env = cleanEnvironment()
	out := &limitedWriter{max: 1024}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	if e := cmd.Run(); e != nil {
		return "", errors.New("cannot execute Vector --version")
	}
	match := vectorVersionLine.FindStringSubmatch(strings.TrimSpace(out.b.String()))
	if match == nil || !SupportedVectorVersion(match[1]) {
		return "", errors.New("this release requires Vector " + VectorSeries)
	}
	return match[1], nil
}
