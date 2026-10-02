package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"unicode"
)

// Before the agent takes over a Vector that already runs on a host, setup
// records how that Vector was started and which configuration files it loads,
// and keeps a copy of each. The agent manages exactly one generated JSON file,
// so anything else the running topology depends on (more files, a directory,
// a provider, configuration chosen through the environment) is named, and
// setup stops unless the operator adopts it explicitly. Nothing here changes
// the running Vector or its files.

// Limits that keep an inventory bounded.
const (
	inventoryFileLimit  = 8 << 20
	inventoryTotalLimit = 64 << 20
	inventoryMaxFiles   = 256
	// inventoryMaxSources bounds the places one process names, however long
	// its command line is.
	inventoryMaxSources = 1024
	// inventoryScanLimit is how much of a file is searched for constructs.
	inventoryScanLimit = 2 * MaxArtifact
)

// VectorStartup is how one running Vector process was started, as far as the
// host tells.
type VectorStartup struct {
	PID int `json:"pid"`
	// Command is the process's argument vector, executable first. It is empty
	// when the host wouldn't say; ServiceCommand then stands in for it.
	Command []string `json:"command,omitempty"`
	// Source says where the command came from: "process" (read from the running
	// process) or "service" (the definition of the service that starts it).
	Source  string `json:"source,omitempty"`
	Service string `json:"service,omitempty"`
	// ServiceCommand is how the service's own definition starts Vector: the
	// unit's ExecStart, the launchd job's ProgramArguments, the service's
	// ImagePath. It is shown next to Command and never changes what the
	// inventory reads.
	ServiceCommand []string `json:"service_command,omitempty"`
	WorkDir        string   `json:"work_dir,omitempty"`
	// Root is the directory a process's paths are relative to when it runs in a
	// mount namespace of its own, as in a container: files are read through it.
	Root string `json:"root,omitempty"`
	// Environment holds only the variables that select configuration
	// (VECTOR_CONFIG and its siblings), never the rest of the environment.
	// EnvironmentKnown says whether the process's environment could be read at
	// all: without it, configuration chosen through the environment can't be
	// ruled out.
	Environment      map[string]string `json:"environment,omitempty"`
	EnvironmentKnown bool              `json:"environment_known"`
}

// AdoptionFile is one configuration file the running Vector loads.
type AdoptionFile struct {
	Path string `json:"path"`
	// NamedBy is how Vector was told about it: --config, -C, VECTOR_CONFIG_DIR,
	// or the default path.
	NamedBy string `json:"named_by"`
	Format  string `json:"format,omitempty"`
	Bytes   int64  `json:"bytes"`
	SHA256  string `json:"sha256,omitempty"`
	// Backup is the name of the copy in the backup folder.
	Backup string `json:"backup,omitempty"`
	// Problem says why the file couldn't be read or copied.
	Problem string `json:"problem,omitempty"`
	// Secrets lists secret backends and references the file uses; Environment the
	// environment variables it reads; Provider and Includes what else it pulls in.
	Secrets     []string `json:"secrets,omitempty"`
	Environment []string `json:"environment,omitempty"`
	Provider    string   `json:"provider,omitempty"`
	Includes    []string `json:"includes,omitempty"`

	host     string
	content  []byte
	tooLarge bool
	// assumed: the format is the one Vector falls back to, not one the name says.
	assumed bool
}

// InventoryConcern is something the running Vector depends on beyond the one
// file the agent manages, or that the inventory could not establish.
type InventoryConcern struct {
	Kind string `json:"kind"`
	// Blocks: setup stops unless the operator adopts explicitly.
	Blocks bool     `json:"blocks"`
	Files  []string `json:"files,omitempty"`
	Detail string   `json:"detail"`
}

// AdoptionInventory is what setup learned about the Vector it found running.
type AdoptionInventory struct {
	Processes []VectorStartup    `json:"processes"`
	Files     []AdoptionFile     `json:"files"`
	Concerns  []InventoryConcern `json:"concerns,omitempty"`
	// BackupDir holds the copies and the record, once they are written.
	BackupDir string `json:"backup_dir,omitempty"`
	// Acknowledged: the operator adopted it with --adopt-existing.
	Acknowledged bool   `json:"acknowledged,omitempty"`
	TakenAt      string `json:"taken_at,omitempty"`
	AgentVersion string `json:"agent_version,omitempty"`
	// Fingerprint identifies the processes' commands and the files' checksums, so
	// running setup again over the same Vector keeps the copies it has.
	Fingerprint string `json:"fingerprint,omitempty"`
}

