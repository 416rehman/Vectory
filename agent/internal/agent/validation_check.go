package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// runValidation checks the candidate on this device and returns what it found.
// It returns nil when the check was cut short and there is nothing true to say:
// the agent is stopping, or a test hook ended it. Every step that can fail ends
// in a diagnostic, with the same wording and redaction as an apply's, and a
// check that finds anything wrong is not valid. The steps are the apply's, in
// its order:
//
//  1. download the candidate and verify its size and digest, in memory;
//  2. fill in this device's secrets, naming every one it hasn't bound;
//  3. apply restricted mode's policy;
//  4. stage the result privately and let the pinned Vector validate it, and run
//     its tests when asked.
//
// Nothing else on the device changes (see validation.go).
func (e *Engine) runValidation(ctx context.Context, req *ValidationRequest) *ValidationResult {
	started := time.Now()
	result := &ValidationResult{ID: req.ID}
	r := newRedactor()
	r.limit = maxValidationDiagnostics
	finding := func(code, message, hint string) {
		result.Diagnostics = append(result.Diagnostics, r.finalize(Diagnostic{Code: code, Message: message, Hint: hint}))
	}
	finish := func() *ValidationResult {
		result.DurationMS = time.Since(started).Milliseconds()
		return result.sealed()
	}

	if !e.Settings.Adopted {
		finding("ADOPTION_REQUIRED", "This device hasn't adopted a Vector binary, so it can't check versions.", "A host operator must run vectory setup, or vectory install with --adopt, on this host.")
		return finish()
	}
	if req.Size > MaxArtifact {
		finding("DOWNLOAD_TOO_LARGE", fmt.Sprintf("This version is larger than the %d KiB an agent accepts.", MaxArtifact/1024), "Publish a smaller version.")
		return finish()
	}

	template, failure := e.fetchCandidate(ctx, req)
	if ctx.Err() != nil {
		return nil
	}
	if failure != nil {
		result.Diagnostics = append(result.Diagnostics, failure.diagnostics...)
		return finish()
	}

	// Secrets: the apply's own resolution, carried on past each missing binding so
	// that the check names them all.
	r = e.redactorFor(template)
	r.limit = maxValidationDiagnostics
	data, _, problems, err := resolveSecretReferences(template, e.Settings.SecretFiles, e.Settings.CapabilityPolicy.FullVectorConfig, true)
	if err != nil {
		if len(problems) == 0 {
			result.Diagnostics = append(result.Diagnostics, r.finalize(configurationFinding(err)))
			return finish()
		}
		for _, problem := range problems {
			result.Diagnostics = append(result.Diagnostics, secretDiagnostic(problem, r))
			if problem.code == "SECRET_BINDING_MISSING" {
				result.SecretsMissing = append(result.SecretsMissing, problem.name)
			}
		}
		return finish()
	}

	// From here on the configuration holds this device's secret values, so the
	// redactor learns them: they are removed from everything that is reported.
	r = e.redactorFor(data)
	r.limit = maxValidationDiagnostics
	if err = e.Settings.CapabilityPolicy.Check(data); err != nil {
		diagnostics := e.policyDiagnostics(err, data)
		if len(diagnostics) == 0 {
			diagnostics = []Diagnostic{r.finalize(Diagnostic{Code: "CAPABILITY_DENIED", Message: e.Settings.CapabilityPolicy.refusedMessage()})}
		}
		result.Diagnostics = append(result.Diagnostics, diagnostics...)
		return finish()
	}

	dir, err := e.stagingDir()
	if err != nil {
		result.Diagnostics = append(result.Diagnostics, e.unreadyFinding(r, err))
		return finish()
	}
	stage := filepath.Join(dir, ".vectory-stage-"+RandomID()+".json")
	if err = AtomicWrite(stage, data); err != nil {
		result.Diagnostics = append(result.Diagnostics, e.unreadyFinding(r, err))
		return finish()
	}
	// Removed whatever happens next. A process killed before this runs leaves the
	// copy for the next start to delete (clearValidationStaging).
	defer os.Remove(stage)
	if err = e.boundary("validation_staged"); err != nil {
		return nil
	}

	run, err := e.Driver.CheckCandidate(ctx, stage, req.RunTests)
	if ctx.Err() != nil {
		return nil
	}
	testsFailed := false
	if err != nil {
		if native := asVectorFailure(err); native != nil {
			testsFailed = native.Phase == "test"
			result.Diagnostics = append(result.Diagnostics, checkDiagnostics(r, native)...)
		} else {
			result.Diagnostics = append(result.Diagnostics, e.unreadyFinding(r, err))
		}
	}
	if req.RunTests {
		result.Tests = r.testResults(candidateTestNames(data), run, testsFailed)
	}
	// Vector validated the candidate and, when asked, every test passed.
	result.Valid = err == nil
	return finish()
}

