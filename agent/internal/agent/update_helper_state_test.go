package agent

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The step's own files are frozen in generation 1 like the files it exchanges
// with the agent: testdata/update holds their bytes, and a test fails when a
// member is renamed, removed, added or retyped.

var stepFileKinds = []struct {
	name   string
	golden []string
	// back reads a file and writes it again.
	back func([]byte) ([]byte, error)
}{
	{"journal.json", []string{
		"journal.json", "journal-preparing.json", "journal-swapping.json", "journal-rolling-back.json",
		"journal-committed.json", "journal-rolled-back.json",
	}, func(b []byte) ([]byte, error) {
		j, err := parseUpdateJournal(b)
		if err != nil {
			return nil, err
		}
		return marshalUpdateJournal(j)
	}},
	{"counters.json", []string{"counters.json", "counters-empty.json", "counters-fork.json"}, func(b []byte) ([]byte, error) {
		c, err := parseUpdateCounters(b)
		if err != nil {
			return nil, err
		}
		return marshalUpdateCounters(c)
	}},
	{"installed.json", []string{"installed.json", "installed-after-update.json"}, func(b []byte) ([]byte, error) {
		i, err := parseUpdateInstalled(b)
		if err != nil {
			return nil, err
		}
		return marshalUpdateInstalled(i)
	}},
}

func TestEveryGoldenFileOfTheStepReadsAndWritesBackToTheSameBytes(t *testing.T) {
	for _, kind := range stepFileKinds {
		for _, name := range kind.golden {
			data := golden(t, name)
			out, err := kind.back(data)
			if err != nil {
				t.Errorf("%s: %v", name, err)
				continue
			}
			if !bytes.Equal(out, data) {
				t.Errorf("%s was read and written back as\n%s\nwant\n%s", name, out, data)
			}
		}
	}
}

func TestTheStepFilesGoldenCopiesAreTheContractsExamples(t *testing.T) {
	for _, name := range []string{"journal.json", "counters.json", "installed.json"} {
		contract := repoFile(t, "contracts/fixtures/agent-release/examples/"+name)
		if !bytes.Equal(contract, golden(t, name)) {
			t.Errorf("the contract's example %s differs from the frozen copy in testdata/update: the formats are fixed within a generation of the service definition, so change both only with a new generation", name)
		}
	}
}

func TestTheStepExamplesSayWhatTheContractSays(t *testing.T) {
	journal, err := parseUpdateJournal(golden(t, "journal.json"))
	if err != nil {
		t.Fatal(err)
	}
	if journal.Stage != UpdateStageTrial || journal.Release != goldenManifest || len(journal.Signers) != 1 || journal.Signers[0] != goldenKey || journal.Counter != 7 ||
		journal.From == nil || journal.From.Version != "0.1.0" || journal.To == nil || journal.To.SHA256 != goldenBuild || journal.To.Version != "0.1.1" ||
		!journal.StartedAt.Equal(time.Date(2026, 10, 5, 2, 14, 0, 0, time.UTC)) || !journal.Deadline.Equal(time.Date(2026, 10, 5, 2, 19, 9, 0, time.UTC)) ||
		journal.BootIDBefore != "f0e051603ad0e1b9440613ea81dffd1c38e05991027ca1d991c5df7d9705152e" || journal.Interruptions != 0 ||
		journal.Swap == nil || journal.Swap.Style != updateSwapRename || journal.Swap.Staged != ".vectory-update-7" || journal.Swap.Previous != ".vectory-previous" ||
		journal.Code != "" || !journal.FinishedAt.IsZero() || !journal.active() {
		t.Errorf("journal: %+v", journal)
	}
	preparing, err := parseUpdateJournal(golden(t, "journal-preparing.json"))
	if err != nil || preparing.Counter != 0 || preparing.From != nil || preparing.To != nil || preparing.Swap != nil || preparing.Signers == nil || len(preparing.Signers) != 0 || !preparing.active() {
		t.Errorf("a journal that has only accepted the request: %+v, %v", preparing, err)
	}
	for name, terminal := range map[string]bool{"journal-committed.json": true, "journal-rolled-back.json": true, "journal-swapping.json": false, "journal-rolling-back.json": false} {
		j, err := parseUpdateJournal(golden(t, name))
		if err != nil || j.active() == terminal {
			t.Errorf("%s: active %v, %v", name, j.active(), err)
		}
	}
	rolledBack, _ := parseUpdateJournal(golden(t, "journal-rolled-back.json"))
	if rolledBack.Code != "ROLLBACK_UNHEALTHY" || rolledBack.FinishedAt.IsZero() {
		t.Errorf("a rollback that left the previous build in place: %+v", rolledBack)
	}
	counters, err := parseUpdateCounters(golden(t, "counters.json"))
	if err != nil || counters.HighestCounters[goldenKey] != 7 || len(counters.HighestCounters) != 1 || counters.RolloverConflict != nil {
		t.Errorf("counters: %+v, %v", counters, err)
	}
	empty, err := parseUpdateCounters(golden(t, "counters-empty.json"))
	if err != nil || empty.HighestCounters == nil || len(empty.HighestCounters) != 0 {
		t.Errorf("no floors yet: %+v, %v", empty, err)
	}
	fork, err := parseUpdateCounters(golden(t, "counters-fork.json"))
	if err != nil || fork.RolloverConflict == nil || fork.RolloverConflict.From != goldenKey || fork.RolloverConflict.To[0] >= fork.RolloverConflict.To[1] {
		t.Errorf("a fork: %+v, %v", fork, err)
	}
	installed, err := parseUpdateInstalled(golden(t, "installed.json"))
	if err != nil || installed.Version != "0.1.0" || installed.Release != "" || installed.SHA256 != "ac1d6b41ffd3b5582fe7be77f89d6407263d0378965b759defb9b41919e26dec" ||
		!installed.RecordedAt.Equal(time.Date(2026, 10, 3, 12, 31, 2, 0, time.UTC)) {
		t.Errorf("installed: %+v, %v", installed, err)
	}
	after, err := parseUpdateInstalled(golden(t, "installed-after-update.json"))
	if err != nil || after.Release != goldenManifest || after.SHA256 != goldenBuild {
		t.Errorf("installed after an update: %+v, %v", after, err)
	}
}

