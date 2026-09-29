//! Wake-ups: a device's agent holds one authenticated request open
//! (`GET /agent/v1/wait`), and the server answers it the moment that device's
//! desired state changes, so a deployment reaches the device in seconds
//! instead of at its next check-in.
//!
//! The answer is a hint, never authority. It is unsigned, tiny
//! (`{"changed":true|false}`), carries no configuration and changes no state.
//! An agent that hears `changed:true` sends an ordinary heartbeat, which gets
//! the ordinary signed manifest, so a forged or stale answer can only cause an
//! early heartbeat. The agent still initiates every connection.
//!
//! Everything here lives in memory and stays cheap at fleet size:
//! - A wait authenticates and reads the device's generations in one query,
//!   then parks without a database connection, the writer lock or an agent
//!   request slot. Nothing reads the database while it is parked or when it
//!   times out.
//! - One waiter per device: a newer wait replaces the older one, which
//!   answers `changed:false`. At most `Options::limit` waits are parked at
//!   once; beyond that the server answers 503 and the agent keeps polling.
//! - Writers stage the devices whose desired generation, policy generation or
//!   access they change (`stage`). Once the request or scheduler tick has
//!   finished, its transactions have ended, and `flush` reads the committed
//!   generations of the staged devices that have a parked wait, in one query,
//!   and answers those whose state really changed. A preview that rolls its
//!   simulated changes back wakes nobody, and a burst of changes wakes each
//!   waiter once.
//! - The response head is sent at once and the one-line body when the answer
//!   is known (at most `Options::hold` later), so the agent listener's request
//!   deadline and slots bound only the authentication, and an agent's
//!   response-header timeout never cuts a parked wait short.
use crate::{
    State,
    device::PeerCertificate,
    error::{ApiError, Result},
};
use axum::{
    Extension,
    body::Bytes,
    extract::{RawQuery, Request, State as AppState},
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use hyper::body::Frame;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    task::{Context, Poll, Waker},
    time::Duration,
};

/// Listed in the signed manifest's `features`: this server holds waits.
pub const FEATURE: &str = "wake";
/// Seconds a refused wait should leave before the next one. The agent keeps
/// checking in on its ordinary schedule meanwhile.
const BUSY_RETRY_SECONDS: u64 = 60;
const CLOSING_RETRY_SECONDS: u64 = 5;
const MAX_SAFE: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug)]
pub struct Options {
    /// Waits parked at once across the fleet; 0 turns wake-ups off (the
    /// manifest stops listing the feature and agents only poll).
    pub limit: usize,
    /// How long one wait is held before it answers `changed:false`.
    pub hold: Duration,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            limit: 20_000,
            hold: Duration::from_secs(25),
        }
    }
}

/// What a parked wait answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// The device's desired state or access changed: check in now.
    Changed,
    /// Nothing changed: the hold ended, a newer wait replaced this one, or
    /// the server is shutting down.
    Unchanged,
}
impl Answer {
    fn body(self) -> &'static [u8] {
        match self {
            Answer::Changed => br#"{"changed":true}"#,
            Answer::Unchanged => br#"{"changed":false}"#,
        }
    }
}

