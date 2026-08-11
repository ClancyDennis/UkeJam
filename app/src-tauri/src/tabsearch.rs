//! In-app tab finding — search Ultimate Guitar and pull a tab's text straight
//! into the app, so adding a song doesn't require a separate browser and
//! copy/paste round-trip.
//!
//! UG has no public API; like other open-source tab tools we read the JSON
//! state blob every page embeds in `<div class="js-store" data-content="...">`.
//! That blob has been stable for years and carries exactly what we need
//! (search results, tab text), whereas HTML selectors churn with redesigns.
//! The network + parsing live in Rust rather than the webview because the
//! webview can't fetch cross-origin, and this keeps the scraping in one
//! testable place.

use serde::Serialize;
use serde_json::Value;

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// One search result: a specific version of a song's chord sheet.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TabHit {
    pub artist: String,
    pub song: String,
    pub url: String,
    /// UG tab type, e.g. "Chords" or "Ukulele Chords".
    pub kind: String,
    pub rating: f64,
    pub votes: u64,
    pub version: u32,
}

/// A fetched tab: metadata plus the plain chords-over-lyrics text, ready for
/// the paste box (and the existing ✨ AI-enhance → ChordPro pipeline).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TabContent {
    pub title: String,
    pub artist: String,
    pub text: String,
    pub url: String,
}

/// What a search returns: the hits, plus the query strings actually searched
/// (more than one when the LLM expands a fuzzy description).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub queries: Vec<String>,
    pub hits: Vec<TabHit>,
}