// A renamed, removed, added, repeated or re-cased member is refused in every file,
// at the top and inside the objects they hold.
func TestEveryMemberOfEveryStepFileIsRequiredAndNothingElseIsAccepted(t *testing.T) {
	for _, kind := range stepFileKinds {
		for _, name := range kind.golden {
			top := parseObject(t, golden(t, name))
			check := func(what string, data []byte, want string) {
				t.Helper()
				if _, err := kind.back(data); err == nil || !strings.Contains(err.Error(), want) {
					t.Errorf("%s, %s: %v, want an error that says %q", name, what, err, want)
				}
			}
			for _, key := range top.keys {
				check("without "+key, top.without(key).bytes(), `lacks the member "`+key+`"`)
				check("with "+key+" renamed", top.renamed(key, key+"_x").bytes(), `has a member "`+key+`_x"`)
				check("with "+key+" in capitals", top.renamed(key, strings.ToUpper(key)).bytes(), `has a member "`+strings.ToUpper(key)+`"`)
				check("with "+key+" twice", top.duplicated(key), `has the member "`+key+`" twice`)
			}
			check("with another member", top.with("extra", "1").bytes(), `has a member "extra"`)
			for _, key := range top.keys {
				if len(top.values[key]) == 0 || top.values[key][0] != '{' || key == "highest_counters" {
					continue
				}
				inner := parseObject(t, top.values[key])
				for _, member := range inner.keys {
					check("without "+key+"."+member, top.with(key, strings.TrimSpace(string(inner.without(member).bytes()))).bytes(), `lacks the member "`+member+`"`)
					check(key+"."+member+" renamed", top.with(key, strings.TrimSpace(string(inner.renamed(member, member+"_x").bytes()))).bytes(), `has a member "`+member+`_x"`)
					check(key+"."+member+" in capitals", top.with(key, strings.TrimSpace(string(inner.renamed(member, strings.ToUpper(member)).bytes()))).bytes(), `has a member "`+strings.ToUpper(member)+`"`)
					check(key+"."+member+" twice", top.with(key, strings.TrimSuffix(string(inner.duplicated(member)), "\n")).bytes(), `twice`)
				}
				check("another member in "+key, top.with(key, strings.TrimSpace(string(inner.with("extra", "1").bytes()))).bytes(), `has a member "extra"`)
			}
		}
	}
}

