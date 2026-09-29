//go:build windows

package agent

import "path/filepath"

// Windows keeps its existing behavior: SafePath refuses reparse points, so
// nothing is followed here.
func resolveLinks(path string, anyOwner bool) (string, bool, error) {
	return filepath.Clean(path), false, nil
}
