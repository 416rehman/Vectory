//! The dashboard and API listener.
//!
//! It speaks plain HTTP for a TLS reverse proxy to reach, and bounds every
//! connection the way the agent listener does, so a client that is silent or
//! slow costs a socket for a few seconds and nothing else:
//!
//! - a connection has `header_timeout` to deliver its first request's headers,
//!   whatever protocol it speaks, and an HTTP/1 connection has as long between
//!   requests: it is closed when it sits idle for that long;
//! - a request's body has `body_timeout` to arrive in full, however steadily
//!   it trickles;
//! - at most `max_connections` are served at once. A connection beyond that is
//!   closed at once, and the ones already served are not disturbed;
//! - a failed `accept` is logged, waited out and retried, and only a socket
//!   that can never accept again ends the listener;
//! - where `VECTORY_HTTP_ALLOWED_PEERS` names the peers that may connect, a
//!   connection from any other is closed at once, before it is read or counted.
//!
//! Requests reach the router with their peer address as `ConnectInfo`, exactly
//! as they did when `axum::serve` served the router with connect info.
use crate::device::{Accept, AcceptFailure, AcceptTrouble, accept_failure};
use axum::{Router, body::Body, extract::ConnectInfo};
use hyper::body::{Body as HttpBody, Frame, Incoming, SizeHint};
use hyper_util::{
    rt::{TokioExecutor, TokioIo, TokioTimer},
    server::conn::auto,
    service::TowerToHyperService,
};
use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::{Pin, pin},
    sync::{Arc, RwLock, Weak},
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::{
    sync::{Notify, Semaphore, watch},
    task::JoinSet,
    time::Sleep,
};
use tower::ServiceBuilder;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

pub const HEADER_TIMEOUT_VARIABLE: &str = "VECTORY_HTTP_HEADER_TIMEOUT_SECONDS";
pub const BODY_TIMEOUT_VARIABLE: &str = "VECTORY_HTTP_BODY_TIMEOUT_SECONDS";
pub const CONNECTIONS_VARIABLE: &str = "VECTORY_MAX_HTTP_CONNECTIONS";
pub const ALLOWED_PEERS_VARIABLE: &str = "VECTORY_HTTP_ALLOWED_PEERS";

/// How the listener bounds what one client can take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// How long a client has to deliver the start line and headers of a
    /// request, counted from when it connects or its last response ends.
    pub header_timeout: Duration,
    /// How long a request's body has to arrive in full once its headers have.
    pub body_timeout: Duration,
    /// Connections served at once.
    pub max_connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            header_timeout: Duration::from_secs(15),
            body_timeout: Duration::from_secs(30),
            max_connections: 4096,
        }
    }
}

impl Limits {
    /// The limits the environment names: a variable left unset or blank keeps
    /// its default, a whole number is brought into the variable's range, and
    /// anything else is an error that names the variable.
    pub fn from_values(
        header_timeout: Option<String>,
        body_timeout: Option<String>,
        max_connections: Option<String>,
    ) -> anyhow::Result<Self> {
        let default = Self::default();
        Ok(Self {
            header_timeout: Duration::from_secs(bounded(
                HEADER_TIMEOUT_VARIABLE,
                header_timeout,
                default.header_timeout.as_secs(),
                1..=120,
            )?),
            body_timeout: Duration::from_secs(bounded(
                BODY_TIMEOUT_VARIABLE,
                body_timeout,
                default.body_timeout.as_secs(),
                1..=300,
            )?),
            max_connections: bounded(
                CONNECTIONS_VARIABLE,
                max_connections,
                default.max_connections as u64,
                64..=65536,
            )? as usize,
        })
    }
}

fn bounded(
    variable: &str,
    value: Option<String>,
    default: u64,
    range: std::ops::RangeInclusive<u64>,
) -> anyhow::Result<u64> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(default);
    };
    let number = value.trim().parse::<u64>().map_err(|_| {
        anyhow::anyhow!(
            "{variable} must be a whole number from {} to {}",
            range.start(),
            range.end()
        )
    })?;
    Ok(number.clamp(*range.start(), *range.end()))
}

