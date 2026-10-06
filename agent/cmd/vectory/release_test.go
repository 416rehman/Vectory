package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vectory/vectory/agent/internal/agent"
)

// releaseFiles is a directory with what a signer has: a release.json the server
// prepared, the SHA256SUMS of the builds, a key, and the public key in a file.
type releaseFiles struct {
	dir      string
	manifest string
	sums     string
	key      string
	pub      string
	private  agent.ReleasePrivateKey
	public   agent.ReleaseKey
	now      time.Time
}

const (
	linuxDigest   = "4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f"
	windowsDigest = "25043433d22cf8f6f5ffb531abb6a0b0fe0952af2bb946586b5868b4bdf4e201"
)

// releaseManifestText is a manifest of agent 0.1.1, issued an hour ago and valid
// for the given time.
func releaseManifestText(now time.Time, lifetime time.Duration, counter int) string {
	issued := now.Add(-time.Hour)
	if lifetime < 0 {
		issued = now.Add(2 * lifetime)
	}
	format := func(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }
	return fmt.Sprintf(`{"schema":"vectory.agent-release.v1","version":"0.1.1","counter":%d,"issued_at":"%s","expires_at":"%s","min_from":"0.1.0","service_definition":1,"artifacts":[{"os":"linux","arch":"amd64","format":"executable","file":"vectory-0.1.1-linux-amd64","size":15204352,"sha256":"%s"},{"os":"windows","arch":"amd64","format":"executable","file":"vectory-0.1.1-windows-amd64.exe","size":15892480,"sha256":"%s"}]}`,
		counter, format(issued), format(now.Add(lifetime)), linuxDigest, windowsDigest)
}