func TestAStepFileThatIsNotOneObjectIsRefused(t *testing.T) {
	for _, kind := range stepFileKinds {
		good := golden(t, kind.golden[0])
		for what, data := range map[string][]byte{
			"empty":             nil,
			"an array":          []byte("[]\n"),
			"two objects":       append(append([]byte(nil), bytes.TrimSpace(good)...), good...),
			"text after it":     append(append([]byte(nil), good...), "x"...),
			"not UTF-8":         append(append([]byte(nil), bytes.TrimSpace(good)[:len(bytes.TrimSpace(good))-1]...), 0xff, '}'),
			"a different file":  []byte(`{"schema":"vectory.update-request.v1"}`),
			"the schema is old": []byte(strings.Replace(string(good), ".v1", ".v0", 1)),
		} {
			if _, err := kind.back(data); err == nil {
				t.Errorf("%s: %s was accepted", kind.name, what)
			}
		}
	}
}

func TestAJournalIsRefusedWhenItIsNotWhatTheStepCanActOn(t *testing.T) {
	trial := parseObject(t, golden(t, "journal.json"))
	preparing := parseObject(t, golden(t, "journal-preparing.json"))
	rolledBack := parseObject(t, golden(t, "journal-rolled-back.json"))
	for what, data := range map[string][]byte{
		"a stage that doesn't exist":                    trial.with("stage", `"waiting"`).bytes(),
		"a release that isn't a digest":                 trial.with("release", `"abc"`).bytes(),
		"a release in capitals":                         trial.with("release", `"`+strings.ToUpper(goldenManifest)+`"`).bytes(),
		"more than four signers":                        trial.with("signers", `["`+strings.Repeat("a", 64)+`","`+strings.Repeat("b", 64)+`","`+strings.Repeat("c", 64)+`","`+strings.Repeat("d", 64)+`","`+strings.Repeat("e", 64)+`"]`).bytes(),
		"a signer twice":                                trial.with("signers", `["`+goldenKey+`","`+goldenKey+`"]`).bytes(),
		"a signer that isn't a fingerprint":             trial.with("signers", `["team"]`).bytes(),
		"signers that are null":                         trial.with("signers", `null`).bytes(),
		"a counter of zero":                             trial.with("counter", `0`).bytes(),
		"a counter above 2^53-1":                        trial.with("counter", `9007199254740992`).bytes(),
		"a counter that isn't a whole number":           trial.with("counter", `7.5`).bytes(),
		"an exponent for a counter":                     trial.with("counter", `7e0`).bytes(),
		"a counter that is a string":                    trial.with("counter", `"7"`).bytes(),
		"an instant without its Z":                      trial.with("started_at", `"2026-10-05T02:14:00"`).bytes(),
		"an instant with a fraction":                    trial.with("started_at", `"2026-10-05T02:14:00.5Z"`).bytes(),
		"a deadline that isn't an instant":              trial.with("deadline", `"soon"`).bytes(),
		"a boot id that isn't 64 hex":                   trial.with("boot_id_before", `"abc"`).bytes(),
		"interruptions of two":                          trial.with("interruptions", `2`).bytes(),
		"negative interruptions":                        trial.with("interruptions", `-1`).bytes(),
		"a code that isn't an agent code":               trial.with("code", `"BROKEN"`).bytes(),
		"a version that isn't a version in to":          trial.with("to", `{"version":"0.1","sha256":"`+goldenBuild+`"}`).bytes(),
		"a digest that isn't a digest in from":          trial.with("from", `{"version":"0.1.0","sha256":"xyz"}`).bytes(),
		"a swap style that doesn't exist":               trial.with("swap", `{"style":"copy","staged":".a","previous":".b"}`).bytes(),
		"a swap that stages the file it keeps":          trial.with("swap", `{"style":"rename","staged":".a","previous":".a"}`).bytes(),
		"a swap name with a separator":                  trial.with("swap", `{"style":"rename","staged":"../a","previous":".b"}`).bytes(),
		"a swap name with a backslash":                  trial.with("swap", `{"style":"rename","staged":"a\\b","previous":".b"}`).bytes(),
		"an empty swap name":                            trial.with("swap", `{"style":"rename","staged":"","previous":".b"}`).bytes(),
		"a swap name of dots":                           trial.with("swap", `{"style":"rename","staged":"..","previous":".b"}`).bytes(),
		"a trial that doesn't know the builds":          trial.with("from", `null`).bytes(),
		"a trial without a counter":                     trial.with("counter", `null`).bytes(),
		"a trial without signers":                       trial.with("signers", `[]`).bytes(),
		"a trial without the swap":                      trial.with("swap", `null`).bytes(),
		"a trial without a deadline":                    trial.with("deadline", `null`).bytes(),
		"a swapping journal that has finished":          trial.with("stage", `"committed"`).bytes(),
		"a journal that rolled back without a reason":   rolledBack.with("code", `null`).bytes(),
		"a journal that rolled back and never finished": rolledBack.with("finished_at", `null`).bytes(),
		"a rollback that doesn't say why":               trial.with("stage", `"rolling_back"`).bytes(),
		"a journal that committed with a code":          parseObject(t, golden(t, "journal-committed.json")).with("code", `"NO_CHECK_IN"`).bytes(),
		"a preparing journal with a swap and no builds": preparing.with("swap", `{"style":"rename","staged":".a","previous":".b"}`).with("stage", `"swapping"`).bytes(),
		"a journal that doesn't say when it started":    preparing.with("started_at", `null`).bytes(),
	} {
		if _, err := parseUpdateJournal(data); err == nil {
			t.Errorf("%s was accepted:\n%s", what, data)
		}
	}
	// What the step writes while it prepares, before anything is known, is fine.
	for _, data := range [][]byte{preparing.bytes(), preparing.with("swap", `{"style":"rename","staged":".vectory-update-7","previous":".vectory-previous"}`).bytes()} {
		if _, err := parseUpdateJournal(data); err != nil {
			t.Errorf("a journal in preparing was refused: %v\n%s", err, data)
		}
	}
	if _, err := marshalUpdateJournal(updateJournal{Stage: UpdateStageSwapping, Release: goldenManifest, StartedAt: time.Now()}); err == nil {
		t.Error("a journal that a reader would refuse was written")
	}
}

