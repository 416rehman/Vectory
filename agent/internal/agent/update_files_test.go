package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// testdata/update holds the bytes of the files in generation 1 of the service
// definition: the contract's examples, and a few states they don't show. They are
// frozen. A build of a generation must read and write what every other build of
// it left, so a member that is renamed, removed, added or retyped needs a new
// generation, and a test below fails until the files here change on purpose.

func golden(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "update", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

const (
	goldenKey      = "05cc6c02351af0cb1be9877e7cdcd326c68310018746cb7bbbf6beb29392618b"
	goldenManifest = "01e2380259f57e6f0a7b7b2fca2b5882fcec1cab1a94c9a1d0dc00703f0367c8"
	goldenBuild    = "4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f"
)

// kinds describe each file for the tests that treat all of them alike.
var updateFileKinds = []struct {
	name   string
	golden []string
	parse  func([]byte) error
}{
	{"request.json", []string{"request.json"}, func(b []byte) error { _, err := ParseUpdateRequest(b); return err }},
	{"health.json", []string{"health.json", "health-no-offer.json"}, func(b []byte) error { _, err := ParseUpdateHealth(b); return err }},
	{"status.json", []string{"status.json", "status-idle.json", "status-rolled-back.json", "status-fork.json", "status-first-run.json"}, func(b []byte) error { _, err := ParseUpdateStatus(b); return err }},
	{"rollovers.json", []string{"rollovers.json", "rollovers-empty.json"}, func(b []byte) error { _, err := ParseUpdateRollovers(b); return err }},
}

func TestEveryGoldenFileReadsAndWritesBackToTheSameBytes(t *testing.T) {
	roundTrip := func(name string, data []byte, parseAndMarshal func([]byte) ([]byte, error)) {
		t.Helper()
		out, err := parseAndMarshal(data)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			return
		}
		if !bytes.Equal(out, data) {
			t.Errorf("%s was read and written back as\n%s\nwant\n%s", name, out, data)
		}
	}
	for _, name := range []string{"request.json"} {
		roundTrip(name, golden(t, name), func(b []byte) ([]byte, error) {
			v, err := ParseUpdateRequest(b)
			if err != nil {
				return nil, err
			}
			return MarshalUpdateRequest(v)
		})
	}
	for _, name := range []string{"health.json", "health-no-offer.json"} {
		roundTrip(name, golden(t, name), func(b []byte) ([]byte, error) {
			v, err := ParseUpdateHealth(b)
			if err != nil {
				return nil, err
			}
			return MarshalUpdateHealth(v)
		})
	}
	for _, name := range []string{"status.json", "status-idle.json", "status-rolled-back.json", "status-fork.json", "status-first-run.json"} {
		roundTrip(name, golden(t, name), func(b []byte) ([]byte, error) {
			v, err := ParseUpdateStatus(b)
			if err != nil {
				return nil, err
			}
			return MarshalUpdateStatus(v)
		})
	}
	for _, name := range []string{"rollovers.json", "rollovers-empty.json"} {
		roundTrip(name, golden(t, name), func(b []byte) ([]byte, error) {
			v, err := ParseUpdateRollovers(b)
			if err != nil {
				return nil, err
			}
			return MarshalUpdateRollovers(v)
		})
	}
}

// The contract's examples are the first files of generation 1. If one of them
// changes, so does a format that deployed builds already write: that needs a new
// generation, and the files here change with it.
func TestTheGoldenFilesAreTheContractsExamples(t *testing.T) {
	for _, name := range []string{"request.json", "health.json", "status.json", "rollovers.json", "policy.json"} {
		contract := repoFile(t, "contracts/fixtures/agent-release/examples/"+name)
		if !bytes.Equal(contract, golden(t, name)) {
			t.Errorf("the contract's example %s differs from the frozen copy in testdata/update: the formats are fixed within a generation of the service definition, so change both only with a new generation", name)
		}
	}
}

func TestTheExamplesSayWhatTheContractSays(t *testing.T) {
	request, err := ParseUpdateRequest(golden(t, "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	if request.ManifestSHA256 != goldenManifest || request.ArtifactSHA256 != goldenBuild || request.RolloutID != "c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4" ||
		!request.OfferedAt.Equal(time.Date(2026, 10, 4, 1, 58, 10, 0, time.UTC)) {
		t.Errorf("request: %+v", request)
	}
	health, err := ParseUpdateHealth(golden(t, "health.json"))
	if err != nil {
		t.Fatal(err)
	}
	if health.AgentSHA256 != goldenBuild || health.AgentVersion != "0.1.1" || health.Vector != UpdateVectorRunning || health.Offer != goldenManifest ||
		health.BootID != "80b04de2a7ab1621a71e84dcdb23ed4b341a6d6601ca299d53779f5ccba58fe1" ||
		!health.CheckedInAt.Equal(time.Date(2026, 10, 5, 2, 14, 11, 382_000_000, time.UTC)) {
		t.Errorf("health: %+v", health)
	}
	noOffer, err := ParseUpdateHealth(golden(t, "health-no-offer.json"))
	if err != nil || noOffer.Offer != "" || noOffer.Vector != UpdateVectorStopped {
		t.Errorf("health without an offer: %+v, %v", noOffer, err)
	}
	status, err := ParseUpdateStatus(golden(t, "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !status.RunAt.Equal(time.Date(2026, 10, 5, 2, 14, 12, 0, time.UTC)) || status.Stage != UpdateStageTrial || status.Eligibility != UpdateEligible ||
		status.ServiceDefinition != 1 || len(status.HighestCounters) != 1 || status.HighestCounters[goldenKey] != 7 || status.RolloverConflict != nil ||
		status.Release != goldenManifest || status.FromVersion != "0.1.0" || status.ToVersion != "0.1.1" ||
		!status.Deadline.Equal(time.Date(2026, 10, 5, 2, 19, 9, 0, time.UTC)) {
		t.Errorf("status: %+v", status)
	}
	last := status.Last
	if last == nil || last.Release != "36e42c85bd0a217e6d145ef4ec74d63ab34cc6e72a8133cd59b485d481f94833" || last.Outcome != UpdateOutcomeCommitted || last.Code != "" ||
		!last.At.Equal(time.Date(2026, 8, 12, 2, 9, 41, 0, time.UTC)) || last.FromVersion != "0.0.9" || last.ToVersion != "0.1.0" || last.FirstCheckInMS == nil || *last.FirstCheckInMS != 1900 {
		t.Errorf("last: %+v", last)
	}
	if got := last.ReleaseResult(); got.Release != last.Release || got.Outcome != "committed" {
		t.Errorf("ReleaseResult: %+v", got)
	}
	rolledBack, err := ParseUpdateStatus(golden(t, "status-rolled-back.json"))
	if err != nil || rolledBack.Last == nil || rolledBack.Last.Code != "NO_CHECK_IN" || rolledBack.Last.FirstCheckInMS != nil || rolledBack.Last.Outcome != UpdateOutcomeRolledBack {
		t.Errorf("a rolled back result: %+v, %v", rolledBack.Last, err)
	}
	fork, err := ParseUpdateStatus(golden(t, "status-fork.json"))
	if err != nil || fork.RolloverConflict == nil || fork.RolloverConflict.From != goldenKey || fork.RolloverConflict.To[0] >= fork.RolloverConflict.To[1] || fork.Last != nil {
		t.Errorf("a fork: %+v, %v", fork.RolloverConflict, err)
	}
	first, err := ParseUpdateStatus(golden(t, "status-first-run.json"))
	if err != nil || first.HighestCounters == nil || len(first.HighestCounters) != 0 || first.Eligibility != "PACKAGE_MANAGED" || !first.Deadline.IsZero() {
		t.Errorf("a first run: %+v, %v", first, err)
	}
	rollovers, err := ParseUpdateRollovers(golden(t, "rollovers.json"))
	if err != nil || len(rollovers) != 1 || rollovers[0].Statement == "" || rollovers[0].Signature == "" {
		t.Errorf("rollovers: %v, %v", rollovers, err)
	}
	empty, err := ParseUpdateRollovers(golden(t, "rollovers-empty.json"))
	if err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("no rollovers: %v, %v", empty, err)
	}
}

// ---------------------------------------------------------------- members

// object is a JSON object with the order of its members kept.
type object struct {
	keys   []string
	values map[string]json.RawMessage
}

func parseObject(t *testing.T, raw []byte) object {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		t.Fatalf("not an object: %s", raw)
	}
	o := object{values: map[string]json.RawMessage{}}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			t.Fatal(err)
		}
		key := token.(string)
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			t.Fatal(err)
		}
		o.keys = append(o.keys, key)
		o.values[key] = value
	}
	return o
}