/// The error a request body ends with when it did not arrive in time.
#[derive(Debug)]
struct BodyTimedOut;
impl std::fmt::Display for BodyTimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the request body did not arrive in time")
    }
}
impl std::error::Error for BodyTimedOut {}

/// A request body that must arrive within one deadline, set when its request
/// does. A body that stalls is cut off, and so is one that trickles in a byte
/// at a time: the time is for the whole body, not for each read. Whatever has
/// already arrived is passed on, so the deadline only ends a wait for more.
struct WithinTime<B> {
    body: B,
    deadline: Pin<Box<Sleep>>,
}

impl<B> HttpBody for WithinTime<B>
where
    B: HttpBody + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = B::Data;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match Pin::new(&mut self.body).poll_frame(cx) {
            Poll::Ready(frame) => Poll::Ready(frame.map(|frame| frame.map_err(Into::into))),
            Poll::Pending => match self.deadline.as_mut().poll(cx) {
                Poll::Ready(()) => Poll::Ready(Some(Err(Box::new(BodyTimedOut)))),
                Poll::Pending => Poll::Pending,
            },
        }
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

/// A request's body for the router. One that has none needs no deadline.
fn bounded_body(body: Incoming, timeout: Duration) -> Body {
    if body.is_end_stream() {
        return Body::new(body);
    }
    Body::new(WithinTime {
        body,
        deadline: Box::pin(tokio::time::sleep(timeout)),
    })
}

/// How often the log hears of a kind of event that can go on as long as an
/// attack does: the first at once, then at most one line an interval.
struct Throttled {
    every: Duration,
    unreported: u64,
    reported: Option<Instant>,
}
impl Throttled {
    fn new(every: Duration) -> Self {
        Self {
            every,
            unreported: 0,
            reported: None,
        }
    }
    /// Note one event. When a line is due, says how many events it covers: the
    /// ones since the last line, this one included.
    fn note(&mut self, now: Instant) -> Option<u64> {
        self.unreported += 1;
        if self
            .reported
            .is_none_or(|at| now.duration_since(at) >= self.every)
        {
            self.reported = Some(now);
            Some(std::mem::take(&mut self.unreported))
        } else {
            None
        }
    }
}

/// One entry of `VECTORY_HTTP_ALLOWED_PEERS`: an address, or a range of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Range {
    network: IpAddr,
    prefix: u8,
}
impl Range {
    /// `10.0.0.5`, `10.0.0.0/8`, `fd00::2` or `fd00::/8`. Bits of the address
    /// beyond the prefix are ignored.
    fn parse(entry: &str) -> Option<Self> {
        let (address, prefix) = match entry.split_once('/') {
            Some((address, prefix)) => (address.parse::<IpAddr>().ok()?, Some(prefix)),
            // A single address is matched the way peers are: canonically.
            None => (entry.parse::<IpAddr>().ok()?.to_canonical(), None),
        };
        let bits = if address.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(prefix) => prefix.parse::<u8>().ok().filter(|prefix| *prefix <= bits)?,
            None => bits,
        };
        Some(Self {
            network: masked(address, prefix),
            prefix,
        })
    }
    fn contains(&self, address: IpAddr) -> bool {
        address.is_ipv4() == self.network.is_ipv4() && masked(address, self.prefix) == self.network
    }
}
fn masked(address: IpAddr, prefix: u8) -> IpAddr {
    match address {
        IpAddr::V4(address) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
            IpAddr::V4(Ipv4Addr::from(u32::from(address) & mask))
        }
        IpAddr::V6(address) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
            IpAddr::V6(Ipv6Addr::from(u128::from(address) & mask))
        }
    }
}

