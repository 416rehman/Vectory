//! Sign-in failure accounting, kept apart from the request limiter so neither
//! can exhaust the other. The ledger is bounded, and when full it evicts the
//! entry that expires soonest (expired entries first). It never declines to
//! record a failure and never turns a sign-in away because it is full.
use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};

/// Live entries. A single instance allows 600 sign-in attempts a minute, each
/// adding at most two failure keys with 15- and 60-minute windows: about
/// 45,000 live keys at the cap, so nothing live is evicted in practice.
pub const CAPACITY: usize = 65536;

struct Entry {
    count: u32,
    expiry: (Instant, u64),
}

pub struct Ledger {
    capacity: usize,
    entries: HashMap<String, Entry>,
    by_expiry: BTreeMap<(Instant, u64), String>,
    sequence: u64,
}

impl Default for Ledger {
    fn default() -> Self {
        Self::with_capacity(CAPACITY)
    }
}

impl Ledger {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: HashMap::new(),
            by_expiry: BTreeMap::new(),
            sequence: 0,
        }
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    fn live(&mut self, key: &str) -> Option<&mut Entry> {
        let expired = self
            .entries
            .get(key)
            .is_some_and(|entry| entry.expiry.0 <= Instant::now());
        if expired {
            self.remove(key);
        }
        self.entries.get_mut(key)
    }
    /// Seconds until `key` may try again once it holds `maximum` failures.
    pub fn blocked(&mut self, key: &str, maximum: u32) -> Option<u64> {
        let entry = self.live(key)?;
        (entry.count >= maximum).then(|| {
            entry
                .expiry
                .0
                .saturating_duration_since(Instant::now())
                .as_secs()
                + 1
        })
    }
    /// Whether `key` holds at least one entry in its current window.
    pub fn seen(&mut self, key: &str) -> bool {
        self.live(key).is_some_and(|entry| entry.count > 0)
    }
    /// Count one against `key`, opening a `window` if it has none.
    pub fn add(&mut self, key: &str, window: Duration) {
        if let Some(entry) = self.live(key) {
            entry.count = entry.count.saturating_add(1);
            return;
        }
        while self.entries.len() >= self.capacity {
            let Some((_, oldest)) = self.by_expiry.pop_first() else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.sequence += 1;
        let expiry = (Instant::now() + window, self.sequence);
        self.by_expiry.insert(expiry, key.to_owned());
        self.entries
            .insert(key.to_owned(), Entry { count: 1, expiry });
    }
    /// Give back one count reserved against `key`.
    pub fn refund(&mut self, key: &str) {
        if let Some(entry) = self.live(key) {
            entry.count = entry.count.saturating_sub(1);
            if entry.count == 0 {
                self.remove(key);
            }
        }
    }
    pub fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.by_expiry.remove(&entry.expiry);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_ledger_evicts_the_soonest_expiry_and_still_records() {
        let mut ledger = Ledger::with_capacity(3);
        ledger.add("short", Duration::from_secs(60));
        ledger.add("long", Duration::from_secs(3600));
        ledger.add("month", Duration::from_secs(30 * 86400));
        ledger.add("new", Duration::from_secs(900));
        assert_eq!(ledger.len(), 3);
        assert!(!ledger.seen("short"));
        assert!(ledger.seen("long") && ledger.seen("month") && ledger.seen("new"));
        for _ in 0..5 {
            ledger.add("another", Duration::from_secs(900));
        }
        assert_eq!(ledger.len(), 3);
        assert!(!ledger.seen("new"));
        assert_eq!(
            ledger.blocked("another", 5).map(|wait| wait > 0),
            Some(true)
        );
        assert_eq!(ledger.blocked("another", 6), None);
    }

    #[test]
    fn refunds_and_expiry_free_entries() {
        let mut ledger = Ledger::with_capacity(8);
        ledger.add("key", Duration::from_secs(60));
        ledger.add("key", Duration::from_secs(60));
        ledger.refund("key");
        assert!(ledger.seen("key"));
        ledger.refund("key");
        assert!(ledger.is_empty());
        ledger.add("gone", Duration::ZERO);
        assert!(!ledger.seen("gone"));
        assert!(ledger.is_empty());
        assert!(ledger.by_expiry.is_empty());
    }
}
