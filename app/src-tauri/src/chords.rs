//! Chord detection — native port of the prototype's chords.py / feedback.py.
//!
//! chroma (with leakage suppression) -> cosine match against 120 templates,
//! weighted by quality priors (favor triads, penalize power chords) -> chord
//! label + cleanliness (cosine score) + missing/extra notes vs. a target.
//!
//! Tuning constants mirror ukejam-detection-tuning (validated on a real uke).

pub const NOTE_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// (quality suffix, intervals from root, score prior).
/// Prior < 1 penalizes a quality so simpler chords win near-ties.
const QUALITIES: &[(&str, &[usize], f32)] = &[
    ("", &[0, 4, 7], 1.00),  // major
    ("m", &[0, 3, 7], 1.00), // minor
    ("5", &[0, 7], 0.84),    // power chord (penalized hard: usually a triad
    // whose 3rd just rings quietly, e.g. Am's C)
    ("sus2", &[0, 2, 7], 0.97),
    ("sus4", &[0, 5, 7], 0.97),
    ("7", &[0, 4, 7, 10], 0.96),
    ("maj7", &[0, 4, 7, 11], 0.95),
    ("m7", &[0, 3, 7, 10], 0.96),
    ("dim", &[0, 3, 6], 0.95),
    ("aug", &[0, 4, 8], 0.95),
];

/// Quality suffixes accepted for a *target* chord — deliberately a superset of
/// `QUALITIES` above.
///
/// `QUALITIES` drives the detection book: adding a row there adds 12 templates
/// the detector can *report*, which re-tunes every near-tie and needs
/// re-validation against a real uke. A target needs none of that — only its
/// pitch classes, to diff what's ringing against. So a chart calling for Am7b5
/// can be graded without teaching the book to label it.
///
/// Keeping the two separate is what lets this list track the chart vocabulary
/// (and `main.ts`'s `chordPitchClasses`) while detection stays as tuned.
const TARGET_QUALITIES: &[(&str, &[usize])] = &[
    ("", &[0, 4, 7]),
    ("m", &[0, 3, 7]),
    ("5", &[0, 7]),
    ("sus2", &[0, 2, 7]),
    ("sus4", &[0, 5, 7]),
    ("7", &[0, 4, 7, 10]),
    ("maj7", &[0, 4, 7, 11]),
    ("m7", &[0, 3, 7, 10]),
    ("dim", &[0, 3, 6]),
    ("dim7", &[0, 3, 6, 9]),
    ("aug", &[0, 4, 8]),
    ("m7b5", &[0, 3, 6, 10]),
    ("6", &[0, 4, 7, 9]),
    ("m6", &[0, 3, 7, 9]),
    ("add9", &[0, 2, 4, 7]),
    ("7sus4", &[0, 5, 7, 10]),
];

pub struct ChordBook {
    pub labels: Vec<String>,
    pub templates: Vec<[f32; 12]>, // unit-normalized
    pub priors: Vec<f32>,
}

impl ChordBook {
    pub fn build() -> Self {
        let mut labels = Vec::new();
        let mut templates = Vec::new();
        let mut priors = Vec::new();
        for (root, name) in NOTE_NAMES.iter().enumerate() {
            for &(suffix, intervals, prior) in QUALITIES {
                let mut vec = [0.0f32; 12];
                for &iv in intervals {
                    let pc = (root + iv) % 12;
                    vec[pc] = 1.0;
                }
                let norm = (vec.iter().map(|x| x * x).sum::<f32>()).sqrt();
                if norm > 0.0 {
                    for x in vec.iter_mut() {
                        *x /= norm;
                    }
                }
                labels.push(format!("{name}{suffix}"));
                templates.push(vec);
                priors.push(prior);
            }
        }
        Self {
            labels,
            templates,
            priors,
        }
    }

