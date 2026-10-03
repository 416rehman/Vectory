//go:build !windows && !darwin

package agent

// accessListProblem is "" off macOS. A Linux file system that keeps an access list
// shows it in the permission bits: once a list names an account, the group bits of
// st_mode are its mask, the most that any entry besides the owning account's grants, so an
// account that can write already shows as a mode the check refuses
// (rootpath_posixacl_linux_test.go). Another Unix has no list the check doesn't see.
func accessListProblem(fd int, directory bool) (string, error) { return "", nil }
