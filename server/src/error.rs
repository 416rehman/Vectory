use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    /// Seconds a throttled client should wait; 429 responses default to 60.
    pub retry_after: Option<u64>,
    /// Members added beside `error` in the body, for a refusal that carries
    /// the evidence it stopped on (`409 TESTS_FAILED` lists the test results).
    pub extra: Option<serde_json::Map<String, serde_json::Value>>,
    /// Members added inside the `error` object beside `code` and `message`:
    /// the named evidence a person needs to act (`409 CONFLICT` of a group
    /// edit lists the colliding assignments as `details`).
    pub fields: Option<serde_json::Map<String, serde_json::Value>>,
}
pub type Result<T> = std::result::Result<T, ApiError>;
impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after: None,
            extra: None,
            fields: None,
        }
    }
    /// Adds the members of `extra` (an object) beside `error` in the body.
    pub fn with_extra(mut self, extra: serde_json::Value) -> Self {
        self.extra = extra.as_object().cloned();
        self
    }
    /// Adds the members of `fields` (an object) inside `error`. `code` and
    /// `message` are never replaced.
    pub fn with_fields(mut self, fields: serde_json::Value) -> Self {
        self.fields = fields.as_object().cloned();
        self
    }
    pub fn throttled(code: &'static str, message: impl Into<String>, seconds: u64) -> Self {
        Self {
            retry_after: Some(seconds.max(1)),
            ..Self::new(StatusCode::TOO_MANY_REQUESTS, code, message)
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "INVALID_INPUT", message)
    }
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
            "Authentication required",
        )
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "FORBIDDEN", "Permission denied")
    }
    /// A change whose session token header is absent or wrong: the same status
    /// and code as a role refusal, and a message that says which of the two it is.
    pub fn csrf() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "The X-CSRF-Token header is missing or wrong",
        )
    }
    pub fn missing() -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Record not found")
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "CONFLICT", message)
    }
    pub fn enrollment() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "ENROLLMENT_FAILED",
            "Enrollment could not be authorized",
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status;
        let mut error = json!({"code":self.code,"message":self.message});
        for (key, value) in self.fields.into_iter().flatten() {
            if key != "code" && key != "message" {
                error[key] = value;
            }
        }
        let mut body = json!({ "error": error });
        for (key, value) in self.extra.into_iter().flatten() {
            // The error object is never replaced by evidence.
            if key != "error" {
                body[key] = value;
            }
        }
        let mut response = (status, Json(body)).into_response();
        if status == StatusCode::TOO_MANY_REQUESTS {
            response.headers_mut().insert(
                "retry-after",
                axum::http::HeaderValue::from(self.retry_after.unwrap_or(60)),
            );
        }
        response
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e,"database operation failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "Database operation failed",
        )
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(_e: anyhow::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "Operation failed",
        )
    }
}