func (o object) bytes() []byte {
	var out bytes.Buffer
	out.WriteByte('{')
	for i, key := range o.keys {
		if i > 0 {
			out.WriteByte(',')
		}
		name, _ := json.Marshal(key)
		out.Write(name)
		out.WriteByte(':')
		out.Write(o.values[key])
	}
	out.WriteString("}\n")
	return out.Bytes()
}

func (o object) without(key string) object {
	copied := object{values: map[string]json.RawMessage{}}
	for _, k := range o.keys {
		if k != key {
			copied.keys = append(copied.keys, k)
			copied.values[k] = o.values[k]
		}
	}
	return copied
}

func (o object) renamed(key, to string) object {
	copied := object{values: map[string]json.RawMessage{}}
	for _, k := range o.keys {
		name := k
		if k == key {
			name = to
		}
		copied.keys = append(copied.keys, name)
		copied.values[name] = o.values[k]
	}
	return copied
}

func (o object) with(key string, raw string) object {
	copied := object{keys: append([]string(nil), o.keys...), values: map[string]json.RawMessage{}}
	for k, v := range o.values {
		copied.values[k] = v
	}
	if _, present := copied.values[key]; !present {
		copied.keys = append(copied.keys, key)
	}
	copied.values[key] = json.RawMessage(raw)
	return copied
}

// duplicated repeats a member: the object holds it twice.
func (o object) duplicated(key string) []byte {
	text := string(o.bytes())
	name, _ := json.Marshal(key)
	return []byte("{" + string(name) + ":" + string(o.values[key]) + "," + text[1:])
}