/// The waits parked right now, one per device.
pub struct Registry {
    inner: Mutex<Inner>,
    options: Options,
}
#[derive(Default)]
struct Inner {
    waiters: HashMap<Arc<str>, Waiter>,
    tickets: u64,
    /// Advanced by every flush before it looks for waiters, so a wait that
    /// registered during a flush knows to read its device once more.
    sequence: u64,
    closed: bool,
    /// Waits answered `changed:true` by a flush, for tests and capacity notes.
    woken: u64,
}
/// A parked wait: the generations the agent last accepted, its answer once
/// known and the task to wake. Fixed size; the device key is the only
/// allocation, shared with the parked response body.
struct Waiter {
    ticket: u64,
    generation: i64,
    policy_generation: i64,
    answer: Option<Answer>,
    waker: Option<Waker>,
}
enum Refusal {
    Full,
    Closing,
}
impl Registry {
    pub fn new(options: Options) -> Self {
        Self {
            inner: Mutex::default(),
            options,
        }
    }
    pub fn options(&self) -> &Options {
        &self.options
    }
    /// Whether this server offers wake-ups at all.
    pub fn enabled(&self) -> bool {
        self.options.limit > 0
    }
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Every critical section leaves the map consistent, so a panic
        // elsewhere never makes it unusable.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// Waits parked right now.
    pub fn parked(&self) -> usize {
        self.lock().waiters.len()
    }
    /// Waits a flush has answered `changed:true` since startup.
    pub fn woken(&self) -> u64 {
        self.lock().woken
    }
    /// Whether this device's agent holds a wait right now, so a change reaches
    /// it within seconds. Only what the registry knows at this instant.
    pub fn listening(&self, device: &str) -> bool {
        self.lock()
            .waiters
            .get(device)
            .is_some_and(|waiter| waiter.answer.is_none())
    }
    /// The read-only `wake` projection of a device, or None when this server
    /// has wake-ups off.
    pub fn projection(&self, device: &str) -> Option<Value> {
        self.enabled()
            .then(|| json!({"listening": self.listening(device)}))
    }
    fn sequence(&self) -> u64 {
        self.lock().sequence
    }
    fn register(
        &self,
        device: &str,
        generation: i64,
        policy_generation: i64,
    ) -> std::result::Result<(Arc<str>, u64), Refusal> {
        let mut inner = self.lock();
        if inner.closed {
            return Err(Refusal::Closing);
        }
        inner.tickets += 1;
        let ticket = inner.tickets;
        let waiter = Waiter {
            ticket,
            generation,
            policy_generation,
            answer: None,
            waker: None,
        };
        if let Some((key, _)) = inner.waiters.get_key_value(device) {
            // One wait per device: the older one answers changed:false when
            // its body next polls and finds another ticket.
            let key = key.clone();
            let older = inner.waiters.insert(key.clone(), waiter);
            if let Some(waker) = older.and_then(|older| older.waker) {
                waker.wake();
            }
            return Ok((key, ticket));
        }
        if inner.waiters.len() >= self.options.limit {
            return Err(Refusal::Full);
        }
        let key: Arc<str> = Arc::from(device);
        inner.waiters.insert(key.clone(), waiter);
        Ok((key, ticket))
    }
    /// The answer for a parked body, or Pending with its task recorded.
    fn poll(&self, device: &str, ticket: u64, waker: &Waker) -> Poll<Answer> {
        let mut inner = self.lock();
        let Some(waiter) = inner.waiters.get_mut(device) else {
            return Poll::Ready(Answer::Unchanged);
        };
        if waiter.ticket != ticket {
            // A newer wait from the same device replaced this one.
            return Poll::Ready(Answer::Unchanged);
        }
        if let Some(answer) = waiter.answer {
            inner.waiters.remove(device);
            return Poll::Ready(answer);
        }
        if !waiter.waker.as_ref().is_some_and(|w| w.will_wake(waker)) {
            waiter.waker = Some(waker.clone());
        }
        Poll::Pending
    }
    /// The hold ended: the answer, if one arrived meanwhile, else unchanged.
    fn expire(&self, device: &str, ticket: u64) -> Answer {
        let mut inner = self.lock();
        match inner.waiters.get(device) {
            Some(waiter) if waiter.ticket == ticket => {
                let answer = waiter.answer.unwrap_or(Answer::Unchanged);
                inner.waiters.remove(device);
                answer
            }
            _ => Answer::Unchanged,
        }
    }
    /// The wait ended without an answer (the agent went away).
    fn cancel(&self, device: &str, ticket: u64) {
        let mut inner = self.lock();
        if inner
            .waiters
            .get(device)
            .is_some_and(|waiter| waiter.ticket == ticket)
        {
            inner.waiters.remove(device);
        }
    }
    /// Staged devices that have an unanswered wait, with what their agents
    /// last accepted. Advances the sequence first (see `Inner::sequence`).
    fn waiting_among(&self, devices: &[String]) -> Vec<(Arc<str>, u64, i64, i64)> {
        let mut inner = self.lock();
        inner.sequence += 1;
        devices
            .iter()
            .filter_map(|device| {
                let (key, waiter) = inner.waiters.get_key_value(device.as_str())?;
                waiter.answer.is_none().then(|| {
                    (
                        key.clone(),
                        waiter.ticket,
                        waiter.generation,
                        waiter.policy_generation,
                    )
                })
            })
            .collect()
    }
    fn answer(&self, device: &str, ticket: u64, answer: Answer) {
        let mut inner = self.lock();
        let Some(waiter) = inner.waiters.get_mut(device) else {
            return;
        };
        if waiter.ticket != ticket || waiter.answer.is_some() {
            return;
        }
        waiter.answer = Some(answer);
        let waker = waiter.waker.take();
        if answer == Answer::Changed {
            inner.woken += 1;
        }
        drop(inner);
        if let Some(waker) = waker {
            waker.wake();
        }
    }
    /// Shutdown: every parked wait answers `changed:false` now, and new waits
    /// are refused. Returns how many were answered.
    pub fn close(&self) -> usize {
        let mut inner = self.lock();
        inner.closed = true;
        let (mut answered, mut wakers) = (0, Vec::new());
        for waiter in inner.waiters.values_mut() {
            if waiter.answer.is_none() {
                waiter.answer = Some(Answer::Unchanged);
                answered += 1;
                wakers.extend(waiter.waker.take());
            }
        }
        drop(inner);
        for waker in wakers {
            waker.wake();
        }
        answered
    }
}

