//! Podium's narrow Linear candidate boundary.
//!
//! This module deliberately knows only how to read top-level Todo or replied
//! Needs Human Root Issues for one persisted [`ProjectBinding`].  A Needs Human
//! candidate requires an unprocessed direct human reply under the current
//! Human Action comment. It does not sort candidates or make scheduling
//! decisions; the scheduler owns that policy.

use crate::domain::{ProjectBinding, RootCandidate};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, RwLock};

const LINEAR_GRAPHQL_ENDPOINT: &str = "https://api.linear.app/graphql";
const ROOT_CANDIDATES_OPERATION: &str = "ListPodiumRootCandidates";
const ROOT_COMMENTS_OPERATION: &str = "ListPodiumRootComments";
const ROOT_ACTION_REPLIES_OPERATION: &str = "ListPodiumHumanActionReplies";
const PROJECTS_OPERATION: &str = "ListPodiumProjects";
const ROOT_CANDIDATES_QUERY: &str = r#"
query ListPodiumRootCandidates($projectId: ID!, $routingLabel: String!, $cursor: String, $first: Int!) {
  issues(
    filter: {
      project: { id: { eq: $projectId } }
      labels: { name: { eq: $routingLabel } }
      state: { type: { in: [unstarted, started] } }
      parent: { null: true }
    }
    after: $cursor
    first: $first
  ) {
    nodes {
      id
      identifier
      title
      priority
      createdAt
      project { id }
      state { name type }
      parent { id }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"#;
const ROOT_COMMENTS_QUERY: &str = r#"
query ListPodiumRootComments($rootId: ID!, $cursor: String, $first: Int!) {
  issue(id: $rootId) {
    comments(after: $cursor, first: $first) {
      nodes { id body createdAt user { id } parent { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;
const ROOT_ACTION_REPLIES_QUERY: &str = r#"
query ListPodiumHumanActionReplies($commentId: ID!, $cursor: String, $first: Int!) {
  comment(id: $commentId) {
    children(after: $cursor, first: $first) {
      nodes {
        id
        body
        createdAt
        user { id }
        reactions(first: $first) {
          nodes { emoji user { id } }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;
const PROJECTS_QUERY: &str = r#"
query ListPodiumProjects($cursor: String, $first: Int!) {
  projects(after: $cursor, first: $first) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
}
"#;

const DEFAULT_PAGE_SIZE: usize = 50;
const DEFAULT_MAX_PAGES: usize = 100;
const MAX_IDENTIFIER_LENGTH: usize = 256;
const MAX_TITLE_LENGTH: usize = 4_096;
const MAX_COMMENT_BODY_LENGTH: usize = 100_000;
const MAX_TIMESTAMP_LENGTH: usize = 128;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const HARNESS_COMMENT_MARKER: &str = "# Symphony Harness:";
const HUMAN_ACTION_COMMENT_MARKER: &str = "# Symphony Harness: Human Action";

/// A request sent to an injectable GraphQL transport.
///
/// Credentials are intentionally not part of this value.  The transport
/// receives the access token as a separate argument, so serializing or
/// formatting a request can never expose it.
#[derive(Clone, PartialEq)]
pub struct GraphqlRequest {
    pub operation: &'static str,
    pub query: &'static str,
    pub variables: Value,
}

impl fmt::Debug for GraphqlRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GraphqlRequest")
            .field("operation", &self.operation)
            .field("query", &"<redacted-query>")
            .field("variables", &self.variables)
            .finish()
    }
}

impl GraphqlRequest {
    fn body(&self) -> Value {
        json!({ "query": self.query, "variables": self.variables })
    }
}

/// Sanitized errors returned by a transport implementation.
///
/// Implementations should map network/client details to one of these variants
/// rather than returning a provider body.  The candidate adapter also maps
/// every transport failure to a bounded public error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    RequestFailed,
    ResponseTooLarge,
    InvalidResponse,
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::RequestFailed => "linear_transport_failed",
            Self::ResponseTooLarge => "linear_response_too_large",
            Self::InvalidResponse => "linear_transport_response_invalid",
        })
    }
}

impl std::error::Error for TransportError {}

/// HTTP/GraphQL transport owned by the caller or by the production adapter.
///
/// The access token is passed only for the duration of the call.  It is never
/// placed in a request value, response value, error, or debug representation.
pub trait LinearTransport: Send + Sync {
    fn execute(
        &self,
        endpoint: &str,
        request: &GraphqlRequest,
        access_token: &str,
    ) -> Result<Value, TransportError>;
}

impl<F> LinearTransport for F
where
    F: Fn(&str, &GraphqlRequest, &str) -> Result<Value, TransportError> + Send + Sync,
{
    fn execute(
        &self,
        endpoint: &str,
        request: &GraphqlRequest,
        access_token: &str,
    ) -> Result<Value, TransportError> {
        self(endpoint, request, access_token)
    }
}

/// A sanitized candidate-boundary error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinearError {
    MissingApiKey,
    InvalidRequest,
    Transport,
    Provider,
    InvalidResponse,
    PaginationLimit,
}

impl fmt::Display for LinearError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MissingApiKey => "linear_api_key_missing",
            Self::InvalidRequest => "linear_candidate_request_invalid",
            Self::Transport => "linear_transport_failed",
            Self::Provider => "linear_provider_failed",
            Self::InvalidResponse => "linear_candidate_response_invalid",
            Self::PaginationLimit => "linear_candidate_pagination_limit",
        })
    }
}

impl std::error::Error for LinearError {}

/// The normalized fields Podium needs from a Linear Root Issue.
#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinearRoot {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub priority: u8,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RootComment {
    id: String,
    body: String,
    created_at: String,
    author_id: String,
    parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RootReply {
    id: String,
    body: String,
    created_at: String,
    author_id: String,
    reactions: Vec<CommentReaction>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommentReaction {
    emoji: String,
    author_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RootCandidateState {
    Todo,
    NeedsHuman,
}

/// The complete provider data exposed by the first-run Project picker.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinearProject {
    pub id: String,
    pub name: String,
}

impl fmt::Debug for LinearRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinearRoot")
            .field("id", &self.id)
            .field("identifier", &self.identifier)
            .field("title", &self.title)
            .field("priority", &self.priority)
            .field("created_at", &self.created_at)
            .finish()
    }
}

impl LinearRoot {
    /// Convert the provider root to the domain candidate consumed by the
    /// scheduler.  Provider IDs are the stable identity used for allocations
    /// and Conductor launches; `identifier` remains display-only metadata.
    pub fn to_root_candidate(&self) -> RootCandidate {
        RootCandidate {
            id: self.id.clone(),
            priority: self.priority,
            created_at: self.created_at.clone(),
        }
    }

    pub fn root_candidate(&self) -> RootCandidate {
        self.to_root_candidate()
    }
}

/// Injectable, bounded Linear candidate adapter.
pub struct LinearCandidateAdapter<T> {
    transport: T,
    access_token: Arc<RwLock<Arc<str>>>,
    endpoint: String,
    page_size: usize,
    max_pages: usize,
}

pub type LinearRootAdapter<T> = LinearCandidateAdapter<T>;
pub type LinearClient<T> = LinearCandidateAdapter<T>;

impl<T> fmt::Debug for LinearCandidateAdapter<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinearCandidateAdapter")
            .field("endpoint", &self.endpoint)
            .field("page_size", &self.page_size)
            .field("max_pages", &self.max_pages)
            .field("access_token", &"<redacted>")
            .finish()
    }
}

