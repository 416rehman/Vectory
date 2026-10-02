package agent

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
)

// fixtureFile is vector-catalog/fixtures/vrl-file-arguments.json: the programs
// every scanner of a VRL call that passes a file judges alike. The server's
// file_argument_calls and the dashboard's fileArgumentCalls read the same file.
type fixtureFile struct {
	Functions []struct {
		Function string `json:"function"`
		Argument string `json:"argument"`
		Position int    `json:"position"`
		Label    string `json:"label"`
	} `json:"functions"`
	Bounds struct {
		Calls      int `json:"calls"`
		CallBytes  int `json:"call_bytes"`
		ScanFactor int `json:"scan_factor"`
	} `json:"bounds"`
	Cases []struct {
		Name    string          `json:"name"`
		Program json.RawMessage `json:"program"`
		Found   []string        `json:"found"`
	} `json:"cases"`
}

func readFileArgumentFixture(t *testing.T) fixtureFile {
	t.Helper()
	var fixture fixtureFile
	if err := json.Unmarshal(repoFile(t, "vector-catalog/fixtures/vrl-file-arguments.json"), &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

// fixtureProgram is a program as the fixture writes it: a string, a list of
// programs joined together, or a program repeated.
func fixtureProgram(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []json.RawMessage
	if json.Unmarshal(raw, &parts) == nil {
		var program strings.Builder
		for _, part := range parts {
			program.WriteString(fixtureProgram(t, part))
		}
		return program.String()
	}
	var repeated struct {
		Repeat json.RawMessage `json:"repeat"`
		Times  int             `json:"times"`
	}
	if err := json.Unmarshal(raw, &repeated); err != nil || repeated.Repeat == nil || repeated.Times < 0 {
		t.Fatalf("not a program: %s", raw)
	}
	return strings.Repeat(fixtureProgram(t, repeated.Repeat), repeated.Times)
}

func labels(calls []fileArgumentFunction) []string {
	var found []string
	for _, call := range calls {
		found = append(found, call.label)
	}
	return found
}

func TestTheFileArgumentTableAndBoundsAreTheFixtures(t *testing.T) {
	fixture := readFileArgumentFixture(t)
	if len(fixture.Functions) != len(fileArgumentFunctions) {
		t.Fatalf("the fixture lists %d functions, the scanner %d", len(fixture.Functions), len(fileArgumentFunctions))
	}
	for i, want := range fixture.Functions {
		got := fileArgumentFunctions[i]
		if got.name != want.Function || got.argument != want.Argument || got.position != want.Position || got.label != want.Label {
			t.Errorf("function %d: the scanner has %+v, the fixture %+v", i, got, want)
		}
	}
	if fixture.Bounds.Calls != maxFileArgumentCalls || fixture.Bounds.CallBytes != maxCallBytes || fixture.Bounds.ScanFactor != maxScanFactor {
		t.Errorf("bounds: the scanner reads %d calls of %d bytes and %d times the program in all, the fixture %+v", maxFileArgumentCalls, maxCallBytes, maxScanFactor, fixture.Bounds)
	}
}

func TestEveryProgramOfTheSharedFixtureIsJudgedAsTheOtherScannersJudgeIt(t *testing.T) {
	fixture := readFileArgumentFixture(t)
	if len(fixture.Cases) < 60 {
		t.Fatalf("%d cases", len(fixture.Cases))
	}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if got := labels(fileArgumentCalls(fixtureProgram(t, c.Program))); !slices.Equal(got, c.Found) {
				t.Errorf("found %v, the fixture says %v", got, c.Found)
			}
		})
	}
}

