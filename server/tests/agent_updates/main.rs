//! Agent updates: the setting and the keys, the releases, the update rollouts
//! and what they do to devices, as one server does them. Real routes and real
//! check-ins feed every assertion; the release module's own tests decide what
//! is a valid release, and these tests decide only that the server's offers pass
//! the check a host makes.
mod audit;
mod download;
mod engine;
mod keys;
mod releases;
mod report;
mod review;
mod settings;
mod support;
