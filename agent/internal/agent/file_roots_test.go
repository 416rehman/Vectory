package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// rootStyleCase is one file system's spelling of what the agent keeps private
// and of roots a host may and may not allow. The rules take a style, so the
// three run on any host.
type rootStyleCase struct {
	name                   string
	style                  pathStyle
	state, managed, secret string // the directory, the file in its own directory, a bound file
	refused                map[string]string
	allowed, notAbsolute   []string
	whatToAllow            string
}

var rootStyles = []rootStyleCase{
	{
		name: "linux", style: posixPaths,
		state: "/var/lib/vectory-agent", managed: "/etc/vectory/managed/vector.json", secret: "/srv/keys/TOKEN",
		refused: map[string]string{
			"/":                             "is the filesystem root",
			"//":                            "is the filesystem root",
			"/.":                            "is the filesystem root",
			"/var/..":                       "is the filesystem root",
			"/var/lib/vectory-agent":        "is the agent's state directory.",
			"/var/lib/vectory-agent/":       "is the agent's state directory.",
			"/var//lib/./vectory-agent":     "is the agent's state directory.",
			"/var/lib/vectory-agent/assets": "lies inside the agent's state directory, /var/lib/vectory-agent.",
			"/var/lib/./vectory-agent/../vectory-agent/new/deep": "lies inside the agent's state directory",
			"/var/lib":                   "contains the agent's state directory, /var/lib/vectory-agent.",
			"/var":                       "contains the agent's state directory",
			"/etc/vectory/managed":       "is the managed configuration directory.",
			"/etc/vectory/managed/inner": "lies inside the managed configuration directory, /etc/vectory/managed.",
			"/etc/vectory":               "contains the managed configuration directory, /etc/vectory/managed.",
			"/etc":                       "contains the managed configuration directory",
			"/srv/keys/TOKEN":            `is the file bound to secret "TOKEN".`,
			"/srv/keys":                  `contains the file bound to secret "TOKEN", /srv/keys/TOKEN.`,
			"/srv":                       `contains the file bound to secret "TOKEN"`,
		},
		allowed:     []string{"/var/log/app", "/var/lib/vectory-agent-data", "/var/lib/vectory", "/etc/vectory/managed-data", "/etc/vectory-extra", "/srv/keys2", "/srv/keys/TOKEN2", "/data", "/VAR/LIB/vectory-agent", "/Var/Lib"},
		notAbsolute: []string{"logs/app", "./logs", "", `C:\logs`},
		whatToAllow: "/var/log/app",
	},
	{
		name: "macOS", style: macPaths,
		state: "/Library/Application Support/Vectory/agent", managed: "/Library/Application Support/Vectory/managed/vector.json", secret: "/opt/keys/TOKEN",
		refused: map[string]string{
			"/": "is the filesystem root",
			"/Library/Application Support/Vectory/agent":         "is the agent's state directory.",
			"/library/application support/vectory/AGENT":         "is the agent's state directory.",
			"/LIBRARY/Application Support/VECTORY/agent/assets":  "lies inside the agent's state directory",
			"/Library/Application Support/Vectory":               "contains the agent's state directory",
			"/Library/Application Support":                       "contains the agent's state directory",
			"/Library":                                           "contains the agent's state directory",
			"/Library/Application Support/Vectory/managed":       "is the managed configuration directory.",
			"/library/application support/vectory/managed/inner": "lies inside the managed configuration directory",
			"/OPT/Keys/token":                                    `is the file bound to secret "TOKEN".`,
			"/Opt/keys":                                          `contains the file bound to secret "TOKEN"`,
		},
		allowed:     []string{"/Library/Application Support/VectoryData", "/Library/Logs/app", "/private/var/log/app", "/opt/keys2"},
		notAbsolute: []string{"Library/Logs", "~/logs"},
		whatToAllow: "/var/log/app",
	},
	{
		name: "Windows", style: windowsPaths,
		state: `C:\ProgramData\Vectory\agent`, managed: `C:\ProgramData\Vectory\managed\vector.json`, secret: `D:\Keys\TOKEN`,
		refused: map[string]string{
			`C:\`:                                  "is the root of a drive",
			`C:/`:                                  "is the root of a drive",
			`c:\`:                                  "is the root of a drive",
			`D:\`:                                  "is the root of a drive",
			`D:/`:                                  "is the root of a drive",
			`C:\.`:                                 "is the root of a drive",
			`C:\Windows\..`:                        "is the root of a drive",
			`C:\..\..`:                             "is the root of a drive",
			`\\?\C:\`:                              "is the root of a drive",
			`\\.\D:\`:                              "is the root of a drive",
			`\\server\share`:                       "is the root of a network share",
			`\\server\share\`:                      "is the root of a network share",
			`//server/share`:                       "is the root of a network share",
			`\\SERVER\Share\\`:                     "is the root of a network share",
			`\\?\UNC\server\share`:                 "is the root of a network share",
			`C:\ProgramData\Vectory\agent`:         "is the agent's state directory.",
			`c:/programdata/vectory/AGENT/`:        "is the agent's state directory.",
			`\\?\C:\ProgramData\Vectory\agent`:     "is the agent's state directory.",
			`C:\ProgramData\Vectory\agent\assets`:  "lies inside the agent's state directory, C:\\ProgramData\\Vectory\\agent.",
			`C:\ProgramData\Vectory\agent.\assets`: "lies inside the agent's state directory",
			`C:\ProgramData\Vectory\agent \assets`: "lies inside the agent's state directory",
			`C:\ProgramData\Vectory\..\Vectory\agent\x`: "lies inside the agent's state directory",
			`C:\ProgramData\Vectory`:                    "contains the agent's state directory",
			`C:\ProgramData`:                            "contains the agent's state directory",
			`C:\ProgramData\Vectory\managed`:            "is the managed configuration directory.",
			`C:\PROGRAMDATA\vectory\MANAGED\inner`:      "lies inside the managed configuration directory",
			`D:\Keys\TOKEN`:                             `is the file bound to secret "TOKEN".`,
			`d:\keys\token`:                             `is the file bound to secret "TOKEN".`,
			`D:\Keys`:                                   `contains the file bound to secret "TOKEN", D:\Keys\TOKEN.`,
		},
		allowed:     []string{`C:\ProgramData\VectoryData`, `C:\Logs\app`, `D:\Logs`, `E:\Keys`, `\\server\share\logs`, `C:\ProgramData\Vectory\agent2`, `//server/share/Keys`},
		notAbsolute: []string{`logs\app`, `D:logs`, `D:`, `\Windows`, `\\server`, `\\\server\share`, `\\?\GLOBALROOT\Device\x`, ""},
		whatToAllow: `C:\Logs\app`,
	},
}

