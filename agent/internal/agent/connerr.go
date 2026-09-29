package agent

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Delivery tells whether a failed request could have reached the server.
type Delivery int

const (
	// NotSent: no request byte left this host. The address, DNS, TCP, proxy or
	// TLS verification failed first, so the server cannot have acted on it.
	NotSent Delivery = iota
	// MaybeSent: request bytes may have reached the server before the failure.
	MaybeSent
	// Answered: the server answered with an HTTP status.
	Answered
)

// ConnectionError is a classified failure with a concrete next step. Every
// field is safe to print: none carries a token, credential or proxy password.
type ConnectionError struct {
	Code       string
	Message    string
	Fix        string
	Delivery   Delivery
	Status     int
	ServerCode string
	RetryAfter time.Duration
	cause      error
}

func (e *ConnectionError) Error() string {
	if e.Fix == "" {
		return e.Message
	}
	return e.Message + " " + e.Fix
}

func (e *ConnectionError) Unwrap() error { return e.cause }

// AsConnectionError returns the classified failure inside err, if any.
func AsConnectionError(err error) (*ConnectionError, bool) {
	var ce *ConnectionError
	ok := errors.As(err, &ce)
	return ce, ok
}

func hostPort(target *url.URL) string {
	port := target.Port()
	if port == "" {
		port = "443"
	}
	return net.JoinHostPort(target.Hostname(), port)
}

// Fingerprint formats a SHA-256 digest as colon-separated uppercase hex.
func Fingerprint(sum []byte) string {
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = strings.ToUpper(hex.EncodeToString([]byte{b}))
	}
	return strings.Join(parts, ":")
}

// ShortFingerprint keeps the first and last two bytes for visual comparison.
// It is deliberately too short to paste as a pin.
func ShortFingerprint(sum []byte) string {
	full := Fingerprint(sum)
	if len(sum) < 6 {
		return full
	}
	return full[:5] + ":...:" + full[len(full)-5:]
}

func certificateSHA256(c *x509.Certificate) []byte {
	sum := sha256.Sum256(c.Raw)
	return sum[:]
}

func certificateName(c *x509.Certificate) string {
	switch {
	case c == nil:
		return "an unknown issuer"
	case c.Subject.CommonName != "":
		return c.Subject.CommonName
	case len(c.Subject.Organization) > 0:
		return c.Subject.Organization[0]
	default:
		return "an unnamed certificate"
	}
}

func issuerName(c *x509.Certificate) string {
	switch {
	case c.Issuer.CommonName != "":
		return c.Issuer.CommonName
	case len(c.Issuer.Organization) > 0:
		return c.Issuer.Organization[0]
	default:
		return "an unnamed authority"
	}
}

func certificateNames(c *x509.Certificate) string {
	names := append([]string{}, c.DNSNames...)
	for _, ip := range c.IPAddresses {
		names = append(names, ip.String())
	}
	if len(names) == 0 && c.Subject.CommonName != "" {
		names = append(names, c.Subject.CommonName)
	}
	if len(names) > 4 {
		names = append(names[:4], fmt.Sprintf("and %d more", len(names)-4))
	}
	if len(names) == 0 {
		return "no host names"
	}
	return strings.Join(names, ", ")
}

func listenerHint(target *url.URL) string {
	if target.Port() == "8443" {
		return "Check that the Vectory server is running and that this host can reach it."
	}
	return "Check the address and port; the agent listener usually uses port 8443."
}

