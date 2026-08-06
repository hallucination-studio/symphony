//! Conductor command construction and terminal observation.
//!
//! This boundary owns only the mechanical launch contract.  It does not
//! interpret Root/Cycle semantics or retry a `NeedsHuman` result.  Role
//! connection overrides are read from the backend environment, while the
//! current Linear token is supplied by Desktop's credential session.  Neither
//! is represented in a request, argv, `Debug` value, or terminal observation.

pub use crate::domain::{AgentKind, RoleLaunchConfig};
use crate::process::{ManagedProcess, ProcessError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const DEFAULT_CONDUCTOR_EXECUTABLE: &str = "conductor";
const ROLE_ENVIRONMENT_KEYS: [(&str, &str); 6] = [
    ("SYMPHONY_RECONCILE_CODEX_API_KEY", "RECONCILE"),
    ("SYMPHONY_RECONCILE_CODEX_BASE_URL", "RECONCILE"),
    ("SYMPHONY_ARTIST_CODEX_API_KEY", "ARTIST"),
    ("SYMPHONY_ARTIST_CODEX_BASE_URL", "ARTIST"),
    ("SYMPHONY_CRITIC_CODEX_API_KEY", "CRITIC"),
    ("SYMPHONY_CRITIC_CODEX_BASE_URL", "CRITIC"),
];

/// The complete input needed to launch one Root-bound Conductor.
///
/// Role API keys and base URLs deliberately do not appear here.  They are
/// selected from the backend environment by [`ConductorLauncher`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchRequest {
    pub root: String,
    pub repository: PathBuf,
    pub workspace: PathBuf,
    pub run_directory: PathBuf,
    pub max_cycles: u32,
    pub reconcile: RoleLaunchConfig,
    pub artist: RoleLaunchConfig,
    pub critic: RoleLaunchConfig,
}

pub type ConductorLaunchRequest = LaunchRequest;

impl LaunchRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        root: impl Into<String>,
        repository: impl Into<PathBuf>,
        workspace: impl Into<PathBuf>,
        run_directory: impl Into<PathBuf>,
        max_cycles: u32,
        reconcile: RoleLaunchConfig,
        artist: RoleLaunchConfig,
        critic: RoleLaunchConfig,
    ) -> Self {
        Self {
            root: root.into(),
            repository: repository.into(),
            workspace: workspace.into(),
            run_directory: run_directory.into(),
            max_cycles,
            reconcile,
            artist,
            critic,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConductorOutcome {
    Completed,
    NeedsHuman,
    Failed,
}

pub type ConductorStatus = ConductorOutcome;

/// Sanitized terminal process facts.  No raw stdout, reason text, argv, or
/// environment values cross this boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConductorObservation {
    pub outcome: ConductorOutcome,
    pub exit_code: Option<i32>,
    pub event_seen: bool,
}

pub type TerminalObservation = ConductorObservation;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchError {
    InvalidRequest,
    NotConnected,
    SpawnFailed,
    Process(ProcessError),
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self {
            Self::InvalidRequest => "invalid_conductor_launch_request",
            Self::NotConnected => "linear_not_connected",
            Self::SpawnFailed => "conductor_start_failed",
            Self::Process(error) => return error.fmt(formatter),
        };
        formatter.write_str(reason)
    }
}

impl std::error::Error for LaunchError {}

impl From<ProcessError> for LaunchError {
    fn from(error: ProcessError) -> Self {
        Self::Process(error)
    }
}

/// A live Conductor process owned by the scheduler.
pub struct RunningConductor {
    process: ManagedProcess,
}

impl std::fmt::Debug for RunningConductor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("RunningConductor").field("pid", &self.process.id()).finish()
    }
}

impl RunningConductor {
    pub fn id(&self) -> u32 {
        self.process.id()
    }

    #[cfg(unix)]
    pub fn process_group_id(&self) -> i32 {
        self.process.process_group_id()
    }

    pub fn wait(&mut self) -> Result<ConductorObservation, LaunchError> {
        let captured = self.process.wait_and_capture()?;
        Ok(observe_conductor_stdout(&captured.stdout, captured.exit_code))
    }

    pub fn try_observe(&mut self) -> Result<Option<ConductorObservation>, LaunchError> {
        let Some(captured) = self.process.try_capture_if_exited()? else {
            return Ok(None);
        };
        Ok(Some(observe_conductor_stdout(&captured.stdout, captured.exit_code)))
    }