impl<T: LinearTransport> LinearCandidateAdapter<T> {
    pub fn new(transport: T, access_token: impl Into<String>) -> Result<Self, LinearError> {
        Self::with_limits(transport, access_token, DEFAULT_PAGE_SIZE, DEFAULT_MAX_PAGES)
    }

    pub fn with_limits(
        transport: T,
        access_token: impl Into<String>,
        page_size: usize,
        max_pages: usize,
    ) -> Result<Self, LinearError> {
        let token = validate_access_token(access_token.into())?;
        if page_size == 0 || page_size > 100 || max_pages == 0 || max_pages > DEFAULT_MAX_PAGES {
            return Err(LinearError::InvalidRequest);
        }
        Ok(Self {
            transport,
            access_token: Arc::new(RwLock::new(Arc::<str>::from(token))),
            endpoint: LINEAR_GRAPHQL_ENDPOINT.to_owned(),
            page_size,
            max_pages,
        })
    }

    /// An adapter without a configured token.  Desktop wires this to its
    /// credential session: `set_access_token` must provide the current
    /// app-actor token before any query (TM-CRED-005).
    pub fn deferred(transport: T) -> Self {
        Self {
            transport,
            access_token: Arc::new(RwLock::new(Arc::<str>::from(""))),
            endpoint: LINEAR_GRAPHQL_ENDPOINT.to_owned(),
            page_size: DEFAULT_PAGE_SIZE,
            max_pages: DEFAULT_MAX_PAGES,
        }
    }

    pub fn set_access_token(&self, token: &str) {
        if let Ok(mut current) = self.access_token.write() {
            *current = Arc::<str>::from(token);
        }
    }

    pub fn from_environment(transport: T) -> Result<Self, LinearError> {
        Self::new(transport, resolve_access_token(std::env::vars_os())?)
    }

    pub fn with_environment<I, K, V>(transport: T, environment: I) -> Result<Self, LinearError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<std::ffi::OsStr>,
        V: Into<std::ffi::OsString>,
    {
        Self::new(transport, resolve_access_token(environment)?)
    }

    pub fn access_token_is_configured(&self) -> bool {
        self.access_token.read().map(|token| !token.is_empty()).unwrap_or(false)
    }

    /// Query and normalize one binding's top-level Root candidates.
    ///
    /// Results preserve provider order.  Priority and creation ordering remain
    /// scheduler policy and are intentionally not performed here.
    pub fn list_root_candidates(
        &self,
        binding: &ProjectBinding,
    ) -> Result<Vec<LinearRoot>, LinearError> {
        validate_binding(binding)?;
        let access_token = self.access_token.read().map_err(|_| LinearError::Transport)?.clone();
        if access_token.is_empty() {
            return Err(LinearError::MissingApiKey);
        }
        let mut candidates = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_ids = HashSet::new();

        for page in 0..self.max_pages {
            let request = GraphqlRequest {
                operation: ROOT_CANDIDATES_OPERATION,
                query: ROOT_CANDIDATES_QUERY,
                variables: json!({
                    "projectId": binding.project_id,
                    "routingLabel": binding.routing_label,
                    "cursor": cursor,
                    "first": self.page_size,
                }),
            };
            let envelope = self
                .transport
                .execute(&self.endpoint, &request, &access_token)
                .map_err(|_| LinearError::Transport)?;
            let data = parse_envelope(envelope)?;
            let connection = object_field(&data, "issues")?;
            let nodes = array_field(connection, "nodes")?;
            let page_info = object_field(connection, "pageInfo")?;
            let has_next = bool_field(page_info, "hasNextPage")?;
            let next_cursor = nullable_string_field(page_info, "endCursor")?;

            for node in nodes {
                let node = object(node)?;
                let Some(state) = root_candidate_state(node, binding)? else { continue };
                let root = parse_root(node)?;
                if state == RootCandidateState::NeedsHuman
                    && !self.has_replied_needs_human(&root.id, &access_token)?
                {
                    continue;
                }
                if seen_ids.insert(root.id.clone()) {
                    candidates.push(root);
                }
            }

            if !has_next {
                return Ok(candidates);
            }
            let Some(next) = next_cursor else {
                return Err(LinearError::InvalidResponse);
            };
            if next.is_empty() || cursor.as_deref() == Some(next.as_str()) {
                return Err(LinearError::InvalidResponse);
            }
            if page + 1 == self.max_pages {
                return Err(LinearError::PaginationLimit);
            }
            cursor = Some(next);
        }
        Err(LinearError::PaginationLimit)
    }

    fn has_replied_needs_human(
        &self,
        root_id: &str,
        access_token: &str,
    ) -> Result<bool, LinearError> {
        let comments = self.list_root_comments(root_id, access_token)?;
        let Some(action) = comments
            .iter()
            .filter(|comment| comment.parent_id.is_none() && is_human_action_comment(&comment.body))
            .max_by(|left, right| {
                left.created_at.cmp(&right.created_at).then(left.id.cmp(&right.id))
            })
        else {
            return Ok(false);
        };
        let replies = self.list_action_replies(&action.id, access_token)?;
        Ok(replies.iter().any(|reply| {
            !reply.body.starts_with(HARNESS_COMMENT_MARKER)
                && reply.author_id != action.author_id
                && !reply.reactions.iter().any(|reaction| {
                    reaction.author_id == action.author_id
                        && matches!(reaction.emoji.as_str(), "white_check_mark" | "x")
                })
        }))
    }

