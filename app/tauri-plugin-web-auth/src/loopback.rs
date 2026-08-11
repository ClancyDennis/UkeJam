//! A throwaway HTTP listener on `127.0.0.1:0`, used as the OAuth redirect
//! target while the system browser sheet is up.
//!
//! It exists because the two halves of the flow want incompatible things.
//! OpenRouter's `/auth` only redirects back to `http(s)` URLs — loopback on
//! any port is fine, custom schemes are not. `ASWebAuthenticationSession`, on
//! the other hand, can only recognise the finish line by its *scheme*, so an
//! `http://127.0.0.1:…` redirect would leave the sheet sitting open on a page
//! it doesn't know is the end.
//!
//! Serving the redirect ourselves satisfies both: the provider gets a real
//! `http` address that really answers, and the reply is a 302 to
//! `<scheme>://callback?…`, which the session intercepts and dismisses on.
//!
//! The listener also *keeps* the query it was hit with. That copy is what
//! makes the flow robust: the code has already been delivered by the time the
//! bounce happens, so even a sheet that closes without reporting a callback
//! (a dismissal read as a cancel, a scheme the session declined to follow)
//! leaves a complete sign-in behind. See `mobile.rs`.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Path the redirect URI points at. Any path works — the provider treats the
/// whole URI as opaque — so this one is just something recognisable in a log.
pub const CALLBACK_PATH: &str = "/oauth-callback";

/// The listener is non-blocking and polled, so it can be stopped promptly on
/// drop instead of parking a thread in `accept` for the rest of the session.
const ACCEPT_POLL: Duration = Duration::from_millis(50);
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// A browser's GET request line is well under this; anything longer is not a
/// redirect we care about, so the read stops rather than growing a buffer.
const MAX_REQUEST_BYTES: usize = 8 * 1024;

pub struct LoopbackServer {
    port: u16,
    captured: Arc<Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl LoopbackServer {
    /// Binds an ephemeral loopback port and starts serving. `scheme` is the
    /// custom URL scheme the callback bounces to so the native sheet closes.
    pub fn start(scheme: &str) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let captured = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = thread::spawn({
            let captured = Arc::clone(&captured);
            let stop = Arc::clone(&stop);
            let scheme = scheme.to_string();
            move || serve(&listener, port, &scheme, &captured, &stop)
        });
        Ok(Self {
            port,
            captured,
            stop,
            worker: Some(worker),
        })
    }

    /// The redirect URI to hand the provider.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }

    /// The callback URL this listener was hit with, if it was hit at all.
    pub fn captured(&self) -> Option<String> {
        self.captured.lock().ok().and_then(|slot| slot.clone())
    }
}

impl Drop for LoopbackServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Keeps answering until dropped rather than stopping at the first callback:
/// a reload, or a retry after a transient failure, must still be served.
fn serve(
    listener: &TcpListener,
    port: u16,
    scheme: &str,
    captured: &Mutex<Option<String>>,
    stop: &AtomicBool,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => handle(stream, port, scheme, captured),
            Err(error) if error.kind() == ErrorKind::WouldBlock => thread::sleep(ACCEPT_POLL),
            Err(_) => return,
        }
    }
}

fn handle(mut stream: TcpStream, port: u16, scheme: &str, captured: &Mutex<Option<String>>) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let Some(line) = read_request_line(&mut stream) else {
        return;
    };
    let Some((path, query)) = request_target(&line).map(split_target) else {
        let _ = write_response(&mut stream, &not_found_response());
        return;
    };
    if path != CALLBACK_PATH {
        let _ = write_response(&mut stream, &not_found_response());
        return;
    }
    let query = sanitize_query(query);
    // First hit wins: a reload must not overwrite the original code with a
    // replay the provider has already invalidated.
    if let Ok(mut slot) = captured.lock() {
        slot.get_or_insert_with(|| callback_url(port, &query));
    }
    let _ = write_response(&mut stream, &redirect_response(scheme, &query));
}

fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::new();
    let mut byte = [0u8; 1];
    while buffer.len() < MAX_REQUEST_BYTES {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => buffer.push(byte[0]),
            Err(_) => return None,
        }
    }
    let line = String::from_utf8_lossy(&buffer).trim_end().to_string();
    (!line.is_empty()).then_some(line)
}

/// The request target out of a `GET /path?query HTTP/1.1` line.
fn request_target(line: &str) -> Option<&str> {
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    (method == "GET" && target.starts_with('/')).then_some(target)
}

fn split_target(target: &str) -> (&str, &str) {
    match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    }
}

/// Control characters are the only thing that could break out of the `Location`
/// header, and no legitimate query contains them.
fn sanitize_query(query: &str) -> String {
    query.chars().filter(|c| !c.is_control()).collect()
}

fn callback_url(port: u16, query: &str) -> String {
    match query.is_empty() {
        true => format!("http://127.0.0.1:{port}{CALLBACK_PATH}"),
        false => format!("http://127.0.0.1:{port}{CALLBACK_PATH}?{query}"),
    }
}

