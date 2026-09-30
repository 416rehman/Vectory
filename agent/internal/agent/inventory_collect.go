package agent

import (
	"context"
	"io"
	"os"
)

// collectStartups reads how each of the running Vector processes was started.
// The reading itself (collectStartup) is each platform's own.
func collectStartups(ctx context.Context, running []RunningVector) []VectorStartup {
	out := make([]VectorStartup, 0, len(running))
	for _, process := range running {
		out = append(out, collectStartup(ctx, process))
	}
	return out
}

// readLimited reads at most limit bytes of a file.
func readLimited(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, limit))
}