    fn list_root_comments(
        &self,
        root_id: &str,
        access_token: &str,
    ) -> Result<Vec<RootComment>, LinearError> {
        validate_identifier(root_id, MAX_IDENTIFIER_LENGTH)?;
        let mut comments = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_ids = HashSet::new();

        for page in 0..self.max_pages {
            let request = GraphqlRequest {
                operation: ROOT_COMMENTS_OPERATION,
                query: ROOT_COMMENTS_QUERY,
                variables: json!({
                    "rootId": root_id,
                    "cursor": cursor,
                    "first": self.page_size,
                }),
            };
            let envelope = self
                .transport
                .execute(&self.endpoint, &request, access_token)
                .map_err(|_| LinearError::Transport)?;
            let data = parse_envelope(envelope)?;
            let issue = object_field(&data, "issue")?;
            let connection = object_field(issue, "comments")?;
            let nodes = array_field(connection, "nodes")?;
            let page_info = object_field(connection, "pageInfo")?;
            let has_next = bool_field(page_info, "hasNextPage")?;
            let next_cursor = nullable_string_field(page_info, "endCursor")?;

            for node in nodes {
                let comment = parse_root_comment(object(node)?)?;
                if !seen_ids.insert(comment.id.clone()) {
                    return Err(LinearError::InvalidResponse);
                }
                comments.push(comment);
            }

            if !has_next {
                if next_cursor.is_some() {
                    return Err(LinearError::InvalidResponse);
                }
                comments.sort_by(|left, right| {
                    left.created_at.cmp(&right.created_at).then(left.id.cmp(&right.id))
                });
                return Ok(comments);
            }
            let Some(next) = next_cursor else {
                return Err(LinearError::InvalidResponse);
            };
            if next.is_empty() || cursor.as_deref() == Some(next.as_str()) {
                return Err(LinearError::InvalidResponse);
            }
            if page + 1 == self.max_pages {
                return Err(LinearError::PaginationLimit);
            }
            cursor = Some(next);
        }
        Err(LinearError::PaginationLimit)
    }

    fn list_action_replies(
        &self,
        action_id: &str,
        access_token: &str,
    ) -> Result<Vec<RootReply>, LinearError> {
        validate_identifier(action_id, MAX_IDENTIFIER_LENGTH)?;
        let mut replies = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_ids = HashSet::new();

        for page in 0..self.max_pages {
            let request = GraphqlRequest {
                operation: ROOT_ACTION_REPLIES_OPERATION,
                query: ROOT_ACTION_REPLIES_QUERY,
                variables: json!({
                    "commentId": action_id,
                    "cursor": cursor,
                    "first": self.page_size,
                }),
            };
            let envelope = self
                .transport
                .execute(&self.endpoint, &request, access_token)
                .map_err(|_| LinearError::Transport)?;
            let data = parse_envelope(envelope)?;
            let comment = object_field(&data, "comment")?;
            let connection = object_field(comment, "children")?;
            let nodes = array_field(connection, "nodes")?;
            let page_info = object_field(connection, "pageInfo")?;
            let has_next = bool_field(page_info, "hasNextPage")?;
            let next_cursor = nullable_string_field(page_info, "endCursor")?;

            for node in nodes {
                let reply = parse_root_reply(object(node)?)?;
                if !seen_ids.insert(reply.id.clone()) {
                    return Err(LinearError::InvalidResponse);
                }
                replies.push(reply);
            }

            if !has_next {
                if next_cursor.is_some() {
                    return Err(LinearError::InvalidResponse);
                }
                replies.sort_by(|left, right| {
                    left.created_at.cmp(&right.created_at).then(left.id.cmp(&right.id))
                });
                return Ok(replies);
            }
            let Some(next) = next_cursor else {
                return Err(LinearError::InvalidResponse);
            };
            if next.is_empty() || cursor.as_deref() == Some(next.as_str()) {
                return Err(LinearError::InvalidResponse);
            }
            if page + 1 == self.max_pages {
                return Err(LinearError::PaginationLimit);
            }
            cursor = Some(next);
        }
        Err(LinearError::PaginationLimit)
    }

    /// List Projects visible to the connected application for Binding setup.
    /// Provider order is preserved and duplicate IDs are ignored.
    pub fn list_projects(&self) -> Result<Vec<LinearProject>, LinearError> {
        let access_token = self.access_token.read().map_err(|_| LinearError::Transport)?.clone();
        if access_token.is_empty() {
            return Err(LinearError::MissingApiKey);
        }
        let mut projects = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_ids = HashSet::new();

        for page in 0..self.max_pages {
            let request = GraphqlRequest {
                operation: PROJECTS_OPERATION,
                query: PROJECTS_QUERY,
                variables: json!({ "cursor": cursor, "first": self.page_size }),
            };
            let envelope = self
                .transport
                .execute(&self.endpoint, &request, &access_token)
                .map_err(|_| LinearError::Transport)?;
            let data = parse_envelope(envelope)?;
            let connection = object_field(&data, "projects")?;
            let nodes = array_field(connection, "nodes")?;
            let page_info = object_field(connection, "pageInfo")?;
            let has_next = bool_field(page_info, "hasNextPage")?;
            let next_cursor = nullable_string_field(page_info, "endCursor")?;

            for node in nodes {
                let node = object(node)?;
                let project = LinearProject {
                    id: bounded_string(
                        node.get("id").ok_or(LinearError::InvalidResponse)?,
                        MAX_IDENTIFIER_LENGTH,
                    )
                    .map_err(|_| LinearError::InvalidResponse)?,
                    name: bounded_string(
                        node.get("name").ok_or(LinearError::InvalidResponse)?,
                        MAX_TITLE_LENGTH,
                    )
                    .map_err(|_| LinearError::InvalidResponse)?,
                };
                if project.id.trim().is_empty() || project.name.trim().is_empty() {
                    return Err(LinearError::InvalidResponse);
                }
                if seen_ids.insert(project.id.clone()) {
                    projects.push(project);
                }
            }

            if !has_next {
                return Ok(projects);
            }
            let Some(next) = next_cursor else {
                return Err(LinearError::InvalidResponse);
            };
            if next.is_empty() || cursor.as_deref() == Some(next.as_str()) {
                return Err(LinearError::InvalidResponse);
            }
            if page + 1 == self.max_pages {
                return Err(LinearError::PaginationLimit);
            }
            cursor = Some(next);
        }
        Err(LinearError::PaginationLimit)
    }

    pub fn roots_for_binding(
        &self,
        binding: &ProjectBinding,
    ) -> Result<Vec<LinearRoot>, LinearError> {
        self.list_root_candidates(binding)
    }

    pub fn candidates(&self, binding: &ProjectBinding) -> Result<Vec<LinearRoot>, LinearError> {
        self.list_root_candidates(binding)
    }

    pub fn domain_root_candidates(
        &self,
        binding: &ProjectBinding,
    ) -> Result<Vec<RootCandidate>, LinearError> {
        Ok(self.list_root_candidates(binding)?.iter().map(LinearRoot::to_root_candidate).collect())
    }
}

/// Convenience constructor for the production backend environment.
pub fn production_linear_adapter<T: LinearTransport>(
    transport: T,
) -> Result<LinearCandidateAdapter<T>, LinearError> {
    LinearCandidateAdapter::from_environment(transport)
}

