package agent

import (
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
)

// checkInstallerCandidate binds a read-only installer preflight to the exact
// staged build and destination. The installer still rehashes immediately before
// its atomic rename; this check prevents accidentally testing a different file
// or an unrelated directory's service-account access.
func checkInstallerCandidate(candidate, target, running string, explicitTarget bool) error {
	if !explicitTarget || !filepath.IsAbs(candidate) || !filepath.IsAbs(target) {
		return errors.New("installer preflight requires an absolute staged candidate and --agent-path")
	}
	if err := regularPath(candidate); err != nil {
		return fmt.Errorf("staged agent must be a regular local file without symlinks: %w", err)
	}
	same := func(a, b string) bool { return filepath.Clean(a) == filepath.Clean(b) }
	if runtime.GOOS == "windows" {
		same = func(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }
	}
	if !same(filepath.Dir(candidate), filepath.Dir(target)) || same(candidate, target) {
		return errors.New("staged agent must be a separate file beside --agent-path")
	}
	stagedDigest, err := FileDigest(candidate)
	if err != nil {
		return fmt.Errorf("cannot hash staged agent: %w", err)
	}
	runningDigest, err := FileDigest(running)
	if err != nil {
		return fmt.Errorf("cannot hash preflight agent: %w", err)
	}
	if stagedDigest != runningDigest {
		return errors.New("staged agent differs from the verified build running preflight")
	}
	return nil
}
