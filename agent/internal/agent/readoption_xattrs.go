//go:build linux || darwin

package agent

import (
	"bytes"
	"errors"
	"golang.org/x/sys/unix"
	"reflect"
	"strings"
)

// Access ACLs and labels are xattrs on Linux. Preserve all bounded attributes,
// including ACLs, rather than guessing which can affect service access.
func settingsXattrs(path string) (map[string][]byte, error) {
	size, err := unix.Listxattr(path, nil)
	if errors.Is(err, unix.ENOTSUP) {
		return map[string][]byte{}, nil
	}
	if err != nil {
		return nil, err
	}
	if size < 0 || size > 65536 {
		return nil, errors.New("settings attributes exceed safe limit")
	}
	names := make([]byte, size)
	n, err := unix.Listxattr(path, names)
	if err != nil || n > len(names) {
		return nil, errors.New("settings attributes changed while reading")
	}
	result := map[string][]byte{}
	total := 0
	for _, name := range strings.Split(string(names[:n]), "\x00") {
		if name == "" {
			continue
		}
		size, err := unix.Getxattr(path, name, nil)
		if err != nil {
			return nil, err
		}
		total += size
		if size < 0 || size > MaxArtifact || total > 2*MaxArtifact {
			return nil, errors.New("settings attributes exceed safe limit")
		}
		value := make([]byte, size)
		n, err := unix.Getxattr(path, name, value)
		if err != nil || n != size {
			return nil, errors.New("settings attributes changed while reading")
		}
		result[name] = value
	}
	return result, nil
}

func copySettingsXattrs(source, destination string) error {
	wanted, err := settingsXattrs(source)
	if err != nil {
		return err
	}
	existing, err := settingsXattrs(destination)
	if err != nil {
		return err
	}
	for name := range existing {
		if _, ok := wanted[name]; !ok {
			if err = unix.Removexattr(destination, name); err != nil {
				return err
			}
		}
	}
	for name, value := range wanted {
		if current, exists := existing[name]; exists && bytes.Equal(current, value) {
			continue
		}
		if err = unix.Setxattr(destination, name, value, 0); err != nil {
			return err
		}
	}
	actual, err := settingsXattrs(destination)
	if err != nil {
		return err
	}
	current, err := settingsXattrs(source)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(wanted, actual) || !reflect.DeepEqual(wanted, current) {
		return errors.New("settings access attributes could not be preserved exactly")
	}
	return nil
}
