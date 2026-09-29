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
		if len(os.Args) != 5 || (os.Args[4] != "restricted" && os.Args[4] != "full") {
			os.Exit(2)
		}
		os.Exit(agent.VectorHost(os.Args[2], os.Args[3], os.Args[4] == "full"))
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
		if !parseFlagsOnly(fs, args, command) {
			return 2
		}
		err = agent.ServiceInstall(*dir, *account)
	case "service-start", "service-stop", "service-uninstall":
		if !parseFlagsOnly(fs, args, command) {
			return 2
		}
		if flagSupplied(fs, "state-dir") {
			fmt.Fprintln(os.Stderr, "vectory: service control targets the fixed Vectory service; --state-dir cannot select another service")
			return 2
		}
		err = agent.ServiceControl(strings.TrimPrefix(command, "service-"))
	case "install":
		binary := fs.String("vector-binary", "", "absolute already installed Vector binary")
		config := fs.String("managed-config", "", "absolute sole managed .json path")
		adopt := fs.Bool("adopt", false, "explicitly adopt after stopping existing Vector and inventorying include/config-dir arguments")
		policyPath := fs.String("capability-policy", "", "operator-owned local capability policy JSON")
		full := fs.Bool("allow-full-vector-config", false, "local grant: trust pipeline publishers with all Vector capabilities, native providers, exec, environment and host resources")
		metrics := fs.String("metrics-url", "", "optional explicitly provisioned http://loopback-IP:port/metrics")
		clearMetrics := fs.Bool("clear-metrics-url", false, "explicitly remove the local metrics collector setting; pipeline exporter is unchanged")
		secretFiles := fs.String("secret-files", "", "local JSON map of approved secret names to absolute private file paths")
		if fs.Parse(args) != nil {
			return 2
		}
		if fs.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "vectory: install accepts flags only; unexpected positional arguments")
			return 2
		}
		if err = metricsOptionUsage(fs, *clearMetrics, false); err != nil {
			fmt.Fprintln(os.Stderr, "vectory:", err)
			return 2
		}
		opts := agent.InstallOptions{Adopt: *adopt, ClearMetricsURL: *clearMetrics}
		fs.Visit(func(f *flag.Flag) {
			switch f.Name {
			case "vector-binary":
				opts.VectorBinary = binary
			case "managed-config":
				opts.ManagedConfig = config
			case "allow-full-vector-config":
				opts.FullVectorConfig = full
			case "metrics-url":
				opts.MetricsURL = metrics
			case "capability-policy":
				if err == nil {
					opts.CapabilityPolicy, err = agent.ReadInstallPolicy(*policyPath)
				}
			case "secret-files":
				if err == nil {
					opts.SecretFiles, err = agent.ReadSecretBindings(*secretFiles)
				}
			}
		})
		if err == nil {
			err = agent.InstallWithOptions(ctx, *dir, opts)
		}
		if err == nil && (opts.MetricsURL != nil || opts.ClearMetricsURL) {
			reportMetricsConfiguration(command, opts.ClearMetricsURL, *jsonOut)
			return 0
		}
	case "re-adopt":
		binary := fs.String("vector-binary", "", "optional replacement absolute local Vector path; defaults to the currently adopted path")
		expected := fs.String("expected-sha256", "", "required independently approved SHA256 of the replacement binary")
		if fs.Parse(args) != nil || fs.NArg() != 0 {
			return 2
		}
		var result agent.ReAdoptionReport
		result, err = agent.ReAdopt(ctx, *dir, *binary, *expected)
		if err == nil {
			if *jsonOut {
				output(result)
			} else {
				fmt.Printf("Approved Vector %s at %s\nSHA256: %s\n%s\n", result.VectorVersion, result.VectorBinary, result.SHA256, result.NextAction)
			}
			return 0
		}
	case "configure-metrics":
		metrics := fs.String("metrics-url", "", "explicitly provisioned http://loopback-IP:port/metrics")
		clearMetrics := fs.Bool("clear-metrics-url", false, "explicitly remove the local metrics collector setting; pipeline exporter is unchanged")
		if fs.Parse(args) != nil {
			return 2
		}
		if fs.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "vectory: configure-metrics accepts flags only; unexpected positional arguments")
			return 2
		}
		if err = metricsOptionUsage(fs, *clearMetrics, true); err != nil {
			fmt.Fprintln(os.Stderr, "vectory:", err)
			return 2
		}
		if *clearMetrics {
			err = agent.ClearMetrics(*dir)
		} else {
			err = agent.ConfigureMetrics(*dir, *metrics)
		}
		if err == nil {
			reportMetricsConfiguration(command, *clearMetrics, *jsonOut)
			return 0
		}
	case "configure-secrets":
		secretFiles := fs.String("secret-files", "", "local JSON map of approved names to absolute private file paths; empty map removes bindings")
		if fs.Parse(args) != nil {
			return 2
		}
		if fs.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "vectory: configure-secrets accepts flags only; unexpected positional arguments")
			return 2
		}
		if *secretFiles == "" {
			fmt.Fprintln(os.Stderr, "vectory: configure-secrets requires --secret-files with a nonempty absolute JSON file path; use {} to remove all bindings")
			return 2
		}
		var bindings *map[string]string
		bindings, err = agent.ReadSecretBindings(*secretFiles)
		if err == nil {
			err = agent.ConfigureSecretFiles(*dir, *bindings)
		}
	case "enroll", "recover-enrollment":
		server := fs.String("server", "", "verified HTTPS origin")
		compatServer := fs.String("ip", "", "compatibility server/IP, still verified HTTPS")
		name := fs.String("id", "", "unique machine name")
		ca := fs.String("ca-file", "", "trusted public CA PEM path; omission retains saved trust, --ca-file= selects system trust")
		stdin := fs.Bool("token-stdin", false, "read token from standard input")
		tokenFile := fs.String("token-file", "", "read token from protected local file")
		token := fs.String("token", "", "compatibility token argument (visible in process listings)")
		if fs.Parse(args) != nil {
			return 2
		}
		if fs.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "vectory: enrollment accepts flags only; unexpected positional arguments")
			return 2
		}
		if *server == "" {
			*server = *compatServer
		}
		var caOption *string
		fs.Visit(func(f *flag.Flag) {
			if f.Name == "ca-file" {
				caOption = ca
			}
		})
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
			var f *os.File
			f, err = agent.OpenEnrollmentTokenFile(*tokenFile)
			if err == nil {
				value, err = readToken(f)
				_ = f.Close()
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
			err = agent.EnrollWithOptions(ctx, *dir, agent.EnrollmentOptions{Server: *server, Name: *name, CAFile: caOption, Token: value, Recover: command == "recover-enrollment"})
		}
	case "run", "service":
		once := fs.Bool("once", false, "one reconciliation then stop owned Vector; test only")
		if !parseFlagsOnly(fs, args, command) {
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
		if !parseFlagsOnly(fs, args, command) {
			return 2
		}
		var s map[string]any
		s, err = agent.StateSummary(*dir)
		if err == nil {
			output(s)
		}
	case "doctor":
		if !parseFlagsOnly(fs, args, command) {
			return 2
		}
		var s map[string]any
		s, err = agent.Doctor(ctx, *dir)
		if *jsonOut && err != nil {
			if s == nil {
				s = map[string]any{}
			}
			s["error"] = err.Error()
			output(s)
			return 1
		}
		output(s)
	case "pause", "resume":
		if !parseFlagsOnly(fs, args, command) {
			return 2
		}
		err = agent.SetPause(*dir, command == "pause")
		if err == nil && command == "resume" {
			fmt.Fprintln(os.Stderr, "Local pause removed. Managed manual edits will be replaced when the latest authorized state is reconciled; remote pause still applies.")
		}
	case "retry":
		if !parseFlagsOnly(fs, args, command) {
			return 2
		}
		err = agent.Retry(*dir)
	case "unenroll":
		if !parseFlagsOnly(fs, args, command) {
			return 2
		}
		err = agent.Unenroll(*dir)
		if err == nil {
			fmt.Fprintln(os.Stderr, "Local credentials removed. Revoke the old device in the dashboard; prior server authorization cannot be revoked offline.")
		}
	case "uninstall":
		purge := fs.Bool("purge", false, "delete this exact state directory after service removal")
		if !parseFlagsOnly(fs, args, command) {
			return 2
		}
		if *purge {
			if !flagSupplied(fs, "state-dir") {
				fmt.Fprintln(os.Stderr, "vectory: uninstall --purge requires an explicit --state-dir")
				return 2
			}
			err = agent.PurgeState(*dir)
		} else {
			var unlock func()
			unlock, err = agent.Lock(*dir)
			if err == nil {
				unlock()
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
func parseFlagsOnly(fs *flag.FlagSet, args []string, command string) bool {
	if fs.Parse(args) != nil {
		return false
	}
	if fs.NArg() != 0 {
		fmt.Fprintf(os.Stderr, "vectory: %s accepts flags only; unexpected positional arguments\n", command)
		return false
	}
	return true
}
func flagSupplied(fs *flag.FlagSet, name string) bool {
	found := false
	fs.Visit(func(option *flag.Flag) { found = found || option.Name == name })
	return found
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

func metricsOptionUsage(fs *flag.FlagSet, clear, required bool) error {
	urlSupplied, clearSupplied := false, false
	fs.Visit(func(f *flag.Flag) {
		urlSupplied = urlSupplied || f.Name == "metrics-url"
		clearSupplied = clearSupplied || f.Name == "clear-metrics-url"
	})
	if clearSupplied && (!clear || urlSupplied) || required && !urlSupplied && !clearSupplied {
		return errors.New("choose exactly one of --metrics-url URL or --clear-metrics-url; omit --clear-metrics-url instead of setting it false")
	}
	return nil
}

func reportMetricsConfiguration(command string, cleared, jsonOut bool) {
	next := "Start or restart the agent through its intended supervisor to use this setting. The pipeline and exporter are unchanged."
	if jsonOut {
		output(map[string]any{"command": command, "status": "ok", "metrics_collection_configured": !cleared, "next_action": next})
		return
	}
	if cleared {
		fmt.Println("Metrics collection setting cleared.", next)
	} else {
		fmt.Println("Metrics endpoint setting saved.", next)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `Vectory agent - explicitly adopted Vector 0.58.0
Commands: install re-adopt configure-secrets configure-metrics enroll recover-enrollment run service status doctor pause resume retry unenroll uninstall version
Native service commands: service-install [--service-user <account>], service-start, service-stop, service-uninstall
Common: --state-dir <absolute path> --json
Service start/stop/uninstall target the fixed service; --state-dir does not select one. Commands accept flags only.
State purge: uninstall --purge --state-dir <exact installed state directory> (agent stopped).
Install: --vector-binary <absolute path> --managed-config <absolute .json> --adopt
Re-adopt while stopped: --expected-sha256 <trusted candidate SHA256> [--vector-binary <absolute replacement path>]
Optional local trust grant: install --allow-full-vector-config (existing agent must be stopped)
Return to restricted mode locally: install --allow-full-vector-config=false
Metrics while stopped: configure-metrics --metrics-url http://127.0.0.1:9598/metrics | --clear-metrics-url
Install also accepts --metrics-url or --clear-metrics-url; omission preserves the setting.
Enroll: --server https://host:8443 --id edge-01 --token-stdin [--ca-file <trusted PEM>]
CA trust: omission retains saved trust; --ca-file= explicitly selects system trust.
Compatibility: vectory -ip <server> -id <name> -token <token> [--state-dir <path>]
TLS verification is mandatory. No Vector installation, upgrade, or arbitrary remote command feature.
Exit codes: 0 success; 1 operation/preflight failed; 2 invalid command or options.`)
}
