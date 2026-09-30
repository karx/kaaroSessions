//! kaaro-sessions — analyze + build + serve.

use clap::{Parser, Subcommand};
use kaaro_core::analyze::{scan_all, RootOverrides};
use kaaro_core::graph_pipeline::{build_graph_data_file, BuildGraphOpts};
use kaaro_core::sessions_output::{build_sessions_output, sessions_data_to_json};
use kaaro_core::{
    build_signals_data_from_sessions, default_home_dir, load_policy, now_iso_utc,
    parse_session_flag, try_incremental_claude_code,
};
use kaaro_core::harness_paths;
use kaaro_surface::{
    create_router, in_process_runners, resolve_static_dir, resolve_watch_roots, AppState,
    FileWatchService, Rebuilder, SurfacePaths, SurfaceStatus,
};
use std::time::Duration;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(
    name = "kaaro-sessions",
    about = "Live observability for AI coding sessions — Rust port",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Scan harness roots and write sessions-data.json
    Analyze(AnalyzeArgs),
    /// Build graph-data.json from sessions-data.json (JSON only; HTML stubbed)
    Build(BuildArgs),
    /// Serve snapshot JSON APIs + SSE (default port 3333)
    Serve(ServeArgs),
}

#[derive(Parser, Debug)]
struct AnalyzeArgs {
    /// Output path for sessions-data.json
    #[arg(short, long, default_value = "sessions-data.json")]
    output: PathBuf,

    /// Override Claude Code projects root (~/.claude/projects)
    #[arg(long)]
    claude_code_root: Option<PathBuf>,

    /// Override Codex home (~/.codex)
    #[arg(long)]
    codex_root: Option<PathBuf>,

    /// Override Pi sessions root (~/.pi/agent/sessions)
    #[arg(long)]
    pi_root: Option<PathBuf>,

    /// Override Grok sessions root (~/.grok/sessions)
    #[arg(long)]
    grok_root: Option<PathBuf>,

    /// Override Antigravity brain root (~/.gemini/antigravity/brain)
    #[arg(long)]
    antigravity_root: Option<PathBuf>,

    /// Override OpenCode storage root (~/.local/share/opencode/storage)
    #[arg(long)]
    opencode_root: Option<PathBuf>,

    /// Override Copilot workspaceStorage root
    #[arg(long)]
    copilot_root: Option<PathBuf>,

    /// Override Command Code projects root (~/.commandcode/projects)
    #[arg(long)]
    command_code_root: Option<PathBuf>,

    /// Compact JSON (default is pretty)
    #[arg(long)]
    compact: bool,

    /// Incremental Claude Code update: `projectId/sessionId` (or `…/sessionId.jsonl`)
    #[arg(long, value_name = "PROJECT/SESSION")]
    session: Option<String>,

    /// Output path for signals-data.json (default: beside sessions output)
    #[arg(long)]
    signals_output: Option<PathBuf>,

    /// Project dir for `.agents/policy.json` (default: cwd)
    #[arg(long)]
    policy_project_dir: Option<PathBuf>,

    /// Home dir for `~/.agents/policy.json` (default: $HOME)
    #[arg(long)]
    policy_home_dir: Option<PathBuf>,
}

#[derive(Parser, Debug)]
struct BuildArgs {
    /// Input sessions-data.json
    #[arg(short, long, default_value = "sessions-data.json")]
    input: PathBuf,

    /// Output graph-data.json
    #[arg(short, long, default_value = "graph-data.json")]
    output: PathBuf,

    /// Min sessions for a file node to appear
    #[arg(long, default_value_t = 1)]
    min_sessions: usize,

    /// Emit type:subagent nodes + spawn edges
    #[arg(long, default_value_t = true)]
    include_subagents: bool,

    /// Compact JSON (default is pretty)
    #[arg(long)]
    compact: bool,
}

#[derive(Parser, Debug)]
struct ServeArgs {
    /// Listen port
    #[arg(long, default_value_t = 3333)]
    port: u16,

