//! Bounded counters with fixed windows, one per key. The request limiter's
//! partitions and sign-in failure accounting each keep their own ledger, so
//! none can exhaust another. When full, a ledger evicts the entry that
//! expires soonest (expired entries first): it never declines to count a new
//! key. Each new key also drops a few expired entries, so a ledger never
//! scans all of its entries.
use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};

/// Expired entries dropped per new key, oldest first.
const PRUNE_PER_INSERT: usize = 8;

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
    /// Seconds until `key` may try again once it holds `maximum` counts.
    pub fn blocked(&mut self, key: &str, maximum: u32) -> Option<u64> {
        let entry = self.live(key)?;
        (entry.count >= maximum).then(|| remaining(entry))
    }
    /// Whether `key` holds at least one count in its current window.
    pub fn seen(&mut self, key: &str) -> bool {
        self.live(key).is_some_and(|entry| entry.count > 0)
    }
    /// Count one against `key`, opening a `window` if it has none.
    pub fn add(&mut self, key: &str, window: Duration) {
        if let Some(entry) = self.live(key) {
            entry.count = entry.count.saturating_add(1);
            return;
        }
        self.prune(PRUNE_PER_INSERT);
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
    /// Count one against `key` unless it already holds `ceiling` in its
    /// current window; `Err` is the seconds until that window ends. A refused
    /// call is not counted, so a caller that checks a narrower budget first
    /// and this one second charges this one only for what the first let
    /// through.
    pub fn admit(&mut self, key: &str, ceiling: u32, window: Duration) -> Result<(), u64> {
        if ceiling == 0 {
            return Err(window.as_secs() + 1);
        }
        if let Some(wait) = self.blocked(key, ceiling) {
            return Err(wait);
        }
        self.add(key, window);
        Ok(())
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
    /// Drop at most `most` expired entries, soonest expiry first.
    fn prune(&mut self, most: usize) {
        let now = Instant::now();
        for _ in 0..most {
            match self.by_expiry.first_key_value() {
                Some(((expiry, _), _)) if *expiry <= now => {
                    if let Some((_, key)) = self.by_expiry.pop_first() {
                        self.entries.remove(&key);
                    }
                }
                _ => break,
            }
        }
    }
}

/// Whole seconds until `entry`'s window ends, rounded up to at least one.
fn remaining(entry: &Entry) -> u64 {
    entry
        .expiry
        .0
        .saturating_duration_since(Instant::now())
        .as_secs()
        + 1
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

    #[test]
    fn calls_are_admitted_up_to_the_ceiling_and_start_over_after_the_window() {
        let mut ledger = Ledger::with_capacity(8);
        for _ in 0..3 {
            assert_eq!(ledger.admit("key", 3, Duration::from_secs(60)), Ok(()));
        }
        let wait = ledger.admit("key", 3, Duration::from_secs(60)).unwrap_err();
        assert!((59..=60).contains(&wait), "{wait}");
        // A window that has ended opens a new one.
        assert_eq!(ledger.admit("brief", 1, Duration::ZERO), Ok(()));
        assert_eq!(ledger.admit("brief", 1, Duration::ZERO), Ok(()));
        // A ceiling of nothing admits nothing, and leaves no entry behind.
        assert!(ledger.admit("closed", 0, Duration::from_secs(60)).is_err());
        assert!(!ledger.seen("closed"));
    }

    #[test]
    fn a_refused_call_does_not_advance_the_count() {
        // Two budgets, charged narrowest first: an address that has spent its
        // own budget never touches the shared one.
        let mut ledger = Ledger::with_capacity(16);
        let minute = Duration::from_secs(60);
        let mut shared_calls = 0;
        for _ in 0..700 {
            if ledger.admit("client", 60, minute).is_ok() {
                ledger.admit("shared", 600, minute).unwrap();
                shared_calls += 1;
            }
        }
        assert_eq!(shared_calls, 60);
        assert!(ledger.blocked("shared", 60).is_some());
        assert!(
            ledger.blocked("shared", 61).is_none(),
            "the shared budget was charged for refused calls"
        );
        // A call refused by a ceiling doesn't raise the count past it, so a
        // caller with a higher ceiling (a reserved share) keeps its room.
        let admitted = (0..50)
            .filter(|_| ledger.admit("shared", 100, minute).is_ok())
            .count();
        assert_eq!(admitted, 40);
        assert!(ledger.blocked("shared", 101).is_none());
        assert!(ledger.admit("shared", 150, minute).is_ok());
    }

    #[test]
    fn new_keys_drop_expired_entries_a_few_at_a_time() {
        let mut ledger = Ledger::with_capacity(1000);
        for n in 0..20 {
            ledger.add(&format!("brief-{n}"), Duration::from_millis(200));
        }
        std::thread::sleep(Duration::from_millis(250));
        ledger.add("live", Duration::from_secs(60));
        assert_eq!(ledger.len(), 20 - PRUNE_PER_INSERT + 1);
        ledger.add("live-2", Duration::from_secs(60));
        ledger.add("live-3", Duration::from_secs(60));
        assert_eq!(ledger.len(), 3, "only the live keys are left");
        assert_eq!(ledger.by_expiry.len(), 3);
    }
}
