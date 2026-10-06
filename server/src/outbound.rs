//! Outbound delivery for notifications: the one place the control plane opens
//! connections to an address an administrator typed.
//!
//! Every attempt resolves the host itself, checks every resolved address and
//! connects only to an address it just checked, so an answer that changes
//! between a save and a send (DNS rebinding) is judged at connect time. Public
//! addresses are allowed; private ones (RFC 1918, CGNAT, unique local, and
//! this server's loopback) only when the channel explicitly allows them;
//! link-local, multicast, unspecified, reserved and cloud metadata addresses
//! never. HTTPS is required unless the address is private; redirects are
//! never followed; responses are read to a small cap; every step has a
//! deadline (connect 5 s, whole attempt 10 s). Credentials never travel in a
//! URL, and no URL path, query or secret ever appears in an error.
use hyper::body::Bytes;
use rustls::pki_types::{CertificateDer, ServerName};
use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::Pin,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};

/// Connecting to one resolved address may take this long.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// A whole attempt, from resolving to the last byte read, may take this long.
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
/// Bytes of a receiver's response body that are read (for its error text).
pub const RESPONSE_CAP: usize = 4096;
/// Longest error text kept for the delivery log.
pub const ERROR_CAP: usize = 500;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How the server finds and reaches a receiver. The system dialer uses the
/// operating system's resolver and plain TCP; tests substitute a scripted one.
pub trait Dialer: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, std::io::Result<Vec<SocketAddr>>>;
    fn connect(&self, address: SocketAddr) -> BoxFuture<'_, std::io::Result<TcpStream>>;
}
pub struct SystemDialer;
impl Dialer for SystemDialer {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, std::io::Result<Vec<SocketAddr>>> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, port)).await?.collect()) })
    }
    fn connect(&self, address: SocketAddr) -> BoxFuture<'_, std::io::Result<TcpStream>> {
        Box::pin(TcpStream::connect(address))
    }
}

/// Test seams. Production leaves both empty: the system dialer and the
/// public web PKI roots.
#[derive(Clone, Default)]
pub struct Options {
    pub dialer: Option<Arc<dyn Dialer>>,
    /// Extra trusted roots (DER), for tests with a local TLS receiver.
    pub extra_roots: Vec<Vec<u8>>,
}
impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options")
            .field("custom_dialer", &self.dialer.is_some())
            .field("extra_roots", &self.extra_roots.len())
            .finish()
    }
}
impl Options {
    fn dialer(&self) -> Arc<dyn Dialer> {
        self.dialer
            .clone()
            .unwrap_or_else(|| Arc::new(SystemDialer))
    }
}

