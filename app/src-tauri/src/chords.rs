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

/// Parse a chord name (e.g. "Am", "G", "F#m7") into its pitch classes.
/// Returns None if the root or quality isn't recognized.
pub fn pitch_classes_for(name: &str) -> Option<Vec<usize>> {
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
    // Match against the known qualities (longest suffix wins isn't needed since
    // QUALITIES suffixes are unambiguous here).
    for &(s, intervals, _) in QUALITIES {
        if s == suffix {
            let mut classes: Vec<usize> = intervals.iter().map(|iv| (root + iv) % 12).collect();
            classes.sort_unstable();
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
        assert!(pitch_classes_for("C/G").is_none());
        assert!(pitch_classes_for("Gadd9").is_none());
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
