//! Default session roots per harness — port of `hooks/harness-paths.mjs`.
//! All roots are overridable via [`crate::analyze::RootOverrides`].

use std::path::PathBuf;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn claude_projects_root() -> PathBuf {
    home().join(".claude").join("projects")
}

pub fn codex_home_root() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".codex"))
}

pub fn pi_sessions_root() -> PathBuf {
    home().join(".pi").join("agent").join("sessions")
}

pub fn antigravity_brain_root() -> PathBuf {
    home().join(".gemini").join("antigravity").join("brain")
}

pub fn grok_sessions_root() -> PathBuf {
    home().join(".grok").join("sessions")
}

pub fn opencode_storage_root() -> PathBuf {
    home()
        .join(".local")
        .join("share")
        .join("opencode")
        .join("storage")
}

/// VS Code user-data `workspaceStorage` (platform-specific).
pub fn copilot_workspace_storage_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData").join("Roaming"));
        return appdata.join("Code").join("User").join("workspaceStorage");
    }
    #[cfg(target_os = "macos")]
    {
        return home()
            .join("Library")
            .join("Application Support")
            .join("Code")
            .join("User")
            .join("workspaceStorage");
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        home()
            .join(".config")
            .join("Code")
            .join("User")
            .join("workspaceStorage")
    }
}

pub fn command_code_projects_root() -> PathBuf {
    home().join(".commandcode").join("projects")
}
