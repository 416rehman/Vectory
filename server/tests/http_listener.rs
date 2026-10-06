//! The dashboard and API listener under slow, silent and numerous clients, and
//! what it still does for ordinary ones: serve requests, keep connections
//! alive, tell handlers the peer address and stop gracefully.
use axum::{
    Router,
    body::Bytes,
    extract::ConnectInfo,
    routing::{get, post},
};
use http_body_util::{BodyExt, Empty};
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde_json::Value;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{TcpSocket, TcpStream},
    task::JoinHandle,
};
use vectory_server::{
    Settings, State, api, device,
    http_listener::{AllowedPeers, Limits, Resolver, Timing, serve_on},
    initialize,
};

const SECRET: &str = "isolated-http-listener-secret-0123456789";

/// A listener as the server runs it, on a loopback port, with a way to stop it.
struct Listener {
    task: JoinHandle<anyhow::Result<()>>,
    address: SocketAddr,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Listener {
    fn stop(&mut self) {
        let _ = self.stop.take().map(|stop| stop.send(()));
    }
}
async fn listen(app: Router, limits: Limits) -> Listener {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(serve_on(listener, app, limits, None, async move {
        let _ = stopped.await;
    }));
    Listener {
        task,
        address,
        stop: Some(stop),
    }
}
/// Limits for a test: the timeouts a test names, and no cap in the way.
fn limits(header_seconds: u64, body_seconds: u64) -> Limits {
    Limits {
        header_timeout: Duration::from_secs(header_seconds),
        body_timeout: Duration::from_secs(body_seconds),
        max_connections: 4096,
    }
}
fn small_router() -> Router {
    Router::new()
        .route("/ping", get(|| async { "pong" }))
        .route(
            "/peer",
            get(|ConnectInfo(peer): ConnectInfo<SocketAddr>| async move { peer.to_string() }),
        )
        .route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(700)).await;
                "finished"
            }),
        )
        .route(
            "/length",
            post(|body: Bytes| async move { body.len().to_string() }),
        )
}

async fn state(root: &std::path::Path, trust_proxy_headers: bool) -> State {
    initialize(Settings {
        data_dir: root.join("state"),
        bootstrap_secret: SECRET.into(),
        cookie_secure: false,
        dashboard_dir: root.join("dist"),
        releases_dir: root.join("releases"),
        instance_name: "Listener".into(),
        trust_proxy_headers,
        ..Default::default()
    })
    .await
    .unwrap()
}

/// A raw HTTP/1.1 connection, so a test decides exactly what is sent and when.
struct Conn {
    stream: TcpStream,
    buffer: Vec<u8>,
    opened: Instant,
}
impl Conn {
    async fn open(address: SocketAddr) -> Self {
        Self {
            stream: TcpStream::connect(address).await.unwrap(),
            buffer: Vec::new(),
            opened: Instant::now(),
        }
    }
    /// A connection from another loopback address, where the machine has one.
    async fn open_from(address: SocketAddr, local: &str) -> Option<Self> {
        let socket = TcpSocket::new_v4().unwrap();
        socket
            .bind(SocketAddr::new(local.parse().unwrap(), 0))
            .ok()?;
        Some(Self {
            stream: socket.connect(address).await.ok()?,
            buffer: Vec::new(),
            opened: Instant::now(),
        })
    }
    async fn send(&mut self, bytes: &[u8]) {
        let _ = self.stream.write_all(bytes).await;
    }
    /// The next response: its status and body, or None when the connection
    /// ends first.
    async fn response(&mut self) -> Option<(u16, String)> {
        loop {
            if let Some(end) = self.buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&self.buffer[..end]).into_owned();
                let length = head
                    .lines()
                    .skip(1)
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                let total = end + 4 + length;
                if self.buffer.len() >= total {
                    let body = String::from_utf8_lossy(&self.buffer[end + 4..total]).into_owned();
                    let status = head.split_whitespace().nth(1)?.parse().ok()?;
                    self.buffer.drain(..total);
                    return Some((status, body));
                }
            }
            let mut chunk = [0u8; 4096];
            match tokio::time::timeout(Duration::from_secs(10), self.stream.read(&mut chunk)).await
            {
                Ok(Ok(read)) if read > 0 => self.buffer.extend_from_slice(&chunk[..read]),
                _ => return None,
            }
        }
    }
    /// When the server closed this connection, counted from when it opened,
    /// or None if it was still open `limit` after it opened.
    async fn closed_by(&mut self, limit: Duration) -> Option<Duration> {
        closed_by(&mut self.stream, self.opened, limit).await
    }
}
async fn closed_by(
    reader: &mut (impl AsyncRead + Unpin),
    opened: Instant,
    limit: Duration,
) -> Option<Duration> {
    let mut chunk = [0u8; 4096];
    loop {
        let left = limit.saturating_sub(opened.elapsed());
        match tokio::time::timeout(left, reader.read(&mut chunk)).await {
            Ok(Ok(0)) | Ok(Err(_)) => return Some(opened.elapsed()),
            Ok(Ok(_)) => continue,
            Err(_) => return None,
        }
    }
}

