package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/vectory/vectory/agent/internal/agent"
)

// releaseCommand is `vectory release`: the tools a team uses to publish agent
// builds that hosts install on their own. It reads and writes files only, so it
// needs no network, no service and no administrator rights, and it uses the one
// verification path a host uses.
var releaseCommand = command{
	name:    "release",
	group:   "Publish agent builds",
	summary: "Make release keys, sign agent builds and check signatures",
	usage:   "release <verb> [flags]",
	about: `A team signs each agent build with a release key it keeps, and a host that pinned
the key's fingerprint installs only builds that key signed. These verbs make
the key, sign a release.json and check a release the way a host does. They
read and write files only: no network, no service and no administrator rights.`,
	examples: []string{
		"vectory release keygen --out team.key",
		"vectory release sign --key team.key --checksums SHA256SUMS release.json",
		"vectory release verify --key team.pub release.json",
	},
	verbs: []command{
		{name: "keygen", summary: "Create a release key",
			usage: "release keygen --out FILE [--name NAME]",
			about: `Creates a release key. The private half goes in FILE, which keygen creates closed
to other accounts and never replaces. The public half is printed: give it to the
server and save it in a file. Keep FILE off the server: whoever holds it can
sign builds that every host pinning its fingerprint installs as root.`,
			examples: []string{"vectory release keygen --out team.key --name team"},
			define:   defineReleaseKeygen},
		{name: "sign", summary: "Sign a release.json with a release key",
			usage:    "release sign --key FILE --checksums FILE [--yes] [--out FILE] release.json",
			operands: []string{"release.json"},
			about: `Signs the exact bytes of release.json, the file the server prepared for your key.
It signs only when every build's file name and SHA-256 in release.json appear
unchanged in SHA256SUMS, a checksum file you got without the server (the
project's release page, or your own build), so a signature never repeats only
what the server said. It shows the version, counter, expiry and each platform,
and asks before it signs; without a terminal it needs --yes. The signature is
written to release.json.sig beside the file, or to --out; an existing file keeps
its signatures and gains this one only when another key made them.`,
			examples: []string{
				"vectory release sign --key team.key --checksums SHA256SUMS release.json",
				"vectory release sign --key team.key --checksums SHA256SUMS --yes --out /tmp/release.json.sig release.json",
			},
			define: defineReleaseSign},
		{name: "rollover", summary: "Hand a release key over to a new one",
			usage: "release rollover --key FILE --to FILE [--out FILE]",
			about: `Writes a statement, signed by the key being replaced, that names its successor.
Hosts that pin the old key follow it to the new key when they are offered a
release the new key signed, without anyone logging in to them. --key is the old
private key, --to is a file holding the new public key line, and the statement
is written to rollover.json, or to --out, which must not exist. Upload it in
Settings → Agent updates.`,
			examples: []string{"vectory release rollover --key team.key --to team-next.pub"},
			define:   defineReleaseRollover},
		{name: "verify", summary: "Check a release the way a host does",
			usage:    "release verify --key FILE [--signatures FILE] release.json",
			operands: []string{"release.json"},
			about: `Checks release.json and its signatures with the public key in FILE, with the one
function every host uses: the signature, the format of the manifest and its
expiry. The signatures are read from release.json.sig beside the file, or from
--signatures. It has no counter floors or running version of its own, so it
doesn't check them, nor the platform, the track or the service definition: a
host decides those from its own state. Exits 1, with the code a host would
report, when it refuses.`,
			examples: []string{"vectory release verify --key team.pub release.json"},
			define:   defineReleaseVerify},
	},
}

// releaseClock is the time a release is judged at: now.
func releaseClock() time.Time { return time.Now().UTC().Truncate(time.Second) }

