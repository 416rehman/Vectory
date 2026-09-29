package agent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// lines collects what the agent reports.
type lines struct {
	mu    sync.Mutex
	items []string
}

func (l *lines) add(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.items = append(l.items, line)
}
func (l *lines) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.items...)
}

func quiet(string) {}

func eventually(t *testing.T, within time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached in time")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// enrolledForWake enrolls a synthetic device with setup, without a service,
// against a fake server listing features. It returns the server, the state
// directory and how many heartbeats setup's own check-in sent.
func enrolledForWake(t *testing.T, features []string, noWake *bool) (*setupServer, string, int32) {
	t.Helper()
	server := newSetupServer(t)
	server.features = features
	options, dir, _ := setupFixture(t)
	options.Server, options.CASHA256, options.VectorBinary = server.url, server.pin, fakeVector(t, VectorVersion)
	options.Token = func() (string, error) { return "synthetic-setup-token", nil }
	options.NoWake = noWake
	result, err := Setup(context.Background(), options)
	if err != nil || !result.OK {
		t.Fatalf("setup: %+v %v", result, err)
	}
	return server, dir, server.heartbeats.Load()
}

// running starts the agent loop; stop ends it like a service stop and
// returns how the loop ended.
func running(t *testing.T, dir string, options runOptions, report func(string)) (stop func() error) {
	t.Helper()
	if report == nil {
		report = func(string) {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runWith(ctx, dir, options, report) }()
	var once sync.Once
	var result error
	stop = func() error {
		once.Do(func() {
			cancel()
			select {
			case result = <-done:
			case <-time.After(10 * time.Second):
				result = errors.New("the agent did not stop")
			}
		})
		return result
	}
	t.Cleanup(func() { _ = stop() })
	return stop
}

func answer(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, body)
}

// A wake-up brings exactly one heartbeat, at once, over the heartbeat's own
// client: the fake server answers a wait only for a TLS client presenting
// the device certificate, and setup pinned its CA. Stopping during the next
// wait is a clean stop, not an outage.
func TestWakeUpBringsExactlyOneHeartbeatAtOnce(t *testing.T) {
	server, dir, base := enrolledForWake(t, []string{featureWake}, nil)
	queries := make(chan url.Values, 8)
	answers := make(chan string, 8)
	server.setWait(func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.Query()
		select {
		case body := <-answers:
			answer(w, body)
		case <-r.Context().Done():
		}
	})
	var reports lines
	stop := running(t, dir, runOptions{}, reports.add)
	eventually(t, 5*time.Second, func() bool { return server.heartbeats.Load() == base+1 })
	var query url.Values
	select {
	case query = <-queries:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent never waited")
	}
	if len(query) != 2 || query.Get("generation") != "0" || query.Get("policy_generation") != "0" {
		t.Fatalf("wait query %v", query)
	}
	// Past wakeSpacing, the heartbeat follows the answer at once.
	time.Sleep(wakeSpacing + 100*time.Millisecond)
	answered := time.Now()
	answers <- `{"changed":true}`
	eventually(t, 3*time.Second, func() bool { return server.heartbeats.Load() == base+2 })
	if late := server.beatsAt()[base+1].Sub(answered); late > 500*time.Millisecond {
		t.Fatalf("the heartbeat came %v after the wake-up", late)
	}
	select {
	case <-queries:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent did not wait again after its heartbeat")
	}
	time.Sleep(1500 * time.Millisecond)
	if n := server.heartbeats.Load() - base; n != 2 {
		t.Fatalf("%d heartbeats, want the first and exactly one after the wake-up", n)
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
	state, err := LoadState(dir)
	if err != nil || state.CheckInFailure != nil {
		t.Fatalf("stopping during a wait recorded an outage: %+v %v", state.CheckInFailure, err)
	}
	for _, line := range reports.all() {
		if strings.Contains(strings.ToLower(line), "wait") || strings.Contains(strings.ToLower(line), "wake") {
			t.Fatalf("waiting was reported: %q", line)
		}
	}
}

// A server that answers changed:true to every wait gets at most one
// heartbeat a second.
func TestWakeUpsCannotSpinTheLoop(t *testing.T) {
	server, dir, base := enrolledForWake(t, []string{featureWake}, nil)
	server.setWait(func(w http.ResponseWriter, _ *http.Request) { answer(w, `{"changed":true}`) })
	stop := running(t, dir, runOptions{}, nil)
	eventually(t, 5*time.Second, func() bool { return server.heartbeats.Load() == base+1 })
	time.Sleep(3500 * time.Millisecond)
	if err := stop(); err != nil {
		t.Fatal(err)
	}
	times := server.beatsAt()[base:]
	if len(times) < 3 {
		t.Fatalf("%d heartbeats: wake-ups brought no check-ins", len(times))
	}
	for i := 1; i < len(times); i++ {
		if gap := times[i].Sub(times[i-1]); gap < 990*time.Millisecond {
			t.Fatalf("heartbeats %v apart", gap)
		}
	}
}

// Older servers don't list the feature and get no waits; neither does a
// host that turned wake-ups off (run --no-wake, or setup --no-wake saved in
// its settings).
func TestNoWaitsWithoutTheFeatureOrWhenTurnedOff(t *testing.T) {
	off := true
	for _, c := range []struct {
		name     string
		features []string
		setting  *bool
		options  runOptions
	}{
		{"server without the feature", nil, nil, runOptions{}},
		{"vectory run --no-wake", []string{featureWake}, nil, runOptions{noWake: true}},
		{"setup --no-wake", []string{featureWake}, &off, runOptions{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			server, dir, base := enrolledForWake(t, c.features, c.setting)
			server.setWait(func(w http.ResponseWriter, _ *http.Request) { answer(w, `{"changed":true}`) })
			if settings, err := LoadSettings(dir); err != nil || settings.NoWake != (c.setting != nil) {
				t.Fatalf("saved no_wake %v %v", settings.NoWake, err)
			}
			stop := running(t, dir, c.options, nil)
			eventually(t, 5*time.Second, func() bool { return server.heartbeats.Load() == base+1 })
			time.Sleep(1500 * time.Millisecond)
			if err := stop(); err != nil {
				t.Fatal(err)
			}
			if server.waits.Load() != 0 || server.heartbeats.Load() != base+1 {
				t.Fatalf("%d waits, %d heartbeats", server.waits.Load(), server.heartbeats.Load()-base)
			}
		})
	}
}

func TestWakeAllowed(t *testing.T) {
	e := &Engine{State: State{ServerFeatures: []string{featureHostRuntime, featureWake}}}
	if !e.wakeAllowed(false, 0) {
		t.Fatal("a server listing wake gets waits")
	}
	if e.wakeAllowed(true, 0) || e.wakeAllowed(false, 1) {
		t.Fatal("--no-wake or a failed check-in still waits")
	}
	e.Settings.NoWake = true
	if e.wakeAllowed(false, 0) {
		t.Fatal("the no_wake setting still waits")
	}
	e.Settings.NoWake, e.State.ServerFeatures = false, []string{featureHostRuntime}
	if e.wakeAllowed(false, 0) {
		t.Fatal("a server without the feature gets waits")
	}
}

// wakeEngine is an engine whose client talks to handler, which records the
// waits it answers.
func wakeEngine(t *testing.T, handler http.HandlerFunc) (*Engine, *atomic.Int32) {
	t.Helper()
	var waits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/v1/wait" || r.URL.RawQuery != "generation=7&policy_generation=3" {
			t.Errorf("unexpected request %s", r.URL)
			http.NotFound(w, r)
			return
		}
		waits.Add(1)
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return &Engine{Dir: t.TempDir(), Client: &Client{HTTP: server.Client(), Base: server.URL}, Driver: &fakeDriver{alive: true}, State: State{ServerFeatures: []string{featureWake}, HighestGeneration: 7, HighestPolicyGeneration: 3}}, &waits
}

