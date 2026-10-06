//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"
)

// promptSecret reads a hidden value from the controlling terminal, so it works
// even when standard input is a pipe (curl ... | sudo sh).
func promptSecret(label string) (string, error) {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return "", errors.New("no terminal to ask for the token; use --token-file PATH or --token-stdin")
	}
	defer tty.Close()
	if !term.IsTerminal(int(tty.Fd())) {
		return "", errors.New("no terminal to ask for the token; use --token-file PATH or --token-stdin")
	}
	fmt.Fprint(tty, label)
	value, err := term.ReadPassword(int(tty.Fd()))
	fmt.Fprintln(tty)
	if err != nil {
		return "", errors.New("couldn't read the token from the terminal")
	}
	return strings.TrimSpace(string(value)), nil
}