/// Where an address sits for delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    Public,
    /// Reachable only with "Allow private network addresses". The text names
    /// the kind of address.
    Private(&'static str),
    /// Never contacted.
    Forbidden(&'static str),
}
const METADATA: &str = "a cloud metadata address";

pub fn classify(ip: IpAddr) -> Reach {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}
fn classify_v4(ip: Ipv4Addr) -> Reach {
    let [a, b, c, _] = ip.octets();
    if ip == Ipv4Addr::new(100, 100, 100, 200)
        || ip == Ipv4Addr::new(192, 0, 0, 192)
        || ip == Ipv4Addr::new(168, 63, 129, 16)
    {
        // Alibaba Cloud and Oracle Cloud instance metadata, and Azure's
        // platform address (the WireServer), which every Azure VM reaches and
        // which is not link-local.
        return Reach::Forbidden(METADATA);
    }
    match (a, b, c) {
        (0, _, _) => Reach::Forbidden("an unspecified address"),
        (127, _, _) => Reach::Private("a loopback address"),
        (10, _, _) | (192, 168, _) => Reach::Private("a private address"),
        (172, 16..=31, _) => Reach::Private("a private address"),
        (100, 64..=127, _) => Reach::Private("a shared (CGNAT) address"),
        (198, 18..=19, _) => Reach::Private("a private address"),
        // Includes 169.254.169.254 (AWS, Azure, GCP and others) and
        // 169.254.170.2 (container task metadata).
        (169, 254, _) => Reach::Forbidden(METADATA),
        (192, 0, 0) => Reach::Forbidden("a reserved address"),
        (192, 0, 2) | (198, 51, 100) | (203, 0, 113) => Reach::Forbidden("a documentation address"),
        (224..=239, _, _) => Reach::Forbidden("a multicast address"),
        (240..=255, _, _) => Reach::Forbidden("a reserved address"),
        _ => Reach::Public,
    }
}
fn classify_v6(ip: Ipv6Addr) -> Reach {
    let s = ip.segments();
    if ip.is_unspecified() {
        return Reach::Forbidden("an unspecified address");
    }
    if ip.is_loopback() {
        return Reach::Private("a loopback address");
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        return classify_v4(v4);
    }
    let embedded = |high: u16, low: u16| {
        Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
    };
    match s {
        // IPv4-compatible (deprecated) and other ::/96 forms.
        [0, 0, 0, 0, 0, 0, _, _] => Reach::Forbidden("a reserved address"),
        // NAT64 well-known prefix: judge the IPv4 address inside.
        [0x64, 0xff9b, 0, 0, 0, 0, high, low] => classify_v4(embedded(high, low)),
        [0x64, 0xff9b, 1, ..] => Reach::Private("a private address"),
        [0x100, 0, 0, 0, ..] => Reach::Forbidden("a reserved address"),
        [0x2001, 0xdb8, ..] => Reach::Forbidden("a documentation address"),
        // Teredo tunnels hide the address they reach.
        [0x2001, 0, ..] => Reach::Forbidden("a reserved address"),
        // 6to4: judge the IPv4 address inside.
        [0x2002, high, low, ..] => classify_v4(embedded(high, low)),
        // AWS instance metadata (fd00:ec2::254) and pod identity (fd00:ec2::23).
        [0xfd00, 0x0ec2, ..] => Reach::Forbidden(METADATA),
        [first, ..] if first & 0xfe00 == 0xfc00 => Reach::Private("a private address"),
        [first, ..] if first & 0xffc0 == 0xfe80 => Reach::Forbidden("a link-local address"),
        [first, ..] if first & 0xffc0 == 0xfec0 => Reach::Private("a private address"),
        [first, ..] if first & 0xff00 == 0xff00 => Reach::Forbidden("a multicast address"),
        _ => Reach::Public,
    }
}

/// Why a send cannot go out, in words for the delivery log.
#[derive(Debug, Clone)]
pub struct Failure {
    pub message: String,
    /// Worth another attempt later: the network, not the configuration.
    pub retryable: bool,
}
fn failure(message: impl Into<String>, retryable: bool) -> Failure {
    Failure {
        message: message.into(),
        retryable,
    }
}

/// Check one address against a channel's policy.
pub fn permitted(ip: IpAddr, allow_private: bool) -> Result<(), String> {
    refusal(ip, allow_private, None).map_or(Ok(()), Err)
}
/// Why an address is refused, naming the host it came from when there is one.
fn refusal(ip: IpAddr, allow_private: bool, host: Option<&str>) -> Option<String> {
    let subject = match host {
        Some(host) => format!("{host} resolves to {ip},"),
        None => format!("{ip} is"),
    };
    match classify(ip) {
        Reach::Public => None,
        Reach::Private(_) if allow_private => None,
        Reach::Private(kind) => Some(format!(
            "{subject} {kind}. Turn on Allow private network addresses to send there."
        )),
        Reach::Forbidden(kind) => Some(format!("{subject} {kind}, which Vectory never contacts.")),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
}
/// A parsed, checked webhook URL. Only the host is ever shown or logged.
#[derive(Clone, Debug)]
pub struct Destination {
    pub scheme: Scheme,
    /// Domain (IDNA-normalized) or IP address, without brackets.
    pub host: String,
    pub port: u16,
    /// The Host header value.
    pub authority: String,
    /// Origin-form request target: path and query. Treated as a secret.
    pub target: String,
}

pub const MAX_URL_LENGTH: usize = 2048;
/// Parse and check a webhook URL before it is saved or used.
pub fn webhook_destination(input: &str, allow_private: bool) -> Result<Destination, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Enter the webhook URL.".into());
    }
    if input.len() > MAX_URL_LENGTH || input.chars().any(|c| c.is_control() || c == ' ') {
        return Err(format!(
            "Enter a URL of at most {MAX_URL_LENGTH} characters, without spaces."
        ));
    }
    let url = url::Url::parse(input)
        .map_err(|_| "Enter a full URL such as https://hooks.example.com/…".to_owned())?;
    let scheme = match url.scheme() {
        "https" => Scheme::Https,
        "http" if allow_private => Scheme::Http,
        "http" => {
            return Err(
                "Use an https:// URL. Plain http:// works only for private addresses, with Allow private network addresses on."
                    .into(),
            );
        }
        _ => return Err("Use an https:// URL.".into()),
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(
            "Remove the user name and password from the URL. Put credentials in the header value instead."
                .into(),
        );
    }
    if url.fragment().is_some() {
        return Err("Remove the #fragment from the URL.".into());
    }
    let host = match url.host() {
        Some(url::Host::Domain(domain)) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            if domain.is_empty() {
                return Err("The URL needs a host name.".into());
            }
            if !allow_private && (domain == "localhost" || domain.ends_with(".localhost")) {
                return Err(
                    "localhost is this server's loopback address. Turn on Allow private network addresses to send there."
                        .into(),
                );
            }
            domain
        }
        Some(url::Host::Ipv4(ip)) => {
            permitted(IpAddr::V4(ip), allow_private)?;
            ip.to_string()
        }
        Some(url::Host::Ipv6(ip)) => {
            permitted(IpAddr::V6(ip), allow_private)?;
            ip.to_string()
        }
        None => return Err("The URL needs a host name.".into()),
    };
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "The URL needs a port.".to_owned())?;
    let authority = match (url.host(), url.port()) {
        (Some(url::Host::Ipv6(ip)), Some(port)) => format!("[{ip}]:{port}"),
        (Some(url::Host::Ipv6(ip)), None) => format!("[{ip}]"),
        (_, Some(port)) => format!("{host}:{port}"),
        (_, None) => host.clone(),
    };
    let mut target = url.path().to_owned();
    if target.is_empty() {
        target.push('/');
    }
    if let Some(query) = url.query() {
        target.push('?');
        target.push_str(query);
    }
    Ok(Destination {
        scheme,
        host,
        port,
        authority,
        target,
    })
}
/// What the API shows for a saved URL: its origin, never its path or query,
/// which often carry the receiver's secret (Slack's do).
pub fn url_hint(destination: &Destination) -> String {
    let scheme = match destination.scheme {
        Scheme::Http => "http",
        Scheme::Https => "https",
    };
    let rest = if destination.target == "/" { "" } else { "…" };
    format!("{scheme}://{}/{rest}", destination.authority)
}