tokio::task_local! {
    /// Devices whose desired state the current request or scheduler tick may
    /// have changed.
    static STAGED: RefCell<Vec<String>>;
}

/// Records that this device's desired generation, policy generation or
/// access may change in the current writer transaction. Nothing happens until
/// the surrounding request or tick has finished (see `changes`); outside one,
/// for example in the offline maintenance tool, this does nothing.
pub fn stage(device: &str) {
    let _ = STAGED.try_with(|staged| staged.borrow_mut().push(device.to_owned()));
}

/// Runs a request or a scheduler tick, then answers the waits of the devices
/// whose committed desired state it changed. Its transactions have ended by
/// then, so rolled-back changes wake nobody.
pub async fn changes<F: Future>(s: &State, work: F) -> F::Output {
    let mut scoped = std::pin::pin!(STAGED.scope(RefCell::default(), work));
    let output = scoped.as_mut().await;
    let staged = scoped
        .as_mut()
        .take_value()
        .map(RefCell::into_inner)
        .unwrap_or_default();
    flush(s, staged).await;
    output
}

/// `changes` as a layer for both listeners' routers.
pub async fn middleware(AppState(s): AppState<State>, request: Request, next: Next) -> Response {
    changes(&s, next.run(request)).await
}

/// Answers the waits of staged devices whose committed desired generation or
/// policy generation differs from what their agent last accepted, or whose
/// access was revoked. One read for all of them, and none when no staged
/// device is waiting.
async fn flush(s: &State, mut devices: Vec<String>) {
    if devices.is_empty() || !s.wake.enabled() {
        return;
    }
    devices.sort_unstable();
    devices.dedup();
    let waiting = s.wake.waiting_among(&devices);
    if waiting.is_empty() {
        return;
    }
    let ids = json!(waiting.iter().map(|w| &*w.0).collect::<Vec<&str>>()).to_string();
    let rows: Vec<(String, i64, i64, bool)> = match sqlx::query_as(
        "SELECT d.id,d.desired_generation,d.policy_generation,d.revoked FROM json_each(?) w JOIN devices d ON d.id=w.value",
    )
    .bind(ids)
    .fetch_all(&s.pool)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            // The waits stay parked: each learns of the change within one
            // hold, when its agent waits again and the registration reads it.
            tracing::warn!(%error, "wake-up check failed");
            return;
        }
    };
    let current: HashMap<String, (i64, i64, bool)> = rows
        .into_iter()
        .map(|(id, generation, policy, revoked)| (id, (generation, policy, revoked)))
        .collect();
    for (device, ticket, generation, policy_generation) in waiting {
        // A revoked device checks in now and meets the ordinary refusal.
        let changed = current
            .get(&*device)
            .is_none_or(|&(g, p, revoked)| revoked || g != generation || p != policy_generation);
        if changed {
            s.wake.answer(&device, ticket, Answer::Changed);
        }
    }
}

/// The generations the agent last accepted, from `?generation=N&policy_generation=M`.
fn accepted(raw: Option<&str>) -> Result<(i64, i64)> {
    let invalid = || {
        ApiError::invalid(
            "Wait takes exactly generation and policy_generation, each a nonnegative safe integer",
        )
    };
    let (mut generation, mut policy) = (None, None);
    for pair in raw.unwrap_or("").split('&') {
        let (name, value) = pair.split_once('=').ok_or_else(invalid)?;
        let slot = match name {
            "generation" => &mut generation,
            "policy_generation" => &mut policy,
            _ => return Err(invalid()),
        };
        let number =
            (!value.is_empty() && value.len() <= 16 && value.bytes().all(|b| b.is_ascii_digit()))
                .then(|| value.parse::<i64>().ok())
                .flatten()
                .filter(|n| (0..=MAX_SAFE).contains(n))
                .ok_or_else(invalid)?;
        if slot.replace(number).is_some() {
            return Err(invalid());
        }
    }
    Ok((generation.ok_or_else(invalid)?, policy.ok_or_else(invalid)?))
}