fn get_request(path: &str, extra_headers: &str) -> Vec<u8> {
    format!("GET {path} HTTP/1.1\r\nHost: vectory.test\r\n{extra_headers}\r\n").into_bytes()
}
fn post_request(path: &str, headers: &[(&str, &str)], body: &str) -> Vec<u8> {
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: vectory.test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    request.into_bytes()
}

#[tokio::test]
async fn a_request_and_a_keep_alive_sequence_are_served_over_http1_and_http2() {
    let temp = tempfile::tempdir().unwrap();
    let state = state(temp.path(), false).await;
    let server = listen(api::router(state), limits(5, 5)).await;

    // Several requests, one after another, on one connection.
    let mut conn = Conn::open(server.address).await;
    for _ in 0..3 {
        conn.send(&get_request("/api/v1/status", "")).await;
        let (status, body) = conn
            .response()
            .await
            .expect("a response on a live connection");
        assert_eq!(status, 200, "{body}");
        let status: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(status["initialized"], false);
    }
    // HTTP/2 over cleartext, as a client with prior knowledge speaks it.
    let stream = TcpStream::connect(server.address).await.unwrap();
    let (mut sender, connection) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(stream))
            .await
            .unwrap();
    tokio::spawn(connection);
    for _ in 0..2 {
        let request = hyper::Request::builder()
            .uri("http://vectory.test/api/v1/status")
            .body(Empty::<Bytes>::new())
            .unwrap();
        let response = sender.send_request(request).await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.version(), hyper::Version::HTTP_2);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["initialized"],
            false
        );
    }
}

