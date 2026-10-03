package agent

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// What an operator typed that can't work says what it was and what to pass
// instead, and is told apart from an operation that failed.
func TestReAdoptDigestMessagesNameTheFileAndTheDigest(t *testing.T) {
	f := newReadoptFixture(t, false)
	for digest, want := range map[string]string{
		"":                    "--expected-sha256 is required",
		"abc123":              "64 hexadecimal characters, and abc123 has 6",
		"ZZ" + f.approved[2:]: "64 hexadecimal characters",
	} {
		_, err := reAdopt(context.Background(), f.dir, "", digest, successfulChecks())
		if err == nil || !IsInputError(err) || !strings.Contains(err.Error(), want) {
			t.Errorf("digest %q: %v", digest, err)
		}
	}
	wrong := strings.Repeat("a", 64)
	_, err := reAdopt(context.Background(), f.dir, "", wrong, successfulChecks())
	if err == nil || IsInputError(err) || !strings.Contains(err.Error(), "the SHA-256 of "+f.binary+" is "+f.approved+", not the "+wrong+" you passed") || !strings.Contains(err.Error(), "no binary was approved") {
		t.Fatalf("a digest that differs: %v", err)
	}
}

func TestInstallSaysWhyAVectorBinaryIsNotSupported(t *testing.T) {
	for version, want := range map[string]string{
		"0.58.1-rc.1": "pre-releases aren't supported",
		"0.59.0":      "this agent requires 0.58.x",
		"0.57.2":      "this agent requires 0.58.x",
	} {
		binary := standInVector(t, fakeVectorConfig{Version: version})
		managed := filepath.Join(t.TempDir(), "managed.json")
		err := InstallWithOptions(context.Background(), t.TempDir(), InstallOptions{Adopt: true, VectorBinary: &binary, ManagedConfig: &managed})
		if err == nil || !strings.Contains(err.Error(), "found Vector "+version+" at "+binary+"; "+want) {
			t.Errorf("Vector %s: %v", version, err)
		}
		if strings.Contains(version, "-") == strings.Contains(err.Error(), "this agent requires") {
			t.Errorf("Vector %s gives the wrong reason: %v", version, err)
		}
	}
}

func TestOptionErrorsThatNoHostCouldAcceptAreInputErrors(t *testing.T) {
	seconds := 3
	for name, options := range map[string]InstallOptions{
		"destination without a port": {AddAllowances: &CapabilityPolicy{AllowedNetworkHosts: []string{"logs.example.net"}}},
		"port out of range":          {AddAllowances: &CapabilityPolicy{AllowedListenAddresses: []string{"0.0.0.0:99999"}}},
		"relative file root":         {AddAllowances: &CapabilityPolicy{AllowedFileRoots: []string{"relative/dir"}}},
		"wildcard file root":         {AddAllowances: &CapabilityPolicy{AllowedFileRoots: []string{exampleFileRoot() + "/*.log"}}},
		"graceful shutdown":          {GracefulShutdownSeconds: &seconds},
	} {
		err := options.validate()
		if err == nil || !IsInputError(err) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, test := range map[string]struct {
		options InstallOptions
		echo    string
	}{
		"destination": {InstallOptions{AddAllowances: &CapabilityPolicy{AllowedNetworkHosts: []string{"logs.example.net"}}}, "logs.example.net isn't an exact host:port"},
		"listener":    {InstallOptions{AddAllowances: &CapabilityPolicy{AllowedListenAddresses: []string{"0.0.0.0:99999"}}}, "0.0.0.0:99999 isn't an exact host:port"},
		"root":        {InstallOptions{AddAllowances: &CapabilityPolicy{AllowedFileRoots: []string{"relative/dir"}}}, "file root relative/dir isn't an absolute path"},
		"seconds":     {InstallOptions{GracefulShutdownSeconds: &seconds}, "--graceful-shutdown-seconds 3 is out of range"},
	} {
		if err := test.options.validate(); err == nil || !strings.Contains(err.Error(), test.echo) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A refusal that depends on the host is not the operator's typing.
	if err := (InstallOptions{AddAllowances: &CapabilityPolicy{AllowedFileRoots: []string{string(filepath.Separator)}}}).validate(); err == nil || IsInputError(err) {
		t.Errorf("the filesystem root: %v", err)
	}
	if err := validateMetricsChange(&[]string{"https://127.0.0.1:9598/metrics"}[0], false); err == nil || !IsInputError(err) || !strings.Contains(err.Error(), "https://127.0.0.1:9598/metrics can't be the metrics endpoint: must be http://") {
		t.Errorf("a metrics URL that can't work: %v", err)
	}
}

func TestSecretBindingMessagesSayWhichPathOrNameIsWrong(t *testing.T) {
	if _, err := ReadSecretBindings("relative/bindings.json"); err == nil || !IsInputError(err) || !strings.Contains(err.Error(), "--secret-files relative/bindings.json isn't an absolute path") {
		t.Errorf("a relative path: %v", err)
	}
	if _, err := ReadSecretBindings(filepath.Join(t.TempDir(), "missing.json")); err == nil || !strings.Contains(err.Error(), "can't be read: no such file or directory") {
		t.Errorf("a missing file: %v", err)
	}
	for name, test := range map[string]struct {
		bindings map[string]string
		want     string
	}{
		"name":  {map[string]string{"9lives": "/etc/vectory/db-password"}, "9lives isn't a secret name"},
		"path":  {map[string]string{"DB_PASSWORD": "db-password"}, "the file for DB_PASSWORD must be an absolute local path, and db-password isn't one"},
		"empty": {map[string]string{"DB_PASSWORD": ""}, "the file for DB_PASSWORD is empty: bind each name to the absolute path of a file"},
	} {
		if err := validateSecretFiles(test.bindings); err == nil || !strings.Contains(err.Error(), test.want) || IsInputError(err) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
