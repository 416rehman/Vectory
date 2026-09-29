//go:build windows

package agent

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"path/filepath"
	"strings"
)

func adoptionLocalPath(path string) error {
	if !filepath.IsAbs(path) || strings.HasPrefix(path, `\\`) || len(filepath.VolumeName(path)) != 2 || strings.Contains(path[2:], ":") {
		return errors.New("local maintenance requires local drive paths; UNC and device paths are unsupported")
	}
	return nil
}

func preserveSettingsSecurity(source, destination string) error {
	// These access-policy portions require READ_CONTROL, not the separate
	// SeSecurityPrivilege used for auditing SACLs. Preserve mandatory integrity
	// labels and resource/central-policy attributes alongside discretionary ACLs.
	parts := windows.SECURITY_INFORMATION(windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION | windows.LABEL_SECURITY_INFORMATION | windows.ATTRIBUTE_SECURITY_INFORMATION | windows.SCOPE_SECURITY_INFORMATION)
	sd, err := windows.GetNamedSecurityInfo(source, windows.SE_FILE_OBJECT, parts)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	group, _, err := sd.Group()
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	sacl, _, err := sd.SACL()
	if err != nil && !errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
		return fmt.Errorf("read access SACL: %w", err)
	}
	control, _, err := sd.Control()
	if err != nil {
		return err
	}
	flags := windows.SECURITY_INFORMATION(windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION)
	for _, part := range []windows.SECURITY_INFORMATION{windows.LABEL_SECURITY_INFORMATION, windows.ATTRIBUTE_SECURITY_INFORMATION, windows.SCOPE_SECURITY_INFORMATION} {
		// Setting an absent scoped-policy flag unnecessarily requires elevated
		// privilege. Apply a part only when source or destination contains it.
		sourcePart, e := windows.GetNamedSecurityInfo(source, windows.SE_FILE_OBJECT, part)
		if e != nil {
			return e
		}
		destinationPart, e := windows.GetNamedSecurityInfo(destination, windows.SE_FILE_OBJECT, part)
		if e != nil {
			return e
		}
		has := func(value *windows.SECURITY_DESCRIPTOR) bool {
			acl, _, err := value.SACL()
			return err == nil && acl != nil && acl.AceCount != 0
		}
		if has(sourcePart) || has(destinationPart) {
			flags |= part
		}
	}
	if control&windows.SE_DACL_PROTECTED != 0 {
		flags |= windows.PROTECTED_DACL_SECURITY_INFORMATION
	} else {
		flags |= windows.UNPROTECTED_DACL_SECURITY_INFORMATION
	}
	if err = windows.SetNamedSecurityInfo(destination, windows.SE_FILE_OBJECT, flags, owner, group, acl, sacl); err != nil {
		return fmt.Errorf("apply access descriptor: %w", err)
	}
	actual, err := windows.GetNamedSecurityInfo(destination, windows.SE_FILE_OBJECT, parts)
	if err != nil {
		return err
	}
	current, err := windows.GetNamedSecurityInfo(source, windows.SE_FILE_OBJECT, parts)
	if err != nil {
		return err
	}
	wantedText, actualText, currentText := sd.String(), actual.String(), current.String()
	if wantedText == "" || actualText == "" || currentText == "" || wantedText != actualText || wantedText != currentText {
		return errors.New("settings access descriptor could not be preserved exactly")
	}
	return nil
}
