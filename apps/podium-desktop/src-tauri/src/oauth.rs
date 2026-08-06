//! Linear OAuth for the one built-in application (TM-CRED-001/002).
//!
//! Authorization-code flow with PKCE and `actor=app`: consent happens in the
//! system browser, the callback returns to a loopback listener, and the code
//! exchange needs no client secret.  There is exactly one built-in
//! application identity; its public `client_id` is injected at build time via
//! `SYMPHONY_LINEAR_CLIENT_ID` and no secret exists anywhere in the product.

use serde_json::{json, Value};
use sha2::Digest;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const LINEAR_AUTHORIZE_ENDPOINT: &str = "https://linear.app/oauth/authorize";
pub const LINEAR_TOKEN_ENDPOINT: &str = "https://api.linear.app/oauth/token";
pub const LINEAR_GRAPHQL_ENDPOINT: &str = "https://api.linear.app/graphql";
pub const LINEAR_SCOPES: &str = "read,write,app:assignable,app:mentionable";

const CALLBACK_PATH: &str = "/callback";
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(180);
const CALLBACK_POLL: Duration = Duration::from_millis(50);
const MAX_CALLBACK_BYTES: usize = 8 * 1024;
/// Refresh skew: a token inside this window is treated as expired.
pub const REFRESH_SKEW_SECONDS: u64 = 60;

/// The built-in application's public identity, injected at compile time.
/// Builds without it cannot connect; the Settings surface says so.
pub fn builtin_client_id() -> Option<&'static str> {
    option_env!("SYMPHONY_LINEAR_CLIENT_ID").filter(|value| !value.trim().is_empty())
}

/// Sanitized OAuth failures.  Provider bodies and credentials never appear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthError {
    MissingClientId,
    NotConnected,
    ListenerFailed,
    TimedOut,
    Cancelled,
    StateMismatch,
    ProviderRejected,
    Transport,
    InvalidResponse,
}

impl std::fmt::Display for OAuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::MissingClientId => "linear_application_unconfigured",
            Self::NotConnected => "linear_not_connected",
            Self::ListenerFailed => "linear_callback_listener_failed",
            Self::TimedOut => "linear_authorization_timed_out",
            Self::Cancelled => "linear_authorization_cancelled",
            Self::StateMismatch => "linear_authorization_state_mismatch",
            Self::ProviderRejected => "linear_authorization_rejected",
            Self::Transport => "linear_transport_failed",
            Self::InvalidResponse => "linear_transport_response_invalid",
        })
    }
}

impl std::error::Error for OAuthError {}

/// Token endpoints are fixed in production and injectable for tests.
#[derive(Clone)]
pub struct OAuthEndpoints {
    pub token: String,
    pub graphql: String,
}

impl Default for OAuthEndpoints {
    fn default() -> Self {
        Self {
            token: LINEAR_TOKEN_ENDPOINT.to_owned(),
            graphql: LINEAR_GRAPHQL_ENDPOINT.to_owned(),
        }
    }
}

/// One in-flight authorization.  `authorize_url` is opened in the system
/// browser; the loopback listener accepts exactly one matching callback.
pub struct AuthorizationSession {
    pub authorize_url: String,
    listener: TcpListener,
    client_id: String,
    redirect_uri: String,
    verifier: String,
    state: String,
}

impl std::fmt::Debug for AuthorizationSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthorizationSession")
            .field("redirect_uri", &self.redirect_uri)
            .field("verifier", &"<redacted>")
            .field("state", &"<redacted>")
            .finish()
    }
}

pub fn begin_authorization(client_id: &str) -> Result<AuthorizationSession, OAuthError> {
    if client_id.trim().is_empty() {
        return Err(OAuthError::MissingClientId);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| OAuthError::ListenerFailed)?;
    listener.set_nonblocking(true).map_err(|_| OAuthError::ListenerFailed)?;
    let port = listener.local_addr().map_err(|_| OAuthError::ListenerFailed)?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");

    let verifier = random_url_safe(32)?;
    let challenge = {
        let digest = sha2::Sha256::digest(verifier.as_bytes());
        base64_url(&digest)
    };
    let state = random_url_safe(16)?;

    let authorize_url = format!(
        "{LINEAR_AUTHORIZE_ENDPOINT}?response_type=code&client_id={}&redirect_uri={}&state={}&scope={}&actor=app&code_challenge={}&code_challenge_method=S256",
        url_encode(client_id),
        url_encode(&redirect_uri),
        url_encode(&state),
        url_encode(LINEAR_SCOPES),
        url_encode(&challenge),
    );
    Ok(AuthorizationSession {
        authorize_url,
        listener,
        client_id: client_id.to_owned(),
        redirect_uri,
        verifier,
        state,
    })
}

