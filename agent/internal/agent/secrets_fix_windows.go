//go:build windows

package agent

import "golang.org/x/sys/windows"

// privateFileFix is the exact command that makes a file private to this
// agent account, for local error messages only.
func privateFileFix(path string) string {
	sid := "<agent account SID>"
	if token, err := windows.OpenCurrentProcessToken(); err == nil {
		if user, err := token.GetTokenUser(); err == nil {
			sid = user.User.Sid.String()
		}
		token.Close()
	}
	return `run as Administrator: icacls "` + path + `" /setowner *S-1-5-32-544 && icacls "` + path + `" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F *` + sid + `:F (use the file's full path, without 8.3 short names, links or junctions)`
}