func defineReleaseKeygen(c *cli) func() int {
	out := c.String("out", "", "FILE", "The file for the private key; it must not exist")
	name := c.String("name", "release", "NAME", "Display name in the public key line, 1 to 64 printable characters")
	return func() int {
		if *out == "" {
			fmt.Fprintln(c.stderr, "vectory release keygen: --out is required. Name the file for the private key, such as team.key.")
			return exitUsage
		}
		private, err := agent.GenerateReleasePrivateKey()
		if err != nil {
			return c.fail(err)
		}
		public, err := private.Public(*name)
		if err != nil {
			return usageProblem(c, "--name", err)
		}
		path, ok := c.resolveFilePath("out", *out)
		if !ok {
			return exitUsage
		}
		exists := fmt.Errorf("%s already exists, and keygen never replaces a file. Choose a file name that isn't in use", *out)
		if _, err := os.Lstat(path); err == nil {
			return c.fail(exists)
		}
		if err := agent.WriteReleasePrivateKey(path, private); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return c.fail(exists)
			}
			return c.fail(fmt.Errorf("couldn't create %s: %w", *out, err))
		}
		fmt.Fprintf(c.stdout, "Wrote the private key to %s, closed to other accounts.\n", *out)
		fmt.Fprintln(c.stdout, "Keep it off the server. Whoever holds it can sign builds that every host pinning this key installs as root.")
		fmt.Fprintln(c.stdout)
		fmt.Fprintln(c.stdout, "Public key (give it to the server, and save it in a file such as team.pub):")
		fmt.Fprintf(c.stdout, "  %s\n", public.Line())
		fmt.Fprintln(c.stdout, "Fingerprint (hosts pin it; compare it with the one the dashboard shows):")
		fmt.Fprintf(c.stdout, "  %s\n", agent.GroupFingerprint(public.Fingerprint()))
		return exitOK
	}
}

func defineReleaseSign(c *cli) func() int {
	keyFlag := c.String("key", "", "FILE", "The private key file made by release keygen")
	checksums := c.String("checksums", "", "FILE", "SHA256SUMS, the checksum file you got without the server")
	yes := c.Bool("yes", "Sign without asking (needed when there is no terminal)")
	out := c.String("out", "", "FILE", "Write the signatures here (default: release.json.sig beside the manifest)")
	return func() int {
		if !c.requireFlag("key", *keyFlag) || !c.requireFlag("checksums", *checksums) {
			return exitUsage
		}
		manifestPath, ok := c.resolveOperand("release.json", c.operands[0])
		if !ok {
			return exitUsage
		}
		manifestBytes, err := agent.ReadReleaseFile(manifestPath, agent.MaxReleaseManifest)
		if err != nil {
			return c.fail(err)
		}
		manifest, err := agent.ParseReleaseManifest(manifestBytes)
		if err != nil {
			return c.fail(err)
		}
		now := releaseClock()
		if !now.Before(manifest.ExpiresAt) {
			return c.fail(fmt.Errorf("this release expired at %s, and no host would take it. Ask the server to prepare a new release", formatUTC(manifest.ExpiresAt)))
		}
		checksumsPath, ok := c.resolvePath("checksums", *checksums)
		if !ok {
			return exitUsage
		}
		sums, err := agent.ReadReleaseFile(checksumsPath, maxChecksumsFile)
		if err != nil {
			return c.fail(err)
		}
		if problems := checkChecksums(manifest, sums, checksumsPath); len(problems) > 0 {
			fmt.Fprintln(c.stderr, "vectory: not signed: the builds in release.json don't match "+filepath.Base(checksumsPath)+":")
			for _, problem := range problems {
				fmt.Fprintln(c.stderr, "  "+problem)
			}
			return exitFailed
		}
		keyPath, ok := c.resolveFilePath("key", *keyFlag)
		if !ok {
			return exitUsage
		}
		private, err := agent.ReadReleasePrivateKey(keyPath)
		if err != nil {
			return c.fail(err)
		}
		shownOut := manifestOutputPath(*out, c.operands[0])
		outPath, ok := c.resolveFilePath("out", shownOut)
		if !ok {
			return exitUsage
		}
		existing, err := readExistingSignatures(outPath)
		if err != nil {
			return c.fail(err)
		}
		signature := private.SignRelease(manifestBytes)
		entry := agent.ReleaseSignature{Key: private.Fingerprint()}
		copy(entry.Signature[:], signature)
		entries, already, err := addSignature(existing, entry, outPath)
		if err != nil {
			return c.fail(err)
		}
		// What is about to be written must be a signature a host accepts: check
		// it with the verification every host uses before anything changes.
		public, err := private.Public("release")
		if err != nil {
			return c.fail(err)
		}
		file, err := agent.BuildReleaseSignatures(entries)
		if err != nil {
			return c.fail(err)
		}
		if _, err := agent.VerifyReleaseFiles(agent.VerifyInput{Manifest: manifestBytes, Signatures: file, Pins: []agent.ReleaseKey{public}, Now: now}); err != nil {
			return c.fail(fmt.Errorf("the signature doesn't verify, so nothing was written: %w", err))
		}

		printRelease(c.stdout, manifest, now)
		fmt.Fprintf(c.stdout, "Every file name and SHA-256 matches %s.\n", filepath.Base(checksumsPath))
		if already {
			fmt.Fprintf(c.stdout, "%s already holds this signature by key %s. Nothing changed.\n", shownOut, private.Fingerprint()[:16])
			return exitOK
		}
		if !*yes {
			answer, terminal := c.ask(fmt.Sprintf("Sign this release with key %s? [y/N] ", private.Fingerprint()[:16]))
			if !terminal {
				fmt.Fprintln(c.stderr, "vectory release sign: there is no terminal to ask on. Check the summary above, then run the command again with --yes.")
				return exitFailed
			}
			if answer = strings.ToLower(answer); answer != "y" && answer != "yes" {
				fmt.Fprintln(c.stderr, "Not signed.")
				return exitFailed
			}
		}
		if err := writeFileAtomically(outPath, file, 0o644); err != nil {
			return c.fail(fmt.Errorf("couldn't write %s: %w", shownOut, err))
		}
		fmt.Fprintf(c.stdout, "Signed with key %s. Wrote %s (%s).\n", private.Fingerprint()[:16], shownOut, plural(len(entries), "signature"))
		fmt.Fprintf(c.stdout, "Next: upload %s to the release on Devices → Agent updates.\n", filepath.Base(outPath))
		return exitOK
	}
}

