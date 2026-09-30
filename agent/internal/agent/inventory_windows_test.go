//go:build windows

package agent

import (
	"reflect"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The command lines the inventory splits come from Windows, so its splitter is
// held to what Windows itself does with them: it agrees with
// CommandLineToArgvW, and with the quoting Go and the service manager write.
func TestWindowsCommandLineSplitterAgreesWithTheSystem(t *testing.T) {
	lines := []string{
		`"C:\Program Files\Vector\bin\vector.exe" --config "C:\Program Files\Vector\config\vector.yaml"`,
		`vector.exe -c a.yaml -c b.yaml`,
		`"abc" d e`,
		`x a\\\b d"e f"g h`,
		`x a\\\"b c d`,
		`x a\\\\"b c" d e`,
		"x\t--tab\t\"two  words\"",
		`x "" y`,
		`  leading.exe   spaced  `,
		`C:\tools\vector.exe --config-dir "C:\conf.d\\"`,
	}
	for _, line := range lines {
		want, err := windows.DecomposeCommandLine(line)
		if err != nil {
			t.Fatal(err)
		}
		if got := splitWindowsCommandLine(line); !reflect.DeepEqual(got, want) {
			t.Errorf("%s\n got %q\nwant %q", line, got, want)
		}
	}
	arguments := [][]string{
		{`C:\Program Files\Vector\bin\vector.exe`, "--config", `C:\Program Files\Vector\config\vector.yaml`},
		{`C:\v.exe`, "--label", "two words", "", `say "hi"`, `ends with a backslash\`, `C:\dir with space\`, "tab\there", "unicode-\u00e9\u65e5"},
	}
	for _, args := range arguments {
		line := windows.ComposeCommandLine(args)
		if got := splitWindowsCommandLine(line); !reflect.DeepEqual(got, args) {
			t.Errorf("%s\n got %q\nwant %q", line, got, args)
		}
		if got := parseImagePath(line); !reflect.DeepEqual(got, args) {
			t.Errorf("image path %s\n got %q\nwant %q", line, got, args)
		}
	}
}

// Another process's memory is read at offsets taken from the layouts x/sys
// declares. On 64-bit Windows they are the documented ones.
func TestProcessParameterOffsetsAreThoseOfWindows(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("the inventory reads 64-bit processes")
	}
	want := map[string][2]uintptr{
		"PEB.ProcessParameters":                {offsetProcessParameters, 0x20},
		"parameters.CurrentDirectory":          {offsetCurrentDirectory, 0x38},
		"parameters.CommandLine":               {offsetCommandLine, 0x70},
		"parameters.Environment":               {offsetEnvironment, 0x80},
		"parameters.EnvironmentSize":           {offsetEnvironmentSize, 0x3F0},
		"UNICODE_STRING.Length":                {offsetStringLength, 0},
		"UNICODE_STRING.Buffer":                {offsetStringBuffer, 8},
		"PROCESS_BASIC_INFORMATION (48 bytes)": {unsafe.Sizeof(processBasicInformation{}), 48},
		"PROCESS_BASIC_INFORMATION.Peb":        {unsafe.Offsetof(processBasicInformation{}.PebBaseAddress), 8},
	}
	for name, pair := range want {
		if pair[0] != pair[1] {
			t.Errorf("%s is at %#x, Windows has it at %#x", name, pair[0], pair[1])
		}
	}
}

// The process reading and the service listing are the ones setup runs, here
// against this very process: its own command line and directory come back, and
// an executable that isn't running is not found.
func TestReadProcessInfoReadsThisProcess(t *testing.T) {
	info, err := readProcessInfo(windows.GetCurrentProcessId())
	if err != nil {
		t.Fatal(err)
	}
	want := windows.GetCommandLine()
	if got := windows.UTF16PtrToString(want); info.commandLine != got {
		t.Fatalf("command line %q, want %q", info.commandLine, got)
	}
	if info.currentDirectory == "" || !info.environmentKnown || len(info.environment) == 0 {
		t.Fatalf("%+v", info)
	}
	if _, err := readProcessInfo(0xFFFFFFF0); err == nil {
		t.Fatal("a process that doesn't exist was read")
	}
	if names := runningServiceNames(); len(names) == 0 {
		t.Fatal("no running service was listed, and Windows always runs some")
	}
}