/// A DNS name: dot-separated labels of letters, digits, `-` and `_`. A string
/// of only digits and dots is a mistyped address, not a name.
fn is_host_name(entry: &str) -> bool {
    let numeric = entry.bytes().all(|b| b.is_ascii_digit() || b == b'.');
    !numeric
        && entry.len() <= 253
        && entry.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// Looks a host name up. The server asks the system's resolver; a test scripts
/// the answers.
pub trait Resolver: Send + Sync + 'static {
    fn resolve(&self, name: &str) -> impl Future<Output = std::io::Result<Vec<IpAddr>>> + Send;
}
/// The system's resolver: in a Compose network, Docker's.
pub struct SystemResolver;
impl Resolver for SystemResolver {
    async fn resolve(&self, name: &str) -> std::io::Result<Vec<IpAddr>> {
        Ok(tokio::net::lookup_host((name, 0))
            .await?
            .map(|address| address.ip().to_canonical())
            .collect())
    }
}

/// How often host names are looked up again.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// Between lookups while every name has addresses.
    pub refresh: Duration,
    /// Between lookups while some name has none yet, as when the proxy starts
    /// after the server.
    pub retry: Duration,
    /// At the least between two lookups, however many connections are refused
    /// and ask for one.
    pub min_gap: Duration,
    /// How long a lookup may take before it counts as failed.
    pub lookup_timeout: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            refresh: Duration::from_secs(30),
            retry: Duration::from_secs(2),
            min_gap: Duration::from_secs(1),
            lookup_timeout: Duration::from_secs(5),
        }
    }
}

/// The peers `VECTORY_HTTP_ALLOWED_PEERS` lets connect: addresses and ranges as
/// given, and what each host name last resolved to. Loopback is always allowed,
/// so the image's own health check keeps working.
pub struct AllowedPeers {
    ranges: Vec<Range>,
    names: Vec<String>,
    /// What each name resolved to the last time a lookup found anything, in
    /// the order of `names`, and whether its latest lookup failed.
    resolved: RwLock<Vec<(Vec<IpAddr>, bool)>>,
    /// Asks the refresher to look the names up now.
    lookup_now: Notify,
}

