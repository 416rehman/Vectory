package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func sourceNames(sources []configSource) []string {
	var out []string
	for _, s := range sources {
		out = append(out, s.named+" "+s.kind+" "+s.pattern)
	}
	return out
}

// Which files Vector loads follows its own options: -c and --config, -C and
// --config-dir, the format-specific ones, their environment variables (only
// for an option the arguments leave out), commas that separate values, and the
// default path when nothing names configuration.
func TestVectorConfigSourcesFollowVectorsOptions(t *testing.T) {
	def := defaultVectorConfig()
	cases := []struct {
		name string
		args []string
		env  map[string]string
		want []string
	}{
		{"nothing named", nil, nil, []string{"the default path file " + def}},
		{"only unrelated options", []string{"--watch-config", "-q", "--log-level", "debug"}, nil, []string{"the default path file " + def}},
		{"--config twice", []string{"--config", "/a.yaml", "--config", "/b.toml"}, nil, []string{"--config file /a.yaml", "--config file /b.toml"}},
		{"--config=", []string{"--config=/a.yaml"}, nil, []string{"--config file /a.yaml"}},
		{"-c", []string{"-c", "/a.yaml"}, nil, []string{"-c file /a.yaml"}},
		{"-c attached", []string{"-c/a.yaml"}, nil, []string{"-c file /a.yaml"}},
		{"-c=", []string{"-c=/a.yaml"}, nil, []string{"-c file /a.yaml"}},
		{"a cluster", []string{"-wc", "/a.yaml"}, nil, []string{"-c file /a.yaml"}},
		{"commas", []string{"-c", "/a.yaml,/b.yaml, /c.yaml"}, nil, []string{"-c file /a.yaml", "-c file /b.yaml", "-c file /c.yaml"}},
		{"-C and --config-dir", []string{"-C", "/conf.d", "--config-dir", "/more.d"}, nil, []string{"-C directory /conf.d", "--config-dir directory /more.d"}},
		{"format options", []string{"--config-toml", "/a.toml", "--config-json=/b.json", "--config-yaml", "/c.yaml"}, nil, []string{"--config-toml file /a.toml", "--config-json file /b.json", "--config-yaml file /c.yaml"}},
		{"environment supplies what the arguments leave out", nil, map[string]string{"VECTOR_CONFIG_DIR": "/conf.d"}, []string{"VECTOR_CONFIG_DIR directory /conf.d"}},
		{"arguments beat the environment for the same option", []string{"-c", "/a.yaml"}, map[string]string{"VECTOR_CONFIG": "/env.yaml"}, []string{"-c file /a.yaml"}},
		{"another option's environment still applies", []string{"-c", "/a.yaml"}, map[string]string{"VECTOR_CONFIG_DIR": "/conf.d"}, []string{"-c file /a.yaml", "VECTOR_CONFIG_DIR directory /conf.d"}},
		{"an empty environment variable is unset", nil, map[string]string{"VECTOR_CONFIG": ""}, []string{"the default path file " + def}},
		{"a subcommand's options after --", []string{"--", "-c", "/ignored.yaml"}, nil, []string{"the default path file " + def}},
		{"an option without its value", []string{"--config"}, nil, []string{"the default path file " + def}},
		{"unknown long option with a value", []string{"--unknown=x", "--config", "/a.yaml"}, nil, []string{"--config file /a.yaml"}},
	}
	for _, c := range cases {
		if got := sourceNames(vectorConfigSources(c.args, c.env)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got %q\nwant %q", c.name, got, c.want)
		}
	}
	if got := vectorConfigSources([]string{"--config-json", "/a"}, nil); got[0].format != "json" {
		t.Errorf("--config-json expects JSON, got %q", got[0].format)
	}
}

