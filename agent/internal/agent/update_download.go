package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"
)

// The download of an agent build. A build is up to MaxAgentBuild (128 MiB), so it
// can't go through Client.request, which reads a response whole into memory and
// stops at MaxArtifact, and under the 30 seconds the shared client allows a
// request. It streams to a file instead: counted and hashed as it arrives, never
// past the signed size, renamed to its final name only when its size and SHA-256
// are the signed ones, and removed on any failure, so that nothing under a final
// name is ever a partial build. A transfer has five minutes in all and may not
// pause for more than twenty seconds, the limits the server keeps to as well.

var (
	// updateDownloadDeadline and updateDownloadStall are the bounds of a transfer.
	// They are variables so that a test can shorten them; only tests assign them.
	updateDownloadDeadline = 5 * time.Minute
	updateDownloadStall    = 20 * time.Second
)

// updateDownloadWords end the hint of a failed transfer of a build: nothing was
// changed on this host, and the agent tries again by itself.
var updateDownloadWords = downloadWords{"Nothing was changed.", "The agent tries again at its next check-in."}

// updateDownloadError says why a build did not arrive. Code is the agent code the
// device reports (DOWNLOAD_FAILED, ARTIFACT_MISMATCH or DISK_FULL); Gone says the
// server no longer offers the build (403 or 404); Retry is how long the server
// asked this device to wait (429 or 503). Words are for the log: they carry
// nothing the server said, only what the agent found.
type updateDownloadError struct {
	Code  string
	Gone  bool
	Retry time.Duration
	Words string
	cause error
}

func (e *updateDownloadError) Error() string { return e.Words }
func (e *updateDownloadError) Unwrap() error { return e.cause }

// downloadClient is the HTTP client a transfer uses: the check-in client's
// transport, cloned so that a long transfer has connections of its own and can't
// keep a heartbeat or a wait from getting one (the shared transport allows two
// to the server), with no limit on the whole request (the transfer's own
// deadline replaces it) and no redirects. closeIdle drops the connections the
// transfer leaves open.
func (c *Client) downloadClient() (client *http.Client, closeIdle func()) {
	noRedirects := func(*http.Request, []*http.Request) error { return errors.New("redirects forbidden") }
	var base http.RoundTripper
	if c.HTTP != nil {
		base = c.HTTP.Transport
	}
	if transport, ok := base.(*http.Transport); ok {
		clone := transport.Clone()
		return &http.Client{Transport: clone, CheckRedirect: noRedirects}, clone.CloseIdleConnections
	}
	return &http.Client{Transport: base, CheckRedirect: noRedirects}, func() {}
}

