// Isolated synthetic protocol driver. No real Vector activation is claimed.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	crand "crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"runtime"
	"sort"
	"sync"
	"time"
)

type device struct {
	ID          string `json:"id"`
	Certificate string `json:"certificate"`
	Key         string `json:"key"`
}
type plan struct {
	Server     string   `json:"server"`
	CA         string   `json:"ca"`
	SigningKey string   `json:"signing_key"`
	Digest     string   `json:"digest"`
	Duration   float64  `json:"duration"`
	Interval   float64  `json:"interval"`
	Devices    []device `json:"devices"`
}
type prepared struct {
	identity device
	client   *http.Client
}

func quantiles(values []float64) map[string]float64 {
	if len(values) == 0 {
		return nil
	}
	sort.Float64s(values)
	return map[string]float64{"p50": values[int(float64(len(values)-1)*.5)], "p95": values[int(float64(len(values)-1)*.95)], "p99": values[int(float64(len(values)-1)*.99)], "max": values[len(values)-1]}
}
func run() error {
	input := flag.String("plan", "", "private fixture plan")
	output := flag.String("out", "", "measurement JSON")
	flag.Parse()
	raw, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	var p plan
	if err = json.Unmarshal(raw, &p); err != nil {
		return err
	}
	if p.Duration <= 0 || p.Interval <= 0 || len(p.Devices) == 0 {
		return errors.New("invalid measurement parameters")
	}
	ca, err := os.ReadFile(p.CA)
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return errors.New("invalid fixture CA")
	}
	public, err := base64.StdEncoding.DecodeString(p.SigningKey)
	if err != nil || len(public) != ed25519.PublicKeySize {
		return errors.New("invalid fixture signing key")
	}
	setup := time.Now()
	clients := make([]prepared, len(p.Devices))
	for index, d := range p.Devices {
		certificate, err := tls.LoadX509KeyPair(d.Certificate, d.Key)
		if err != nil {
			return err
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS13}
		transport.MaxConnsPerHost = 2
		transport.ResponseHeaderTimeout = 20 * time.Second
		transport.DisableCompression = true
		clients[index] = prepared{d, &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect forbidden") }}}
	}
	setupSeconds := time.Since(setup).Seconds()
	started := time.Now()
	deadline := started.Add(time.Duration(p.Duration * float64(time.Second)))
	var mu sync.Mutex
	var group sync.WaitGroup
	requests, success, attempted, unique := 0, 0, 0, 0
	var requestBytes, responseBytes int64
	errorsByKind, protocols := map[string]int{}, map[string]int{}
	all, good, convergence := []float64{}, []float64{}, []float64{}
	for index, ready := range clients {
		group.Add(1)
		go func(index int, ready prepared) {
			defer group.Done()
			defer ready.client.CloseIdleConnections()
			rng := rand.New(rand.NewSource(int64(20260926 + index)))
			time.Sleep(time.Duration(rng.Float64() * p.Interval * float64(time.Second)))
			tried, received, failures := false, false, 0
			for time.Now().Before(deadline) {
				nonceBytes := make([]byte, 32)
				if _, err := crand.Read(nonceBytes); err != nil {
					return
				}
				nonce := base64.StdEncoding.EncodeToString(nonceBytes)
				body, _ := json.Marshal(map[string]any{"protocol_version": 1, "request_id": nonce, "nonce": nonce, "boot_id": fmt.Sprintf("synthetic-%d", index), "agent_version": "synthetic-go-http2", "vector_version": "0.58.0", "reported_generation": 1, "policy_generation": 0, "actual_sha256": p.Digest, "apply_state": "verified_applied", "local_paused": false, "remote_pause_acknowledged": false, "telemetry": map[string]any{"sampled_at": time.Now().UTC().Format(time.RFC3339), "events_per_second": 12.5, "errors": 0}})
				mu.Lock()
				requests++
				requestBytes += int64(len(body))
				if !tried {
					attempted++
					tried = true
				}
				mu.Unlock()
				request, _ := http.NewRequestWithContext(context.Background(), "POST", p.Server+"/agent/v1/heartbeat", bytes.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				begin := time.Now()
				response, requestError := ready.client.Do(request)
				kind, protocol := "", ""
				var responseSize int64
				if requestError != nil {
					kind = "connection_error"
					if errors.Is(requestError, context.DeadlineExceeded) {
						kind = "timeout"
					}
				} else {
					data, readError := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
					response.Body.Close()
					responseSize = int64(len(data))
					protocol = response.Proto
					if readError != nil || len(data) > 1024*1024 {
						kind = "response_read_error"
					} else if response.StatusCode != 200 {
						kind = fmt.Sprintf("HTTP %d", response.StatusCode)
					} else {
						var envelope struct {
							Payload   string `json:"payload"`
							Signature string `json:"signature"`
						}
						var manifest struct {
							Device     string `json:"device_id"`
							Nonce      string `json:"nonce"`
							Generation int    `json:"generation"`
							Desired    *struct {
								Digest string `json:"sha256"`
							} `json:"desired"`
						}
						if json.Unmarshal(data, &envelope) != nil {
							kind = "invalid_envelope"
						} else {
							payload, e1 := base64.StdEncoding.DecodeString(envelope.Payload)
							signature, e2 := base64.StdEncoding.DecodeString(envelope.Signature)
							if e1 != nil || e2 != nil || !ed25519.Verify(public, payload, signature) || json.Unmarshal(payload, &manifest) != nil || manifest.Device != ready.identity.ID || manifest.Nonce != nonce || manifest.Generation != 1 || manifest.Desired == nil || manifest.Desired.Digest != p.Digest {
								kind = "manifest_binding_failure"
							}
						}
					}
				}
				latency := float64(time.Since(begin)) / float64(time.Millisecond)
				mu.Lock()
				all = append(all, latency)
				responseBytes += responseSize
				if protocol != "" {
					protocols[protocol]++
				}
				if kind == "" {
					success++
					good = append(good, latency)
					if !received {
						received = true
						unique++
						convergence = append(convergence, time.Since(started).Seconds())
					}
				} else {
					errorsByKind[kind]++
				}
				mu.Unlock()
				base := p.Interval
				if kind != "" {
					failures++
					base = min(300, float64(5*(int64(1)<<min(failures, 6))))
				} else {
					failures = 0
				}
				delay := time.Duration(base * (.8 + .4*rng.Float64()) * float64(time.Second))
				remaining := time.Until(deadline)
				if remaining <= 0 {
					break
				}
				time.Sleep(min(delay, remaining))
			}
		}(index, ready)
	}
	group.Wait()
	telemetryJSON, _ := json.Marshal(map[string]any{"sampled_at": time.Now().UTC().Format(time.RFC3339), "events_per_second": 12.5, "errors": 0})
	result := map[string]any{"transport": "Go net/http DefaultTransport clone; TLS1.3; HTTP/2 negotiated when available", "protocol_counts": protocols, "agents": len(clients), "requests": requests, "success": success, "unique_agents_attempted": attempted, "unique_agents_succeeded": unique, "errors": errorsByKind, "error_rate": float64(requests-success) / float64(max(requests, 1)), "latency_all_requests_ms": quantiles(all), "latency_successful_requests_ms": quantiles(good), "signed_manifest_convergence_seconds": quantiles(convergence), "request_bytes": requestBytes, "response_bytes": responseBytes, "elapsed_seconds": time.Since(started).Seconds(), "context_setup_outside_measurement_seconds": setupSeconds}
	result["go_version"] = runtime.Version()
	result["telemetry_json_bytes"] = len(telemetryJSON)
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(*output, append(encoded, '\n'), 0600)
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "isolated load driver failed:", err)
		os.Exit(1)
	}
}
