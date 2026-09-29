//go:build !windows

package agent

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func adoptionLocalPath(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("local maintenance requires absolute local paths")
	}
	return nil
}

func preserveSettingsSecurity(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() {
		return errors.New("cannot preserve settings ownership")
	}
	if info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return errors.New("unexpected privileged settings mode; preserve and review local metadata before maintenance")
	}
	if err = os.Chown(destination, int(stat.Uid), int(stat.Gid)); err != nil {
		return err
	}
	if err = os.Chmod(destination, info.Mode().Perm()); err != nil {
		return err
	}
	if err = preserveExtendedSettingsSecurity(source, destination); err != nil {
		return err
	}
	for _, path := range []string{source, destination} {
		current, err := os.Lstat(path)
		if err != nil {
			return err
		}
		owner, ok := current.Sys().(*syscall.Stat_t)
		if !ok || owner.Uid != stat.Uid || owner.Gid != stat.Gid || current.Mode().Perm() != info.Mode().Perm() {
			return errors.New("settings ownership or mode changed during access-metadata preservation")
		}
	}
	return nil
}