#[tokio::test]
async fn sockets_that_never_finish_their_headers_are_closed_within_the_header_timeout() {
    let server = listen(small_router(), limits(2, 30)).await;
    let a_request = get_request("/ping", "");

    // Half a request, nothing at all, half an HTTP/2 preface, a whole one with
    // no request after it, and one request followed by silence.
    let mut stalled: Vec<(&str, Conn)> = Vec::new();
    for _ in 0..8 {
        let mut conn = Conn::open(server.address).await;
        conn.send(b"GET /ping HTTP/1.1\r\nHost: vectory.test\r\nX-Slow: ")
            .await;
        stalled.push(("half a request", conn));
    }
    for _ in 0..4 {
        stalled.push(("silence", Conn::open(server.address).await));
    }
    for _ in 0..4 {
        let mut conn = Conn::open(server.address).await;
        conn.send(b"PRI * HTTP/2.0\r\n").await;
        stalled.push(("half an HTTP/2 preface", conn));
    }
    for _ in 0..2 {
        let mut conn = Conn::open(server.address).await;
        conn.send(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n").await;
        conn.send(&[0, 0, 0, 4, 0, 0, 0, 0, 0]).await;
        stalled.push(("an HTTP/2 preface and settings, then nothing", conn));
    }
    let mut idle = Conn::open(server.address).await;
    idle.send(&a_request).await;
    assert_eq!(idle.response().await.unwrap(), (200, "pong".into()));

    // Nothing refuses them at once, and they do not hold up a normal request.
    tokio::time::sleep(Duration::from_millis(300)).await;
    for (what, conn) in &mut stalled {
        assert_eq!(
            conn.closed_by(Duration::from_millis(300)).await,
            None,
            "{what} was closed before the timeout"
        );
    }
    let mut normal = Conn::open(server.address).await;
    normal.send(&a_request).await;
    assert_eq!(normal.response().await.unwrap(), (200, "pong".into()));

    // Each is closed once the second is up, none long after.
    for (what, conn) in &mut stalled {
        let closed = conn.closed_by(Duration::from_secs(10)).await;
        let closed = closed.unwrap_or_else(|| panic!("{what} was still open after ten seconds"));
        assert!(
            closed >= Duration::from_millis(1800),
            "{what} was closed after {closed:?}"
        );
    }
    // A connection that answered a request and then sits idle is closed the
    // same way.
    let closed = idle
        .closed_by(Duration::from_secs(10))
        .await
        .expect("an idle keep-alive connection stayed open");
    assert!(closed >= Duration::from_millis(1800), "{closed:?}");
}

#[tokio::test]
async fn a_request_body_that_arrives_too_slowly_is_cut_off() {
    let server = listen(small_router(), limits(30, 2)).await;
    let head = "POST /length HTTP/1.1\r\nHost: vectory.test\r\n";

    // It stalls after a few bytes.
    let mut stalled = Conn::open(server.address).await;
    stalled
        .send(format!("{head}Content-Length: 1000\r\n\r\n0123456789").as_bytes())
        .await;

    // It trickles a byte every 300 ms, never silent for longer than the time
    // the whole body gets, declared by its length and then in chunks.
    let mut trickles = Vec::new();
    for framing in [
        "Content-Length: 100000\r\n\r\n",
        "Transfer-Encoding: chunked\r\n\r\n",
    ] {
        let mut conn = Conn::open(server.address).await;
        conn.send(format!("{head}{framing}").as_bytes()).await;
        let (opened, framed) = (conn.opened, framing.contains("chunked"));
        let (reader, mut writer) = conn.stream.into_split();
        let feeder = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let piece: &[u8] = if framed { b"1\r\nx\r\n" } else { b"x" };
                if writer.write_all(piece).await.is_err() {
                    break;
                }
            }
        });
        trickles.push((framing, opened, reader, feeder));
    }

    // A body that comes in two parts well inside the time, and a large one that
    // comes at once, are read in full.
    let mut in_two = Conn::open(server.address).await;
    in_two
        .send(format!("{head}Content-Length: 10\r\n\r\nhello").as_bytes())
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    in_two.send(b"world").await;
    assert_eq!(in_two.response().await.unwrap(), (200, "10".into()));
    let mut large = Conn::open(server.address).await;
    let body = "x".repeat(600_000);
    large
        .send(format!("{head}Content-Length: {}\r\n\r\n{body}", body.len()).as_bytes())
        .await;
    assert_eq!(large.response().await.unwrap(), (200, "600000".into()));

    let closed = stalled.closed_by(Duration::from_secs(10)).await;
    let closed = closed.expect("a stalled body was still open after ten seconds");
    assert!(closed >= Duration::from_millis(1800), "{closed:?}");
    for (framing, opened, mut reader, feeder) in trickles {
        let closed = closed_by(&mut reader, opened, Duration::from_secs(10)).await;
        feeder.abort();
        let closed =
            closed.unwrap_or_else(|| panic!("a trickling body ({framing:?}) was never cut off"));
        // Cut off by the deadline of the whole body, though it was never silent
        // for longer than 300 ms.
        assert!(
            closed >= Duration::from_millis(1800) && closed < Duration::from_secs(8),
            "a trickling body ({framing:?}) was cut off after {closed:?}"
        );
    }
}

#[tokio::test]
async fn a_body_cut_off_for_being_slow_answers_with_the_error_every_unreadable_body_gets() {
    let temp = tempfile::tempdir().unwrap();
    let state = state(temp.path(), false).await;
    let server = listen(api::router(state), limits(30, 1)).await;
    let mut conn = Conn::open(server.address).await;
    conn.send(
        b"POST /api/v1/password-reset HTTP/1.1\r\nHost: vectory.test\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"code\":",
    )
    .await;
    let (status, body) = conn.response().await.expect("an answer before it closed");
    assert_eq!(status, 400, "{body}");
    let error: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(error["error"]["code"], "INVALID_INPUT", "{body}");
    assert!(
        conn.closed_by(Duration::from_secs(5)).await.is_some(),
        "the connection stayed open after a body it could not read"
    );
}

