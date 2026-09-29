package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeServiceManager records service calls; start and restart make a
// stand-in agent with the given build check in. fail makes a call fail.
type fakeServiceManager struct {
	running         bool
	registration    ServiceRegistration
	actions         []string
	dir             string
	build           *AgentBuild
	fail            map[string]error
	stopToReplace   bool
	keepsDefinition bool
}

func (f *fakeServiceManager) ops() serviceOps {
	return serviceOps{
		install: func(exe, dir, account string) (ServiceRegistration, error) { return f.registration, f.fail["install"] },
		check: func(exe, dir, account string) error {
			f.actions = append(f.actions, "check")
			return f.fail["check"]
		},
		replace: func(source, target string) error {
			f.actions = append(f.actions, "replace")
			return f.fail["replace"]
		},
		control: func(action string) error {
			f.actions = append(f.actions, action)
			if err := f.fail[action]; err != nil {
				return err
			}
			f.running = action != "stop"
			if !f.running || f.build == nil {
				return nil
			}
			now := time.Now()
			return SaveState(f.dir, State{Agent: f.build, LastHeartbeat: &now, Policy: Policy{HeartbeatSeconds: 30}})
		},
		status: func(context.Context) ServiceInfo {
			state := "stopped"
			if f.running {
				state = "running"
			}
			return ServiceInfo{Installed: true, State: state}
		},
		stopToReplace:   f.stopToReplace,
		keepsDefinition: f.keepsDefinition,
	}
}

