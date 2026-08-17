// Minimal error type.  The original shell scripts communicated failure mostly
// through exit codes and `echo` to stderr; we surface the same information as a
// string-typed error so callers can decide whether to emit a message and which
// process exit code to use.

use std::fmt;

#[derive(Debug)]
pub struct MtError(pub String);

impl fmt::Display for MtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for MtError {}

impl From<std::io::Error> for MtError {
    fn from(e: std::io::Error) -> Self {
        MtError(e.to_string())
    }
}

impl From<std::str::Utf8Error> for MtError {
    fn from(e: std::str::Utf8Error) -> Self {
        MtError(e.to_string())
    }
}

impl From<String> for MtError {
    fn from(s: String) -> Self {
        MtError(s)
    }
}

impl From<&str> for MtError {
    fn from(s: &str) -> Self {
        MtError(s.to_string())
    }
}

pub type Result<T> = std::result::Result<T, MtError>;

/// Exit codes mirror the original shell scripts so the rpcd wrappers and the
/// LuCI front-end keep working unchanged.
pub mod exit {
    /// Generic usage / argument error (shell used `exit 64`).
    pub const USAGE: i32 = 64;
    /// Validation failure for a sub-command argument (shell used `exit 64`).
    pub const BAD_ARG: i32 = 64;
    /// AT / transport channel unavailable.
    pub const CHANNEL: i32 = 2;
}