impl AuthorizationSession {
    /// Block until the browser returns, the operator cancels, or the flow
    /// times out.  Only a callback whose `state` matches this session is
    /// accepted; anything else fails closed (TM-CRED-002).
    pub fn wait_for_code(&self, cancel: &AtomicBool) -> Result<String, OAuthError> {
        let deadline = Instant::now() + AUTHORIZATION_TIMEOUT;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(OAuthError::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(OAuthError::TimedOut);
            }
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    let outcome = read_callback(&mut stream);
                    let code = outcome.and_then(|callback| {
                        if callback.state == self.state {
                            Ok(callback.code)
                        } else {
                            Err(OAuthError::StateMismatch)
                        }
                    });
                    respond(&mut stream, code.is_ok());
                    return code;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(CALLBACK_POLL);
                }
                Err(_) => return Err(OAuthError::ListenerFailed),
            }
        }
    }

    /// Exchange the callback code for tokens (PKCE: no client secret), then
    /// read the organization so Settings shows the real connection state
    /// (TM-CRED-006).
    pub fn complete(
        &self,
        code: &str,
        client: &reqwest::blocking::Client,
        endpoints: &OAuthEndpoints,
    ) -> Result<TokenSet, OAuthError> {
        let tokens = exchange_code(
            client,
            &endpoints.token,
            &self.client_id,
            &self.redirect_uri,
            code,
            &self.verifier,
        )?;
        let organization = read_organization(client, &endpoints.graphql, &tokens.access_token)?;
        Ok(TokenSet { organization, ..tokens })
    }
}

pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub organization: String,
}

pub fn exchange_code(
    client: &reqwest::blocking::Client,
    token_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> Result<TokenSet, OAuthError> {
    token_request(
        client,
        token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", client_id),
            ("code_verifier", verifier),
        ],
    )
}

/// Refresh-token rotation.  The provider keeps the previous refresh token
/// valid for a grace window, so one immediate replay is allowed after a
/// transport failure (TM-CRED-004).
pub fn refresh_tokens(
    client: &reqwest::blocking::Client,
    token_endpoint: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenSet, OAuthError> {
    token_request(
        client,
        token_endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ],
    )
    .or_else(|error| {
        if error != OAuthError::Transport {
            return Err(error);
        }
        token_request(
            client,
            token_endpoint,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("client_id", client_id),
            ],
        )
    })
}

fn token_request(
    client: &reqwest::blocking::Client,
    token_endpoint: &str,
    form: &[(&str, &str)],
) -> Result<TokenSet, OAuthError> {
    let body = form
        .iter()
        .map(|(key, value)| format!("{}={}", url_encode(key), url_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let response = client
        .post(token_endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .map_err(|_| OAuthError::Transport)?;
    if response.status().as_u16() == 400 || response.status().as_u16() == 401 {
        return Err(OAuthError::ProviderRejected);
    }
    if !response.status().is_success() {
        return Err(OAuthError::Transport);
    }
    let body = response.bytes().map_err(|_| OAuthError::Transport)?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| OAuthError::InvalidResponse)?;
    let access_token = token_field(&value, "access_token")?;
    let refresh_token = token_field(&value, "refresh_token")?;
    let expires_in = value
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|seconds| *seconds > 0)
        .ok_or(OAuthError::InvalidResponse)?;
    Ok(TokenSet { access_token, refresh_token, expires_in, organization: String::new() })
}

fn token_field(value: &Value, field: &str) -> Result<String, OAuthError> {
    let text = value.get(field).and_then(Value::as_str).ok_or(OAuthError::InvalidResponse)?;
    if text.trim().is_empty()
        || text.len() > 16_384
        || text.chars().any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
    {
        return Err(OAuthError::InvalidResponse);
    }
    Ok(text.to_owned())
}

fn read_organization(
    client: &reqwest::blocking::Client,
    graphql_endpoint: &str,
    access_token: &str,
) -> Result<String, OAuthError> {
    let response = client
        .post(graphql_endpoint)
        .header(reqwest::header::AUTHORIZATION, access_token)
        .json(&json!({ "query": "{ organization { name } }" }))
        .send()
        .map_err(|_| OAuthError::Transport)?;
    if response.status().as_u16() == 401 {
        return Err(OAuthError::ProviderRejected);
    }
    if !response.status().is_success() {
        return Err(OAuthError::Transport);
    }
    let body = response.bytes().map_err(|_| OAuthError::Transport)?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| OAuthError::InvalidResponse)?;
    let name = value
        .get("data")
        .and_then(|data| data.get("organization"))
        .and_then(|organization| organization.get("name"))
        .and_then(Value::as_str)
        .ok_or(OAuthError::InvalidResponse)?;
    if name.trim().is_empty() || name.len() > 256 {
        return Err(OAuthError::InvalidResponse);
    }
    Ok(name.to_owned())
}

