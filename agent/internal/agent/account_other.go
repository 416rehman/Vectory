//go:build !linux && !darwin

package agent

import (
	"context"
	"errors"
)

// CreateServiceAccount isn't needed on Windows: the service runs as the
// dedicated NT SERVICE\Vectory virtual account.
func CreateServiceAccount(ctx context.Context, name string) error {
	return errors.New("creating service accounts isn't supported on this platform")
}
