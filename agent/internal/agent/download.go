package agent

import (
	"errors"
	"fmt"
	"strings"
)

// downloadFailure is a configuration that did not arrive whole and verified,
// or arrived and could not be kept. It says what happened in the words the
// device page shows, with the fix, and it never leaves anything half written:
// the download is held in memory until its size and SHA-256 match the signed
// manifest, and only then written.
type downloadFailure struct {
	// code is the issue code: DOWNLOAD_FAILED, DIGEST_MISMATCH or WRITE_FAILED.
	code        string
	message     string
	diagnostics []Diagnostic
}

func (f *downloadFailure) Error() string { return f.message }

// downloadAgain ends every download hint: the retry needs nothing from anyone.
const downloadAgain = "Nothing was applied. The agent tries again at its next check-in."

// downloadFinding is one diagnostic about a download. The texts carry no path
// and no value from the device.
func downloadFinding(code, message, hint string) []Diagnostic {
	return []Diagnostic{newRedactor().finalize(Diagnostic{Code: code, Message: message, Hint: hint})}
}

// classifyDownload explains a failed request for the configuration.
func classifyDownload(err error) *downloadFailure {
	var interrupted *bodyInterrupted
	switch ce, connection := AsConnectionError(err); {
	case connection:
		hint := downloadAgain
		// A connection error's fix may tell a person to run a command again;
		// nobody runs anything here, the agent just tries again.
		if fix := ce.Fix; fix != "" && !strings.HasPrefix(fix, "Run the same command again") {
			hint += " " + fix
		}
		return &downloadFailure{code: "DOWNLOAD_FAILED", message: "Cannot download the configuration", diagnostics: downloadFinding(ce.Code, ce.Message, hint)}
	case errors.As(err, &interrupted):
		message := "The server closed the connection before the whole configuration arrived."
		if interrupted.timedOut() {
			message = "The server stopped sending the configuration before it was complete."
		}
		return &downloadFailure{code: "DOWNLOAD_FAILED", message: "The download was cut off before the whole configuration arrived", diagnostics: downloadFinding("DOWNLOAD_INTERRUPTED", message, downloadAgain+" If it keeps happening, look for a proxy or firewall that cuts long responses.")}
	case errors.Is(err, errResponseTooLarge):
		return &downloadFailure{code: "DOWNLOAD_FAILED", message: "The configuration is larger than agents accept", diagnostics: downloadFinding("DOWNLOAD_TOO_LARGE", fmt.Sprintf("The server sent more than the %d KiB a configuration may have.", MaxArtifact/1024), "Nothing was applied. Publish a smaller version.")}
	}
	return &downloadFailure{code: "DOWNLOAD_FAILED", message: "Cannot obtain a digest-verified authorized template"}
}

// mismatchFailure is a download whose bytes are not the ones the signed
// manifest names.
func mismatchFailure(got int, want int64, sizeOK bool) *downloadFailure {
	message := "The SHA-256 of the configuration does not match the signed manifest."
	if !sizeOK {
		message = fmt.Sprintf("The configuration arrived with %d bytes; the signed manifest says %d.", got, want)
	}
	return &downloadFailure{code: "DIGEST_MISMATCH", message: "The downloaded configuration doesn't match its signed size and digest", diagnostics: downloadFinding("ARTIFACT_MISMATCH", message, downloadAgain+" If it keeps failing, something between the server and this device may be altering downloads.")}
}