func defineReleaseRollover(c *cli) func() int {
	keyFlag := c.String("key", "", "FILE", "The private key being replaced")
	to := c.String("to", "", "FILE", "A file holding the public key line of the new key")
	out := c.String("out", "", "FILE", "Write the statement here (default rollover.json; it must not exist)")
	return func() int {
		if !c.requireFlag("key", *keyFlag) || !c.requireFlag("to", *to) {
			return exitUsage
		}
		keyPath, ok := c.resolveFilePath("key", *keyFlag)
		if !ok {
			return exitUsage
		}
		old, err := agent.ReadReleasePrivateKey(keyPath)
		if err != nil {
			return c.fail(err)
		}
		toPath, ok := c.resolvePath("to", *to)
		if !ok {
			return exitUsage
		}
		successor, err := agent.ReadReleasePublicKeyFile(toPath)
		if err != nil {
			return c.fail(err)
		}
		if successor.Fingerprint() == old.Fingerprint() {
			fmt.Fprintln(c.stderr, "vectory release rollover: --to is the key that --key holds, and a key can't replace itself.")
			return exitUsage
		}
		path := *out
		if path == "" {
			path = "rollover.json"
		}
		shownOut := path
		if path, ok = c.resolveFilePath("out", path); !ok {
			return exitUsage
		}
		envelope, err := agent.SignRollover(old, successor, releaseClock())
		if err != nil {
			return c.fail(err)
		}
		contents := []byte(`{"statement":"` + envelope.Statement + `","signature":"` + envelope.Signature + `"}` + "\n")
		if err := writeFileExclusively(path, contents, 0o644); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return c.fail(fmt.Errorf("%s already exists. Choose another --out, or remove it if it is an old statement", shownOut))
			}
			return c.fail(fmt.Errorf("couldn't write %s: %w", shownOut, err))
		}
		fmt.Fprintf(c.stdout, "Wrote %s: key %s hands over to key %s (%s).\n", shownOut, old.Fingerprint()[:16], successor.ShortID(), successor.Name())
		fmt.Fprintf(c.stdout, "New key fingerprint, to compare with the key you made: %s\n", agent.GroupFingerprint(successor.Fingerprint()))
		fmt.Fprintln(c.stdout, "Upload it in Settings → Agent updates. Hosts that pin the old key follow it when they are offered a release the new key signed.")
		return exitOK
	}
}

func defineReleaseVerify(c *cli) func() int {
	keyFlag := c.String("key", "", "FILE", "A file holding the public key line to verify with")
	signatures := c.String("signatures", "", "FILE", "The signature file (default: release.json.sig beside the manifest)")
	return func() int {
		if !c.requireFlag("key", *keyFlag) {
			return exitUsage
		}
		keyPath, ok := c.resolvePath("key", *keyFlag)
		if !ok {
			return exitUsage
		}
		key, err := agent.ReadReleasePublicKeyFile(keyPath)
		if err != nil {
			return c.fail(err)
		}
		manifestPath, ok := c.resolveOperand("release.json", c.operands[0])
		if !ok {
			return exitUsage
		}
		signaturesPath := *signatures
		if signaturesPath == "" {
			signaturesPath = manifestOutputPath("", c.operands[0])
		}
		if signaturesPath, ok = c.resolvePath("signatures", signaturesPath); !ok {
			return exitUsage
		}
		manifestBytes, err := agent.ReadReleaseFile(manifestPath, agent.MaxReleaseManifest)
		if err != nil {
			return c.fail(err)
		}
		signatureBytes, err := agent.ReadReleaseFile(signaturesPath, agent.MaxReleaseSignatures)
		if err != nil {
			return c.fail(err)
		}
		now := releaseClock()
		verified, err := agent.VerifyReleaseFiles(agent.VerifyInput{Manifest: manifestBytes, Signatures: signatureBytes, Pins: []agent.ReleaseKey{key}, Now: now})
		if err != nil {
			return c.fail(err)
		}
		fmt.Fprintf(c.stdout, "Valid: %s is signed by key %s (%s).\n", filepath.Base(c.operands[0]), key.ShortID(), key.Name())
		printRelease(c.stdout, verified.Manifest, now)
		fmt.Fprintln(c.stdout, "This check has no counter floors or running version. A host also checks those, its track, its platform and its service definition.")
		return exitOK
	}
}

