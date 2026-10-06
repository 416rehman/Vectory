package agent

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

// drainAgentEnv names the state directory of a stand-in agent process: the
// test binary re-executed to own a real Vector the way `vectory run` does,
// so tests can signal it like a terminal or a service manager would.
const drainAgentEnv = "VECTORY_TEST_DRAIN_AGENT"

func drainAgentMain(dir string) int {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	digest, err := FileDigest(binary)
	if err != nil {
		fmt.Println("error:", err)
		return 1
	}
	driver := &VectorDriver{Dir: dir, Settings: Settings{Adopted: true, VectorBinary: binary, VectorBinarySHA256: digest, StartupSeconds: 20, GracefulShutdownSeconds: minGracefulShutdownSeconds}}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err = driver.Activate(ctx, filepath.Join(dir, "managed.json")); err != nil {
		fmt.Println("error:", err)
		return 1
	}
	fmt.Println("ready", driver.child.Process.Pid)
	<-ctx.Done()
	if err = driver.Stop(); err != nil {
		fmt.Println("error:", err)
		return 1
	}
	return 0
}
