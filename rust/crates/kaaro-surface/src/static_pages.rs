//! Serve JS-built HTML artifacts (or minimal stubs).

use crate::state::AppState;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use std::path::{Path, PathBuf};

fn html_response(status: StatusCode, body: String) -> Response {
    let mut res = Html(body).into_response();
    *res.status_mut() = status;
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    res
}

fn read_html(dir: &Path, name: &str) -> Option<String> {
    let p = dir.join(name);
    std::fs::read_to_string(p).ok()
}

fn stub_graph() -> String {
    r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>kaaroSessions</title>
<style>body{font:14px/1.4 system-ui,monospace;background:#080810;color:#ccc;padding:2rem}
a{color:#00aaff} pre{background:#111;padding:1rem;overflow:auto}</style></head>
<body>
<h1>kaaroSessions (stub)</h1>
<p>Built <code>graph.html</code> not found — showing graph-data.json summary.
   Run <code>node build.mjs</code> or <code>kaaro-sessions build</code> then refresh.</p>
<p><a href="/now">/now</a> · <a href="/api/active">/api/active</a> · <a href="/events">/events</a></p>
<pre id="out">loading…</pre>
<script>
fetch('/graph-data.json').then(r=>r.ok?r.json():Promise.reject(r.status))
  .then(d=>{
    const n=(d.nodes||[]).length, e=(d.edges||[]).length;
    const by={};
    for (const x of (d.nodes||[])) by[x.type]=(by[x.type]||0)+1;
    document.getElementById('out').textContent = JSON.stringify({nodes:n,edges:e,byType:by,meta:d.meta},null,2);
  }).catch(err=>{
    document.getElementById('out').textContent = 'graph-data.json unavailable: '+err;
  });
</script>
</body></html>"#
    .into()
}

fn stub_now() -> String {
    r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mission Control</title>
<style>body{font:14px system-ui,monospace;background:#080810;color:#ccc;padding:2rem}
pre{background:#111;padding:1rem}</style></head>
<body>
<h1>Mission Control (stub)</h1>
<p>Serve <code>now.html</code> from <code>--static-dir</code> for the full UI.</p>
<pre id="out">loading…</pre>
<script>
fetch('/api/active').then(r=>r.json()).then(d=>{
  document.getElementById('out').textContent = JSON.stringify(d,null,2);
});
setInterval(()=>location.reload(), 5000);
</script>
</body></html>"#
    .into()
}

fn stub_missing(name: &str) -> String {
    format!(
        r#"<!DOCTYPE html><html><body style="font:14px monospace;padding:40px;background:#080810;color:#9aa0b8">
<h2>{name} not built yet</h2>
<p>Place the JS-built artifact in <code>--static-dir</code> (repo root after <code>node build.mjs</code>).</p>
<p><a href="/graph" style="color:#ff6600">Back to the graph</a></p>
</body></html>"#
    )
}

fn building_placeholder() -> String {
    r#"<!DOCTYPE html><html><body style="font:14px monospace;padding:40px;background:#111;color:#ccc">
<h2>Building…</h2><p>Refresh in a few seconds.</p>
<script>setTimeout(()=>location.reload(),3000)</script>
</body></html>"#
    .into()
}

async fn serve_named(state: &AppState, file: &str, stub: String) -> Response {
    if let Some(dir) = state.paths.static_dir.as_ref() {
        if let Some(html) = read_html(dir, file) {
            return html_response(StatusCode::OK, html);
        }
    }
    html_response(StatusCode::OK, stub)
}

pub async fn page_home(State(state): State<AppState>) -> Response {
    // Prefer home.html; fall back to graph.html then stub.
    if let Some(dir) = state.paths.static_dir.as_ref() {
        if let Some(html) = read_html(dir, "home.html") {
            return html_response(StatusCode::OK, html);
        }
        if let Some(html) = read_html(dir, "graph.html") {
            return html_response(StatusCode::OK, html);
        }
    }
    html_response(StatusCode::OK, stub_graph())
}

pub async fn page_graph(State(state): State<AppState>) -> Response {
    if let Some(dir) = state.paths.static_dir.as_ref() {
        if let Some(html) = read_html(dir, "graph.html") {
            return html_response(StatusCode::OK, html);
        }
    }
    // While a rebuild is in flight and graph-data is not yet on disk, show placeholder.
    let rebuilding = state
        .status
        .lock()
        .map(|s| s.rebuilding)
        .unwrap_or(false);
    let missing_data = state
        .paths
        .graph_data
        .as_ref()
        .map(|p| !p.exists())
        .unwrap_or(false);
    if rebuilding && missing_data {
        return html_response(StatusCode::SERVICE_UNAVAILABLE, building_placeholder());
    }
    html_response(StatusCode::OK, stub_graph())
}

pub async fn page_now(State(state): State<AppState>) -> Response {
    serve_named(&state, "now.html", stub_now()).await
}

pub async fn page_daw(State(state): State<AppState>) -> Response {
    serve_named(&state, "daw-builder.html", stub_missing("DAW Builder")).await
}

pub async fn page_mapping(State(state): State<AppState>) -> Response {
    serve_named(&state, "kind-map.html", stub_missing("Kind map")).await
}

/// Resolve default static dir: cwd, then parent kaaroSessions repo root.
pub fn resolve_static_dir(explicit: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        return if p.is_dir() { Some(p) } else { None };
    }
    let candidates = [
        PathBuf::from("."),
        PathBuf::from(".."),
        PathBuf::from("../.."),
    ];
    for c in candidates {
        if c.join("graph.html").is_file() || c.join("now.html").is_file() || c.join("home.html").is_file() {
            return Some(c.canonicalize().unwrap_or(c));
        }
    }
    // Still useful as lookup root even without artifacts (stubs used).
    Some(PathBuf::from("."))
}
