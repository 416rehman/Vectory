//go:build !windows

package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A machine to run the privileged step on, without systemd and without root: a
// tree of directories the test owns (the policy, the step's directory, the
// agent's state directory and the install directory, with the path check trusting
// the test's own account under it), the real primitives of the step on top of it
// (the lock, the copy, the swap, the handles) and a service manager, a clock and a
// probe that live in files. All of the machine's state is in files, so that the
// step can be killed in the middle of a boundary, in another process, and a new
// run in this one finds exactly what the killed one left.
//
// A "build" is a small file whose first line says what it is and how it behaves
// when the service starts it: FAKEBUILD <version> <behavior>. The fake service
// manager reads the file at the install path when it starts the service, so that
// what runs is whatever the executable is at that moment, as it is for a real
// service.

const fakeBuildMarker = "FAKEBUILD "

// fakeBuild is a build with the given version and behavior, padded so that two
// builds with the same words differ when salt does.
func fakeBuild(version, behavior, salt string) []byte {
	return []byte(fakeBuildMarker + version + " " + behavior + "\n" + strings.Repeat(salt+"-"+version+"-"+behavior+"\n", 64))
}

func classifyFakeBuild(content []byte) (version, behavior string) {
	line, _, _ := strings.Cut(string(content), "\n")
	fields := strings.Fields(strings.TrimPrefix(line, fakeBuildMarker))
	if !strings.HasPrefix(line, fakeBuildMarker) || len(fields) != 2 {
		return "", "unknown"
	}
	return fields[0], fields[1]
}

func digestOf(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// ---------------------------------------------------------------- the clock

// fakeClock is time that moves only when the step sleeps, kept in a file so that
// two processes share it.
type fakeClock struct {
	path string
	mu   sync.Mutex
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	data, err := os.ReadFile(c.path)
	if err != nil {
		panic(err)
	}
	nanos, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		panic(err)
	}
	return time.Unix(0, nanos).UTC()
}

func (c *fakeClock) set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := os.WriteFile(c.path, []byte(strconv.FormatInt(t.UnixNano(), 10)), 0o600); err != nil {
		panic(err)
	}
}

func (c *fakeClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.set(c.Now().Add(d))
	return nil
}

func (c *fakeClock) advance(d time.Duration) { c.set(c.Now().Add(d)) }

// ---------------------------------------------------------------- the machine

// fakeConfig is what a killed process needs to rebuild the machine.
type fakeConfig struct {
	Machine     string `json:"machine"`
	Exe         string `json:"exe"`
	StateDir    string `json:"state_dir"`
	UID         uint32 `json:"uid"`
	GID         uint32 `json:"gid"`
	Packaged    bool   `json:"packaged"`
	InstallFree uint64 `json:"install_free"`
	StepFree    uint64 `json:"step_free"`
	ReadOnly    bool   `json:"read_only"`
	StopFails   bool   `json:"stop_fails"`
	// StartFails is how many starts of the service fail before one works: a service
	// manager that doesn't take the service for a while.
	StartFails  int  `json:"start_fails"`
	StageENOSPC bool `json:"stage_enospc"`
	// SwapFails is why the swap fails: "read-only" for a file system that turned
	// read-only, and any other text for an error the system gives.
	SwapFails string `json:"swap_fails"`
	// CopyENOSPC names a directory, as the step holds it, in which the copy of the
	// build runs out of room.
	CopyENOSPC string `json:"copy_enospc"`
	// TwoRenames makes the install swap the way Windows does: the executable steps
	// aside and the staged file takes its place, with no executable in between.
	TwoRenames bool `json:"two_renames"`
	// SlowStopOf names a version whose stop takes the service manager's whole stop
	// limit of the clock: a build that ignores the signal to stop is ended only when
	// the manager's timeout runs out.
	SlowStopOf string `json:"slow_stop_of"`
	// SlowStartOf names a version whose start waits for the system before the process
	// begins: a unit that is ordered after the network is started only when it is up.
	SlowStartOf string `json:"slow_start_of"`
}

