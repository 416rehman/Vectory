package agent

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// The path check trusts root and nothing else, and the update paths are the
// system's. Two variables let a test build a tree it owns and point the update
// code at it: rootOwnedTrust and updateLocationsOverride. Two more let a test
// shorten the bounds of a transfer of an agent build, five minutes and twenty
// seconds without a byte: updateDownloadDeadline and updateDownloadStall. The
// privileged step adds four: the service manager and the host's service files
// (updateHostOverride), the clock (updateClockOverride), the point a test
// stops the step at (updateFault) and the table of the operating systems whose
// updates the build ships (updateGateOverride). They are declared in code that ships and
// assigned only in test files, so the agent that ships has no way to relax the
// check or the bounds. TestProductionAgentContainsNoTestHooks, in cmd/vectory,
// keeps the same promise for the older seams and for these.
func TestTheUpdateSeamsAreAssignedOnlyByTests(t *testing.T) {
	seams := map[string]bool{
		"rootOwnedTrust": true, "updateLocationsOverride": true, "updateDownloadDeadline": true, "updateDownloadStall": true,
		"updateHostOverride": true, "updateClockOverride": true, "updateFault": true, "updateGateOverride": true,
	}
	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no source to check: %v", err)
	}
	fset := token.NewFileSet()
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch n := node.(type) {
			case *ast.AssignStmt:
				for _, left := range n.Lhs {
					if name := seamName(left); seams[name] {
						t.Errorf("%s assigns the test seam %s", fset.Position(n.Pos()), name)
					}
				}
			case *ast.UnaryExpr:
				// Taking the address would let anything assign it.
				if n.Op == token.AND && seams[seamName(n.X)] {
					t.Errorf("%s takes the address of the test seam %s", fset.Position(n.Pos()), seamName(n.X))
				}
			case *ast.IncDecStmt:
				if seams[seamName(n.X)] {
					t.Errorf("%s changes the test seam %s", fset.Position(n.Pos()), seamName(n.X))
				}
			}
			return true
		})
	}
}

// seamName is the identifier an expression names, through a selector or a
// parenthesis, or "".
func seamName(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		if root := seamName(e.X); root != "" {
			return root
		}
		return e.Sel.Name
	case *ast.ParenExpr:
		return seamName(e.X)
	case *ast.IndexExpr:
		return seamName(e.X)
	}
	return ""
}