    /// Index of the best chord (prior-weighted) plus raw cosine score.
    pub fn best(&self, chroma: &[f32; 12]) -> (usize, f32) {
        let mut best_i = 0;
        let mut best_ranked = f32::MIN;
        let mut best_raw = 0.0;
        for i in 0..self.templates.len() {
            let dot: f32 = (0..12).map(|k| self.templates[i][k] * chroma[k]).sum();
            let ranked = dot * self.priors[i];
            if ranked > best_ranked {
                best_ranked = ranked;
                best_raw = dot;
                best_i = i;
            }
        }
        (best_i, best_raw)
    }
}

/// Parse a chord name (e.g. "Am", "G", "F#m7", "D/F#") into its pitch classes.
/// Returns None if the root or quality isn't recognized — the caller must treat
/// that as "cannot grade this chord", never as "no target" (see `set_target`).
pub fn pitch_classes_for(name: &str) -> Option<Vec<usize>> {
    // Drop a slash bass ("D/F#" -> "D"). The bass note is a voicing instruction,
    // not an extra required pitch class, and on a 4-string uke it usually isn't
    // reachable anyway. Rejecting the whole name instead used to mean the target
    // silently vanished and every slash chord in a chart auto-passed.
    let name = name.split('/').next().unwrap_or(name).trim();
    let bytes = name.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    // root letter
    let mut root = match bytes[0] {
        b'C' => 0,
        b'D' => 2,
        b'E' => 4,
        b'F' => 5,
        b'G' => 7,
        b'A' => 9,
        b'B' => 11,
        _ => return None,
    };
    let mut i = 1;
    if i < bytes.len() && (bytes[i] == b'#' || bytes[i] == b'b') {
        root = if bytes[i] == b'#' {
            (root + 1) % 12
        } else {
            (root + 11) % 12
        };
        i += 1;
    }
    let suffix = &name[i..];
    // Match against the gradeable qualities (exact match; the suffixes are
    // unambiguous, so no longest-wins pass is needed).
    for &(s, intervals) in TARGET_QUALITIES {
        if s == suffix {
            let mut classes: Vec<usize> = intervals.iter().map(|iv| (root + iv) % 12).collect();
            classes.sort_unstable();
            classes.dedup(); // add9 spells 9 as 2, which a root of 0 would double
            return Some(classes);
        }
    }
    None
}

/// Pitch classes whose chroma energy exceeds `thresh`.
fn sounding(chroma: &[f32; 12], thresh: f32) -> Vec<usize> {
    (0..12).filter(|&k| chroma[k] >= thresh).collect()
}