// Blocking lists the concerns that stop setup.
func (i AdoptionInventory) Blocking() []InventoryConcern {
	var out []InventoryConcern
	for _, c := range i.Concerns {
		if c.Blocks {
			out = append(out, c)
		}
	}
	return out
}

// configOption is one way Vector is told which configuration to load.
type configOption struct {
	long  string
	short byte
	// kind is "file" (a path or a glob) or "directory".
	kind string
	// format is the format Vector expects, or "" to detect it from the name.
	format string
	env    string
}

// The options of Vector 0.58 that name configuration, each with the
// environment variable that stands in for it when it is not given.
var configOptions = []configOption{
	{long: "config", short: 'c', kind: "file", env: "VECTOR_CONFIG"},
	{long: "config-dir", short: 'C', kind: "directory", env: "VECTOR_CONFIG_DIR"},
	{long: "config-toml", kind: "file", format: "toml", env: "VECTOR_CONFIG_TOML"},
	{long: "config-json", kind: "file", format: "json", env: "VECTOR_CONFIG_JSON"},
	{long: "config-yaml", kind: "file", format: "yaml", env: "VECTOR_CONFIG_YAML"},
}

// configEnvironment lists the variables that select configuration.
func configEnvironment() []string {
	names := make([]string, len(configOptions))
	for i, option := range configOptions {
		names[i] = option.env
	}
	return names
}

// configSource is one place a running Vector reads configuration from.
type configSource struct {
	// named is what the operator would recognize: "--config", "-C",
	// "VECTOR_CONFIG_DIR", "the default path".
	named   string
	kind    string
	format  string
	pattern string
}

// environmentNamed is true for a source that came from an environment variable.
func (s configSource) environmentNamed() bool { return strings.HasPrefix(s.named, "VECTOR_") }

// vectorConfigSources reads which configuration the arguments name (argument
// zero, the executable, excluded) and which the environment adds for the
// options the arguments leave out. Values are split at commas, as Vector does.
// When nothing names configuration Vector reads its default path.
func vectorConfigSources(args []string, environment map[string]string) []configSource {
	var sources []configSource
	given := map[string]bool{}
	add := func(option configOption, written, value string) {
		given[option.long] = true
		for _, part := range strings.Split(value, ",") {
			if part = strings.TrimSpace(part); part != "" {
				sources = append(sources, configSource{named: written, kind: option.kind, format: option.format, pattern: part})
			}
		}
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--":
			i = len(args)
		case strings.HasPrefix(arg, "--"):
			name, value, hasValue := strings.Cut(arg[2:], "=")
			option := configOptionNamed(name)
			if option == nil {
				continue
			}
			if !hasValue {
				if i+1 >= len(args) {
					continue
				}
				i++
				value = args[i]
			}
			add(*option, "--"+name, value)
		case strings.HasPrefix(arg, "-") && len(arg) > 1:
			// A cluster of short options such as -wc FILE: the first option that
			// takes a value takes the rest of the argument, or the next one.
			for j := 1; j < len(arg); j++ {
				option := configOptionShort(arg[j])
				if option == nil {
					continue
				}
				value := strings.TrimPrefix(arg[j+1:], "=")
				if value == "" && i+1 < len(args) {
					i++
					value = args[i]
				}
				add(*option, "-"+string(arg[j]), value)
				break
			}
		}
	}
	for _, option := range configOptions {
		if value := environment[option.env]; value != "" && !given[option.long] {
			add(option, option.env, value)
		}
	}
	if len(sources) == 0 {
		sources = append(sources, configSource{named: "the default path", kind: "file", pattern: defaultVectorConfig()})
	}
	return sources
}

func configOptionNamed(name string) *configOption {
	for i := range configOptions {
		if configOptions[i].long == name {
			return &configOptions[i]
		}
	}
	return nil
}

func configOptionShort(letter byte) *configOption {
	for i := range configOptions {
		if configOptions[i].short == letter {
			return &configOptions[i]
		}
	}
	return nil
}

