package main

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The hooks the crash, proxy and disk tests use to stop the agent at a stage,
// start it as a stand-in for Vector, or make the disk fill up live in test
// files. The binary that ships has none of them: it reads no hook from its
// environment, and no production code sets the engine's fault hook or the
// seam that lets a test fill the disk.
func TestProductionAgentContainsNoTestHooks(t *testing.T) {
	name := "vectory"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(t.TempDir(), name)
	build := exec.Command("go", "build", "-o", binary, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	content, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"VECTORY_TEST_", "VECTOR_TEST_", "vectory-stand-in", "fake-vector.json"} {
		if bytes.Contains(content, []byte(marker)) {
			t.Errorf("the built agent contains %q", marker)
		}
	}

	// And in the source: nothing outside a test file assigns a hook.
	seams := map[string]bool{
		"Fault": true, "createAtomicTemp": true,
		"rootOwnedTrust": true, "updateLocationsOverride": true,
		"updateHostOverride": true, "updateClockOverride": true, "updateFault": true,
	}
	files, err := filepath.Glob(filepath.Join("..", "..", "internal", "agent", "*.go"))
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
					switch l := left.(type) {
					case *ast.SelectorExpr:
						if seams[l.Sel.Name] {
							t.Errorf("%s assigns the test hook %s", fset.Position(n.Pos()), l.Sel.Name)
						}
					case *ast.Ident:
						if seams[l.Name] {
							t.Errorf("%s assigns the test seam %s", fset.Position(n.Pos()), l.Name)
						}
					}
				}
			case *ast.KeyValueExpr:
				if key, ok := n.Key.(*ast.Ident); ok && seams[key.Name] {
					t.Errorf("%s sets the test hook %s", fset.Position(n.Pos()), key.Name)
				}
			}
			return true
		})
	}
}