// A renamed, removed, added, repeated or re-cased member is refused in every
// file, at the top and inside the objects they hold, whatever else is right.
func TestEveryMemberOfEveryFileIsRequiredAndNothingElseIsAccepted(t *testing.T) {
	for _, kind := range updateFileKinds {
		for _, name := range kind.golden {
			top := parseObject(t, golden(t, name))
			check := func(what string, data []byte, want string) {
				t.Helper()
				err := kind.parse(data)
				if err == nil || !strings.Contains(err.Error(), want) {
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
			// The members of the objects inside.
			for _, key := range top.keys {
				if len(top.values[key]) == 0 || top.values[key][0] != '{' {
					continue
				}
				inner := parseObject(t, top.values[key])
				for _, member := range inner.keys {
					if key == "highest_counters" {
						// A map: its keys are fingerprints, and a repeated one is refused.
						check("with "+member+" twice in "+key, top.with(key, strings.TrimSuffix(string(inner.duplicated(member)), "\n")).bytes(), "twice")
						continue
					}
					optional := member == "first_check_in_ms"
					if !optional {
						check("without "+key+"."+member, top.with(key, strings.TrimSpace(string(inner.without(member).bytes()))).bytes(), `lacks the member "`+member+`"`)
					}
					check(key+"."+member+" renamed", top.with(key, strings.TrimSpace(string(inner.renamed(member, member+"_x").bytes()))).bytes(), `has a member "`+member+`_x"`)
					check(key+"."+member+" in capitals", top.with(key, strings.TrimSpace(string(inner.renamed(member, strings.ToUpper(member)).bytes()))).bytes(), `has a member "`+strings.ToUpper(member)+`"`)
					check(key+"."+member+" twice", top.with(key, strings.TrimSuffix(string(inner.duplicated(member)), "\n")).bytes(), `twice`)
				}
				extra := `has a member "extra"`
				if key == "highest_counters" {
					extra = "isn't a fingerprint" // a map's keys are fingerprints, not members
				}
				check("another member in "+key, top.with(key, strings.TrimSpace(string(inner.with("extra", "1").bytes()))).bytes(), extra)
			}
		}
	}
}

func TestAMemberThatIsTheWrongKindOfValueIsRefused(t *testing.T) {
	status := parseObject(t, golden(t, "status.json"))
	for key, raw := range map[string]string{
		"schema": "1", "run_at": "1", "stage": "null", "eligibility": "[]", "service_definition": `"1"`, "highest_counters": "[]",
		"rollover_conflict": "1", "release": "1", "from_version": "[]", "to_version": "{}", "deadline": "5", "last": "[]",
	} {
		if _, err := ParseUpdateStatus(status.with(key, raw).bytes()); err == nil {
			t.Errorf("status.json with %s = %s was accepted", key, raw)
		}
	}
	for _, key := range []string{"stage", "eligibility", "service_definition", "highest_counters", "run_at", "schema"} {
		if _, err := ParseUpdateStatus(status.with(key, "null").bytes()); err == nil {
			t.Errorf("status.json with %s = null was accepted", key)
		}
	}
	request := parseObject(t, golden(t, "request.json"))
	for _, key := range request.keys {
		if _, err := ParseUpdateRequest(request.with(key, "null").bytes()); err == nil {
			t.Errorf("request.json with %s = null was accepted", key)
		}
		if _, err := ParseUpdateRequest(request.with(key, "7").bytes()); err == nil {
			t.Errorf("request.json with %s = 7 was accepted", key)
		}
	}
	health := parseObject(t, golden(t, "health.json"))
	for _, key := range health.keys {
		if key == "offer" {
			continue
		}
		if _, err := ParseUpdateHealth(health.with(key, "null").bytes()); err == nil {
			t.Errorf("health.json with %s = null was accepted", key)
		}
	}
	if _, err := ParseUpdateHealth(health.with("offer", "7").bytes()); err == nil {
		t.Error("health.json with offer = 7 was accepted")
	}
}

// ---------------------------------------------------------------- values

func TestAFileThatIsNotStrictJSONOfOneObjectIsRefused(t *testing.T) {
	good := golden(t, "request.json")
	for name, data := range map[string][]byte{
		"empty":             nil,
		"a byte order mark": append([]byte("\xef\xbb\xbf"), good...),
		"data after it":     append(append([]byte{}, good...), []byte(" {}")...),
		"two objects":       append(append([]byte{}, good...), good...),
		"an array":          []byte("[" + string(good) + "]"),
		"a string":          []byte(`"request"`),
		"not UTF-8":         bytes.Replace(good, []byte("c3a1d5e8"), []byte("c3\xffd5e8"), 1),
		"truncated":         good[:len(good)/2],
		"a comment":         append([]byte("// request\n"), good...),
		"a trailing comma":  bytes.Replace(good, []byte("}\n"), []byte(",}\n"), 1),
		"single quotes":     bytes.ReplaceAll(good, []byte(`"`), []byte("'")),
	} {
		if _, err := ParseUpdateRequest(data); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	// Spacing and a missing final line feed are only formatting.
	spaced := strings.ReplaceAll(strings.TrimSpace(string(good)), ",", ", ")
	if _, err := ParseUpdateRequest([]byte(spaced)); err != nil {
		t.Errorf("formatting changed what was accepted: %v", err)
	}
	if _, err := ParseUpdateRequest([]byte(" \n" + strings.TrimSpace(string(good)) + "\n\n")); err != nil {
		t.Errorf("white space around the object: %v", err)
	}
}

func TestUpdateRequestValues(t *testing.T) {
	request := parseObject(t, golden(t, "request.json"))
	for _, tc := range []struct{ member, value, want string }{
		{"schema", `"vectory.update-request.v2"`, "the schema is"},
		{"schema", `"vectory.update-health.v1"`, "the schema is"},
		{"manifest_sha256", `"` + strings.ToUpper(goldenManifest) + `"`, "manifest_sha256"},
		{"manifest_sha256", `"` + goldenManifest[:63] + `"`, "manifest_sha256"},
		{"manifest_sha256", `"` + goldenManifest + `0"`, "manifest_sha256"},
		{"manifest_sha256", `"` + strings.Repeat("g", 64) + `"`, "manifest_sha256"},
		{"manifest_sha256", `""`, "manifest_sha256"},
		{"artifact_sha256", `"../../etc/passwd"`, "artifact_sha256"},
		{"rollout_id", `"C3A1D5E8-6F0B-4A53-9A84-52D7F0A1B6E4"`, "rollout_id"},
		{"rollout_id", `"c3a1d5e86f0b4a539a8452d7f0a1b6e4"`, "rollout_id"},
		{"rollout_id", `"c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4x"`, "rollout_id"},
		{"rollout_id", `""`, "rollout_id"},
		{"offered_at", `"2026-10-04T01:58:10+00:00"`, "offered_at"},
		{"offered_at", `"2026-10-04T01:58:10.500Z"`, "offered_at"},
		{"offered_at", `"2026-10-04T01:58:10z"`, "offered_at"},
		{"offered_at", `"2026-10-04t01:58:10Z"`, "offered_at"},
		{"offered_at", `"2026-10-04 01:58:10Z"`, "offered_at"},
		{"offered_at", `"1969-12-31T23:59:59Z"`, "offered_at"},
		{"offered_at", `"2026-13-04T01:58:10Z"`, "offered_at"},
		{"offered_at", `"2026-02-30T01:58:10Z"`, "offered_at"},
		{"offered_at", `"2026-10-04T24:58:10Z"`, "offered_at"},
		{"offered_at", `"2026-10-04T01:60:10Z"`, "offered_at"},
		{"offered_at", `"2026-10-04T01:58:60Z"`, "offered_at"},
		{"offered_at", `"2026-10-04T01:58:10"`, "offered_at"},
		{"offered_at", `1791079090`, ""},
	} {
		_, err := ParseUpdateRequest(request.with(tc.member, tc.value).bytes())
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s = %s: %v, want an error that says %q", tc.member, tc.value, err, tc.want)
		}
	}
	// A rollout ID, a time at the ends of the ranges, and the years that bound it.
	for _, tc := range []struct{ member, value string }{
		{"rollout_id", `"00000000-0000-0000-0000-000000000000"`},
		{"offered_at", `"1970-01-01T00:00:00Z"`},
		{"offered_at", `"9999-12-31T23:59:59Z"`},
		{"offered_at", `"2028-02-29T12:00:00Z"`},
	} {
		if _, err := ParseUpdateRequest(request.with(tc.member, tc.value).bytes()); err != nil {
			t.Errorf("%s = %s: %v", tc.member, tc.value, err)
		}
	}
}

func TestUpdateHealthValues(t *testing.T) {
	health := parseObject(t, golden(t, "health.json"))
	for _, tc := range []struct{ member, value, want string }{
		{"agent_sha256", `"abc"`, "agent_sha256"},
		{"agent_version", `""`, "agent_version"},
		{"agent_version", `"` + strings.Repeat("v", 129) + `"`, "agent_version"},
		{"agent_version", `"0.1.1\u0000"`, "agent_version"},
		{"agent_version", `"0.1.1\n"`, "agent_version"},
		{"agent_version", "\"0.1.1\\u202e\"", "agent_version"},
		{"agent_version", "\"0.1.1\\u2028\"", "agent_version"},
		{"agent_version", "\"\\ufeff0.1.1\"", "agent_version"},
		{"agent_version", `"0.1.1\u007f"`, "agent_version"},
		{"agent_version", `"0.1.1\u0085"`, "agent_version"},
		{"boot_id", `"` + strings.ToUpper(goldenKey) + `"`, "boot_id"},
		{"boot_id", `"abc"`, "boot_id"},
		{"checked_in_at", `"2026-10-05T02:14:11Z"`, "checked_in_at"},
		{"checked_in_at", `"2026-10-05T02:14:11.38Z"`, "checked_in_at"},
		{"checked_in_at", `"2026-10-05T02:14:11.3820Z"`, "checked_in_at"},
		{"checked_in_at", `"2026-10-05T02:14:11,382Z"`, "checked_in_at"},
		{"checked_in_at", `"2026-10-05T02:14:11.382+00:00"`, "checked_in_at"},
		{"vector", `"Running"`, "vector"},
		{"vector", `"starting"`, "vector"},
		{"offer", `"` + strings.ToUpper(goldenManifest) + `"`, "offer"},
		{"offer", `"x"`, "offer"},
		{"offer", `""`, "offer"},
	} {
		_, err := ParseUpdateHealth(health.with(tc.member, tc.value).bytes())
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s = %s: %v, want an error that says %q", tc.member, tc.value, err, tc.want)
		}
	}
	for _, tc := range []struct{ member, value string }{
		{"agent_version", `"` + strings.Repeat("é", 64) + `"`}, // 128 bytes
		{"agent_version", `"0.1.1-rc.1+build 5"`},
		{"checked_in_at", `"2026-10-05T02:14:11.000Z"`},
		{"checked_in_at", `"9999-12-31T23:59:59.999Z"`},
		{"vector", `"none"`},
		{"offer", `null`},
	} {
		if _, err := ParseUpdateHealth(health.with(tc.member, tc.value).bytes()); err != nil {
			t.Errorf("%s = %s: %v", tc.member, tc.value, err)
		}
	}
}

func TestUpdateStatusValues(t *testing.T) {
	status := parseObject(t, golden(t, "status.json"))
	counters := func(text string) string { return `{` + text + `}` }
	for _, tc := range []struct{ member, value, want string }{
		{"stage", `"committed"`, "stage"},
		{"stage", `"Trial"`, "stage"},
		{"stage", `""`, "stage"},
		{"eligibility", `"ELIGIBLE"`, "eligibility"},
		{"eligibility", `"UPDATES_OFF"`, "eligibility"},
		{"eligibility", `"NO_SUCH_CODE"`, "eligibility"},
		{"service_definition", `0`, "service_definition"},
		{"service_definition", `1001`, "service_definition"},
		{"service_definition", `-1`, "service_definition"},
		{"service_definition", `1.0`, "service_definition"},
		{"service_definition", `1e0`, "service_definition"},
		{"service_definition", `01`, ""},
		{"highest_counters", `null`, "highest_counters"},
		{"highest_counters", counters(`"abc":1`), "highest_counters"},
		{"highest_counters", counters(`"` + strings.ToUpper(goldenKey) + `":1`), "highest_counters"},
		{"highest_counters", counters(`"` + goldenKey + `":-1`), ""},
		{"highest_counters", counters(`"` + goldenKey + `":9007199254740992`), "highest_counters"},
		{"highest_counters", counters(`"` + goldenKey + `":1.5`), ""},
		{"highest_counters", counters(`"` + goldenKey + `":1e3`), ""},
		{"highest_counters", counters(`"` + goldenKey + `":"7"`), ""},
		{"highest_counters", counters(strings.Join([]string{`"` + strings.Repeat("a", 64) + `":1`, `"` + strings.Repeat("b", 64) + `":1`, `"` + strings.Repeat("c", 64) + `":1`, `"` + strings.Repeat("d", 64) + `":1`, `"` + strings.Repeat("e", 64) + `":1`}, ",")), "highest_counters"},
		{"release", `"x"`, "release"},
		{"from_version", `""`, "from_version"},
		{"from_version", `"0.1.0\u0007"`, "from_version"},
		{"to_version", `"0.1"`, "to_version"},
		{"to_version", `"0.1.1-rc.1"`, "to_version"},
		{"to_version", `"00.1.1"`, "to_version"},
		{"to_version", `"0.1.1.1"`, "to_version"},
		{"to_version", `"0.1.1234567890"`, "to_version"},
		{"to_version", `"v0.1.1"`, "to_version"},
		{"to_version", `""`, "to_version"},
		{"deadline", `"2026-10-05T02:19:09.5Z"`, "deadline"},
		{"deadline", `"soon"`, "deadline"},
		{"run_at", `"2026-10-05T02:14:12.382Z"`, "run_at"},
		{"last", `{}`, "lacks the member"},
	} {
		_, err := ParseUpdateStatus(status.with(tc.member, tc.value).bytes())
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s = %s: %v, want an error that says %q", tc.member, tc.value, err, tc.want)
		}
	}
	for _, tc := range []struct{ member, value string }{
		{"stage", `"swapping"`},
		{"stage", `"rolling_back"`},
		{"eligibility", `"READ_ONLY"`},
		{"eligibility", `"PLATFORM_NOT_IN_RELEASE"`},
		{"service_definition", `1000`},
		{"highest_counters", `{"` + goldenKey + `":9007199254740991}`},
		{"highest_counters", `{"` + goldenKey + `":0}`},
		{"to_version", `"123456789.0.987654321"`},
		{"to_version", `null`},
		{"deadline", `null`},
		{"release", `null`},
		{"from_version", `"` + strings.Repeat("é", 64) + `"`},
	} {
		if _, err := ParseUpdateStatus(status.with(tc.member, tc.value).bytes()); err != nil {
			t.Errorf("%s = %s: %v", tc.member, tc.value, err)
		}
	}
}