// classifyCertificate explains a certificate verification failure. presented
// is the chain the server sent, when known.
func classifyCertificate(target *url.URL, err error, presented []*x509.Certificate) *ConnectionError {
	var (
		unknown  x509.UnknownAuthorityError
		hostname x509.HostnameError
		invalid  x509.CertificateInvalidError
	)
	e := &ConnectionError{Delivery: NotSent, cause: err}
	switch {
	case errors.As(err, &unknown):
		e.Code = "TLS_UNKNOWN_AUTHORITY"
		issuer := "an unknown authority"
		if len(presented) > 0 {
			issuer = fmt.Sprintf("%q", issuerName(presented[0]))
		} else if unknown.Cert != nil {
			issuer = fmt.Sprintf("%q", issuerName(unknown.Cert))
		}
		e.Message = fmt.Sprintf("The server's certificate is issued by %s, which this host doesn't trust.", issuer)
		e.Fix = "Copy the command from Add device in the dashboard: it pins the server's CA with --ca-sha256. Or pass --ca-file with your CA certificate."
		if len(presented) > 0 {
			e.Fix += fmt.Sprintf(" (The certificate this host received has SHA-256 %s; compare it with Add device.)", ShortFingerprint(certificateSHA256(presented[len(presented)-1])))
		}
	case errors.As(err, &hostname):
		e.Code = "TLS_HOSTNAME_MISMATCH"
		e.Message = fmt.Sprintf("The server's certificate is valid for %s, not %q.", certificateNames(hostname.Certificate), target.Hostname())
		e.Fix = "Use one of those names in --server, or reissue the certificate for this name."
	case errors.As(err, &invalid) && invalid.Reason == x509.Expired:
		e.Code = "TLS_CERTIFICATE_TIME"
		now := time.Now().UTC().Format("2006-01-02 15:04 UTC")
		c := invalid.Cert
		if c != nil && time.Now().Before(c.NotBefore) {
			e.Message = fmt.Sprintf("The server's certificate %q isn't valid until %s, and this host's clock says %s.", certificateName(c), c.NotBefore.UTC().Format("2006-01-02 15:04 UTC"), now)
			e.Fix = "Fix this host's clock (for example, enable NTP)."
		} else if c != nil {
			e.Message = fmt.Sprintf("The server's certificate %q expired on %s (this host's clock says %s).", certificateName(c), c.NotAfter.UTC().Format("2006-01-02 15:04 UTC"), now)
			e.Fix = "Renew the server certificate, or fix this host's clock if it is wrong."
		} else {
			e.Message = "The server's certificate is outside its validity period."
			e.Fix = "Check the server certificate and this host's clock."
		}
	default:
		e.Code = "TLS_VERIFICATION_FAILED"
		e.Message = "The server's certificate couldn't be verified."
		e.Fix = "Check the certificate chain configured for the agent listener."
	}
	return e
}

