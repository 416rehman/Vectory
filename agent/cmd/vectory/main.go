package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/vectory/vectory/agent/internal/agent"
	"golang.org/x/term"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "__vector-host" {
		if len(os.Args) != 4 {
			os.Exit(2)
		}
		os.Exit(agent.VectorHost(os.Args[2], os.Args[3]))
	}
	os.Exit(run(os.Args[1:]))
}
func defaultState() string {
	if runtime.GOOS == "windows" {
		p := os.Getenv("ProgramData")
		if p == "" {
			p = `C:\ProgramData`
		}
		return filepath.Join(p, "Vectory")
	}
	if runtime.GOOS == "darwin" {
		return "/Library/Application Support/Vectory"
	}
	return "/var/lib/vectory"
}
func output(v any) { enc := json.NewEncoder(os.Stdout); enc.SetIndent("", "  "); _ = enc.Encode(v) }
func run(args []string) int {
	if len(args) == 0 {
		usage()
		return 2
	}
	command := args[0]
	args = args[1:]
	if strings.HasPrefix(command, "-") {
		args = append([]string{command}, args...)
		command = "enroll"
	}
	if command == "version" {
		fmt.Println(agent.Version)
		return 0
	}
	if command == "help" || command == "--help" {
		usage()
		return 0
	}
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	dir := fs.String("state-dir", defaultState(), "absolute protected state directory")
	jsonOut := fs.Bool("json", false, "JSON output")
	var err error
	ctx, stop := signal.NotifyContext(context.Background(), terminationSignals()...)
	defer stop()
	switch command {
	case "service-install":
		account := fs.String("service-user", "", "existing unprivileged Unix account; Windows uses NT SERVICE\\Vectory")
		if fs.Parse(args) != nil {
			return 2
		}
		err = agent.ServiceInstall(*dir, *account)
	case "service-start", "service-stop", "service-uninstall":
		if fs.Parse(args) != nil {
			return 2
		}
		err = agent.ServiceControl(strings.TrimPrefix(command, "service-"))
	case "install":
		binary := fs.String("vector-binary", "", "absolute already installed Vector binary")
		config := fs.String("managed-config", "", "absolute sole managed .json path")
		adopt := fs.Bool("adopt", false, "explicitly adopt after stopping existing Vector and inventorying include/config-dir arguments")
		policyPath := fs.String("capability-policy", "", "operator-owned local capability policy JSON")
		metrics := fs.String("metrics-url", "", "optional explicitly provisioned http://loopback-IP:port/metrics")
		secretFiles := fs.String("secret-files", "", "local JSON map of approved secret names to absolute private file paths")
		if fs.Parse(args) != nil {
			return 2
		}
		var policy *agent.CapabilityPolicy
		if *policyPath != "" {
			policy = &agent.CapabilityPolicy{}
			err = agent.ReadJSON(*policyPath, policy)
		}
		if err == nil {
			err = agent.Install(ctx, *dir, *binary, *config, *adopt, policy)
		}
		if err == nil && *metrics != "" {
			err = agent.ConfigureMetrics(*dir, *metrics)
		}
		if err == nil && *secretFiles != "" {
			var bindings map[string]string
			err = agent.ReadJSON(*secretFiles, &bindings)
			if err == nil {
				err = agent.ConfigureSecretFiles(*dir, bindings)
			}
		}
	case "configure-secrets":
		secretFiles := fs.String("secret-files", "", "local JSON map of approved names to absolute private file paths; empty map removes bindings")
		if fs.Parse(args) != nil {
			return 2
		}
		var bindings map[string]string
		err = agent.ReadJSON(*secretFiles, &bindings)
		if err == nil {
			err = agent.ConfigureSecretFiles(*dir, bindings)
		}
	case "enroll", "recover-enrollment":
		server := fs.String("server", "", "verified HTTPS origin")
		compatServer := fs.String("ip", "", "compatibility server/IP, still verified HTTPS")
		name := fs.String("id", "", "unique machine name")
		ca := fs.String("ca-file", "", "private server CA obtained through a trusted channel")
		stdin := fs.Bool("token-stdin", false, "read token from standard input")
		tokenFile := fs.String("token-file", "", "read token from protected local file")
		token := fs.String("token", "", "compatibility token argument (visible in process listings)")
		if fs.Parse(args) != nil {
			return 2
		}
		if *server == "" {
			*server = *compatServer
		}
		if command == "recover-enrollment" {
			existing, e := agent.LoadSettings(*dir)
			if e != nil {
				fmt.Fprintln(os.Stderr, "vectory: recovery requires an existing installation")
				return 1
			}
			if *server == "" {
				*server = existing.Server
			}
			if *name == "" {
				*name = existing.Name
			}
			if *ca == "" {
				*ca = existing.CAFile
			}
		}
		var value string
		count := 0
		if *stdin {
			count++
		}
		if *tokenFile != "" {
			count++
		}
		if *token != "" {
			count++
		}
		if count > 1 {
			err = errors.New("choose only one token input")
		} else if *stdin {
			value, err = readToken(os.Stdin)
		} else if *tokenFile != "" {
			if err = agent.SafePath(*tokenFile); err == nil {
				var f *os.File
				f, err = os.Open(*tokenFile)
				if err == nil {
					info, _ := f.Stat()
					if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
						err = errors.New("token file must not be readable by group or other users")
					} else {
						value, err = readToken(f)
					}
					f.Close()
				}
			}
		} else if *token != "" {
			fmt.Fprintln(os.Stderr, "Warning: command-line tokens may appear in shell history and process listings; prefer --token-stdin.")
			value = *token
		} else if term.IsTerminal(int(os.Stdin.Fd())) {
			fmt.Fprint(os.Stderr, "Enrollment token: ")
			var b []byte
			b, err = term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
			value = string(b)
		} else {
			err = errors.New("use --token-stdin, --token-file, or an interactive terminal")
		}
		if err == nil {
			err = agent.ConfigureEnrollment(*dir, *server, *name, *ca)
		}
		if err == nil {
			var s agent.Settings
			s, err = agent.LoadSettings(*dir)
			if err == nil {
				if command == "recover-enrollment" {
					err = agent.RecoverEnrollment(ctx, *dir, s, strings.TrimSpace(value))
				} else {
					err = agent.Enroll(ctx, *dir, s, strings.TrimSpace(value))
				}
			}
		}
	case "run", "service":
		once := fs.Bool("once", false, "one reconciliation then stop owned Vector; test only")
		if fs.Parse(args) != nil {
			return 2
		}
		report := func(message string) {
			if *jsonOut {
				output(map[string]string{"message": message})
			} else {
				fmt.Fprintln(os.Stderr, message)
			}
		}
		if command == "service" {
			err = service(ctx, *dir, report)
		} else {
			err = agent.Run(ctx, *dir, *once, report)
		}
	case "status":
		if fs.Parse(args) != nil {
			return 2
		}
		var s map[string]any
		s, err = agent.StateSummary(*dir)
		if err == nil {
			output(s)
		}
	case "doctor":
		if fs.Parse(args) != nil {
			return 2
		}
		var s map[string]any
		s, err = agent.Doctor(ctx, *dir)
		output(s)
	case "pause", "resume":
		if fs.Parse(args) != nil {
			return 2
		}
		err = agent.SetPause(*dir, command == "pause")
		if err == nil && command == "resume" {
			fmt.Fprintln(os.Stderr, "Local pause removed. Managed manual edits will be replaced when the latest authorized state is reconciled; remote pause still applies.")
		}
	case "retry":
		if fs.Parse(args) != nil {
			return 2
		}
		var unlock func()
		unlock, err = agent.Lock(*dir)
		if err == nil {
			defer unlock()
			var s agent.State
			s, err = agent.LoadState(*dir)
			if err == nil {
				s.FailedGeneration = nil
				s.FailedEffectiveSHA256 = ""
				err = agent.SaveState(*dir, s)
			}
		}
	case "unenroll":
		if fs.Parse(args) != nil {
			return 2
		}
		err = agent.Unenroll(*dir)
		if err == nil {
			fmt.Fprintln(os.Stderr, "Local credentials removed. Revoke the old device in the dashboard; prior server authorization cannot be revoked offline.")
		}
	case "uninstall":
		purge := fs.Bool("purge", false, "delete this exact state directory after service removal")
		if fs.Parse(args) != nil {
			return 2
		}
		var unlock func()
		unlock, err = agent.Lock(*dir)
		if err == nil {
			unlock()
			if *purge {
				resolved, e := filepath.Abs(*dir)
				if e != nil || resolved == filepath.VolumeName(resolved)+string(filepath.Separator) || filepath.Base(resolved) == "." {
					err = errors.New("unsafe purge path")
				} else if _, e = os.Stat(filepath.Join(resolved, "settings.json")); e != nil {
					err = errors.New("purge requires an installed Vectory settings.json")
				} else if e = agent.SafePath(resolved); e != nil {
					err = e
				} else {
					err = os.RemoveAll(resolved)
				}
			} else {
				fmt.Fprintln(os.Stderr, "State and identity preserved. Remove the service registration and installed binary through your package manager.")
			}
		}
	default:
		usage()
		return 2
	}
	if err != nil {
		if *jsonOut {
			output(map[string]string{"error": err.Error()})
		} else {
			fmt.Fprintln(os.Stderr, "vectory:", err)
		}
		return 1
	}
	if command != "status" && command != "doctor" && command != "run" && command != "service" {
		if *jsonOut {
			output(map[string]string{"status": "ok", "command": command})
		} else {
			fmt.Println(command + ": complete")
		}
	}
	return 0
}
func readToken(r io.Reader) (string, error) {
	line, err := bufio.NewReader(io.LimitReader(r, 4097)).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	if len(line) > 4096 {
		return "", errors.New("token exceeds input limit")
	}
	return strings.TrimSpace(line), nil
}
func usage() {
	fmt.Fprintln(os.Stderr, `Vectory agent — explicitly adopted Vector 0.58.0
Commands: install configure-secrets enroll recover-enrollment run service status doctor pause resume retry unenroll uninstall version
Native service commands: service-install [--service-user <account>], service-start, service-stop, service-uninstall
Common: --state-dir <absolute path> --json
Install: --vector-binary <absolute path> --managed-config <absolute .json> --adopt
Enroll: --server https://host:8443 --id edge-01 --token-stdin [--ca-file <trusted PEM>]
Compatibility: vectory -ip <server> -id <name> -token <token> [--state-dir <path>]
TLS verification is mandatory. No Vector installation, upgrade, or arbitrary remote command feature.
Exit codes: 0 success; 1 operation/preflight failed; 2 invalid command or options.`)
}