impl AllowedPeers {
    /// The peers a setting names, or None when it is unset or blank (every peer
    /// may connect). An entry that is not an address, a range or a host name is
    /// an error that names it.
    pub fn parse(value: Option<&str>) -> anyhow::Result<Option<Self>> {
        let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
            return Ok(None);
        };
        let (mut ranges, mut names) = (Vec::new(), Vec::<String>::new());
        for entry in value
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
        {
            if let Some(range) = Range::parse(entry) {
                ranges.push(range);
            } else if is_host_name(entry) {
                let name = entry.to_ascii_lowercase();
                if !names.contains(&name) {
                    names.push(name);
                }
            } else {
                anyhow::bail!(
                    "{ALLOWED_PEERS_VARIABLE} has the entry {entry:?}, which is not an IP address, a CIDR range such as 10.0.0.0/8 or a host name"
                );
            }
        }
        if ranges.is_empty() && names.is_empty() {
            anyhow::bail!("{ALLOWED_PEERS_VARIABLE} names no address, range or host name");
        }
        let resolved = RwLock::new(vec![(Vec::new(), false); names.len()]);
        Ok(Some(Self {
            ranges,
            names,
            resolved,
            lookup_now: Notify::new(),
        }))
    }

    /// Looks the host names up once, says so when one has no address, and keeps
    /// them fresh from then on. A name that cannot be resolved allows nobody
    /// until it can: the listener fails closed, and tries again.
    pub async fn start<R: Resolver>(self, resolver: R, timing: Timing) -> Arc<Self> {
        let peers = Arc::new(self);
        if !peers.names.is_empty() {
            let resolver = Arc::new(resolver);
            peers.look_up(&resolver, timing.lookup_timeout).await;
            let missing = peers.unresolved();
            if !missing.is_empty() {
                tracing::warn!(
                    "{ALLOWED_PEERS_VARIABLE} names {}, but no address was found for {} yet. Until one is, the HTTP listener refuses the peers {} would have allowed: it accepts loopback and the other entries only. The server looks again every {:?}, and whenever it refuses a connection.",
                    missing.join(", "),
                    if missing.len() == 1 { "it" } else { "them" },
                    if missing.len() == 1 { "it" } else { "they" },
                    timing.retry
                );
            }
            tokio::spawn(keep_fresh(Arc::downgrade(&peers), resolver, timing));
        }
        tracing::info!("{}", peers.describe());
        peers
    }

    /// Whether `address` may connect: loopback, a listed address or range, or
    /// an address a listed name last resolved to.
    pub fn allows(&self, address: IpAddr) -> bool {
        let address = address.to_canonical();
        address.is_loopback()
            || self.ranges.iter().any(|range| range.contains(address))
            || self
                .resolved
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .any(|(found, _)| found.contains(&address))
    }

    /// A connection was refused: a host name may have a new address, so look
    /// the names up soon.
    fn refused(&self) {
        if !self.names.is_empty() {
            self.lookup_now.notify_one();
        }
    }

    /// The host names that have no address yet.
    fn unresolved(&self) -> Vec<&str> {
        let resolved = self
            .resolved
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.names
            .iter()
            .zip(resolved.iter())
            .filter(|(_, (found, _))| found.is_empty())
            .map(|(name, _)| name.as_str())
            .collect()
    }

    fn describe(&self) -> String {
        let resolved = self
            .resolved
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut allowed = vec!["loopback".to_owned()];
        allowed.extend(self.ranges.iter().map(|range| {
            let full = if range.network.is_ipv4() { 32 } else { 128 };
            if range.prefix == full {
                range.network.to_string()
            } else {
                format!("{}/{}", range.network, range.prefix)
            }
        }));
        allowed.extend(
            self.names
                .iter()
                .zip(resolved.iter())
                .map(|(name, (found, _))| {
                    let found: Vec<String> = found.iter().map(IpAddr::to_string).collect();
                    format!(
                        "{name} ({})",
                        if found.is_empty() {
                            "no address yet".into()
                        } else {
                            found.join(", ")
                        }
                    )
                }),
        );
        format!(
            "the HTTP listener accepts connections only from {}",
            allowed.join(", ")
        )
    }

    /// Looks every name up at once. A name whose lookup fails, times out or
    /// finds nothing keeps the addresses of the last lookup that found some.
    async fn look_up<R: Resolver>(&self, resolver: &Arc<R>, timeout: Duration) {
        let mut lookups = JoinSet::new();
        for (index, name) in self.names.iter().enumerate() {
            let (resolver, name) = (resolver.clone(), name.clone());
            lookups.spawn(async move {
                let found = tokio::time::timeout(timeout, resolver.resolve(&name)).await;
                (index, found)
            });
        }
        while let Some(done) = lookups.join_next().await {
            let Ok((index, found)) = done else { continue };
            let name = &self.names[index];
            let mut resolved = self
                .resolved
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let (kept, failing) = &mut resolved[index];
            match found {
                Ok(Ok(mut found)) if !found.is_empty() => {
                    found.sort();
                    found.dedup();
                    if *kept != found {
                        tracing::info!(name, addresses = ?found, "{ALLOWED_PEERS_VARIABLE}: the name now resolves to these addresses");
                        *kept = found;
                    } else if *failing {
                        tracing::info!(
                            name,
                            "{ALLOWED_PEERS_VARIABLE}: lookups of the name work again"
                        );
                    }
                    *failing = false;
                }
                other => {
                    if !*failing && !kept.is_empty() {
                        let reason = match other {
                            Ok(Err(error)) => error.to_string(),
                            Err(_) => "the lookup timed out".to_owned(),
                            _ => "the name has no address".to_owned(),
                        };
                        tracing::warn!(
                            name,
                            reason,
                            "{ALLOWED_PEERS_VARIABLE}: the lookup failed; keeping the addresses it found last"
                        );
                    }
                    *failing = true;
                }
            }
        }
    }
}

/// Looks the names up again: every `refresh`, every `retry` while one has no
/// address, and soon after a connection is refused, but never more often than
/// `min_gap`. Ends when the listener that holds the peers is gone.
async fn keep_fresh<R: Resolver>(peers: Weak<AllowedPeers>, resolver: Arc<R>, timing: Timing) {
    let mut last = Instant::now();
    loop {
        let Some(strong) = peers.upgrade() else {
            return;
        };
        let wait = if strong.unresolved().is_empty() {
            timing.refresh
        } else {
            timing.retry
        };
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = strong.lookup_now.notified() => {}
        }
        if let Some(rest) = timing.min_gap.checked_sub(last.elapsed()) {
            tokio::time::sleep(rest).await;
        }
        last = Instant::now();
        strong.look_up(&resolver, timing.lookup_timeout).await;
    }
}

