//go:build windows

package agent

import (
	"context"
	"os"

	"golang.org/x/sys/windows"
)

// Elevated reports whether this process can install system files and services.
func Elevated() bool { return windows.GetCurrentProcessToken().IsElevated() }

// writableLocation defers to the operation's own access checks on Windows.
func writableLocation(path string) bool { return true }

const elevationHint = "Run it from an elevated PowerShell (Run as administrator): setup installs the agent and registers a Windows service that runs as NT SERVICE\\Vectory."

func binaryMode() os.FileMode { return 0755 }

// ownerSuffix is omitted on Windows, where access is governed by ACLs.
func ownerSuffix(info os.FileInfo) string { return "" }

// accountAccessProblem is empty on Windows: the virtual service account can
// run programs from Program Files, and ACLs there are the operator's choice.
func accountAccessProblem(ctx context.Context, account, path string, read bool, args ...string) string {
	return ""
}
