//go:build windows

package agent

import "errors"

func mkfifo(path string) error { return errors.New("Windows has no named pipes in the file system") }