#[tokio::test]
async fn connections_beyond_the_limit_are_closed_at_once_and_the_others_keep_working() {
    let server = listen(
        small_router(),
        Limits {
            max_connections: 4,
            ..limits(30, 30)
        },
    )
    .await;
    let mut held = Vec::new();
    for _ in 0..4 {
        let mut conn = Conn::open(server.address).await;
        conn.send(&get_request("/ping", "")).await;
        assert_eq!(conn.response().await.unwrap(), (200, "pong".into()));
        held.push(conn);
    }

    // The next ones connect and are closed without a word.
    for _ in 0..3 {
        let mut extra = Conn::open(server.address).await;
        extra.send(&get_request("/ping", "")).await;
        assert_eq!(extra.response().await, None);
        // At once, not after the 30 seconds an idle connection is given.
        let closed = extra.closed_by(Duration::from_secs(10)).await;
        assert!(
            closed.is_some_and(|closed| closed < Duration::from_secs(5)),
            "a connection beyond the limit was kept for {closed:?}"
        );
    }
    // The first four are untouched.
    for conn in &mut held {
        conn.send(&get_request("/ping", "")).await;
        assert_eq!(conn.response().await.unwrap(), (200, "pong".into()));
    }
    // When one goes, its place is free again.
    drop(held.pop());
    let mut served = None;
    for _ in 0..50 {
        let mut conn = Conn::open(server.address).await;
        conn.send(&get_request("/ping", "")).await;
        if let Some(response) = conn.response().await {
            served = Some(response);
            held.push(conn);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(served, Some((200, "pong".into())));
}

#[tokio::test]
async fn a_handler_sees_the_peer_that_connected() {
    let server = listen(small_router(), limits(5, 5)).await;
    let mut conn = Conn::open(server.address).await;
    let local = conn.stream.local_addr().unwrap();
    conn.send(&get_request("/peer", "")).await;
    assert_eq!(conn.response().await.unwrap(), (200, local.to_string()));
    // On every request of a kept-alive connection, and on a second connection.
    conn.send(&get_request("/peer", "")).await;
    assert_eq!(conn.response().await.unwrap(), (200, local.to_string()));
    let mut other = Conn::open(server.address).await;
    let other_local = other.stream.local_addr().unwrap();
    other.send(&get_request("/peer", "")).await;
    assert_eq!(
        other.response().await.unwrap(),
        (200, other_local.to_string())
    );
    assert_ne!(local, other_local);
}

/// A request that spends the caller's own budget and nothing else: a reset
/// code that cannot be right, answered 401 until the address's 30 a minute run
/// out and 429 after that.
async fn spend_one_try(mut conn: Conn, forwarded: Option<&str>) -> (u16, String) {
    let headers: Vec<(&str, &str)> = forwarded
        .map(|hop| ("X-Forwarded-For", hop))
        .into_iter()
        .collect();
    conn.send(&post_request(
        "/api/v1/password-reset",
        &headers,
        r#"{"code":"not-a-code","new_password":"a-long-enough-password"}"#,
    ))
    .await;
    conn.response().await.expect("an answer")
}
fn error_code(body: &str) -> String {
    serde_json::from_str::<Value>(body).unwrap()["error"]["code"]
        .as_str()
        .unwrap_or("")
        .to_owned()
}

#[tokio::test]
async fn throttling_is_keyed_by_the_connecting_peer_and_ignores_forwarded_headers_by_default() {
    let temp = tempfile::tempdir().unwrap();
    let state = state(temp.path(), false).await;
    let server = listen(api::router(state), limits(5, 5)).await;
    for attempt in 1..=30 {
        let (status, body) = spend_one_try(Conn::open(server.address).await, None).await;
        assert_eq!(
            (status, error_code(&body)),
            (401, "RESET_CODE_INVALID".into()),
            "try {attempt}"
        );
    }
    let (status, body) = spend_one_try(Conn::open(server.address).await, None).await;
    assert_eq!((status, error_code(&body)), (429, "RATE_LIMITED".into()));
    // A forwarded address does not give it a fresh budget: it is the peer's.
    let (status, body) =
        spend_one_try(Conn::open(server.address).await, Some("198.51.100.7")).await;
    assert_eq!(
        (status, error_code(&body)),
        (429, "RATE_LIMITED".into()),
        "{body}"
    );
    // Another peer has a budget of its own. (Not every machine has a second
    // loopback address.)
    match Conn::open_from(server.address, "127.0.0.2").await {
        Some(other) => {
            let (status, body) = spend_one_try(other, None).await;
            assert_eq!(
                (status, error_code(&body)),
                (401, "RESET_CODE_INVALID".into()),
                "a second peer shared the first one's budget"
            );
        }
        None => eprintln!("skipped the second peer: no 127.0.0.2 on this machine"),
    }
}

#[tokio::test]
async fn behind_a_trusted_proxy_throttling_is_keyed_by_the_last_forwarded_hop() {
    let temp = tempfile::tempdir().unwrap();
    let state = state(temp.path(), true).await;
    let server = listen(api::router(state), limits(5, 5)).await;
    let hop = "203.0.113.50, 198.51.100.7";
    for attempt in 1..=30 {
        let (status, body) = spend_one_try(Conn::open(server.address).await, Some(hop)).await;
        assert_eq!(
            (status, error_code(&body)),
            (401, "RESET_CODE_INVALID".into()),
            "try {attempt}"
        );
    }
    let (status, body) = spend_one_try(Conn::open(server.address).await, Some(hop)).await;
    assert_eq!((status, error_code(&body)), (429, "RATE_LIMITED".into()));
    // Another forwarded client, and the proxy's own address (no header), each
    // have budgets of their own: the header chose the key, not the peer.
    for forwarded in [Some("198.51.100.8"), None] {
        let (status, body) = spend_one_try(Conn::open(server.address).await, forwarded).await;
        assert_eq!(
            (status, error_code(&body)),
            (401, "RESET_CODE_INVALID".into()),
            "{forwarded:?}"
        );
    }
}

#[tokio::test]
async fn shutdown_finishes_a_request_in_flight_and_closes_idle_connections() {
    let mut server = listen(small_router(), limits(30, 30)).await;
    let mut idle = Conn::open(server.address).await;
    idle.send(&get_request("/ping", "")).await;
    assert_eq!(idle.response().await.unwrap(), (200, "pong".into()));
    let mut busy = Conn::open(server.address).await;
    busy.send(&get_request("/slow", "")).await;
    tokio::time::sleep(Duration::from_millis(150)).await;

    server.stop();
    assert!(
        idle.closed_by(Duration::from_secs(3)).await.is_some(),
        "an idle connection outlived the shutdown"
    );
    assert_eq!(busy.response().await.unwrap(), (200, "finished".into()));
    assert!(
        busy.closed_by(Duration::from_secs(5)).await.is_some(),
        "the connection stayed open after the last request of a shutdown"
    );
    let ended = tokio::time::timeout(Duration::from_secs(5), server.task)
        .await
        .expect("the listener did not return after its connections ended")
        .unwrap();
    assert!(ended.is_ok(), "{ended:?}");
    assert!(
        TcpStream::connect(server.address).await.is_err(),
        "a stopped listener accepted a connection"
    );
}

/// A listener whose first accepts fail with the errors it is given, as when a
/// descriptor limit is reached or a connection is aborted.
struct Failing {
    listener: tokio::net::TcpListener,
    errors: std::collections::VecDeque<std::io::Error>,
}
impl device::Accept for Failing {
    fn accept(
        &mut self,
    ) -> impl std::future::Future<
        Output = std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)>,
    > + Send {
        async move {
            if let Some(error) = self.errors.pop_front() {
                return Err(error);
            }
            self.listener.accept().await
        }
    }
}

#[tokio::test]
async fn failed_accepts_are_waited_out_and_the_listener_keeps_serving() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    #[cfg(unix)]
    let shortage = || std::io::Error::from_raw_os_error(24);
    #[cfg(not(unix))]
    let shortage = || std::io::Error::other("too many open files");
    let errors = [
        shortage(),
        std::io::Error::from(std::io::ErrorKind::ConnectionAborted),
        shortage(),
        shortage(),
    ];
    let task = tokio::spawn(serve_on(
        Failing {
            listener,
            errors: errors.into(),
        },
        small_router(),
        limits(5, 5),
        None,
        std::future::pending(),
    ));
    for _ in 0..2 {
        let mut conn = Conn::open(address).await;
        conn.send(&get_request("/ping", "")).await;
        assert_eq!(conn.response().await.unwrap(), (200, "pong".into()));
        assert!(
            !task.is_finished(),
            "the listener ended after a failed accept"
        );
    }
    task.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn a_listener_that_can_never_accept_again_ends_with_its_reason() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    // EMFILE, then EBADF: the descriptor is not an open socket.
    let errors = [
        std::io::Error::from_raw_os_error(24),
        std::io::Error::from_raw_os_error(9),
    ];
    let task = tokio::spawn(serve_on(
        Failing {
            listener,
            errors: errors.into(),
        },
        small_router(),
        limits(5, 5),
        None,
        std::future::pending(),
    ));
    let ended = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("an unusable listener kept running")
        .unwrap();
    let error = ended.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("the dashboard listener cannot accept connections"),
        "{error:#}"
    );
}