const (
	// fakeSlowStop is how long a slow stop takes: the stop timeout of the agent's unit.
	fakeSlowStop = 330 * time.Second
	// fakeSlowStart is how long a slow start waits before the process begins.
	fakeSlowStart = 120 * time.Second
)

const fakeBigDisk = 1 << 40

// fakeService is the service manager's state for the agent's service.
type fakeService struct {
	State    string `json:"state"`
	Restarts int    `json:"restarts"`
	Started  int64  `json:"started"`
	Digest   string `json:"digest"`
	Version  string `json:"version"`
	Behavior string `json:"behavior"`
	Boot     string `json:"boot"`
	Checkins int    `json:"checkins"`
	// Vector is the state of Vector the running build reports: running unless a
	// test says otherwise.
	Vector  string   `json:"vector"`
	Starts  int      `json:"starts"`
	History []string `json:"history"`
}

type fakeHost struct {
	unixUpdateHost
	cfg     fakeConfig
	clock   *fakeClock
	account updateAccount
	paths   UpdatePaths

	mu         sync.Mutex
	probeCalls []string
	unitsCalls []string
}

func loadFakeHost(machine string) *fakeHost {
	data, err := os.ReadFile(filepath.Join(machine, "config.json"))
	if err != nil {
		panic(err)
	}
	h := &fakeHost{clock: &fakeClock{path: filepath.Join(machine, "clock.json")}}
	if err := json.Unmarshal(data, &h.cfg); err != nil {
		panic(err)
	}
	h.account = updateAccount{Name: "svc", UID: h.cfg.UID, GID: h.cfg.GID}
	h.paths = UpdateLocations()
	return h
}

func (h *fakeHost) saveConfig() {
	data, _ := json.Marshal(h.cfg)
	if err := os.WriteFile(filepath.Join(h.cfg.Machine, "config.json"), data, 0o600); err != nil {
		panic(err)
	}
}

func (h *fakeHost) servicePath() string { return filepath.Join(h.cfg.Machine, "service.json") }

func (h *fakeHost) loadService() fakeService {
	var s fakeService
	if data, err := os.ReadFile(h.servicePath()); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	if s.State == "" {
		s.State = "inactive"
	}
	return s
}

func (h *fakeHost) saveService(s fakeService) {
	data, _ := json.Marshal(s)
	if err := os.WriteFile(h.servicePath(), data, 0o600); err != nil {
		panic(err)
	}
}

// writeAsAccount writes a file the way the service account would: owned by it,
// last written at the machine's time.
func (h *fakeHost) writeAsAccount(path string, data []byte, mtime time.Time) {
	if err := os.WriteFile(path, data, 0o600); err != nil {
		panic(err)
	}
	if os.Geteuid() == 0 {
		if err := os.Lchown(path, int(h.account.UID), int(h.account.GID)); err != nil {
			panic(err)
		}
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		panic(err)
	}
}

func (h *fakeHost) healthPath() string { return UpdateExchangeFor(h.cfg.StateDir).Health }

// writeHealth records a check-in of the running build.
func (h *fakeHost) writeHealth(s fakeService, at time.Time, vector string) {
	h.writeHealthAt(s, at, at, vector)
}

// writeHealthAt records a check-in whose own time and whose file's time differ.
func (h *fakeHost) writeHealthAt(s fakeService, checkedIn, written time.Time, vector string) {
	health := UpdateHealth{AgentSHA256: s.Digest, AgentVersion: s.Version, BootID: s.Boot, CheckedInAt: checkedIn.UTC().Truncate(time.Millisecond), Vector: vector}
	data, err := MarshalUpdateHealth(health)
	if err != nil {
		panic(err)
	}
	h.writeAsAccount(h.healthPath(), data, written)
}

