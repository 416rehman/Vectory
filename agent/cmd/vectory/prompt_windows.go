//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"
)

// promptSecret reads a hidden value from the console, even when standard
// input is redirected.
func promptSecret(label string) (string, error) {
	console, err := os.OpenFile("CONIN$", os.O_RDWR, 0)
	if err != nil {
		return "", errors.New("no console to ask for the token; use --token-file PATH or --token-stdin")
	}
	defer console.Close()
	fmt.Fprint(os.Stderr, label)
	value, err := term.ReadPassword(int(console.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", errors.New("couldn't read the token from the console")
	}
	return strings.TrimSpace(string(value)), nil
}