// classifyTransport explains an error returned before any HTTP status. wrote
// reports whether request bytes may have been written to the connection.
func classifyTransport(target *url.URL, proxy *url.URL, wrote bool, err error) *ConnectionError {
	if ce, ok := AsConnectionError(err); ok {
		return ce
	}
	address := hostPort(target)
	e := &ConnectionError{Delivery: NotSent, cause: err}
	if wrote {
		e.Delivery = MaybeSent
	}
	var (
		verification *tls.CertificateVerificationError
		unknown      x509.UnknownAuthorityError
		hostname     x509.HostnameError
		invalid      x509.CertificateInvalidError
		record       tls.RecordHeaderError
		alert        tls.AlertError
		dns          *net.DNSError
		op           *net.OpError
		timeout      interface{ Timeout() bool }
	)
	proxyAddress := ""
	if proxy != nil {
		proxyAddress = proxy.Host
	}
	switch {
	case errors.Is(err, context.Canceled):
		e.Code, e.Message = "CANCELED", "Stopped before the server answered."
	case errors.As(err, &verification):
		return classifyCertificate(target, verification.Err, verification.UnverifiedCertificates)
	case errors.As(err, &unknown), errors.As(err, &hostname), errors.As(err, &invalid):
		return classifyCertificate(target, err, nil)
	case errors.As(err, &record), strings.Contains(err.Error(), "server gave HTTP response to HTTPS client"):
		// net/http replaces the TLS record error with this text for HTTP replies.
		e.Code = "PLAIN_HTTP"
		if record.RecordHeader == [5]byte{} || strings.HasPrefix(string(record.RecordHeader[:]), "HTTP/") {
			e.Message = fmt.Sprintf("%s answered with plain HTTP, not HTTPS.", address)
			e.Fix = "That looks like the dashboard's HTTP port. Agents connect to the agent listener, usually https://" + net.JoinHostPort(target.Hostname(), "8443") + "."
		} else {
			e.Message = fmt.Sprintf("%s isn't speaking TLS.", address)
			e.Fix = "Point --server at the Vectory agent listener, usually port 8443."
		}
	case errors.As(err, &alert), errors.As(err, &op) && op.Op == "remote error":
		e.Code = "TLS_HANDSHAKE_REJECTED"
		reason := "handshake failure"
		if op != nil && op.Op == "remote error" && op.Err != nil {
			reason = strings.TrimPrefix(op.Err.Error(), "tls: ")
		} else if alert != 0 {
			reason = strings.TrimPrefix(alert.Error(), "tls: ")
		}
		e.Message = fmt.Sprintf("%s rejected the TLS handshake (%s).", address, safeText(reason, 60))
		e.Fix = "Check that --server points to the Vectory agent listener; it requires TLS 1.3."
	case errors.As(err, &op) && op.Op == "proxyconnect":
		e.Code = "PROXY_UNREACHABLE"
		e.Message = fmt.Sprintf("Can't reach the proxy at %s.", proxyAddress)
		e.Fix = "Check HTTPS_PROXY, or add the server to NO_PROXY if it should be reached directly."
	case errors.As(err, &dns):
		e.Code = "DNS"
		name := dns.Name
		if name == "" {
			name = target.Hostname()
		}
		switch {
		case dns.IsNotFound:
			e.Message = fmt.Sprintf("Can't find %s in DNS.", name)
			e.Fix = "Check the host name in --server and this host's DNS settings."
		case dns.IsTimeout:
			e.Message = fmt.Sprintf("The DNS lookup for %s timed out.", name)
			e.Fix = "Check this host's DNS resolver."
		default:
			e.Message = fmt.Sprintf("The DNS lookup for %s failed.", name)
			e.Fix = "Check this host's DNS resolver."
		}
	case errRefused(err):
		e.Code = "CONNECTION_REFUSED"
		e.Message = fmt.Sprintf("Nothing is accepting connections on %s.", address)
		e.Fix = listenerHint(target)
	case errUnreachable(err):
		e.Code = "NO_ROUTE"
		e.Message = fmt.Sprintf("This host has no network route to %s.", address)
		e.Fix = "Check routing and firewalls between this host and the server."
	case errors.As(err, &timeout) && timeout.Timeout():
		e.Code = "TIMEOUT"
		if wrote {
			e.Message = "The server didn't answer in time."
			e.Fix = "Run the same command again; it picks up where it stopped."
		} else {
			e.Message = fmt.Sprintf("Timed out connecting to %s.", address)
			e.Fix = fmt.Sprintf("Check firewalls between this host and the server (outbound TCP %s).", target.Port())
			if target.Port() == "" {
				e.Fix = "Check firewalls between this host and the server (outbound TCP 443)."
			}
		}
	case proxy != nil && !wrote && (errReset(err) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)):
		e.Code = "PROXY_REFUSED"
		e.Message = fmt.Sprintf("The proxy at %s couldn't connect to %s.", proxyAddress, address)
		e.Fix = "Check that the proxy allows this server and that the address is right, or add the server to NO_PROXY."
	case errReset(err):
		e.Code = "CONNECTION_RESET"
		if wrote {
			e.Message = "The connection was reset before the server answered."
			e.Fix = "Run the same command again; it picks up where it stopped."
		} else {
			e.Message = fmt.Sprintf("The connection to %s was reset during setup.", address)
			e.Fix = "A firewall or proxy may be interfering with TLS to this port."
		}
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		e.Code = "CONNECTION_CLOSED"
		if wrote {
			e.Message = "The server closed the connection before answering."
			e.Fix = "Run the same command again; it picks up where it stopped."
		} else {
			e.Message = fmt.Sprintf("%s closed the connection during the TLS handshake.", address)
			e.Fix = "Check that --server points to the Vectory agent listener."
		}
	case proxy != nil && !wrote:
		// A proxy that refuses CONNECT reports only its status text.
		e.Code = "PROXY_REFUSED"
		e.Message = fmt.Sprintf("The proxy at %s refused to connect to %s (%s).", proxyAddress, address, safeText(innerError(err), 80))
		e.Fix = "Allow this server in the proxy, or add it to NO_PROXY."
	default:
		e.Code = "NETWORK"
		e.Message = fmt.Sprintf("Couldn't reach %s (%s).", address, safeText(innerError(err), 160))
		if wrote {
			e.Fix = "Run the same command again; it picks up where it stopped."
		} else {
			e.Fix = "Check the address, network and proxy settings."
		}
	}
	return e
}