// behaviorDelay is how long after the start a build with that behavior writes
// its first check-in.
func behaviorDelay(behavior string) time.Duration {
	switch behavior {
	case "slow":
		return 400 * time.Second
	case "late":
		return 200 * time.Second
	case "good", "novector", "wrongsha", "wrongboot", "future",
		"healthversion", "staletime", "futurerecord", "futurefile", "restarted", "activating":
		return 3 * time.Second
	}
	return -1
}

// evolve plays the service forward to now: what the started build did meanwhile.
func (h *fakeHost) evolve(s *fakeService, now time.Time) {
	if s.Started == 0 {
		return
	}
	started := time.Unix(0, s.Started)
	elapsed := now.Sub(started)
	switch s.Behavior {
	case "crash":
		s.State = "activating"
		s.Restarts = int(elapsed / (5 * time.Second))
		return
	case "fail":
		s.State = "failed"
		return
	case "exit":
		s.State = "inactive"
		return
	}
	s.State = "active"
	switch s.Behavior {
	case "restarted":
		// The manager restarted it once, a second after it started.
		if elapsed >= time.Second {
			s.Restarts = 1
		}
	case "activating":
		s.State = "activating"
	}
	delay := behaviorDelay(s.Behavior)
	if delay < 0 || elapsed < delay {
		return
	}
	// A running agent checks in again every 30 seconds.
	k := int((elapsed - delay) / (30 * time.Second))
	if k+1 <= s.Checkins {
		return
	}
	s.Checkins = k + 1
	at := started.Add(delay + time.Duration(k)*30*time.Second)
	switch s.Behavior {
	case "novector":
		h.writeHealth(*s, at, UpdateVectorStopped)
	case "wrongsha":
		wrong := *s
		wrong.Digest = digestOf([]byte("another build"))
		h.writeHealth(wrong, at, UpdateVectorRunning)
	case "wrongboot":
		h.writeHealth(*s, at, UpdateVectorRunning)
	case "future":
		h.writeHealth(*s, now.Add(time.Hour), UpdateVectorRunning)
	case "healthversion":
		other := *s
		other.Version = "9.9.9"
		h.writeHealth(other, at, UpdateVectorRunning)
	case "staletime":
		// A record whose own check-in time is from before the build started, in a file
		// that was just written.
		h.writeHealthAt(*s, started.Add(-time.Hour), at, UpdateVectorRunning)
	case "futurerecord":
		h.writeHealthAt(*s, now.Add(time.Hour), at, UpdateVectorRunning)
	case "futurefile":
		h.writeHealthAt(*s, at, now.Add(time.Hour), UpdateVectorRunning)
	default:
		vector := s.Vector
		if vector == "" {
			vector = UpdateVectorRunning
		}
		h.writeHealth(*s, at, vector)
	}
}

func (h *fakeHost) Registered(stateDir string) (registeredService, error) {
	return registeredService{Executable: h.cfg.Exe, StateDir: stateDir, Account: h.account}, nil
}

func (h *fakeHost) PackageManaged(string) (string, bool) {
	return "a fake package owns it", h.cfg.Packaged
}

func (h *fakeHost) StateDirReachable(string) error { return nil }

// AgentExecutable is the executable the fake service runs.
func (h *fakeHost) AgentExecutable() (string, error) { return h.cfg.Exe, nil }

func (h *fakeHost) ServiceState(ctx context.Context) (updateServiceState, error) {
	s := h.loadService()
	h.evolve(&s, h.clock.Now())
	h.saveService(s)
	return updateServiceState{State: s.State, Restarts: s.Restarts, PID: 1000 + s.Starts}, nil
}

func (h *fakeHost) StopService(ctx context.Context) error {
	if h.cfg.StopFails {
		return errors.New("systemctl stop failed")
	}
	s := h.loadService()
	h.evolve(&s, h.clock.Now())
	if h.cfg.SlowStopOf != "" && s.Version == h.cfg.SlowStopOf && s.Started != 0 {
		h.clock.advance(fakeSlowStop)
	}
	s.State, s.Started, s.Restarts = "inactive", 0, 0
	s.History = append(s.History, "stop")
	h.saveService(s)
	return nil
}