/// Serves `app` on connections from `listener` until `shutdown` completes, then
/// stops accepting, lets each connection finish its request and returns once the
/// last one has. A server that never stops passes a future that never completes.
/// With `allowed` set, a connection from any other peer is closed as soon as it
/// is accepted: before anything is read from it, and without counting toward the
/// limit. Returns an error only when the listener can never accept again.
pub async fn serve_on<A: Accept>(
    mut listener: A,
    app: Router,
    limits: Limits,
    allowed: Option<Arc<AllowedPeers>>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let mut builder = auto::Builder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(limits.header_timeout);
    // A peer that stops answering pings is gone; an HTTP/2 connection with
    // nothing to say is not otherwise timed after its first request.
    builder
        .http2()
        .timer(TokioTimer::new())
        .keep_alive_interval(limits.header_timeout)
        .keep_alive_timeout(limits.header_timeout);
    let builder = Arc::new(builder);
    let connections = Arc::new(Semaphore::new(limits.max_connections));
    let (stop, stopped) = watch::channel(false);
    let mut trouble = AcceptTrouble::new("the dashboard listener");
    let mut at_capacity = Throttled::new(Duration::from_secs(10));
    let mut not_allowed = Throttled::new(Duration::from_secs(60));
    let mut shutdown = pin!(shutdown);
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = &mut shutdown => break,
        };
        let (socket, address) = match accepted {
            Ok(accepted) => {
                trouble.accepted();
                accepted
            }
            Err(error) => match accept_failure(&error) {
                AcceptFailure::Skip => continue,
                AcceptFailure::Pause => {
                    let pause = trouble.failed(&error, Instant::now());
                    tokio::time::sleep(pause).await;
                    continue;
                }
                AcceptFailure::Unusable => {
                    return Err(anyhow::Error::new(error)
                        .context("the dashboard listener cannot accept connections"));
                }
            },
        };
        if let Some(peers) = &allowed {
            if !peers.allows(address.ip()) {
                if let Some(refused) = not_allowed.note(Instant::now()) {
                    tracing::warn!(
                        peer = %address.ip().to_canonical(),
                        refused,
                        "the dashboard listener closed a connection from a peer that {ALLOWED_PEERS_VARIABLE} does not allow; it reports this at most once a minute"
                    );
                }
                peers.refused();
                continue;
            }
        }
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            if let Some(refused) = at_capacity.note(Instant::now()) {
                tracing::warn!(
                    limit = limits.max_connections,
                    refused,
                    "the dashboard listener is at its connection limit; closing new connections until others finish"
                );
            }
            continue;
        };
        let (builder, app, stopped) = (builder.clone(), app.clone(), stopped.clone());
        tokio::spawn(async move {
            let _permit = permit;
            let _ = socket.set_nodelay(true);
            serve_connection(&builder, socket, address, app, limits, stopped).await;
        });
    }
    // Stop accepting at once, tell every connection to finish its request and
    // close, and wait for the last of them: each holds a permit.
    drop(listener);
    let _ = stop.send(true);
    let _ = connections
        .acquire_many(limits.max_connections as u32)
        .await;
    Ok(())
}