func TestCounterFloorsAreBoundedLikeTheContractSaysAndNeverNegative(t *testing.T) {
	counters := parseObject(t, golden(t, "counters.json"))
	five := `{"` + strings.Repeat("a", 64) + `":1,"` + strings.Repeat("b", 64) + `":1,"` + strings.Repeat("c", 64) + `":1,"` + strings.Repeat("d", 64) + `":1,"` + strings.Repeat("e", 64) + `":1}`
	for what, data := range map[string][]byte{
		"five keys":                 counters.with("highest_counters", five).bytes(),
		"a key that isn't a hash":   counters.with("highest_counters", `{"team":7}`).bytes(),
		"a negative floor":          counters.with("highest_counters", `{"`+goldenKey+`":-1}`).bytes(),
		"a floor above 2^53-1":      counters.with("highest_counters", `{"`+goldenKey+`":9007199254740992}`).bytes(),
		"a fractional floor":        counters.with("highest_counters", `{"`+goldenKey+`":7.5}`).bytes(),
		"floors that are a list":    counters.with("highest_counters", `[]`).bytes(),
		"floors that are null":      counters.with("highest_counters", `null`).bytes(),
		"a fork that isn't a fork":  counters.with("rollover_conflict", `{"from":"`+goldenKey+`","to":["`+goldenKey+`","`+strings.Repeat("a", 64)+`"]}`).bytes(),
		"a fork in the wrong order": counters.with("rollover_conflict", `{"from":"`+goldenKey+`","to":["`+strings.Repeat("b", 64)+`","`+strings.Repeat("a", 64)+`"]}`).bytes(),
		"a fork with one successor": counters.with("rollover_conflict", `{"from":"`+goldenKey+`","to":["`+strings.Repeat("b", 64)+`"]}`).bytes(),
	} {
		if _, err := parseUpdateCounters(data); err == nil {
			t.Errorf("%s was accepted:\n%s", what, data)
		}
	}
	if _, err := parseUpdateCounters(counters.with("highest_counters", `{"`+goldenKey+`":9007199254740991}`).bytes()); err != nil {
		t.Errorf("the largest counter: %v", err)
	}
}