func (h *fakeHost) StartService(ctx context.Context) error {
	if h.cfg.StartFails > 0 {
		h.cfg.StartFails--
		return errors.New("systemctl start failed")
	}
	s := h.loadService()
	if s.State == "active" && s.Started != 0 {
		return nil
	}
	content, err := os.ReadFile(h.cfg.Exe)
	if err != nil {
		return err
	}
	version, behavior := classifyFakeBuild(content)
	if h.cfg.SlowStartOf != "" && version == h.cfg.SlowStartOf {
		h.clock.advance(fakeSlowStart)
	}
	s.Starts++
	s.State, s.Restarts, s.Started = "active", 0, h.clock.Now().UnixNano()
	s.Digest, s.Version, s.Behavior, s.Checkins, s.Vector = digestOf(content), version, behavior, 0, ""
	s.Boot = digestOf([]byte("boot-" + strconv.Itoa(s.Starts)))
	if behavior == "wrongboot" {
		s.Boot = h.lastBoot()
	}
	s.History = append(s.History, "start "+version)
	h.saveService(s)
	return nil
}

// lastBoot is the boot id of the process that wrote the health record before.
func (h *fakeHost) lastBoot() string {
	health, err := ReadUpdateHealth(h.healthPath())
	if err != nil {
		return strings.Repeat("0", 64)
	}
	return health.BootID
}

func (h *fakeHost) RunProbe(ctx context.Context, path string, account updateAccount) ([]byte, error) {
	h.mu.Lock()
	h.probeCalls = append(h.probeCalls, path)
	h.mu.Unlock()
	if account != h.account {
		return nil, fmt.Errorf("the probe was asked to run as %+v, and the service account is %+v", account, h.account)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	version, behavior := classifyFakeBuild(content)
	switch behavior {
	case "badprobe":
		return nil, errors.New("the build failed: exit status 1")
	case "wrongversion":
		version = "9.9.9"
	case "wrongos":
		return []byte(fmt.Sprintf(`{"version":%q,"vector_version":"0.58.0","go":"go1.26","os":"plan9","arch":%q}`, version, runtime.GOARCH)), nil
	case "hugeprobe":
		return nil, errProbeOutputTooLong
	case "noversion":
		return []byte("not json"), nil
	}
	return []byte(fmt.Sprintf(`{"version":%q,"vector_version":"0.58.0","go":"go1.26","os":%q,"arch":%q}`+"\n", version, runtime.GOOS, runtime.GOARCH)), nil
}

// CopyInto is the real copy, except for the build into the directory a test says
// is full.
func (h *fakeHost) CopyInto(dir *rootOwned, name string, perm rootFilePerm, src io.Reader, size int64) (string, error) {
	if h.cfg.CopyENOSPC != "" && dir.Path() == h.cfg.CopyENOSPC && name == UpdateBuildFile(runtime.GOOS) {
		return "", &os.PathError{Op: "write", Path: dir.entryPath(name), Err: syscall.ENOSPC}
	}
	return h.unixUpdateHost.CopyInto(dir, name, perm, src, size)
}

func (h *fakeHost) FreeSpace(dir *rootOwned) (uint64, error) {
	if h.cfg.StepFree != 0 {
		return h.cfg.StepFree, nil
	}
	return h.unixUpdateHost.FreeSpace(dir)
}

func (h *fakeHost) OpenInstall(executable string) (updateInstall, error) {
	inner, err := openUnixInstall(executable)
	if err != nil && h.cfg.TwoRenames && notExist(err) {
		// Where the swap has two renames the executable can be missing, and the install
		// is opened without it, as Windows opens it, beside the not-exist error.
		directory, dirErr := openRootOwned(filepath.Dir(executable), rootOwnedDirectory)
		if dirErr != nil {
			return nil, err
		}
		return &fakeInstall{unixInstall: &unixInstall{held: directory, name: filepath.Base(executable), path: executable}, cfg: &h.cfg}, err
	}
	if err != nil {
		return nil, err
	}
	return &fakeInstall{unixInstall: inner, cfg: &h.cfg}, nil
}

func (h *fakeHost) InstallUnits(spec updateUnitSpec) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.unitsCalls = append(h.unitsCalls, fmt.Sprintf("install %+v", spec))
	return nil
}