    /// Stop the complete process tree, then return its ordinary terminal
    /// observation.  A stop never schedules a retry or recovery action.
    pub fn stop(&mut self, grace: Duration) -> Result<ConductorObservation, LaunchError> {
        let captured = self.process.stop_and_capture(grace)?;
        Ok(observe_conductor_stdout(&captured.stdout, captured.exit_code))
    }

    pub fn stop_within(&mut self, grace: Duration) -> Result<ConductorObservation, LaunchError> {
        self.stop(grace)
    }
}

/// Mechanical launcher for one Conductor executable.
pub struct ConductorLauncher {
    executable: PathBuf,
    role_environment: BTreeMap<String, OsString>,
    linear_token: Option<String>,
}

impl std::fmt::Debug for ConductorLauncher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConductorLauncher")
            .field("executable", &self.executable)
            .field("role_environment_keys", &self.role_environment.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl ConductorLauncher {
    /// Construct a launcher from the backend process environment.
    pub fn from_environment() -> Self {
        let executable = std::env::var_os("SYMPHONY_CONDUCTOR_EXECUTABLE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONDUCTOR_EXECUTABLE));
        Self::with_environment(executable, std::env::vars_os())
    }

    /// Construct a launcher using only the role environment values present in
    /// `environment`.  This form is useful for tests and for a backend that
    /// already owns a validated environment snapshot.
    pub fn with_environment<I, K, V>(executable: impl Into<PathBuf>, environment: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: Into<OsString>,
    {
        let allowed = ROLE_ENVIRONMENT_KEYS
            .iter()
            .map(|(name, _)| *name)
            .collect::<std::collections::HashSet<_>>();
        let role_environment = environment
            .into_iter()
            .filter_map(|(key, value)| {
                let key = key.as_ref().to_string_lossy().into_owned();
                allowed.contains(key.as_str()).then_some((key, value.into()))
            })
            .collect();
        Self { executable: executable.into(), role_environment, linear_token: None }
    }

    /// Set the current app-actor access token injected into each child as
    /// `LINEAR_API_KEY` (TM-CRED-005).  The child never sees the Desktop
    /// process value, the refresh token, or the credentials file.
    pub fn set_linear_token(&mut self, token: &str) {
        self.linear_token = Some(token.to_owned());
    }

    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self::with_environment(executable, std::env::vars_os())
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// Return the exact Conductor argv.  This contains no credentials.
    pub fn argv(&self, request: &LaunchRequest) -> Result<Vec<OsString>, LaunchError> {
        build_conductor_argv(request)
    }

    /// Safe operator display for a launch.  Environment values are never
    /// rendered; only the executable and non-secret argv are included.
    pub fn display(&self, request: &LaunchRequest) -> Result<String, LaunchError> {
        let args = self.argv(request)?;
        let mut display = self.executable.to_string_lossy().into_owned();
        for arg in args {
            display.push(' ');
            display.push_str(&quote_argument(&arg));
        }
        Ok(display)
    }

    pub fn launch(&self, request: &LaunchRequest) -> Result<RunningConductor, LaunchError> {
        let command = self.command(request)?;
        ManagedProcess::spawn(command).map(|process| RunningConductor { process }).map_err(
            |error| match error {
                ProcessError::SpawnFailed => LaunchError::SpawnFailed,
                other => LaunchError::Process(other),
            },
        )
    }

    fn command(&self, request: &LaunchRequest) -> Result<Command, LaunchError> {
        let args = self.argv(request)?;
        let mut command = Command::new(&self.executable);
        command
            .args(args)
            .current_dir(&request.repository)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            // Stderr is a private diagnostic channel owned by the Conductor;
            // do not inherit it into the Desktop's public process log.
            .stderr(Stdio::null());

        // Remove all role and generic Codex credential variables first.  A
        // role value is then mechanically copied only when non-empty.  With
        // no role value the child receives no CODEX_* override and can use its
        // own local Codex configuration.
        for (key, _) in ROLE_ENVIRONMENT_KEYS {
            command.env_remove(key);
        }
        command.env_remove("CODEX_API_KEY");
        command.env_remove("CODEX_BASE_URL");
        command.env_remove("SYMPHONY_CODEX_API_KEY");
        command.env_remove("SYMPHONY_CODEX_BASE_URL");
        for (key, value) in &self.role_environment {
            if !value.is_empty() {
                command.env(key, value);
            }
        }

        // The Linear token comes only from the Desktop credential session,
        // never from the inherited Desktop process environment.
        command.env_remove("LINEAR_API_KEY");
        command.env_remove("SYMPHONY_LINEAR_TOKEN");
        if let Some(token) = &self.linear_token {
            command.env("LINEAR_API_KEY", token);
        }
        Ok(command)
    }
}

/// Build the CLI arguments expected by `apps/conductor`.
pub fn build_conductor_argv(request: &LaunchRequest) -> Result<Vec<OsString>, LaunchError> {
    validate_request(request)?;
    let mut args = vec![
        OsString::from("run"),
        OsString::from("--linear-root"),
        OsString::from(&request.root),
        OsString::from("--workspace"),
        request.workspace.as_os_str().to_owned(),
        OsString::from("--dir"),
        request.run_directory.as_os_str().to_owned(),
    ];
    append_role_args(&mut args, "reconcile", &request.reconcile);
    append_role_args(&mut args, "artist", &request.artist);
    append_role_args(&mut args, "critic", &request.critic);
    args.extend([OsString::from("--max-cycles"), OsString::from(request.max_cycles.to_string())]);
    Ok(args)
}

pub fn conductor_argv(request: &LaunchRequest) -> Result<Vec<OsString>, LaunchError> {
    build_conductor_argv(request)
}

fn append_role_args(args: &mut Vec<OsString>, role: &str, config: &RoleLaunchConfig) {
    args.push(format!("--{role}-agent").into());
    let agent = match config.agent {
        AgentKind::Codex => "codex",
    };
    args.push(agent.into());
    if let Some(model) = config.model.as_deref().filter(|value| !value.is_empty()) {
        args.push(format!("--{role}-model").into());
        args.push(model.into());
    }
    if let Some(reasoning) = config.reasoning_effort.as_deref().filter(|value| !value.is_empty()) {
        args.push(format!("--{role}-reasoning-effort").into());
        args.push(reasoning.into());
    }
}

fn validate_request(request: &LaunchRequest) -> Result<(), LaunchError> {
    if request.root.is_empty()
        || request.root.contains('\0')
        || request.repository.as_os_str().is_empty()
        || request.workspace.as_os_str().is_empty()
        || request.run_directory.as_os_str().is_empty()
        || request.max_cycles == 0
    {
        return Err(LaunchError::InvalidRequest);
    }
    for config in [&request.reconcile, &request.artist, &request.critic] {
        if config.model.as_deref().is_some_and(|value| value.contains('\0'))
            || config.reasoning_effort.as_deref().is_some_and(|value| value.contains('\0'))
        {
            return Err(LaunchError::InvalidRequest);
        }
    }
    Ok(())
}

fn quote_argument(value: &OsStr) -> String {
    let value = value.to_string_lossy();
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-._/:".contains(character))
    {
        value.into_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// Parse the last structured `conductor_stopped` JSONL event.
///
/// Unknown/malformed lines are ignored.  A missing or malformed terminal
/// event is a failed ordinary observation; this function never retries and
/// never turns `NeedsHuman` into scheduling behavior.
pub fn observe_conductor_stdout(stdout: &[u8], exit_code: Option<i32>) -> ConductorObservation {
    let mut terminal = None;
    for line in stdout.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if value.get("event").and_then(Value::as_str) != Some("conductor_stopped") {
            continue;
        }
        terminal = Some(parse_terminal_status(&value));
    }
    let event_seen = terminal.is_some();
    ConductorObservation {
        outcome: terminal.unwrap_or(ConductorOutcome::Failed),
        exit_code,
        event_seen,
    }
}

pub fn parse_conductor_stopped(stdout: &[u8]) -> ConductorOutcome {
    observe_conductor_stdout(stdout, None).outcome
}

pub fn parse_terminal_observation(stdout: &[u8], exit_code: Option<i32>) -> ConductorObservation {
    observe_conductor_stdout(stdout, exit_code)
}

fn parse_terminal_status(value: &Value) -> ConductorOutcome {
    let Some(object) = value.as_object() else {
        return ConductorOutcome::Failed;
    };
    if object.contains_key("outcome") || object.contains_key("result") {
        return ConductorOutcome::Failed;
    }
    match object.get("status").and_then(Value::as_str) {
        Some("done") => ConductorOutcome::Completed,
        Some("needs_human") => ConductorOutcome::NeedsHuman,
        _ => ConductorOutcome::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::fs::{self, File};
    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "symphony-launch-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos(),
        ))
    }

    fn request() -> LaunchRequest {
        LaunchRequest::new(
            "ENG-123",
            "/tmp",
            "/tmp/symphony-workspace",
            "/tmp/symphony-run",
            4,
            role(Some("reconcile-model"), Some("low")),
            role(Some(""), Some("high")),
            role(None, None),
        )
    }

    fn role(model: Option<&str>, reasoning_effort: Option<&str>) -> RoleLaunchConfig {
        RoleLaunchConfig {
            agent: AgentKind::Codex,
            model: model.map(str::to_owned),
            reasoning_effort: reasoning_effort.map(str::to_owned),
        }
    }

    #[test]
    fn argv_contains_three_independent_role_flags_and_omits_empty_overrides() {
        let args = build_conductor_argv(&request()).expect("request should validate");
        let args =
            args.iter().map(|value| value.to_string_lossy().into_owned()).collect::<Vec<_>>();

        assert!(args.windows(2).any(|pair| pair == ["--reconcile-agent", "codex"]));
        assert!(args.windows(2).any(|pair| pair == ["--artist-agent", "codex"]));
        assert!(args.windows(2).any(|pair| pair == ["--critic-agent", "codex"]));
        assert!(args.windows(2).any(|pair| pair == ["--reconcile-model", "reconcile-model"]));
        assert!(args.windows(2).any(|pair| pair == ["--reconcile-reasoning-effort", "low"]));
        assert!(args.windows(2).any(|pair| pair == ["--artist-reasoning-effort", "high"]));
        assert!(!args.iter().any(|value| value == "--artist-model"));
        assert!(!args.iter().any(|value| value == "--critic-model"));
        assert!(!args.iter().any(|value| value == "--critic-reasoning-effort"));
    }

    #[test]
    fn terminal_parser_uses_the_last_structured_stopped_event() {
        let stdout = br#"{"event":"conductor_stopped","status":"done"}
{"event":"root_reconciled","decision":"cycle"}
{"event":"conductor_stopped","status":"needs_human","reason":"do not expose this"}
"#;
        let observation = observe_conductor_stdout(stdout, Some(0));
        assert_eq!(observation.outcome, ConductorOutcome::NeedsHuman);
        assert!(observation.event_seen);
        assert!(!format!("{observation:?}").contains("do not expose this"));
    }

    #[test]
    fn absent_or_unknown_terminal_event_is_failed() {
        assert_eq!(
            parse_conductor_stopped(br#"{"event":"conductor_started"}"#),
            ConductorOutcome::Failed
        );
        assert_eq!(
            parse_conductor_stopped(br#"{"event":"conductor_stopped","status":"other"}"#),
            ConductorOutcome::Failed
        );
    }

    #[test]
    fn terminal_parser_accepts_only_the_strict_status_field() {
        for line in [
            br#"{"event":"conductor_stopped","outcome":"done"}"#.as_slice(),
            br#"{"event":"conductor_stopped","result":"done"}"#.as_slice(),
            br#"{"event":"conductor_stopped","status":"done","outcome":"failed"}"#.as_slice(),
            br#"{"event":"conductor_stopped","status":true}"#.as_slice(),
            br#"{"event":"conductor_stopped","status":"completed"}"#.as_slice(),
            br#"{"event":"conductor_stopped","status":"needs-human"}"#.as_slice(),
        ] {
            let observation = observe_conductor_stdout(line, Some(0));
            assert_eq!(observation.outcome, ConductorOutcome::Failed);
            assert!(observation.event_seen);
        }

        assert_eq!(
            parse_conductor_stopped(br#"{"event":"conductor_stopped","status":"done"}"#),
            ConductorOutcome::Completed
        );
        assert_eq!(
            parse_conductor_stopped(br#"{"event":"conductor_stopped","status":"needs_human"}"#),
            ConductorOutcome::NeedsHuman
        );
    }

    #[test]
    fn malformed_last_terminal_event_overrides_an_earlier_valid_event() {
        let stdout = br#"{"event":"conductor_stopped","status":"done"}
{"event":"conductor_stopped","status":"done","result":"conflicting"}
"#;

        let observation = observe_conductor_stdout(stdout, Some(0));
        assert_eq!(observation.outcome, ConductorOutcome::Failed);
        assert!(observation.event_seen);
    }

    #[cfg(unix)]
    #[test]
    fn real_child_receives_role_argv_and_private_environment_only() {
        let directory = temporary_directory("mapping");
        fs::create_dir_all(&directory).expect("fixture directory should be created");
        let script = directory.join("fixture.sh");
        let argv_file = directory.join("argv");
        let environment_file = directory.join("environment");
        let workspace = directory.join("workspace");
        let run_directory = directory.join("run");
        fs::create_dir_all(&workspace).expect("workspace should exist");
        fs::create_dir_all(&run_directory).expect("run directory should exist");
        let mut file = File::create(&script).expect("script should be writable");
        writeln!(
            file,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' \"$SYMPHONY_RECONCILE_CODEX_API_KEY\" \"$SYMPHONY_RECONCILE_CODEX_BASE_URL\" \"$SYMPHONY_ARTIST_CODEX_API_KEY\" \"$SYMPHONY_ARTIST_CODEX_BASE_URL\" \"$SYMPHONY_CRITIC_CODEX_API_KEY\" \"$SYMPHONY_CRITIC_CODEX_BASE_URL\" \"${{CODEX_API_KEY-unset}}\" \"${{CODEX_BASE_URL-unset}}\" \"${{LINEAR_API_KEY-unset}}\" \"${{SYMPHONY_LINEAR_TOKEN-unset}}\" > '{}'\nprintf '%s\\n' '{{\"event\":\"conductor_stopped\",\"status\":\"done\"}}'",
            argv_file.display(),
            environment_file.display(),
        )
        .expect("script should be written");
        let mut permissions =
            fs::metadata(&script).expect("script metadata should be available").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).expect("script should be executable");

        let environment = [
            ("SYMPHONY_RECONCILE_CODEX_API_KEY", "reconcile-secret"),
            ("SYMPHONY_RECONCILE_CODEX_BASE_URL", "https://reconcile.invalid"),
            ("SYMPHONY_ARTIST_CODEX_API_KEY", "artist-secret"),
            ("SYMPHONY_ARTIST_CODEX_BASE_URL", "https://artist.invalid"),
            ("SYMPHONY_CRITIC_CODEX_API_KEY", "critic-secret"),
            ("SYMPHONY_CRITIC_CODEX_BASE_URL", "https://critic.invalid"),
            ("CODEX_API_KEY", "generic-secret-must-not-cross"),
            ("CODEX_BASE_URL", "https://generic.invalid"),
        ];
        let mut launcher = ConductorLauncher::with_environment(&script, environment);
        launcher.set_linear_token("linear-session-secret");
        let mut launch_request = request();
        launch_request.workspace = workspace;
        launch_request.run_directory = run_directory;
        let display = launcher.display(&launch_request).expect("display should be safe");
        assert!(!display.contains("secret"));
        assert!(!format!("{launcher:?}").contains("secret"));

        let mut process = launcher.launch(&launch_request).expect("fixture should start");
        let observation = process.wait().expect("fixture should stop");
        assert_eq!(observation.outcome, ConductorOutcome::Completed);
        assert_eq!(observation.exit_code, Some(0));

        let argv = fs::read_to_string(&argv_file).expect("argv fixture should write output");
        assert!(argv.contains("--linear-root\nENG-123\n"));
        assert!(argv.contains("--reconcile-model\nreconcile-model\n"));
        assert!(!argv.contains("--artist-model\n"));
        assert!(argv.contains("--critic-agent\ncodex\n"));

        let child_environment =
            fs::read_to_string(&environment_file).expect("environment should be written");
        assert!(child_environment.contains("reconcile-secret\nhttps://reconcile.invalid\n"));
        assert!(child_environment.contains("artist-secret\nhttps://artist.invalid\n"));
        assert!(child_environment.contains("critic-secret\nhttps://critic.invalid\n"));
        assert!(child_environment.contains("unset\nunset\n"));
        assert!(child_environment.contains("linear-session-secret\nunset\n"));
        assert!(!format!("{observation:?}").contains("secret"));

        fs::remove_dir_all(directory).expect("fixture directory should be cleaned");
    }
}
