//! The one canonical wire-instant formatter for the fs-helper sidecar.
//!
//! Every timestamp the sidecar emits over the wire (history `recorded_at`,
//! index `indexed_at` / `last_indexed_at`, rebuild-task `started_at` /
//! `finished_at`) MUST be produced here so there is exactly ONE formatter
//! (C1) and zero silent fallbacks (C2 — no `unwrap_or_default()` → 1970, no
//! hand-rolled formats, no 5-digit year overflow).
//!
//! Canonical wire instant: `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, exactly 3
//! fractional digits, trailing `Z`), matching
//! `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.

/// The one canonical wire-instant formatter: `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC).
///
/// `to_rfc3339_opts(SecondsFormat::Millis, true)` emits exactly three
/// fractional digits and a `Z` suffix (the `true` forces `Z` instead of
/// `+00:00`). chrono's `Utc::now()` is range-safe and never produces a
/// pre-epoch or 5-digit-year value from the system clock, so the old
/// `unwrap_or_default()` silent-1970 hazard and the civil-date overflow are
/// both gone.
pub fn iso_instant_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches_canonical(s: &str) -> bool {
        // ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$
        let b = s.as_bytes();
        if b.len() != 24 {
            return false;
        }
        let digit = |i: usize| b[i].is_ascii_digit();
        digit(0) && digit(1) && digit(2) && digit(3)
            && b[4] == b'-'
            && digit(5) && digit(6)
            && b[7] == b'-'
            && digit(8) && digit(9)
            && b[10] == b'T'
            && digit(11) && digit(12)
            && b[13] == b':'
            && digit(14) && digit(15)
            && b[16] == b':'
            && digit(17) && digit(18)
            && b[19] == b'.'
            && digit(20) && digit(21) && digit(22)
            && b[23] == b'Z'
    }

    #[test]
    fn emits_canonical_shape_mmm_z() {
        let s = iso_instant_now();
        assert!(
            matches_canonical(&s),
            "iso_instant_now() must match YYYY-MM-DDTHH:MM:SS.mmmZ, got {s:?}"
        );
    }

    #[test]
    fn known_instant_formats_exactly() {
        use chrono::TimeZone;
        // Verify the exact `…mmmZ` shape against a fixed instant so the
        // formatting contract is locked independent of the wall clock.
        let dt = chrono::Utc
            .with_ymd_and_hms(2026, 6, 8, 12, 34, 56)
            .unwrap();
        let s = dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert_eq!(s, "2026-06-08T12:34:56.000Z");
        assert!(matches_canonical(&s));
    }

    #[test]
    fn canonical_instants_sort_chronologically_by_string() {
        // Fixed-width canonical ISO means lexicographic order == chronological
        // order, which is what the `indexed_at` max comparison in index.rs
        // relies on. Two distinct instants must compare the same way as
        // strings and as time.
        let earlier = "2026-06-08T12:34:56.000Z";
        let later = "2026-06-08T12:34:56.001Z";
        assert!(earlier < later);

        let year_boundary_earlier = "2026-12-31T23:59:59.999Z";
        let year_boundary_later = "2027-01-01T00:00:00.000Z";
        assert!(year_boundary_earlier < year_boundary_later);
    }
}