func (h *fakeHost) RemoveUnits() (string, bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.unitsCalls = append(h.unitsCalls, "remove")
	return filepath.Dir(h.cfg.Exe), true, nil
}

// fakeInstall is the real install handle with the disk a test needs it to have.
type fakeInstall struct {
	*unixInstall
	cfg *fakeConfig
}

func (i *fakeInstall) ReadOnly() bool { return i.cfg.ReadOnly }

func (i *fakeInstall) FreeSpace() (uint64, error) {
	if i.cfg.InstallFree != 0 {
		return i.cfg.InstallFree, nil
	}
	return i.unixInstall.FreeSpace()
}

func (i *fakeInstall) Stage(name string, src io.Reader, size int64) (string, error) {
	if i.cfg.StageENOSPC {
		return "", &os.PathError{Op: "write", Path: name, Err: syscall.ENOSPC}
	}
	return i.unixInstall.Stage(name, src, size)
}

func (i *fakeInstall) Swap(staged, previous string) error {
	switch i.cfg.SwapFails {
	case "":
		if i.cfg.TwoRenames {
			return i.twoRenames().swap(staged, previous)
		}
		return i.unixInstall.Swap(staged, previous)
	case "read-only":
		return fmt.Errorf("%w: the file system became read-only", errUpdateReadOnly)
	}
	return errors.New(i.cfg.SwapFails)
}

func (i *fakeInstall) Style() string {
	if i.cfg.TwoRenames {
		return updateSwapTwoRenames
	}
	return i.unixInstall.Style()
}

func (i *fakeInstall) Restore(previous string) error {
	if i.cfg.TwoRenames {
		return i.twoRenames().restore(previous)
	}
	return i.unixInstall.Restore(previous)
}

// twoRenames is the install directory as the two-rename swap sees it, over the
// Unix primitives: the sequence is the one Windows runs, on renames that replace.
func (i *fakeInstall) twoRenames() twoRenames {
	return twoRenames{
		executable: i.name,
		rename:     func(from, to string) error { return i.held.RenameAt(from, to) },
		present: func(name string) (bool, error) {
			_, err := os.Lstat(filepath.Join(filepath.Dir(i.path), name))
			if errors.Is(err, os.ErrNotExist) {
				return false, nil
			}
			return err == nil, err
		},
	}
}

// ---------------------------------------------------------------- the fixture

type stepFixture struct {
	t          *testing.T
	root       string
	paths      UpdatePaths
	stateDir   string
	installDir string
	exe        string
	machine    string
	host       *fakeHost
	clock      *fakeClock
	private    ReleasePrivateKey
	public     ReleaseKey
	start      time.Time
	logs       *strings.Builder
}

var fixtureStart = time.Date(2026, 10, 5, 2, 0, 0, 0, time.UTC)