// Every way a wait can fail leaves the interval to the ordinary schedule,
// once, silently, and never as an outage. A server that asks to hold off
// gets no wait until then.
func TestWaitFailuresFallBackToTheScheduleSilently(t *testing.T) {
	for _, c := range []struct {
		name    string
		handler http.HandlerFunc
		holdOff bool
	}{
		{"connection cut", func(w http.ResponseWriter, _ *http.Request) {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = connection.Close()
			}
		}, false},
		{"server without the route", http.NotFound, false},
		{"refused", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":{"code":"UNAUTHENTICATED","message":"Authentication required"}}`, http.StatusUnauthorized)
		}, false},
		{"server error", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "unavailable", http.StatusInternalServerError)
		}, false},
		{"busy", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Retry-After", "120")
			http.Error(w, `{"error":{"code":"CAPACITY_BUSY","message":"busy"},"retry_after":120}`, http.StatusServiceUnavailable)
		}, true},
		{"not JSON", func(w http.ResponseWriter, _ *http.Request) { answer(w, "changed") }, false},
		{"another shape", func(w http.ResponseWriter, _ *http.Request) { answer(w, `{"changed":"yes"}`) }, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			e, waits := wakeEngine(t, c.handler)
			s := &workloadSupervisor{}
			var reports lines
			started := time.Now()
			if !s.wait(context.Background(), e, 600*time.Millisecond, reports.add, true) {
				t.Fatal("the interval ended as a stop")
			}
			if elapsed := time.Since(started); elapsed < 590*time.Millisecond {
				t.Fatalf("checked in after %v, before the schedule", elapsed)
			}
			if waits.Load() != 1 || len(reports.all()) != 0 || e.State.CheckInFailure != nil {
				t.Fatalf("%d waits, reports %v, outage %+v", waits.Load(), reports.all(), e.State.CheckInFailure)
			}
			s.wait(context.Background(), e, 300*time.Millisecond, reports.add, true)
			want := int32(2)
			if c.holdOff {
				want = 1
			}
			if waits.Load() != want {
				t.Fatalf("%d waits in the next interval, want %d", waits.Load(), want)
			}
		})
	}
}