func innerError(err error) string {
	var u *url.Error
	if errors.As(err, &u) && u.Err != nil {
		return u.Err.Error()
	}
	return err.Error()
}

var unsafeText = regexp.MustCompile(`[^\x20-\x7e]`)

func safeText(s string, max int) string {
	s = unsafeText.ReplaceAllString(s, "?")
	if len(s) > max {
		s = s[:max] + "..."
	}
	return s
}

var serverCode = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// classifyStatus explains a non-success HTTP status. body is a bounded prefix
// of the response; only its safe error code is read.
func classifyStatus(target *url.URL, path string, status int, retry time.Duration, body []byte) *ConnectionError {
	e := &ConnectionError{Delivery: Answered, Status: status, RetryAfter: retry}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && serverCode.MatchString(envelope.Error.Code) {
		e.ServerCode = envelope.Error.Code
	}
	wait := "Try again in a minute."
	if retry > 0 {
		wait = "Try again in " + humanDuration(retry) + "."
	}
	switch {
	case status == 401 && strings.HasSuffix(path, "/enroll"):
		e.Code = "ENROLLMENT_REFUSED"
		e.Message = "The server refused this enrollment (HTTP 401)."
		e.Fix = "Devices aren't told why; an administrator can see the reason on the Add device page or in Activity. Fix the cause, then run the command again. A new token is fine."
	case status == 401:
		e.Code = "CREDENTIAL_REJECTED"
		e.Message = "The server doesn't accept this device's credential (HTTP 401)."
		e.Fix = "The device may have been revoked. Check it under Devices; an administrator can authorize recovery."
	case status == 403:
		e.Code = "FORBIDDEN"
		e.Message = "The server refused the request (HTTP 403)."
		e.Fix = "Check this device's status under Devices."
	case status == 404:
		e.Code = "NOT_AN_AGENT_ENDPOINT"
		e.Message = fmt.Sprintf("There's no Vectory agent endpoint at %s (HTTP 404).", target.String())
		e.Fix = "Point --server at the agent listener (usually port 8443), not the dashboard."
	case status == 408 || status == 429 || status == 503:
		e.Code = "SERVER_BUSY"
		e.Message = fmt.Sprintf("The server is busy (HTTP %d).", status)
		e.Fix = wait
	case status >= 500:
		e.Code = "SERVER_ERROR"
		e.Message = fmt.Sprintf("The server had an internal error (HTTP %d).", status)
		e.Fix = "Try again. If it keeps happening, check the server log."
	default:
		e.Code = "REJECTED"
		e.Message = fmt.Sprintf("The server rejected the request (HTTP %d).", status)
	}
	return e
}

func humanDuration(d time.Duration) string {
	seconds := int(d.Round(time.Second) / time.Second)
	switch {
	case seconds < 1:
		return "a moment"
	case seconds < 90:
		return fmt.Sprintf("%d s", seconds)
	case seconds < 5400:
		return fmt.Sprintf("%d min", (seconds+30)/60)
	default:
		return fmt.Sprintf("%d h", (seconds+1800)/3600)
	}
}