// defaultVectorConfig is the file Vector loads when told nothing.
func defaultVectorConfig() string {
	if runtime.GOOS == "windows" {
		programFiles := os.Getenv("ProgramFiles")
		if programFiles == "" {
			programFiles = `C:\Program Files`
		}
		return filepath.Join(programFiles, "Vector", "config", "vector.yaml")
	}
	return "/etc/vector/vector.yaml"
}

// configExtensions are the file names Vector reads from a configuration
// directory; the match is case-sensitive.
var configExtensions = map[string]string{".toml": "toml", ".json": "json", ".yaml": "yaml", ".yml": "yaml"}

// componentDirectories are the sub-directories of a configuration directory
// Vector reads, one component per file. Any other sub-directory is ignored.
var componentDirectories = []string{"sources", "transforms", "sinks", "enrichment_tables", "tests"}

// formatOf is the format Vector takes a file to have from its name.
func formatOf(path string) string { return configExtensions[filepath.Ext(path)] }

// directoryFiles lists what Vector loads from a configuration directory: the
// files with a configuration extension at its top level, hidden ones included,
// and the same in each component sub-directory.
func directoryFiles(dir string) ([]string, error) {
	var files []string
	collect := func(folder string) error {
		entries, err := os.ReadDir(folder)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			path := filepath.Join(folder, entry.Name())
			if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && formatOf(path) != "" {
				files = append(files, path)
			}
		}
		return nil
	}
	if err := collect(dir); err != nil {
		return nil, err
	}
	for _, name := range componentDirectories {
		if info, err := os.Stat(filepath.Join(dir, name)); err == nil && info.IsDir() {
			if err := collect(filepath.Join(dir, name)); err != nil {
				return nil, err
			}
		}
	}
	sort.Strings(files)
	return files, nil
}

// fileScan is what a configuration file says about what else it depends on.
type fileScan struct {
	provider    string
	includes    []string
	secrets     []string
	environment []string
}

// includeKeys are root keys that would name other files to load. Vector 0.58
// has no such key (it rejects an unknown field), so a file that has one is
// assembled by something else, which the agent doesn't do.
var includeKeys = map[string]bool{"include": true, "includes": true, "import": true, "imports": true, "extends": true}

