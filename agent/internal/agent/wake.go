package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Wake-ups. Between check-ins the agent holds one request open,
// GET /agent/v1/wait, on the same client as its heartbeat (the same
// transport, TLS verification, CA pin and proxy), and the server answers it
// as soon as this device's desired state changes. The answer is only a hint:
// changed:true makes the agent send its ordinary heartbeat at once, which
// receives the ordinary signed manifest and is verified as always. Nothing in
// the answer is trusted, stored or applied, so a forged or stale answer can
// only cause an early heartbeat. The agent still only initiates connections.
//
// A wait that fails (network, 4xx, 5xx, a server that stopped offering it)
// leaves the interval to the ordinary schedule and its backoff. It is never
// an outage, never retried in a loop and never reported.

// featureWake is listed in the signed manifest's features by servers that
// hold waits. Agents wait only for servers that list it.
const featureWake = "wake"

// What the run loop last saw of waits when it isn't the ordinary, kept in the
// state for `vectory status`, which can't ask the running process. Nothing
// else reads it.
const (
	// wakeOffRun: this run was started with --no-wake.
	wakeOffRun = "off_run"
	// wakeFailed: the last wait ended in an error, so the schedule covers its
	// interval.
	wakeFailed = "failed"
)

// noteWake records what the loop saw. It saves only when that changed, so the
// steady state costs no writes.
func (e *Engine) noteWake(observation string) {
	if e.State.Wake == observation {
		return
	}
	e.State.Wake = observation
	_ = e.save()
}

// wakeSpacing bounds how fast wake-ups can drive the loop: a heartbeat a
// wake-up asks for starts at least this long after the previous check-in
// ended, and a wait that ends sooner than this without a change is not
// renewed before the next check-in.
var wakeSpacing = time.Second

// wakeAnswer is how one wait ended.
type wakeAnswer struct {
	changed    bool
	retryAfter time.Duration
	err        error
}

// waitForChange holds GET /agent/v1/wait until the server answers: at once
// when this device's desired state differs from the generations the agent
// last accepted, otherwise when it changes, the server's hold ends or the
// server stops.
func (c *Client) waitForChange(ctx context.Context, generation, policyGeneration uint64) wakeAnswer {
	target := fmt.Sprintf("%s/agent/v1/wait?generation=%d&policy_generation=%d", c.Base, generation, policyGeneration)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return wakeAnswer{err: err}
	}
	req.Header.Set("User-Agent", "Vectory/"+Version)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return wakeAnswer{err: err}
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 4096))
	if res.StatusCode != http.StatusOK {
		return wakeAnswer{retryAfter: retryAfter(res), err: fmt.Errorf("wait answered HTTP %d", res.StatusCode)}
	}
	if err != nil {
		return wakeAnswer{err: err}
	}
	var answer struct {
		Changed *bool `json:"changed"`
	}
	if json.Unmarshal(body, &answer) != nil || answer.Changed == nil {
		return wakeAnswer{err: errors.New(`wait answer is not {"changed":true|false}`)}
	}
	return wakeAnswer{changed: *answer.Changed}
}

// wakeAllowed says whether this interval holds a wait: the server lists the
// feature, neither the host's settings nor this run turned wake-ups off, and
// the last check-in succeeded (after a failure the ordinary backoff applies).
func (e *Engine) wakeAllowed(noWake bool, failures int) bool {
	return !noWake && !e.Settings.NoWake && failures == 0 && e.serverSupports(featureWake)
}

// listening is one wait in flight. Its goroutine makes the request and
// touches no Engine state, so the supervisor keeps its local checks going.
type listening struct {
	answers chan wakeAnswer
	cancel  context.CancelFunc
	started time.Time
}

// listen starts a wait, unless the server asked to hold off.
func (s *workloadSupervisor) listen(ctx context.Context, e *Engine) *listening {
	if time.Now().Before(s.wakeResume) {
		return nil
	}
	ctx, cancel := context.WithCancel(ctx)
	l := &listening{answers: make(chan wakeAnswer, 1), cancel: cancel, started: time.Now()}
	client, generation, policy := e.Client, e.State.HighestGeneration, e.State.HighestPolicyGeneration
	go func() { l.answers <- client.waitForChange(ctx, generation, policy) }()
	return l
}

// answer is the wait's outcome, or a channel that never delivers without one.
func (l *listening) answer() <-chan wakeAnswer {
	if l == nil {
		return nil
	}
	return l.answers
}

// stop ends an unanswered wait and returns once its goroutine has, so no
// request outlives the interval it belongs to. Stopping the agent this way
// is a clean stop, not an outage.
func (l *listening) stop() {
	if l == nil {
		return
	}
	l.cancel()
	<-l.answers
}
