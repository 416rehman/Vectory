package agent

import (
	"path/filepath"
	"strings"
)

// What a package manager owns, as every operating system's host sees it.

// packageDirectories hold what a package manager installs: an agent that lives in
// one of them belongs to the package, and an update behind its back would be undone
// by the next upgrade or reported as a modified file. /opt/homebrew and
// /usr/local/Cellar are Homebrew's.
var packageDirectories = []string{"/usr/bin", "/usr/sbin", "/bin", "/sbin", "/usr/lib", "/opt/homebrew", "/usr/local/Cellar"}

// packageCandidates are the paths an executable can be known by: the one it was
// asked for, and the file a link at it leads to.
func packageCandidates(executable string) []string {
	candidates := []string{executable}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil && resolved != executable {
		candidates = append(candidates, resolved)
	}
	return candidates
}

// underPackageDirectory says whether any of the candidates is in one of the
// package directories, and which.
func underPackageDirectory(candidates []string) (directory string, managed bool) {
	for _, candidate := range candidates {
		for _, directory := range packageDirectories {
			if candidate == directory || strings.HasPrefix(candidate, directory+"/") {
				return directory, true
			}
		}
	}
	return "", false
}