var (
	secretReference = regexp.MustCompile(`SECRET\[([A-Za-z0-9_-]+)\.`)
	environmentUse  = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)|\$([A-Z_][A-Z0-9_]*)`)
	tomlTable       = regexp.MustCompile(`^\[\[?\s*"?([A-Za-z0-9_-]+)"?(?:\s*\.\s*"?([A-Za-z0-9_-]+)"?)?`)
	tomlKey         = regexp.MustCompile(`^"?([A-Za-z0-9_-]+)"?\s*(?:\.\s*"?([A-Za-z0-9_-]+)"?\s*)?=\s*(.*)$`)
	tomlInlineType  = regexp.MustCompile(`\btype\s*=\s*["']([^"']+)["']`)
)

// scanConfig finds the constructs that matter to adoption in a file of the
// given format, without expanding anything: a provider, includes, secret
// backends and references, and environment variables the file reads.
func scanConfig(format string, data []byte) fileScan {
	if len(data) > inventoryScanLimit {
		data = data[:inventoryScanLimit]
	}
	var scan fileScan
	text := string(data)
	names := map[string]bool{}
	for _, match := range secretReference.FindAllStringSubmatch(text, -1) {
		names[match[1]] = true
	}
	variables := map[string]bool{}
	for _, match := range environmentUse.FindAllStringSubmatch(text, -1) {
		variables[match[1]+match[2]] = true
	}
	switch {
	case format == "json" || format == "yaml" && json.Valid(data):
		scan = scanJSON(data, scan, names)
	case format == "yaml":
		scan = scanYAML(text, scan, names)
	case format == "toml":
		scan = scanTOML(text, scan, names)
	}
	for name := range names {
		scan.secrets = append(scan.secrets, name)
	}
	for name := range variables {
		scan.environment = append(scan.environment, name)
	}
	sort.Strings(scan.secrets)
	sort.Strings(scan.environment)
	sort.Strings(scan.includes)
	return scan
}

func scanJSON(data []byte, scan fileScan, names map[string]bool) fileScan {
	var root map[string]json.RawMessage
	if json.Unmarshal(data, &root) != nil {
		return scan
	}
	if raw, ok := root["provider"]; ok {
		scan.provider = "unknown"
		var block struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &block) == nil && block.Type != "" {
			scan.provider = block.Type
		}
	}
	for key, value := range root {
		if includeKeys[key] {
			scan.includes = append(scan.includes, jsonNames(value)...)
		}
	}
	var backends map[string]json.RawMessage
	if json.Unmarshal(root["secret"], &backends) == nil {
		for name := range backends {
			names[name] = true
		}
	}
	return scan
}

// jsonNames lists the strings of a JSON string or array of strings.
func jsonNames(raw json.RawMessage) []string {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return []string{one}
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil && len(many) > 0 {
		return many
	}
	return []string{"a list of files"}
}

// scanYAML reads the root keys of a YAML document by their position: a root
// key starts in the first column. Anything more elaborate is left alone.
func scanYAML(text string, scan fileScan, names map[string]bool) fileScan {
	root := ""
	indent := -1
	sawInclude := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r \t")
		trimmed := strings.TrimLeft(line, " \t")
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || line == "---" || line == "..." || strings.HasPrefix(line, "--- ") {
			continue
		}
		if line[0] != ' ' && line[0] != '\t' && line[0] != '-' {
			key, value, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			root, indent = strings.Trim(strings.TrimSpace(key), `"'`), -1
			value = strings.TrimSpace(value)
			switch {
			case root == "provider":
				scan.provider = "unknown"
			case includeKeys[root]:
				sawInclude = true
				if value != "" {
					scan.includes = append(scan.includes, yamlValue(value))
				}
			}
			continue
		}
		key, _, ok := strings.Cut(trimmed, ":")
		depth := len(line) - len(trimmed)
		switch {
		case root == "provider" && ok && strings.TrimSpace(key) == "type":
			scan.provider = strings.Trim(strings.TrimSpace(strings.TrimPrefix(trimmed, key+":")), `"'`)
		case root == "secret" && ok && (indent < 0 || depth <= indent):
			indent = depth
			names[strings.Trim(strings.TrimSpace(key), `"'`)] = true
		case includeKeys[root] && strings.HasPrefix(trimmed, "- "):
			scan.includes = append(scan.includes, yamlValue(strings.TrimPrefix(trimmed, "- ")))
		}
	}
	// An include key with nothing under it is still an include.
	if sawInclude && len(scan.includes) == 0 {
		scan.includes = []string{"a list of files"}
	}
	return scan
}

// yamlValue is a scalar or inline list from a root key, shortened.
func yamlValue(value string) string {
	value = strings.Trim(strings.TrimSpace(value), `[]"'`)
	if len(value) > 100 {
		value = value[:100]
	}
	if value == "" {
		return "a list of files"
	}
	return value
}

// scanTOML reads the root keys and tables of a TOML document line by line.
func scanTOML(text string, scan fileScan, names map[string]bool) fileScan {
	table := ""
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			table = ""
			if m := tomlTable.FindStringSubmatch(line); m != nil {
				table = m[1]
				switch {
				case table == "provider":
					scan.provider = "unknown"
				case table == "secret" && m[2] != "":
					names[m[2]] = true
				}
			}
			continue
		}
		m := tomlKey.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		switch {
		case table == "" && includeKeys[m[1]]:
			scan.includes = append(scan.includes, yamlValue(m[3]))
		case table == "" && m[1] == "provider":
			scan.provider = "unknown"
			if m[2] == "type" {
				scan.provider = strings.Trim(strings.TrimSpace(m[3]), `"'`)
			} else if inline := tomlInlineType.FindStringSubmatch(m[3]); inline != nil {
				scan.provider = inline[1]
			}
		case table == "" && m[1] == "secret" && m[2] != "":
			names[m[2]] = true
		case table == "provider" && m[1] == "type" && m[2] == "":
			scan.provider = strings.Trim(strings.TrimSpace(m[3]), `"'`)
		}
	}
	return scan
}

// inventoryBuilder gathers the files and concerns of the processes it is given.
type inventoryBuilder struct {
	inventory AdoptionInventory
	seen      map[string]bool
	total     int64
	overflow  int
}

