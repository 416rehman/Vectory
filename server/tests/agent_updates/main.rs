//! Agent updates: the setting and the keys, the releases, the update rollouts
//! and what they do to devices, as one server does them. Real routes and real
//! check-ins feed every assertion; nothing here signs or verifies a release,
//! which the release module's own tests do.
mod engine;
mod report;
mod review;
mod settings;
mod support;