// restrictedRemap is a pipeline with one remap step that runs program.
func restrictedRemap(t *testing.T, program string) []byte {
	t.Helper()
	config, err := json.Marshal(map[string]any{
		"sources":    map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json"}},
		"transforms": map[string]any{"t": map[string]any{"type": "remap", "inputs": []string{"in"}, "source": program}},
		"sinks":      map[string]any{"out": map[string]any{"type": "blackhole", "inputs": []string{"t"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return config
}

// The grok patterns of these programs hold no %{, which restricted mode refuses
// anywhere in a pipeline, so the call that passes a file is what is judged.
const (
	grokWithFile    = `.x = parse_groks!(.message, ["[a-z]+"], alias_sources: ["/etc/vector/aliases.json"])`
	grokByPosition  = `.x = parse_groks!(.message, ["[a-z]+"], {}, ["/etc/vector/aliases.json"])`
	grokWithoutFile = `.x = parse_groks!(.message, ["[a-z]+"], aliases: {"A": "[a-z]+"})`
	etldWithFile    = `.x = parse_etld!(.message, psl: "/etc/vector/list.dat")`
	etldByPosition  = `.x = parse_etld!(.message, 1, "/etc/vector/list.dat")`
	etldWithoutFile = `.x = parse_etld!(.message, plus_parts: 1)`
)

// A restricted device refuses a VRL program that passes a file to parse_groks
// or parse_etld, in every spelling, and accepts the same functions without one.
// A device in full mode accepts all of them: it runs the program for real.
func TestRestrictedModeRefusesAVRLCallThatPassesAFile(t *testing.T) {
	restricted, full := CapabilityPolicy{}, CapabilityPolicy{FullVectorConfig: true}
	for name, tc := range map[string]struct{ program, function, argument string }{
		"parse_groks, alias_sources by name":      {grokWithFile, "parse_groks", "alias_sources"},
		"parse_groks, the fourth argument":        {grokByPosition, "parse_groks", "alias_sources"},
		"parse_etld, psl by name":                 {etldWithFile, "parse_etld", "psl"},
		"parse_etld, the third argument":          {etldByPosition, "parse_etld", "psl"},
		"a call after a clean one":                {etldWithoutFile + "\n" + etldWithFile, "parse_etld", "psl"},
		"a call that reads differently by quotes": {`.x = parse_etld!(.message, r'\', psl: "/etc/vector/list.dat")`, "parse_etld", "psl"},
	} {
		config := restrictedRemap(t, tc.program)
		var refusal *PolicyRefusal
		err := restricted.Check(config)
		if !errors.As(err, &refusal) {
			t.Errorf("%s: accepted: %v", name, err)
			continue
		}
		want := "capability denied: VRL that reads a file (" + tc.function + " " + tc.argument + ")"
		if refusal.Code != "DYNAMIC_CAPABILITY_DENIED" || refusal.Error() != want || refusal.Resource != tc.function || refusal.Argument != tc.argument || refusal.Field != "source" || refusal.ComponentID != "t" {
			t.Errorf("%s: got %+v", name, refusal)
		}
		if err := full.Check(config); err != nil {
			t.Errorf("%s: refused in full mode: %v", name, err)
		}
	}
	for name, program := range map[string]string{
		"parse_groks without a file": grokWithoutFile,
		"parse_etld without a file":  etldWithoutFile,
		"parse_etld, the value only": `.x = parse_etld!(.message)`,
		"names that only look alike": `.parse_etld = 1
.note = "parse_groks and psl: are words"
.y = my_parse_etld(.message, 1, "x")`,
	} {
		config := restrictedRemap(t, program)
		for mode, policy := range map[string]CapabilityPolicy{"restricted": restricted, "full": full} {
			if err := policy.Check(config); err != nil {
				t.Errorf("%s, %s: refused: %v", name, mode, err)
			}
		}
	}
}

// The refusal says what is wrong and what to do, with the function and its
// argument; no allowance changes it, and the host's status says the same.
func TestTheFileArgumentRefusalNamesTheFunctionAndTheArgument(t *testing.T) {
	// An allowed file root does not make the file readable: Vector's own read is
	// what the policy can't judge.
	policy := CapabilityPolicy{AllowedFileRoots: []string{"/etc/vector"}}
	for _, tc := range []struct{ program, message, hint string }{
		{grokWithFile, `Transform "t" (remap) reads a file with parse_groks (alias_sources), which restricted mode doesn't allow.`, "Remove the alias_sources argument, or deploy to a full-mode device."},
		{etldWithFile, `Transform "t" (remap) reads a file with parse_etld (psl), which restricted mode doesn't allow.`, "Remove the psl argument, or deploy to a full-mode device."},
	} {
		err := policy.Check(restrictedRemap(t, tc.program))
		var refusal *PolicyRefusal
		if !errors.As(err, &refusal) {
			t.Fatalf("not a refusal: %v", err)
		}
		d := refusal.Diagnostic()
		if d.Code != "DYNAMIC_CAPABILITY_DENIED" || d.Message != tc.message || !strings.HasPrefix(d.Hint, tc.hint) || !strings.Contains(d.Hint, "No allowance on a restricted host can permit it.") {
			t.Errorf("diagnostic: %+v", d)
		}
		if d.ComponentKind != "transform" || d.ComponentID != "t" || d.Field != "source" {
			t.Errorf("where: %+v", d)
		}
		local := capabilityDiagnostic(err.Error())
		if local.Reason != "DYNAMIC_CAPABILITY_DENIED" || !strings.Contains(local.NextAction, "full-configuration trust grant") || strings.Contains(local.NextAction, "external VRL lookups") {
			t.Errorf("local diagnostic: %+v", local)
		}
	}
}

// The check holds wherever the agent already looks for VRL: any setting of a
// component, and the VRL of a unit test.
func TestAFileArgumentIsRefusedInEverySettingThatHoldsVRL(t *testing.T) {
	restricted := CapabilityPolicy{}
	const call = `parse_etld!(.d, psl: "/etc/vector/list.dat")`
	for name, tc := range map[string]struct{ config, field string }{
		"filter condition": {`{"transforms":{"f":{"type":"filter","inputs":["in"],"condition":"` + strings.ReplaceAll(call, `"`, `\"`) + ` == \"x\""}}}`, "condition"},
		"route condition":  {`{"transforms":{"r":{"type":"route","inputs":["in"],"route":{"a":"` + strings.ReplaceAll(call, `"`, `\"`) + ` == \"x\""}}}}`, "a"},
		"reduce condition": {`{"transforms":{"r":{"type":"reduce","inputs":["in"],"ends_when":"` + strings.ReplaceAll(call, `"`, `\"`) + ` == \"x\""}}}`, "ends_when"},
		"unit test":        {`{"tests":[{"name":"t","inputs":[],"outputs":[{"extract_from":"t","conditions":[{"type":"vrl","source":"` + strings.ReplaceAll(call, `"`, `\"`) + ` == \"x\""}]}]}]}`, "tests"},
	} {
		var refusal *PolicyRefusal
		err := restricted.Check([]byte(tc.config))
		if !errors.As(err, &refusal) || refusal.Code != "DYNAMIC_CAPABILITY_DENIED" || refusal.Resource != "parse_etld" || refusal.Argument != "psl" || refusal.Field != tc.field {
			t.Errorf("%s: got %v", name, err)
		}
		if err := (CapabilityPolicy{FullVectorConfig: true}).Check([]byte(tc.config)); err != nil {
			t.Errorf("%s: refused in full mode: %v", name, err)
		}
	}
	// The same step with the argument removed is as before.
	clean := `{"tests":[{"name":"t","inputs":[],"outputs":[{"extract_from":"t","conditions":[{"type":"vrl","source":"parse_etld!(.d, plus_parts: 1).etld == \"co.uk\""}]}]}]}`
	if err := restricted.Check([]byte(clean)); err != nil {
		t.Errorf("a test without a file refused: %v", err)
	}
}

// A program that holds both kinds is refused for the one the table of external
// functions names first, as before; the file argument never hides it.
func TestAnExternalFunctionIsStillNamedBeforeAFileArgument(t *testing.T) {
	program := `.k = get_env_var!("HOME")
.x = parse_etld!(.message, psl: "/etc/vector/list.dat")`
	var refusal *PolicyRefusal
	if err := (CapabilityPolicy{}).Check(restrictedRemap(t, program)); !errors.As(err, &refusal) || refusal.Resource != "get_env_var" || refusal.Argument != "" {
		t.Fatalf("got %v", err)
	}
	if d := refusal.Diagnostic(); d.Message != `Transform "t" (remap) calls get_env_var, which restricted mode doesn't allow.` {
		t.Errorf("message: %s", d.Message)
	}
}