/// Resolve and check where to connect. Every address a name resolves to must
/// be allowed; one forbidden or disallowed private answer refuses the send.
async fn reach(
    options: &Options,
    host: &str,
    port: u16,
    allow_private: bool,
    plaintext: Plaintext,
) -> Result<Vec<SocketAddr>, Failure> {
    let addresses = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => {
            let answer =
                tokio::time::timeout(CONNECT_TIMEOUT, options.dialer().resolve(host, port))
                    .await
                    .map_err(|_| failure(format!("Looking up {host} timed out."), true))?
                    .map_err(|_| failure(format!("Couldn't resolve {host}."), true))?;
            if answer.is_empty() {
                return Err(failure(format!("{host} has no addresses."), true));
            }
            answer
        }
    };
    for address in &addresses {
        let named = host.parse::<IpAddr>().is_err().then_some(host);
        if let Some(reason) = refusal(address.ip(), allow_private, named) {
            return Err(failure(reason, false));
        }
        let loopback = is_loopback(address.ip());
        let private = matches!(classify(address.ip()), Reach::Private(_));
        match plaintext {
            Plaintext::No => {}
            Plaintext::PrivateOnly if !private => {
                return Err(failure(
                    format!(
                        "{host} is a public address. Plain http:// only reaches private addresses; use https://."
                    ),
                    false,
                ));
            }
            Plaintext::LoopbackOnly if !loopback => {
                return Err(failure(
                    format!(
                        "{host} isn't this server's loopback address. Unencrypted email only goes to a relay on this server; choose STARTTLS or TLS."
                    ),
                    false,
                ));
            }
            _ => {}
        }
    }
    Ok(addresses)
}
fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Plaintext {
    No,
    PrivateOnly,
    LoopbackOnly,
}
/// Connect to the first checked address that answers.
async fn connect(
    options: &Options,
    host: &str,
    addresses: &[SocketAddr],
) -> Result<TcpStream, Failure> {
    let dialer = options.dialer();
    let mut last = None;
    for address in addresses {
        match tokio::time::timeout(CONNECT_TIMEOUT, dialer.connect(*address)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(error)) => {
                last = Some(match error.kind() {
                    std::io::ErrorKind::ConnectionRefused => {
                        format!("Connection refused by {host} ({address}).")
                    }
                    _ => format!(
                        "Couldn't connect to {host} ({address}): {}.",
                        io_reason(&error)
                    ),
                })
            }
            Err(_) => {
                last = Some(format!(
                    "Timed out connecting to {host} ({address}) after {} s.",
                    CONNECT_TIMEOUT.as_secs()
                ))
            }
        }
    }
    Err(failure(
        last.unwrap_or_else(|| format!("Couldn't connect to {host}.")),
        true,
    ))
}
fn io_reason(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::ConnectionReset => "the connection was reset".into(),
        std::io::ErrorKind::ConnectionAborted => "the connection was aborted".into(),
        std::io::ErrorKind::TimedOut => "timed out".into(),
        std::io::ErrorKind::UnexpectedEof => "the connection closed early".into(),
        std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::NetworkUnreachable => {
            "the network is unreachable".into()
        }
        std::io::ErrorKind::HostUnreachable => "the host is unreachable".into(),
        _ => bounded(&error.to_string(), 120),
    }
}

