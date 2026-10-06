package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Advisory locking spans separate containers that share the same volume. The
// kernel releases the lock after a crash, without replacing persisted trust.
func certificateLock(dir string) (func(), error) {
	fd, err := syscall.Open(filepath.Join(dir, ".certificate-lock"), syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), "certificate operation lock")
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("certificate lock must be a regular file")
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { syscall.Flock(fd, syscall.LOCK_UN); file.Close() }, nil
		}
		if (err != syscall.EWOULDBLOCK && err != syscall.EAGAIN) || !time.Now().Before(deadline) {
			file.Close()
			return nil, fmt.Errorf("another certificate maintenance operation is in progress")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