    /// Path to graph-data.json (503 if missing; rebuild output)
    #[arg(long, default_value = "graph-data.json")]
    graph_data: PathBuf,

    /// Path to sessions-data.json (rebuild analyze output)
    #[arg(long, default_value = "sessions-data.json")]
    sessions_data: PathBuf,

    /// Path to signals-data.json (analyze / rebuild output)
    #[arg(long, default_value = "signals-data.json")]
    signals_data: PathBuf,

    /// Directory with JS-built HTML (graph.html, now.html, home.html, …)
    #[arg(long)]
    static_dir: Option<PathBuf>,

    /// Bind address
    #[arg(long, default_value = "127.0.0.1")]
    bind: String,

    /// Poll harness roots and pulse on JSONL/JSON changes (default on)
    #[arg(long, default_value_t = true)]
    watch: bool,

    /// Disable filesystem watch / pulse tail
    #[arg(long, default_value_t = false)]
    no_watch: bool,

    /// Debounce before pulsing a changed file (ms)
    #[arg(long, default_value_t = 1500)]
    watch_debounce_ms: u64,

    /// Poll interval for the watch walker (ms)
    #[arg(long, default_value_t = 500)]
    watch_poll_ms: u64,

    /// Debounced analyze→build on change + startup (default on)
    #[arg(long, default_value_t = true)]
    rebuild: bool,

    /// Disable rebuild orchestrator
    #[arg(long, default_value_t = false)]
    no_rebuild: bool,

    /// Debounce window for schedule_rebuild (ms); defaults to watch-debounce-ms
    #[arg(long)]
    rebuild_debounce_ms: Option<u64>,

    /// Override Claude Code projects root for watch / rebuild scan
    #[arg(long)]
    claude_code_root: Option<PathBuf>,

    /// Override Pi sessions root for watch / rebuild scan
    #[arg(long)]
    pi_root: Option<PathBuf>,

    /// Override Codex home for watch / rebuild scan
    #[arg(long)]
    codex_root: Option<PathBuf>,

    /// Override OpenCode storage root for watch / rebuild scan
    #[arg(long)]
    opencode_root: Option<PathBuf>,

    /// Override Grok sessions root for watch / rebuild scan
    #[arg(long)]
    grok_root: Option<PathBuf>,

    /// Override Antigravity brain root for watch / rebuild scan
    #[arg(long)]
    antigravity_root: Option<PathBuf>,

    /// Override Copilot workspaceStorage for watch / rebuild scan
    #[arg(long)]
    copilot_root: Option<PathBuf>,

    /// Override Command Code projects root for watch / rebuild scan
    #[arg(long)]
    command_code_root: Option<PathBuf>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let cmd = cli.command.unwrap_or(Commands::Analyze(AnalyzeArgs {
        output: PathBuf::from("sessions-data.json"),
        claude_code_root: None,
        codex_root: None,
        pi_root: None,
        grok_root: None,
        antigravity_root: None,
        opencode_root: None,
        copilot_root: None,
        command_code_root: None,
        compact: false,
        session: None,
        signals_output: None,
        policy_project_dir: None,
        policy_home_dir: None,
    }));