func TestScanConfigFindsWhatAdoptionMustNotIgnore(t *testing.T) {
	cases := []struct {
		name, format, text string
		provider           string
		includes           []string
		secrets            []string
		environment        []string
	}{
		{name: "plain yaml", format: "yaml", text: "sources:\n  in:\n    type: demo_logs\nsinks:\n  out:\n    type: blackhole\n    inputs: [in]\n"},
		{name: "yaml include list", format: "yaml", text: "include:\n  - extra.yaml\n  - \"more.yaml\"\nsources: {}\n", includes: []string{"extra.yaml", "more.yaml"}},
		{name: "yaml include inline", format: "yaml", text: "include: [a.yaml, b.yaml]\n", includes: []string{"a.yaml, b.yaml"}},
		{name: "yaml include at the list's own indent", format: "yaml", text: "includes:\n- a.yaml\n", includes: []string{"a.yaml"}},
		{name: "yaml provider", format: "yaml", text: "provider:\n  type: http\n  url: https://example.invalid/config\n", provider: "http"},
		{name: "yaml include only inside a component is not a root include", format: "yaml", text: "sources:\n  in:\n    type: demo_logs\n    include: x\n"},
		{name: "yaml secret backends and references", format: "yaml", text: "secret:\n  file_secrets:\n    type: file\n    path: /etc/vector/secrets.json\n  other:\n    type: exec\nsinks:\n  out:\n    auth:\n      token: SECRET[file_secrets.token]\n", secrets: []string{"file_secrets", "other"}},
		{name: "secret reference without a backend block", format: "yaml", text: "sinks:\n  out:\n    auth:\n      token: SECRET[vault.api.key]\n", secrets: []string{"vault"}},
		{name: "environment variables", format: "yaml", text: "sinks:\n  out:\n    endpoint: ${ENDPOINT:-http://x}\n    token: $API_TOKEN\n    lowercase: ${not_matched_bare}\n", environment: []string{"API_TOKEN", "ENDPOINT", "not_matched_bare"}},
		{name: "json root include and provider", format: "json", text: `{"include":["other.yaml"],"provider":{"type":"http","url":"http://x"},"sources":{}}`, provider: "http", includes: []string{"other.yaml"}},
		{name: "json secret", format: "json", text: `{"secret":{"aws":{"type":"aws_secrets_manager"}},"sources":{}}`, secrets: []string{"aws"}},
		{name: "json provider without a type", format: "json", text: `{"provider":{}}`, provider: "unknown"},
		{name: "yaml written as json", format: "yaml", text: `{"include":"x.yaml","sources":{}}`, includes: []string{"x.yaml"}},
		{name: "toml include", format: "toml", text: "include = [\"a.toml\"]\n[sources.in]\ntype = \"demo_logs\"\n", includes: []string{"a.toml"}},
		{name: "toml provider table", format: "toml", text: "[provider]\ntype = \"http\"\nurl = \"http://x\"\n[sources.in]\ntype = \"demo_logs\"\n", provider: "http"},
		{name: "toml provider inline", format: "toml", text: "provider = { type = \"http\", url = \"http://x\" }\n", provider: "http"},
		{name: "toml a later table's type is not the provider's", format: "toml", text: "[provider]\nurl = \"http://x\"\n[sources.in]\ntype = \"demo_logs\"\n", provider: "unknown"},
		{name: "toml include inside a table is not a root include", format: "toml", text: "[sources.in]\ntype = \"demo_logs\"\ninclude = \"x\"\n"},
		{name: "toml secret table", format: "toml", text: "[secret.file_secrets]\ntype = \"file\"\n", secrets: []string{"file_secrets"}},
		{name: "unknown format still finds references", format: "", text: "token: SECRET[vault.k] $HOME_DIR", secrets: []string{"vault"}, environment: []string{"HOME_DIR"}},
	}
	for _, c := range cases {
		got := scanConfig(c.format, []byte(c.text))
		if got.provider != c.provider || !reflect.DeepEqual(got.includes, c.includes) || !reflect.DeepEqual(got.secrets, c.secrets) || !reflect.DeepEqual(got.environment, c.environment) {
			t.Errorf("%s:\n got %+v\nwant provider %q includes %q secrets %q environment %q", c.name, got, c.provider, c.includes, c.secrets, c.environment)
		}
	}
}

func writeConfigFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func startup(command ...string) VectorStartup {
	return VectorStartup{PID: 812, Command: append([]string{"/usr/bin/vector"}, command...), Source: "process", EnvironmentKnown: true}
}

func kinds(inventory AdoptionInventory) []string {
	var out []string
	for _, c := range inventory.Concerns {
		blocks := ""
		if c.Blocks {
			blocks = "!"
		}
		out = append(out, blocks+c.Kind)
	}
	return out
}

const minimalYAML = "sources:\n  in:\n    type: demo_logs\n    format: json\nsinks:\n  out:\n    type: blackhole\n    inputs: [in]\n"

func TestInventoryOfOneFileHasNothingThatStopsSetup(t *testing.T) {
	dir := t.TempDir()
	writeConfigFiles(t, dir, map[string]string{"vector.yaml": minimalYAML})
	path := filepath.Join(dir, "vector.yaml")
	inventory := InventoryVector([]VectorStartup{startup("--config", path)})
	if len(inventory.Files) != 1 || inventory.Files[0].Path != path || inventory.Files[0].SHA256 != Digest([]byte(minimalYAML)) || inventory.Files[0].Bytes != int64(len(minimalYAML)) || inventory.Files[0].NamedBy != "--config" || inventory.Files[0].Format != "yaml" {
		t.Fatalf("%+v", inventory.Files)
	}
	if len(inventory.Concerns) != 0 || len(inventory.Blocking()) != 0 {
		t.Fatalf("a single plain file raised concerns: %+v", inventory.Concerns)
	}
	if inventory.Fingerprint == "" || inventory.Fingerprint != InventoryVector([]VectorStartup{startup("--config", path)}).Fingerprint {
		t.Fatal("the fingerprint of an unchanged Vector must be stable")
	}
	if err := os.WriteFile(path, []byte(minimalYAML+"# changed\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if InventoryVector([]VectorStartup{startup("--config", path)}).Fingerprint == inventory.Fingerprint {
		t.Fatal("a changed file kept its fingerprint")
	}
}

func TestInventoryOfAConfigDirectoryWithSeveralFilesBlocks(t *testing.T) {
	dir := t.TempDir()
	writeConfigFiles(t, dir, map[string]string{
		"10-sources.yaml":         minimalYAML,
		"20-sinks.yml":            "sinks: {}\n",
		".hidden.toml":            "[sources]\n",
		"notes.txt":               "not configuration",
		"Upper.YAML":              "not read: extensions are case-sensitive",
		"sources/http.json":       `{"type":"http_server"}`,
		"other-dir/ignored.yaml":  "not a component directory",
		"transforms/remap.yaml":   "type: remap\n",
		"sinks/deep/ignored.yaml": "too deep",
	})
	inventory := InventoryVector([]VectorStartup{startup("--config-dir", dir)})
	var names []string
	for _, file := range inventory.Files {
		rel, _ := filepath.Rel(dir, file.Path)
		names = append(names, filepath.ToSlash(rel))
	}
	want := []string{".hidden.toml", "10-sources.yaml", "20-sinks.yml", "sources/http.json", "transforms/remap.yaml"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("files %q, want %q", names, want)
	}
	if got := kinds(inventory); len(got) == 0 || got[0] != "!several_files" {
		t.Fatalf("concerns %q", got)
	}
	several := inventory.Concerns[0]
	if !strings.Contains(several.Detail, "Vector loads 5 configuration files") || !strings.Contains(several.Detail, "10-sources.yaml") || !strings.Contains(several.Detail, "20-sinks.yml") || len(several.Files) != 5 {
		t.Fatalf("the refusal must name the files: %+v", several)
	}
	for _, file := range inventory.Files {
		if file.NamedBy != "--config-dir" || file.SHA256 == "" {
			t.Fatalf("%+v", file)
		}
	}
}

func TestInventoryNamesAnyTopologyTheAgentWouldNotManage(t *testing.T) {
	dir := t.TempDir()
	writeConfigFiles(t, dir, map[string]string{
		"plain.yaml":    minimalYAML,
		"included.yaml": "include:\n  - other.yaml\n" + minimalYAML,
		"provider.json": `{"provider":{"type":"http","url":"http://127.0.0.1:1/config"}}`,
		"secret.yaml":   "secret:\n  file_secrets:\n    type: file\nsinks:\n  out:\n    token: SECRET[file_secrets.t]\n",
		"env.yaml":      "sinks:\n  out:\n    endpoint: ${ENDPOINT}\n",
		"weird.conf":    "sources: {}\n",
	})
	at := func(name string) string { return filepath.Join(dir, name) }
	cases := []struct {
		name  string
		start VectorStartup
		want  []string
	}{
		{"include", startup("-c", at("included.yaml")), []string{"!include"}},
		{"provider", startup("-c", at("provider.json")), []string{"!provider"}},
		{"secrets are noted, not blocked", startup("-c", at("secret.yaml")), []string{"secret_backend"}},
		{"environment variables are noted, not blocked", startup("-c", at("env.yaml")), []string{"environment_variables"}},
		{"an unknown extension is read as TOML, and noted", startup("-c", at("weird.conf")), []string{"format_assumed"}},
		{"a file that doesn't exist is noted", startup("-c", at("gone.yaml")), []string{"missing"}},
		{"a directory given as a file", startup("-c", dir), []string{"!unresolved"}},
		{"a glob of several files", startup("-c", filepath.Join(dir, "p*")), []string{"!several_files", "!provider"}},
		{"a glob that matches nothing", startup("-c", filepath.Join(dir, "zzz*")), []string{"missing"}},
		{"a recursive wildcard is not expanded", startup("-c", filepath.Join(dir, "**", "*.yaml")), []string{"!unresolved"}},
		{"a relative path with no working directory", startup("-c", "vector.yaml"), []string{"!unresolved"}},
		{"a file for a directory option", startup("-C", at("plain.yaml")), []string{"!unresolved"}},
	}
	for _, c := range cases {
		if got := kinds(InventoryVector([]VectorStartup{c.start})); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestInventoryResolvesRelativePathsAgainstTheProcessWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	writeConfigFiles(t, dir, map[string]string{"etc/vector.yaml": minimalYAML})
	process := startup("--config", "etc/vector.yaml")
	process.WorkDir = dir
	inventory := InventoryVector([]VectorStartup{process})
	if len(inventory.Files) != 1 || inventory.Files[0].Path != filepath.Join(dir, "etc", "vector.yaml") || len(inventory.Concerns) != 0 {
		t.Fatalf("%+v %+v", inventory.Files, inventory.Concerns)
	}
}

func TestInventoryConfigurationChosenByTheEnvironmentBlocks(t *testing.T) {
	dir := t.TempDir()
	writeConfigFiles(t, dir, map[string]string{"vector.yaml": minimalYAML})
	process := startup()
	process.Environment = map[string]string{"VECTOR_CONFIG": filepath.Join(dir, "vector.yaml")}
	process.Service = "vector.service"
	inventory := InventoryVector([]VectorStartup{process})
	if len(inventory.Files) != 1 || inventory.Files[0].NamedBy != "VECTOR_CONFIG" {
		t.Fatalf("%+v", inventory.Files)
	}
	got := kinds(inventory)
	if !reflect.DeepEqual(got, []string{"!environment_selected"}) {
		t.Fatalf("%q", got)
	}
	detail := inventory.Concerns[0].Detail
	if !strings.Contains(detail, "VECTOR_CONFIG environment variable of vector.service") {
		t.Fatalf("the refusal must name the variable and the service: %q", detail)
	}
	both := startup()
	both.Environment = map[string]string{"VECTOR_CONFIG": filepath.Join(dir, "vector.yaml"), "VECTOR_CONFIG_DIR": dir}
	if detail := InventoryVector([]VectorStartup{both}).Concerns[0].Detail; !strings.Contains(detail, "VECTOR_CONFIG and VECTOR_CONFIG_DIR environment variables") {
		t.Fatalf("%q", detail)
	}
}

func TestInventoryWhenTheProcessCannotBeRead(t *testing.T) {
	dir := t.TempDir()
	writeConfigFiles(t, dir, map[string]string{"vector.yaml": minimalYAML})
	path := filepath.Join(dir, "vector.yaml")

	blind := startup("--config", path)
	blind.EnvironmentKnown = false
	if got := kinds(InventoryVector([]VectorStartup{blind})); !reflect.DeepEqual(got, []string{"!environment_unknown"}) {
		t.Fatalf("an unreadable environment can't rule out VECTOR_CONFIG_DIR: %q", got)
	}
	nothing := VectorStartup{PID: 9}
	inventory := InventoryVector([]VectorStartup{nothing})
	if got := kinds(inventory); !reflect.DeepEqual(got, []string{"!unknown_command"}) || len(inventory.Files) != 0 {
		t.Fatalf("without a command the configuration is unknown: %q", got)
	}
	if !strings.Contains(inventory.Concerns[0].Detail, "pid 9") || !strings.Contains(inventory.Concerns[0].Detail, "sudo") {
		t.Fatalf("%q", inventory.Concerns[0].Detail)
	}
	service := VectorStartup{PID: 9, ServiceCommand: []string{"/usr/bin/vector", "--config", path}, Source: "service", Service: "vector.service", EnvironmentKnown: true}
	if inventory := InventoryVector([]VectorStartup{service}); len(inventory.Files) != 1 || len(inventory.Concerns) != 0 {
		t.Fatalf("the service's definition stands in for a process that can't be read: %+v", inventory)
	}
}

func TestInventoryLimitsWhatItReads(t *testing.T) {
	dir := t.TempDir()
	big := filepath.Join(dir, "big.yaml")
	f, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Truncate(inventoryFileLimit + 1); err != nil {
		t.Skip("this file system can't make a sparse file:", err)
	}
	f.Close()
	inventory := InventoryVector([]VectorStartup{startup("-c", big)})
	if len(inventory.Files) != 1 || inventory.Files[0].SHA256 != "" || inventory.Files[0].Backup != "" || inventory.Files[0].content != nil {
		t.Fatalf("an oversized file was read: %+v", inventory.Files)
	}
	if got := kinds(inventory); !reflect.DeepEqual(got, []string{"!too_large"}) {
		t.Fatalf("%q", got)
	}

	many := t.TempDir()
	files := map[string]string{}
	for i := 0; i < inventoryMaxFiles+3; i++ {
		files[fmt.Sprintf("f%04d.yaml", i)] = "sources: {}\n"
	}
	writeConfigFiles(t, many, files)
	inventory = InventoryVector([]VectorStartup{startup("-C", many)})
	if len(inventory.Files) != inventoryMaxFiles {
		t.Fatalf("%d files kept", len(inventory.Files))
	}
	found := false
	for _, c := range inventory.Concerns {
		found = found || c.Kind == "too_large" && c.Blocks && strings.Contains(c.Detail, "3 were not inventoried")
	}
	if !found {
		t.Fatalf("%q", kinds(inventory))
	}
}

func TestInventoryReadsAFileWithoutAKnownExtensionAsVectorDoes(t *testing.T) {
	dir := t.TempDir()
	writeConfigFiles(t, dir, map[string]string{"vector.conf": "include = [\"other.toml\"]\n", "vector": "[secret.vault]\ntype = \"file\"\n"})
	inventory := InventoryVector([]VectorStartup{startup("-c", filepath.Join(dir, "vector.conf"), "--config-yaml", filepath.Join(dir, "vector"))})
	formats := map[string]string{}
	for _, file := range inventory.Files {
		formats[filepath.Base(file.Path)] = file.Format
	}
	if !reflect.DeepEqual(formats, map[string]string{"vector.conf": "toml", "vector": "yaml"}) {
		t.Fatalf("Vector falls back to TOML for a name it doesn't know, and obeys --config-yaml: %v", formats)
	}
	if inventory.Files[0].Includes[0] != "other.toml" {
		t.Fatalf("the file is scanned as TOML: %+v", inventory.Files[0])
	}
	got := kinds(inventory)
	if !reflect.DeepEqual(got, []string{"!several_files", "!include", "format_assumed"}) {
		t.Fatalf("%q", got)
	}
}

func TestInventoryBoundsHowManyPlacesAProcessNames(t *testing.T) {
	args := make([]string, 0, 2*(inventoryMaxSources+10))
	dir := t.TempDir()
	for i := 0; i < inventoryMaxSources+10; i++ {
		args = append(args, "-c", filepath.Join(dir, fmt.Sprintf("gone%d.yaml", i)))
	}
	inventory := InventoryVector([]VectorStartup{startup(args...)})
	found := false
	for _, c := range inventory.Concerns {
		found = found || c.Kind == "too_large" && c.Blocks && strings.Contains(c.Detail, "names more than 1024 places")
	}
	if !found || len(inventory.Concerns) > inventoryMaxSources+1 {
		t.Fatalf("%d concerns, without the one that says the list was cut", len(inventory.Concerns))
	}
}

func TestInventoryNeverReadsSpecialFiles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no FIFOs to make")
	}
	dir := t.TempDir()
	fifo := filepath.Join(dir, "config.yaml")
	if err := mkfifo(fifo); err != nil {
		t.Skip("can't make a FIFO:", err)
	}
	inventory := InventoryVector([]VectorStartup{startup("-c", fifo)})
	if len(inventory.Files) != 1 || inventory.Files[0].Problem == "" || inventory.Files[0].SHA256 != "" {
		t.Fatalf("a FIFO was opened for reading (it would have blocked): %+v", inventory.Files)
	}
}

func TestInventoryReadsPathsThroughAProcessRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a container root is a Linux mechanism; Windows paths have drive letters")
	}
	root := t.TempDir()
	writeConfigFiles(t, root, map[string]string{"etc/vector/vector.yaml": minimalYAML})
	process := startup("--config", "/etc/vector/vector.yaml")
	process.Root = root
	inventory := InventoryVector([]VectorStartup{process})
	if len(inventory.Files) != 1 || inventory.Files[0].Path != "/etc/vector/vector.yaml" || inventory.Files[0].SHA256 != Digest([]byte(minimalYAML)) || len(inventory.Concerns) != 0 {
		t.Fatalf("a file inside the process's root is named as the process names it: %+v %+v", inventory.Files, inventory.Concerns)
	}
	process.Command = []string{"/usr/bin/vector", "-C", "/etc/vector"}
	if inventory = InventoryVector([]VectorStartup{process}); len(inventory.Files) != 1 || inventory.Files[0].Path != "/etc/vector/vector.yaml" {
		t.Fatalf("%+v", inventory.Files)
	}
}

func TestInventoryHidesCredentialsInArguments(t *testing.T) {
	process := startup("--config", "https://user:hunter2@config.example.invalid/vector.yaml", "--label", "plain")
	inventory := InventoryVector([]VectorStartup{process})
	joined := strings.Join(inventory.Processes[0].Command, " ")
	if strings.Contains(joined, "hunter2") || !strings.Contains(joined, "https://***@config.example.invalid/vector.yaml") {
		t.Fatalf("%q", joined)
	}
	if got := displayCommand([]string{"/usr/bin/vector", "--label", "two words", "esc\x1b[31m"}); got != "/usr/bin/vector --label "+displayArg("two words")+" esc?[31m" {
		t.Fatalf("%q", got)
	}
}