// ---------------------------------------------------------------- the summary

func formatUTC(instant time.Time) string { return instant.UTC().Format("2006-01-02 15:04") + " UTC" }

// untilText says how long from now an instant is, rounded to days from a day and
// a half, and to hours from an hour and a half.
func untilText(now, instant time.Time) string {
	remaining := instant.Sub(now)
	switch {
	case remaining >= 36*time.Hour:
		return "in " + plural(int(remaining.Round(24*time.Hour)/(24*time.Hour)), "day")
	case remaining >= 90*time.Minute:
		return "in " + plural(int(remaining.Round(time.Hour)/time.Hour), "hour")
	}
	return "in under 2 hours"
}

func plural(count int, noun string) string {
	if count == 1 {
		return fmt.Sprintf("1 %s", noun)
	}
	return fmt.Sprintf("%d %ss", count, noun)
}

// printRelease prints what a signature authorizes: the version, the counter,
// the expiry, who can take it and each build.
func printRelease(w io.Writer, manifest agent.ReleaseManifest, now time.Time) {
	fmt.Fprintf(w, "Agent %s · counter %d · expires %s (%s)\n", manifest.Version, manifest.Counter, formatUTC(manifest.ExpiresAt), untilText(now, manifest.ExpiresAt))
	if manifest.MinFrom != "" {
		fmt.Fprintf(w, "  For agents running %s or newer\n", manifest.MinFrom)
	}
	platformWidth, fileWidth := 0, 0
	for _, artifact := range manifest.Artifacts {
		platformWidth = max(platformWidth, len(artifact.OS+"/"+artifact.Arch))
		fileWidth = max(fileWidth, len(artifact.File))
	}
	for _, artifact := range manifest.Artifacts {
		fmt.Fprintf(w, "  %-*s  %-*s  %d bytes  sha256 %s…\n", platformWidth, artifact.OS+"/"+artifact.Arch, fileWidth, artifact.File, artifact.Size, artifact.SHA256[:16])
	}
}

// ---------------------------------------------------------------- the checksums

// maxChecksumsFile bounds a SHA256SUMS file: a release holds a few dozen
// lines, and a file that is much longer is something else.
const maxChecksumsFile = 1 << 20

// parseChecksums reads a SHA256SUMS file: lines of `<64 hex>  <name>` (text
// mode) or `<64 hex> *<name>` (binary mode), as sha256sum and the release build
// write them, with blank lines and # comments allowed. It returns the digests
// listed for each name, in lowercase.
func parseChecksums(contents []byte) (map[string][]string, error) {
	listed := map[string][]string{}
	for number, line := range strings.Split(string(contents), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if len(line) < 67 || (line[64] != ' ') || (line[65] != ' ' && line[65] != '*') {
			return nil, fmt.Errorf("line %d isn't `<sha-256>  <file name>`", number+1)
		}
		digest := strings.ToLower(line[:64])
		for i := 0; i < len(digest); i++ {
			if (digest[i] < '0' || digest[i] > '9') && (digest[i] < 'a' || digest[i] > 'f') {
				return nil, fmt.Errorf("line %d doesn't start with a SHA-256 in hexadecimal", number+1)
			}
		}
		name := line[66:]
		listed[name] = append(listed[name], digest)
	}
	return listed, nil
}