/// A listener that reports each connection as coming from the peer a test
/// names, as when it is another machine: every connection a test makes is
/// loopback, which is always allowed. With no peer named, the real one is
/// reported.
struct Claiming {
    listener: tokio::net::TcpListener,
    claimed: Arc<Mutex<Option<SocketAddr>>>,
}
impl device::Accept for Claiming {
    fn accept(
        &mut self,
    ) -> impl std::future::Future<
        Output = std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)>,
    > + Send {
        async move {
            let (stream, real) = self.listener.accept().await?;
            let claimed = *self.claimed.lock().unwrap();
            Ok((stream, claimed.unwrap_or(real)))
        }
    }
}
#[derive(Clone)]
struct Claim(Arc<Mutex<Option<SocketAddr>>>);
impl Claim {
    fn peer(&self, peer: Option<&str>) {
        *self.0.lock().unwrap() =
            peer.map(|peer| SocketAddr::new(peer.parse::<IpAddr>().unwrap(), 50000));
    }
}
async fn listen_claiming(
    app: Router,
    limits: Limits,
    allowed: Option<Arc<AllowedPeers>>,
) -> (Listener, Claim) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let claimed = Arc::new(Mutex::new(None));
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(serve_on(
        Claiming {
            listener,
            claimed: claimed.clone(),
        },
        app,
        limits,
        allowed,
        async move {
            let _ = stopped.await;
        },
    ));
    (
        Listener {
            task,
            address,
            stop: Some(stop),
        },
        Claim(claimed),
    )
}