/// One connection, until it ends or is closed for being too slow.
async fn serve_connection(
    builder: &auto::Builder<TokioExecutor>,
    socket: tokio::net::TcpStream,
    address: SocketAddr,
    app: Router,
    limits: Limits,
    mut stopped: watch::Receiver<bool>,
) {
    let first_request = Arc::new(Notify::new());
    let arrived = first_request.clone();
    let service = TowerToHyperService::new(
        ServiceBuilder::new()
            .map_request(move |mut request: hyper::Request<Incoming>| {
                arrived.notify_one();
                request.extensions_mut().insert(ConnectInfo(address));
                request.map(|body| bounded_body(body, limits.body_timeout))
            })
            .service(app),
    );
    let connection = builder.serve_connection(TokioIo::new(socket), service);
    let mut connection = pin!(connection);
    // Whichever protocol the client speaks, it must get a whole request in
    // before this: a client that sends nothing, half a request line or half an
    // HTTP/2 preface is not otherwise timed.
    let first_headers = tokio::time::sleep(limits.header_timeout);
    let mut first_headers = pin!(first_headers);
    let mut waiting = true;
    let mut draining = false;
    loop {
        tokio::select! {
            _ = connection.as_mut() => return,
            () = &mut first_headers, if waiting => return,
            () = first_request.notified(), if waiting => waiting = false,
            _ = stopped.changed(), if !draining => {
                draining = true;
                connection.as_mut().graceful_shutdown();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(header: &str, body: &str, connections: &str) -> anyhow::Result<Limits> {
        Limits::from_values(
            Some(header.into()),
            Some(body.into()),
            Some(connections.into()),
        )
    }

    #[test]
    fn limits_default_when_unset_or_blank() {
        let default = Limits::default();
        assert_eq!(
            (
                default.header_timeout.as_secs(),
                default.body_timeout.as_secs(),
                default.max_connections
            ),
            (15, 30, 4096)
        );
        assert_eq!(Limits::from_values(None, None, None).unwrap(), default);
        assert_eq!(limits("", " ", "\t").unwrap(), default);
    }

    #[test]
    fn limits_take_whole_numbers_and_clamp_them_to_their_ranges() {
        let set = limits(" 5 ", "90", "1000").unwrap();
        assert_eq!(
            (
                set.header_timeout.as_secs(),
                set.body_timeout.as_secs(),
                set.max_connections
            ),
            (5, 90, 1000)
        );
        let low = limits("0", "0", "1").unwrap();
        assert_eq!(
            (
                low.header_timeout.as_secs(),
                low.body_timeout.as_secs(),
                low.max_connections
            ),
            (1, 1, 64)
        );
        let high = limits("121", "301", "65537").unwrap();
        assert_eq!(
            (
                high.header_timeout.as_secs(),
                high.body_timeout.as_secs(),
                high.max_connections
            ),
            (120, 300, 65536)
        );
        assert_eq!(
            limits("18446744073709551615", "30", "4096")
                .unwrap()
                .header_timeout
                .as_secs(),
            120
        );
    }

    #[test]
    fn a_value_that_is_not_a_whole_number_names_its_variable() {
        for value in ["fast", "1.5", "-1", "1e3", "15s", "18446744073709551616"] {
            for (index, variable) in [
                HEADER_TIMEOUT_VARIABLE,
                BODY_TIMEOUT_VARIABLE,
                CONNECTIONS_VARIABLE,
            ]
            .into_iter()
            .enumerate()
            {
                let mut values = [None, None, None];
                values[index] = Some(value.to_owned());
                let [header, body, connections] = values;
                let error = Limits::from_values(header, body, connections).unwrap_err();
                assert!(
                    error.to_string().starts_with(variable),
                    "{variable}={value}: {error}"
                );
            }
        }
    }

    fn peers(value: &str) -> AllowedPeers {
        AllowedPeers::parse(Some(value)).unwrap().unwrap()
    }
    fn ip(address: &str) -> IpAddr {
        address.parse().unwrap()
    }

    #[test]
    fn a_throttled_event_is_reported_at_once_and_then_once_an_interval() {
        let start = Instant::now();
        let mut throttled = Throttled::new(Duration::from_secs(60));
        assert_eq!(throttled.note(start), Some(1));
        assert_eq!(throttled.note(start + Duration::from_secs(1)), None);
        assert_eq!(throttled.note(start + Duration::from_secs(59)), None);
        assert_eq!(throttled.note(start + Duration::from_secs(60)), Some(3));
        assert_eq!(throttled.note(start + Duration::from_secs(61)), None);
        assert_eq!(throttled.note(start + Duration::from_secs(121)), Some(2));
    }

    #[test]
    fn an_unset_or_blank_setting_allows_every_peer() {
        for value in [None, Some(""), Some("  \t ")] {
            assert!(AllowedPeers::parse(value).unwrap().is_none(), "{value:?}");
        }
    }

    #[test]
    fn addresses_ranges_and_host_names_are_told_apart() {
        let allowed = peers(
            " 192.0.2.7, 10.1.0.0/16 ,fd00::2, 2001:db8:5::/48 ,Proxy, caddy.internal ,, proxy ",
        );
        assert_eq!(allowed.ranges.len(), 4);
        // Names are lowercased and listed once.
        assert_eq!(allowed.names, ["proxy", "caddy.internal"]);
        // Bits beyond the prefix are ignored.
        let wide = Range::parse("10.77.8.9/8").unwrap();
        assert_eq!((wide.network, wide.prefix), (ip("10.0.0.0"), 8));
        assert_eq!(Range::parse("10.0.0.0/0").unwrap().network, ip("0.0.0.0"));
        assert!(Range::parse("10.0.0.1/32").is_some() && Range::parse("::/128").is_some());
        for entry in [
            "10.0.0.0/33",
            "::/129",
            "10.0.0.0/",
            "10.0.0.0/-1",
            "10.0.0.0/x",
            "10.0.0/8",
            "proxy/24",
            "",
        ] {
            assert!(Range::parse(entry).is_none(), "{entry:?}");
        }
    }

    #[test]
    fn an_entry_that_is_none_of_those_names_itself() {
        for entry in [
            "1.2.3.4.5",
            "10.0.0",
            "10.0.0.0/33",
            "fd00:::1",
            "fe80::1%eth0",
            "pro xy",
            "http://proxy",
            "proxy:8080",
            "-proxy",
            "proxy-",
            "pro..xy",
            "caddy/24",
        ] {
            let error = AllowedPeers::parse(Some(&format!("proxy,{entry}")))
                .err()
                .unwrap_or_else(|| panic!("{entry:?} was accepted"));
            let message = error.to_string();
            assert!(
                message.starts_with(ALLOWED_PEERS_VARIABLE)
                    && message.contains(&format!("{entry:?}")),
                "{entry:?}: {message}"
            );
        }
        let error = AllowedPeers::parse(Some(" , ,")).err().unwrap();
        assert!(
            error.to_string().starts_with(ALLOWED_PEERS_VARIABLE),
            "{error}"
        );
    }

    #[test]
    fn loopback_is_always_allowed_and_everything_else_only_if_listed() {
        let allowed = peers("192.0.2.7, 10.1.0.0/16, 2001:db8:5::/48");
        for address in [
            "127.0.0.1",
            "127.8.8.8",
            "::1",
            "::ffff:127.0.0.1",
            "192.0.2.7",
            "::ffff:192.0.2.7",
            "10.1.0.0",
            "10.1.255.255",
            "::ffff:10.1.2.3",
            "2001:db8:5::1",
            "2001:db8:5:ffff::9",
        ] {
            assert!(allowed.allows(ip(address)), "{address}");
        }
        for address in [
            "192.0.2.8",
            "10.2.0.1",
            "10.0.255.255",
            "::ffff:10.2.0.1",
            "2001:db8:6::1",
            "2001:4860::1",
            "172.18.0.3",
            "0.0.0.0",
            "::",
        ] {
            assert!(!allowed.allows(ip(address)), "{address}");
        }
        // A name allows nobody until it resolves.
        assert!(!peers("proxy").allows(ip("172.18.0.3")));
        assert!(peers("proxy").allows(ip("127.0.0.1")));
        assert!(peers("10.0.0.0/0").allows(ip("203.0.113.9")));
        assert!(!peers("10.0.0.0/0").allows(ip("2001:db8::1")));
    }

    #[tokio::test]
    async fn the_system_resolver_finds_localhost() {
        let found = SystemResolver.resolve("localhost").await.unwrap();
        assert!(
            found.iter().any(|address| address.is_loopback()),
            "{found:?}"
        );
    }
}
