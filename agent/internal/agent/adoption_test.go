package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

var adoptionMarks = map[string]string{"ok": "[ok]", "info": "[i] ", "warn": "[!!]", "fail": "[!!]", "plan": "[..]"}

var (
	backupFolder = regexp.MustCompile(`\d{8}T\d{6}Z(-\d+)?`)
	recordedAt   = regexp.MustCompile(`(?i)(recorded) \d{4}-\d\d-\d\d \d\d:\d\d \w+`)
)

// stopVector is the advice the tests' running Vector gets to stop it: the
// service manager's command of the platform the test runs on.
func stopVector() string {
	return stopAdvice([]RunningVector{{Service: "vector.service"}}, runtime.GOOS)
}

// renderAdoption prints the steps that concern an existing Vector the way the
// command line prints them, with the values that differ between runs replaced
// by placeholders: the paths (also as a command line quotes them, and longest
// first, since the backup folder is inside the state directory), the times and
// the platform's way to stop a service.
func renderAdoption(result SetupResult, replace map[string]string) string {
	var b strings.Builder
	for _, step := range result.Steps {
		if step.ID != "inventory" && step.ID != "existing" || strings.Contains(step.Detail, "checking again in") {
			continue
		}
		fmt.Fprintf(&b, "%s %-12s %s\n", adoptionMarks[step.Status], step.Label, IndentLines(step.Detail, 18))
		if step.Fix != "" {
			fmt.Fprintf(&b, "%s%s\n", strings.Repeat(" ", 18), IndentLines(step.Fix, 18))
		}
	}
	out := strings.ReplaceAll(b.String(), stopVector(), "<stop>")
	replacements := map[string]string{}
	for value, placeholder := range replace {
		for _, form := range []string{value, ShellQuote(value), displayArg(value)} {
			replacements[form] = placeholder
		}
	}
	forms := make([]string, 0, len(replacements))
	for form := range replacements {
		forms = append(forms, form)
	}
	sort.Slice(forms, func(i, j int) bool { return len(forms[i]) > len(forms[j]) })
	for _, form := range forms {
		out = strings.ReplaceAll(out, form, replacements[form])
	}
	out = backupFolder.ReplaceAllString(out, "<time>")
	out = recordedAt.ReplaceAllString(out, "$1 <date>")
	return strings.ReplaceAll(out, `\`, "/")
}

// assertGolden compares got with testdata/adoption/<name>.golden. Setting
// VECTORY_UPDATE_GOLDEN rewrites the file from what the code says now; the
// diff is then reviewed like any other change.
func assertGolden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "adoption", name+".golden")
	if os.Getenv("VECTORY_UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if text := strings.ReplaceAll(string(want), "\r\n", "\n"); text != got {
		t.Fatalf("%s differs from its golden file.\n--- got\n%s--- want\n%s", name, got, text)
	}
}

// adoptionHost is a host where a Vector runs, set up against a real (test)
// server, so setup's whole path is exercised.
type adoptionHost struct {
	t       *testing.T
	options SetupOptions
	host    serviceHost
	server  *setupServer
	dir     string
	managed string
	conf    string
	// running is what runs now; setting it to nil stops that Vector.
	running []VectorStartup
	tokens  int
}

// newAdoptionHost writes the given configuration files and starts a
// (pretended) Vector with the arguments args(conf) names.
func newAdoptionHost(t *testing.T, files map[string]string, args func(conf string) []string) *adoptionHost {
	t.Helper()
	h := &adoptionHost{t: t, server: newSetupServer(t), conf: t.TempDir()}
	writeConfigFiles(t, h.conf, files)
	h.options, h.dir, h.managed = setupFixture(t)
	h.options.KeepExistingVector = false
	h.options.Server, h.options.CASHA256 = h.server.url, h.server.pin
	h.options.VectorBinary = standInVector(t, fakeVectorConfig{})
	h.options.Token = func() (string, error) { h.tokens++; return "synthetic-setup-token", nil }
	h.running = []VectorStartup{{PID: 812, Command: append([]string{"/usr/bin/vector"}, args(h.conf)...), Source: "process", Service: "vector.service", EnvironmentKnown: true}}
	h.host = serviceHost{
		systemd: func() bool { return false },
		why:     func() string { return "systemd isn't running" },
		settle:  time.Millisecond,
		detectVector: func(context.Context) ([]RunningVector, bool) {
			var out []RunningVector
			for _, s := range h.running {
				out = append(out, RunningVector{PID: s.PID, Service: s.Service})
			}
			return out, true
		},
		collect: func(context.Context, []RunningVector) []VectorStartup { return h.running },
	}
	return h
}

func (h *adoptionHost) run() (SetupResult, error) {
	h.t.Helper()
	return setupWith(context.Background(), h.options, nativeService, h.host)
}

func (h *adoptionHost) replace() map[string]string {
	return map[string]string{h.dir: "<state>", h.managed: "<managed>", h.conf: "<conf>"}
}

// recordFolders lists the inventories kept in the state directory.
func (h *adoptionHost) recordFolders() []string {
	entries, _ := os.ReadDir(filepath.Join(h.dir, adoptionInventoryDir))
	var out []string
	for _, entry := range entries {
		out = append(out, filepath.Join(h.dir, adoptionInventoryDir, entry.Name()))
	}
	return out
}

func (h *adoptionHost) requireNothingInstalled() {
	h.t.Helper()
	if _, err := os.Stat(filepath.Join(h.dir, "settings.json")); !os.IsNotExist(err) {
		h.t.Fatal("setup installed the agent")
	}
	if h.tokens != 0 || h.server.enrolls.Load() != 0 {
		h.t.Fatalf("setup asked for the token (%d) or enrolled (%d) before it was allowed to", h.tokens, h.server.enrolls.Load())
	}
}

const twoFiles = "sinks: {}\n"

func configDirArgs(conf string) []string { return []string{"--config-dir", conf} }

func TestAdoptionBackupCopiesEveryFileWithItsChecksum(t *testing.T) {
	conf := t.TempDir()
	writeConfigFiles(t, conf, map[string]string{"10-sources.yaml": minimalYAML, "20-sinks.yaml": twoFiles, "sources/extra.json": `{"type":"x"}`})
	state := filepath.Join(t.TempDir(), "var", "vectory")
	inventory := InventoryVector([]VectorStartup{startup("-C", conf)})
	taken := time.Date(2026, 9, 30, 10, 15, 0, 0, time.UTC)
	if err := writeAdoptionBackup(state, &inventory, taken); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(state, adoptionInventoryDir, "20260930T101500Z")
	if inventory.BackupDir != folder || inventory.TakenAt != "2026-09-30T10:15:00Z" || inventory.AgentVersion != Version {
		t.Fatalf("%+v", inventory)
	}
	for _, file := range inventory.Files {
		if file.Backup == "" {
			t.Fatalf("no copy of %s", file.Path)
		}
		original, _ := os.ReadFile(file.Path)
		copied, err := os.ReadFile(filepath.Join(folder, file.Backup))
		if err != nil || string(copied) != string(original) || Digest(copied) != file.SHA256 {
			t.Fatalf("the copy of %s differs: %v", file.Path, err)
		}
	}
	names := map[string]bool{}
	for _, file := range inventory.Files {
		names[file.Backup] = true
	}
	if len(names) != 3 {
		t.Fatalf("copies of different files must not share a name: %v", names)
	}
	var record AdoptionInventory
	if err := ReadJSON(filepath.Join(folder, adoptionRecordName), &record); err != nil {
		t.Fatal(err)
	}
	if record.Fingerprint != inventory.Fingerprint || len(record.Files) != 3 || record.Files[0].SHA256 != inventory.Files[0].SHA256 || record.Files[0].Backup != inventory.Files[0].Backup {
		t.Fatalf("the record doesn't say what was copied: %+v", record)
	}
	// The state directory that holds it is still one setup may install into.
	if err := CheckFreshStateDirectory(state); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		for _, path := range []string{state, filepath.Join(state, adoptionInventoryDir), folder} {
			if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0700 {
				t.Fatalf("%s is %v: the copies can hold credentials", path, info.Mode())
			}
		}
		entries, _ := os.ReadDir(folder)
		for _, entry := range entries {
			if info, err := entry.Info(); err != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("%s is %v", entry.Name(), info.Mode())
			}
		}
	}

	// The same Vector again keeps the copies it has; a changed file is a new
	// inventory beside the old one.
	again := InventoryVector([]VectorStartup{startup("-C", conf)})
	if err := writeAdoptionBackup(state, &again, taken.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if again.BackupDir != folder || again.TakenAt != inventory.TakenAt || len(mustReadDir(t, filepath.Join(state, adoptionInventoryDir))) != 1 {
		t.Fatalf("an unchanged Vector was copied again: %+v", again)
	}
	writeConfigFiles(t, conf, map[string]string{"20-sinks.yaml": "sinks: {changed: {}}\n"})
	changed := InventoryVector([]VectorStartup{startup("-C", conf)})
	if err := writeAdoptionBackup(state, &changed, taken.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if changed.BackupDir == folder || len(mustReadDir(t, filepath.Join(state, adoptionInventoryDir))) != 2 {
		t.Fatalf("a changed file wasn't copied: %+v", changed)
	}
	if latest := latestAdoptionRecord(state); latest == nil || latest.BackupDir != changed.BackupDir {
		t.Fatalf("the newest inventory is the one a later run consults: %+v", latest)
	}
	if again, _ := os.ReadFile(filepath.Join(folder, inventory.Files[1].Backup)); string(again) != twoFiles {
		t.Fatal("the first inventory's copy was overwritten")
	}
}

func mustReadDir(t *testing.T, dir string) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

func TestAdoptionBackupRefusesADirectoryThatIsNotTheAgents(t *testing.T) {
	conf := t.TempDir()
	writeConfigFiles(t, conf, map[string]string{"vector.yaml": minimalYAML})
	state := t.TempDir()
	writeConfigFiles(t, state, map[string]string{"notes.txt": "somebody else's"})
	inventory := InventoryVector([]VectorStartup{startup("-c", filepath.Join(conf, "vector.yaml"))})
	if err := writeAdoptionBackup(state, &inventory, time.Now()); err == nil || !strings.Contains(err.Error(), "unrelated files") {
		t.Fatalf("copies were written into a directory that isn't a Vectory state directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(state, adoptionInventoryDir)); !os.IsNotExist(err) {
		t.Fatal("something was written there anyway")
	}
	// A folder without a record is a copy that never finished: passed over.
	other := t.TempDir()
	if err := os.MkdirAll(filepath.Join(other, adoptionInventoryDir, "20260101T000000Z"), 0700); err != nil {
		t.Fatal(err)
	}
	if record := latestAdoptionRecord(other); record != nil {
		t.Fatalf("%+v", record)
	}
	// A record that can't be read stops setup rather than being ignored.
	broken := filepath.Join(other, adoptionInventoryDir, "20260202T000000Z")
	if err := os.MkdirAll(broken, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(broken, adoptionRecordName), []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	record := latestAdoptionRecord(other)
	if record == nil || len(record.Blocking()) != 1 || record.Blocking()[0].Kind != "record_unreadable" || record.BackupDir != broken || !strings.Contains(record.Blocking()[0].Detail, broken) {
		t.Fatalf("%+v", record)
	}
}

func TestDescribeSaysHowVectorStartedAndWhereItsFilesAreBackedUp(t *testing.T) {
	sum := strings.Repeat("ab", 32)
	one := AdoptionInventory{
		Processes: []VectorStartup{{PID: 812, Command: []string{"/usr/bin/vector", "--config", "/etc/vector/vector.yaml"}, Source: "process", Service: "vector.service", ServiceCommand: []string{"/usr/bin/vector", "--config", "/etc/vector/vector.yaml"}}},
		Files:     []AdoptionFile{{Path: "/etc/vector/vector.yaml", SHA256: sum}},
		BackupDir: "/var/lib/vectory-agent/adoption-inventory/20260930T101500Z",
	}
	want := "Vector started with: /usr/bin/vector --config /etc/vector/vector.yaml; configuration files: /etc/vector/vector.yaml (sha256 abababababab…), backed up to /var/lib/vectory-agent/adoption-inventory/20260930T101500Z."
	if got := one.Describe(); got != want {
		t.Fatalf("%s", got)
	}
	// Without a copy (a dry run, or one that failed) it doesn't claim one.
	one.BackupDir = ""
	if got := one.Describe(); strings.Contains(got, "backed up") {
		t.Fatal(got)
	}
	// A service that starts Vector another way is shown; a process that couldn't
	// be read gives way to the service's definition, and says so.
	one.Processes[0].ServiceCommand = []string{"/usr/bin/vector", "--config-dir", "/etc/vector/conf.d"}
	if got := one.Describe(); !strings.Contains(got, "(vector.service defines: /usr/bin/vector --config-dir /etc/vector/conf.d)") {
		t.Fatal(got)
	}
	one.Processes[0].Source = "service"
	if got := one.Describe(); !strings.Contains(got, "(from the definition of vector.service, since the process itself couldn't be read)") {
		t.Fatal(got)
	}
	several := AdoptionInventory{
		Processes: []VectorStartup{{PID: 1, Command: []string{"vector", "-c", "/a.yaml"}}, {PID: 2, Command: []string{"vector", "-c", "/b.yaml"}}, {PID: 3}},
		Files:     []AdoptionFile{{Path: "/a.yaml", SHA256: sum}, {Path: "/b.yaml", Problem: "permission denied"}, {Path: "/big.yaml", Problem: "is larger than an inventory keeps", tooLarge: true}},
		BackupDir: "/state/adoption-inventory/x",
		Concerns:  []InventoryConcern{{Kind: "secret_backend", Detail: "/a.yaml uses secret backends (vault)."}, {Kind: "several_files", Blocks: true, Detail: "Vector loads 3 configuration files."}},
	}
	want = "Vector (pid 1) started with: vector -c /a.yaml\nVector (pid 2) started with: vector -c /b.yaml\nVector (pid 3) started with: (the host wouldn't say)\n" +
		"Configuration files: /a.yaml (sha256 abababababab…), /b.yaml (can't be read: permission denied), /big.yaml (is larger than an inventory keeps), backed up to /state/adoption-inventory/x.\n/a.yaml uses secret backends (vault)."
	if got := several.Describe(); got != want {
		t.Fatalf("%s\nwant\n%s", got, want)
	}
	if got := (AdoptionInventory{Processes: []VectorStartup{{PID: 1, Command: []string{"vector"}}}}).Describe(); got != "Vector started with: vector; configuration files: none found." {
		t.Fatal(got)
	}
}

// One plain file: the operator is told how Vector started, where its file is
// backed up, and the way to hand it over the setup has always offered.
func TestSetupRecordsAndBacksUpTheFileOfARunningVector(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"vector.yaml": minimalYAML}, func(conf string) []string { return []string{"--config", filepath.Join(conf, "vector.yaml")} })
	result, err := h.run()
	if err == nil || result.OK || stepStatus(result, "existing") != "fail" || stepStatus(result, "inventory") != "info" {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	h.requireNothingInstalled()
	assertGolden(t, "running-one-file", renderAdoption(result, h.replace()))
	adoption := result.Adoption
	if adoption == nil || len(adoption.Files) != 1 || adoption.Files[0].Backup == "" || len(adoption.Blocking()) != 0 || adoption.Acknowledged {
		t.Fatalf("%+v", adoption)
	}
	copied, err := os.ReadFile(filepath.Join(adoption.BackupDir, adoption.Files[0].Backup))
	if err != nil || string(copied) != minimalYAML || adoption.Files[0].SHA256 != Digest(copied) {
		t.Fatalf("backup: %q %v", copied, err)
	}
	if folders := h.recordFolders(); len(folders) != 1 || folders[0] != adoption.BackupDir {
		t.Fatalf("%v", folders)
	}
	// The result is what --json prints: nothing in it is secret, and it names
	// the checksum of every file.
	raw, err := json.Marshal(result)
	if err != nil || !strings.Contains(string(raw), `"adoption"`) || !strings.Contains(string(raw), Digest([]byte(minimalYAML))) {
		t.Fatalf("%s %v", raw, err)
	}
	// Setting up again over the same Vector doesn't make another copy.
	if _, err = h.run(); err == nil || len(h.recordFolders()) != 1 {
		t.Fatalf("%v %v", err, h.recordFolders())
	}
}

// A directory of several files: setup names them, says how to merge them or to
// adopt them as they are, and changes nothing but the copies.
func TestSetupRefusesAConfigDirectoryOfSeveralFilesAndNamesThem(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"10-sources.yaml": minimalYAML, "20-sinks.yaml": twoFiles}, configDirArgs)
	result, err := h.run()
	if err == nil || result.OK || stepStatus(result, "existing") != "fail" {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	h.requireNothingInstalled()
	assertGolden(t, "running-config-dir", renderAdoption(result, h.replace()))
	message := err.Error()
	for _, want := range []string{filepath.Join(h.conf, "10-sources.yaml"), filepath.Join(h.conf, "20-sinks.yaml"), "--adopt-existing", "Keep an existing workload", h.managed, stopVector()} {
		if !strings.Contains(message, want) {
			t.Errorf("the refusal doesn't say %q:\n%s", want, message)
		}
	}
	if adoption := result.Adoption; adoption == nil || len(adoption.Files) != 2 || len(adoption.Blocking()) == 0 || adoption.Blocking()[0].Kind != "several_files" {
		t.Fatalf("%+v", result.Adoption)
	}
	// Both files were copied before anything was said about them.
	for _, file := range result.Adoption.Files {
		if copied, err := os.ReadFile(filepath.Join(result.Adoption.BackupDir, file.Backup)); err != nil || Digest(copied) != file.SHA256 {
			t.Fatalf("%s wasn't backed up: %v", file.Path, err)
		}
	}
}

// --adopt-existing confirms the topology; it doesn't take over a Vector that
// still runs, and it doesn't skip the copy.
func TestAdoptExistingDoesNotTakeOverARunningVector(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"10-sources.yaml": minimalYAML, "20-sinks.yaml": twoFiles}, configDirArgs)
	h.options.AdoptExisting = true
	result, err := h.run()
	if err == nil || !strings.Contains(err.Error(), "Setup won't take it over") || strings.Contains(err.Error(), "adopting it would drop") {
		t.Fatalf("%v", err)
	}
	h.requireNothingInstalled()
	if result.Adoption == nil || !result.Adoption.Acknowledged || result.Adoption.BackupDir == "" || len(result.Adoption.Blocking()) == 0 {
		t.Fatalf("%+v", result.Adoption)
	}
	assertGolden(t, "running-config-dir-adopt", renderAdoption(result, h.replace()))
}

// The operator stops Vector and runs setup again. What was recorded still
// stands: the topology needs an explicit adoption, and giving it goes on to
// install. Merging the files into the managed one doesn't make that
// unnecessary, since setup can't see what the merge left out.
func TestSetupRemembersAConfigDirectoryAfterVectorStops(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"10-sources.yaml": minimalYAML, "20-sinks.yaml": twoFiles}, configDirArgs)
	first, err := h.run()
	if err == nil {
		t.Fatal("a running Vector was taken over")
	}
	folder := first.Adoption.BackupDir

	h.running = nil
	if err := os.MkdirAll(filepath.Dir(h.managed), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.managed, []byte(`{"sources":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := h.run()
	if err == nil || stepStatus(result, "existing") != "fail" {
		t.Fatalf("setup went ahead without the files being adopted: %+v %v", result.Steps, err)
	}
	h.requireNothingInstalled()
	assertGolden(t, "recorded-config-dir", renderAdoption(result, h.replace()))
	for _, want := range []string{filepath.Join(h.conf, "10-sources.yaml"), "--adopt-existing"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal doesn't say %q:\n%s", want, err)
		}
	}
	if strings.Contains(err.Error(), "systemctl") {
		t.Fatal("it tells the operator to stop a Vector that no longer runs")
	}

	h.options.AdoptExisting = true
	result, err = h.run()
	if err != nil || !result.OK || result.Device == nil || h.server.enrolls.Load() != 1 {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	assertGolden(t, "adopted-config-dir", renderAdoption(result, h.replace()))
	if result.Adoption == nil || !result.Adoption.Acknowledged || result.Adoption.BackupDir != folder {
		t.Fatalf("%+v", result.Adoption)
	}
	var record AdoptionInventory
	if err := ReadJSON(filepath.Join(folder, adoptionRecordName), &record); err != nil || !record.Acknowledged {
		t.Fatalf("the adoption wasn't recorded: %+v %v", record, err)
	}
	for _, file := range record.Files {
		if copied, err := os.ReadFile(filepath.Join(folder, file.Backup)); err != nil || Digest(copied) != file.SHA256 {
			t.Fatalf("the copy of %s changed: %v", file.Path, err)
		}
	}
	if _, err := os.Stat(filepath.Join(h.dir, "settings.json")); err != nil {
		t.Fatal("the agent isn't installed:", err)
	}
	// Once installed there is nothing left to adopt.
	again, err := h.run()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, step := range again.Steps {
		found = found || step.ID == "existing" && strings.Contains(step.Detail, "already set up")
	}
	if !found {
		t.Fatalf("--adopt-existing on an installed host wasn't explained: %+v", again.Steps)
	}
}

// A dry run says what a real one would do about a recorded topology, and
// writes nothing: the adoption isn't recorded either.
func TestDryRunOfAnAdoptionRecordsNothing(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"10-sources.yaml": minimalYAML, "20-sinks.yaml": twoFiles}, configDirArgs)
	first, err := h.run()
	if err == nil || first.Adoption == nil {
		t.Fatalf("%+v %v", first.Steps, err)
	}
	folder := first.Adoption.BackupDir
	h.running = nil
	h.options.DryRun = true
	if _, err := h.run(); err == nil || !strings.Contains(err.Error(), "--adopt-existing") {
		t.Fatalf("a dry run went ahead over a topology the agent wouldn't manage: %v", err)
	}
	h.options.AdoptExisting = true
	result, err := h.run()
	if err != nil || !result.OK || !result.DryRun || stepStatus(result, "install") != "plan" {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	var record AdoptionInventory
	if err := ReadJSON(filepath.Join(folder, adoptionRecordName), &record); err != nil || record.Acknowledged {
		t.Fatalf("a dry run recorded the adoption: %+v %v", record, err)
	}
	h.requireNothingInstalled()
	if len(h.recordFolders()) != 1 {
		t.Fatalf("%v", h.recordFolders())
	}
}

func TestSetupAfterAPlainVectorStopsNeedsNoAdoption(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"vector.yaml": minimalYAML}, func(conf string) []string { return []string{"--config", filepath.Join(conf, "vector.yaml")} })
	if _, err := h.run(); err == nil {
		t.Fatal("a running Vector was taken over")
	}
	h.running = nil
	result, err := h.run()
	if err != nil || !result.OK || h.server.enrolls.Load() != 1 {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	assertGolden(t, "recorded-one-file", renderAdoption(result, h.replace()))
	if result.Adoption == nil || result.Adoption.Acknowledged {
		t.Fatalf("%+v", result.Adoption)
	}
}

