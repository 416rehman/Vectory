package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Driver exclusively owns the explicitly adopted Vector child. An arbitrary
// existing Vector process or a healthy HTTP endpoint can never satisfy Alive.
type Driver interface {
	Validate(context.Context, string) error
	Activate(context.Context, string) error
	Alive() bool
	Stop() error
}
type VectorDriver struct {
	Settings Settings
	mu       sync.Mutex
	child    *exec.Cmd
	lifetime io.WriteCloser
	done     chan struct{}
	verified bool
}
type limitedWriter struct {
	b   bytes.Buffer
	max int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	n := len(p)
	if w.b.Len() < w.max {
		left := w.max - w.b.Len()
		if len(p) > left {
			p = p[:left]
		}
		w.b.Write(p)
	}
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
func (d *VectorDriver) checkBinary() error {
	h, e := FileDigest(d.Settings.VectorBinary)
	if e != nil || h != d.Settings.VectorBinarySHA256 {
		return errors.New("adopted Vector binary changed or is inaccessible; local adoption required")
	}
	return nil
}
func (d *VectorDriver) Validate(ctx context.Context, path string) error {
	if e := d.checkBinary(); e != nil {
		return e
	}
	if e := SafePath(path); e != nil {
		return e
	}
	seconds := d.Settings.ValidationSeconds
	if seconds < 1 || seconds > 120 {
		seconds = 30
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, d.Settings.VectorBinary, "validate", "--config-json", path)
	cmd.Env = cleanEnvironment()
	out := &limitedWriter{max: 4096}
	cmd.Stdout = out
	cmd.Stderr = out
	if e := cmd.Run(); e != nil {
		if ctx.Err() != nil {
			return errors.New("Vector validation exceeded timeout")
		}
		return errors.New("Vector rejected configuration or environment; run local doctor for remediation")
	}
	return nil
}
func (d *VectorDriver) Alive() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
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
	case <-time.After(10 * time.Second):
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

type startupWriter struct {
	mu       sync.Mutex
	line     []byte
	dropping bool
	ack      chan struct{}
	once     sync.Once
}

func (w *startupWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, c := range p {
		if c == '\n' {
			if !w.dropping {
				var v struct {
					Target  string `json:"target"`
					Message string `json:"message"`
					Version string `json:"version"`
				}
				if json.Unmarshal(w.line, &v) == nil && v.Target == "vector" && v.Message == "Vector has started." && v.Version == VectorVersion {
					w.once.Do(func() { close(w.ack) })
				}
			}
			w.line = w.line[:0]
			w.dropping = false
		} else if len(w.line) < 8192 && !w.dropping {
			w.line = append(w.line, c)
		} else {
			w.dropping = true
		}
	}
	return len(p), nil
}
func (d *VectorDriver) Activate(ctx context.Context, path string) error {
	if !d.Settings.Adopted {
		return errors.New("Vector instance has not been explicitly adopted")
	}
	if e := d.checkBinary(); e != nil {
		return e
	}
	if e := d.Stop(); e != nil {
		return e
	}
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	cmd := exec.Command(exe, "__vector-host", d.Settings.VectorBinary, path)
	cmd.Env = cleanEnvironment()
	in, e := cmd.StdinPipe()
	if e != nil {
		return e
	}
	ack := &startupWriter{ack: make(chan struct{})}
	cmd.Stdout = ack
	cmd.Stderr = io.Discard
	if e = cmd.Start(); e != nil {
		in.Close()
		return errors.New("cannot start Vector supervisor")
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	d.mu.Lock()
	d.child = cmd
	d.lifetime = in
	d.done = done
	d.mu.Unlock()
	seconds := d.Settings.StartupSeconds
	if seconds < 3 || seconds > 120 {
		seconds = 20
	}
	timeout := time.NewTimer(time.Duration(seconds) * time.Second)
	defer timeout.Stop()
	select {
	case <-ctx.Done():
		_ = d.Stop()
		return errors.New("Vector startup cancelled")
	case <-done:
		_ = d.Stop()
		return errors.New("Vector exited before startup acknowledgment")
	case <-timeout.C:
		_ = d.Stop()
		return errors.New("Vector startup acknowledgment timed out")
	case <-ack.ack:
	}
	live := time.NewTimer(2 * time.Second)
	defer live.Stop()
	select {
	case <-ctx.Done():
		_ = d.Stop()
		return errors.New("Vector observation cancelled")
	case <-done:
		_ = d.Stop()
		return errors.New("Vector exited during startup observation")
	case <-live.C:
	}
	d.mu.Lock()
	d.verified = true
	d.mu.Unlock()
	return nil
}

// VectorHost is internal local process supervision, never a remotely selected command.
// Its stdin pipe is kept open by the agent; EOF terminates its exact child.
func VectorHost(binary, path string) int {
	// Linux parent-death signals are tied to the creating thread. Keep it alive
	// for the child's complete lifetime, not merely until exec.Start returns.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	cleanup, e := supervisorGuard()
	if e != nil {
		return 1
	}
	defer cleanup()
	cmd := exec.Command(binary, "--config-json", path, "--log-format", "json", "--require-healthy", "true")
	cmd.Env = cleanEnvironment()
	// Vector 0.58 JSON tracing uses stdout (src/trace.rs); policy excludes console
	// stdout so event payloads cannot impersonate the trusted startup record.
	cmd.Stdout = os.Stdout
	cmd.Stderr = io.Discard
	childPlatformOptions(cmd)
	if e = cmd.Start(); e != nil {
		return 1
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	closed := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(closed) }()
	select {
	case e := <-done:
		if e != nil {
			return 1
		}
		return 0
	case <-closed:
		stopChild(cmd)
		select {
		case <-done:
		case <-time.After(7 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
		return 0
	}
}
func ProbeVector(ctx context.Context, s Settings) (string, error) {
	if !strings.HasSuffix(strings.ToLower(s.VectorBinary), "vector") && !strings.HasSuffix(strings.ToLower(s.VectorBinary), "vector.exe") {
		return "", errors.New("binary must be a local Vector executable")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.VectorBinary, "--version")
	cmd.Env = cleanEnvironment()
	out := &limitedWriter{max: 1024}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	if e := cmd.Run(); e != nil {
		return "", errors.New("cannot execute Vector --version")
	}
	if !strings.HasPrefix(out.b.String(), "vector "+VectorVersion+" ") {
		return "", errors.New("this release requires Vector " + VectorVersion)
	}
	return VectorVersion, nil
}
