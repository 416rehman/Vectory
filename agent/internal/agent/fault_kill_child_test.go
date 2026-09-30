package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// The agent process that is killed in the crash tests is this test binary,
// started again with the work to do in killHelperEnv. It runs the agent's own
// check-in code (Poll, Recover, StartExisting) against a control plane in the
// parent, with a stand-in for Vector that lives only as long as the process.
// The stage hook lives here, in test code: no production build contains it.
const killHelperEnv = "VECTORY_TEST_KILL_HELPER"

// killRequest is the work the child does.
type killRequest struct {
	// Mode is "apply", which checks in and applies until it stops at Stop and
	// waits to be killed, or "restart", which starts as the agent does after a
	// crash: recover, start what was established, check in.
	Mode      string `json:"mode"`
	Dir       string `json:"dir"`
	Managed   string `json:"managed"`
	Server    string `json:"server"`
	PublicKey string `json:"public_key"`
	// Stop is the stage boundary at which an apply child stops and waits.
	Stop string `json:"stop"`
	// Retry makes a restarted agent take a retry request, as its loop does.
	Retry bool `json:"retry"`
}

// killSnapshot is what a restart child reports after each step.
type killSnapshot struct {
	Step               string   `json:"step"`
	Error              string   `json:"error,omitempty"`
	ManagedSHA256      string   `json:"managed_sha256"`
	ApplyState         string   `json:"apply_state"`
	ReportedGeneration uint64   `json:"reported_generation"`
	LastGoodSHA256     string   `json:"last_good_sha256"`
	Held               bool     `json:"held"`
	Journal            bool     `json:"journal"`
	Alive              bool     `json:"vector_running"`
	Issue              string   `json:"issue,omitempty"`
	Locked             bool     `json:"locked"`
	Files              []string `json:"files,omitempty"`
}

func killHelperMain(raw string) int {
	var request killRequest
	if err := json.Unmarshal([]byte(raw), &request); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// The agent holds its lock for its whole life. A restart must be able to
	// take it: a killed process never releases anything itself.
	var unlock func()
	var err error
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if unlock, err = Lock(request.Dir); err == nil || time.Now().After(deadline) {
			break
		}
	}
	if err != nil {
		encoded, _ := json.Marshal(killSnapshot{Step: "lock", Error: err.Error()})
		fmt.Println(string(encoded))
		return 1
	}
	defer unlock()
	state, err := LoadState(request.Dir)
	if err != nil {
		return 1
	}
	e := &Engine{Dir: request.Dir, Settings: Settings{ManagedConfig: request.Managed, Adopted: true}, State: state, BootID: RandomID(),
		Credentials: Credentials{DeviceID: "device-a", SigningPublicKey: request.PublicKey},
		Client:      &Client{HTTP: &http.Client{Timeout: 20 * time.Second}, Base: request.Server},
		// The old Vector runs while an apply is under way; after a crash it
		// is gone with the agent.
		Driver: &fakeDriver{alive: request.Mode == "apply"}}
	switch request.Mode {
	case "apply":
		e.Fault = func(stage string) error {
			fmt.Println("stage " + stage)
			if stage == request.Stop {
				time.Sleep(time.Hour)
			}
			return nil
		}
		_ = e.Poll(ctx)
		fmt.Println("done")
		return 0
	case "restart":
		snapshot := func(step string, err error) {
			out := killSnapshot{Step: step, ManagedSHA256: e.actual(), ApplyState: e.State.ApplyState, ReportedGeneration: e.State.ReportedGeneration, LastGoodSHA256: e.State.LastGoodSHA256, Held: e.State.FailedGeneration != nil, Alive: e.Driver.Alive(), Locked: true}
			if err != nil {
				out.Error = err.Error()
			}
			if e.State.Error != nil {
				out.Issue = e.State.Error.Code
			}
			if _, statErr := os.Stat(filepath.Join(request.Dir, "journal.json")); statErr == nil {
				out.Journal = true
			}
			for _, dir := range []string{request.Dir, filepath.Dir(request.Managed)} {
				entries, _ := os.ReadDir(dir)
				for _, entry := range entries {
					out.Files = append(out.Files, entry.Name())
				}
			}
			encoded, _ := json.Marshal(out)
			fmt.Println(string(encoded))
		}
		snapshot("locked", nil)
		err = e.Recover(ctx)
		snapshot("recovered", err)
		err = e.StartExisting(ctx)
		snapshot("started", err)
		if request.Retry && e.takeQueuedRetry() {
			snapshot("retry taken", nil)
		}
		err = e.Poll(ctx)
		snapshot("checked in", err)
		return 0
	}
	return 2
}
