//! The late-start window: how long after its time a due schedule still starts.
//!
//! The scheduler checks due schedules every two seconds. A schedule found due
//! within the window (after the server was down, for example) activates once;
//! a later one becomes `missed` and waits for an operator. Both outcomes are
//! decided inside the serialized writer transaction, like cancellation, so a
//! cancel and an activation of the same schedule never interleave: whichever
//! commits first decides (see `contracts/CONTRACT.md`, Scheduling).
use crate::Settings;

/// The window when `VECTORY_SCHEDULE_LATE_START_SECONDS` is unset: one hour.
pub const DEFAULT_LATE_START_SECONDS: u64 = 3600;
/// Accepted values: one minute to seven days.
pub const LATE_START_SECONDS: std::ops::RangeInclusive<u64> = 60..=604_800;

/// `VECTORY_SCHEDULE_LATE_START_SECONDS`, validated. `None` when unset or
/// empty (the default applies); an error names the variable and its bounds.
pub fn late_start_from(value: Option<&str>) -> anyhow::Result<Option<u64>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    match value.parse::<u64>() {
        Ok(seconds) if LATE_START_SECONDS.contains(&seconds) => Ok(Some(seconds)),
        _ => anyhow::bail!(
            "VECTORY_SCHEDULE_LATE_START_SECONDS must be a whole number of seconds from {} to {} (got {value:?})",
            LATE_START_SECONDS.start(),
            LATE_START_SECONDS.end()
        ),
    }
}

/// The window this server applies, in seconds.
pub fn late_start_seconds(settings: &Settings) -> u64 {
    settings
        .schedule_late_start_seconds
        .filter(|seconds| LATE_START_SECONDS.contains(seconds))
        .unwrap_or(DEFAULT_LATE_START_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_is_bounded_and_defaults_to_one_hour() {
        assert_eq!(late_start_from(None).unwrap(), None);
        assert_eq!(late_start_from(Some("  ")).unwrap(), None);
        assert_eq!(late_start_from(Some("60")).unwrap(), Some(60));
        assert_eq!(late_start_from(Some(" 604800 ")).unwrap(), Some(604_800));
        for invalid in ["59", "604801", "-1", "1h", "3600.5", "0x10", "1e3"] {
            let error = late_start_from(Some(invalid)).unwrap_err().to_string();
            assert!(
                error.contains("VECTORY_SCHEDULE_LATE_START_SECONDS")
                    && error.contains("60 to 604800"),
                "{invalid}: {error}"
            );
        }
        let mut settings = Settings::default();
        assert_eq!(late_start_seconds(&settings), 3600);
        settings.schedule_late_start_seconds = Some(120);
        assert_eq!(late_start_seconds(&settings), 120);
        // A value outside the bounds can't come from the environment; a
        // hand-built setting still can't widen or disable the window.
        settings.schedule_late_start_seconds = Some(0);
        assert_eq!(late_start_seconds(&settings), 3600);
    }
}
