//go:build !windows

package agent

import "context"

// runUpdateService is the step as a service the operating system started this
// process as. Only Windows has one: the step's timer starts a unit that makes one
// run everywhere else.
func runUpdateService(ctx context.Context, dir string) (bool, error) { return false, nil }