/// Resolve `LINEAR_API_KEY`, falling back to `SYMPHONY_LINEAR_TOKEN` only when
/// the primary variable is absent or blank.
pub fn resolve_access_token<I, K, V>(environment: I) -> Result<String, LinearError>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<std::ffi::OsStr>,
    V: Into<std::ffi::OsString>,
{
    let mut primary: Option<String> = None;
    let mut fallback: Option<String> = None;
    for (key, value) in environment {
        let key = key.as_ref().to_string_lossy();
        let value = value.into().to_string_lossy().into_owned();
        match key.as_ref() {
            "LINEAR_API_KEY" => primary = Some(value),
            "SYMPHONY_LINEAR_TOKEN" => fallback = Some(value),
            _ => {}
        }
    }
    let selected = primary
        .filter(|value| !value.trim().is_empty())
        .or_else(|| fallback.filter(|value| !value.trim().is_empty()));
    validate_access_token(selected.ok_or(LinearError::MissingApiKey)?)
}

fn validate_access_token(token: String) -> Result<String, LinearError> {
    if token.trim().is_empty()
        || token.len() > 16_384
        || token.chars().any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
    {
        return Err(LinearError::MissingApiKey);
    }
    Ok(token)
}

fn validate_binding(binding: &ProjectBinding) -> Result<(), LinearError> {
    validate_identifier(&binding.project_id, MAX_IDENTIFIER_LENGTH)?;
    validate_identifier(&binding.routing_label, MAX_IDENTIFIER_LENGTH)?;
    Ok(())
}

fn parse_envelope(value: Value) -> Result<Map<String, Value>, LinearError> {
    let envelope = object(&value)?;
    if let Some(errors) = envelope.get("errors") {
        let errors = errors.as_array().ok_or(LinearError::InvalidResponse)?;
        if !errors.is_empty() {
            return Err(LinearError::Provider);
        }
    }
    let data = envelope.get("data").ok_or(LinearError::InvalidResponse)?;
    Ok(object(data)?.clone())
}

fn root_candidate_state(
    node: &Map<String, Value>,
    binding: &ProjectBinding,
) -> Result<Option<RootCandidateState>, LinearError> {
    let project = object(node.get("project").ok_or(LinearError::InvalidResponse)?)?;
    if bounded_string(
        project.get("id").ok_or(LinearError::InvalidResponse)?,
        MAX_IDENTIFIER_LENGTH,
    )? != binding.project_id
    {
        return Ok(None);
    }
    let parent = node.get("parent").ok_or(LinearError::InvalidResponse)?;
    if !parent.is_null() {
        let parent = object(parent)?;
        bounded_string(
            parent.get("id").ok_or(LinearError::InvalidResponse)?,
            MAX_IDENTIFIER_LENGTH,
        )?;
        return Ok(None);
    }
    let state = object(node.get("state").ok_or(LinearError::InvalidResponse)?)?;
    let state_name = bounded_string(state.get("name").ok_or(LinearError::InvalidResponse)?, 128)?;
    let state_type = bounded_string(state.get("type").ok_or(LinearError::InvalidResponse)?, 128)?;
    let candidate_state = match (state_name.as_str(), state_type.as_str()) {
        ("Todo", "unstarted") => RootCandidateState::Todo,
        ("Needs Human", "started") => RootCandidateState::NeedsHuman,
        _ => return Ok(None),
    };
    if let Some(routing) = node.get("routingLabel").or_else(|| node.get("routing_label")) {
        if bounded_string(routing, MAX_IDENTIFIER_LENGTH)? != binding.routing_label {
            return Ok(None);
        }
    }
    let labels = object(node.get("labels").ok_or(LinearError::InvalidResponse)?)?;
    let label_nodes = array_field(labels, "nodes")?;
    let mut matched_label = false;
    for label in label_nodes {
        let label = object(label)?;
        let name = bounded_string(
            label.get("name").ok_or(LinearError::InvalidResponse)?,
            MAX_IDENTIFIER_LENGTH,
        )?;
        if name == binding.routing_label {
            matched_label = true;
        }
    }
    if !matched_label {
        return Ok(None);
    }
    Ok(Some(candidate_state))
}

fn parse_root(node: &Map<String, Value>) -> Result<LinearRoot, LinearError> {
    let id =
        bounded_string(node.get("id").ok_or(LinearError::InvalidResponse)?, MAX_IDENTIFIER_LENGTH)?;
    let identifier = bounded_string(
        node.get("identifier").ok_or(LinearError::InvalidResponse)?,
        MAX_IDENTIFIER_LENGTH,
    )?;
    let title =
        bounded_string(node.get("title").ok_or(LinearError::InvalidResponse)?, MAX_TITLE_LENGTH)?;
    let priority = node
        .get("priority")
        .and_then(Value::as_u64)
        .filter(|priority| *priority <= 4)
        .map(|priority| priority as u8)
        .ok_or(LinearError::InvalidResponse)?;
    let created_at = bounded_string(
        node.get("createdAt").ok_or(LinearError::InvalidResponse)?,
        MAX_TIMESTAMP_LENGTH,
    )?;
    if !valid_rfc3339(&created_at) {
        return Err(LinearError::InvalidResponse);
    }
    Ok(LinearRoot { id, identifier, title, priority, created_at })
}

fn parse_root_comment(node: &Map<String, Value>) -> Result<RootComment, LinearError> {
    let id =
        bounded_string(node.get("id").ok_or(LinearError::InvalidResponse)?, MAX_IDENTIFIER_LENGTH)?;
    let body = bounded_text(
        node.get("body").ok_or(LinearError::InvalidResponse)?,
        MAX_COMMENT_BODY_LENGTH,
    )?;
    let created_at = bounded_string(
        node.get("createdAt").ok_or(LinearError::InvalidResponse)?,
        MAX_TIMESTAMP_LENGTH,
    )?;
    if !valid_rfc3339(&created_at) {
        return Err(LinearError::InvalidResponse);
    }
    let author = object(node.get("user").ok_or(LinearError::InvalidResponse)?)?;
    let author_id = bounded_string(
        author.get("id").ok_or(LinearError::InvalidResponse)?,
        MAX_IDENTIFIER_LENGTH,
    )?;
    let parent = node.get("parent").ok_or(LinearError::InvalidResponse)?;
    let parent_id = if parent.is_null() {
        None
    } else {
        Some(bounded_string(
            object(parent)?.get("id").ok_or(LinearError::InvalidResponse)?,
            MAX_IDENTIFIER_LENGTH,
        )?)
    };
    Ok(RootComment { id, body, created_at, author_id, parent_id })
}

fn is_human_action_comment(body: &str) -> bool {
    body == HUMAN_ACTION_COMMENT_MARKER
        || body
            .strip_prefix(HUMAN_ACTION_COMMENT_MARKER)
            .is_some_and(|suffix| suffix.starts_with('\n'))
}