// newStepFixture builds the machine: a host that pins one key, consents to
// automatic updates and runs agent 0.1.0, which is healthy and checked in.
func newStepFixture(t *testing.T) *stepFixture {
	t.Helper()
	paths := useUpdateRoots(t)
	root := filepath.Dir(filepath.Dir(filepath.Dir(paths.PolicyDir)))
	f := &stepFixture{t: t, paths: paths, root: root, start: fixtureStart, logs: &strings.Builder{}}
	f.stateDir = filepath.Join(root, "var", "lib", "vectory-agent")
	f.installDir = filepath.Join(root, "usr", "local", "bin")
	f.exe = filepath.Join(f.installDir, "vectory")
	f.machine = filepath.Join(root, "machine")
	for _, dir := range []string{f.installDir, f.machine} {
		mkdirMode(t, dir, 0o755)
	}
	// The service account's state directory and the directory the agent keeps its
	// offer in are private to it.
	mkdirMode(t, filepath.Join(f.stateDir, "updates"), 0o700)
	mkdirMode(t, f.stateDir, 0o700)
	f.clock = &fakeClock{path: filepath.Join(f.machine, "clock.json")}
	f.clock.set(fixtureStart)

	uid, gid := uint32(os.Geteuid()), uint32(os.Getegid())
	if uid == 0 {
		uid, gid = 65534, 65534
	}
	cfg := fakeConfig{Machine: f.machine, Exe: f.exe, StateDir: f.stateDir, UID: uid, GID: gid}
	f.host = &fakeHost{cfg: cfg, clock: f.clock, account: updateAccount{Name: "svc", UID: uid, GID: gid}, paths: paths}
	f.host.saveConfig()
	if os.Geteuid() == 0 {
		for _, dir := range []string{f.stateDir, filepath.Join(f.stateDir, "updates")} {
			if err := os.Chown(dir, int(uid), int(gid)); err != nil {
				t.Fatal(err)
			}
		}
	}
	f.private = testPrivateKey(t, 7)
	f.public = testPublicKey(t, f.private, "team")

	for _, dir := range []struct {
		path string
		leaf rootFilePerm
	}{{paths.Private, rootPrivate}, {paths.Staging, rootPrivate}, {paths.Helper, rootPrivate}, {paths.Probe, rootReadable}} {
		held, err := ensureRootOwnedDir(dir.path, dir.leaf)
		if err != nil {
			t.Fatal(err)
		}
		held.Close()
	}
	f.setPolicy(func(p *UpdatePolicy) {})
	f.installBuild(fakeBuild("0.1.0", "good", "installed"))
	f.recordInstalled("0.1.0")
	f.runningBuild()

	updateHostOverride = f.host
	updateClockOverride = f.clock
	t.Cleanup(func() { updateHostOverride, updateClockOverride, updateFault = nil, nil, nil })
	return f
}

// setPolicy writes the host's policy: automatic updates, the patch track, no
// window, the test key pinned, then whatever edit says.
func (f *stepFixture) setPolicy(edit func(*UpdatePolicy)) {
	f.t.Helper()
	policy := UpdatePolicy{Consent: UpdateConsentAuto, Track: UpdateTrackPatch, Keys: []PinnedKey{{Key: f.public, PinnedAt: f.start}}}
	edit(&policy)
	if err := WriteUpdatePolicy(policy); err != nil {
		f.t.Fatal(err)
	}
}