func newReleaseFiles(t *testing.T) releaseFiles {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := releaseFiles{dir: dir, now: time.Now().UTC().Truncate(time.Second)}
	f.manifest = filepath.Join(dir, "release.json")
	f.sums = filepath.Join(dir, "SHA256SUMS")
	f.key = filepath.Join(dir, "team.key")
	f.pub = filepath.Join(dir, "team.pub")
	if f.private, err = agent.GenerateReleasePrivateKey(); err != nil {
		t.Fatal(err)
	}
	if err = agent.WriteReleasePrivateKey(f.key, f.private); err != nil {
		t.Fatal(err)
	}
	if f.public, err = f.private.Public("team"); err != nil {
		t.Fatal(err)
	}
	write := func(path, contents string) {
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(f.pub, f.public.Line()+"\n")
	write(f.manifest, releaseManifestText(f.now, 180*24*time.Hour, 7))
	write(f.sums, linuxDigest+"  vectory-0.1.1-linux-amd64\n"+windowsDigest+"  vectory-0.1.1-windows-amd64.exe\n")
	return f
}

func (f releaseFiles) write(t *testing.T, name, contents string) string {
	t.Helper()
	path := filepath.Join(f.dir, name)
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func (f releaseFiles) read(t *testing.T, name string) string {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join(f.dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}

func (f releaseFiles) exists(name string) bool {
	_, err := os.Lstat(filepath.Join(f.dir, name))
	return err == nil
}

func (f releaseFiles) sign(args ...string) (int, string, string) {
	return invoke(append([]string{"release", "sign", "--key", f.key, "--checksums", f.sums, "--yes"}, append(args, f.manifest)...)...)
}

// runRelease runs a verb with the terminal replaced, as a person at a keyboard
// would answer.
func runRelease(verb string, ask func(string) (string, bool), args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	command := findCommand("release").verb(verb)
	c := newCLI(command, &stdout, &stderr)
	c.ask = ask
	code := executeWith(c, command, args)
	return code, stdout.String(), stderr.String()
}

func noTerminal(string) (string, bool) { return "", false }

// ---------------------------------------------------------------- keygen

func TestReleaseKeygenWritesAPrivateKeyAndPrintsThePublicOne(t *testing.T) {
	f := newReleaseFiles(t)
	path := filepath.Join(f.dir, "new.key")
	code, stdout, stderr := invoke("release", "keygen", "--out", path, "--name", "team ops")
	if code != 0 || stderr != "" {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	lines := strings.Split(strings.TrimSuffix(stdout, "\n"), "\n")
	var keyLine, groups string
	for i, line := range lines {
		switch {
		case strings.HasPrefix(line, "vectory-release-key ed25519 "):
			keyLine = line
		case strings.HasPrefix(line, "Fingerprint") && i+1 < len(lines):
			groups = lines[i+1]
		}
	}
	public, err := agent.ParseReleaseKey(keyLine)
	if err != nil || public.Name() != "team ops" {
		t.Fatalf("the public key line %q: %v\n%s", keyLine, err, stdout)
	}
	// The line is printed at the left edge, so what a person copies is the line
	// and nothing in front of it: saved as it is, the file reads back as the key.
	saved := f.write(t, "copied.pub", keyLine+"\n")
	if read, err := agent.ReadReleasePublicKeyFile(saved); err != nil || read != public {
		t.Errorf("the printed line saved to a file: %v", err)
	}
	if groups != agent.GroupFingerprint(public.Fingerprint()) || len(strings.Fields(groups)) != 8 {
		t.Errorf("the fingerprint is printed in groups of eight: %q", groups)
	}
	for _, want := range []string{"Wrote the private key to " + path + ", closed to other accounts.", "Keep it off the server."} {
		if !strings.Contains(stdout, want) {
			t.Errorf("the output lacks %q:\n%s", want, stdout)
		}
	}
	private, err := agent.ReadReleasePrivateKey(path)
	if err != nil || private.Fingerprint() != public.Fingerprint() {
		t.Fatalf("the file holds another key: %v", err)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("%v %v", info, err)
		}
	}
	// A relative name is the current directory's.
	t.Chdir(f.dir)
	if code, _, stderr := invoke("release", "keygen", "--out", "relative.key"); code != 0 || stderr != "" || !f.exists("relative.key") {
		t.Errorf("a relative name: %d %q", code, stderr)
	}
	// The default name is release- and the first 8 characters of the
	// fingerprint, the name the server gives a key it makes.
	_, unnamed, _ := invoke("release", "keygen", "--out", "unnamed.key")
	unnamedLines := strings.Split(strings.TrimSpace(unnamed), "\n")
	unnamedPrint := strings.ReplaceAll(unnamedLines[len(unnamedLines)-1], " ", "")
	unnamedName := regexp.MustCompile(`(?m)^vectory-release-key ed25519 \S+ (release-[0-9a-f]{8})$`).FindStringSubmatch(unnamed)
	if unnamedName == nil || len(unnamedPrint) != 64 || unnamedName[1] != "release-"+unnamedPrint[:8] {
		t.Errorf("the default name:\n%s", unnamed)
	}
}

func TestReleaseKeygenNeverReplacesAFile(t *testing.T) {
	f := newReleaseFiles(t)
	before := f.read(t, "team.key")
	code, stdout, stderr := invoke("release", "keygen", "--out", f.key)
	if code != 1 || stdout != "" || !strings.Contains(stderr, f.key+" already exists, and keygen never replaces a file") {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	if f.read(t, "team.key") != before {
		t.Error("the existing key changed")
	}
	// Any existing thing is refused: the manifest, and a name that is a directory.
	for _, path := range []string{f.manifest, f.dir} {
		if code, _, stderr := invoke("release", "keygen", "--out", path); code != 1 || !strings.Contains(stderr, "already exists") {
			t.Errorf("%s: %d %q", path, code, stderr)
		}
	}
	if !strings.HasPrefix(f.read(t, "release.json"), `{"schema"`) {
		t.Error("the manifest changed")
	}
	// A missing directory is said plainly, and nothing is made.
	missing := filepath.Join(f.dir, "missing", "k.key")
	if code, _, stderr := invoke("release", "keygen", "--out", missing); code != 1 || !strings.Contains(stderr, "couldn't create") {
		t.Errorf("%d %q", code, stderr)
	}
}

func TestReleaseKeygenChecksItsFlags(t *testing.T) {
	f := newReleaseFiles(t)
	if code, _, stderr := invoke("release", "keygen"); code != 2 || !strings.Contains(stderr, "--out is required") {
		t.Errorf("no --out: %d %q", code, stderr)
	}
	for _, name := range []string{strings.Repeat("n", 65), " lead", "trail ", `quo"te`, "tab\tx", "caf\u00e9"} {
		path := filepath.Join(f.dir, "n.key")
		code, _, stderr := invoke("release", "keygen", "--out", path, "--name", name)
		if code != 2 || !strings.Contains(stderr, "--name:") || f.exists("n.key") {
			t.Errorf("--name %q: %d %q (file made: %v)", name, code, stderr, f.exists("n.key"))
		}
	}
	if code, _, stderr := invoke("release", "keygen", "--out", filepath.Join(f.dir, "n.key"), "--name", ""); code != 2 || !strings.Contains(stderr, "--name:") {
		t.Errorf("an empty name: %d %q", code, stderr)
	}
}

// ---------------------------------------------------------------- sign

func TestReleaseSignWritesASignatureAHostAccepts(t *testing.T) {
	f := newReleaseFiles(t)
	code, stdout, stderr := f.sign()
	if code != 0 || stderr != "" {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	short := f.public.ShortID()
	for _, want := range []string{
		fmt.Sprintf("Agent 0.1.1 · counter 7 · expires %s (in 180 days)", f.now.Add(180*24*time.Hour).Format("2006-01-02 15:04")+" UTC"),
		fmt.Sprintf("  Issued %s · service definition 1", f.now.Add(-time.Hour).Format("2006-01-02 15:04")+" UTC"),
		"  For agents running 0.1.0 or newer",
		"  linux/amd64    vectory-0.1.1-linux-amd64        15204352 bytes  sha256 4206fd2a4cefdeff…",
		"  windows/amd64  vectory-0.1.1-windows-amd64.exe  15892480 bytes  sha256 25043433d22cf8f6…",
		"Every file name and SHA-256 matches SHA256SUMS.",
		"Signed with key " + short + ". Wrote " + f.manifest + ".sig (1 signature).",
		"Next: upload release.json.sig to the release on Devices → Agent updates.",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("the output lacks %q:\n%s", want, stdout)
		}
	}
	// The file is the exact bytes a host reads, and a host accepts it.
	signatures := f.read(t, "release.json.sig")
	if !strings.HasSuffix(signatures, "\n") || strings.Count(signatures, "\n") != 1 {
		t.Errorf("the signature file is one line: %q", signatures)
	}
	manifest := f.read(t, "release.json")
	verified, err := agent.VerifyRelease(agent.VerifyInput{
		Manifest: []byte(manifest), Signatures: []byte(signatures), Pins: []agent.ReleaseKey{f.public}, Now: f.now,
		RunningVersion: "0.1.0", OS: "linux", Arch: "amd64", Track: agent.ReleaseTrackPatch, ServiceDefinition: 1,
	})
	if err != nil || verified.Signer() != f.public || verified.Manifest.Counter != 7 {
		t.Fatalf("a host refuses what sign wrote: %v", err)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(f.manifest + ".sig"); info == nil || info.Mode().Perm() != 0o644 {
			t.Errorf("the signature file is public: %v", info)
		}
	}
	// verify says the same with the public key file.
	code, stdout, stderr = invoke("release", "verify", "--key", f.pub, f.manifest)
	if code != 0 || stderr != "" || !strings.HasPrefix(stdout, "Valid: release.json is signed by key "+short+" (team).\n") ||
		!strings.Contains(stdout, "This check has no counter floors or running version.") {
		t.Errorf("verify: %d %q %q", code, stdout, stderr)
	}
}

// What a signature covers is shown, the service definition a host must already
// have included: a number above what the fleet runs would stop every host at
// SERVICE_DEFINITION_OUTDATED, and the person who signs should see it.
func TestReleaseSummaryShowsTheServiceDefinition(t *testing.T) {
	f := newReleaseFiles(t)
	f.write(t, "release.json", strings.Replace(releaseManifestText(f.now, 180*24*time.Hour, 7), `"service_definition":1`, `"service_definition":3`, 1))
	code, stdout, stderr := f.sign()
	if code != 0 || !strings.Contains(stdout, " · service definition 3\n") {
		t.Fatalf("sign: %d %q %q", code, stdout, stderr)
	}
	if code, stdout, stderr = invoke("release", "verify", "--key", f.pub, f.manifest); code != 0 || !strings.Contains(stdout, " · service definition 3\n") {
		t.Errorf("verify: %d %q %q", code, stdout, stderr)
	}
}

func TestReleaseSignAsksOnATerminal(t *testing.T) {
	f := newReleaseFiles(t)
	args := []string{"--key", f.key, "--checksums", f.sums, f.manifest}
	var asked []string
	answering := func(answer string, terminal bool) func(string) (string, bool) {
		return func(question string) (string, bool) { asked = append(asked, question); return answer, terminal }
	}

	// Without a terminal and without --yes: the summary, a refusal, nothing written.
	code, stdout, stderr := runRelease("sign", noTerminal, args...)
	if code != 1 || !strings.Contains(stdout, "Agent 0.1.1 · counter 7") || !strings.Contains(stderr, "there is no terminal to ask on") || !strings.Contains(stderr, "with --yes") || f.exists("release.json.sig") {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	// A terminal that says no, or anything but yes.
	for _, answer := range []string{"n", "N", "", "no", "yep", "sure", "yes please"} {
		code, stdout, stderr = runRelease("sign", answering(answer, true), args...)
		if code != 1 || !strings.Contains(stderr, "Not signed.") || f.exists("release.json.sig") || strings.Contains(stdout, "Signed with key") {
			t.Fatalf("answer %q: %d %q %q", answer, code, stdout, stderr)
		}
	}
	if len(asked) == 0 || asked[0] != "Sign this release with key "+f.public.ShortID()+"? [y/N] " {
		t.Errorf("the question is %q", asked)
	}
	// Yes, in either spelling, signs.
	for i, answer := range []string{"y", "YES"} {
		name := fmt.Sprintf("signed-%d.sig", i)
		code, stdout, stderr = runRelease("sign", answering(answer, true), "--out", filepath.Join(f.dir, name), "--key", f.key, "--checksums", f.sums, f.manifest)
		if code != 0 || !strings.Contains(stdout, "Signed with key") || !f.exists(name) {
			t.Fatalf("answer %q: %d %q %q", answer, code, stdout, stderr)
		}
	}
	// --yes never asks.
	asked = nil
	if code, _, _ = runRelease("sign", answering("n", true), append([]string{"--yes"}, args...)...); code != 0 || len(asked) != 0 {
		t.Errorf("--yes: %d, asked %q", code, asked)
	}
}

func TestReleaseSignChecksEveryBuildAgainstTheChecksums(t *testing.T) {
	f := newReleaseFiles(t)
	other := strings.Repeat("0", 64)
	windows := windowsDigest + "  vectory-0.1.1-windows-amd64.exe\n"
	for _, c := range []struct {
		name string
		sums string
		want []string // the problems named; nil when the sums are accepted
	}{
		{"text mode", linuxDigest + "  vectory-0.1.1-linux-amd64\n" + windows, nil},
		{"binary mode", linuxDigest + " *vectory-0.1.1-linux-amd64\n" + windowsDigest + " *vectory-0.1.1-windows-amd64.exe\n", nil},
		{"uppercase digests", strings.ToUpper(linuxDigest) + "  vectory-0.1.1-linux-amd64\n" + strings.ToUpper(windowsDigest) + "  vectory-0.1.1-windows-amd64.exe\n", nil},
		{"Windows line endings", linuxDigest + "  vectory-0.1.1-linux-amd64\r\n" + windowsDigest + "  vectory-0.1.1-windows-amd64.exe\r\n", nil},
		{"other files, comments and blank lines", "# build 7\n\n" + other + "  catalog.json\n" + linuxDigest + "  vectory-0.1.1-linux-amd64\n" + strings.TrimSuffix(windows, "\n"), nil},
		{"the same line twice", strings.Repeat(linuxDigest+"  vectory-0.1.1-linux-amd64\n", 2) + windows, nil},
		{"a different digest", other + "  vectory-0.1.1-linux-amd64\n" + windows, []string{"vectory-0.1.1-linux-amd64: release.json says " + linuxDigest + " and SHA256SUMS says " + other}},
		{"a build with no line", linuxDigest + "  vectory-0.1.1-linux-amd64\n", []string{"SHA256SUMS has no line for vectory-0.1.1-windows-amd64.exe"}},
		{"nothing listed", other + "  something-else\n", []string{"SHA256SUMS has no line for vectory-0.1.1-linux-amd64", "SHA256SUMS has no line for vectory-0.1.1-windows-amd64.exe"}},
		{"an empty file", "", []string{"SHA256SUMS has no line for vectory-0.1.1-linux-amd64"}},
		{"a name with a directory", linuxDigest + "  ./vectory-0.1.1-linux-amd64\n" + windows, []string{"SHA256SUMS has no line for vectory-0.1.1-linux-amd64"}},
		{"a name in another case", linuxDigest + "  Vectory-0.1.1-linux-amd64\n" + windows, []string{"SHA256SUMS has no line for vectory-0.1.1-linux-amd64"}},
		{"one name with two digests", linuxDigest + "  vectory-0.1.1-linux-amd64\n" + other + "  vectory-0.1.1-linux-amd64\n" + windows, []string{"SHA256SUMS lists vectory-0.1.1-linux-amd64 with different digests (" + other + " and " + linuxDigest + ")"}},
		{"a line that isn't a checksum", "hello\n" + linuxDigest + "  vectory-0.1.1-linux-amd64\n", []string{"SHA256SUMS: line 1 isn't `<sha-256>  <file name>`"}},
		{"a digest that isn't hexadecimal", strings.Repeat("g", 64) + "  vectory-0.1.1-linux-amd64\n", []string{"SHA256SUMS: line 1 doesn't start with a SHA-256 in hexadecimal"}},
		{"a digest that is too short", linuxDigest[:63] + "  vectory-0.1.1-linux-amd64\n", []string{"SHA256SUMS: line 1 isn't `<sha-256>  <file name>`"}},
		{"one space and no star", linuxDigest + " vectory-0.1.1-linux-amd64\n", []string{"SHA256SUMS: line 1 isn't `<sha-256>  <file name>`"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f.write(t, "SHA256SUMS", c.sums)
			os.Remove(f.manifest + ".sig")
			code, stdout, stderr := f.sign()
			if c.want == nil {
				if code != 0 || !f.exists("release.json.sig") {
					t.Fatalf("%d %q %q", code, stdout, stderr)
				}
				return
			}
			if code != 1 || f.exists("release.json.sig") || strings.Contains(stdout, "Signed with key") {
				t.Fatalf("a signature was made: %d %q %q", code, stdout, stderr)
			}
			if !strings.Contains(stderr, "vectory: not signed: the builds in release.json don't match SHA256SUMS:") {
				t.Errorf("%q", stderr)
			}
			for _, want := range c.want {
				if !strings.Contains(stderr, "\n  "+want+"\n") {
					t.Errorf("stderr lacks %q:\n%s", want, stderr)
				}
			}
		})
	}
}

func TestReleaseSignRefusesWhatItCannotSignSafely(t *testing.T) {
	f := newReleaseFiles(t)
	unchanged := func(t *testing.T) {
		t.Helper()
		if f.exists("release.json.sig") {
			t.Fatalf("a signature file was written:\n%s", f.read(t, "release.json.sig"))
		}
	}
	t.Run("a manifest that breaks the format", func(t *testing.T) {
		f.write(t, "release.json", strings.Replace(releaseManifestText(f.now, 180*24*time.Hour, 7), `"counter":7`, `"counter":0`, 1))
		code, _, stderr := f.sign()
		if code != 1 || !strings.Contains(stderr, "MANIFEST_INVALID") {
			t.Fatalf("%d %q", code, stderr)
		}
		unchanged(t)
	})
	t.Run("a manifest that expired", func(t *testing.T) {
		f.write(t, "release.json", releaseManifestText(f.now, -24*time.Hour, 7))
		code, _, stderr := f.sign()
		if code != 1 || !strings.Contains(stderr, "this release expired at") || !strings.Contains(stderr, "no host would take it") {
			t.Fatalf("%d %q", code, stderr)
		}
		unchanged(t)
	})
	f.write(t, "release.json", releaseManifestText(f.now, 180*24*time.Hour, 7))
	t.Run("a manifest that does not exist", func(t *testing.T) {
		code, _, stderr := invoke("release", "sign", "--key", f.key, "--checksums", f.sums, "--yes", filepath.Join(f.dir, "none.json"))
		if code != 1 || !strings.Contains(stderr, "none.json doesn't exist") {
			t.Fatalf("%d %q", code, stderr)
		}
	})
	t.Run("a file that is too large", func(t *testing.T) {
		big := f.write(t, "big.json", strings.Repeat(" ", agent.MaxReleaseManifest+1))
		code, _, stderr := invoke("release", "sign", "--key", f.key, "--checksums", f.sums, "--yes", big)
		if code != 1 || !strings.Contains(stderr, "is larger than 16384 bytes") {
			t.Fatalf("%d %q", code, stderr)
		}
	})
	t.Run("a public key in the place of the private one", func(t *testing.T) {
		privatePublic := filepath.Join(f.dir, "public-as-private.key")
		if err := agent.AtomicWrite(privatePublic, []byte(f.public.Line()+"\n")); err != nil {
			t.Fatal(err)
		}
		code, _, stderr := invoke("release", "sign", "--key", privatePublic, "--checksums", f.sums, "--yes", f.manifest)
		if code != 1 || !strings.Contains(stderr, "not a release private key") {
			t.Fatalf("%d %q", code, stderr)
		}
		unchanged(t)
	})
	t.Run("a checksum file that does not exist", func(t *testing.T) {
		code, _, stderr := invoke("release", "sign", "--key", f.key, "--checksums", filepath.Join(f.dir, "none"), "--yes", f.manifest)
		if code != 1 || !strings.Contains(stderr, "none doesn't exist") {
			t.Fatalf("%d %q", code, stderr)
		}
	})
	t.Run("flags missing", func(t *testing.T) {
		if code, _, stderr := invoke("release", "sign", "--checksums", f.sums, f.manifest); code != 2 || !strings.Contains(stderr, "--key is required") {
			t.Errorf("no key: %d %q", code, stderr)
		}
		if code, _, stderr := invoke("release", "sign", "--key", f.key, f.manifest); code != 2 || !strings.Contains(stderr, "--checksums is required") {
			t.Errorf("no checksums: %d %q", code, stderr)
		}
		if code, _, stderr := invoke("release", "sign", "--key", f.key, "--checksums", f.sums); code != 2 || !strings.Contains(stderr, "missing release.json") {
			t.Errorf("no manifest: %d %q", code, stderr)
		}
	})
	unchanged(t)
}

func TestReleaseSignGrowsAnExistingSignatureFileOnlyByAnotherKey(t *testing.T) {
	f := newReleaseFiles(t)
	if code, _, stderr := f.sign(); code != 0 {
		t.Fatal(stderr)
	}
	first := f.read(t, "release.json.sig")

	// The same key again is the same signature: nothing changes.
	code, stdout, _ := f.sign()
	if code != 0 || !strings.Contains(stdout, "release.json.sig already holds this signature by key "+f.public.ShortID()+". Nothing changed.") || f.read(t, "release.json.sig") != first {
		t.Fatalf("%d %q", code, stdout)
	}

	// Another key adds its own entry and leaves the first as it was.
	second, err := agent.GenerateReleasePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	secondKey := filepath.Join(f.dir, "second.key")
	if err := agent.WriteReleasePrivateKey(secondKey, second); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := invoke("release", "sign", "--key", secondKey, "--checksums", f.sums, "--yes", f.manifest)
	if code != 0 || !strings.Contains(stdout, "(2 signatures)") {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	entries, err := agent.ParseReleaseSignatures([]byte(f.read(t, "release.json.sig")))
	if err != nil || len(entries) != 2 || entries[0].Key != f.public.Fingerprint() || entries[1].Key != second.Fingerprint() {
		t.Fatalf("%+v %v", entries, err)
	}
	// Either key's pin verifies the release.
	secondPublic, _ := second.Public("second")
	for _, pin := range []agent.ReleaseKey{f.public, secondPublic} {
		if _, err := agent.VerifyReleaseFiles(agent.VerifyInput{Manifest: []byte(f.read(t, "release.json")), Signatures: []byte(f.read(t, "release.json.sig")), Pins: []agent.ReleaseKey{pin}, Now: f.now}); err != nil {
			t.Errorf("%s: %v", pin.ShortID(), err)
		}
	}

	// A third and a fourth key fill the file, and a fifth is refused.
	for i := 0; i < 3; i++ {
		extra, _ := agent.GenerateReleasePrivateKey()
		path := filepath.Join(f.dir, fmt.Sprintf("extra%d.key", i))
		if err := agent.WriteReleasePrivateKey(path, extra); err != nil {
			t.Fatal(err)
		}
		code, stdout, stderr := invoke("release", "sign", "--key", path, "--checksums", f.sums, "--yes", f.manifest)
		if i < 2 && code != 0 {
			t.Fatalf("key %d: %d %q %q", i, code, stdout, stderr)
		}
		if i == 2 && (code != 1 || !strings.Contains(stderr, "already holds 4 signatures, the most a release takes")) {
			t.Fatalf("a fifth signature: %d %q %q", code, stdout, stderr)
		}
	}
}

func TestReleaseSignNeverOverwritesWhatItDoesNotUnderstand(t *testing.T) {
	f := newReleaseFiles(t)
	// A signature by this key that isn't of this release.json (an older release's
	// file left in the directory) is not replaced.
	stale := agent.ReleaseSignature{Key: f.public.Fingerprint()}
	copy(stale.Signature[:], f.private.SignRelease([]byte("another release")))
	staleFile, err := agent.BuildReleaseSignatures([]agent.ReleaseSignature{stale})
	if err != nil {
		t.Fatal(err)
	}
	f.write(t, "release.json.sig", string(staleFile))
	code, _, stderr := f.sign()
	if code != 1 || !strings.Contains(stderr, "already holds a signature by key "+f.public.ShortID()+" that isn't a signature of this release.json") || f.read(t, "release.json.sig") != string(staleFile) {
		t.Fatalf("%d %q", code, stderr)
	}

	// Files that are not signature files are left alone: the manifest itself, the
	// key, and a directory.
	for _, name := range []string{"release.json", "team.key", "SHA256SUMS"} {
		before := f.read(t, name)
		code, _, stderr := f.sign("--out", filepath.Join(f.dir, name))
		if code != 1 || !strings.Contains(stderr, "isn't a signature file, so it was left alone") || f.read(t, name) != before {
			t.Errorf("--out %s: %d %q", name, code, stderr)
		}
	}
	if code, _, stderr := f.sign("--out", f.dir); code != 1 || !strings.Contains(stderr, "isn't a regular file") {
		t.Errorf("--out a directory: %d %q", code, stderr)
	}
}

func TestReleaseSignWritesWhereItIsTold(t *testing.T) {
	f := newReleaseFiles(t)
	out := filepath.Join(f.dir, "elsewhere.sig")
	code, stdout, stderr := f.sign("--out", out)
	if code != 0 || !f.exists("elsewhere.sig") || f.exists("release.json.sig") {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	if !strings.Contains(stdout, "Wrote "+out+" (1 signature).") || !strings.Contains(stdout, "Next: upload elsewhere.sig") {
		t.Errorf("%s", stdout)
	}
	// Options may come in any order before the file, and the manifest may be named
	// relative to the current directory.
	t.Chdir(f.dir)
	code, _, stderr = invoke("release", "sign", "--yes", "--checksums", "SHA256SUMS", "--key", "team.key", "release.json")
	if code != 0 || !f.exists("release.json.sig") {
		t.Fatalf("%d %q", code, stderr)
	}
}

func TestReleaseSignRefusesAKeyThatIsNotPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the access list of a private file is checked by the account tests on Windows")
	}
	f := newReleaseFiles(t)
	if err := os.Chmod(f.key, 0o644); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := f.sign()
	if code != 1 || !strings.Contains(stderr, "readable by other accounts") || !strings.Contains(stderr, "chmod 600") || f.exists("release.json.sig") {
		t.Fatalf("%d %q", code, stderr)
	}
	if err := os.Chmod(f.key, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(f.dir, "link.key")
	if err := os.Symlink(f.key, link); err != nil {
		t.Fatal(err)
	}
	code, _, stderr = invoke("release", "sign", "--key", link, "--checksums", f.sums, "--yes", f.manifest)
	if code != 1 || !strings.Contains(stderr, "symbolic link") || f.exists("release.json.sig") {
		t.Fatalf("a link to the key: %d %q", code, stderr)
	}
}

// ---------------------------------------------------------------- verify

func TestReleaseVerifyGivesTheCodeAHostWould(t *testing.T) {
	f := newReleaseFiles(t)
	if code, _, stderr := f.sign(); code != 0 {
		t.Fatal(stderr)
	}
	other, _ := agent.GenerateReleasePrivateKey()
	otherPublic, _ := other.Public("other")
	otherPub := f.write(t, "other.pub", otherPublic.Line())
	manifest := f.read(t, "release.json")
	flipped := f.write(t, "flipped.json", strings.Replace(manifest, `"counter":7`, `"counter":8`, 1))
	expired := f.write(t, "expired.json", releaseManifestText(f.now, -24*time.Hour, 7))
	expiredSignatures := agent.ReleaseSignature{Key: f.public.Fingerprint()}
	copy(expiredSignatures.Signature[:], f.private.SignRelease([]byte(f.read(t, "expired.json"))))
	expiredFile, _ := agent.BuildReleaseSignatures([]agent.ReleaseSignature{expiredSignatures})
	f.write(t, "expired.json.sig", string(expiredFile))
	smallOrder := f.write(t, "small.pub", "vectory-release-key ed25519 AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= small\n")
	garbage := f.write(t, "garbage.sig", "not json")

	for _, c := range []struct {
		name string
		args []string
		code string
	}{
		{"another key", []string{"--key", otherPub, f.manifest}, "KEY_NOT_PINNED"},
		{"a byte changed in the manifest", []string{"--key", f.pub, "--signatures", f.manifest + ".sig", flipped}, "SIGNATURE_INVALID"},
		{"an expired release", []string{"--key", f.pub, expired}, "MANIFEST_EXPIRED"},
		{"a key of small order", []string{"--key", smallOrder, f.manifest}, "RELEASE_KEY_INVALID"},
		{"a signature file that is not one", []string{"--key", f.pub, "--signatures", garbage, f.manifest}, "SIGNATURE_INVALID"},
	} {
		code, stdout, stderr := invoke(append([]string{"release", "verify"}, c.args...)...)
		if code != 1 || stdout != "" || !strings.HasPrefix(stderr, "vectory: "+c.code+": ") {
			t.Errorf("%s: %d %q %q", c.name, code, stdout, stderr)
		}
	}
	if code, stdout, _ := invoke("release", "verify", "--key", f.pub, f.manifest); code != 0 || !strings.HasPrefix(stdout, "Valid: ") {
		t.Errorf("the good release: %d %q", code, stdout)
	}
	// Missing files are said by name.
	if code, _, stderr := invoke("release", "verify", "--key", f.pub, "--signatures", filepath.Join(f.dir, "none.sig"), f.manifest); code != 1 || !strings.Contains(stderr, "none.sig doesn't exist") {
		t.Errorf("%d %q", code, stderr)
	}
	if code, _, stderr := invoke("release", "verify", "--key", filepath.Join(f.dir, "none.pub"), f.manifest); code != 1 || !strings.Contains(stderr, "none.pub doesn't exist") {
		t.Errorf("%d %q", code, stderr)
	}
}

// A verify of a signature by one of two keys works with either pin, and says
// which key signed.
func TestReleaseVerifyNamesTheKeyThatSigned(t *testing.T) {
	f := newReleaseFiles(t)
	second, _ := agent.GenerateReleasePrivateKey()
	secondPublic, _ := second.Public("second")
	secondKey := filepath.Join(f.dir, "second.key")
	if err := agent.WriteReleasePrivateKey(secondKey, second); err != nil {
		t.Fatal(err)
	}
	f.sign()
	invoke("release", "sign", "--key", secondKey, "--checksums", f.sums, "--yes", f.manifest)
	secondPub := f.write(t, "second.pub", secondPublic.Line())
	for pub, short := range map[string]string{f.pub: f.public.ShortID(), secondPub: secondPublic.ShortID()} {
		if code, stdout, _ := invoke("release", "verify", "--key", pub, f.manifest); code != 0 || !strings.HasPrefix(stdout, "Valid: release.json is signed by key "+short) {
			t.Errorf("%s: %d %q", pub, code, stdout)
		}
	}
}

// A file is named by what it is in a message about it: the signature file that
// sits beside the manifest is no --signatures flag when nobody typed one, and a
// file argument is not named twice.
func TestReleaseVerifyNamesFilesByWhatTheyAre(t *testing.T) {
	f := newReleaseFiles(t)
	if code, _, stderr := f.sign(); code != 0 {
		t.Fatal(stderr)
	}
	if code, stdout, stderr := invoke("release", "verify", "--key", f.pub, ""); code != 2 || stdout != "" || stderr != "vectory release verify: can't use '' as the release file: path is empty\n" {
		t.Errorf("an empty file name: %d %q %q", code, stdout, stderr)
	}
	if runtime.GOOS == "windows" {
		return // a link needs a privilege there
	}
	real := filepath.Join(f.dir, "real.sig")
	if err := os.Rename(f.manifest+".sig", real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, f.manifest+".sig"); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := invoke("release", "verify", "--key", f.pub, f.manifest)
	if want := "Using " + real + " for the signature file (" + f.manifest + ".sig is a symbolic link).\n"; code != 0 || !strings.HasPrefix(stdout, "Valid: ") || stderr != want {
		t.Errorf("the default signature file is a link: %d %q\n%q, want %q", code, stdout, stderr, want)
	}
	// Named with the flag, it is the flag that is named.
	code, _, stderr = invoke("release", "verify", "--key", f.pub, "--signatures", f.manifest+".sig", f.manifest)
	if want := "Using " + real + " for --signatures (" + f.manifest + ".sig is a symbolic link).\n"; code != 0 || stderr != want {
		t.Errorf("--signatures is a link: %d %q, want %q", code, stderr, want)
	}
}

// ---------------------------------------------------------------- rollover

// A key replaced through the tools: the old key signs a statement naming the
// new one, the new key signs the next release, and a host that pins only the old
// key accepts it and pins the new one.
func TestReleaseRolloverLetsAHostFollowToTheNewKey(t *testing.T) {
	f := newReleaseFiles(t)
	nextPath := filepath.Join(f.dir, "next.key")
	code, stdout, stderr := invoke("release", "keygen", "--out", nextPath, "--name", "team-next")
	if code != 0 {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	var nextLine string
	for _, line := range strings.Split(stdout, "\n") {
		if strings.HasPrefix(line, "vectory-release-key ") {
			nextLine = line
		}
	}
	nextPub := f.write(t, "next.pub", nextLine+"\n")
	next, err := agent.ParseReleaseKey(nextLine)
	if err != nil {
		t.Fatal(err)
	}

	code, stdout, stderr = invoke("release", "rollover", "--key", f.key, "--to", nextPub, "--out", filepath.Join(f.dir, "rollover.json"))
	if code != 0 || stderr != "" {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	want := fmt.Sprintf("Wrote %s: key %s hands over to key %s (team-next).", filepath.Join(f.dir, "rollover.json"), f.public.ShortID(), next.ShortID())
	if !strings.Contains(stdout, want) || !strings.Contains(stdout, "Upload it in Settings → Agent updates.") {
		t.Errorf("the output lacks %q:\n%s", want, stdout)
	}
	// The successor's whole fingerprint is printed for the signer to compare.
	if line := "New key fingerprint, to compare with the key you made: " + agent.GroupFingerprint(next.Fingerprint()) + "\n"; !strings.Contains(stdout, line) {
		t.Errorf("the output lacks %q:\n%s", line, stdout)
	}
	contents := f.read(t, "rollover.json")
	if !strings.HasSuffix(contents, "\n") || strings.Count(contents, "\n") != 1 || !strings.HasPrefix(contents, `{"statement":"`) {
		t.Errorf("the file is the envelope on one line: %q", contents)
	}
	var envelope agent.RolloverEnvelope
	if err := json.Unmarshal([]byte(contents), &envelope); err != nil {
		t.Fatal(err)
	}
	rollover, err := envelope.Parse()
	if err != nil || rollover.From != f.public.Fingerprint() || rollover.To != next || !rollover.VerifiedBy(f.public) {
		t.Fatalf("the statement: %+v %v", rollover, err)
	}

	// The next release is signed by the new key; a host that pins only the old one
	// takes it through the statement, and ends up pinning the new key.
	f.write(t, "release.json", releaseManifestText(f.now, 180*24*time.Hour, 8))
	if code, _, stderr := invoke("release", "sign", "--key", nextPath, "--checksums", f.sums, "--yes", f.manifest); code != 0 {
		t.Fatal(stderr)
	}
	verified, err := agent.VerifyRelease(agent.VerifyInput{
		Manifest: []byte(f.read(t, "release.json")), Signatures: []byte(f.read(t, "release.json.sig")),
		Rollovers: []agent.RolloverEnvelope{envelope}, Pins: []agent.ReleaseKey{f.public},
		Floors: map[string]uint64{f.public.Fingerprint(): 7}, Now: f.now,
		RunningVersion: "0.1.0", OS: "linux", Arch: "amd64", Track: agent.ReleaseTrackPatch, ServiceDefinition: 1,
	})
	if err != nil {
		t.Fatalf("a host refuses the release: %v", err)
	}
	if len(verified.Pins) != 1 || verified.Pins[0] != next || verified.Floors[next.Fingerprint()] != 8 {
		t.Errorf("pins %v floors %v", verified.Pins, verified.Floors)
	}
}

func TestReleaseRolloverRefusesWhatItCannotDoSafely(t *testing.T) {
	f := newReleaseFiles(t)
	other, _ := agent.GenerateReleasePrivateKey()
	otherPublic, _ := other.Public("other")
	otherPub := f.write(t, "other.pub", otherPublic.Line()+"\n")
	smallPub := f.write(t, "small.pub", "vectory-release-key ed25519 AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= small\n")
	badPub := f.write(t, "bad.pub", "not a key\n")

	if code, _, stderr := invoke("release", "rollover", "--key", f.key, "--to", f.pub); code != 2 || !strings.Contains(stderr, "a key can't replace itself") {
		t.Errorf("to itself: %d %q", code, stderr)
	}
	privatePublic := filepath.Join(f.dir, "public-as-private.key")
	if err := agent.AtomicWrite(privatePublic, []byte(f.public.Line()+"\n")); err != nil {
		t.Fatal(err)
	}
	for name, pub := range map[string]string{"a key of small order": smallPub, "text that is not a key": badPub} {
		if code, _, stderr := invoke("release", "rollover", "--key", f.key, "--to", pub); code != 1 || !strings.Contains(stderr, "RELEASE_KEY_INVALID") {
			t.Errorf("%s: %d %q", name, code, stderr)
		}
	}
	if code, _, stderr := invoke("release", "rollover", "--key", privatePublic, "--to", otherPub); code != 1 || !strings.Contains(stderr, "not a release private key") {
		t.Errorf("a public key as --key: %d %q", code, stderr)
	}
	if code, _, stderr := invoke("release", "rollover", "--to", otherPub); code != 2 || !strings.Contains(stderr, "--key is required") {
		t.Errorf("%d %q", code, stderr)
	}
	if code, _, stderr := invoke("release", "rollover", "--key", f.key); code != 2 || !strings.Contains(stderr, "--to is required") {
		t.Errorf("%d %q", code, stderr)
	}
	if f.exists("rollover.json") {
		t.Error("a refused rollover wrote a file")
	}

	// An existing statement is never replaced.
	t.Chdir(f.dir)
	if code, _, stderr := invoke("release", "rollover", "--key", f.key, "--to", otherPub); code != 0 {
		t.Fatalf("%d %q", code, stderr)
	}
	first := f.read(t, "rollover.json")
	code, stdout, stderr := invoke("release", "rollover", "--key", f.key, "--to", otherPub)
	if code != 1 || stdout != "" || !strings.Contains(stderr, "rollover.json already exists") || f.read(t, "rollover.json") != first {
		t.Errorf("%d %q %q", code, stdout, stderr)
	}
}

// ---------------------------------------------------------------- the plumbing

func TestReleaseGroupHelpAndFlagsBeforeTheVerb(t *testing.T) {
	code, stdout, stderr := invoke("help", "release")
	if code != 0 || stderr != "" {
		t.Fatal(code, stderr)
	}
	for _, want := range []string{"keygen    Create a release key", "sign      Sign a release.json with a release key", "rollover  Hand a release key over to a new one", "verify    Check a release the way a host does"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("the group help lacks %q:\n%s", want, stdout)
		}
	}
	_, general, _ := invoke("help")
	if !strings.Contains(general, "Publish agent builds\n  release             Make release keys, sign agent builds and check signatures\n") {
		t.Errorf("the general help:\n%s", general)
	}
	for _, verb := range []string{"keygen", "sign", "rollover", "verify"} {
		code, stdout, stderr := invoke("help", "release", verb)
		if code != 0 || stderr != "" || !strings.HasPrefix(stdout, "vectory release "+verb+": ") || !strings.Contains(stdout, "Usage:\n  vectory release "+verb+" ") || !strings.Contains(stdout, "Flags:\n") {
			t.Errorf("%s: %d %q %q", verb, code, stdout, stderr)
		}
		if strings.Contains(stdout, "--state-dir") || strings.Contains(stdout, "--json") {
			t.Errorf("%s offers a flag it doesn't have:\n%s", verb, stdout)
		}
	}
	if code, _, stderr := invoke("--json", "release", "verify", "--key", "k", "x"); code != 2 || !strings.Contains(stderr, "put the command first: vectory release verify --json --key k x") {
		t.Errorf("flags before the command: %d %q", code, stderr)
	}
	// The verbs need no state directory and no administrator rights.
	if code, _, _ := invoke("release", "verify", "--state-dir", "/x"); code != 2 {
		t.Error("--state-dir is not a flag of release verbs")
	}
}

func TestReleaseVerbsAreOfflineAndPure(t *testing.T) {
	// The verbs read the files they are given and write only the files they name:
	// run in an empty directory with no state anywhere.
	f := newReleaseFiles(t)
	t.Chdir(f.dir)
	if code, _, stderr := f.sign(); code != 0 {
		t.Fatal(stderr)
	}
	before := dirListing(t, f.dir)
	if code, _, stderr := invoke("release", "verify", "--key", "team.pub", "release.json"); code != 0 {
		t.Fatal(stderr)
	}
	if after := dirListing(t, f.dir); before != after {
		t.Errorf("verify changed the directory:\n%s\n%s", before, after)
	}
}

func dirListing(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return strings.Join(names, ",")
}
