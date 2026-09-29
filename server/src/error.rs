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
}
pub type Result<T> = std::result::Result<T, ApiError>;
impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after: None,
        }
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
        let mut response = (
            status,
            Json(json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response();
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