/// Whether a connection from `peer` is served. A connection that is not is
/// closed without a single byte.
async fn served_as(server: &Listener, claim: &Claim, peer: &str) -> bool {
    claim.peer(Some(peer));
    let mut conn = Conn::open(server.address).await;
    conn.send(&get_request("/peer", "")).await;
    match conn.response().await {
        Some((200, body)) => {
            let seen: SocketAddr = body.parse().unwrap();
            assert_eq!(seen.ip(), peer.parse::<IpAddr>().unwrap(), "{peer}");
            true
        }
        None => {
            assert!(
                conn.buffer.is_empty(),
                "{peer} was refused with a response: {:?}",
                String::from_utf8_lossy(&conn.buffer)
            );
            assert!(
                conn.closed_by(Duration::from_secs(1)).await.is_some(),
                "{peer} was refused but left open"
            );
            false
        }
        other => panic!("{peer} got {other:?}"),
    }
}
async fn eventually_served_as(server: &Listener, claim: &Claim, peer: &str) -> bool {
    let started = Instant::now();
    loop {
        if served_as(server, claim, peer).await {
            return true;
        }
        if started.elapsed() > Duration::from_secs(4) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Host name answers a test decides and can change between lookups. A name
/// with no answer fails to resolve.
#[derive(Clone, Default)]
struct Scripted(Arc<Mutex<HashMap<String, Vec<IpAddr>>>>);
impl Scripted {
    fn set(&self, name: &str, addresses: &[&str]) {
        let mut answers = self.0.lock().unwrap();
        if addresses.is_empty() {
            answers.remove(name);
        } else {
            answers.insert(
                name.into(),
                addresses.iter().map(|a| a.parse().unwrap()).collect(),
            );
        }
    }
}
impl Resolver for Scripted {
    async fn resolve(&self, name: &str) -> std::io::Result<Vec<IpAddr>> {
        self.0
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| std::io::Error::other("no such host"))
    }
}
fn quickly() -> Timing {
    Timing {
        refresh: Duration::from_millis(150),
        retry: Duration::from_millis(150),
        min_gap: Duration::from_millis(20),
        lookup_timeout: Duration::from_secs(1),
    }
}

#[tokio::test]
async fn a_peer_that_is_not_allowed_is_closed_without_a_response() {
    let allowed = AllowedPeers::parse(Some("10.1.0.0/16, 192.0.2.7, 2001:db8::/32"))
        .unwrap()
        .unwrap()
        .start(Scripted::default(), Timing::default())
        .await;
    let (server, claim) = listen_claiming(small_router(), limits(30, 30), Some(allowed)).await;
    for (peer, allowed) in [
        ("10.1.2.3", true),
        ("10.2.0.1", false),
        ("192.0.2.7", true),
        ("192.0.2.8", false),
        ("2001:db8::7", true),
        ("2001:4860::1", false),
        ("::ffff:10.1.9.9", true),
        ("::ffff:10.2.9.9", false),
        ("172.18.0.3", false),
        // Loopback, whatever the list says: the image's own health check.
        ("127.0.0.1", true),
        ("127.8.8.8", true),
        ("::1", true),
        ("::ffff:127.0.0.1", true),
    ] {
        assert_eq!(served_as(&server, &claim, peer).await, allowed, "{peer}");
    }
    // A connection that really comes from loopback is served too.
    claim.peer(None);
    let mut conn = Conn::open(server.address).await;
    conn.send(&get_request("/ping", "")).await;
    assert_eq!(conn.response().await.unwrap(), (200, "pong".into()));
}

#[tokio::test]
async fn an_unset_or_empty_setting_changes_nothing() {
    for value in [None, Some(""), Some("   ")] {
        assert!(AllowedPeers::parse(value).unwrap().is_none(), "{value:?}");
    }
    let (server, claim) = listen_claiming(small_router(), limits(30, 30), None).await;
    for peer in ["192.0.2.7", "10.2.0.1", "2001:4860::1", "127.0.0.1"] {
        assert!(served_as(&server, &claim, peer).await, "{peer}");
    }
}

#[tokio::test]
async fn a_host_name_is_looked_up_again_and_a_failed_lookup_keeps_the_last_addresses() {
    let script = Scripted::default();
    script.set("proxy", &["10.2.0.1"]);
    let allowed = AllowedPeers::parse(Some("proxy"))
        .unwrap()
        .unwrap()
        .start(script.clone(), quickly())
        .await;
    let (server, claim) = listen_claiming(small_router(), limits(30, 30), Some(allowed)).await;
    // Resolved before the first connection is accepted.
    assert!(served_as(&server, &claim, "10.2.0.1").await);
    assert!(!served_as(&server, &claim, "10.2.0.9").await);

    // The proxy container is replaced and has another address.
    script.set("proxy", &["10.2.0.9"]);
    assert!(eventually_served_as(&server, &claim, "10.2.0.9").await);
    assert!(!served_as(&server, &claim, "10.2.0.1").await);

    // Lookups fail from now on: the last addresses stay allowed.
    script.set("proxy", &[]);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(served_as(&server, &claim, "10.2.0.9").await);
    assert!(!served_as(&server, &claim, "10.2.0.1").await);

    // And they work again.
    script.set("proxy", &["10.2.0.5"]);
    assert!(eventually_served_as(&server, &claim, "10.2.0.5").await);
    assert!(!served_as(&server, &claim, "10.2.0.9").await);
}

#[tokio::test]
async fn a_name_with_no_address_allows_nobody_until_a_refused_connection_finds_one() {
    let script = Scripted::default();
    // Both timers are far off: only a refused connection can prompt the lookup.
    let timing = Timing {
        refresh: Duration::from_secs(300),
        retry: Duration::from_secs(300),
        ..quickly()
    };
    let allowed = AllowedPeers::parse(Some("proxy, 192.0.2.0/24"))
        .unwrap()
        .unwrap()
        .start(script.clone(), timing)
        .await;
    let (server, claim) = listen_claiming(small_router(), limits(30, 30), Some(allowed)).await;
    // Startup did not fail. The listener fails closed: loopback and the other
    // entries are served, and nobody the name would have allowed.
    assert!(!served_as(&server, &claim, "10.2.0.1").await);
    assert!(served_as(&server, &claim, "192.0.2.50").await);
    assert!(served_as(&server, &claim, "127.0.0.1").await);

    script.set("proxy", &["10.2.0.1"]);
    assert!(
        eventually_served_as(&server, &claim, "10.2.0.1").await,
        "a refused connection did not prompt a lookup"
    );
}