fn tls_config(options: &Options) -> Result<Arc<rustls::ClientConfig>, Failure> {
    static DEFAULT: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    let build = |extra: &[Vec<u8>]| -> Result<Arc<rustls::ClientConfig>, Failure> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        for der in extra {
            roots
                .add(CertificateDer::from(der.clone()))
                .map_err(|_| failure("A trusted root certificate is invalid.", false))?;
        }
        let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| failure("TLS is unavailable.", false))?
        .with_root_certificates(roots)
        .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(config))
    };
    if options.extra_roots.is_empty() {
        if let Some(config) = DEFAULT.get() {
            return Ok(config.clone());
        }
        let config = build(&[])?;
        let _ = DEFAULT.set(config.clone());
        return Ok(config);
    }
    build(&options.extra_roots)
}
async fn tls(
    options: &Options,
    host: &str,
    stream: TcpStream,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, Failure> {
    let name = ServerName::try_from(host.to_owned())
        .map_err(|_| failure(format!("{host} isn't a valid TLS server name."), false))?;
    tokio_rustls::TlsConnector::from(tls_config(options)?)
        .connect(name, stream)
        .await
        .map_err(|error| {
            failure(
                format!(
                    "TLS handshake with {host} failed: {}.",
                    bounded(&error.to_string(), 160)
                ),
                true,
            )
        })
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// The result of one delivery attempt.
#[derive(Clone, Debug)]
pub struct Outcome {
    pub delivered: bool,
    /// HTTP status, or the SMTP reply code of a refusal.
    pub status: Option<u16>,
    pub latency_ms: u64,
    pub error: Option<String>,
    pub retryable: bool,
}
impl Outcome {
    fn failed(started: Instant, status: Option<u16>, failure: Failure, secrets: &[String]) -> Self {
        Outcome {
            delivered: false,
            status,
            latency_ms: elapsed(started),
            error: Some(redact(&failure.message, secrets)),
            retryable: failure.retryable,
        }
    }
}
fn elapsed(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Replace every secret in a text, then bound it: the delivery log never
/// shows a credential, even one a receiver echoed back.
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_owned();
    for secret in secrets.iter().filter(|s| s.len() >= 4) {
        out = out.replace(secret.as_str(), "«redacted»");
    }
    bounded(&out, ERROR_CAP)
}
fn bounded(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_owned()
    } else {
        let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}
/// A receiver's response body as one short printable line.
fn snippet(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let line: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    bounded(&line, 160)
}

pub struct HttpMessage<'a> {
    pub destination: &'a Destination,
    pub allow_private: bool,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// Values to strike from any error text (URL path, header value, secret).
    pub secrets: Vec<String>,
}

/// POST one JSON message and report exactly what happened.
pub async fn post(options: &Options, message: HttpMessage<'_>) -> Outcome {
    let started = Instant::now();
    let secrets = message.secrets.clone();
    match tokio::time::timeout(TOTAL_TIMEOUT, post_inner(options, &message, started)).await {
        Ok(Ok(outcome)) => Outcome {
            error: outcome.error.map(|e| redact(&e, &secrets)),
            ..outcome
        },
        Ok(Err(failure)) => Outcome::failed(started, None, failure, &secrets),
        Err(_) => Outcome::failed(
            started,
            None,
            failure(
                format!(
                    "{} didn't answer within {} s.",
                    message.destination.host,
                    TOTAL_TIMEOUT.as_secs()
                ),
                true,
            ),
            &secrets,
        ),
    }
}
async fn post_inner(
    options: &Options,
    message: &HttpMessage<'_>,
    started: Instant,
) -> Result<Outcome, Failure> {
    use http_body_util::BodyExt;
    let d = message.destination;
    let plaintext = if d.scheme == Scheme::Http {
        Plaintext::PrivateOnly
    } else {
        Plaintext::No
    };
    if d.scheme == Scheme::Http && !message.allow_private {
        return Err(failure(
            "Plain http:// needs Allow private network addresses.",
            false,
        ));
    }
    let addresses = reach(options, &d.host, d.port, message.allow_private, plaintext).await?;
    let stream = connect(options, &d.host, &addresses).await?;
    let io: Box<dyn Stream> = match d.scheme {
        Scheme::Https => Box::new(tls(options, &d.host, stream).await?),
        Scheme::Http => Box::new(stream),
    };
    let (mut sender, connection) = hyper::client::conn::http1::handshake::<
        _,
        http_body_util::Full<Bytes>,
    >(hyper_util::rt::TokioIo::new(io))
    .await
    .map_err(|_| failure(format!("{} closed the connection.", d.host), true))?;
    let driver = tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut request = hyper::Request::builder()
        .method(hyper::Method::POST)
        .uri(d.target.as_str())
        .header(hyper::header::HOST, d.authority.as_str())
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .header(hyper::header::CONNECTION, "close");
    for (name, value) in &message.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let request = request
        .body(http_body_util::Full::new(Bytes::from(message.body.clone())))
        .map_err(|_| {
            failure(
                "The request couldn't be built. Check the header name and value.",
                false,
            )
        })?;
    let result = sender.send_request(request).await;
    let response = match result {
        Ok(response) => response,
        Err(_) => {
            driver.abort();
            return Err(failure(
                format!("{} closed the connection before answering.", d.host),
                true,
            ));
        }
    };
    let status = response.status();
    let mut body = response.into_body();
    let mut read = Vec::new();
    while read.len() < RESPONSE_CAP {
        match body.frame().await {
            Some(Ok(frame)) => {
                if let Some(data) = frame.data_ref() {
                    let room = RESPONSE_CAP - read.len();
                    read.extend_from_slice(&data[..data.len().min(room)]);
                }
            }
            Some(Err(_)) | None => break,
        }
    }
    drop(body);
    driver.abort();
    let code = status.as_u16();
    if status.is_success() {
        return Ok(Outcome {
            delivered: true,
            status: Some(code),
            latency_ms: elapsed(started),
            error: None,
            retryable: false,
        });
    }
    let reason = status.canonical_reason().unwrap_or("");
    let said = snippet(&read);
    let error = if status.is_redirection() {
        format!(
            "The receiver answered {code} {reason}, a redirect. Vectory doesn't follow redirects; use the final URL."
        )
    } else if said.is_empty() {
        format!("The receiver answered {code} {reason}.")
    } else {
        format!("The receiver answered {code} {reason}: {said}")
    };
    Ok(Outcome {
        delivered: false,
        status: Some(code),
        latency_ms: elapsed(started),
        error: Some(error.replace("  ", " ")),
        retryable: code == 408 || code == 425 || code == 429 || status.is_server_error(),
    })
}

/// How an SMTP connection is protected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmtpSecurity {
    /// Plain connection upgraded with STARTTLS; refused if the server can't.
    StartTls,
    /// TLS from the first byte (usually port 465).
    Tls,
    /// No encryption: only to a relay on this server's loopback address.
    None,
}
impl SmtpSecurity {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "starttls" => Some(Self::StartTls),
            "tls" => Some(Self::Tls),
            "none" => Some(Self::None),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StartTls => "starttls",
            Self::Tls => "tls",
            Self::None => "none",
        }
    }
}
pub struct EmailMessage<'a> {
    pub host: &'a str,
    pub port: u16,
    pub security: SmtpSecurity,
    pub allow_private: bool,
    pub username: Option<&'a str>,
    pub password: Option<&'a str>,
    pub from: &'a str,
    pub to: &'a [String],
    pub subject: &'a str,
    pub body: &'a str,
}