/// (missing, extra) note names vs. a target pitch-class set.
pub fn diff(chroma: &[f32; 12], target: &[usize], thresh: f32) -> (Vec<String>, Vec<String>) {
    let playing = sounding(chroma, thresh);
    let missing = target
        .iter()
        .filter(|p| !playing.contains(p))
        .map(|&p| NOTE_NAMES[p].to_string())
        .collect();
    let extra = playing
        .iter()
        .filter(|p| !target.contains(p))
        .map(|&p| NOTE_NAMES[p].to_string())
        .collect();
    (missing, extra)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_chord_names() {
        assert_eq!(pitch_classes_for("C").unwrap(), vec![0, 4, 7]);
        assert_eq!(pitch_classes_for("Am").unwrap(), vec![0, 4, 9]);
        assert_eq!(pitch_classes_for("Bb").unwrap(), vec![2, 5, 10]);
        assert_eq!(pitch_classes_for("F#m7").unwrap(), vec![1, 4, 6, 9]);
    }

    #[test]
    fn rejects_unsupported_chord_names() {
        assert!(pitch_classes_for("").is_none());
        assert!(pitch_classes_for("c").is_none());
        // Junk must stay None. The caller turns None into "no target", and with
        // no target the missing/extra diff is empty — which the UI and the bar
        // grader both used to read as a flawless chord. See set_target in lib.rs.
        assert!(pitch_classes_for("Gx").is_none());
        assert!(pitch_classes_for("Riff").is_none());
        assert!(pitch_classes_for("G#x").is_none());
    }

    /// Qualities a chart can ask for but the detection book deliberately can't
    /// label. Grading needs only pitch classes, so these must parse even though
    /// they are absent from QUALITIES.
    #[test]
    fn grades_qualities_the_detector_cannot_label() {
        assert_eq!(pitch_classes_for("Cdim7").unwrap(), vec![0, 3, 6, 9]);
        assert_eq!(pitch_classes_for("Am7b5").unwrap(), vec![0, 3, 7, 9]);
        assert_eq!(pitch_classes_for("C6").unwrap(), vec![0, 4, 7, 9]);
        assert_eq!(pitch_classes_for("Cm6").unwrap(), vec![0, 3, 7, 9]);
        assert_eq!(pitch_classes_for("G7sus4").unwrap(), vec![0, 2, 5, 7]);
        // add9 spells the 9 as pitch class 2; on a root of D that collides with
        // nothing, but the dedup matters for roots where it would double a tone.
        assert_eq!(pitch_classes_for("Cadd9").unwrap(), vec![0, 2, 4, 7]);
        // Every quality in the table must parse for every root, or a chart using
        // it silently stops being graded.
        for &(suffix, _) in TARGET_QUALITIES {
            for root in NOTE_NAMES {
                let name = format!("{root}{suffix}");
                assert!(
                    pitch_classes_for(&name).is_some(),
                    "{name} should be gradeable"
                );
            }
        }
    }

    /// A slash bass is a voicing instruction, not an extra required note — and on
    /// four strings usually not even reachable. Rejecting the name outright meant
    /// the target silently vanished and the chord auto-passed.
    #[test]
    fn slash_chords_grade_as_their_upper_triad() {
        assert_eq!(
            pitch_classes_for("D/F#").unwrap(),
            pitch_classes_for("D").unwrap()
        );
        assert_eq!(
            pitch_classes_for("C/G").unwrap(),
            pitch_classes_for("C").unwrap()
        );
        // The bass note is not silently promoted into the required set.
        assert!(!pitch_classes_for("C/B").unwrap().contains(&11));
    }

    /// Every quality the frontend resolver knows must also parse here. The two
    /// lists are separate code in separate languages; when they drift, the
    /// frontend shows a target Rust is not grading, which reads as a clean hit.
    #[test]
    fn target_qualities_match_the_frontends_list() {
        let main_ts = include_str!("../../src/main.ts");
        let start = main_ts
            .find("const intervals: Record<string, number[]> = {")
            .expect("frontend interval table not found in main.ts");
        let open = main_ts[start..].find('{').unwrap() + start;
        let mut depth = 0;
        let end = main_ts[open..]
            .char_indices()
            .find(|&(_, ch)| {
                match ch {
                    '{' => depth += 1,
                    '}' => depth -= 1,
                    _ => {}
                }
                depth == 0
            })
            .map(|(i, _)| open + i)
            .expect("unterminated interval table");
        let table = &main_ts[open..=end];
        for line in table.lines() {
            let line = line.trim();
            let Some((key, _)) = line.split_once(':') else {
                continue;
            };
            if !line.contains('[') {
                continue;
            }
            let suffix = key.trim().trim_matches('"');
            assert!(
                TARGET_QUALITIES.iter().any(|&(s, _)| s == suffix),
                "main.ts grades quality {suffix:?} but chords.rs does not — \
                 the frontend would show a target Rust never checks"
            );
        }
    }

    #[test]
    fn diffs_missing_and_extra_pitch_classes() {
        let target = pitch_classes_for("C").unwrap();
        let mut chroma = [0.0; 12];
        chroma[0] = 0.4;
        chroma[4] = 0.4;
        chroma[2] = 0.3;

        let (missing, extra) = diff(&chroma, &target, 0.18);
        assert_eq!(missing, vec!["G"]);
        assert_eq!(extra, vec!["D"]);
    }
}