/// Run each query and merge the hits (dedup'd by url, best-voted first).
/// More than one query arrives when ✨ smart mode (enhance::interpret_search)
/// expanded a fuzzy description. A per-query failure only surfaces when NO
/// query produced hits — partial results beat an error.
pub fn run_search(queries: &[String]) -> Result<SearchOutcome, String> {
    let mut hits: Vec<TabHit> = Vec::new();
    let mut first_err: Option<String> = None;
    for q in queries {
        match search(q) {
            Ok(found) => {
                for h in found {
                    if !hits.iter().any(|e| e.url == h.url) {
                        hits.push(h);
                    }
                }
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }
    if hits.is_empty() {
        if let Some(e) = first_err {
            return Err(e);
        }
    }
    hits.sort_by(|a, b| b.votes.cmp(&a.votes));
    hits.truncate(40);
    Ok(SearchOutcome {
        queries: queries.to_vec(),
        hits,
    })
}

/// One plain title search against UG.
fn search(query: &str) -> Result<Vec<TabHit>, String> {
    let url = format!(
        "https://www.ultimate-guitar.com/search.php?search_type=title&value={}",
        percent_encode(query)
    );
    let html = http_get(&url)?;
    let store = js_store_json(&html)?;
    Ok(parse_search_results(&store))
}

/// Fetch a tab page and extract its text + metadata.
pub fn fetch_tab(url: &str) -> Result<TabContent, String> {
    validate_tab_url(url)?;
    let html = http_get(url)?;
    let store = js_store_json(&html)?;
    parse_tab_page(&store, url)
}

/// Only ultimate-guitar https links may be fetched or opened in the preview
/// window — the frontend passes URLs around, so re-check at the trust boundary.
pub fn validate_tab_url(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or("only https:// ultimate-guitar.com links are allowed")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let ok = !host.contains(['@', ':'])
        && (host == "ultimate-guitar.com" || host.ends_with(".ultimate-guitar.com"));
    if ok {
        Ok(())
    } else {
        Err(format!("refusing to open non-ultimate-guitar url ({host})"))
    }
}

// ---- scraping internals ----

fn http_get(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(UA)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .map_err(|e| format!("request failed (offline?): {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("site returned {status}"));
    }
    resp.text().map_err(|e| format!("read body: {e}"))
}

/// Pull the `data-content` JSON blob out of the page's js-store div.
/// Every double quote inside the attribute is entity-escaped (&quot;), so the
/// first raw `"` after the attribute opens is its true end.
fn js_store_json(html: &str) -> Result<Value, String> {
    let anchor = html.find("js-store").unwrap_or(0);
    const ATTR: &str = "data-content=\"";
    let start = html[anchor..]
        .find(ATTR)
        .map(|i| anchor + i + ATTR.len())
        .or_else(|| html.find(ATTR).map(|i| i + ATTR.len()))
        .ok_or("page had no embedded data — the site layout may have changed")?;
    let end = html[start..]
        .find('"')
        .map(|i| start + i)
        .ok_or("embedded data blob was unterminated")?;
    serde_json::from_str(&html_unescape(&html[start..end]))
        .map_err(|e| format!("couldn't parse page data: {e}"))
}

fn parse_search_results(store: &Value) -> Vec<TabHit> {
    let data = &store["store"]["page"]["data"];
    let mut hits = Vec::new();
    // `results` is the main list; `other_tabs` appears on some result pages
    for key in ["results", "other_tabs"] {
        let Some(arr) = data[key].as_array() else { continue };
        for r in arr {
            // ad/promo rows carry marketing_type and no usable tab
            if r["marketing_type"].as_str().is_some() {
                continue;
            }
            let Some(url) = r["tab_url"].as_str().filter(|u| !u.is_empty()) else {
                continue;
            };
            let kind = r["type"].as_str().unwrap_or("");
            // the app listens for CHORDS; note-by-note tabs, official/Pro
            // content, videos etc. aren't importable or useful here
            if !kind.contains("Chords") {
                continue;
            }
            hits.push(TabHit {
                artist: r["artist_name"].as_str().unwrap_or("").to_string(),
                song: r["song_name"].as_str().unwrap_or("").to_string(),
                url: url.to_string(),
                kind: kind.to_string(),
                rating: r["rating"].as_f64().unwrap_or(0.0),
                votes: r["votes"].as_u64().unwrap_or(0),
                version: r["version"].as_u64().unwrap_or(1) as u32,
            });
        }
    }
    hits
}

fn parse_tab_page(store: &Value, url: &str) -> Result<TabContent, String> {
    let data = &store["store"]["page"]["data"];
    let content = data["tab_view"]["wiki_tab"]["content"]
        .as_str()
        .ok_or("no tab text on that page (official/Pro tabs can't be imported)")?;
    let tab = &data["tab"];
    Ok(TabContent {
        title: tab["song_name"].as_str().unwrap_or("").to_string(),
        artist: tab["artist_name"].as_str().unwrap_or("").to_string(),
        text: strip_ug_markup(content),
        url: url.to_string(),
    })
}

/// UG wraps chords in [ch]..[/ch] and preformatted blocks in [tab]..[/tab];
/// stripped, the text is the familiar chords-over-lyrics sheet.
fn strip_ug_markup(s: &str) -> String {
    s.replace("\r\n", "\n")
        .replace("[tab]", "")
        .replace("[/tab]", "")
        .replace("[ch]", "")
        .replace("[/ch]", "")
}

fn html_unescape(s: &str) -> String {
    // &amp; last, so "&amp;quot;" decodes to the literal "&quot;"
    s.replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // a minimal page shaped like UG's: js-store div with entity-escaped JSON
    fn page(json: &str) -> String {
        let escaped = json
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        format!(
            "<html><body><div class=\"other\" data-content=\"{{}}\"></div>\
             <div class=\"js-store\" data-content=\"{escaped}\"></div></body></html>"
        )
    }

    #[test]
    fn extracts_js_store_blob() {
        let html = page(r#"{"store":{"page":{"data":{"x":"a \"quoted\" & <tag>"}}}}"#);
        let v = js_store_json(&html).unwrap();
        assert_eq!(
            v["store"]["page"]["data"]["x"].as_str().unwrap(),
            "a \"quoted\" & <tag>"
        );
    }

    #[test]
    fn parses_search_results_filtering_noise() {
        let json = r#"{"store":{"page":{"data":{"results":[
            {"song_name":"Riptide","artist_name":"Vance Joy","tab_url":"https://tabs.ultimate-guitar.com/tab/vance-joy/riptide-chords-1", "type":"Chords","rating":4.9,"votes":31000,"version":1},
            {"song_name":"Riptide","artist_name":"Vance Joy","tab_url":"https://tabs.ultimate-guitar.com/tab/vance-joy/riptide-ukulele-2","type":"Ukulele Chords","rating":4.8,"votes":900,"version":2},
            {"song_name":"Riptide","artist_name":"Vance Joy","tab_url":"https://tabs.ultimate-guitar.com/tab/vance-joy/riptide-official","type":"Official","rating":5,"votes":10},
            {"song_name":"Riptide","artist_name":"Vance Joy","tab_url":"https://tabs.ultimate-guitar.com/tab/vance-joy/riptide-tab-9","type":"Tab","rating":4,"votes":5},
            {"marketing_type":"article","song_name":"ad"},
            {"song_name":"NoUrl","artist_name":"X","type":"Chords"}
        ]}}}}"#;
        let hits = parse_search_results(&serde_json::from_str(json).unwrap());
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].kind, "Chords");
        assert_eq!(hits[0].votes, 31000);
        assert_eq!(hits[1].kind, "Ukulele Chords");
        assert_eq!(hits[1].version, 2);
    }

    #[test]
    fn parses_tab_page_and_strips_markup() {
        let json = r#"{"store":{"page":{"data":{
            "tab":{"song_name":"Riptide","artist_name":"Vance Joy"},
            "tab_view":{"wiki_tab":{"content":"[tab][ch]Am[/ch]  [ch]G[/ch]\r\nI was scared[/tab]"}}
        }}}}"#;
        let store: Value = serde_json::from_str(json).unwrap();
        let tab = parse_tab_page(&store, "https://tabs.ultimate-guitar.com/x").unwrap();
        assert_eq!(tab.title, "Riptide");
        assert_eq!(tab.artist, "Vance Joy");
        assert_eq!(tab.text, "Am  G\nI was scared");
    }

    #[test]
    fn tab_page_without_content_is_a_clear_error() {
        let json = r#"{"store":{"page":{"data":{"tab":{"song_name":"X"}}}}}"#;
        let store: Value = serde_json::from_str(json).unwrap();
        assert!(parse_tab_page(&store, "u").unwrap_err().contains("Pro"));
    }

    #[test]
    fn url_validation() {
        assert!(validate_tab_url("https://tabs.ultimate-guitar.com/tab/a/b-1").is_ok());
        assert!(validate_tab_url("https://www.ultimate-guitar.com/search.php?q=1").is_ok());
        assert!(validate_tab_url("https://ultimate-guitar.com/x").is_ok());
        assert!(validate_tab_url("http://tabs.ultimate-guitar.com/x").is_err());
        assert!(validate_tab_url("https://evil.com/ultimate-guitar.com").is_err());
        assert!(validate_tab_url("https://notultimate-guitar.com/x").is_err());
        assert!(validate_tab_url("https://ultimate-guitar.com@evil.com/x").is_err());
        assert!(validate_tab_url("https://x.ultimate-guitar.com:8443/x").is_err());
    }

    #[test]
    fn percent_encoding() {
        assert_eq!(percent_encode("hey there Delilah!"), "hey%20there%20Delilah%21");
        assert_eq!(percent_encode("AC/DC"), "AC%2FDC");
    }
}
