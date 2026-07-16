use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use url::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum OAuthReturnError {
    InvalidAttemptId,
    AttemptAlreadyRegistered,
    InvalidCallback,
    MissingParameter,
    UnexpectedParameter,
    UnknownOrConsumedAttempt,
}

#[derive(Debug, PartialEq, Eq)]
pub struct OAuthReturn {
    pub attempt_id: String,
    pub authorization_code: String,
}

#[derive(Default)]
pub struct OAuthReturnRegistry {
    pending: Mutex<HashSet<String>>,
    completed: Mutex<VecDeque<OAuthReturn>>,
}

impl OAuthReturnRegistry {
    pub fn register(&self, attempt_id: &str) -> Result<(), OAuthReturnError> {
        if !is_identifier(attempt_id) {
            return Err(OAuthReturnError::InvalidAttemptId);
        }
        if !self.pending.lock().unwrap().insert(attempt_id.to_owned()) {
            return Err(OAuthReturnError::AttemptAlreadyRegistered);
        }
        Ok(())
    }

    pub fn receive(&self, callback: &str) -> Result<OAuthReturn, OAuthReturnError> {
        let url = Url::parse(callback).map_err(|_| OAuthReturnError::InvalidCallback)?;
        if url.scheme() != "symphony"
            || url.host_str() != Some("oauth")
            || url.path() != "/linear/callback"
            || url.fragment().is_some()
        {
            return Err(OAuthReturnError::InvalidCallback);
        }
        let mut code = None;
        let mut state = None;
        for (name, value) in url.query_pairs() {
            match name.as_ref() {
                "code" if code.is_none() => code = Some(value.into_owned()),
                "state" if state.is_none() => state = Some(value.into_owned()),
                _ => return Err(OAuthReturnError::UnexpectedParameter),
            }
        }
        let authorization_code =
            code.filter(|value| !value.is_empty()).ok_or(OAuthReturnError::MissingParameter)?;
        let attempt_id =
            state.filter(|value| !value.is_empty()).ok_or(OAuthReturnError::MissingParameter)?;
        if !self.pending.lock().unwrap().remove(&attempt_id) {
            return Err(OAuthReturnError::UnknownOrConsumedAttempt);
        }
        Ok(OAuthReturn { attempt_id, authorization_code })
    }

    pub fn receive_for_backend(&self, callback: &str) -> Result<(), OAuthReturnError> {
        let result = self.receive(callback)?;
        self.completed.lock().unwrap().push_back(result);
        Ok(())
    }

    pub fn take_for_backend(&self) -> Option<OAuthReturn> {
        self.completed.lock().unwrap().pop_front()
    }
}

fn is_identifier(value: &str) -> bool {
    value.len() <= 128
        && value.bytes().next().is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_fixed_callback_and_matching_one_shot_state() {
        let returns = OAuthReturnRegistry::default();
        returns.register("attempt-1").unwrap();

        let result = returns
            .receive("symphony://oauth/linear/callback?code=opaque-code&state=attempt-1")
            .unwrap();

        assert_eq!(result.attempt_id, "attempt-1");
        assert_eq!(result.authorization_code, "opaque-code");
        assert_eq!(
            returns
                .receive("symphony://oauth/linear/callback?code=again&state=attempt-1")
                .unwrap_err(),
            OAuthReturnError::UnknownOrConsumedAttempt
        );
    }

    #[test]
    fn rejects_wrong_origin_state_and_token_fields() {
        let returns = OAuthReturnRegistry::default();
        returns.register("attempt-1").unwrap();

        assert_eq!(
            returns.receive("https://oauth/linear/callback?code=x&state=attempt-1").unwrap_err(),
            OAuthReturnError::InvalidCallback
        );
        assert_eq!(
            returns.receive("symphony://oauth/linear/callback?code=x&state=wrong").unwrap_err(),
            OAuthReturnError::UnknownOrConsumedAttempt
        );
        assert_eq!(
            returns
                .receive(
                    "symphony://oauth/linear/callback?code=x&state=attempt-1&access_token=redacted"
                )
                .unwrap_err(),
            OAuthReturnError::UnexpectedParameter
        );
    }

    #[test]
    fn queues_a_valid_return_only_for_the_private_backend_boundary() {
        let returns = OAuthReturnRegistry::default();
        returns.register("attempt-1").unwrap();
        returns
            .receive_for_backend(
                "symphony://oauth/linear/callback?code=opaque-code&state=attempt-1",
            )
            .unwrap();

        assert_eq!(
            returns.take_for_backend().unwrap(),
            OAuthReturn {
                attempt_id: "attempt-1".to_owned(),
                authorization_code: "opaque-code".to_owned(),
            }
        );
        assert!(returns.take_for_backend().is_none());
    }

    #[test]
    fn rejects_attempt_ids_outside_the_closed_contract_shape() {
        let returns = OAuthReturnRegistry::default();

        assert_eq!(returns.register(" attempt"), Err(OAuthReturnError::InvalidAttemptId));
        assert_eq!(returns.register("attempt?secret"), Err(OAuthReturnError::InvalidAttemptId));
    }
}