fn parse_root_reply(node: &Map<String, Value>) -> Result<RootReply, LinearError> {
    let id =
        bounded_string(node.get("id").ok_or(LinearError::InvalidResponse)?, MAX_IDENTIFIER_LENGTH)?;
    let body = bounded_text(
        node.get("body").ok_or(LinearError::InvalidResponse)?,
        MAX_COMMENT_BODY_LENGTH,
    )?;
    let created_at = bounded_string(
        node.get("createdAt").ok_or(LinearError::InvalidResponse)?,
        MAX_TIMESTAMP_LENGTH,
    )?;
    if !valid_rfc3339(&created_at) {
        return Err(LinearError::InvalidResponse);
    }
    let author = object(node.get("user").ok_or(LinearError::InvalidResponse)?)?;
    let author_id = bounded_string(
        author.get("id").ok_or(LinearError::InvalidResponse)?,
        MAX_IDENTIFIER_LENGTH,
    )?;
    let reactions = object_field(node, "reactions")?;
    let reaction_nodes = array_field(reactions, "nodes")?;
    let reaction_page_info = object_field(reactions, "pageInfo")?;
    if bool_field(reaction_page_info, "hasNextPage")?
        || nullable_string_field(reaction_page_info, "endCursor")?.is_some()
    {
        return Err(LinearError::PaginationLimit);
    }
    let mut parsed_reactions = Vec::with_capacity(reaction_nodes.len());
    for reaction in reaction_nodes {
        let reaction = object(reaction)?;
        let emoji = bounded_string(
            reaction.get("emoji").ok_or(LinearError::InvalidResponse)?,
            MAX_IDENTIFIER_LENGTH,
        )?;
        if !matches!(emoji.as_str(), "white_check_mark" | "x") {
            continue;
        }
        let author = object(reaction.get("user").ok_or(LinearError::InvalidResponse)?)?;
        let author_id = bounded_string(
            author.get("id").ok_or(LinearError::InvalidResponse)?,
            MAX_IDENTIFIER_LENGTH,
        )?;
        parsed_reactions.push(CommentReaction { emoji, author_id });
    }
    Ok(RootReply { id, body, created_at, author_id, reactions: parsed_reactions })
}

fn object(value: &Value) -> Result<&Map<String, Value>, LinearError> {
    value.as_object().ok_or(LinearError::InvalidResponse)
}

fn object_field<'a>(
    record: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Map<String, Value>, LinearError> {
    object(record.get(field).ok_or(LinearError::InvalidResponse)?)
}

fn array_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Vec<Value>, LinearError> {
    object
        .get(field)
        .ok_or(LinearError::InvalidResponse)?
        .as_array()
        .ok_or(LinearError::InvalidResponse)
}

fn bool_field(object: &Map<String, Value>, field: &str) -> Result<bool, LinearError> {
    object
        .get(field)
        .ok_or(LinearError::InvalidResponse)?
        .as_bool()
        .ok_or(LinearError::InvalidResponse)
}

fn nullable_string_field(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, LinearError> {
    let value = object.get(field).ok_or(LinearError::InvalidResponse)?;
    if value.is_null() {
        return Ok(None);
    }
    Ok(Some(bounded_string(value, MAX_IDENTIFIER_LENGTH)?))
}

fn bounded_string(value: &Value, max: usize) -> Result<String, LinearError> {
    let value = value.as_str().ok_or(LinearError::InvalidResponse)?;
    validate_identifier(value, max)?;
    Ok(value.to_owned())
}

fn bounded_text(value: &Value, max: usize) -> Result<String, LinearError> {
    let value = value.as_str().ok_or(LinearError::InvalidResponse)?;
    if value.is_empty() || value.len() > max || value.chars().any(|ch| ch == '\0') {
        return Err(LinearError::InvalidResponse);
    }
    Ok(value.to_owned())
}

fn validate_identifier(value: &str, max: usize) -> Result<(), LinearError> {
    if value.is_empty()
        || value.len() > max
        || value.chars().any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
    {
        return Err(LinearError::InvalidRequest);
    }
    Ok(())
}

/// Strict enough for Linear's RFC3339 `createdAt` values while avoiding a
/// second date-time dependency in the desktop binary.
fn valid_rfc3339(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes.len() > MAX_TIMESTAMP_LENGTH {
        return false;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || (bytes[10] != b'T' && bytes[10] != b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return false;
    }
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        digits(bytes, 0, 4),
        digits(bytes, 5, 2),
        digits(bytes, 8, 2),
        digits(bytes, 11, 2),
        digits(bytes, 14, 2),
        digits(bytes, 17, 2),
    ) else {
        return false;
    };
    if year == 0
        || !(1..=12).contains(&month)
        || day == 0
        || hour > 23
        || minute > 59
        || second > 59
    {
        return false;
    }
    let days = [31_u32, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut max_day = days[(month - 1) as usize];
    if month == 2 && (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) {
        max_day = 29;
    }
    if day > max_day {
        return false;
    }
    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start || index - start > 9 {
            return false;
        }
    }
    match bytes.get(index) {
        Some(b'Z') | Some(b'z') => index += 1,
        Some(b'+') | Some(b'-') => {
            if bytes.len() < index + 6 || bytes[index + 3] != b':' {
                return false;
            }
            let offset_hour = match digits(bytes, index + 1, 2) {
                Some(value) => value,
                None => return false,
            };
            let offset_minute = match digits(bytes, index + 4, 2) {
                Some(value) => value,
                None => return false,
            };
            if offset_hour > 23 || offset_minute > 59 {
                return false;
            }
            index += 6;
        }
        _ => return false,
    }
    index == bytes.len()
}

fn digits(bytes: &[u8], start: usize, count: usize) -> Option<u32> {
    if start.checked_add(count)? > bytes.len() {
        return None;
    }
    let mut value = 0_u32;
    for byte in &bytes[start..start + count] {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u32::from(*byte - b'0');
    }
    Some(value)
}

/// Production HTTPS transport.  It is kept separate from parsing so tests can
/// use a deterministic fixture without a socket or credential.
#[derive(Clone)]
pub struct ReqwestLinearTransport {
    client: reqwest::blocking::Client,
}

impl fmt::Debug for ReqwestLinearTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReqwestLinearTransport")
    }
}

impl ReqwestLinearTransport {
    pub fn new(timeout: std::time::Duration) -> Result<Self, TransportError> {
        reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .map(|client| Self { client })
            .map_err(|_| TransportError::RequestFailed)
    }
}

impl LinearTransport for ReqwestLinearTransport {
    fn execute(
        &self,
        endpoint: &str,
        request: &GraphqlRequest,
        access_token: &str,
    ) -> Result<Value, TransportError> {
        let response = self
            .client
            .post(endpoint)
            // Linear's API expects the API key directly in Authorization,
            // rather than a Bearer-prefixed value.
            .header(reqwest::header::AUTHORIZATION, access_token)
            .json(&request.body())
            .send()
            .map_err(|_| TransportError::RequestFailed)?;
        if !response.status().is_success() {
            return Err(TransportError::RequestFailed);
        }
        let bytes = response.bytes().map_err(|_| TransportError::RequestFailed)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(TransportError::ResponseTooLarge);
        }
        serde_json::from_slice(&bytes).map_err(|_| TransportError::InvalidResponse)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{AgentKind, ProjectBinding};
    use std::sync::{Arc, Mutex};

