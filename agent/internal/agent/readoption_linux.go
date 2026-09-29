//go:build linux

package agent

func preserveExtendedSettingsSecurity(source, destination string) error {
	return copySettingsXattrs(source, destination)
}