// installBuild puts a build in the install directory the way an installer does.
func (f *stepFixture) installBuild(content []byte) {
	f.t.Helper()
	tmp := f.exe + ".tmp"
	if err := os.WriteFile(tmp, content, 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Rename(tmp, f.exe); err != nil {
		f.t.Fatal(err)
	}
}

func (f *stepFixture) recordInstalled(version string) {
	f.t.Helper()
	content, err := os.ReadFile(f.exe)
	if err != nil {
		f.t.Fatal(err)
	}
	private, err := openRootOwned(f.paths.Private, rootOwnedDirectory)
	if err != nil {
		f.t.Fatal(err)
	}
	defer private.Close()
	if err := writeUpdateInstalled(private, updateInstalled{Version: version, SHA256: digestOf(content), RecordedAt: f.start}); err != nil {
		f.t.Fatal(err)
	}
}

// runningBuild starts the service on the installed build and has it check in, as
// an agent that has been up for an hour has.
func (f *stepFixture) runningBuild() {
	f.t.Helper()
	content, err := os.ReadFile(f.exe)
	if err != nil {
		f.t.Fatal(err)
	}
	version, behavior := classifyFakeBuild(content)
	s := fakeService{State: "active", Started: f.start.Add(-time.Hour).UnixNano(), Digest: digestOf(content), Version: version, Behavior: behavior, Checkins: 1, Starts: 1,
		Boot: digestOf([]byte("boot-0")), History: []string{"start " + version}}
	f.host.saveService(s)
	f.host.writeHealth(s, f.start.Add(-30*time.Second), UpdateVectorRunning)
}

// fakeRelease is a release as the agent stages it.
type fakeRelease struct {
	version   string
	counter   uint64
	build     []byte
	manifest  []byte
	signature []byte
	rollovers []RolloverEnvelope
}

type releaseOptions struct {
	counter   uint64
	issued    time.Time
	expires   time.Time
	minFrom   string
	signer    *ReleasePrivateKey
	signerKey *ReleaseKey
	rollovers []RolloverEnvelope
	// artifactOf changes the artifact the manifest names, after the build is made.
	mutate func(*ReleaseManifest)
}

// newRelease makes a release of version, signed by the host's pinned key unless the
// options say another, whose build behaves as behavior says.
func (f *stepFixture) newRelease(version, behavior string, options releaseOptions) *fakeRelease {
	f.t.Helper()
	if options.counter == 0 {
		options.counter = 7
	}
	if options.issued.IsZero() {
		options.issued = f.start.Add(-time.Hour)
	}
	if options.expires.IsZero() {
		options.expires = f.start.Add(180 * 24 * time.Hour)
	}
	signer, key := f.private, f.public
	if options.signer != nil {
		signer, key = *options.signer, *options.signerKey
	}
	build := fakeBuild(version, behavior, "release-"+strconv.FormatUint(options.counter, 10))
	manifest := ReleaseManifest{
		Version: version, Counter: options.counter, IssuedAt: options.issued, ExpiresAt: options.expires, MinFrom: options.minFrom, ServiceDefinition: 1,
		Artifacts: []ReleaseArtifact{{OS: runtime.GOOS, Arch: runtime.GOARCH, Format: "executable",
			File: fmt.Sprintf("vectory-%s-%s-%s", version, runtime.GOOS, runtime.GOARCH), Size: int64(len(build)), SHA256: digestOf(build)}},
	}
	if options.mutate != nil {
		options.mutate(&manifest)
	}
	manifestBytes, err := BuildReleaseManifest(manifest)
	if err != nil {
		f.t.Fatal(err)
	}
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(key, signer.SignRelease(manifestBytes))})
	if err != nil {
		f.t.Fatal(err)
	}
	return &fakeRelease{version: version, counter: options.counter, build: build, manifest: manifestBytes, signature: signatures, rollovers: options.rollovers}
}

func (r *fakeRelease) manifestSHA() string { return Digest(r.manifest) }
func (r *fakeRelease) buildSHA() string    { return digestOf(r.build) }

// stage writes the release where the agent does: the build and the files beside it
// in <state>/updates/incoming/<manifest sha256>/, then request.json last.
func (f *stepFixture) stage(r *fakeRelease) string {
	f.t.Helper()
	exchange := UpdateExchangeFor(f.stateDir)
	dir, err := exchange.IncomingDir(r.manifestSHA())
	if err != nil {
		f.t.Fatal(err)
	}
	// The service account's directories are private to it, as the agent's umask makes
	// them: what the step reads there it reads as root, through the capability that
	// ignores a directory's permissions.
	mkdirMode(f.t, exchange.Incoming, 0o700)
	mkdirMode(f.t, dir, 0o700)
	if os.Geteuid() == 0 {
		for _, d := range []string{exchange.Incoming, dir} {
			if err := os.Chown(d, int(f.host.account.UID), int(f.host.account.GID)); err != nil {
				f.t.Fatal(err)
			}
		}
	}
	now := f.clock.Now()
	rollovers, err := MarshalUpdateRollovers(r.rollovers)
	if err != nil {
		f.t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		UpdateBuildFile(runtime.GOOS): r.build, UpdateReleaseFile: r.manifest, UpdateSignaturesFile: r.signature, UpdateRolloversFile: rollovers,
	} {
		f.host.writeAsAccount(filepath.Join(dir, name), data, now)
	}
	f.request(r.manifestSHA(), r.buildSHA(), now)
	return dir
}

