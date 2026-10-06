package agent

import (
	"encoding/json"
	"testing"
)

// componentIDFixture is vector-catalog/fixtures/component-ids.json: which
// component IDs and output names a device may report. The server's
// reported_component_id (server/src/validation.rs) reads the same file, so the
// two rules cannot drift: an ID one refuses and the other accepts costs the
// device its check-in.
type componentIDFixture struct {
	MaxBytes int `json:"max_bytes"`
	Cases    []struct {
		Name  string          `json:"name"`
		ID    json.RawMessage `json:"id"`
		Valid bool            `json:"valid"`
	} `json:"cases"`
}

func readComponentIDFixture(t *testing.T) componentIDFixture {
	t.Helper()
	var fixture componentIDFixture
	if err := json.Unmarshal(repoFile(t, "vector-catalog/fixtures/component-ids.json"), &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) < 40 {
		t.Fatalf("the fixture holds %d cases", len(fixture.Cases))
	}
	return fixture
}

func TestAReportableIDIsWhatTheSharedFixtureSays(t *testing.T) {
	fixture := readComponentIDFixture(t)
	if fixture.MaxBytes != maxComponentIDBytes {
		t.Fatalf("the fixture's longest ID is %d bytes, the agent's %d", fixture.MaxBytes, maxComponentIDBytes)
	}
	for _, c := range fixture.Cases {
		id := fixtureProgram(t, c.ID)
		if got := reportableID(id); got != c.Valid {
			t.Errorf("%s: reportableID(%q) = %v, the fixture says %v", c.Name, id, got, c.Valid)
		}
	}
}

// An ID is reported only when the pipeline names it too (the redactor learned
// it from the template) and the server's rule accepts it.
func TestIdentifierReportsATemplateIDByTheSameRule(t *testing.T) {
	for _, c := range readComponentIDFixture(t).Cases {
		id := fixtureProgram(t, c.ID)
		r := newRedactor()
		r.safe[id] = true
		want := ""
		if c.Valid {
			want = id
		}
		if got := r.identifier(id); got != want {
			t.Errorf("%s: identifier(%q) = %q, want %q", c.Name, id, got, want)
		}
		if got := newRedactor().identifier(id); got != "" {
			t.Errorf("%s: an ID the template doesn't name was reported: %q", c.Name, got)
		}
	}
}

// The policy check refuses a pipeline's path-like IDs (componentIDProblem), and
// the report rule is never more permissive: an ID a report allows is one the
// policy lets a pipeline name.
func TestNoReportableIDIsOneThePolicyRefuses(t *testing.T) {
	for _, c := range readComponentIDFixture(t).Cases {
		id := fixtureProgram(t, c.ID)
		if c.Valid && componentIDProblem(id) != "" {
			t.Errorf("%s: the fixture allows %q, which the policy refuses (%s)", c.Name, id, componentIDProblem(id))
		}
		if componentIDProblem(id) != "" && reportableID(id) {
			t.Errorf("%s: %q is a path to the policy and reportable", c.Name, id)
		}
	}
}

func TestAnInvalidUTF8IDIsNotReportable(t *testing.T) {
	// The server only sees valid UTF-8: this would arrive as the replacement
	// character, three bytes for one, and could pass the bound on the wire.
	if reportableID("a\xffb") {
		t.Fatal("an ID with an invalid byte is reportable")
	}
}