func serviceFixture(t *testing.T, recorded *AgentBuild, heartbeat time.Time) (string, string, string) {
	t.Helper()
	dir := t.TempDir()
	agentPath := filepath.Join(t.TempDir(), "vectory")
	if err := os.WriteFile(agentPath, []byte("agent build "+Version), 0755); err != nil {
		t.Fatal(err)
	}
	digest, err := FileDigest(agentPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = SaveState(dir, State{Agent: recorded, LastHeartbeat: &heartbeat, Policy: Policy{HeartbeatSeconds: 30}}); err != nil {
		t.Fatal(err)
	}
	return dir, agentPath, digest
}

func serviceDetail(result SetupResult) string {
	var lines []string
	for _, step := range result.Steps {
		lines = append(lines, step.Status+" "+step.Detail)
	}
	return strings.Join(lines, "\n")
}

func TestSetupRestartsARunningServiceOnAnOlderBuild(t *testing.T) {
	dir, agentPath, digest := serviceFixture(t, &AgentBuild{Version: "0.1.0", SHA256: "old"}, time.Now())
	manager := &fakeServiceManager{running: true, registration: ServiceUnchanged, dir: dir, build: &AgentBuild{Version: Version, SHA256: digest}}
	r := &setupRun{options: SetupOptions{CheckIn: 5 * time.Second}}
	result, err := r.startService(context.Background(), manager.ops(), "systemd", agentPath, dir, "vectory", 60)
	if err != nil || !result.OK || strings.Join(manager.actions, ",") != "restart" {
		t.Fatalf("actions %v, err %v\n%s", manager.actions, err, serviceDetail(result))
	}
	if detail := serviceDetail(result); !strings.Contains(detail, "ok vectory.service upgraded 0.1.0 → "+Version+" · first check-in") {
		t.Fatalf("upgrade not reported:\n%s", detail)
	}
}

func TestSetupRestartsAServiceThatNeverRecordedItsBuild(t *testing.T) {
	dir, agentPath, digest := serviceFixture(t, nil, time.Now())
	manager := &fakeServiceManager{running: true, registration: ServiceUpdated, dir: dir, build: &AgentBuild{Version: Version, SHA256: digest}}
	r := &setupRun{options: SetupOptions{CheckIn: 5 * time.Second}}
	result, err := r.startService(context.Background(), manager.ops(), "systemd", agentPath, dir, "vectory", 60)
	detail := serviceDetail(result)
	if err != nil || strings.Join(manager.actions, ",") != "restart" || !strings.Contains(detail, "info vectory.service definition updated.") || !strings.Contains(detail, "ok vectory.service restarted on "+Version) {
		t.Fatalf("actions %v, err %v\n%s", manager.actions, err, detail)
	}
}

func TestSetupLeavesACurrentServiceAlone(t *testing.T) {
	dir, agentPath, digest := serviceFixture(t, nil, time.Now().Add(-5*time.Second))
	if err := SaveState(dir, State{Agent: &AgentBuild{Version: Version, SHA256: digest}, LastHeartbeat: ptrTime(time.Now().Add(-5 * time.Second)), Policy: Policy{HeartbeatSeconds: 30}}); err != nil {
		t.Fatal(err)
	}
	manager := &fakeServiceManager{running: true, registration: ServiceUnchanged, dir: dir}
	r := &setupRun{options: SetupOptions{CheckIn: time.Second}}
	result, err := r.startService(context.Background(), manager.ops(), "systemd", agentPath, dir, "vectory", 60)
	if err != nil || len(manager.actions) != 0 || !strings.Contains(serviceDetail(result), "ok vectory.service running "+Version+" · last check-in") {
		t.Fatalf("actions %v, err %v\n%s", manager.actions, err, serviceDetail(result))
	}
}

func TestSetupStartsAStoppedService(t *testing.T) {
	dir, agentPath, digest := serviceFixture(t, &AgentBuild{Version: "0.1.0", SHA256: "old"}, time.Now().Add(-time.Hour))
	manager := &fakeServiceManager{registration: ServiceCreated, dir: dir, build: &AgentBuild{Version: Version, SHA256: digest}}
	r := &setupRun{options: SetupOptions{CheckIn: 5 * time.Second}}
	result, err := r.startService(context.Background(), manager.ops(), "systemd", agentPath, dir, "vectory", 60)
	if err != nil || strings.Join(manager.actions, ",") != "start" || !strings.Contains(serviceDetail(result), "ok vectory.service running · first check-in") {
		t.Fatalf("actions %v, err %v\n%s", manager.actions, err, serviceDetail(result))
	}
}

// A check-in from the old build (or from nothing) never counts.
func TestSetupWaitsForTheNewBuildToCheckIn(t *testing.T) {
	dir, agentPath, _ := serviceFixture(t, &AgentBuild{Version: "0.1.0", SHA256: "old"}, time.Now())
	manager := &fakeServiceManager{running: true, registration: ServiceUnchanged, dir: dir, build: &AgentBuild{Version: "0.1.0", SHA256: "old"}}
	r := &setupRun{options: SetupOptions{CheckIn: 500 * time.Millisecond}}
	result, err := r.startService(context.Background(), manager.ops(), "systemd", agentPath, dir, "vectory", 0)
	if err != nil || !strings.Contains(serviceDetail(result), "warn vectory.service restarted on "+Version+", but hasn't checked in") {
		t.Fatalf("err %v\n%s", err, serviceDetail(result))
	}
}

// Windows can't replace a running agent: setup stops the service only after a
// read-only check that registration would accept this agent. A refusal
// leaves the service running.
func TestSetupChecksTheRegistrationBeforeStoppingTheService(t *testing.T) {
	dir, agentPath, _ := serviceFixture(t, &AgentBuild{Version: "0.1.0", SHA256: "old"}, time.Now())
	refused := errors.New("the Vectory service is registered for another executable, state directory or account")
	manager := &fakeServiceManager{running: true, stopToReplace: true, dir: dir, fail: map[string]error{"check": refused}}
	r := &setupRun{}
	err := r.installAgent(context.Background(), manager.ops(), "windows", filepath.Join(t.TempDir(), "vectory.exe"), agentPath, dir, `NT SERVICE\Vectory`)
	result, err := r.restartIfStopped(manager.ops(), r.result, err)
	if err == nil || strings.Join(manager.actions, ",") != "check" || !manager.running || stepStatus(result, "service") != "fail" {
		t.Fatalf("actions %v, err %v\n%s", manager.actions, err, serviceDetail(result))
	}
}

// Once setup stopped the service, a failure starts it again: on the previous
// build when the agent couldn't be replaced.
func TestSetupRestartsTheServiceOnThePreviousBuildWhenTheAgentCantBeReplaced(t *testing.T) {
	dir, agentPath, _ := serviceFixture(t, &AgentBuild{Version: "0.1.0", SHA256: "old"}, time.Now())
	busy := errors.New("the process cannot access the file because it is being used by another process")
	manager := &fakeServiceManager{running: true, stopToReplace: true, dir: dir, fail: map[string]error{"replace": busy}}
	r := &setupRun{}
	err := r.installAgent(context.Background(), manager.ops(), "windows", filepath.Join(t.TempDir(), "vectory.exe"), agentPath, dir, `NT SERVICE\Vectory`)
	result, err := r.restartIfStopped(manager.ops(), r.result, err)
	detail := serviceDetail(result)
	if err == nil || !strings.Contains(err.Error(), "being used by another process") {
		t.Fatalf("the replace failure was lost: %v", err)
	}
	if strings.Join(manager.actions, ",") != "check,stop,replace,start" || !manager.running || !strings.Contains(detail, "info Vectory service restarted on the previous build.") {
		t.Fatalf("actions %v\n%s", manager.actions, detail)
	}
}

// A failure after the new agent is in place starts the service on it.
func TestSetupRestartsTheServiceWhenALaterStepFails(t *testing.T) {
	dir, agentPath, _ := serviceFixture(t, &AgentBuild{Version: "0.1.0", SHA256: "old"}, time.Now())
	manager := &fakeServiceManager{running: true, stopToReplace: true, dir: dir, fail: map[string]error{"install": errors.New("another agent lifecycle operation is running")}}
	r := &setupRun{options: SetupOptions{CheckIn: time.Second}}
	ops := manager.ops()
	if err := r.installAgent(context.Background(), ops, "windows", filepath.Join(t.TempDir(), "vectory.exe"), agentPath, dir, `NT SERVICE\Vectory`); err != nil {
		t.Fatal(err)
	}
	result, err := r.startService(context.Background(), ops, "windows", agentPath, dir, `NT SERVICE\Vectory`, 60)
	result, err = r.restartIfStopped(ops, result, err)
	if err == nil || strings.Join(manager.actions, ",") != "check,stop,replace,start" || !strings.Contains(serviceDetail(result), "info Vectory service restarted on "+Version+".") {
		t.Fatalf("actions %v, err %v\n%s", manager.actions, err, serviceDetail(result))
	}
}

// The service step starts the service setup stopped, and reports the upgrade.
func TestSetupStartsTheStoppedServiceOnTheNewBuild(t *testing.T) {
	dir, agentPath, digest := serviceFixture(t, &AgentBuild{Version: "0.1.0", SHA256: "old"}, time.Now())
	manager := &fakeServiceManager{running: true, stopToReplace: true, registration: ServiceUnchanged, dir: dir, build: &AgentBuild{Version: Version, SHA256: digest}}
	r := &setupRun{options: SetupOptions{CheckIn: 5 * time.Second}}
	ops := manager.ops()
	if err := r.installAgent(context.Background(), ops, "windows", filepath.Join(t.TempDir(), "vectory.exe"), agentPath, dir, `NT SERVICE\Vectory`); err != nil {
		t.Fatal(err)
	}
	result, err := r.startService(context.Background(), ops, "windows", agentPath, dir, `NT SERVICE\Vectory`, 60)
	result, err = r.restartIfStopped(ops, result, err)
	if err != nil || strings.Join(manager.actions, ",") != "check,stop,replace,start" || !strings.Contains(serviceDetail(result), "ok Vectory service upgraded 0.1.0 → "+Version+" · first check-in") {
		t.Fatalf("actions %v, err %v\n%s", manager.actions, err, serviceDetail(result))
	}
}

// launchd keeps a loaded definition across kickstart -k: an updated one is
// loaded with a stop and a start.
func TestSetupLoadsAnUpdatedLaunchdDefinition(t *testing.T) {
	dir, agentPath, digest := serviceFixture(t, nil, time.Now())
	current := &AgentBuild{Version: Version, SHA256: digest}
	if err := SaveState(dir, State{Agent: current, LastHeartbeat: ptrTime(time.Now()), Policy: Policy{HeartbeatSeconds: 30}}); err != nil {
		t.Fatal(err)
	}
	manager := &fakeServiceManager{running: true, registration: ServiceUpdated, keepsDefinition: true, dir: dir, build: current}
	r := &setupRun{options: SetupOptions{CheckIn: 5 * time.Second}}
	result, err := r.startService(context.Background(), manager.ops(), "launchd", agentPath, dir, "_vectory", 60)
	if err != nil || strings.Join(manager.actions, ",") != "stop,start" || !strings.Contains(serviceDetail(result), "ok io.vectory.agent restarted on "+Version) {
		t.Fatalf("actions %v, err %v\n%s", manager.actions, err, serviceDetail(result))
	}
}

// A running service that setup didn't touch isn't reported as started, and
// the hint points where the agent's output really goes.
func TestSetupDoesNotClaimItStartedARunningService(t *testing.T) {
	for service, want := range map[string]string{"systemd": "journalctl -u vectory.service", "windows": "`vectory status` shows the last check-in error", "launchd": "`sudo vectory logs` Vector's log"} {
		dir, agentPath, digest := serviceFixture(t, nil, time.Now())
		if err := SaveState(dir, State{Agent: &AgentBuild{Version: Version, SHA256: digest}, LastHeartbeat: ptrTime(time.Now().Add(-time.Hour)), Policy: Policy{HeartbeatSeconds: 30}}); err != nil {
			t.Fatal(err)
		}
		manager := &fakeServiceManager{running: true, registration: ServiceUnchanged, dir: dir}
		r := &setupRun{options: SetupOptions{CheckIn: 300 * time.Millisecond}}
		result, err := r.startService(context.Background(), manager.ops(), service, agentPath, dir, "vectory", 60)
		last := result.Steps[len(result.Steps)-1]
		if err != nil || len(manager.actions) != 0 || last.Detail != ServiceInfoName(service)+" is running, but hasn't checked in after 300 ms." || !strings.Contains(last.Fix, want) || strings.Contains(last.Fix, "Event Viewer") {
			t.Fatalf("%s: actions %v, err %v, step %+v", service, manager.actions, err, last)
		}
	}
}

// Ctrl-C while setup waits for the check-in leaves the service running.
func TestSetupInterruptedWhileWaitingKeepsTheServiceRunning(t *testing.T) {
	dir, agentPath, _ := serviceFixture(t, &AgentBuild{Version: "0.1.0", SHA256: "old"}, time.Now())
	manager := &fakeServiceManager{running: true, registration: ServiceUnchanged, dir: dir, build: &AgentBuild{Version: "0.1.0", SHA256: "old"}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &setupRun{options: SetupOptions{CheckIn: 5 * time.Second}}
	result, err := r.startService(ctx, manager.ops(), "systemd", agentPath, dir, "vectory", 60)
	last := result.Steps[len(result.Steps)-1]
	if err == nil || result.OK || !manager.running || last.Status != "warn" || last.Detail != "Interrupted; vectory.service keeps running." {
		t.Fatalf("err %v, step %+v", err, last)
	}
}

func ptrTime(t time.Time) *time.Time { return &t }
