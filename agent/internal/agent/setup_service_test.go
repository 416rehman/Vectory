package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeServiceManager records service actions; start and restart make a
// stand-in agent with the given build check in.
type fakeServiceManager struct {
	running      bool
	registration ServiceRegistration
	actions      []string
	dir          string
	build        *AgentBuild
}

func (f *fakeServiceManager) ops() serviceOps {
	return serviceOps{
		install: func(exe, dir, account string) (ServiceRegistration, error) { return f.registration, nil },
		control: func(action string) error {
			f.actions = append(f.actions, action)
			f.running = true
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

func ptrTime(t time.Time) *time.Time { return &t }
