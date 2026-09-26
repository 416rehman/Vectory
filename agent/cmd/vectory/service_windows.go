//go:build windows

package main

import (
	"context"
	"github.com/vectory/vectory/agent/internal/agent"
	"golang.org/x/sys/windows/svc"
	"os"
)

func terminationSignals() []os.Signal { return []os.Signal{os.Interrupt} }

type handler struct {
	dir    string
	report func(string)
}

func (h handler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- agent.Run(ctx, h.dir, false, h.report) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			if err != nil {
				return true, 1
			}
			return false, 0
		case r := <-requests:
			switch r.Cmd {
			case svc.Interrogate:
				status <- r.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		}
	}
}
func service(ctx context.Context, dir string, report func(string)) error {
	is, e := svc.IsWindowsService()
	if e != nil {
		return e
	}
	if !is {
		return agent.Run(ctx, dir, false, report)
	}
	return svc.Run("Vectory", handler{dir, report})
}