func TestWaitAnswers(t *testing.T) {
	t.Run("changed at once waits out the spacing", func(t *testing.T) {
		e, waits := wakeEngine(t, func(w http.ResponseWriter, _ *http.Request) { answer(w, `{"changed":true}`) })
		started := time.Now()
		if !(&workloadSupervisor{}).wait(context.Background(), e, 10*time.Second, quiet, true) {
			t.Fatal("stopped")
		}
		if elapsed := time.Since(started); elapsed < wakeSpacing || elapsed > wakeSpacing+500*time.Millisecond || waits.Load() != 1 {
			t.Fatalf("checked in after %v with %d waits", elapsed, waits.Load())
		}
	})
	t.Run("changed later checks in at once", func(t *testing.T) {
		e, _ := wakeEngine(t, func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(1300 * time.Millisecond)
			answer(w, `{"changed":true}`)
		})
		started := time.Now()
		(&workloadSupervisor{}).wait(context.Background(), e, 10*time.Second, quiet, true)
		if elapsed := time.Since(started); elapsed < 1300*time.Millisecond || elapsed > 1800*time.Millisecond {
			t.Fatalf("checked in after %v", elapsed)
		}
	})
	t.Run("unchanged after the hold waits again", func(t *testing.T) {
		ended := make(chan struct{})
		var count atomic.Int32
		e, waits := wakeEngine(t, func(w http.ResponseWriter, r *http.Request) {
			if count.Add(1) == 1 {
				time.Sleep(wakeSpacing + 100*time.Millisecond)
				answer(w, `{"changed":false}`)
				return
			}
			<-r.Context().Done()
			close(ended)
		})
		started := time.Now()
		(&workloadSupervisor{}).wait(context.Background(), e, 2500*time.Millisecond, quiet, true)
		if elapsed := time.Since(started); elapsed < 2490*time.Millisecond || waits.Load() != 2 {
			t.Fatalf("checked in after %v with %d waits", elapsed, waits.Load())
		}
		select {
		case <-ended:
		case <-time.After(time.Second):
			t.Fatal("the second wait outlived its interval")
		}
	})
	t.Run("unchanged at once is not renewed", func(t *testing.T) {
		e, waits := wakeEngine(t, func(w http.ResponseWriter, _ *http.Request) { answer(w, `{"changed":false}`) })
		(&workloadSupervisor{}).wait(context.Background(), e, 1500*time.Millisecond, quiet, true)
		if waits.Load() != 1 {
			t.Fatalf("%d waits", waits.Load())
		}
	})
	t.Run("stopping ends the wait", func(t *testing.T) {
		ended := make(chan struct{})
		e, _ := wakeEngine(t, func(_ http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
			close(ended)
		})
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(200*time.Millisecond, cancel)
		started := time.Now()
		if (&workloadSupervisor{}).wait(ctx, e, 10*time.Second, quiet, true) {
			t.Fatal("a stop reported a check-in")
		}
		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("stopped after %v", elapsed)
		}
		select {
		case <-ended:
		case <-time.After(time.Second):
			t.Fatal("the wait outlived the stop")
		}
	})
	t.Run("without wake nothing waits", func(t *testing.T) {
		e, waits := wakeEngine(t, func(w http.ResponseWriter, _ *http.Request) { answer(w, `{"changed":true}`) })
		(&workloadSupervisor{}).wait(context.Background(), e, 300*time.Millisecond, quiet, false)
		if waits.Load() != 0 {
			t.Fatal("waited with wake off")
		}
	})
}

// install --no-wake saves the local setting; =false turns wake-ups back on;
// omitting it keeps the setting, and nothing else changes.
func TestNoWakeIsALocalSetting(t *testing.T) {
	f := maintenanceFixture(t)
	for _, step := range []struct {
		option *bool
		want   bool
	}{{optionPointer(true), true}, {nil, true}, {optionPointer(false), false}} {
		if err := InstallWithOptions(context.Background(), f.dir, InstallOptions{NoWake: step.option}); err != nil {
			t.Fatal(err)
		}
		settings, err := LoadSettings(f.dir)
		if err != nil || settings.NoWake != step.want {
			t.Fatalf("no_wake %v after %v: %v", settings.NoWake, step.option, err)
		}
	}
}
