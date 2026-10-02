package agent

import (
	"encoding/binary"
	"reflect"
	"testing"
	"unicode/utf16"
)

// These parsers read what each operating system says about a process, so they
// are tested here with the text those systems produce, on every platform.

func TestSplitNULKeepsEmptyArguments(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", nil},
		{"one argument, terminated", "vector\x00", []string{"vector"}},
		{"several", "/usr/bin/vector\x00--config\x00/etc/vector/vector.yaml\x00", []string{"/usr/bin/vector", "--config", "/etc/vector/vector.yaml"}},
		{"an empty argument at the end", "vector\x00--label\x00\x00", []string{"vector", "--label", ""}},
		{"unterminated", "vector\x00-q", []string{"vector", "-q"}},
	}
	for _, c := range cases {
		if got := splitNUL([]byte(c.in)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestSelectedEnvironmentKeepsOnlyTheVariablesThatSelectConfiguration(t *testing.T) {
	entries := []string{"PATH=/usr/bin", "AWS_SECRET_ACCESS_KEY=hunter2", "VECTOR_CONFIG_DIR=/etc/vector/conf.d", "VECTOR_LOG=debug", "vector_config=/lower.yaml", "VECTOR_CONFIG=", "NOEQUALS"}
	got := selectedEnvironment(entries, false)
	want := map[string]string{"VECTOR_CONFIG_DIR": "/etc/vector/conf.d", "VECTOR_CONFIG": ""}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unix names are case-sensitive and nothing else is kept: %v", got)
	}
	got = selectedEnvironment([]string{"vector_config_dir=/lower", `Path=C:\x`, "AWS_SECRET_ACCESS_KEY=hunter2"}, true)
	if !reflect.DeepEqual(got, map[string]string{"VECTOR_CONFIG_DIR": "/lower"}) {
		t.Fatalf("windows names fold case, and nothing else is kept: %v", got)
	}
}

// What `systemctl show` prints for a unit, as systemd 255 renders it.
const systemctlVectorUnit = `FragmentPath=/lib/systemd/system/vector.service
ExecStart={ path=/usr/bin/vector ; argv[]=/usr/bin/vector --config-dir /etc/vector/conf.d ; ignore_errors=no ; start_time=[Tue 2026-09-29 10:15:00 UTC] ; stop_time=[n/a] ; pid=812 ; code=(null) ; status=0/0 }
Environment=VECTOR_LOG=info "GREETING=two words" VECTOR_CONFIG_TOML=/etc/vector/extra.toml
EnvironmentFiles=/etc/default/vector (ignore_errors=yes)
WorkingDirectory=!/var/lib/vector
`

func TestParseSystemdShow(t *testing.T) {
	info := parseSystemdShow(systemctlVectorUnit)
	if !reflect.DeepEqual(info.ExecStart, []string{"/usr/bin/vector", "--config-dir", "/etc/vector/conf.d"}) {
		t.Errorf("ExecStart %q", info.ExecStart)
	}
	if !reflect.DeepEqual(info.Environment, []string{"VECTOR_LOG=info", "GREETING=two words", "VECTOR_CONFIG_TOML=/etc/vector/extra.toml"}) {
		t.Errorf("Environment %q", info.Environment)
	}
	if !reflect.DeepEqual(info.EnvironmentFiles, []systemdEnvironmentFile{{Path: "/etc/default/vector", Optional: true}}) {
		t.Errorf("EnvironmentFiles %+v", info.EnvironmentFiles)
	}
	if info.WorkingDirectory != "/var/lib/vector" || info.FragmentPath != "/lib/systemd/system/vector.service" {
		t.Errorf("paths %q %q", info.WorkingDirectory, info.FragmentPath)
	}
	if empty := parseSystemdShow(""); len(empty.ExecStart) != 0 || len(empty.Environment) != 0 {
		t.Errorf("nothing said: %+v", empty)
	}
	if got := parseExecStart("{ path=/usr/bin/vector ; ignore_errors=no }"); got != nil {
		t.Errorf("a command without argv[]: %q", got)
	}
}

func TestParseEnvironmentFile(t *testing.T) {
	text := "# comment\n; another\n\nVECTOR_CONFIG_DIR=/etc/vector/conf.d\nQUOTED=\"a value\"\nSINGLE='x'\nnot an assignment\n  SPACED = padded \n"
	want := []string{"VECTOR_CONFIG_DIR=/etc/vector/conf.d", "QUOTED=a value", "SINGLE=x", "SPACED=padded"}
	if got := parseEnvironmentFile(text); !reflect.DeepEqual(got, want) {
		t.Fatalf("%q, want %q", got, want)
	}
}

func procArgs2(argc int, path string, padding int, args, environment []string) []byte {
	data := binary.LittleEndian.AppendUint32(nil, uint32(argc))
	data = append(data, path...)
	data = append(data, make([]byte, 1+padding)...)
	for _, arg := range args {
		data = append(append(data, arg...), 0)
	}
	for _, entry := range environment {
		data = append(append(data, entry...), 0)
	}
	return data
}

func TestParseProcArgs2(t *testing.T) {
	data := procArgs2(3, "/opt/homebrew/bin/vector", 5, []string{"vector", "--config", "/opt/homebrew/etc/vector/vector.yaml"}, []string{"HOME=/Users/op", "VECTOR_CONFIG_DIR=/x"})
	path, args, environment, err := parseProcArgs2(data)
	if err != nil || path != "/opt/homebrew/bin/vector" || !reflect.DeepEqual(args, []string{"vector", "--config", "/opt/homebrew/etc/vector/vector.yaml"}) || !reflect.DeepEqual(environment, []string{"HOME=/Users/op", "VECTOR_CONFIG_DIR=/x"}) {
		t.Fatalf("%q %q %q %v", path, args, environment, err)
	}
	// An argument that is empty stays an argument; the environment ends with an
	// empty entry or the end of the data.
	_, args, environment, err = parseProcArgs2(append(procArgs2(2, "/v", 0, []string{"v", ""}, []string{"A=1"}), 0, 0))
	if err != nil || !reflect.DeepEqual(args, []string{"v", ""}) || !reflect.DeepEqual(environment, []string{"A=1"}) {
		t.Fatalf("%q %q %v", args, environment, err)
	}
	for name, bad := range map[string][]byte{"empty": nil, "short": {1, 0}, "no path": {1, 0, 0, 0, 'a'}, "impossible count": procArgs2(1<<20, "/v", 0, nil, nil)} {
		if _, _, _, err := parseProcArgs2(bad); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A record cut short by the size limit still gives the arguments it holds.
	_, args, _, err = parseProcArgs2(procArgs2(3, "/v", 0, []string{"v", "--con"}, nil))
	if err != nil || len(args) != 2 {
		t.Fatalf("truncated: %q %v", args, err)
	}
}

func TestEnvironmentFromPS(t *testing.T) {
	command := []string{"/opt/homebrew/bin/vector", "--config-dir", "/opt/homebrew/etc/vector/conf.d"}
	line := "  /opt/homebrew/bin/vector --config-dir /opt/homebrew/etc/vector/conf.d HOME=/Users/op VECTOR_CONFIG_JSON=/x/extra.json PATH=/usr/bin AWS_SECRET_ACCESS_KEY=hunter2\n"
	got, ok := environmentFromPS(line, command)
	if !ok || !reflect.DeepEqual(got, map[string]string{"VECTOR_CONFIG_JSON": "/x/extra.json"}) {
		t.Fatalf("%v %v", got, ok)
	}
	if got, ok := environmentFromPS("/opt/homebrew/bin/vector --config-dir /opt/homebrew/etc/vector/conf.d", command); !ok || len(got) != 0 {
		t.Fatalf("a process with nothing to show: %v %v", got, ok)
	}
	if _, ok := environmentFromPS("/somewhere/else --config-dir x", command); ok {
		t.Fatal("a line that doesn't start with the arguments says nothing about the environment")
	}
	if _, ok := environmentFromPS("", command); ok {
		t.Fatal("an empty line says nothing")
	}
}

const homebrewPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>homebrew.mxcl.vector</string>
	<key>LimitLoadToSessionType</key>
	<array>
		<string>Aqua</string>
		<string>Background</string>
	</array>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/opt/vector/bin/vector</string>
		<string>--config-dir</string>
		<string>/opt/homebrew/etc/vector/conf.d</string>
		<string>--label</string>
		<string>two words</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>VECTOR_CONFIG_JSON</key>
		<string>/opt/homebrew/etc/vector/extra.json</string>
		<key>RETRIES</key>
		<integer>3</integer>
	</dict>
	<key>StandardErrorPath</key>
	<string>/opt/homebrew/var/log/vector.log</string>
	<key>WorkingDirectory</key>
	<string>/opt/homebrew/var</string>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
`

func TestParsePlist(t *testing.T) {
	job, err := parsePlist([]byte(homebrewPlist))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/opt/homebrew/opt/vector/bin/vector", "--config-dir", "/opt/homebrew/etc/vector/conf.d", "--label", "two words"}
	if job.Label != "homebrew.mxcl.vector" || !reflect.DeepEqual(job.Command(), want) || job.WorkingDirectory != "/opt/homebrew/var" {
		t.Fatalf("%+v", job)
	}
	if job.EnvironmentVariables["VECTOR_CONFIG_JSON"] != "/opt/homebrew/etc/vector/extra.json" || job.EnvironmentVariables["RETRIES"] != "3" {
		t.Fatalf("environment %v", job.EnvironmentVariables)
	}
	program, err := parsePlist([]byte(`<plist version="1.0"><dict><key>Label</key><string>x</string><key>Program</key><string>/usr/bin/vector</string></dict></plist>`))
	if err != nil || !reflect.DeepEqual(program.Command(), []string{"/usr/bin/vector"}) {
		t.Fatalf("%+v %v", program, err)
	}
	for name, bad := range map[string]string{
		"binary":      "bplist00\x00\x01",
		"not a plist": "<html></html>",
		"cut short":   `<plist version="1.0"><dict><key>Label</key>`,
		"an array":    `<plist version="1.0"><array><string>x</string></array></plist>`,
		"empty":       "",
	} {
		if _, err := parsePlist([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// The rules Microsoft documents for CommandLineToArgvW, and service paths.
func TestSplitWindowsCommandLine(t *testing.T) {
	cases := []struct {
		line string
		want []string
	}{
		{`"C:\Program Files\Vector\bin\vector.exe" --config "C:\Program Files\Vector\config\vector.yaml"`, []string{`C:\Program Files\Vector\bin\vector.exe`, "--config", `C:\Program Files\Vector\config\vector.yaml`}},
		{`vector.exe -c a.yaml -c b.yaml`, []string{"vector.exe", "-c", "a.yaml", "-c", "b.yaml"}},
		{`"abc" d e`, []string{"abc", "d", "e"}},
		{`x a\\\b d"e f"g h`, []string{"x", `a\\\b`, "de fg", "h"}},
		{`x a\\\"b c d`, []string{"x", `a\"b`, "c", "d"}},
		{`x a\\\\"b c" d e`, []string{"x", `a\\b c`, "d", "e"}},
		{"x\t--tab\t\"two  words\"", []string{"x", "--tab", "two  words"}},
		{`x "" y`, []string{"x", "", "y"}},
		{`  leading.exe   spaced  `, []string{"", "leading.exe", "spaced"}},
		{`"unterminated first`, []string{"unterminated first"}},
		{"", nil},
		{"   ", nil},
	}
	for _, c := range cases {
		if got := splitWindowsCommandLine(c.line); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s\n got %q\nwant %q", c.line, got, c.want)
		}
	}
}