func TestSetupDryRunShowsTheInventoryAndCopiesNothing(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"10-sources.yaml": minimalYAML, "20-sinks.yaml": twoFiles}, configDirArgs)
	h.options.DryRun = true
	result, err := h.run()
	if err == nil || stepStatus(result, "inventory") != "info" {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	if _, statErr := os.Stat(h.dir); !os.IsNotExist(statErr) {
		t.Fatal("a dry run created the state directory")
	}
	if result.Adoption == nil || result.Adoption.BackupDir != "" || result.Adoption.Files[0].Backup != "" {
		t.Fatalf("%+v", result.Adoption)
	}
	assertGolden(t, "dry-run-config-dir", renderAdoption(result, h.replace()))
}

func TestKeepExistingVectorRecordsAndCopiesNothing(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"10-sources.yaml": minimalYAML, "20-sinks.yaml": twoFiles}, configDirArgs)
	h.options.KeepExistingVector = true
	result, err := h.run()
	if err != nil || !result.OK || result.Adoption != nil {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	if len(h.recordFolders()) != 0 {
		t.Fatal("a Vector that is left alone was copied")
	}
	for _, step := range result.Steps {
		if step.ID == "inventory" {
			t.Fatalf("%+v", step)
		}
	}
}

func TestAdoptAndKeepExistingContradictEachOther(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"vector.yaml": minimalYAML}, func(conf string) []string { return []string{"--config", filepath.Join(conf, "vector.yaml")} })
	h.options.AdoptExisting, h.options.KeepExistingVector = true, true
	result, err := h.run()
	if err == nil || !strings.Contains(err.Error(), "contradict") || stepStatus(result, "existing") != "fail" {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	h.requireNothingInstalled()
}