// checkChecksums compares every build of the manifest with the checksum file
// and returns what doesn't match: a build with no line, or a different digest.
func checkChecksums(manifest agent.ReleaseManifest, contents []byte, path string) []string {
	listed, err := parseChecksums(contents)
	if err != nil {
		return []string{filepath.Base(path) + ": " + err.Error()}
	}
	var problems []string
	for _, artifact := range manifest.Artifacts {
		digests := slices.Compact(slices.Sorted(slices.Values(listed[artifact.File])))
		switch {
		case len(digests) == 0:
			problems = append(problems, fmt.Sprintf("%s has no line for %s", filepath.Base(path), artifact.File))
		case len(digests) > 1:
			problems = append(problems, fmt.Sprintf("%s lists %s with different digests (%s)", filepath.Base(path), artifact.File, strings.Join(digests, " and ")))
		case digests[0] != artifact.SHA256:
			problems = append(problems, fmt.Sprintf("%s: release.json says %s and %s says %s", artifact.File, artifact.SHA256, filepath.Base(path), digests[0]))
		}
	}
	return problems
}

// ---------------------------------------------------------------- the files

// manifestOutputPath is where the signatures of a manifest go: --out, or the
// manifest's own path with .sig added.
func manifestOutputPath(out, manifest string) string {
	if out != "" {
		return out
	}
	return manifest + ".sig"
}

// resolveOperand makes the path of a file argument absolute and canonical.
func (c *cli) resolveOperand(label, value string) (string, bool) {
	resolved, err := agent.ResolveOperatorPath(value)
	if err != nil {
		fmt.Fprintf(c.stderr, "vectory %s: %s %s: %s\n", c.cmd.words(), label, value, err)
		return "", false
	}
	if resolved.Resolved {
		fmt.Fprintf(c.stderr, "Using %s for %s (%s is a symbolic link).\n", resolved.Path, label, value)
	}
	return resolved.Path, true
}

// requireFlag reports whether a flag a command can't run without has a value;
// when it doesn't, it prints a usage error.
func (c *cli) requireFlag(name, value string) bool {
	if value != "" {
		return true
	}
	fmt.Fprintf(c.stderr, "vectory %s: --%s is required.\nRun 'vectory help %s' for usage.\n", c.cmd.words(), name, c.cmd.words())
	return false
}

func usageProblem(c *cli, flagName string, err error) int {
	message := err.Error()
	var refusal *agent.UpdateRefusal
	if errors.As(err, &refusal) {
		message = refusal.Detail
	}
	fmt.Fprintf(c.stderr, "vectory %s: %s: %s\n", c.cmd.words(), flagName, message)
	return exitUsage
}

// readExistingSignatures reads the signature file a new signature joins. A path
// with nothing there gives no entries; a path that is not a regular file, or
// holds something other than a signature file, is refused, so an existing file
// is never overwritten by guesswork.
func readExistingSignatures(path string) ([]agent.ReleaseSignature, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s exists and isn't a regular file. Choose another --out", path)
	}
	contents, err := agent.ReadReleaseFile(path, agent.MaxReleaseSignatures)
	if err != nil {
		return nil, err
	}
	entries, err := agent.ParseReleaseSignatures(contents)
	if err != nil {
		return nil, fmt.Errorf("%s exists and isn't a signature file, so it was left alone (%w). Choose another --out", path, err)
	}
	return entries, nil
}

// addSignature joins a new signature to the entries of an existing file. A
// signature is only ever added: an entry by the same key stays as it is, and is
// reported as already there only when it is this very signature.
func addSignature(existing []agent.ReleaseSignature, entry agent.ReleaseSignature, path string) ([]agent.ReleaseSignature, bool, error) {
	for _, held := range existing {
		if held.Key != entry.Key {
			continue
		}
		if held.Signature == entry.Signature {
			return existing, true, nil
		}
		return nil, false, fmt.Errorf("%s already holds a signature by key %s that isn't a signature of this release.json. Delete the file, or choose another --out", path, entry.Key[:16])
	}
	if len(existing) >= 4 {
		return nil, false, fmt.Errorf("%s already holds 4 signatures, the most a release takes", path)
	}
	return append(slices.Clone(existing), entry), false, nil
}

// writeFileExclusively creates a new file and writes it whole, or removes what
// it created: an existing path of any kind is refused.
func writeFileExclusively(path string, contents []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err = file.Write(contents); err == nil {
		err = file.Sync()
	}
	if closed := file.Close(); err == nil {
		err = closed
	}
	if err != nil {
		_ = os.Remove(path)
	}
	return err
}

// writeFileAtomically replaces a file, or creates it, so that a reader sees the
// old file or the new one and never part of either.
func writeFileAtomically(path string, contents []byte, mode os.FileMode) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".vectory-release-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if _, err = temp.Write(contents); err == nil {
		err = temp.Chmod(mode)
	}
	if err == nil {
		err = temp.Sync()
	}
	if closed := temp.Close(); err == nil {
		err = closed
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}