func TestParseImagePath(t *testing.T) {
	cases := []struct {
		image string
		want  []string
	}{
		{`"C:\Program Files\Vector\bin\vector.exe" --config "C:\Program Files\Vector\config\vector.yaml"`, []string{`C:\Program Files\Vector\bin\vector.exe`, "--config", `C:\Program Files\Vector\config\vector.yaml`}},
		{`C:\Program Files\Vector\bin\vector.exe --config C:\vector.yaml`, []string{`C:\Program Files\Vector\bin\vector.exe`, "--config", `C:\vector.yaml`}},
		{`C:\Program Files\Vector\bin\VECTOR.EXE`, []string{`C:\Program Files\Vector\bin\VECTOR.EXE`}},
		{`C:\tools\vector.exe.old\vector.exe -q`, []string{`C:\tools\vector.exe.old\vector.exe`, "-q"}},
		{`vector -q`, []string{"vector", "-q"}},
		{"", nil},
	}
	for _, c := range cases {
		if got := parseImagePath(c.image); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s\n got %q\nwant %q", c.image, got, c.want)
		}
	}
}

func TestParseWindowsEnvironment(t *testing.T) {
	block := utf16.Encode([]rune("SystemRoot=C:\\Windows\x00VECTOR_CONFIG_DIR=C:\\conf.d\x00\x00garbage after the end\x00"))
	want := []string{`SystemRoot=C:\Windows`, `VECTOR_CONFIG_DIR=C:\conf.d`}
	if got := parseWindowsEnvironment(block); !reflect.DeepEqual(got, want) {
		t.Fatalf("%q, want %q", got, want)
	}
	if got := parseWindowsEnvironment(nil); got != nil {
		t.Fatalf("%q", got)
	}
}