// Each way a running Vector's topology depends on more than the one file the
// agent manages stops setup and names what it found.
func TestSetupNamesEveryKindOfTopologyTheAgentWouldNotManage(t *testing.T) {
	dir := t.TempDir()
	writeConfigFiles(t, dir, map[string]string{
		"included.yaml": "include:\n  - extra.yaml\n" + minimalYAML,
		"provider.json": `{"provider":{"type":"http","url":"http://127.0.0.1:1/config"}}`,
		"plain.yaml":    minimalYAML,
	})
	at := func(name string) string { return filepath.Join(dir, name) }
	cases := []struct {
		name  string
		start VectorStartup
		want  []string
	}{
		{"include", startup("-c", at("included.yaml")), []string{"names other files with include (extra.yaml)", "something else assembles this configuration"}},
		{"provider", startup("-c", at("provider.json")), []string{"provider (http)", "which the agent doesn't manage"}},
		{"several files by a glob", startup("-c", at("*.yaml")), []string{"Vector loads 2 configuration files", "included.yaml", "plain.yaml"}},
		{"configuration chosen by the environment", func() VectorStartup {
			s := startup()
			s.Environment, s.Service = map[string]string{"VECTOR_CONFIG_DIR": dir}, "vector.service"
			return s
		}(), []string{"chosen by the VECTOR_CONFIG_DIR environment variable of vector.service", "doesn't pass"}},
		{"an environment that couldn't be read", func() VectorStartup {
			s := startup("-c", at("plain.yaml"))
			s.EnvironmentKnown = false
			return s
		}(), []string{"environment of Vector (pid 812) couldn't be read", "sudo"}},
		{"a command that couldn't be read", VectorStartup{PID: 812, Service: "vector.service"}, []string{"How Vector (pid 812) was started couldn't be read", "sudo"}},
		{"a relative path", startup("-c", "vector.yaml"), []string{"vector.yaml (-c) is relative, and the working directory of the process is unknown"}},
	}
	for _, c := range cases {
		h := newAdoptionHost(t, nil, func(string) []string { return nil })
		h.running = []VectorStartup{c.start}
		result, err := h.run()
		if err == nil || stepStatus(result, "existing") != "fail" {
			t.Errorf("%s: %+v %v", c.name, result.Steps, err)
			continue
		}
		for _, want := range append(c.want, "--adopt-existing") {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%s: the refusal doesn't say %q:\n%s", c.name, want, err)
			}
		}
		h.requireNothingInstalled()
	}
}