func (b *inventoryBuilder) concern(kind string, blocks bool, files []string, detail string) {
	b.inventory.Concerns = append(b.inventory.Concerns, InventoryConcern{Kind: kind, Blocks: blocks, Files: files, Detail: detail})
}

// InventoryVector works out what the running Vector processes load: the
// files, with their checksums and what each pulls in, and the concerns that
// keep the agent from managing that topology as one file. It reads files and
// never changes them.
func InventoryVector(startups []VectorStartup) AdoptionInventory {
	b := &inventoryBuilder{inventory: AdoptionInventory{Files: []AdoptionFile{}}, seen: map[string]bool{}}
	for _, process := range startups {
		process.Command = redactCommand(process.Command)
		process.ServiceCommand = redactCommand(process.ServiceCommand)
		b.inventory.Processes = append(b.inventory.Processes, process)
		b.process(process)
	}
	b.files()
	b.inventory.Fingerprint = fingerprintOf(b.inventory)
	return b.inventory
}

func (b *inventoryBuilder) process(process VectorStartup) {
	command := process.Command
	if len(command) == 0 {
		command = process.ServiceCommand
	}
	if len(command) == 0 {
		b.concern("unknown_command", true, nil, fmt.Sprintf("How Vector (pid %d) was started couldn't be read, so the configuration it loads is unknown. Run setup with sudo (administrator rights) so it can read the process.", process.PID))
		return
	}
	sources := vectorConfigSources(command[1:], process.Environment)
	if len(sources) > inventoryMaxSources {
		b.concern("too_large", true, nil, fmt.Sprintf("Vector (pid %d) names more than %d places to load configuration from; the rest were not inventoried.", process.PID, inventoryMaxSources))
		sources = sources[:inventoryMaxSources]
	}
	var variables []string
	for _, source := range sources {
		if source.environmentNamed() {
			variables = append(variables, source.named)
		}
	}
	if variables = dedupe(variables); len(variables) > 0 {
		b.concern("environment_selected", true, nil, "Its configuration is chosen by the "+joinNames(variables)+" environment variable"+pluralSuffix(len(variables))+process.serviceSuffix()+", which the agent doesn't pass to the Vector it starts.")
	}
	if !process.EnvironmentKnown {
		b.concern("environment_unknown", true, nil, fmt.Sprintf("The environment of Vector (pid %d) couldn't be read, so configuration chosen through VECTOR_CONFIG or VECTOR_CONFIG_DIR can't be ruled out. Run setup with sudo (administrator rights) so it can read the process.", process.PID))
	}
	for _, source := range sources {
		b.source(source, process)
	}
}

// source adds the files one place names, or a concern when it can't.
func (b *inventoryBuilder) source(source configSource, process VectorStartup) {
	found, problem := resolveSource(source, process)
	if problem != nil {
		b.concern(problem.kind, problem.blocks, []string{source.pattern}, source.pattern+" ("+source.named+") "+problem.text+".")
		return
	}
	for _, place := range found {
		members := []location{place}
		if source.kind == "directory" {
			files, err := directoryFiles(place.host)
			if err != nil {
				b.concern("unreadable", true, []string{place.shown}, place.shown+" ("+source.named+") can't be read: "+describeReadError(err)+".")
				continue
			}
			members = nil
			for _, file := range files {
				members = append(members, location{shown: shownPath(process.Root, file), host: file})
			}
		}
		for _, member := range members {
			if b.seen[member.host] {
				continue
			}
			b.seen[member.host] = true
			if len(b.inventory.Files) >= inventoryMaxFiles {
				b.overflow++
				continue
			}
			file := AdoptionFile{Path: member.shown, NamedBy: source.named, Format: source.format, host: member.host}
			if file.Format == "" {
				file.Format = formatOf(member.shown)
			}
			if file.Format == "" {
				// Vector reads a file it was named directly, whose extension it
				// doesn't know, as TOML.
				file.Format, file.assumed = "toml", true
			}
			readInventoryFile(&file, &b.total)
			b.inventory.Files = append(b.inventory.Files, file)
		}
	}
}

