package agent

import (
	"runtime"
	"strings"
	"testing"
)

func goodProbeOutput(version string) []byte {
	return []byte(`{"version":"` + version + `","vector_version":"0.58.0","go":"go1.26.8","os":"` + runtime.GOOS + `","arch":"` + runtime.GOARCH + `"}` + "\n")
}

func TestTheProbeAcceptsABuildThatSaysItIsTheVersionTheReleaseNamesOnThisPlatform(t *testing.T) {
	if refusal := checkProbeOutput(goodProbeOutput("0.1.1"), "0.1.1"); refusal != nil {
		t.Fatalf("a build that reports what the release says: %v", refusal)
	}
	// A build may print more than the three members the probe reads.
	extra := []byte(`{"version":"0.1.1","os":"` + runtime.GOOS + `","arch":"` + runtime.GOARCH + `","commit":"abc","builder":{"a":[1,2]}}`)
	if refusal := checkProbeOutput(extra, "0.1.1"); refusal != nil {
		t.Errorf("a build that prints more: %v", refusal)
	}
}

func TestTheProbeRefusesEverythingElseWithTheCodeThatSaysSo(t *testing.T) {
	other := "linux"
	if runtime.GOOS == "linux" {
		other = "darwin"
	}
	otherArch := "arm64"
	if runtime.GOARCH == "arm64" {
		otherArch = "amd64"
	}
	for name, output := range map[string]string{
		"nothing":                    "",
		"not JSON":                   "vectory 0.1.1",
		"a list":                     `["0.1.1"]`,
		"a number":                   `7`,
		"two documents":              string(goodProbeOutput("0.1.1")) + string(goodProbeOutput("0.1.1")),
		"trailing text":              string(goodProbeOutput("0.1.1")) + "ok",
		"another version":            string(goodProbeOutput("0.1.2")),
		"no version":                 `{"os":"` + runtime.GOOS + `","arch":"` + runtime.GOARCH + `"}`,
		"another operating system":   `{"version":"0.1.1","os":"` + other + `","arch":"` + runtime.GOARCH + `"}`,
		"another architecture":       `{"version":"0.1.1","os":"` + runtime.GOOS + `","arch":"` + otherArch + `"}`,
		"no platform":                `{"version":"0.1.1"}`,
		"a version that is a number": `{"version":1,"os":"` + runtime.GOOS + `","arch":"` + runtime.GOARCH + `"}`,
	} {
		refusal := checkProbeOutput([]byte(output), "0.1.1")
		if refusal == nil || refusal.Code != "PROBE_FAILED" {
			t.Errorf("%s: %v", name, refusal)
		}
	}
}

func TestWhatTheProbeQuotesFromABuildIsTextAWindowCanShow(t *testing.T) {
	output := []byte(`{"version":"\u001b[31m0.1.1\u001b]0;pwned\u0007","os":"` + runtime.GOOS + `\n","arch":"x"}`)
	refusal := checkProbeOutput(output, "0.1.1")
	if refusal == nil {
		t.Fatal("a build with escape sequences in its version was accepted")
	}
	for _, r := range refusal.Detail {
		if r < 0x20 || r == 0x7f {
			t.Fatalf("the refusal holds a control character: %q", refusal.Detail)
		}
	}
}

func TestTheVersionOfAnInstalledBuildIsWhatItPrintsIfItIsText(t *testing.T) {
	if got, err := probeVersionOf(goodProbeOutput("0.1.0")); err != nil || got != "0.1.0" {
		t.Errorf("a good build: %q, %v", got, err)
	}
	for name, output := range map[string]string{
		"nothing":             "",
		"not JSON":            "x",
		"no version":          `{"os":"linux"}`,
		"an empty version":    `{"version":""}`,
		"a control character": `{"version":"0.1\u0000.0"}`,
		"too long":            `{"version":"` + strings.Repeat("1", 129) + `"}`,
	} {
		if got, err := probeVersionOf([]byte(output)); err == nil {
			t.Errorf("%s: %q", name, got)
		}
	}
	if got, err := probeVersionOf([]byte(`{"version":"` + strings.Repeat("1", 128) + `"}`)); err != nil || len(got) != 128 {
		t.Errorf("128 bytes: %d, %v", len(got), err)
	}
}

func TestTheProbesOutputIsKeptToItsBoundAndNeverBlocksTheWriter(t *testing.T) {
	output := &boundedOutput{limit: 10}
	for _, chunk := range []string{"abcd", "efgh", "ijkl", "mnop"} {
		if n, err := output.Write([]byte(chunk)); n != len(chunk) || err != nil {
			t.Fatalf("a write of %q reported %d, %v", chunk, n, err)
		}
	}
	if got := output.buffer.String(); got != "abcdefghij" || !output.overflow {
		t.Errorf("kept %q, overflow %v", got, output.overflow)
	}
	exact := &boundedOutput{limit: 4}
	exact.Write([]byte("abcd"))
	if exact.overflow || exact.buffer.String() != "abcd" {
		t.Errorf("output of exactly the bound: %q, overflow %v", exact.buffer.String(), exact.overflow)
	}
}