struct Callback {
    code: String,
    state: String,
}

/// Parse one loopback callback.  Only `GET /callback` carrying both `code`
/// and `state` is accepted; anything else fails closed and is never echoed
/// back with detail.
fn read_callback(stream: &mut std::net::TcpStream) -> Result<Callback, OAuthError> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|_| OAuthError::Transport)?;
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream.read(&mut chunk).map_err(|_| OAuthError::Transport)?;
        if read == 0 {
            return Err(OAuthError::InvalidResponse);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n")
            || buffer.len() > MAX_CALLBACK_BYTES
        {
            break;
        }
    }
    if buffer.len() > MAX_CALLBACK_BYTES {
        return Err(OAuthError::InvalidResponse);
    }
    let text = String::from_utf8_lossy(&buffer);
    let request_line = text.lines().next().ok_or(OAuthError::InvalidResponse)?;
    let target = request_line
        .strip_prefix("GET ")
        .and_then(|rest| rest.split_whitespace().next())
        .ok_or(OAuthError::InvalidResponse)?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return Err(OAuthError::InvalidResponse);
    }
    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        match key {
            "code" => code = Some(value.to_owned()),
            "state" => state = Some(value.to_owned()),
            _ => {}
        }
    }
    match (code, state) {
        (Some(code), Some(state)) if !code.is_empty() && !state.is_empty() => {
            Ok(Callback { code, state })
        }
        _ => Err(OAuthError::InvalidResponse),
    }
}

fn respond(stream: &mut std::net::TcpStream, success: bool) {
    let (status, message) = if success {
        ("200 OK", "Linear authorization complete. You can return to Symphony.")
    } else {
        ("400 Bad Request", "This authorization callback could not be used.")
    };
    let body = format!(
        "<!doctype html><html><body style=\"font-family:system-ui;text-align:center;padding:48px\">{message}</body></html>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

fn random_url_safe(bytes: usize) -> Result<String, OAuthError> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::getrandom(&mut buffer).map_err(|_| OAuthError::Transport)?;
    Ok(base64_url(&buffer))
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_uses_pkce_app_actor_and_loopback() {
        let session = begin_authorization("client-fixture").unwrap();
        assert!(session.authorize_url.starts_with(LINEAR_AUTHORIZE_ENDPOINT));
        for fragment in [
            "response_type=code",
            "client_id=client-fixture",
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A",
            "actor=app",
            "code_challenge_method=S256",
            "scope=read%2Cwrite%2Capp%3Aassignable%2Capp%3Amentionable",
        ] {
            assert!(session.authorize_url.contains(fragment), "missing {fragment}");
        }
        assert!(!format!("{session:?}").contains(&session.verifier));
        assert!(!session.authorize_url.contains(&session.verifier));
    }

    #[test]
    fn callback_round_trip_and_state_verification() {
        let session = begin_authorization("client-fixture").unwrap();
        let address = session.listener.local_addr().unwrap();
        let cancel = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let waiter = scope.spawn(|| session.wait_for_code(&cancel));
            let mut browser = std::net::TcpStream::connect(address).unwrap();
            write!(
                browser,
                "GET /callback?code=fixture-code&state={} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n",
                session.state
            )
            .unwrap();
            assert_eq!(waiter.join().unwrap().unwrap(), "fixture-code");
        });
    }

    #[test]
    fn mismatched_state_fails_closed() {
        let session = begin_authorization("client-fixture").unwrap();
        let address = session.listener.local_addr().unwrap();
        let cancel = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let waiter = scope.spawn(|| session.wait_for_code(&cancel));
            let mut browser = std::net::TcpStream::connect(address).unwrap();
            write!(
                browser,
                "GET /callback?code=fixture-code&state=forged-state HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n"
            )
            .unwrap();
            assert_eq!(waiter.join().unwrap(), Err(OAuthError::StateMismatch));
        });
    }

    #[test]
    fn cancellation_stops_the_wait() {
        let session = begin_authorization("client-fixture").unwrap();
        let cancel = AtomicBool::new(true);
        assert_eq!(session.wait_for_code(&cancel), Err(OAuthError::Cancelled));
    }
}