// files turns what the files contain into concerns, most important first.
func (b *inventoryBuilder) files() {
	files := b.inventory.Files
	if b.overflow > 0 {
		b.concern("too_large", true, nil, fmt.Sprintf("Vector loads more than %d configuration files; %d were not inventoried.", inventoryMaxFiles, b.overflow))
	}
	for _, file := range files {
		switch {
		case file.tooLarge:
			b.concern("too_large", true, []string{file.Path}, file.Path+" "+file.Problem+".")
		case file.Problem != "":
			b.concern("unreadable", true, []string{file.Path}, file.Path+" can't be read: "+file.Problem+".")
		}
		if file.assumed {
			b.concern("format_assumed", false, []string{file.Path}, file.Path+" has no .toml, .yaml or .json extension, so Vector reads it as TOML.")
		}
		if file.Provider != "" {
			b.concern("provider", true, []string{file.Path}, file.Path+" fetches more configuration from a provider ("+file.Provider+"), which the agent doesn't manage.")
		}
		if len(file.Includes) > 0 {
			b.concern("include", true, []string{file.Path}, file.Path+" names other files with include ("+strings.Join(file.Includes, ", ")+"). Vector 0.58 doesn't read includes, so something else assembles this configuration, and the agent doesn't.")
		}
		if len(file.Secrets) > 0 {
			b.concern("secret_backend", false, []string{file.Path}, file.Path+" uses secret backends ("+strings.Join(file.Secrets, ", ")+"). The agent keeps credentials in device secrets: see vectory configure-secrets.")
		}
		if len(file.Environment) > 0 {
			b.concern("environment_variables", false, []string{file.Path}, file.Path+" reads environment variables ("+strings.Join(file.Environment, ", ")+"). The agent starts Vector without the environment of the old process.")
		}
	}
	if len(files) > 1 {
		paths := make([]string, len(files))
		for i, file := range files {
			paths[i] = file.Path
		}
		first := InventoryConcern{Kind: "several_files", Blocks: true, Files: paths, Detail: fmt.Sprintf("Vector loads %d configuration files: %s.", len(paths), listNames(paths, 8))}
		b.inventory.Concerns = append([]InventoryConcern{first}, b.inventory.Concerns...)
	}
	sort.SliceStable(b.inventory.Concerns, func(i, j int) bool {
		return b.inventory.Concerns[i].Blocks && !b.inventory.Concerns[j].Blocks
	})
}

