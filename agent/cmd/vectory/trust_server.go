package main

import (
	"fmt"

	"github.com/vectory/vectory/agent/internal/agent"
)

func defineTrustServer(c *cli) func() int {
	c.StateDir()
	server := c.String("server", "", "URL", "The exact server address saved when this host enrolled")
	pin := c.String("ca-sha256", "", "HEX", "New CA fingerprint obtained separately from a trusted source")
	caFile := c.String("ca-file", "", "PATH", "New PEM CA file; use --ca-file= to explicitly select system roots")
	c.JSON("Print one JSON document")
	return func() int {
		if *server == "" || c.supplied("ca-sha256") == c.supplied("ca-file") || c.supplied("ca-sha256") && *pin == "" {
			fmt.Fprintln(c.stderr, "vectory trust-server: require --server and exactly one of --ca-sha256 HEX or --ca-file PATH (use --ca-file= for system roots)")
			return exitUsage
		}
		choice := agent.TrustServerOptions{Server: *server, CASHA256: *pin}
		if c.supplied("ca-file") {
			value := *caFile
			if value != "" {
				resolved, ok := c.resolvePath("ca-file", value)
				if !ok {
					return exitUsage
				}
				value = resolved
			}
			choice.CAFile = &value
		}
		ctx, stop := interruptible()
		defer stop()
		result, err := agent.TrustServer(ctx, *c.state, choice)
		if err != nil {
			return c.fail(err)
		}
		if *c.json {
			c.output(map[string]any{"status": "ok", "command": "trust-server", "server": result.Server, "trust": result.Trust})
		} else {
			fmt.Fprintf(c.stdout, "Verified %s against %s and saved this host's server trust. Start the agent, then run `vectory doctor` to check its connection.\n", result.Trust, result.Server)
		}
		return exitOK
	}
}