    fn binding() -> ProjectBinding {
        ProjectBinding {
            project_id: "project-1".into(),
            routing_label: "core".into(),
            repository_path: "/repo".into(),
            base_branch: "main".into(),
            concurrency: 1,
            completed_workspace_retention: None,
            reconcile_agent: AgentKind::Codex,
            reconcile_model: None,
            reconcile_reasoning_effort: None,
            artist_agent: AgentKind::Codex,
            artist_model: None,
            artist_reasoning_effort: None,
            critic_agent: AgentKind::Codex,
            critic_model: None,
            critic_reasoning_effort: None,
        }
    }

    fn node(id: &str, identifier: &str, priority: u64, created_at: &str) -> Value {
        json!({
            "id": id,
            "identifier": identifier,
            "title": "A root",
            "priority": priority,
            "createdAt": created_at,
            "project": { "id": "project-1" },
            "state": { "name": "Todo", "type": "unstarted" },
            "parent": null,
            "labels": { "nodes": [{ "name": "core" }] },
        })
    }

    fn needs_human_node(id: &str, identifier: &str, priority: u64, created_at: &str) -> Value {
        let mut value = node(id, identifier, priority, created_at);
        value["state"] = json!({ "name": "Needs Human", "type": "started" });
        value
    }

    fn comment(id: &str, body: &str, created_at: &str, user_id: &str) -> Value {
        comment_with_parent(id, body, created_at, user_id, None)
    }

    fn comment_with_parent(
        id: &str,
        body: &str,
        created_at: &str,
        user_id: &str,
        parent_id: Option<&str>,
    ) -> Value {
        json!({
            "id": id,
            "body": body,
            "createdAt": created_at,
            "user": { "id": user_id },
            "parent": parent_id.map(|id| json!({ "id": id })).unwrap_or(Value::Null),
        })
    }

    fn reply(
        id: &str,
        body: &str,
        created_at: &str,
        user_id: &str,
        reactions: Vec<Value>,
    ) -> Value {
        json!({
            "id": id,
            "body": body,
            "createdAt": created_at,
            "user": { "id": user_id },
            "reactions": {
                "nodes": reactions,
                "pageInfo": { "hasNextPage": false, "endCursor": null },
            },
        })
    }

    fn reaction(emoji: &str, user_id: &str) -> Value {
        json!({ "emoji": emoji, "user": { "id": user_id } })
    }

    fn comments_page(nodes: Vec<Value>, has_next: bool, end_cursor: Option<&str>) -> Value {
        json!({
            "data": { "issue": { "comments": {
                "nodes": nodes,
                "pageInfo": { "hasNextPage": has_next, "endCursor": end_cursor },
            }}}
        })
    }

    fn action_replies_page(nodes: Vec<Value>, has_next: bool, end_cursor: Option<&str>) -> Value {
        json!({
            "data": { "comment": { "children": {
                "nodes": nodes,
                "pageInfo": { "hasNextPage": has_next, "endCursor": end_cursor },
            }}}
        })
    }

    fn page(nodes: Vec<Value>, has_next: bool, end_cursor: Option<&str>) -> Value {
        json!({
            "data": { "issues": {
                "nodes": nodes,
                "pageInfo": { "hasNextPage": has_next, "endCursor": end_cursor },
            }},
        })
    }