func TestInstalledRecordsAnythingTheBuildSaysItsVersionIsAndNothingThatIsntText(t *testing.T) {
	installed := parseObject(t, golden(t, "installed.json"))
	for _, version := range []string{`"0.1.0-dev"`, `"v0.1.0"`, `"0.1.10"`} {
		if _, err := parseUpdateInstalled(installed.with("version", version).bytes()); err != nil {
			t.Errorf("version %s: %v", version, err)
		}
	}
	for what, data := range map[string][]byte{
		"an empty version":         installed.with("version", `""`).bytes(),
		"a version with a newline": installed.with("version", `"0.1\n0"`).bytes(),
		"a version of 129 bytes":   installed.with("version", `"`+strings.Repeat("1", 129)+`"`).bytes(),
		"a digest in capitals":     installed.with("sha256", `"`+strings.ToUpper(goldenBuild)+`"`).bytes(),
		"a release that isn't":     installed.with("release", `"abc"`).bytes(),
		"a time without seconds":   installed.with("recorded_at", `"2026-10-03T12:31Z"`).bytes(),
	} {
		if _, err := parseUpdateInstalled(data); err == nil {
			t.Errorf("%s was accepted:\n%s", what, data)
		}
	}
}

// ---------------------------------------------------------------- reading and writing

func privateStepDir(t *testing.T) (*rootOwned, string) {
	t.Helper()
	root := ownTree(t)
	path := filepath.Join(root, "var", "lib", "vectory-update", "private")
	dir, err := ensureRootOwnedDir(path, rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dir.Close() })
	return dir, path
}

func TestTheStepsFilesAreWrittenAtomicallyAndPrivately(t *testing.T) {
	private, path := privateStepDir(t)
	if _, found, err := readUpdateJournal(private); found || err != nil {
		t.Fatalf("a journal that isn't there: found %v, %v", found, err)
	}
	if _, found, err := readUpdateInstalled(private); found || err != nil {
		t.Fatalf("an installed record that isn't there: found %v, %v", found, err)
	}
	counters, err := readUpdateCounters(private)
	if err != nil || counters.HighestCounters == nil || len(counters.HighestCounters) != 0 || counters.RolloverConflict != nil {
		t.Fatalf("counters that aren't there are empty: %+v, %v", counters, err)
	}

	journal, _ := parseUpdateJournal(golden(t, "journal.json"))
	if err := writeUpdateJournal(private, journal); err != nil {
		t.Fatal(err)
	}
	if err := writeUpdateCounters(private, updateCounters{HighestCounters: map[string]uint64{goldenKey: 7}}); err != nil {
		t.Fatal(err)
	}
	installed, _ := parseUpdateInstalled(golden(t, "installed.json"))
	if err := writeUpdateInstalled(private, installed); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{updateJournalFile, updateCountersFile, updateInstalledFile} {
		info, err := os.Stat(filepath.Join(path, name))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("%s: %v, %v", name, info, err)
		}
	}
	got, found, err := readUpdateJournal(private)
	if err != nil || !found || got.Stage != UpdateStageTrial || got.Counter != 7 || !got.StartedAt.Equal(journal.StartedAt) {
		t.Fatalf("the journal read back: %+v, %v, %v", got, found, err)
	}
	if floors, err := readUpdateCounters(private); err != nil || floors.HighestCounters[goldenKey] != 7 {
		t.Fatalf("the floors read back: %+v, %v", floors, err)
	}
	if record, found, err := readUpdateInstalled(private); err != nil || !found || record.SHA256 != installed.SHA256 {
		t.Fatalf("the record read back: %+v, %v, %v", record, found, err)
	}
	entries, _ := os.ReadDir(path)
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Errorf("a temporary file was left: %s", entry.Name())
		}
	}
}

func TestAStepFileThatIsLargerThanItsBoundOrDamagedIsAnErrorAndNeverAnIdleStep(t *testing.T) {
	private, path := privateStepDir(t)
	for _, name := range []string{updateJournalFile, updateCountersFile, updateInstalledFile} {
		if err := os.WriteFile(filepath.Join(path, name), bytes.Repeat([]byte("x"), maxUpdateStepFile+1), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, found, err := readUpdateJournal(private); err == nil || found {
		t.Errorf("a journal over its bound: found %v, %v", found, err)
	}
	if _, err := readUpdateCounters(private); err == nil {
		t.Error("counters over their bound were read")
	}
	if _, found, err := readUpdateInstalled(private); err == nil || found {
		t.Errorf("an installed record over its bound: found %v, %v", found, err)
	}
	for _, name := range []string{updateJournalFile, updateCountersFile, updateInstalledFile} {
		if err := os.WriteFile(filepath.Join(path, name), []byte("{"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, found, err := readUpdateJournal(private); err == nil || found {
		t.Errorf("a damaged journal is an idle step: found %v, %v", found, err)
	}
	if _, err := readUpdateCounters(private); err == nil {
		t.Error("damaged counters were read as no floors: a step that forgets its floors would try a release twice")
	}
}