/// The device a client certificate belongs to, with its current desired and
/// policy generations: the heartbeat's authentication and revocation check,
/// in one statement on a pooled connection that is returned at once.
async fn identify(s: &State, peer: &PeerCertificate) -> Result<(String, i64, i64)> {
    let fingerprint = peer.0.as_deref().ok_or_else(ApiError::unauthorized)?;
    sqlx::query_as("SELECT c.device_id,d.desired_generation,d.policy_generation FROM credentials c JOIN devices d ON d.id=c.device_id WHERE c.fingerprint=? AND c.revoked=0 AND d.revoked=0 AND c.expires_at>?")
        .bind(fingerprint)
        .bind(crate::db::now())
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(ApiError::unauthorized)
}

fn json_response(status: StatusCode, body: Vec<u8>) -> Response {
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// 503 with `Retry-After` and the same hint in the body: the agent keeps
/// checking in on its ordinary schedule and waits again later.
fn busy(message: &str, seconds: u64) -> Response {
    let body = json!({"error":{"code":"CAPACITY_BUSY","message":message},"retry_after":seconds});
    let mut response = json_response(StatusCode::SERVICE_UNAVAILABLE, body.to_string().into());
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
    response
}

/// `GET /agent/v1/wait?generation=N&policy_generation=M` (mTLS): held until
/// this device's desired or policy generation differs from the agent's last
/// accepted values, the device is revoked, or the hold ends.
pub async fn wait(
    AppState(s): AppState<State>,
    Extension(peer): Extension<PeerCertificate>,
    RawQuery(raw): RawQuery,
) -> Response {
    wait_inner(&s, &peer, raw.as_deref())
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn wait_inner(s: &State, peer: &PeerCertificate, raw: Option<&str>) -> Result<Response> {
    if !s.wake.enabled() {
        return Err(ApiError::missing());
    }
    let sequence = s.wake.sequence();
    let (device, generation, policy_generation) = identify(s, peer).await?;
    s.limit(
        format!("wait:{device}"),
        60,
        std::time::Duration::from_secs(60),
    )?;
    let (accepted_generation, accepted_policy) = accepted(raw)?;
    let changed =
        |generation, policy| generation != accepted_generation || policy != accepted_policy;
    if changed(generation, policy_generation) {
        return Ok(answered(Answer::Changed));
    }
    let (key, ticket) = match s
        .wake
        .register(&device, accepted_generation, accepted_policy)
    {
        Ok(registered) => registered,
        Err(Refusal::Full) => {
            return Ok(busy(
                "Too many agents are waiting; check in on schedule",
                BUSY_RETRY_SECONDS,
            ));
        }
        Err(Refusal::Closing) => {
            return Ok(busy(
                "The server is restarting; check in on schedule",
                CLOSING_RETRY_SECONDS,
            ));
        }
    };
    if s.wake.sequence() != sequence {
        // A flush ran while this wait authenticated, and may have looked for
        // the device before it registered: read it once more.
        match identify(s, peer).await {
            Ok((_, generation, policy)) if !changed(generation, policy) => {}
            Ok(_) => {
                s.wake.cancel(&device, ticket);
                return Ok(answered(Answer::Changed));
            }
            Err(error) => {
                s.wake.cancel(&device, ticket);
                return Err(error);
            }
        }
    }
    let body = WaitBody {
        state: s.clone(),
        device: key,
        ticket,
        deadline: Box::pin(tokio::time::sleep(s.wake.options.hold)),
        done: false,
    };
    let mut response = axum::body::Body::new(body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

fn answered(answer: Answer) -> Response {
    json_response(StatusCode::OK, answer.body().to_vec())
}

/// The body of a parked wait: one JSON frame once the answer is known. The
/// response head has already gone out.
struct WaitBody {
    state: State,
    device: Arc<str>,
    ticket: u64,
    deadline: Pin<Box<tokio::time::Sleep>>,
    done: bool,
}
impl hyper::body::Body for WaitBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, Self::Error>>> {
        let this = &mut *self;
        if this.done {
            return Poll::Ready(None);
        }
        let wake = &this.state.wake;
        let answer = match wake.poll(&this.device, this.ticket, cx.waker()) {
            Poll::Ready(answer) => answer,
            Poll::Pending => match this.deadline.as_mut().poll(cx) {
                Poll::Ready(()) => wake.expire(&this.device, this.ticket),
                Poll::Pending => return Poll::Pending,
            },
        };
        this.done = true;
        Poll::Ready(Some(Ok(Frame::data(Bytes::from_static(answer.body())))))
    }
    fn is_end_stream(&self) -> bool {
        self.done
    }
}
impl Drop for WaitBody {
    fn drop(&mut self) {
        if !self.done {
            self.state.wake.cancel(&self.device, self.ticket);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::Wake;

    struct Count(std::sync::atomic::AtomicUsize);
    impl Wake for Count {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    fn waker() -> (Arc<Count>, Waker) {
        let count = Arc::new(Count(Default::default()));
        (count.clone(), Waker::from(count))
    }
    fn woken(count: &Count) -> usize {
        count.0.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn query_takes_exactly_both_generations() {
        assert_eq!(
            accepted(Some("generation=3&policy_generation=0")).unwrap(),
            (3, 0)
        );
        assert_eq!(
            accepted(Some("policy_generation=9007199254740991&generation=1")).unwrap(),
            (1, MAX_SAFE)
        );
        for raw in [
            None,
            Some(""),
            Some("generation=1"),
            Some("generation=1&policy_generation=1&generation=2"),
            Some("generation=1&policy_generation=1&extra=1"),
            Some("generation=-1&policy_generation=1"),
            Some("generation=+1&policy_generation=1"),
            Some("generation=1.0&policy_generation=1"),
            Some("generation=9007199254740992&policy_generation=1"),
            Some("generation=&policy_generation=1"),
            Some("generation&policy_generation=1"),
        ] {
            assert!(accepted(raw).is_err(), "{raw:?}");
        }
    }

    #[test]
    fn one_waiter_per_device_and_a_bounded_registry() {
        let registry = Registry::new(Options {
            limit: 2,
            hold: Duration::from_secs(25),
        });
        let (older_count, older) = waker();
        let (key, first) = registry.register("a", 1, 1).ok().unwrap();
        assert!(registry.poll(&key, first, &older).is_pending());
        assert!(registry.listening("a"));
        // A newer wait replaces the older one, which is woken and answers
        // changed:false; the newer one keeps waiting.
        let (_, second) = registry.register("a", 1, 1).ok().unwrap();
        assert_eq!(woken(&older_count), 1);
        assert_eq!(
            registry.poll("a", first, &older),
            Poll::Ready(Answer::Unchanged)
        );
        assert!(registry.poll("a", second, &older).is_pending());
        assert_eq!(registry.parked(), 1);
        registry.register("b", 0, 0).ok().unwrap();
        assert!(matches!(registry.register("c", 0, 0), Err(Refusal::Full)));
        // Replacing an existing device's wait never needs more room.
        assert!(registry.register("b", 0, 0).is_ok());
        // A cancelled or expired older ticket never removes the newer wait.
        registry.cancel("a", first);
        assert_eq!(registry.expire("a", first), Answer::Unchanged);
        assert!(registry.listening("a"));
        registry.cancel("a", second);
        assert!(!registry.listening("a"));
        assert_eq!(registry.parked(), 1);
    }

    #[test]
    fn answers_once_and_close_answers_every_waiter() {
        let registry = Registry::new(Options::default());
        let (count, waker) = waker();
        let (_, ticket) = registry.register("a", 4, 2).ok().unwrap();
        assert!(registry.poll("a", ticket, &waker).is_pending());
        let waiting = registry.waiting_among(&["a".into(), "missing".into()]);
        assert_eq!(waiting.len(), 1);
        assert_eq!((waiting[0].2, waiting[0].3), (4, 2));
        registry.answer("a", ticket, Answer::Changed);
        registry.answer("a", ticket, Answer::Changed);
        assert_eq!((woken(&count), registry.woken()), (1, 1));
        assert!(!registry.listening("a"));
        assert!(registry.waiting_among(&["a".into()]).is_empty());
        assert_eq!(
            registry.poll("a", ticket, &waker),
            Poll::Ready(Answer::Changed)
        );
        assert_eq!(registry.parked(), 0);
        let (_, b) = registry.register("b", 0, 0).ok().unwrap();
        let (_, c) = registry.register("c", 0, 0).ok().unwrap();
        assert!(registry.poll("b", b, &waker).is_pending());
        assert_eq!(registry.close(), 2);
        assert_eq!(
            registry.poll("b", b, &waker),
            Poll::Ready(Answer::Unchanged)
        );
        assert_eq!(registry.expire("c", c), Answer::Unchanged);
        assert!(matches!(
            registry.register("d", 0, 0),
            Err(Refusal::Closing)
        ));
        assert_eq!(registry.parked(), 0);
    }
}
