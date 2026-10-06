//go:build !windows

package agent

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Stopping the agent must give Vector exactly one SIGTERM so it drains
// in-flight events. A second signal makes Vector quit at once, and a killed
// supervisor SIGKILLs it (Linux parent-death signal).
func TestNativeStopDrainsVectorOnce(t *testing.T) {
	if os.Getenv("VECTOR_TEST_BINARY") == "" {
		t.Skip("set VECTOR_TEST_BINARY to verified Vector 0.58.0 for native integration")
	}
	cases := []struct {
		name string
		stop func(agent, supervisor int) error
	}{
		// A terminal delivers Ctrl-C to the whole foreground process group.
		{"ctrl-c to the foreground group", func(agent, _ int) error { return syscall.Kill(-agent, syscall.SIGINT) }},
		// systemd KillMode=mixed (and launchd) signal only the main process.
		{"service stop signals the agent", func(agent, _ int) error { return syscall.Kill(agent, syscall.SIGTERM) }},
		// A stray signal to the supervisor must not stop or signal Vector.
		{"stray signals to the supervisor", func(agent, supervisor int) error {
			for _, s := range []syscall.Signal{syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP} {
				if err := syscall.Kill(supervisor, s); err != nil {
					return err
				}
			}
			time.Sleep(1500 * time.Millisecond)
			if err := syscall.Kill(supervisor, 0); err != nil {
				return err
			}
			return syscall.Kill(agent, syscall.SIGTERM)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			data := filepath.Join(dir, "data")
			if err := os.Mkdir(data, 0700); err != nil {
				t.Fatal(err)
			}
			config, _ := json.Marshal(map[string]any{
				"data_dir": data,
				"sources":  map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json", "interval": 0.05}},
				"sinks":    map[string]any{"out": map[string]any{"type": "blackhole", "inputs": []string{"in"}, "print_interval_secs": 0}},
			})
			if err := os.WriteFile(filepath.Join(dir, "managed.json"), config, 0600); err != nil {
				t.Fatal(err)
			}
			agent := exec.Command(os.Args[0], "-test.run=^$")
			agent.Env = append(os.Environ(), drainAgentEnv+"="+dir)
			// The stand-in agent leads its own group, like a shell job.
			agent.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			out, err := agent.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = agent.Start(); err != nil {
				t.Fatal(err)
			}
			exited := make(chan error, 1)
			lines := bufio.NewScanner(out)
			ready := make(chan string, 1)
			go func() {
				for lines.Scan() {
					ready <- lines.Text()
				}
				exited <- agent.Wait()
			}()
			var supervisor int
			select {
			case line := <-ready:
				pid, found := strings.CutPrefix(line, "ready ")
				if !found {
					t.Fatalf("agent did not start Vector: %s", line)
				}
				supervisor, _ = strconv.Atoi(pid)
			case <-time.After(30 * time.Second):
				_ = syscall.Kill(-agent.Process.Pid, syscall.SIGKILL)
				t.Fatal("agent did not start Vector")
			}
			if group, err := syscall.Getpgid(supervisor); err != nil || group == agent.Process.Pid {
				t.Errorf("supervisor shares the agent's process group (%d, %v)", group, err)
			}
			if err = tc.stop(agent.Process.Pid, supervisor); err != nil {
				t.Fatal(err)
			}
			select {
			case err = <-exited:
				if err != nil {
					t.Fatalf("agent exit: %v", err)
				}
			case <-time.After(30 * time.Second):
				_ = syscall.Kill(-agent.Process.Pid, syscall.SIGKILL)
				t.Fatal("agent did not stop")
			}
			if err = syscall.Kill(supervisor, 0); err == nil {
				t.Fatal("supervisor outlived the agent")
			}
			log, err := os.ReadFile(filepath.Join(dir, vectorLogName))
			if err != nil {
				t.Fatal(err)
			}
			var received []string
			for _, line := range strings.Split(string(log), "\n") {
				if rec, ok := parseVectorRecord([]byte(line)); ok && rec.Message == "Signal received." {
					received = append(received, line)
				}
			}
			text := string(log)
			if len(received) != 1 || !strings.Contains(received[0], `"signal":"SIGTERM"`) ||
				!strings.Contains(text, `"Vector is stopping."`) || !strings.Contains(text, `"Vector has stopped."`) || strings.Contains(text, `"Vector has quit."`) {
				t.Fatalf("Vector did not drain on exactly one SIGTERM:\n%s", text)
			}
		})
	}
}
