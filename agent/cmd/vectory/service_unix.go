//go:build !windows

package main

import (
	"context"
	"github.com/vectory/vectory/agent/internal/agent"
	"os"
	"syscall"
)

func terminationSignals() []os.Signal { return []os.Signal{os.Interrupt, syscall.SIGTERM} }

func service(ctx context.Context, dir string, report func(string)) error {
	return agent.Run(ctx, dir, false, report)
}