    let result = match cmd {
        Commands::Analyze(args) => run_analyze(args),
        Commands::Build(args) => run_build(args),
        Commands::Serve(args) => run_serve(args),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run_analyze(args: AnalyzeArgs) -> Result<(), String> {
    let overrides = RootOverrides {
        claude_code: args.claude_code_root,
        codex: args.codex_root,
        pi: args.pi_root,
        antigravity: args.antigravity_root,
        grok: args.grok_root,
        opencode: args.opencode_root,
        copilot: args.copilot_root,
        command_code: args.command_code_root,
    };

    let data = if let Some(ref sess) = args.session {
        let flag = parse_session_flag(&[format!("--session={sess}")]).ok_or_else(|| {
            format!("malformed --session={sess} (expected projectId/sessionId)")
        })?;
        let cc_root = overrides
            .claude_code
            .clone()
            .unwrap_or_else(harness_paths::claude_projects_root);
        match try_incremental_claude_code(&args.output, &flag.project_id, &flag.session_id, &cc_root)?
        {
            Some(merged) => {
                eprintln!(
                    "Incremental: updated {}/{}",
                    flag.project_id, flag.session_id
                );
                merged
            }
            None => {
                eprintln!("No existing data — falling back to full scan");
                let envelopes = scan_all(&overrides);
                for env in &envelopes {
                    eprintln!(
                        "scanned {} ({}): {} session(s)",
                        env.harness,
                        env.source_dir.display(),
                        env.sessions.len()
                    );
                }
                build_sessions_output(&envelopes)
            }
        }
    } else {
        let envelopes = scan_all(&overrides);
        if envelopes.is_empty() {
            eprintln!("warning: no harness roots found / no sessions scanned");
        } else {
            for env in &envelopes {
                eprintln!(
                    "scanned {} ({}): {} session(s)",
                    env.harness,
                    env.source_dir.display(),
                    env.sessions.len()
                );
            }
        }
        build_sessions_output(&envelopes)
    };
    let json = if args.compact {
        serde_json::to_string(&data).map_err(|e| e.to_string())?
    } else {
        sessions_data_to_json(&data).map_err(|e| e.to_string())?
    };

    if let Some(parent) = args.output.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&args.output, json.as_bytes()).map_err(|e| e.to_string())?;
    eprintln!(
        "wrote {} ({} sessions, {} projects)",
        args.output.display(),
        data.meta.total_sessions,
        data.meta.total_projects
    );

    let signals_path = args.signals_output.unwrap_or_else(|| {
        args.output
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("signals-data.json")
    });
    let project_dir = args
        .policy_project_dir
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let home_dir = args.policy_home_dir.unwrap_or_else(default_home_dir);
    let policy = load_policy(&project_dir, &home_dir);
    let signals = build_signals_data_from_sessions(&data.sessions, policy.as_ref(), &now_iso_utc());
    let signals_json = serde_json::to_string_pretty(&signals).map_err(|e| e.to_string())?;
    if let Some(parent) = signals_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&signals_path, signals_json.as_bytes()).map_err(|e| e.to_string())?;
    let total = signals
        .get("total_signals")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if total > 0 {
        let by = signals
            .get("by_level")
            .and_then(|v| v.as_object())
            .map(|m| {
                m.iter()
                    .map(|(k, v)| format!("{} {}", v, k))
                    .collect::<Vec<_>>()
                    .join(" · ")
            })
            .unwrap_or_default();
        eprintln!("Signals: {total} ({by})");
    }
    eprintln!("wrote {}", signals_path.display());
    Ok(())
}

fn run_build(args: BuildArgs) -> Result<(), String> {
    let raw = std::fs::read_to_string(&args.input).map_err(|e| {
        format!("read {}: {e}", args.input.display())
    })?;
    let data: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse sessions-data: {e}"))?;

    let opts = BuildGraphOpts {
        min_sessions: args.min_sessions,
        include_subagent_nodes: args.include_subagents,
        ..Default::default()
    };
    let file = build_graph_data_file(&data, opts);
    let session_nodes = file
        .nodes
        .iter()
        .filter(|n| n.get("type").and_then(|t| t.as_str()) == Some("session"))
        .count();
    let project_nodes = file
        .nodes
        .iter()
        .filter(|n| n.get("type").and_then(|t| t.as_str()) == Some("project"))
        .count();
    let file_nodes = file
        .nodes
        .iter()
        .filter(|n| n.get("type").and_then(|t| t.as_str()) == Some("file"))
        .count();

    let json = if args.compact {
        serde_json::to_string(&file).map_err(|e| e.to_string())?
    } else {
        file.to_json_pretty().map_err(|e| e.to_string())?
    };

    if let Some(parent) = args.output.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&args.output, json.as_bytes()).map_err(|e| e.to_string())?;
    eprintln!(
        "Graph: {} nodes ({} project · {} session · {} file)  edges: {}",
        file.nodes.len(),
        project_nodes,
        session_nodes,
        file_nodes,
        file.edges.len()
    );
    eprintln!("wrote {}", args.output.display());
    Ok(())
}