func (c rootStyleCase) protected() []protectedPath {
	managedDir := c.managed[:strings.LastIndexAny(c.managed, `/\`)]
	return []protectedPath{
		{what: "the agent's state directory", path: c.state},
		{what: "the managed configuration directory", path: managedDir},
		{what: `the file bound to secret "TOKEN"`, path: c.secret, file: true},
	}
}

// A file root may not be a filesystem or volume root, or be, contain or lie
// inside the state directory, the managed configuration directory or a bound
// secret file. The refusal names the root and what it overlaps, and says what
// to allow instead. The same rules run for the three path styles: drive
// letters, UNC shares, both separators and case on Windows; case on macOS.
func TestAFileRootThatCoversWhatTheAgentKeepsPrivateIsRefused(t *testing.T) {
	for _, c := range rootStyles {
		t.Run(c.name, func(t *testing.T) {
			protected := c.protected()
			for root, want := range c.refused {
				problem := fileRootProblem(c.style, root, protected)
				if problem == "" {
					t.Errorf("%q was accepted", root)
					continue
				}
				if !strings.HasPrefix(problem, "File root "+root+" ") || !strings.Contains(problem, want) || !strings.HasSuffix(problem, rootAdvice+c.whatToAllow+".") {
					t.Errorf("%q: %s", root, problem)
				}
			}
			for _, root := range c.allowed {
				if problem := fileRootProblem(c.style, root, protected); problem != "" {
					t.Errorf("%q was refused: %s", root, problem)
				}
			}
			for _, root := range c.notAbsolute {
				if problem := fileRootProblem(c.style, root, protected); !strings.HasPrefix(problem, "File root "+root+" isn't an absolute path.") {
					t.Errorf("%q: %s", root, problem)
				}
			}
		})
	}
}

// The state directory, the managed configuration directory and a secret file
// say what is wrong in their own words, and the exact text is part of the
// operator's experience.
func TestTheFileRootRefusalsSayWhyAndWhatToDo(t *testing.T) {
	protected := rootStyles[0].protected()
	for root, want := range map[string]string{
		"/":                      `File root / is the filesystem root, so pipelines could read and write every file on it. Allow the directory that holds the files pipelines need, such as /var/log/app.`,
		"/var/lib":               `File root /var/lib contains the agent's state directory, /var/lib/vectory-agent. It holds this host's identity key and settings, so no pipeline may read or write there. Allow the directory that holds the files pipelines need, such as /var/log/app.`,
		"/etc/vectory/managed/x": `File root /etc/vectory/managed/x lies inside the managed configuration directory, /etc/vectory/managed. It holds the rendered pipelines, which carry resolved device secrets, so no pipeline may read or write there. Allow the directory that holds the files pipelines need, such as /var/log/app.`,
		"/srv/keys":              `File root /srv/keys contains the file bound to secret "TOKEN", /srv/keys/TOKEN. The file holds a device secret's value, so no pipeline may read it. Allow the directory that holds the files pipelines need, such as /var/log/app.`,
	} {
		if got := fileRootProblem(posixPaths, root, protected); got != want {
			t.Errorf("%q:\n got %s\nwant %s", root, got, want)
		}
	}
	// Nothing lies inside a file, so a root below a secret's path overlaps nothing.
	if got := fileRootProblem(posixPaths, "/srv/keys/TOKEN/inner", protected); got != "" {
		t.Errorf("a root below a secret file was refused: %s", got)
	}
}

// What a host's file system treats as one name is one name. A root named in
// another case, through a link, or before it exists is judged where it leads.
func TestAFileRootIsJudgedWhereItLeads(t *testing.T) {
	base := privateTempDir(t)
	state := filepath.Join(base, "State")
	managed := filepath.Join(base, "managed")
	for _, dir := range []string{state, managed, filepath.Join(base, "logs")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	managedConfig := filepath.Join(managed, "vector.json")
	secretDir := filepath.Join(base, "secrets")
	if err := os.MkdirAll(secretDir, 0o700); err != nil {
		t.Fatal(err)
	}
	secrets := map[string]string{"TOKEN": filepath.Join(secretDir, "token")}
	refused := func(t *testing.T, root, want string) {
		t.Helper()
		err := checkFileRoots([]string{root}, state, managedConfig, secrets)
		if err == nil || !strings.HasPrefix(err.Error(), "File root "+root+" ") || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", root, err)
		}
	}
	// Each of these is the thing itself, or what holds it or lies in it.
	refused(t, state, "is the agent's state directory.")
	refused(t, filepath.Join(state, "assets"), "lies inside the agent's state directory")
	refused(t, filepath.Join(state, "not", "yet", "there"), "lies inside the agent's state directory")
	refused(t, base, "contains the agent's state directory")
	refused(t, managed, "is the managed configuration directory.")
	refused(t, filepath.Join(managed, "nested"), "lies inside the managed configuration directory")
	refused(t, secretDir, `contains the file bound to secret "TOKEN"`)
	refused(t, secrets["TOKEN"], `is the file bound to secret "TOKEN".`)
	if err := checkFileRoots([]string{filepath.Join(base, "logs"), filepath.Join(base, "State-data")}, state, managedConfig, secrets); err != nil {
		t.Errorf("a sibling was refused: %v", err)
	}
	// A path that isn't absolute (hand-edited settings) is left out, not a crash.
	if err := checkFileRoots([]string{filepath.Join(base, "logs")}, "state", "managed.json", map[string]string{"TOKEN": "relative"}); err != nil {
		t.Errorf("relative settings: %v", err)
	}

	if runtime.GOOS != "windows" {
		// Another spelling of the state directory by a link: the root is typed
		// through the link, and so is the state directory in another test below.
		link := filepath.Join(base, "link")
		if err := os.Symlink(state, link); err != nil {
			t.Fatal(err)
		}
		refused(t, link, "is the agent's state directory.")
		refused(t, filepath.Join(link, "assets"), "lies inside the agent's state directory")
		// The settings may hold the state directory spelled through a link while
		// the root is typed as the real path: the same place.
		if err := checkFileRoots([]string{state}, link, managedConfig, nil); err == nil {
			t.Error("a root that is the real path of a linked state directory was accepted")
		}
		if err := checkFileRoots([]string{filepath.Join(state, "inner")}, link, managedConfig, nil); err == nil {
			t.Error("a root below the real path of a linked state directory was accepted")
		}
		// A link that leads out of every private place is judged by where it leads.
		elsewhere := filepath.Join(base, "elsewhere")
		if err := os.Mkdir(elsewhere, 0o700); err != nil {
			t.Fatal(err)
		}
		other := filepath.Join(base, "other")
		if err := os.Symlink(elsewhere, other); err != nil {
			t.Fatal(err)
		}
		if err := checkFileRoots([]string{other}, state, managedConfig, secrets); err != nil {
			t.Errorf("a link to a harmless directory was refused: %v", err)
		}
	}
	// On a file system that ignores case, a root in another case is the same place.
	upper := filepath.Join(base, "STATE")
	if _, err := os.Stat(upper); err == nil {
		refused(t, upper, "the agent's state directory")
	}
}

// ReadInstallPolicy, install --capability-policy and setup judge the part that
// needs no installation: a filesystem or volume root.
func TestReadInstallPolicyRefusesAFilesystemRoot(t *testing.T) {
	volume := filepath.VolumeName(os.TempDir()) + string(filepath.Separator)
	raw, _ := json.Marshal([]string{volume})
	path := filepath.Join(t.TempDir(), "allowances.json")
	if err := os.WriteFile(path, []byte(`{"allowed_file_roots":`+string(raw)+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadInstallPolicy(path); err == nil || !strings.Contains(err.Error(), "so pipelines could read and write every file on it") {
		t.Fatalf("%q: %v", volume, err)
	}
	if err := validateInstallPolicy(CapabilityPolicy{AllowedFileRoots: []string{volume}}); err == nil {
		t.Fatal("a volume root passed validateInstallPolicy")
	}
	if err := validateInstallPolicy(CapabilityPolicy{AllowedFileRoots: []string{filepath.Join(os.TempDir(), "logs")}}); err != nil {
		t.Fatal(err)
	}
}

// `vectory allow`, `install` and `setup` all end in InstallWithOptions: a root
// that covers the state directory, the managed configuration or a bound secret
// file is refused there, before anything changes.
func TestInstallOptionsRefuseRootsThatCoverWhatTheAgentKeepsPrivate(t *testing.T) {
	f := maintenanceFixture(t)
	secretDir := privateTempDir(t)
	secret := filepath.Join(secretDir, "token")
	if err := AtomicWrite(secret, []byte("synthetic-placeholder")); err != nil {
		t.Fatal(err)
	}
	if err := ConfigureSecretFiles(f.dir, map[string]string{"TOKEN": secret}); err != nil {
		t.Fatal(err)
	}
	// The fixture's three directories are siblings in one test directory.
	base := filepath.Dir(f.dir)
	before := map[string][]byte{}
	for _, name := range []string{"settings.json", "state.json"} {
		before[name], _ = os.ReadFile(filepath.Join(f.dir, name))
	}
	unchanged := func(t *testing.T) {
		t.Helper()
		for name, want := range before {
			if got, _ := os.ReadFile(filepath.Join(f.dir, name)); !bytes.Equal(got, want) {
				t.Fatalf("a refused root changed %s", name)
			}
		}
	}
	for name, tc := range map[string]struct {
		root, want string
	}{
		"the state directory":    {f.dir, "is the agent's state directory."},
		"inside the state":       {filepath.Join(f.dir, "assets"), "lies inside the agent's state directory"},
		"above the state":        {base, "contains the agent's state directory"},
		"the managed directory":  {filepath.Dir(f.managed), "is the managed configuration directory."},
		"inside the managed":     {filepath.Join(filepath.Dir(f.managed), "x"), "lies inside the managed configuration directory"},
		"the secret's directory": {secretDir, `contains the file bound to secret "TOKEN"`},
		"the secret file":        {secret, `is the file bound to secret "TOKEN".`},
		"the filesystem root":    {filepath.VolumeName(f.dir) + string(filepath.Separator), "so pipelines could read and write every file on it"},
	} {
		t.Run(name, func(t *testing.T) {
			for how, options := range map[string]InstallOptions{
				"vectory allow": {AddAllowances: &CapabilityPolicy{AllowedFileRoots: []string{tc.root}}},
				"a replacement": {CapabilityPolicy: &CapabilityPolicy{AllowedFileRoots: []string{filepath.Join(t.TempDir(), "fine"), tc.root}}},
			} {
				err := InstallWithOptions(context.Background(), f.dir, options)
				if err == nil || !strings.HasPrefix(err.Error(), "File root "+tc.root+" ") || !strings.Contains(err.Error(), tc.want) {
					t.Errorf("%s: %v", how, err)
				}
				unchanged(t)
			}
		})
	}
	// The same call that binds a secret file judges the roots against it.
	other := filepath.Join(secretDir, "other")
	if err := AtomicWrite(other, []byte("synthetic-placeholder")); err != nil {
		t.Fatal(err)
	}
	err := InstallWithOptions(context.Background(), f.dir, InstallOptions{
		CapabilityPolicy: &CapabilityPolicy{AllowedFileRoots: []string{secretDir}},
		SecretFiles:      optionPointer(map[string]string{"NEW": other}),
	})
	if err == nil || !strings.Contains(err.Error(), `contains the file bound to secret "NEW"`) {
		t.Errorf("a root over a file bound in the same call: %v", err)
	}
	unchanged(t)

	// A good root is allowed, and roots this call leaves alone are not judged
	// again: an installation that allowed one earlier can still change the rest.
	good := filepath.Join(t.TempDir(), "logs")
	if err := InstallWithOptions(context.Background(), f.dir, InstallOptions{AddAllowances: &CapabilityPolicy{AllowedFileRoots: []string{good}}}); err != nil {
		t.Fatal(err)
	}
	if settings, _ := LoadSettings(f.dir); len(settings.CapabilityPolicy.AllowedFileRoots) != 1 || settings.CapabilityPolicy.AllowedFileRoots[0] != good {
		t.Fatalf("the good root was not saved: %+v", settings.CapabilityPolicy)
	}
	doc, err := loadSettingsDocument(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	next := doc.value
	next.CapabilityPolicy.AllowedFileRoots = append(next.CapabilityPolicy.AllowedFileRoots, base)
	if err := WriteJSON(filepath.Join(f.dir, "settings.json"), next); err != nil {
		t.Fatal(err)
	}
	if err := InstallWithOptions(context.Background(), f.dir, InstallOptions{AddAllowances: &CapabilityPolicy{AllowedNetworkHosts: []string{"logs.example.test:443"}}}); err != nil {
		t.Errorf("an earlier root locked the host out of an unrelated change: %v", err)
	}
}

// A fresh installation judges the roots before it creates anything.
func TestAFreshInstallationRefusesRootsThatCoverItsOwnDirectoriesBeforeCreatingThem(t *testing.T) {
	for name, root := range map[string]func(state, managedDir string) string{
		"the state directory":      func(state, _ string) string { return state },
		"the managed directory":    func(_, managedDir string) string { return managedDir },
		"the directory above both": func(state, _ string) string { return filepath.Dir(state) },
	} {
		t.Run(name, func(t *testing.T) {
			base := t.TempDir()
			dir, managed, binary := filepath.Join(base, "state"), filepath.Join(base, "managed", "managed.json"), filepath.Join(base, "vector")
			if err := os.WriteFile(binary, []byte("synthetic-probe-fixture"), 0o700); err != nil {
				t.Fatal(err)
			}
			probed := false
			err := installWithOptions(context.Background(), dir,
				InstallOptions{Adopt: true, VectorBinary: &binary, ManagedConfig: &managed, CapabilityPolicy: &CapabilityPolicy{AllowedFileRoots: []string{root(dir, filepath.Dir(managed))}}},
				func(context.Context, Settings) (string, error) { probed = true; return VectorVersion, nil })
			if err == nil || !strings.HasPrefix(err.Error(), "File root ") {
				t.Fatalf("got %v", err)
			}
			if probed {
				t.Error("Vector was probed for an installation that was refused")
			}
			for _, path := range []string{dir, filepath.Dir(managed)} {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					t.Errorf("%s exists after the refusal", path)
				}
			}
		})
	}
}