// fetchCandidate downloads the candidate and holds it in memory until its size
// and SHA-256 are exactly what the signed request names, as an apply does, so a
// cut-off or altered download never leaves a file behind. It isn't cached: it
// never replaces the template of the version the device is offered.
func (e *Engine) fetchCandidate(ctx context.Context, req *ValidationRequest) ([]byte, *downloadFailure) {
	data, err := e.Client.request(ctx, "GET", req.ArtifactPath, nil)
	if err != nil {
		if ce, ok := AsConnectionError(err); ok && (ce.Status == 403 || ce.Status == 404) {
			// The server stops offering the digest when the request has expired or
			// was replaced by a newer one.
			return nil, &downloadFailure{code: "DOWNLOAD_FAILED", message: "The server no longer offers this version", diagnostics: downloadFinding("CHECK_EXPIRED", "The server no longer offers this version to this device. The check may have expired or been replaced.", checkWords.retry())}
		}
		return nil, classifyDownloadWith(err, checkWords)
	}
	if int64(len(data)) != req.Size || Digest(data) != req.SHA256 {
		return nil, mismatchFailureWith(len(data), req.Size, int64(len(data)) == req.Size, checkWords)
	}
	return data, nil
}

// configurationFinding explains a configuration that couldn't be read for its
// references. The texts are fixed: the error's own words are never forwarded.
func configurationFinding(err error) Diagnostic {
	message := "The agent couldn't read this version's configuration."
	switch err.Error() {
	case "configuration must be a JSON object":
		message = "The configuration isn't a JSON object."
	case "configuration has trailing data":
		message = "The configuration has data after its JSON object."
	case "local secret reference limit exceeded":
		message = fmt.Sprintf("The configuration names more than %d device secrets.", maxSecretNames)
	case "effective configuration exceeds artifact limit":
		message = "With this device's secrets filled in, the configuration is larger than agents accept."
	}
	return Diagnostic{Code: "CONFIG_INVALID", Message: message}
}

// unreadyFinding explains why a check couldn't run on this host: a full disk,
// or anything else that kept it from staging the candidate.
func (e *Engine) unreadyFinding(r *redactor, err error) Diagnostic {
	if full, ok := diskFullFrom(err); ok {
		return r.finalize(Diagnostic{Code: "DISK_FULL", Message: "The disk that holds " + storageLabelFor(e.Settings, full.Dir) + " is full.", Hint: "Free some space on that disk, then run the check again."})
	}
	return r.finalize(Diagnostic{Code: "CHECK_UNAVAILABLE", Message: "The agent couldn't run this check on this device.", Hint: "Run vectory doctor on the host."})
}

// checkDiagnostics turns Vector's failure into diagnostics as an apply does,
// with the wording of a check where an apply's would send someone to retry it.
func checkDiagnostics(r *redactor, failure *VectorFailure) []Diagnostic {
	out := r.diagnose(failure)
	for i := range out {
		if out[i].Code == "VECTOR_TIMEOUT" {
			out[i].Hint = "A destination whose health check never answers is the usual cause: check them from this device, then run the check again."
		}
	}
	return out
}

// candidateTestNames lists the names of the tests a configuration holds, in
// order and without repeats.
func candidateTestNames(data []byte) []string {
	var document struct {
		Tests []json.RawMessage `json:"tests"`
	}
	if json.Unmarshal(data, &document) != nil {
		return nil
	}
	var names []string
	for _, raw := range document.Tests {
		var test struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &test) == nil && strings.TrimSpace(test.Name) != "" && !slices.Contains(names, test.Name) {
			names = append(names, test.Name)
		}
	}
	return names
}