func TestTheLastResultOfAStatus(t *testing.T) {
	status := parseObject(t, golden(t, "status.json"))
	last := parseObject(t, status.values["last"])
	with := func(member, value string) []byte {
		return status.with("last", strings.TrimSpace(string(last.with(member, value).bytes()))).bytes()
	}
	for _, tc := range []struct{ member, value, want string }{
		{"release", `"x"`, "last.release"},
		{"outcome", `"success"`, "last.outcome"},
		{"outcome", `"Committed"`, "last.outcome"},
		{"outcome", `"rolled_back"`, "last.code is missing"}, // the code is null
		{"code", `"START_FAILED"`, "last.code is set on a result that committed"},
		{"code", `"start_failed"`, "last.code"},
		{"code", `"NOT_A_CODE"`, "last.code"},
		{"code", `""`, "last.code"},
		{"at", `"2026-08-12T02:09:41.000Z"`, "last.at"},
		{"at", `"yesterday"`, "last.at"},
		{"from_version", `""`, "last.from_version"},
		{"from_version", `"0.0.9\n"`, "last.from_version"},
		{"to_version", `"1.2"`, "last.to_version"},
		{"first_check_in_ms", `86400001`, "last.first_check_in_ms"},
		{"first_check_in_ms", `-1`, ""},
		{"first_check_in_ms", `1.5`, ""},
		{"first_check_in_ms", `"1900"`, ""},
	} {
		_, err := ParseUpdateStatus(with(tc.member, tc.value))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("last.%s = %s: %v, want an error that says %q", tc.member, tc.value, err, tc.want)
		}
	}
	for _, tc := range []struct{ member, value string }{
		{"first_check_in_ms", `86400000`}, {"first_check_in_ms", `0`}, {"first_check_in_ms", `null`}, {"to_version", `null`},
	} {
		if _, err := ParseUpdateStatus(with(tc.member, tc.value)); err != nil {
			t.Errorf("last.%s = %s: %v", tc.member, tc.value, err)
		}
	}
	// Without the optional member.
	if _, err := ParseUpdateStatus(status.with("last", strings.TrimSpace(string(last.without("first_check_in_ms").bytes()))).bytes()); err != nil {
		t.Errorf("a result with no first check-in: %v", err)
	}
	// Every outcome with a code, and a result for each code.
	for _, outcome := range []string{"rolled_back", "failed", "refused"} {
		for code := range updateCodes {
			data := status.with("last", strings.TrimSpace(string(last.with("outcome", `"`+outcome+`"`).with("code", `"`+code+`"`).bytes()))).bytes()
			if _, err := ParseUpdateStatus(data); err != nil {
				t.Errorf("%s with %s: %v", outcome, code, err)
			}
		}
	}
}

