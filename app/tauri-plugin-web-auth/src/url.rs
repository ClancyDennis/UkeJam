//! Just enough URL assembly to bolt a redirect URI onto a provider's
//! authorize URL. The plugin deliberately carries no URL crate: this is the
//! only string it ever builds.

/// Appends `key=value` to `url`, percent-encoding both. A fragment, if the
/// caller supplied one, is kept last so the result stays a valid URL.
pub fn append_query_param(url: &str, key: &str, value: &str) -> String {
    let (base, fragment) = match url.split_once('#') {
        Some((base, fragment)) => (base, Some(fragment)),
        None => (url, None),
    };
    let separator = if base.contains('?') { '&' } else { '?' };
    let mut out = format!(
        "{base}{separator}{}={}",
        percent_encode(key),
        percent_encode(value)
    );
    if let Some(fragment) = fragment {
        out.push('#');
        out.push_str(fragment);
    }
    out
}

/// Percent-encodes everything outside RFC 3986's unreserved set — the strict
/// choice, so a redirect URI's `:` and `/` survive as data rather than being
/// re-read as structure by the provider.
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_redirect_uri_as_one_opaque_value() {
        assert_eq!(
            percent_encode("http://127.0.0.1:52341/oauth-callback"),
            "http%3A%2F%2F127.0.0.1%3A52341%2Foauth-callback"
        );
    }

    #[test]
    fn appends_with_the_right_separator() {
        assert_eq!(
            append_query_param("https://openrouter.ai/auth", "callback_url", "http://x/y"),
            "https://openrouter.ai/auth?callback_url=http%3A%2F%2Fx%2Fy"
        );
        assert_eq!(
            append_query_param("https://openrouter.ai/auth?code_challenge=abc", "callback_url", "http://x/y"),
            "https://openrouter.ai/auth?code_challenge=abc&callback_url=http%3A%2F%2Fx%2Fy"
        );
    }

    #[test]
    fn keeps_a_fragment_at_the_end() {
        assert_eq!(
            append_query_param("https://example.com/auth#top", "redirect_uri", "http://x"),
            "https://example.com/auth?redirect_uri=http%3A%2F%2Fx#top"
        );
    }
}