#[tokio::main]
async fn run_serve(args: ServeArgs) -> Result<(), String> {
    let static_dir = resolve_static_dir(args.static_dir.clone());
    if let Some(ref d) = static_dir {
        eprintln!("static-dir: {}", d.display());
    }

    let state = AppState::new(
        SurfacePaths {
            graph_data: Some(args.graph_data.clone()),
            sessions_data: Some(args.sessions_data.clone()),
            signals: Some(args.signals_data.clone()),
            static_dir,
        },
        SurfaceStatus {
            rebuilding: false,
            last_built: None,
            clients: 0,
            port: args.port,
        },
    );

    let roots_overrides = RootOverrides {
        claude_code: args.claude_code_root.clone(),
        codex: args.codex_root.clone(),
        pi: args.pi_root.clone(),
        antigravity: args.antigravity_root.clone(),
        grok: args.grok_root.clone(),
        opencode: args.opencode_root.clone(),
        copilot: args.copilot_root.clone(),
        command_code: args.command_code_root.clone(),
    };

    state.trace.set_roots_from_overrides(&roots_overrides);

    let rebuild_enabled = args.rebuild && !args.no_rebuild;
    let rebuild_debounce = args
        .rebuild_debounce_ms
        .unwrap_or(args.watch_debounce_ms);

    let rebuilder = if rebuild_enabled {
        let (analyze, build) = in_process_runners(
            args.sessions_data.clone(),
            args.graph_data.clone(),
            args.signals_data.clone(),
            roots_overrides.clone(),
        );
        let rb = Rebuilder::new(
            state.hub.clone(),
            state.status.clone(),
            analyze,
            build,
            rebuild_debounce,
            None,
        );
        Some(rb)
    } else {
        None
    };

    let watch_enabled = args.watch && !args.no_watch;
    if watch_enabled {
        let roots = resolve_watch_roots(
            args.claude_code_root.clone(),
            args.codex_root.clone(),
            args.pi_root.clone(),
            args.antigravity_root.clone(),
            args.grok_root.clone(),
            args.opencode_root.clone(),
            args.copilot_root.clone(),
            args.command_code_root.clone(),
        );
        if roots.is_empty() {
            eprintln!("watch: no harness roots found — live pulse disabled");
        } else {
            for r in &roots {
                eprintln!("Watching [{}]: {}", r.harness_id, r.root.display());
            }
            let svc = FileWatchService::with_rebuilder_and_trace(
                roots,
                (*state.emitter).clone(),
                Duration::from_millis(args.watch_debounce_ms),
                rebuilder.clone(),
                Some(state.trace.clone()),
            );
            let _watch_task = svc.spawn(Duration::from_millis(args.watch_poll_ms));
        }
    } else {
        eprintln!("watch: disabled (--no-watch)");
    }

    if let Some(ref rb) = rebuilder {
        eprintln!(
            "rebuild: enabled (debounce {}ms) → {} + {}",
            rebuild_debounce,
            args.sessions_data.display(),
            args.graph_data.display()
        );
        let rb = rb.clone();
        tokio::spawn(async move {
            rb.rebuild(None).await;
        });
    } else {
        eprintln!("rebuild: disabled (--no-rebuild)");
    }

    let app = create_router(state);
    let addr: SocketAddr = format!("{}:{}", args.bind, args.port)
        .parse()
        .map_err(|e| format!("bad bind address: {e}"))?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| e.to_string())?;
    eprintln!("kaaro-sessions surface listening on http://{addr}");
    eprintln!("  UI:  /  /graph  /now  /daw  /mapping");
    eprintln!("  API: /status  /api/harnesses  /api/active  /api/signals  /api/kind-map  /api/trace/:id  /graph-data.json  /events");
    axum::serve(listener, app)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