var testPassedLine = regexp.MustCompile(`^test (.+) \.\.\. passed$`)

// testResults says, for each test the configuration holds, whether it passed:
// from the lines `vector test` prints for each test, and the first failing
// condition it prints for a failed one (already redacted). Tests that didn't
// run are said to be not run, never to have passed. The names and messages
// come from the published pipeline and the redacted diagnostics, never from
// raw output.
func (r *redactor) testResults(names []string, run candidateRun, failed bool) []ValidationTest {
	passed := map[string]bool{}
	failing := map[string]string{}
	if run.TestsRan {
		for _, line := range strings.Split(strings.ToValidUTF8(terminalSequence.ReplaceAllString(string(run.TestOutput), ""), ""), "\n") {
			if m := testPassedLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
				passed[m[1]] = true
			}
		}
		for _, finding := range r.testFindings(run.TestOutput) {
			// The finding's message leads with the test's name; the result carries
			// the name apart. A finding that only names the test says "Failed."
			message, ok := strings.CutPrefix(finding.diagnostic.Message, "Test \""+finding.name+"\" failed: ")
			if !ok || message == "" {
				message = "Failed."
			}
			failing[finding.name] = message
		}
	}
	tests := make([]ValidationTest, 0, len(names))
	for _, name := range names {
		test := ValidationTest{Name: r.testName(name)}
		if message, ok := failing[name]; ok {
			test.Message = boundBytes(message, maxTestMessage)
		} else {
			switch {
			case !run.TestsRan:
				test.NotRun, test.Message = true, "Not run: the check stopped before the tests."
			case passed[name]:
				test.Passed = true
			case failed:
				test.NotRun, test.Message = true, "Not run: Vector stopped before this test."
			default:
				// Vector exits cleanly only when no test failed.
				test.Passed = true
			}
		}
		tests = append(tests, test)
	}
	return tests
}

// testName is a test's name as a result carries it: one line, redacted, bounded.
func (r *redactor) testName(name string) string {
	name = strings.Map(func(c rune) rune {
		if unicode.IsControl(c) && !unicode.IsSpace(c) {
			return -1
		}
		return c
	}, name)
	return boundBytes(r.text(strings.Join(strings.Fields(name), " ")), maxTestName)
}

// boundBytes cuts text to at most limit bytes, at a character boundary, with an
// ellipsis when it cut.
func boundBytes(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	const ellipsis = "…"
	cut := limit - len(ellipsis)
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return strings.TrimSpace(text[:cut]) + ellipsis
}

// sealed puts a result in the shape the server's parser accepts: arrays that
// are never null, diagnostics with errors first and at most
// maxValidationDiagnostics, failing tests first and at most maxValidationTests,
// and the missing secrets sorted, without repeats and at most maxSecretNames.
func (res *ValidationResult) sealed() *ValidationResult {
	sort.SliceStable(res.Diagnostics, func(i, j int) bool {
		return res.Diagnostics[i].Severity == "error" && res.Diagnostics[j].Severity != "error"
	})
	if len(res.Diagnostics) > maxValidationDiagnostics {
		res.Diagnostics = res.Diagnostics[:maxValidationDiagnostics]
	}
	rank := func(t ValidationTest) int {
		switch {
		case !t.Passed && !t.NotRun:
			return 0
		case t.NotRun:
			return 1
		}
		return 2
	}
	sort.SliceStable(res.Tests, func(i, j int) bool { return rank(res.Tests[i]) < rank(res.Tests[j]) })
	if len(res.Tests) > maxValidationTests {
		res.Tests = res.Tests[:maxValidationTests]
	}
	sort.Strings(res.SecretsMissing)
	res.SecretsMissing = slices.Compact(res.SecretsMissing)
	if len(res.SecretsMissing) > maxSecretNames {
		res.SecretsMissing = res.SecretsMissing[:maxSecretNames]
	}
	if res.Diagnostics == nil {
		res.Diagnostics = []Diagnostic{}
	}
	if res.Tests == nil {
		res.Tests = []ValidationTest{}
	}
	if res.SecretsMissing == nil {
		res.SecretsMissing = []string{}
	}
	res.DurationMS = max(res.DurationMS, 0)
	return res
}
