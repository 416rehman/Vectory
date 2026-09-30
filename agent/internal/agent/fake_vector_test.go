package agent

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// A stand-in for the vector executable that runs on every platform without a
// shell: a copy of this test binary named vector (vector.exe on Windows). When
// it starts under that name it acts as Vector for the few commands the agent
// runs to inspect and validate a candidate. How it answers is written next to
// it in fake-vector.json, so a test changes its behavior between runs.

// fakeVectorConfig is what the stand-in reads at every start.
type fakeVectorConfig struct {
	// Version is what --version reports.
	Version string `json:"version"`
	// Validate is how `vector validate` ends: ok, reject, hang (never ends)
	// or slow (ends after Seconds).
	Validate string  `json:"validate"`
	Seconds  float64 `json:"seconds"`
	// PIDFile receives the process id of a validation that hangs, and Calls
	// one line per validation started.
	PIDFile string `json:"pid_file"`
	Calls   string `json:"calls"`
}

// fakeVectorInvoked reports that this process was started as the stand-in.
func fakeVectorInvoked() bool {
	name := strings.ToLower(filepath.Base(os.Args[0]))
	return strings.TrimSuffix(name, ".exe") == "vector"
}

func fakeVectorMain(args []string, stdout io.Writer) int {
	exe, err := os.Executable()
	if err != nil {
		return 1
	}
	config := fakeVectorConfig{Version: VectorVersion, Validate: "ok"}
	if raw, err := os.ReadFile(filepath.Join(filepath.Dir(exe), "fake-vector.json")); err == nil {
		_ = json.Unmarshal(raw, &config)
	}
	if len(args) == 0 {
		return 2
	}
	switch args[0] {
	case "--version", "-V":
		fmt.Fprintf(stdout, "vector %s (stand-in)\n", config.Version)
		return 0
	case "validate":
		if config.Calls != "" {
			if f, err := os.OpenFile(config.Calls, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600); err == nil {
				fmt.Fprintln(f, strings.Join(args, " "))
				f.Close()
			}
		}
		switch config.Validate {
		case "hang", "slow":
			if config.PIDFile != "" {
				_ = os.WriteFile(config.PIDFile, []byte(strconv.Itoa(os.Getpid())), 0600)
			}
			if config.Validate == "hang" {
				time.Sleep(time.Hour)
			}
			time.Sleep(time.Duration(config.Seconds * float64(time.Second)))
		case "reject":
			fmt.Fprintln(stdout, "x stand-in rejected the configuration")
			return 1
		}
		fmt.Fprintln(stdout, "Validated")
		return 0
	}
	return 2
}

var (
	fakeVectorOnce sync.Once
	fakeVectorDir  string
)

// stopFakeVector removes the stand-in when the tests end.
func stopFakeVector() {
	if fakeVectorDir != "" {
		_ = os.RemoveAll(fakeVectorDir)
	}
}

// standInVector returns the stand-in's path and writes how it behaves now.
func standInVector(t *testing.T, config fakeVectorConfig) string {
	t.Helper()
	fakeVectorOnce.Do(func() {
		dir, err := os.MkdirTemp("", "vectory-stand-in-")
		if err != nil {
			t.Fatal(err)
		}
		if dir, err = filepath.EvalSymlinks(dir); err != nil {
			t.Fatal(err)
		}
		binary := "vector"
		if runtime.GOOS == "windows" {
			binary += ".exe"
		}
		self, err := os.ReadFile(os.Args[0])
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, binary), self, 0755); err != nil {
			t.Fatal(err)
		}
		fakeVectorDir = dir
	})
	if fakeVectorDir == "" {
		t.Fatal("the stand-in for Vector could not be created")
	}
	if config.Version == "" {
		config.Version = VectorVersion
	}
	if config.Validate == "" {
		config.Validate = "ok"
	}
	raw, _ := json.Marshal(config)
	if err := os.WriteFile(filepath.Join(fakeVectorDir, "fake-vector.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	binary := "vector"
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	return filepath.Join(fakeVectorDir, binary)
}