// request writes request.json for the digests, last written at time at.
func (f *stepFixture) request(manifest, artifact string, at time.Time) {
	f.t.Helper()
	data, err := MarshalUpdateRequest(UpdateRequest{ManifestSHA256: manifest, ArtifactSHA256: artifact, RolloutID: "c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4", OfferedAt: at})
	if err != nil {
		f.t.Fatal(err)
	}
	f.host.writeAsAccount(UpdateExchangeFor(f.stateDir).Request, data, at)
}

func bg() context.Context { return context.Background() }

// run is one run of the step as the timer starts it.
func (f *stepFixture) run() error {
	f.t.Helper()
	return RunUpdateHelper(context.Background(), f.stateDir)
}

func (f *stepFixture) mustRun() {
	f.t.Helper()
	if err := f.run(); err != nil {
		f.t.Fatalf("the step failed: %v", err)
	}
}

// ---------------------------------------------------------------- reading the machine

func (f *stepFixture) status() UpdateStatus {
	f.t.Helper()
	data, err := os.ReadFile(f.paths.Status)
	if err != nil {
		f.t.Fatal(err)
	}
	status, err := ParseUpdateStatus(data)
	if err != nil {
		f.t.Fatal(err)
	}
	return status
}

func (f *stepFixture) journal() (updateJournal, bool) {
	f.t.Helper()
	data, err := os.ReadFile(f.paths.Journal)
	if errors.Is(err, os.ErrNotExist) {
		return updateJournal{}, false
	}
	if err != nil {
		f.t.Fatal(err)
	}
	journal, err := parseUpdateJournal(data)
	if err != nil {
		f.t.Fatal(err)
	}
	return journal, true
}

func (f *stepFixture) counters() updateCounters {
	f.t.Helper()
	data, err := os.ReadFile(f.paths.Counters)
	if errors.Is(err, os.ErrNotExist) {
		return updateCounters{HighestCounters: map[string]uint64{}}
	}
	if err != nil {
		f.t.Fatal(err)
	}
	counters, err := parseUpdateCounters(data)
	if err != nil {
		f.t.Fatal(err)
	}
	return counters
}

func (f *stepFixture) installedRecord() updateInstalled {
	f.t.Helper()
	data, err := os.ReadFile(f.paths.Installed)
	if err != nil {
		f.t.Fatal(err)
	}
	installed, err := parseUpdateInstalled(data)
	if err != nil {
		f.t.Fatal(err)
	}
	return installed
}

// executableDigest is the digest of the installed executable now.
func (f *stepFixture) executableDigest() string {
	f.t.Helper()
	content, err := os.ReadFile(f.exe)
	if err != nil {
		f.t.Fatal(err)
	}
	return digestOf(content)
}

func (f *stepFixture) service() fakeService { return f.host.loadService() }

// install directory entries other than the executable.
func (f *stepFixture) beside() []string {
	f.t.Helper()
	entries, err := os.ReadDir(f.installDir)
	if err != nil {
		f.t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		if entry.Name() != "vectory" {
			names = append(names, entry.Name())
		}
	}
	return names
}

// fileDigest is the digest of a file by path, or "" when it isn't there.
func fileDigest(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return digestOf(content)
}

func (f *stepFixture) policy() UpdatePolicy {
	f.t.Helper()
	policy, err := ReadUpdatePolicy()
	if err != nil {
		f.t.Fatal(err)
	}
	return policy
}

func (f *stepFixture) stagingEmpty() bool {
	f.t.Helper()
	entries, err := os.ReadDir(f.paths.Staging)
	if err != nil {
		f.t.Fatal(err)
	}
	return len(entries) == 0
}