// fingerprintOf identifies the commands and checksums of an inventory.
func fingerprintOf(inventory AdoptionInventory) string {
	type identity struct {
		Commands [][]string
		Files    [][2]string
	}
	var id identity
	for _, process := range inventory.Processes {
		id.Commands = append(id.Commands, process.Command)
	}
	for _, file := range inventory.Files {
		id.Files = append(id.Files, [2]string{file.Path, file.SHA256})
	}
	raw, _ := json.Marshal(id)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (p VectorStartup) serviceSuffix() string {
	if p.Service != "" {
		return " of " + p.Service
	}
	return ""
}

func pluralSuffix(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}

// joinNames is "a", "a and b" or "a, b and c".
func joinNames(names []string) string {
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

// listNames joins names with commas, naming at most limit of them.
func listNames(names []string, limit int) string {
	if len(names) <= limit {
		return strings.Join(names, ", ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(names[:limit], ", "), len(names)-limit)
}

// location is a path as the process names it and where this host reads it.
type location struct{ shown, host string }

func hostPath(root, path string) string {
	if root == "" {
		return path
	}
	return filepath.Join(root, path)
}

func shownPath(root, path string) string {
	if root == "" {
		return path
	}
	return "/" + filepath.ToSlash(strings.TrimPrefix(strings.TrimPrefix(path, root), string(filepath.Separator)))
}

// sourceProblem is why a place Vector was told about can't be turned into
// files. Only a place that isn't there (a missing file, a glob that matches
// nothing) is harmless: there is nothing in it to lose. One the inventory
// can't establish stops setup.
type sourceProblem struct {
	kind   string // missing, unresolved or unreadable
	blocks bool
	text   string
}

// resolveSource turns what Vector was told into the paths it opens, or says
// why it can't: a relative path needs the process's working directory, and a
// glob that matches nothing or a missing path would have stopped Vector.
func resolveSource(source configSource, process VectorStartup) ([]location, *sourceProblem) {
	pattern := source.pattern
	if !filepath.IsAbs(pattern) {
		if process.WorkDir == "" {
			return nil, &sourceProblem{"unresolved", true, "is relative, and the working directory of the process is unknown"}
		}
		pattern = filepath.Join(process.WorkDir, pattern)
	}
	if strings.Contains(pattern, "**") {
		return nil, &sourceProblem{"unresolved", true, "uses **, a recursive wildcard that setup doesn't expand"}
	}
	host := hostPath(process.Root, pattern)
	if strings.ContainsAny(pattern, "*?[") {
		matches, err := filepath.Glob(host)
		if err != nil || len(matches) == 0 {
			return nil, &sourceProblem{"missing", false, "matches nothing"}
		}
		sort.Strings(matches)
		out := make([]location, len(matches))
		for i, match := range matches {
			out[i] = location{shown: shownPath(process.Root, match), host: match}
		}
		return out, nil
	}
	info, err := os.Stat(host)
	switch {
	case os.IsNotExist(err):
		return nil, &sourceProblem{"missing", false, "doesn't exist"}
	case err != nil:
		return nil, &sourceProblem{"unreadable", true, "can't be read: " + describeReadError(err)}
	case source.kind == "directory" && !info.IsDir():
		return nil, &sourceProblem{"unresolved", true, "isn't a directory"}
	case source.kind == "file" && info.IsDir():
		return nil, &sourceProblem{"unresolved", true, "is a directory, not a file"}
	}
	return []location{{shown: pattern, host: host}}, nil
}

// describeReadError is the operating system's reason, without the path.
func describeReadError(err error) string {
	if pathErr, ok := err.(*os.PathError); ok {
		return pathErr.Err.Error()
	}
	return err.Error()
}

// readInventoryFile reads a file for the inventory: its bytes (bounded),
// checksum and the constructs it uses. It records why it couldn't, and never
// fails.
func readInventoryFile(file *AdoptionFile, total *int64) {
	info, err := os.Stat(file.host)
	if err != nil {
		file.Problem = describeReadError(err)
		return
	}
	if !info.Mode().IsRegular() {
		file.Problem = "isn't a regular file"
		return
	}
	file.Bytes = info.Size()
	if info.Size() > inventoryFileLimit || *total+info.Size() > inventoryTotalLimit {
		file.tooLarge = true
		file.Problem = fmt.Sprintf("is larger than an inventory keeps (%d MiB a file, %d MiB in all)", inventoryFileLimit>>20, inventoryTotalLimit>>20)
		return
	}
	f, err := os.Open(file.host)
	if err != nil {
		file.Problem = describeReadError(err)
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, inventoryFileLimit+1))
	if err != nil {
		file.Problem = describeReadError(err)
		return
	}
	if len(data) > inventoryFileLimit {
		file.tooLarge = true
		file.Problem = fmt.Sprintf("grew past the %d MiB an inventory keeps while it was read", inventoryFileLimit>>20)
		return
	}
	*total += int64(len(data))
	file.content = data
	sum := sha256.Sum256(data)
	file.SHA256 = hex.EncodeToString(sum[:])
	file.Bytes = int64(len(data))
	scan := scanConfig(file.Format, data)
	file.Provider, file.Includes, file.Secrets, file.Environment = scan.provider, scan.includes, scan.secrets, scan.environment
}

// credentialInURL is the user and password of a URL argument.
var credentialInURL = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@]*@`)

// redactCommand hides credentials that a URL argument carries, since the
// inventory is printed and returned.
func redactCommand(command []string) []string {
	if command == nil {
		return nil
	}
	out := make([]string, len(command))
	for i, arg := range command {
		out[i] = credentialInURL.ReplaceAllString(arg, "${1}***@")
	}
	return out
}

// displayArg is one argument of a command as its platform writes it: quoted for
// a POSIX shell, or the way a Windows command line holds it. Control
// characters, which could rewrite a terminal, are replaced.
func displayArg(arg string) string {
	arg = printable(arg)
	if runtime.GOOS == "windows" {
		return escapeWindowsArgument(arg)
	}
	return quoteArg(arg)
}

// displayCommand is a command as one line an operator can read.
func displayCommand(command []string) string {
	parts := make([]string, len(command))
	for i, arg := range command {
		parts[i] = displayArg(arg)
	}
	return strings.Join(parts, " ")
}

// printable replaces control characters with a question mark.
func printable(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return '?'
		}
		return r
	}, s)
}
