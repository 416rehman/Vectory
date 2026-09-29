//go:build !windows && !linux && !darwin

package agent

import "errors"

func preserveExtendedSettingsSecurity(source, destination string) error {
	return errors.New("settings access-metadata preservation is unavailable on this platform")
}