// downloadAgentBuild fetches the build at path into dir, as the file a staged
// build is called, and returns it as the file system has it. size and digest are
// the signed ones. It never leaves a file under the final name that isn't exactly
// them, and removes what it wrote when it fails.
func (c *Client) downloadAgentBuild(ctx context.Context, path, dir string, size int64, digest string) (os.FileInfo, error) {
	owner := ctx
	ctx, cancel := context.WithTimeout(ctx, updateDownloadDeadline)
	defer cancel()
	var stalled atomic.Bool
	watchdog := time.AfterFunc(updateDownloadStall, func() {
		stalled.Store(true)
		cancel()
	})
	defer watchdog.Stop()
	// interrupted explains a transfer that stopped for a reason of the network,
	// the clock or the other side; one the owner stopped isn't a failure at all.
	interrupted := func(err error) error {
		switch {
		case owner.Err() != nil:
			return owner.Err()
		case stalled.Load():
			return &updateDownloadError{Code: "DOWNLOAD_FAILED", Words: fmt.Sprintf("The server stopped sending the build for %d seconds. %s", int(updateDownloadStall/time.Second), updateDownloadWords.again), cause: err}
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return &updateDownloadError{Code: "DOWNLOAD_FAILED", Words: fmt.Sprintf("The build didn't arrive in %s. %s", humanDuration(updateDownloadDeadline), updateDownloadWords.again), cause: err}
		}
		return &updateDownloadError{Code: "DOWNLOAD_FAILED", Words: "The server closed the connection before the whole build arrived. " + updateDownloadWords.again + " If it keeps happening, look for a proxy or firewall that cuts long responses.", cause: err}
	}

	target, err := url.Parse(c.Base)
	if err != nil {
		return nil, &updateDownloadError{Code: "DOWNLOAD_FAILED", Words: "The server address can't be read. " + updateDownloadWords.again, cause: err}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+path, nil)
	if err != nil {
		return nil, &updateDownloadError{Code: "DOWNLOAD_FAILED", Words: "The request for the build can't be made. " + updateDownloadWords.again, cause: err}
	}
	req.Header.Set("User-Agent", "Vectory/"+Version)
	req.Header.Set("Accept", "application/octet-stream")
	var wrote atomic.Bool
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		WroteHeaders: func() { wrote.Store(true) },
		WroteRequest: func(httptrace.WroteRequestInfo) { wrote.Store(true) },
	}))
	client, closeIdle := c.downloadClient()
	defer closeIdle()
	res, err := client.Do(req)
	if err != nil {
		if owner.Err() != nil || stalled.Load() || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, interrupted(err)
		}
		proxy, _ := http.ProxyFromEnvironment(req)
		return nil, connectionFailure(classifyTransport(target, proxy, wrote.Load(), err))
	}
	defer res.Body.Close()
	retry := retryAfter(res)
	switch {
	case res.StatusCode == http.StatusOK:
	case res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusNotFound:
		return nil, &updateDownloadError{Code: "DOWNLOAD_FAILED", Gone: true, Words: "The server doesn't offer the build any more."}
	case res.StatusCode == http.StatusTooManyRequests || res.StatusCode == http.StatusServiceUnavailable:
		// Waited out, never counted as a failure of the transfer: the server asked
		// for it. An answer without a usable Retry-After is waited out for a minute.
		if retry <= 0 {
			retry = updateBusyWait
		}
		return nil, &updateDownloadError{Code: "DOWNLOAD_FAILED", Retry: retry, Words: fmt.Sprintf("The server is busy (HTTP %d). The agent asks again in %s.", res.StatusCode, humanDuration(retry))}
	default:
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return nil, connectionFailure(classifyStatus(target, path, res.StatusCode, retry, body))
	}
	// The length the server announces is the signed one, or the build is not the
	// signed one: nothing is read.
	if res.ContentLength >= 0 && res.ContentLength != size {
		return nil, mismatch(res.ContentLength, size)
	}

	part, final := filepath.Join(dir, UpdateBuildPartFile), filepath.Join(dir, UpdateBuildFile(runtime.GOOS))
	// A partial file an earlier transfer left is not resumed: a build is small
	// next to the cost of trusting half of one.
	if err := os.Remove(part); err != nil && !os.IsNotExist(err) {
		return nil, storageFailure(dir, err)
	}
	f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, storageFailure(dir, err)
	}
	failed := true
	defer func() {
		if failed {
			f.Close()
			_ = os.Remove(part)
		}
	}()
	_ = ownedLikeParent(part)

	hash := sha256.New()
	buf := make([]byte, 128<<10)
	var total int64
	for {
		n, readErr := res.Body.Read(buf)
		if n > 0 {
			total += int64(n)
			if total > size {
				return nil, mismatch(total, size)
			}
			if _, err := f.Write(buf[:n]); err != nil {
				return nil, storageFailure(dir, err)
			}
			hash.Write(buf[:n])
			watchdog.Reset(updateDownloadStall)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, interrupted(readErr)
		}
	}
	// Everything has arrived: what is left is this host's own work, which the
	// stall limit is not about.
	watchdog.Stop()
	if total != size {
		return nil, mismatch(total, size)
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return nil, &updateDownloadError{Code: "ARTIFACT_MISMATCH", Words: "The SHA-256 of the build doesn't match the signed release. " + updateDownloadWords.retry()}
	}
	if err := f.Sync(); err != nil {
		return nil, storageFailure(dir, err)
	}
	if err := f.Close(); err != nil {
		return nil, storageFailure(dir, err)
	}
	if err := os.Rename(part, final); err != nil {
		return nil, storageFailure(dir, err)
	}
	failed = false
	if err := syncDir(dir); err != nil {
		_ = os.Remove(final)
		return nil, storageFailure(dir, err)
	}
	info, err := os.Lstat(final)
	if err != nil {
		return nil, storageFailure(dir, err)
	}
	return info, nil
}

// connectionFailure describes a request that failed before the server gave a
// build: the words are the connection error's own (they carry no secret), with
// the hint every failed transfer ends in.
func connectionFailure(ce *ConnectionError) error {
	failure := classifyDownloadWith(ce, updateDownloadWords)
	words := ce.Message
	if len(failure.diagnostics) > 0 {
		words = failure.diagnostics[0].Message + " " + failure.diagnostics[0].Hint
	}
	return &updateDownloadError{Code: "DOWNLOAD_FAILED", Retry: ce.RetryAfter, Words: words, cause: ce}
}

// mismatch is a build that doesn't have the signed size.
func mismatch(got, want int64) error {
	return &updateDownloadError{Code: "ARTIFACT_MISMATCH", Words: fmt.Sprintf("The build arrived with %d bytes, and the signed release says %d. %s", got, want, updateDownloadWords.retry())}
}

// storageFailure is a build that couldn't be written: a full disk is its own
// code, anything else is a transfer that failed.
func storageFailure(dir string, err error) error {
	if full, ok := diskFullFrom(storageError(dir, err)); ok {
		return &updateDownloadError{Code: "DISK_FULL", Words: "There isn't room for the build on the disk that holds the agent's state. Free some space there; the agent tries again at its next check-in.", cause: full}
	}
	return &updateDownloadError{Code: "DOWNLOAD_FAILED", Words: "The build couldn't be saved on this host. " + updateDownloadWords.again, cause: err}
}
