package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// The agent reads HTTPS_PROXY once per process, so a proxy test runs the
// agent's own code in a child process: this test binary, started with the
// proxy in its environment and the work to do in proxyClientEnv.
const proxyClientEnv = "VECTORY_TEST_PROXY_CLIENT"

// proxyClientRequest is the work the child does: enroll (which checks the
// pinned CA, sends the token and stores the identity) and then check in once
// with the device certificate, or check in only.
type proxyClientRequest struct {
	Action string `json:"action"` // "enroll" or "check-in"
	Server string `json:"server"`
	Pin    string `json:"pin"`
	Dir    string `json:"dir"`
	Name   string `json:"name"`
	Token  string `json:"token"`
}

// proxyClientResult is what the child reports.
type proxyClientResult struct {
	Enrolled  bool   `json:"enrolled"`
	CheckedIn bool   `json:"checked_in"`
	Code      string `json:"code,omitempty"`
	Message   string `json:"message,omitempty"`
	Fix       string `json:"fix,omitempty"`
	Error     string `json:"error,omitempty"`
}

// proxyClientMain runs the request in proxyClientEnv and prints one JSON line.
func proxyClientMain(raw string) int {
	var request proxyClientRequest
	if err := json.Unmarshal([]byte(raw), &request); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result := proxyClient(ctx, request)
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		return 2
	}
	return 0
}

func proxyClient(ctx context.Context, request proxyClientRequest) (result proxyClientResult) {
	fail := func(err error) proxyClientResult {
		result.Error = err.Error()
		if ce, ok := AsConnectionError(err); ok {
			result.Code, result.Message, result.Fix = ce.Code, ce.Message, ce.Fix
		}
		return result
	}
	if request.Action == "enroll" {
		if err := PrivateDir(request.Dir); err != nil {
			return fail(err)
		}
		if _, err := os.Stat(filepath.Join(request.Dir, "settings.json")); os.IsNotExist(err) {
			if err = WriteJSON(filepath.Join(request.Dir, "settings.json"), Settings{}); err != nil {
				return fail(err)
			}
			if err = SaveState(request.Dir, State{ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
				return fail(err)
			}
		}
		options := EnrollmentOptions{Server: request.Server, Name: request.Name, Token: request.Token, CASHA256: request.Pin}
		if err := EnrollWithOptions(ctx, request.Dir, options); err != nil {
			return fail(err)
		}
		result.Enrolled = true
	}
	if err := Run(ctx, request.Dir, true, func(string) {}); err != nil {
		return fail(err)
	}
	state, err := LoadState(request.Dir)
	if err != nil {
		return fail(err)
	}
	result.CheckedIn = state.LastHeartbeat != nil
	return result
}
