package agent

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func classifiedRequest(t *testing.T, s Settings, path string) *ConnectionError {
	t.Helper()
	client, err := NewClient(s, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_, err = client.request(context.Background(), "POST", path, map[string]string{"token": "never-in-messages"})
	ce, ok := AsConnectionError(err)
	if !ok {
		t.Fatalf("unclassified failure: %v", err)
	}
	if strings.Contains(ce.Error(), "never-in-messages") {
		t.Fatal("a request secret appeared in the diagnostic")
	}
	return ce
}

func TestConnectionFailuresAreClassifiedWithDelivery(t *testing.T) {
	// A port that was just released refuses connections.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	refused := listener.Addr().String()
	_ = listener.Close()
	ce := classifiedRequest(t, Settings{Server: "https://" + refused}, "/agent/v1/enroll")
	if ce.Code != "CONNECTION_REFUSED" || ce.Delivery != NotSent || !strings.Contains(ce.Message, refused) {
		t.Fatal("refused connection misclassified", ce)
	}

	plain := httptest.NewServer(http.NotFoundHandler())
	defer plain.Close()
	ce = classifiedRequest(t, Settings{Server: strings.Replace(plain.URL, "http://", "https://", 1)}, "/agent/v1/enroll")
	if ce.Code != "PLAIN_HTTP" || ce.Delivery != NotSent || !strings.Contains(ce.Message, "plain HTTP") || !strings.Contains(ce.Fix, ":8443") {
		t.Fatal("plain HTTP port misclassified", ce)
	}

	ca := makeCA(t)
	var hits atomic.Int32
	private := chainServer(t, ca, nil, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	ce = classifiedRequest(t, Settings{Server: private.URL}, "/agent/v1/enroll")
	if ce.Code != "TLS_UNKNOWN_AUTHORITY" || ce.Delivery != NotSent || !strings.Contains(ce.Message, "test device CA") || !strings.Contains(ce.Fix, "--ca-sha256") || hits.Load() != 0 {
		t.Fatal("unknown authority misclassified or request sent", ce)
	}
	// The fingerprint hint is for comparison only and cannot be pasted as a pin:
	// it is whole, in Add device's rows of eight pairs, but never one value.
	sum := certificateSHA256(ca.cert)
	if strings.Contains(ce.Fix, hex.EncodeToString(sum)) || strings.Contains(ce.Fix, Fingerprint(sum)) || !strings.Contains(ce.Fix, FingerprintRows(sum, "  ")) {
		t.Fatal("the unverified fingerprint was offered as a complete pin, or not in full", ce.Fix)
	}

	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := AtomicWrite(caFile, []byte(ca.pem)); err != nil {
		t.Fatal(err)
	}
	named := chainServer(t, ca, []string{"elsewhere.example.test"}, false, http.NotFoundHandler())
	ce = classifiedRequest(t, Settings{Server: named.URL, CAFile: caFile}, "/agent/v1/enroll")
	if ce.Code != "TLS_HOSTNAME_MISMATCH" || !strings.Contains(ce.Message, "elsewhere.example.test") || !strings.Contains(ce.Message, `"127.0.0.1"`) {
		t.Fatal("hostname mismatch misclassified", ce)
	}

	ce = classifiedRequest(t, Settings{Server: "https://vectory-name-that-does-not-exist.invalid:8443"}, "/agent/v1/enroll")
	if ce.Code != "DNS" || ce.Delivery != NotSent {
		t.Fatal("DNS failure misclassified", ce)
	}
}

func TestServerAnswersAreClassified(t *testing.T) {
	ca := makeCA(t)
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := AtomicWrite(caFile, []byte(ca.pem)); err != nil {
		t.Fatal(err)
	}
	status := 401
	server := chainServer(t, ca, nil, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "20")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":{"code":"ENROLLMENT_FAILED","message":"Enrollment failed"}}`))
	}))
	s := Settings{Server: server.URL, CAFile: caFile}
	ce := classifiedRequest(t, s, "/agent/v1/enroll")
	if ce.Code != "ENROLLMENT_REFUSED" || ce.Delivery != Answered || ce.ServerCode != "ENROLLMENT_FAILED" || !strings.Contains(ce.Fix, "Add device") {
		t.Fatal("enrollment refusal misclassified", ce)
	}
	ce = classifiedRequest(t, s, "/agent/v1/heartbeat")
	if ce.Code != "CREDENTIAL_REJECTED" {
		t.Fatal("credential refusal misclassified", ce)
	}
	status = 429
	ce = classifiedRequest(t, s, "/agent/v1/heartbeat")
	if ce.Code != "SERVER_BUSY" || !strings.Contains(ce.Fix, "20 s") {
		t.Fatal("rate limit misclassified", ce)
	}
	status = 404
	ce = classifiedRequest(t, s, "/agent/v1/enroll")
	if ce.Code != "NOT_AN_AGENT_ENDPOINT" || !strings.Contains(ce.Fix, "8443") {
		t.Fatal("dashboard port misclassified", ce)
	}
}

func TestDefinitiveRefusalAllowsNewTokenAndNameWhileAmbiguousKeepsBinding(t *testing.T) {
	dir, _ := enrollmentOptionsFixture(t)
	ca := makeCA(t)
	caFile := filepath.Join(dir, "trusted-ca.pem")
	if err := AtomicWrite(caFile, []byte(ca.pem)); err != nil {
		t.Fatal(err)
	}
	var requests []Enrollment
	status := 401
	server := chainServer(t, ca, nil, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Enrollment
		_ = json.NewDecoder(r.Body).Decode(&request)
		requests = append(requests, request)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":{"code":"ENROLLMENT_FAILED","message":"Enrollment failed"}}`))
	}))
	options := EnrollmentOptions{Server: server.URL, Name: "first-name", Token: "expired-token", CAFile: &caFile}
	err := EnrollWithOptions(context.Background(), dir, options)
	if ce, ok := AsConnectionError(err); !ok || ce.Code != "ENROLLMENT_REFUSED" || strings.Contains(err.Error(), "same token") {
		t.Fatal("refusal did not explain the next step", err)
	}
	pending, _ := ReadPendingEnrollment(dir)
	if pending == nil || pending.Delivery != "refused" {
		t.Fatal("definitive refusal was not recorded", pending)
	}
	// A refused request cannot have enrolled anything: a new name and token start
	// a new request with a new identity.
	options.Name, options.Token = "second-name", "fresh-token"
	status = 503
	_ = EnrollWithOptions(context.Background(), dir, options)
	if len(requests) != 2 || requests[1].RequestID == requests[0].RequestID || requests[1].Name != "second-name" || requests[1].Token != "fresh-token" {
		t.Fatal("refused request was not replaced", requests)
	}
	// The 503 may have been processed: the binding now holds, but a new token
	// (for example after the first expired) may still be used.
	options.Name = "third-name"
	if err := EnrollWithOptions(context.Background(), dir, options); err == nil || !strings.Contains(err.Error(), "second-name") {
		t.Fatal("ambiguous request was rebound", err)
	}
	options.Name, options.Token = "second-name", "another-token"
	_ = EnrollWithOptions(context.Background(), dir, options)
	if len(requests) != 3 || requests[2].RequestID != requests[1].RequestID || requests[2].Token != "another-token" {
		t.Fatal("ambiguous request did not retry its original identity", requests)
	}
	if _, err := os.Stat(filepath.Join(dir, "identity.json")); !os.IsNotExist(err) {
		t.Fatal("identity appeared without an accepted enrollment")
	}
}