    #[test]
    fn filters_binding_fields_and_keeps_provider_order_for_scheduler() {
        let responses = Arc::new(Mutex::new(vec![page(
            vec![
                node("id-match", "ENG-2", 3, "2024-02-01T00:00:00Z"),
                {
                    let mut value = node("id-project", "ENG-3", 1, "2024-01-01T00:00:00Z");
                    value["project"]["id"] = json!("other-project");
                    value
                },
                {
                    let mut value = node("id-state", "ENG-4", 1, "2024-01-01T00:00:00Z");
                    value["state"] = json!({ "name": "In Progress", "type": "started" });
                    value
                },
                {
                    let mut value = node("id-parent", "ENG-5", 1, "2024-01-01T00:00:00Z");
                    value["parent"] = json!({ "id": "parent" });
                    value
                },
                {
                    let mut value = node("id-label", "ENG-6", 1, "2024-01-01T00:00:00Z");
                    value["labels"] = json!({ "nodes": [{ "name": "other" }] });
                    value
                },
            ],
            false,
            None,
        )]));
        let seen = Arc::new(Mutex::new(Vec::<(String, Value, String)>::new()));
        let seen_for_transport = Arc::clone(&seen);
        let responses_for_transport = Arc::clone(&responses);
        let transport = move |endpoint: &str, request: &GraphqlRequest, token: &str| {
            seen_for_transport.lock().unwrap().push((
                endpoint.into(),
                request.variables.clone(),
                token.into(),
            ));
            Ok(responses_for_transport.lock().unwrap().remove(0))
        };
        let adapter = LinearCandidateAdapter::new(transport, "fixture-token").unwrap();

        let roots = adapter.list_root_candidates(&binding()).unwrap();

        assert_eq!(
            roots.iter().map(|root| root.identifier.as_str()).collect::<Vec<_>>(),
            ["ENG-2"]
        );
        assert_eq!(roots[0].to_root_candidate().id, "id-match");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, LINEAR_GRAPHQL_ENDPOINT);
        assert_eq!(seen[0].1["projectId"], "project-1");
        assert_eq!(seen[0].1["routingLabel"], "core");
        assert_eq!(seen[0].1["first"], DEFAULT_PAGE_SIZE);
        assert_eq!(seen[0].2, "fixture-token");
    }

    #[test]
    fn includes_only_replied_needs_human_roots_alongside_todo_roots() {
        let requests = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let requests_for_transport = Arc::clone(&requests);
        let transport = move |_endpoint: &str, request: &GraphqlRequest, _token: &str| {
            requests_for_transport
                .lock()
                .unwrap()
                .push((request.operation.to_owned(), request.variables.clone()));
            match request.operation {
                ROOT_CANDIDATES_OPERATION => Ok(page(
                    vec![
                        node("todo", "ENG-1", 3, "2024-02-01T00:00:00Z"),
                        needs_human_node("needs-human-replied", "ENG-2", 1, "2024-01-01T00:00:00Z"),
                        needs_human_node("needs-human-waiting", "ENG-3", 0, "2024-01-02T00:00:00Z"),
                        needs_human_node("needs-human-harness", "ENG-4", 2, "2024-01-03T00:00:00Z"),
                        needs_human_node("needs-human-checked", "ENG-5", 2, "2024-01-04T00:00:00Z"),
                        needs_human_node(
                            "needs-human-rejected",
                            "ENG-6",
                            2,
                            "2024-01-05T00:00:00Z",
                        ),
                        needs_human_node(
                            "needs-human-user-reaction",
                            "ENG-7",
                            2,
                            "2024-01-06T00:00:00Z",
                        ),
                        needs_human_node(
                            "needs-human-old-reply",
                            "ENG-8",
                            2,
                            "2024-01-07T00:00:00Z",
                        ),
                    ],
                    false,
                    None,
                )),
                ROOT_COMMENTS_OPERATION => {
                    let root_id = request.variables["rootId"].as_str().unwrap();
                    let comments = match root_id {
                        "needs-human-replied" => vec![
                            comment(
                                "question-replied",
                                "# Symphony Harness: Human Action\n\nPlease choose.",
                                "2024-02-01T00:00:00Z",
                                "harness-1",
                            ),
                            comment_with_parent(
                                "harness-follow-up",
                                "# Symphony Harness: Human Action Follow-up\n\nChoose again.",
                                "2024-02-03T00:00:00Z",
                                "harness-1",
                                Some("question-replied"),
                            ),
                            comment(
                                "flat-reply",
                                "Flat answer must not count.",
                                "2024-02-02T00:00:00Z",
                                "user-1",
                            ),
                        ],
                        "needs-human-waiting" => vec![
                            comment(
                                "question-waiting",
                                "# Symphony Harness: Human Action\n\nPlease choose.",
                                "2024-02-01T00:00:00Z",
                                "harness-1",
                            ),
                            comment(
                                "flat-only",
                                "Only a flat answer.",
                                "2024-02-02T00:00:00Z",
                                "user-1",
                            ),
                        ],
                        "needs-human-harness" => vec![comment(
                            "question-harness",
                            "# Symphony Harness: Human Action\n\nPlease choose.",
                            "2024-02-01T00:00:00Z",
                            "harness-1",
                        )],
                        "needs-human-checked" => vec![comment(
                            "question-checked",
                            "# Symphony Harness: Human Action\n\nPlease choose.",
                            "2024-02-01T00:00:00Z",
                            "harness-1",
                        )],
                        "needs-human-rejected" => vec![comment(
                            "question-rejected",
                            "# Symphony Harness: Human Action\n\nPlease choose.",
                            "2024-02-01T00:00:00Z",
                            "harness-1",
                        )],
                        "needs-human-user-reaction" => vec![comment(
                            "question-user-reaction",
                            "# Symphony Harness: Human Action\n\nPlease choose.",
                            "2024-02-01T00:00:00Z",
                            "harness-1",
                        )],
                        "needs-human-old-reply" => vec![
                            comment(
                                "question-old",
                                "# Symphony Harness: Human Action\n\nOld question.",
                                "2024-01-01T00:00:00Z",
                                "harness-1",
                            ),
                            comment(
                                "question-new",
                                "# Symphony Harness: Human Action\n\nNew question.",
                                "2024-01-03T00:00:00Z",
                                "harness-1",
                            ),
                        ],
                        _ => panic!("unexpected root id {root_id}"),
                    };
                    Ok(comments_page(comments, false, None))
                }
                ROOT_ACTION_REPLIES_OPERATION => {
                    let comment_id = request.variables["commentId"].as_str().unwrap();
                    let replies = match comment_id {
                        "question-replied" => vec![reply(
                            "reply",
                            "Use option A.",
                            "2024-02-02T00:00:00Z",
                            "user-1",
                            vec![],
                        )],
                        "question-waiting" => vec![],
                        "question-harness" => vec![reply(
                            "harness-follow-up",
                            "# Symphony Harness: Human Action Follow-up\n\nChoose again.",
                            "2024-02-02T00:00:00Z",
                            "harness-1",
                            vec![],
                        )],
                        "question-checked" => vec![reply(
                            "checked-reply",
                            "Accepted earlier.",
                            "2024-02-02T00:00:00Z",
                            "user-1",
                            vec![reaction("white_check_mark", "harness-1")],
                        )],
                        "question-rejected" => vec![reply(
                            "rejected-reply",
                            "Rejected earlier.",
                            "2024-02-02T00:00:00Z",
                            "user-1",
                            vec![reaction("x", "harness-1")],
                        )],
                        "question-user-reaction" => vec![reply(
                            "user-reaction-reply",
                            "A user reaction is not a receipt.",
                            "2024-02-02T00:00:00Z",
                            "user-1",
                            vec![reaction("white_check_mark", "user-2")],
                        )],
                        "question-new" => vec![],
                        _ => panic!("unexpected comment id {comment_id}"),
                    };
                    Ok(action_replies_page(replies, false, None))
                }
                _ => panic!("unexpected operation {}", request.operation),
            }
        };
        let adapter = LinearCandidateAdapter::new(transport, "fixture-token").unwrap();

        let roots = adapter.list_root_candidates(&binding()).unwrap();

        assert_eq!(
            roots.iter().map(|root| root.id.as_str()).collect::<Vec<_>>(),
            ["todo", "needs-human-replied", "needs-human-user-reaction"]
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests[1].0, ROOT_COMMENTS_OPERATION);
        assert_eq!(requests[1].1["rootId"], "needs-human-replied");
        assert_eq!(requests[2].0, ROOT_ACTION_REPLIES_OPERATION);
        assert_eq!(requests[2].1["commentId"], "question-replied");
        assert_eq!(
            requests.iter().filter(|request| request.0 == ROOT_COMMENTS_OPERATION).count(),
            7
        );
        assert_eq!(
            requests.iter().filter(|request| request.0 == ROOT_ACTION_REPLIES_OPERATION).count(),
            7
        );
    }

    #[test]
    fn rejects_malformed_needs_human_comments_and_stuck_comment_pages() {
        let malformed = |_endpoint: &str, request: &GraphqlRequest, _token: &str| {
            if request.operation == ROOT_CANDIDATES_OPERATION {
                return Ok(page(
                    vec![needs_human_node("needs-human", "ENG-1", 1, "2024-01-01T00:00:00Z")],
                    false,
                    None,
                ));
            }
            Ok(comments_page(
                vec![comment(
                    "question",
                    "# Symphony Harness: Human Action",
                    "not-a-time",
                    "harness-1",
                )],
                false,
                None,
            ))
        };
        let adapter = LinearCandidateAdapter::new(malformed, "fixture-token").unwrap();
        assert_eq!(adapter.list_root_candidates(&binding()), Err(LinearError::InvalidResponse));

        let stuck = |_endpoint: &str, request: &GraphqlRequest, _token: &str| {
            if request.operation == ROOT_CANDIDATES_OPERATION {
                return Ok(page(
                    vec![needs_human_node("needs-human", "ENG-1", 1, "2024-01-01T00:00:00Z")],
                    false,
                    None,
                ));
            }
            if request.operation == ROOT_COMMENTS_OPERATION {
                return Ok(comments_page(
                    vec![comment(
                        "question",
                        "# Symphony Harness: Human Action",
                        "2024-01-01T00:00:00Z",
                        "harness-1",
                    )],
                    false,
                    None,
                ));
            }
            Ok(action_replies_page(vec![], true, Some("same")))
        };
        let adapter = LinearCandidateAdapter::new(stuck, "fixture-token").unwrap();
        assert_eq!(adapter.list_root_candidates(&binding()), Err(LinearError::InvalidResponse));
    }

    #[test]
    fn follows_bounded_pages_and_rejects_stuck_cursor() {
        let calls = Arc::new(Mutex::new(0_u32));
        let calls_for_transport = Arc::clone(&calls);
        let transport = move |_endpoint: &str, request: &GraphqlRequest, _token: &str| {
            let mut calls = calls_for_transport.lock().unwrap();
            *calls += 1;
            let cursor = request.variables["cursor"].as_str();
            Ok(if cursor.is_none() {
                page(vec![node("id-1", "ENG-1", 0, "2024-01-01T00:00:00Z")], true, Some("next"))
            } else {
                page(vec![node("id-2", "ENG-2", 4, "2024-01-02T00:00:00Z")], false, None)
            })
        };
        let adapter =
            LinearCandidateAdapter::with_limits(transport, "fixture-token", 1, 2).unwrap();
        let roots = adapter.list_root_candidates(&binding()).unwrap();
        assert_eq!(roots.len(), 2);
        assert_eq!(*calls.lock().unwrap(), 2);

        let stuck_transport = |_endpoint: &str, _request: &GraphqlRequest, _token: &str| {
            Ok(page(vec![], true, Some("same")))
        };
        let adapter = LinearCandidateAdapter::new(stuck_transport, "fixture-token").unwrap();
        assert_eq!(adapter.list_root_candidates(&binding()), Err(LinearError::InvalidResponse));
    }

    #[test]
    fn lists_projects_with_bounded_pagination_and_deduplicates_ids() {
        let transport = |_endpoint: &str, request: &GraphqlRequest, token: &str| {
            assert_eq!(request.operation, PROJECTS_OPERATION);
            assert_eq!(token, "fixture-token");
            Ok(if request.variables["cursor"].is_null() {
                json!({ "data": { "projects": {
                    "nodes": [{ "id": "project-1", "name": "Symphony" }],
                    "pageInfo": { "hasNextPage": true, "endCursor": "next" }
                }}})
            } else {
                json!({ "data": { "projects": {
                    "nodes": [
                        { "id": "project-1", "name": "Duplicate" },
                        { "id": "project-2", "name": "Console" }
                    ],
                    "pageInfo": { "hasNextPage": false, "endCursor": null }
                }}})
            })
        };
        let adapter =
            LinearCandidateAdapter::with_limits(transport, "fixture-token", 1, 2).unwrap();

        assert_eq!(
            adapter.list_projects().unwrap(),
            vec![
                LinearProject { id: "project-1".into(), name: "Symphony".into() },
                LinearProject { id: "project-2".into(), name: "Console".into() },
            ]
        );
    }

    #[test]
    fn rejects_malformed_project_pages_and_missing_credentials() {
        let malformed = |_endpoint: &str, _request: &GraphqlRequest, _token: &str| {
            Ok(json!({ "data": { "projects": {
                "nodes": [{ "id": "project-1", "name": "" }],
                "pageInfo": { "hasNextPage": false, "endCursor": null }
            }}}))
        };
        let adapter = LinearCandidateAdapter::new(malformed, "fixture-token").unwrap();
        assert_eq!(adapter.list_projects(), Err(LinearError::InvalidResponse));

        let deferred = LinearCandidateAdapter::deferred(malformed);
        assert_eq!(deferred.list_projects(), Err(LinearError::MissingApiKey));
    }

    #[test]
    fn rejects_malformed_root_fields_and_provider_errors() {
        let malformed = |_endpoint: &str, _request: &GraphqlRequest, _token: &str| {
            Ok(page(vec![node("id", "ENG-1", 5, "2024-01-01T00:00:00Z")], false, None))
        };
        let adapter = LinearCandidateAdapter::new(malformed, "fixture-token").unwrap();
        assert_eq!(adapter.list_root_candidates(&binding()), Err(LinearError::InvalidResponse));

        let provider = |_endpoint: &str, _request: &GraphqlRequest, _token: &str| {
            Ok(json!({ "errors": [{ "message": "fixture secret must not escape" }] }))
        };
        let adapter = LinearCandidateAdapter::new(provider, "fixture-secret").unwrap();
        let error = adapter.list_root_candidates(&binding()).unwrap_err();
        assert_eq!(error, LinearError::Provider);
        assert!(!format!("{error:?}").contains("fixture-secret"));
        assert!(!format!("{adapter:?}").contains("fixture-secret"));
    }

    #[test]
    fn resolves_primary_then_fallback_without_exposing_tokens() {
        let primary = resolve_access_token([
            ("LINEAR_API_KEY", "primary-secret"),
            ("SYMPHONY_LINEAR_TOKEN", "fallback-secret"),
        ])
        .unwrap();
        assert_eq!(primary, "primary-secret");
        let fallback =
            resolve_access_token([("SYMPHONY_LINEAR_TOKEN", "fallback-secret")]).unwrap();
        assert_eq!(fallback, "fallback-secret");
        assert_eq!(resolve_access_token::<_, &str, &str>([]), Err(LinearError::MissingApiKey));
        assert!(!format!("{:?}", LinearCandidateAdapter::new(empty_transport, "secret").unwrap())
            .contains("secret"));
    }

    #[test]
    fn deferred_adapter_requires_and_rotates_desktop_token() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen_for_transport = Arc::clone(&seen);
        let transport = move |_endpoint: &str, _request: &GraphqlRequest, token: &str| {
            seen_for_transport.lock().unwrap().push(token.to_owned());
            Ok(page(vec![], false, None))
        };
        let adapter = LinearCandidateAdapter::deferred(transport);

        assert!(!adapter.access_token_is_configured());
        assert_eq!(adapter.list_root_candidates(&binding()), Err(LinearError::MissingApiKey));

        adapter.set_access_token("session-token");
        assert!(adapter.access_token_is_configured());
        adapter.list_root_candidates(&binding()).unwrap();

        adapter.set_access_token("rotated-token");
        adapter.list_root_candidates(&binding()).unwrap();
        assert_eq!(&*seen.lock().unwrap(), &["session-token", "rotated-token"]);
    }

    #[test]
    fn validates_rfc3339_created_at() {
        assert!(valid_rfc3339("2024-02-29T23:59:59.123Z"));
        assert!(valid_rfc3339("2024-02-29T23:59:59+08:00"));
        assert!(!valid_rfc3339("2023-02-29T23:59:59Z"));
        assert!(!valid_rfc3339("2024-02-29 23:59:59Z"));
    }

    fn empty_transport(
        _endpoint: &str,
        _request: &GraphqlRequest,
        _token: &str,
    ) -> Result<Value, TransportError> {
        Ok(page(vec![], false, None))
    }
}