/// A TLS stream lettre can speak SMTP over.
struct SmtpTls(tokio_rustls::client::TlsStream<TcpStream>);
impl std::fmt::Debug for SmtpTls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SmtpTls")
    }
}
impl AsyncRead for SmtpTls {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}
impl AsyncWrite for SmtpTls {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}
impl lettre::transport::smtp::client::AsyncTokioStream for SmtpTls {
    fn peer_addr(&self) -> std::io::Result<SocketAddr> {
        self.0.get_ref().0.peer_addr()
    }
}

/// Send one plain-text email and report exactly what happened.
pub async fn email(options: &Options, message: EmailMessage<'_>) -> Outcome {
    let started = Instant::now();
    let secrets: Vec<String> = message.password.map(str::to_owned).into_iter().collect();
    match tokio::time::timeout(TOTAL_TIMEOUT, email_inner(options, &message, started)).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err((status, failure))) => Outcome::failed(started, status, failure, &secrets),
        Err(_) => Outcome::failed(
            started,
            None,
            failure(
                format!(
                    "{} didn't finish within {} s.",
                    message.host,
                    TOTAL_TIMEOUT.as_secs()
                ),
                true,
            ),
            &secrets,
        ),
    }
}
fn smtp_failure(
    step: &str,
    host: &str,
    error: lettre::transport::smtp::Error,
) -> (Option<u16>, Failure) {
    let code = error.status().map(u16::from);
    let retryable = !error.is_permanent();
    let reason = bounded(
        &error
            .to_string()
            .replace(['\r', '\n'], " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        200,
    );
    (
        code,
        failure(format!("{step} with {host} failed: {reason}"), retryable),
    )
}
async fn email_inner(
    options: &Options,
    m: &EmailMessage<'_>,
    started: Instant,
) -> Result<Outcome, (Option<u16>, Failure)> {
    use lettre::transport::smtp::{
        authentication::{Credentials, Mechanism},
        client::{AsyncSmtpConnection, Certificate, TlsParameters},
        extension::ClientId,
    };
    let plaintext = if m.security == SmtpSecurity::None {
        Plaintext::LoopbackOnly
    } else {
        Plaintext::No
    };
    let addresses = reach(options, m.host, m.port, m.allow_private, plaintext)
        .await
        .map_err(|f| (None, f))?;
    let stream = connect(options, m.host, &addresses)
        .await
        .map_err(|f| (None, f))?;
    let hello = ClientId::Domain("localhost".into());
    let mut connection = if m.security == SmtpSecurity::Tls {
        let secured = tls(options, m.host, stream).await.map_err(|f| (None, f))?;
        AsyncSmtpConnection::connect_with_transport(Box::new(SmtpTls(secured)), &hello).await
    } else {
        AsyncSmtpConnection::connect_with_transport(Box::new(stream), &hello).await
    }
    .map_err(|e| smtp_failure("Greeting", m.host, e))?;
    if m.security == SmtpSecurity::StartTls {
        if !connection.can_starttls() {
            connection.abort().await;
            return Err((
                None,
                failure(
                    format!(
                        "{} doesn't offer STARTTLS. Choose TLS, or another server.",
                        m.host
                    ),
                    false,
                ),
            ));
        }
        let mut parameters = TlsParameters::builder(m.host.to_owned());
        for der in &options.extra_roots {
            let certificate = Certificate::from_der(der.clone()).map_err(|_| {
                (
                    None,
                    failure("A trusted root certificate is invalid.", false),
                )
            })?;
            parameters = parameters.add_root_certificate(certificate);
        }
        let parameters = parameters
            .build_rustls()
            .map_err(|e| smtp_failure("TLS setup", m.host, e))?;
        connection
            .starttls(parameters, &hello)
            .await
            .map_err(|e| smtp_failure("STARTTLS", m.host, e))?;
    }
    if let (Some(user), Some(password)) = (m.username, m.password) {
        let response = connection
            .auth(
                &[Mechanism::Plain, Mechanism::Login],
                &Credentials::new(user.to_owned(), password.to_owned()),
            )
            .await
            .map_err(|e| smtp_failure("Signing in", m.host, e))?;
        if !response.is_positive() {
            connection.abort().await;
            return Err((
                None,
                failure(
                    format!("{} refused the user name or password.", m.host),
                    false,
                ),
            ));
        }
    }
    let built = build_email(m).map_err(|reason| (None, failure(reason, false)))?;
    let response = connection
        .send(built.envelope(), &built.formatted())
        .await
        .map_err(|e| smtp_failure("Sending", m.host, e))?;
    let _ = connection.quit().await;
    Ok(Outcome {
        delivered: response.is_positive(),
        status: Some(u16::from(response.code())),
        latency_ms: elapsed(started),
        error: (!response.is_positive()).then(|| format!("{} didn't accept the message.", m.host)),
        retryable: !response.is_positive(),
    })
}
fn build_email(m: &EmailMessage<'_>) -> Result<lettre::Message, String> {
    use lettre::message::{Mailbox, header::ContentType};
    let from: Mailbox = m
        .from
        .parse()
        .map_err(|_| "The from address isn't valid.".to_owned())?;
    let mut builder = lettre::Message::builder()
        .from(from)
        .subject(m.subject)
        .message_id(Some(format!("<{}@vectory.invalid>", uuid::Uuid::new_v4())))
        .header(ContentType::TEXT_PLAIN);
    for to in m.to {
        let mailbox: Mailbox = to
            .parse()
            .map_err(|_| format!("{to} isn't a valid address."))?;
        builder = builder.to(mailbox);
    }
    builder
        .body(m.body.to_owned())
        .map_err(|_| "The message couldn't be built.".to_owned())
}
/// Check an email address the way sending will.
pub fn valid_mailbox(value: &str) -> bool {
    value.parse::<lettre::message::Mailbox>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn classifies_every_blocked_range() {
        for (address, expected) in [
            ("8.8.8.8", Reach::Public),
            ("2606:4700:4700::1111", Reach::Public),
            ("127.0.0.1", Reach::Private("a loopback address")),
            ("::1", Reach::Private("a loopback address")),
            ("10.1.2.3", Reach::Private("a private address")),
            ("172.20.0.1", Reach::Private("a private address")),
            ("192.168.1.1", Reach::Private("a private address")),
            ("100.64.0.1", Reach::Private("a shared (CGNAT) address")),
            ("fd12:3456::1", Reach::Private("a private address")),
            ("169.254.169.254", Reach::Forbidden(METADATA)),
            ("169.254.170.2", Reach::Forbidden(METADATA)),
            ("100.100.100.200", Reach::Forbidden(METADATA)),
            ("168.63.129.16", Reach::Forbidden(METADATA)),
            ("::ffff:168.63.129.16", Reach::Forbidden(METADATA)),
            ("64:ff9b::a83f:8110", Reach::Forbidden(METADATA)),
            ("2002:a83f:8110::1", Reach::Forbidden(METADATA)),
            ("168.63.129.15", Reach::Public),
            ("168.63.129.17", Reach::Public),
            ("fd00:ec2::254", Reach::Forbidden(METADATA)),
            ("::ffff:169.254.169.254", Reach::Forbidden(METADATA)),
            ("64:ff9b::a9fe:a9fe", Reach::Forbidden(METADATA)),
            ("2002:a9fe:a9fe::1", Reach::Forbidden(METADATA)),
            ("::ffff:127.0.0.1", Reach::Private("a loopback address")),
            ("0.0.0.0", Reach::Forbidden("an unspecified address")),
            ("::", Reach::Forbidden("an unspecified address")),
            ("fe80::1", Reach::Forbidden("a link-local address")),
            ("169.254.1.1", Reach::Forbidden(METADATA)),
            ("224.0.0.1", Reach::Forbidden("a multicast address")),
            ("ff02::1", Reach::Forbidden("a multicast address")),
            ("255.255.255.255", Reach::Forbidden("a reserved address")),
            ("192.0.2.10", Reach::Forbidden("a documentation address")),
        ] {
            assert_eq!(classify(ip(address)), expected, "{address}");
        }
    }

    #[test]
    fn metadata_stays_blocked_even_with_private_allowed() {
        for address in [
            "169.254.169.254",
            "fd00:ec2::254",
            "100.100.100.200",
            "168.63.129.16",
            "::ffff:168.63.129.16",
            "fe80::1",
        ] {
            assert!(permitted(ip(address), true).is_err(), "{address}");
        }
        assert!(permitted(ip("10.0.0.5"), true).is_ok());
        assert!(permitted(ip("10.0.0.5"), false).is_err());
    }

    #[test]
    fn webhook_urls_are_https_without_credentials() {
        let d =
            webhook_destination("https://hooks.slack.com/services/T0/B0/secret", false).unwrap();
        assert_eq!(d.host, "hooks.slack.com");
        assert_eq!(d.port, 443);
        assert_eq!(d.target, "/services/T0/B0/secret");
        assert_eq!(url_hint(&d), "https://hooks.slack.com/…");
        assert!(webhook_destination("http://hooks.example.com/x", false).is_err());
        assert!(webhook_destination("http://10.0.0.5:8080/x", true).is_ok());
        assert!(
            webhook_destination("https://user:pass@hooks.example.com/", false)
                .unwrap_err()
                .contains("user name and password")
        );
        assert!(webhook_destination("https://169.254.169.254/latest", true).is_err());
        // Azure's platform address is reachable from every Azure VM, and is
        // refused like every other cloud metadata address.
        for allow_private in [false, true] {
            let reason = webhook_destination(
                "https://168.63.129.16/machine?comp=goalstate",
                allow_private,
            )
            .unwrap_err();
            assert!(reason.contains("cloud metadata address"), "{reason}");
        }
        assert!(webhook_destination("https://127.0.0.1/hook", false).is_err());
        assert!(webhook_destination("https://localhost/hook", false).is_err());
        assert!(webhook_destination("https://[::1]:9000/hook", true).is_ok());
        assert!(webhook_destination("ftp://example.com/", false).is_err());
        assert!(webhook_destination("https://example.com/#frag", false).is_err());
        let v6 = webhook_destination("https://[2606:4700::1]:8443/a?b=c", false).unwrap();
        assert_eq!(v6.authority, "[2606:4700::1]:8443");
        assert_eq!(v6.target, "/a?b=c");
    }

    #[test]
    fn errors_never_keep_a_secret() {
        let secrets = vec!["s3cr3t-token".to_owned(), "/services/T0/B0/xyz".to_owned()];
        let text = redact(
            "The receiver answered 403 Forbidden: bad token s3cr3t-token at /services/T0/B0/xyz",
            &secrets,
        );
        assert!(
            !text.contains("s3cr3t-token") && !text.contains("xyz"),
            "{text}"
        );
        assert!(redact(&"x".repeat(900), &[]).chars().count() <= ERROR_CAP);
    }
}