// A command line shows the way its platform writes one: a POSIX shell's
// quoting, or the quoting Windows programs read back.
func TestDisplayArgumentsAreQuotedForThePlatform(t *testing.T) {
	if runtime.GOOS == "windows" {
		if got := displayArg(`C:\Program Files\Vector\vector.exe`); got != `"C:\Program Files\Vector\vector.exe"` {
			t.Fatal(got)
		}
		if got := displayArg(`C:\ProgramData\Vector\config`); got != `C:\ProgramData\Vector\config` {
			t.Fatalf("a Windows path with no space needs no quotes: %s", got)
		}
	} else {
		if got := displayArg("two words"); got != "'two words'" {
			t.Fatal(got)
		}
		if got := displayArg("/etc/vector/vector.yaml"); got != "/etc/vector/vector.yaml" {
			t.Fatal(got)
		}
	}
}

func TestEscapedWindowsArgumentsSurviveASplit(t *testing.T) {
	args := []string{`C:\Program Files\Vector\bin\vector.exe`, "--label", "two words", "", `say "hi"`, `ends with a backslash\`, `C:\dir with space\`, `C:\plain\dir\`, "tab\there", `back\\slashes and "quotes"\\`, "unicode-\u00e9\u65e5", `-c=C:\a b\c.yaml`}
	parts := make([]string, len(args))
	for i, arg := range args {
		parts[i] = escapeWindowsArgument(arg)
	}
	line := strings.Join(parts, " ")
	if got := splitWindowsCommandLine(line); !reflect.DeepEqual(got, args) {
		t.Fatalf("%s\n got %q\nwant %q", line, got, args)
	}
	if escapeWindowsArgument(`C:\plain\dir\`) != `C:\plain\dir\` || escapeWindowsArgument("") != `""` {
		t.Fatal("an argument that needs no quotes gets none, and an empty one gets a pair")
	}
}

func TestStopAdviceNamesThePlatformsServiceManager(t *testing.T) {
	running := []RunningVector{{PID: 1}, {PID: 2, Service: "vector"}}
	cases := map[string]string{
		"linux":   "stop it (for example: sudo systemctl disable --now vector)",
		"windows": "stop it (for example, in an elevated PowerShell: Stop-Service -Name vector; Set-Service -Name vector -StartupType Disabled)",
		"darwin":  "stop it",
	}
	for goos, want := range cases {
		if got := stopAdvice(running, goos); got != want {
			t.Errorf("%s: %q, want %q", goos, got, want)
		}
	}
	if got := stopAdvice([]RunningVector{{PID: 3}}, "linux"); got != "stop it" {
		t.Errorf("no service to name: %q", got)
	}
	if got := stopAdvice([]RunningVector{{PID: 4, Service: "Vector Agent"}}, "windows"); !strings.Contains(got, "Stop-Service -Name 'Vector Agent';") {
		t.Errorf("a service name with a space is quoted: %q", got)
	}
}

// A case-insensitive file system finds "Sources" for "sources", and Vector
// reads what is in it; the files are listed under the name they have on disk.
// Another directory whose name only differs in case is not the one found.
func TestOnDiskNameIsTheNameTheDirectoryHas(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "Sources"), 0o755); err != nil {
		t.Fatal(err)
	}
	upper, err := os.Stat(filepath.Join(dir, "Sources"))
	if err != nil {
		t.Fatal(err)
	}
	if got := onDiskName(dir, "sources", upper); got != "Sources" {
		t.Errorf("the directory found for sources is %q, want the name it has on disk", got)
	}
	if got := onDiskName(filepath.Join(dir, "missing"), "sources", upper); got != "sources" {
		t.Errorf("a directory that can't be read keeps the name asked for: %q", got)
	}
	if err := os.Mkdir(filepath.Join(dir, "sources"), 0o755); err != nil {
		t.Skip("this file system treats sources and Sources as one directory")
	}
	lower, err := os.Stat(filepath.Join(dir, "sources"))
	if err != nil {
		t.Fatal(err)
	}
	if got := onDiskName(dir, "sources", lower); got != "sources" {
		t.Errorf("with both directories on disk, sources is %q", got)
	}
}
