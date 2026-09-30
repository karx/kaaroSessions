//! kaaro-core — NormalizedRecord, adapters, reducer, enrich, registry, scan,
//! sessions-data output, graph pipeline, pulse transform.

pub mod action_keys;
pub mod adapters;
pub mod analyze;
pub mod enrich_session;
pub mod graph_data;
pub mod graph_pipeline;
pub mod harness_paths;
pub mod helpers;
pub mod incremental;
pub mod jsonl;
pub mod normalized_record;
pub mod pulse_map;
pub mod policy;
pub mod signal_evaluator;
pub mod golden_sessions;
pub mod kind_map;
pub mod kind_map_build;
pub mod session_records;
pub mod trace_tree;
pub mod pulse_transformer;
pub mod registry;
pub mod scan_walk;
pub mod session_clusters;
pub mod session_locators;
pub mod session_reducer;
pub mod sessions_output;
pub mod subagent_discover;
pub mod watch_handlers;

pub use action_keys::tool_name_to_key;
pub use analyze::{collect_sessions, scan_all, RootOverrides};
pub use incremental::{
    merge_session_into_data, parse_session_flag, try_incremental_claude_code, SessionFlag,
};
pub use enrich_session::{enrich_project, enrich_session, tokens_work, ProjectSummary};
pub use graph_pipeline::{
    build_graph, build_graph_data_file, BuildGraphOpts, GraphBuildResult, GraphDataFile, GraphStats,
};
pub use jsonl::{tail_read, TailReadResult, MAX_JSONL_BYTES};
pub use normalized_record::{
    is_normalized_record, record_kinds, validate_normalized_record, ValidationResult, KIND_COUNT,
};
pub use pulse_map::{
    kind_pulse_entry, kind_routes, pulse_disposition, route_id_from_nr, route_id_from_pulse,
};
pub use kind_map::{
    add_unknown, apply_kind_map_pulse, build_kind_map_payload, kind_from_pulse, unknown_from_pulse,
    UNKNOWN_BUCKET_MAX,
};
pub use kind_map_build::{build_kind_map, gather_kind_map_traces, local_harness_flags, BuildKindMapOpts};
pub use session_records::{read_session_records, SessionRecords};
pub use trace_tree::{child_tree_key, reconstruct_trace_from_nrs, TraceReconOpts};
pub use action_keys::TOOL_ACTION_KEYS;
pub use pulse_transformer::{norm_records_to_pulses, Pulse, PulseCtx};
pub use registry::{get_enabled_harnesses, get_harness, harness_registry, HARNESS_IDS};
pub use session_reducer::{reduce_session, Session, SessionMeta};
pub use sessions_output::{
    build_sessions_output, sessions_data_to_json, validate_sessions_data, SessionsData,
};
pub use watch_handlers::{process_watch_filename, ProcessedWatch};
pub use policy::{default_home_dir, load_policy, load_policy_file, merge_policies};
pub use signal_evaluator::{
    build_signals_data, build_signals_data_from_sessions, empty_signals_data, evaluate_session,
    now_iso_utc,
};
pub use subagent_discover::{
    agent_id_from_sidechain_log, link_spawns, list_subagent_artifacts, parent_session_dir_from_log,
    stub_refs_from_artifacts, subagent_scan_dir_from_log, SubagentArtifact,
};
pub use session_locators::{
    locate_antigravity_session, locate_claude_code_session, locate_codex_session,
    locate_command_code_session, locate_copilot_session, locate_grok_session,
    locate_opencode_session, locate_pi_session, resolve_session_file, LocateHit,
};