// Nothing is copied into a directory that isn't the agent's, and a copy that
// can't be made is said, not hidden; setup still stops.
func TestSetupSaysWhenTheConfigurationCouldNotBeCopied(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"vector.yaml": minimalYAML}, func(conf string) []string { return []string{"--config", filepath.Join(conf, "vector.yaml")} })
	if err := os.MkdirAll(h.dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.dir, "notes.txt"), []byte("not the agent's"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := h.run()
	if err == nil {
		t.Fatal("a running Vector was taken over")
	}
	var inventory SetupStep
	for _, step := range result.Steps {
		if step.ID == "inventory" {
			inventory = step
		}
	}
	if inventory.Status != "warn" || !strings.Contains(inventory.Fix, "Nothing was copied") || !strings.Contains(inventory.Fix, "unrelated files") || strings.Contains(inventory.Detail, "backed up") {
		t.Fatalf("%+v", inventory)
	}
	if _, err := os.Stat(filepath.Join(h.dir, adoptionInventoryDir)); !os.IsNotExist(err) {
		t.Fatal("copies were written into a directory that isn't the agent's")
	}
}

func TestSetupStopsForARecordItCannotRead(t *testing.T) {
	h := newAdoptionHost(t, map[string]string{"vector.yaml": minimalYAML}, func(conf string) []string { return []string{"--config", filepath.Join(conf, "vector.yaml")} })
	h.running = nil
	folder := filepath.Join(h.dir, adoptionInventoryDir, "20260101T000000Z")
	if err := os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, adoptionRecordName), []byte("{truncated"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := h.run()
	if err == nil || stepStatus(result, "existing") != "fail" || !strings.Contains(err.Error(), "can't be read") || !strings.Contains(err.Error(), "--adopt-existing") {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	h.requireNothingInstalled()
}