func TestARolloverConflictNamesThreeDifferentKeysAndTheTwoSuccessorsInOrder(t *testing.T) {
	status := parseObject(t, golden(t, "status-fork.json"))
	a, b, c := "1"+strings.Repeat("0", 63), "2"+strings.Repeat("0", 63), "3"+strings.Repeat("0", 63)
	conflict := func(from, to string) []byte {
		return status.with("rollover_conflict", `{"from":"`+from+`","to":`+to+`}`).bytes()
	}
	for name, data := range map[string][]byte{
		"the successors descending":     conflict(a, `["`+c+`","`+b+`"]`),
		"the same successor twice":      conflict(a, `["`+b+`","`+b+`"]`),
		"a successor that is the key":   conflict(a, `["`+a+`","`+b+`"]`),
		"one successor":                 conflict(a, `["`+b+`"]`),
		"three successors":              conflict(a, `["`+b+`","`+c+`","`+c+`"]`),
		"no successors":                 conflict(a, `[]`),
		"a successor that isn't a key":  conflict(a, `["`+b+`","x"]`),
		"a key in capitals":             conflict(strings.ToUpper(goldenKey), `["`+b+`","`+c+`"]`),
		"successors as one string":      conflict(a, `"`+b+c+`"`),
		"a conflict that is an array":   status.with("rollover_conflict", `[]`).bytes(),
		"a conflict with a stray key":   status.with("rollover_conflict", `{"from":"`+a+`","to":["`+b+`","`+c+`"],"more":1}`).bytes(),
		"a conflict without its from":   status.with("rollover_conflict", `{"to":["`+b+`","`+c+`"]}`).bytes(),
		"a conflict with from twice":    status.with("rollover_conflict", `{"from":"`+a+`","from":"`+a+`","to":["`+b+`","`+c+`"]}`).bytes(),
		"a conflict with a fork of one": conflict(a, `["`+b+`",null]`),
	} {
		if _, err := ParseUpdateStatus(data); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if _, err := ParseUpdateStatus(conflict(a, `["`+b+`","`+c+`"]`)); err != nil {
		t.Errorf("a fork: %v", err)
	}
}

func TestUpdateRolloversValues(t *testing.T) {
	good := golden(t, "rollovers.json")
	rollovers := parseObject(t, good)
	envelope := func(statement, signature string) string {
		return `{"statement":"` + statement + `","signature":"` + signature + `"}`
	}
	signature := strings.Repeat("A", 86) + "=="
	for name, list := range map[string]string{
		"a statement that isn't base64":      "[" + envelope("!!!!", signature) + "]",
		"a statement of padding that is off": "[" + envelope("YQ", signature) + "]",
		"base64 with a newline":              "[" + envelope("YWJj\\nZGVm", signature) + "]",
		"base64 with unused bits set":        "[" + envelope("YR==", signature) + "]",
		"base64 in the URL alphabet":         "[" + envelope("-_-_", signature) + "]",
		"an empty statement":                 "[" + envelope("", signature) + "]",
		"a statement of 1025 bytes":          "[" + envelope(strings.Repeat("QUJD", 342)+"QQ==", signature) + "]",
		"a signature of 63 bytes":            "[" + envelope("YWJj", strings.Repeat("A", 84)) + "]",
		"a statement twice in a rollover":    `[{"statement":"YWJj","statement":"YWJj","signature":"` + signature + `"}]`,
		"a signature that isn't base64":      "[" + envelope("YWJj", strings.Repeat("!", 88)) + "]",
		"nine rollovers":                     "[" + strings.TrimSuffix(strings.Repeat(envelope("YWJj", signature)+",", 9), ",") + "]",
		"a rollover that is a string":        `["YWJj"]`,
		"a rollover with a stray member":     `[{"statement":"YWJj","signature":"` + signature + `","extra":1}]`,
		"a rollover without its signature":   `[{"statement":"YWJj"}]`,
		"rollovers that are null":            `null`,
		"rollovers that are an object":       `{}`,
	} {
		if _, err := ParseUpdateRollovers(rollovers.with("rollovers", list).bytes()); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	for name, list := range map[string]string{
		"eight rollovers":       "[" + strings.TrimSuffix(strings.Repeat(envelope("YWJj", signature)+",", 8), ",") + "]",
		"none":                  "[]",
		"the largest statement": "[" + envelope(strings.Repeat("QUJD", 341)+"QQ==", signature) + "]",
	} {
		if _, err := ParseUpdateRollovers(rollovers.with("rollovers", list).bytes()); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := ParseUpdateRollovers(rollovers.with("schema", `"vectory.update-rollovers.v2"`).bytes()); err == nil {
		t.Error("a schema this agent doesn't read was accepted")
	}
}

// ---------------------------------------------------------------- writers

func TestWritersNeverProduceAFileTheReadersRefuse(t *testing.T) {
	good := time.Date(2026, 10, 4, 1, 58, 10, 0, time.UTC)
	if _, err := MarshalUpdateRequest(UpdateRequest{ManifestSHA256: "x", ArtifactSHA256: goldenBuild, RolloutID: "c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4", OfferedAt: good}); err == nil {
		t.Error("a request with a manifest that isn't a digest was written")
	}
	if _, err := MarshalUpdateRequest(UpdateRequest{ManifestSHA256: goldenManifest, ArtifactSHA256: goldenBuild, RolloutID: "c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4"}); err == nil {
		t.Error("a request with no time was written")
	}
	if _, err := MarshalUpdateRequest(UpdateRequest{ManifestSHA256: goldenManifest, ArtifactSHA256: goldenBuild, RolloutID: "rollout 1", OfferedAt: good}); err == nil {
		t.Error("a request with a rollout that isn't a UUID was written")
	}
	if _, err := MarshalUpdateHealth(UpdateHealth{AgentSHA256: goldenBuild, AgentVersion: "0.1.1", BootID: goldenKey, CheckedInAt: good, Vector: "paused"}); err == nil {
		t.Error("a health record with a state of Vector that isn't one was written")
	}
	if _, err := MarshalUpdateHealth(UpdateHealth{AgentSHA256: goldenBuild, AgentVersion: "0.1.1\n", BootID: goldenKey, CheckedInAt: good, Vector: "running"}); err == nil {
		t.Error("a health record with a newline in the version was written")
	}
	if _, err := MarshalUpdateStatus(UpdateStatus{RunAt: good, Stage: "trial", Eligibility: "eligible", ServiceDefinition: 0}); err == nil {
		t.Error("a status with service definition 0 was written")
	}
	if _, err := MarshalUpdateStatus(UpdateStatus{RunAt: good, Stage: "idle", Eligibility: "eligible", ServiceDefinition: 1, Last: &UpdateLast{Release: goldenManifest, Outcome: "rolled_back", At: good, FromVersion: "0.1.0"}}); err == nil {
		t.Error("a rolled back result with no code was written")
	}
	if _, err := MarshalUpdateStatus(UpdateStatus{RunAt: good, Stage: "idle", Eligibility: "eligible", ServiceDefinition: 1, RolloverConflict: &RolloverConflict{From: goldenKey}}); err == nil {
		t.Error("a conflict with no successors was written")
	}
	if _, err := MarshalUpdateRollovers([]RolloverEnvelope{{Statement: "!", Signature: "!"}}); err == nil {
		t.Error("a rollover that isn't base64 was written")
	}
	if _, err := MarshalUpdateStatus(UpdateStatus{Stage: "idle", Eligibility: "eligible", ServiceDefinition: 1}); err == nil {
		t.Error("a status with no run time was written")
	}
	if _, err := MarshalUpdateStatus(UpdateStatus{RunAt: time.Date(1969, 1, 1, 0, 0, 0, 0, time.UTC), Stage: "idle", Eligibility: "eligible", ServiceDefinition: 1}); err == nil {
		t.Error("a status from 1969 was written")
	}
}

func TestWritersWriteEveryMemberAndSpellEmptyThingsAsTheContractDoes(t *testing.T) {
	status, err := MarshalUpdateStatus(UpdateStatus{RunAt: time.Date(2026, 10, 3, 12, 31, 2, 0, time.UTC), Stage: "idle", Eligibility: "PACKAGE_MANAGED", ServiceDefinition: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(status, golden(t, "status-first-run.json")) {
		t.Errorf("a status with nothing set:\n%s\nwant\n%s", status, golden(t, "status-first-run.json"))
	}
	if rollovers, err := MarshalUpdateRollovers(nil); err != nil || !bytes.Equal(rollovers, golden(t, "rollovers-empty.json")) {
		t.Errorf("no rollovers: %s, %v", rollovers, err)
	}
	// Times are written in UTC, in whole seconds (milliseconds for a check-in), whatever zone they came in.
	zone := time.FixedZone("test", 5*3600+1800)
	health, err := MarshalUpdateHealth(UpdateHealth{
		AgentSHA256: goldenBuild, AgentVersion: "0.1.1", BootID: goldenKey,
		CheckedInAt: time.Date(2026, 10, 5, 7, 44, 11, 382_999_999, zone), Vector: "running", Offer: goldenManifest,
	})
	if err != nil || !strings.Contains(string(health), `"checked_in_at":"2026-10-05T02:14:11.382Z"`) {
		t.Errorf("a check-in from another zone: %s, %v", health, err)
	}
	request, err := MarshalUpdateRequest(UpdateRequest{
		ManifestSHA256: goldenManifest, ArtifactSHA256: goldenBuild, RolloutID: "c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4",
		OfferedAt: time.Date(2026, 10, 4, 7, 28, 10, 900_000_000, zone),
	})
	if err != nil || !strings.Contains(string(request), `"offered_at":"2026-10-04T01:58:10Z"`) {
		t.Errorf("an offer from another zone: %s, %v", request, err)
	}
	if !strings.HasSuffix(string(request), "}\n") || strings.Contains(string(request), " ") {
		t.Errorf("a request is one line with no spaces: %q", request)
	}
	// Counters go out in order of their fingerprints.
	multi, err := MarshalUpdateStatus(UpdateStatus{
		RunAt: time.Date(2026, 10, 3, 12, 31, 2, 0, time.UTC), Stage: "idle", Eligibility: "eligible", ServiceDefinition: 1,
		HighestCounters: map[string]uint64{strings.Repeat("b", 64): 2, strings.Repeat("a", 64): 1, strings.Repeat("c", 64): 3},
	})
	if err != nil || strings.Index(string(multi), strings.Repeat("a", 64)) > strings.Index(string(multi), strings.Repeat("b", 64)) || strings.Index(string(multi), strings.Repeat("b", 64)) > strings.Index(string(multi), strings.Repeat("c", 64)) {
		t.Errorf("counters out of order: %s, %v", multi, err)
	}
}

// The heartbeat's `last` is the same object, so UpdateLast and RolloverConflict
// write and read themselves when they sit inside another value.
func TestTheLastResultAndTheConflictAreJSONValuesOfTheirOwn(t *testing.T) {
	type report struct {
		Last             *UpdateLast       `json:"last,omitempty"`
		RolloverConflict *RolloverConflict `json:"rollover_conflict"`
	}
	var parsed report
	data := []byte(`{"last":{"release":"` + goldenManifest + `","outcome":"failed","code":"PROBE_FAILED","at":"2026-10-05T02:14:12Z","from_version":"0.1.0","to_version":null},"rollover_conflict":null}`)
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Last == nil || parsed.Last.Code != "PROBE_FAILED" || parsed.Last.ToVersion != "" || parsed.RolloverConflict != nil {
		t.Fatalf("%+v", parsed)
	}
	again, err := json.Marshal(parsed)
	if err != nil || string(again) != string(data) {
		t.Errorf("written back as %s, %v", again, err)
	}
	if out, _ := json.Marshal(report{}); string(out) != `{"rollover_conflict":null}` {
		t.Errorf("an empty report: %s", out)
	}
	if err := json.Unmarshal([]byte(`{"last":{"release":"x"}}`), &parsed); err == nil {
		t.Error("a malformed last was accepted")
	}
	if err := json.Unmarshal([]byte(`{"last":{"release":"`+goldenManifest+`","release":"`+goldenManifest+`","outcome":"failed","code":"PROBE_FAILED","at":"2026-10-05T02:14:12Z","from_version":"0.1.0","to_version":null}}`), &parsed); err == nil {
		t.Error("a last with a repeated member was accepted")
	}
	if _, err := json.Marshal(UpdateLast{Release: "x"}); err == nil {
		t.Error("an invalid last was written")
	}
	ms := uint32(2100)
	out, err := json.Marshal(UpdateLast{Release: goldenManifest, Outcome: "committed", At: time.Date(2026, 10, 5, 2, 14, 30, 0, time.UTC), FromVersion: "0.1.0", ToVersion: "0.1.1", FirstCheckInMS: &ms})
	if err != nil || string(out) != `{"release":"`+goldenManifest+`","outcome":"committed","code":null,"at":"2026-10-05T02:14:30Z","from_version":"0.1.0","to_version":"0.1.1","first_check_in_ms":2100}` {
		t.Errorf("%s, %v", out, err)
	}
}

// ---------------------------------------------------------------- files on disk

func TestFilesOnDiskAreReadWithoutFollowingLinksAndWithinTheirBound(t *testing.T) {
	dir := realTempDir(t)
	good := filepath.Join(dir, "health.json")
	if err := os.WriteFile(good, golden(t, "health.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if h, err := ReadUpdateHealth(good); err != nil || h.AgentVersion != "0.1.1" {
		t.Fatalf("%+v, %v", h, err)
	}
	if _, err := ReadUpdateHealth(filepath.Join(dir, "missing.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a missing file: %v", err)
	}
	// A file longer than 4 KiB is refused unread.
	big := filepath.Join(dir, "big.json")
	if err := os.WriteFile(big, append(golden(t, "health.json"), bytes.Repeat([]byte(" "), MaxUpdateFile)...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadUpdateHealth(big); err == nil || !strings.Contains(err.Error(), "larger than its bound (4096 bytes)") {
		t.Errorf("a file of 4 KiB and more: %v", err)
	}
	exact := filepath.Join(dir, "exact.json")
	padded := append(bytes.TrimSpace(golden(t, "health.json")), bytes.Repeat([]byte(" "), MaxUpdateFile-len(bytes.TrimSpace(golden(t, "health.json"))))...)
	if len(padded) != MaxUpdateFile {
		t.Fatal(len(padded))
	}
	if err := os.WriteFile(exact, padded, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadUpdateHealth(exact); err != nil {
		t.Errorf("a file of exactly 4 KiB: %v", err)
	}
	// A symbolic link at the end of the path, or in the middle of it.
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(good, link); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	if _, err := ReadUpdateHealth(link); err == nil {
		t.Error("a symbolic link was followed")
	}
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(realDir, "request.json"), golden(t, "request.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkedDir := filepath.Join(dir, "linked")
	if err := os.Symlink(realDir, linkedDir); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadUpdateRequest(filepath.Join(linkedDir, "request.json")); err == nil {
		t.Error("a file in a symbolic link to a directory was read")
	}
	if _, err := ReadUpdateRequest(filepath.Join(realDir, "request.json")); err != nil {
		t.Errorf("the same file by its real path: %v", err)
	}
	// A directory, and a file that holds something else.
	if _, err := ReadUpdateHealth(realDir); err == nil {
		t.Error("a directory was read as a file")
	}
	other := filepath.Join(dir, "other.json")
	if err := os.WriteFile(other, golden(t, "request.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadUpdateHealth(other); err == nil || !strings.Contains(err.Error(), other) {
		t.Errorf("a request read as a health record: %v", err)
	}
}

func TestWritersWriteTheServiceAccountsFilesAtomically(t *testing.T) {
	dir := realTempDir(t)
	good := time.Date(2026, 10, 4, 1, 58, 10, 0, time.UTC)
	request := UpdateRequest{ManifestSHA256: goldenManifest, ArtifactSHA256: goldenBuild, RolloutID: "c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4", OfferedAt: good}
	path := filepath.Join(dir, "request.json")
	for i := 0; i < 2; i++ {
		if err := WriteUpdateRequest(path, request); err != nil {
			t.Fatal(err)
		}
	}
	if data, _ := os.ReadFile(path); !bytes.Equal(data, golden(t, "request.json")) {
		t.Errorf("the request on disk:\n%s", data)
	}
	if got, err := ReadUpdateRequest(path); err != nil || got.ManifestSHA256 != request.ManifestSHA256 || got.ArtifactSHA256 != request.ArtifactSHA256 || got.RolloutID != request.RolloutID || !got.OfferedAt.Equal(request.OfferedAt) {
		t.Errorf("read back %+v, %v", got, err)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("the request's mode: %v, %v", info, err)
		}
	}
	health := UpdateHealth{AgentSHA256: goldenBuild, AgentVersion: "0.1.1", BootID: "80b04de2a7ab1621a71e84dcdb23ed4b341a6d6601ca299d53779f5ccba58fe1", CheckedInAt: time.Date(2026, 10, 5, 2, 14, 11, 382_000_000, time.UTC), Vector: "running", Offer: goldenManifest}
	if err := WriteUpdateHealth(filepath.Join(dir, "health.json"), health); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadUpdateHealth(filepath.Join(dir, "health.json")); err != nil || got.AgentSHA256 != health.AgentSHA256 || got.AgentVersion != health.AgentVersion || got.BootID != health.BootID ||
		!got.CheckedInAt.Equal(health.CheckedInAt) || got.Vector != health.Vector || got.Offer != health.Offer {
		t.Errorf("read back %+v, %v", got, err)
	}
	envelopes := []RolloverEnvelope{{Statement: "YWJj", Signature: strings.Repeat("A", 86) + "=="}}
	if err := WriteUpdateRollovers(filepath.Join(dir, "rollovers.json"), envelopes); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadUpdateRollovers(filepath.Join(dir, "rollovers.json")); err != nil || len(got) != 1 || got[0] != envelopes[0] {
		t.Errorf("read back %+v, %v", got, err)
	}
	// A refusal leaves what was there.
	if err := WriteUpdateRequest(path, UpdateRequest{}); err == nil {
		t.Error("an empty request was written")
	}
	if data, _ := os.ReadFile(path); !bytes.Equal(data, golden(t, "request.json")) {
		t.Error("a refused write changed the file")
	}
	if err := WriteUpdateRequest(filepath.Join(dir, "missing", "request.json"), request); err == nil {
		t.Error("a request was written into a directory that isn't there")
	}
}

func TestStatusIsReadThroughThePathCheckAndWrittenReadableByEveryone(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	if _, err := ReadUpdateStatus(); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a step that never ran: %v", err)
	}
	dir, err := ensureRootOwnedDir(paths.StepDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	want := UpdateStatus{
		RunAt: time.Date(2026, 10, 5, 2, 14, 12, 0, time.UTC), Stage: UpdateStageTrial, Eligibility: UpdateEligible, ServiceDefinition: 1,
		HighestCounters: map[string]uint64{goldenKey: 7}, Release: goldenManifest, FromVersion: "0.1.0", ToVersion: "0.1.1",
		Deadline: time.Date(2026, 10, 5, 2, 19, 9, 0, time.UTC),
	}
	if err := WriteUpdateStatus(dir, want); err != nil {
		t.Fatal(err)
	}
	got, err := ReadUpdateStatus()
	if err != nil {
		t.Fatal(err)
	}
	if got.Stage != want.Stage || got.HighestCounters[goldenKey] != 7 || !got.Deadline.Equal(want.Deadline) || got.Release != goldenManifest || got.Last != nil {
		t.Errorf("read back %+v", got)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(paths.Status); err != nil || info.Mode().Perm() != 0o644 {
			t.Errorf("status.json's mode: %v, %v", info, err)
		}
	}
	// A status written by an account that isn't root's is not believed.
	if err := os.Chmod(paths.Status, 0o666); err == nil && runtime.GOOS != "windows" {
		if _, err := ReadUpdateStatus(); err == nil {
			t.Error("a status that everyone can write was read")
		} else {
			refusedAs(t, err)
		}
	}
	if err := WriteUpdateStatus(dir, UpdateStatus{Stage: "idle"}); err == nil {
		t.Error("an invalid status was written")
	}
}

func TestTheExchangeLivesInsideTheStateDirectory(t *testing.T) {
	state := filepath.Join(string(filepath.Separator), "var", "lib", "vectory-agent")
	exchange := UpdateExchangeFor(state)
	if exchange.Dir != filepath.Join(state, "updates") || exchange.Request != filepath.Join(state, "updates", "request.json") ||
		exchange.Health != filepath.Join(state, "updates", "health.json") || exchange.Incoming != filepath.Join(state, "updates", "incoming") {
		t.Errorf("%+v", exchange)
	}
	dir, err := exchange.IncomingDir(goldenManifest)
	if err != nil || dir != filepath.Join(state, "updates", "incoming", goldenManifest) {
		t.Errorf("%q, %v", dir, err)
	}
	for _, name := range []string{"", "../..", goldenManifest[:63], strings.ToUpper(goldenManifest), goldenManifest + "/..", "x/" + goldenManifest[:62]} {
		if _, err := exchange.IncomingDir(name); err == nil {
			t.Errorf("IncomingDir(%q) was accepted", name)
		}
	}
	if UpdateBuildFile("linux") != "vectory" || UpdateBuildFile("darwin") != "vectory" || UpdateBuildFile("windows") != "vectory.exe" {
		t.Error("the staged build's name")
	}
	for name, want := range map[string]string{
		UpdateRequestFile: "request.json", UpdateHealthFile: "health.json", UpdateRolloversFile: "rollovers.json",
		UpdateReleaseFile: "release.json", UpdateSignaturesFile: "release.json.sig", UpdateBuildPartFile: "vectory.part",
	} {
		if name != want {
			t.Errorf("a file name is %q, want %q", name, want)
		}
	}
}

// ---------------------------------------------------------------- the contract

func TestTheEnumerationsAndBoundsAreTheContractsSchema(t *testing.T) {
	var schema struct {
		Defs map[string]struct {
			Properties map[string]json.RawMessage `json:"properties"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(repoFile(t, "contracts/protocol.schema.json"), &schema); err != nil {
		t.Fatal(err)
	}
	property := func(def, name string) json.RawMessage {
		t.Helper()
		raw, ok := schema.Defs[def].Properties[name]
		if !ok {
			t.Fatalf("the schema has no %s.%s", def, name)
		}
		return raw
	}
	enum := func(raw json.RawMessage) []string {
		t.Helper()
		var direct struct {
			Enum  []string `json:"enum"`
			AnyOf []struct {
				Enum []string `json:"enum"`
			} `json:"anyOf"`
		}
		if err := json.Unmarshal(raw, &direct); err != nil {
			t.Fatal(err)
		}
		if direct.Enum != nil {
			return direct.Enum
		}
		for _, branch := range direct.AnyOf {
			if branch.Enum != nil {
				return branch.Enum
			}
		}
		t.Fatalf("no enumeration in %s", raw)
		return nil
	}
	same := func(what string, got []string, schemaValues []string) {
		t.Helper()
		if len(got) != len(schemaValues) {
			t.Errorf("%s: the agent has %d values, the schema %d", what, len(got), len(schemaValues))
		}
		for _, value := range schemaValues {
			if !oneOf(value, got) {
				t.Errorf("%s: the schema has %q and the agent doesn't", what, value)
			}
		}
	}
	codes := make([]string, 0, len(updateCodes))
	for code := range updateCodes {
		codes = append(codes, code)
	}
	same("agent codes", codes, enum(property("AgentUpdateLast", "code")))
	same("journal codes", codes, enum(property("UpdateJournal", "code")))
	same("stages", updateStages, enum(property("UpdateStatus", "stage")))
	same("eligibility", updateEligibilities, enum(property("UpdateStatus", "eligibility")))
	same("outcomes", updateOutcomes, enum(property("AgentUpdateLast", "outcome")))
	same("Vector states", updateVectors, enum(property("UpdateHealth", "vector")))

	type schemaBounds struct {
		Minimum    *int64 `json:"minimum"`
		Maximum    *int64 `json:"maximum"`
		MaxItems   *int   `json:"maxItems"`
		MaxProps   *int   `json:"maxProperties"`
		MaxLength  *int   `json:"maxLength"`
		Additional struct {
			Maximum *int64 `json:"maximum"`
		} `json:"additionalProperties"`
	}
	var bounds schemaBounds
	read := func(def, name string) {
		t.Helper()
		bounds = schemaBounds{}
		if err := json.Unmarshal(property(def, name), &bounds); err != nil {
			t.Fatal(err)
		}
	}
	read("UpdateStatus", "service_definition")
	if bounds.Minimum == nil || *bounds.Minimum != 1 || bounds.Maximum == nil || *bounds.Maximum != maxUpdateServiceGeneration {
		t.Errorf("service_definition: the schema says %v to %v", bounds.Minimum, bounds.Maximum)
	}
	read("AgentUpdateLast", "first_check_in_ms")
	if bounds.Minimum == nil || *bounds.Minimum != 0 || bounds.Maximum == nil || *bounds.Maximum != maxFirstCheckInMS {
		t.Errorf("first_check_in_ms: the schema says %v to %v", bounds.Minimum, bounds.Maximum)
	}
	read("UpdateStatus", "highest_counters")
	if bounds.MaxProps == nil || *bounds.MaxProps != maxUpdateFingerprints || bounds.Additional.Maximum == nil || uint64(*bounds.Additional.Maximum) != MaxJSONCounter {
		t.Errorf("highest_counters: the schema says %v properties, counters up to %v", bounds.MaxProps, bounds.Additional.Maximum)
	}
	read("UpdateRollovers", "rollovers")
	if bounds.MaxItems == nil || *bounds.MaxItems != maxUpdateEnvelopes {
		t.Errorf("rollovers: the schema says %v items", bounds.MaxItems)
	}
	read("UpdateHealth", "agent_version")
	if bounds.MaxLength == nil || *bounds.MaxLength != maxUpdateVersionBytes {
		t.Errorf("agent_version: the schema says %v", bounds.MaxLength)
	}
	// The contract writes the members in the order the struct declares them.
	for _, kind := range []struct {
		def  string
		file string
		wire any
	}{
		{"UpdateRequest", "request.json", updateRequestWire{}},
		{"UpdateHealth", "health.json", updateHealthWire{}},
		{"UpdateStatus", "status.json", updateStatusWire{}},
		{"UpdateRollovers", "rollovers.json", updateRolloversWire{}},
	} {
		example := parseObject(t, golden(t, kind.file))
		out, err := json.Marshal(kind.wire)
		if err != nil {
			t.Fatal(err)
		}
		written := parseObject(t, out)
		if strings.Join(written.keys, ",") != strings.Join(example.keys, ",") {
			t.Errorf("%s: the members are written in the order %v, and the contract's example has %v", kind.file, written.keys, example.keys)
		}
		for key := range schema.Defs[kind.def].Properties {
			if _, ok := written.values[key]; !ok {
				t.Errorf("%s: the schema has the member %q and the agent doesn't write it", kind.file, key)
			}
		}
	}
}
