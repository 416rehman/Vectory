package agent

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
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
	// Validate is how `vector validate` ends: ok, reject, healthcheck
	// (fails unless --skip-healthchecks is passed), hang or slow.
	Validate string  `json:"validate"`
	Seconds  float64 `json:"seconds"`
	// PIDFile receives the process id of a validation that hangs, and Calls
	// one line per validation or test run started, followed, for each
	// configuration file that sets data_dir, by what the stand-in saw of that
	// directory.
	PIDFile string `json:"pid_file"`
	Calls   string `json:"calls"`
	// Test is how `vector test` ends: ok (the default), hang (never ends) or
	// fail, which fails the tests named in FailTests with output shaped like
	// Vector's own.
	Test      string   `json:"test"`
	FailTests []string `json:"fail_tests"`
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
	// Started with options and no subcommand, as a running Vector is: stay up
	// until the test that started it ends the process.
	if strings.HasPrefix(args[0], "-") && args[0] != "--version" && args[0] != "-V" {
		time.Sleep(time.Hour)
		return 0
	}
	switch args[0] {
	case "--version", "-V":
		fmt.Fprintf(stdout, "vector %s (stand-in)\n", config.Version)
		return 0
	case "test":
		fakeVectorLog(config, args)
		if config.Test == "hang" {
			time.Sleep(time.Hour)
		}
		names := fakeVectorTestNames(args)
		fmt.Fprintln(stdout, "Running tests")
		var failed []string
		for _, name := range names {
			if config.Test == "fail" && slices.Contains(config.FailTests, name) {
				failed = append(failed, name)
				fmt.Fprintf(stdout, "test %s ... failed\n", name)
				continue
			}
			fmt.Fprintf(stdout, "test %s ... passed\n", name)
		}
		if len(failed) == 0 {
			return 0
		}
		fmt.Fprintln(stdout, "\nfailures:")
		for _, name := range failed {
			fmt.Fprintf(stdout, "\ntest %s:\n\ncheck[0] for transforms [\"tag\"] failed conditions:\n\n  condition[0]: source execution failed: \nerror[E000]: function call error for \"assert_eq\" at (0:27): assertion failed: \"prod\" == \"staging\"\n  ┌─ :1:1\n  │\n1 │ assert_eq!(.env, \"staging\")\n  │ ^^^^^^^^^^^^^^^^^^^^^^^^^^^ assertion failed: \"prod\" == \"staging\"\n  │\n  = see language documentation at https://vrl.dev\n\n\noutput payloads from [\"tag\"] (events encoded as JSON):\n  {\"env\":\"prod\"}\n\n", name)
		}
		return 78
	case "validate":
		fakeVectorLog(config, args)
		switch config.Validate {
		case "healthcheck":
			if !slices.Contains(args, "--skip-healthchecks") {
				fmt.Fprintln(stdout, `x Health check for "es" failed: Failed to make HTTP(S) request: Connection refused (os error 111)`)
				return 1
			}
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

// fakeVectorConfigPaths are the configuration files an invocation names.
func fakeVectorConfigPaths(args []string) []string {
	var paths []string
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--config-json" {
			paths = append(paths, args[i+1])
		}
	}
	return paths
}

// fakeVectorLog notes an invocation in the Calls file: the arguments, and for
// each configuration file that sets data_dir whether that directory exists
// when Vector is asked about it.
func fakeVectorLog(config fakeVectorConfig, args []string) {
	if config.Calls == "" {
		return
	}
	f, err := os.OpenFile(config.Calls, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintln(f, strings.Join(args, " "))
	for _, path := range fakeVectorConfigPaths(args) {
		var document struct {
			DataDir string `json:"data_dir"`
		}
		if raw, err := os.ReadFile(path); err == nil && json.Unmarshal(raw, &document) == nil && document.DataDir != "" {
			_, statErr := os.Stat(document.DataDir)
			fmt.Fprintf(f, "  data_dir exists=%v\n", statErr == nil)
		}
	}
}

// fakeVectorTestNames are the names of the tests in the configuration files an
// invocation names.
func fakeVectorTestNames(args []string) []string {
	var names []string
	for _, path := range fakeVectorConfigPaths(args) {
		var document struct {
			Tests []struct {
				Name string `json:"name"`
			} `json:"tests"`
		}
		if raw, err := os.ReadFile(path); err == nil && json.Unmarshal(raw, &document) == nil {
			for _, test := range document.Tests {
				names = append(names, test.Name)
			}
		}
	}
	return names
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
