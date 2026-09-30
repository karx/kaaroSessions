//! Canonical tool-action vocabulary — port of `hooks/action-keys.mjs`.

/// Ordered canonical tool-action keys (matches JS `TOOL_ACTION_KEYS`).
pub const TOOL_ACTION_KEYS: &[&str] = &[
    "read",
    "write",
    "edit",
    "grep_glob",
    "agent",
    "bash_git",
    "bash_run",
    "bash_other",
    "web",
    "other",
];

fn is_bash_tool_name(name: &str) -> bool {
    matches!(
        name.to_lowercase().trim(),
        "bash"
            | "powershell"
            | "shell"
            | "run_command"
            | "runinterminal"
            | "run_in_terminal"
            | "run_terminal_command"
            | "shell_command"
            | "exec_command"
    )
}

/// Map raw tool name + optional bash category → canonical key.
pub fn tool_name_to_key(name: Option<&str>, category: Option<&str>) -> &'static str {
    let t = name.unwrap_or("").to_lowercase();
    let t = t.trim();
    if matches!(t, "read" | "view_file" | "read_file" | "readfile") {
        return "read";
    }
    if matches!(t, "write" | "write_to_file" | "createfile" | "create_file") {
        return "write";
    }
    if matches!(
        t,
        "edit"
            | "replace_file_content"
            | "search_replace"
            | "strreplace"
            | "editnotebook"
            | "editfile"
            | "replacestring"
            | "applypatch"
            | "insert_edit_into_file"
            | "replace_string_in_file"
            | "apply_patch"
            | "multi_replace_file_content"
    ) {
        return "edit";
    }
    if matches!(
        t,
        "grep"
            | "glob"
            | "grep_search"
            | "list_dir"
            | "findtextinfiles"
            | "filesearch"
            | "listdirectory"
            | "codebase"
            | "file_search"
            | "semantic_search"
            | "findfiles"
            | "searchcodebase"
    ) {
        return "grep_glob";
    }
    if matches!(t, "agent" | "task" | "spawn_subagent") {
        return "agent";
    }
    if is_bash_tool_name(t) {
        return match category {
            Some("git") => "bash_git",
            Some(c) if matches!(c, "npm" | "npx" | "node" | "python") => "bash_run",
            _ => "bash_other",
        };
    }
    if matches!(
        t,
        "web_fetch" | "webfetch" | "web_search" | "websearch" | "web search:" | "fetchwebpage"
    ) {
        return "web";
    }
    "other"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_write_bash() {
        assert_eq!(tool_name_to_key(Some("Read"), None), "read");
        assert_eq!(tool_name_to_key(Some("Bash"), Some("git")), "bash_git");
        assert_eq!(tool_name_to_key(Some("Bash"), Some("npm")), "bash_run");
        assert_eq!(tool_name_to_key(Some("Weird"), None), "other");
    }
}