/// Where the browser sheet is sent so it recognises the end of the flow. The
/// query rides along unchanged, so the native callback carries the same code
/// the loopback hit did.
fn redirect_location(scheme: &str, query: &str) -> String {
    match query.is_empty() {
        true => format!("{scheme}://callback"),
        false => format!("{scheme}://callback?{query}"),
    }
}

fn redirect_response(scheme: &str, query: &str) -> String {
    // The body is only ever seen if the scheme bounce doesn't take (the sheet
    // stays open); it explains the situation rather than showing a blank page.
    let body = "<!doctype html><meta charset=\"utf-8\"><title>Signed in</title>\
<body style=\"font:16px -apple-system,system-ui,sans-serif;text-align:center;padding:3rem\">\
<p>Signed in. You can close this window and return to the app.</p></body>";
    http_response(
        "302 Found",
        &[("Location", &redirect_location(scheme, query))],
        body,
    )
}

fn not_found_response() -> String {
    http_response("404 Not Found", &[], "Not found")
}

fn http_response(status: &str, headers: &[(&str, &str)], body: &str) -> String {
    let mut response = format!("HTTP/1.1 {status}\r\n");
    for (name, value) in headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("Content-Type: text/html; charset=utf-8\r\n");
    response.push_str(&format!("Content-Length: {}\r\n", body.len()));
    response.push_str("Cache-Control: no-store\r\n");
    response.push_str("Connection: close\r\n\r\n");
    response.push_str(body);
    response
}

fn write_response(stream: &mut TcpStream, response: &str) -> std::io::Result<()> {
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    #[test]
    fn request_target_accepts_only_get_lines() {
        assert_eq!(request_target("GET /oauth-callback?code=1 HTTP/1.1"), Some("/oauth-callback?code=1"));
        assert_eq!(request_target("POST /oauth-callback HTTP/1.1"), None);
        assert_eq!(request_target("GET http://evil/ HTTP/1.1"), None);
        assert_eq!(request_target("garbage"), None);
    }

    #[test]
    fn split_target_separates_path_from_query() {
        assert_eq!(split_target("/oauth-callback?code=abc&state=x"), ("/oauth-callback", "code=abc&state=x"));
        assert_eq!(split_target("/oauth-callback"), ("/oauth-callback", ""));
    }

    #[test]
    fn sanitize_query_strips_header_injection() {
        // A CR/LF in the query would otherwise forge extra response headers.
        assert_eq!(
            sanitize_query("code=abc\r\nX-Injected: yes"),
            "code=abcX-Injected: yes"
        );
    }

    #[test]
    fn redirect_carries_the_query_to_the_custom_scheme() {
        assert_eq!(
            redirect_location("ukejam-auth", "code=abc"),
            "ukejam-auth://callback?code=abc"
        );
        assert_eq!(redirect_location("ukejam-auth", ""), "ukejam-auth://callback");
    }

    #[test]
    fn responses_declare_their_body_length() {
        let response = redirect_response("ukejam-auth", "code=abc");
        assert!(response.starts_with("HTTP/1.1 302 Found\r\n"));
        assert!(response.contains("Location: ukejam-auth://callback?code=abc\r\n"));
        let body = response.split("\r\n\r\n").nth(1).expect("response has a body");
        assert!(response.contains(&format!("Content-Length: {}\r\n", body.len())));
    }

    #[test]
    fn serves_the_callback_and_remembers_its_query() {
        let server = LoopbackServer::start("ukejam-auth").expect("loopback binds");
        let redirect = server.redirect_uri();
        let authority = redirect
            .strip_prefix("http://")
            .and_then(|rest| rest.split('/').next())
            .expect("redirect uri has an authority");

        let mut stream = std::net::TcpStream::connect(authority).expect("connects to the listener");
        write!(stream, "GET {CALLBACK_PATH}?code=abc123 HTTP/1.1\r\nHost: {authority}\r\n\r\n")
            .expect("request writes");
        let mut status = String::new();
        BufReader::new(&stream).read_line(&mut status).expect("response reads");

        assert_eq!(status.trim_end(), "HTTP/1.1 302 Found");
        assert_eq!(
            server.captured(),
            Some(format!("http://{authority}{CALLBACK_PATH}?code=abc123"))
        );
    }

    #[test]
    fn ignores_paths_that_are_not_the_callback() {
        let server = LoopbackServer::start("ukejam-auth").expect("loopback binds");
        let redirect = server.redirect_uri();
        let authority = redirect
            .strip_prefix("http://")
            .and_then(|rest| rest.split('/').next())
            .expect("redirect uri has an authority");

        let mut stream = std::net::TcpStream::connect(authority).expect("connects to the listener");
        write!(stream, "GET /favicon.ico HTTP/1.1\r\nHost: {authority}\r\n\r\n").expect("request writes");
        let mut status = String::new();
        BufReader::new(&stream).read_line(&mut status).expect("response reads");

        assert_eq!(status.trim_end(), "HTTP/1.1 404 Not Found");
        assert_eq!(server.captured(), None);
    }
}
