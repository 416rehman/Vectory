//go:build !windows

package main

import (
	"context"
	"github.com/vectory/vectory/agent/internal/agent"
	"os"
	"os/signal"
	"syscall"
)

// terminationSignals stop a command cleanly. Closing the terminal hangs up a
// foreground agent: it saves its state and drains Vector as on Ctrl-C. A
// SIGHUP that is ignored (nohup) stays ignored.
func terminationSignals() []os.Signal {
	signals := []os.Signal{os.Interrupt, syscall.SIGTERM}
	if !signal.Ignored(syscall.SIGHUP) {
		signals = append(signals, syscall.SIGHUP)
	}
	return signals
}

func service(ctx context.Context, dir string, report func(string)) error {
	return agent.Run(ctx, dir, false, report)
}
