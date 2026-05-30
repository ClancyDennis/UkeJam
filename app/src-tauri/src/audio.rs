//! Audio capture + pitch detection for the tuner.
//!
//! Captures the default input device with cpal, accumulates samples into a
//! window, runs an FFT (rustfft), finds the strongest spectral peak in the
//! ukulele range, snaps it to the nearest open string, and reports the cents
//! offset. Results are pushed to the frontend as `tuner` events.
//!
//! This is the native port of the prototype's analysis path; the chord
//! detector will extend the same capture/FFT pipeline later.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::chords::{diff, ChordBook};

const FFT_SIZE: usize = 8192; // ~5.4 Hz bins @ 44.1kHz — resolves adjacent notes
const FMIN: f32 = 70.0;
const FMAX: f32 = 1100.0;
const RMS_GATE: f32 = 0.01;
const CHROMA_FMIN: f32 = 65.0;
const CHROMA_FMAX: f32 = 1050.0; // cut high harmonic bleed (see detection tuning)
const PRESENCE: f32 = 0.18; // chroma bin above this counts as "sounding"

/// What the capture thread analyzes each window into.
#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Tuner,
    Chord,
}

/// Baritone ukulele open strings (low -> high): D3 G3 B3 E4.
const STRINGS: [(&str, f32); 4] = [
    ("D3", 146.83),
    ("G3", 196.00),
    ("B3", 246.94),
    ("E4", 329.63),
];

#[derive(Serialize, Clone)]
pub struct TunerReading {
    /// True when a stable pitch is present (above the silence gate).
    pub active: bool,
    /// Detected fundamental frequency in Hz (0 when inactive).
    pub freq: f32,
    /// Nearest open-string label, e.g. "G3".
    pub nearest: String,
    /// Signed cents from that string (negative = flat, positive = sharp).
    pub cents: f32,
    /// Signal RMS (for a level meter).
    pub rms: f32,
}

#[derive(Serialize, Clone)]
pub struct ChordReading {
    /// True when something is being played (above the silence gate).
    pub active: bool,
    /// Detected chord label, e.g. "Am" (empty when inactive).
    pub detected: String,
    /// Cleanliness = cosine match score 0..1 (the gauge value).
    pub cleanliness: f32,
    /// 12-bin chroma (C..B), normalized — for the chromagram display.
    pub chroma: [f32; 12],
    /// Notes expected by the target chord but not heard.
    pub missing: Vec<String>,
    /// Notes heard but not in the target chord.
    pub extra: Vec<String>,
    pub rms: f32,
}

/// Runtime-adjustable analysis settings, shared with the capture thread.
struct Shared {
    mode: Mode,
    target: Option<Vec<usize>>, // target chord's pitch classes, for the diff
}

/// Tracks the capture thread. The cpal `Stream` is `!Send` on macOS, so it is
/// created, owned, and dropped entirely within a dedicated thread; here we only
/// keep the `running` flag that thread polls to know when to shut down, plus
/// the shared analysis settings.
pub struct AudioState {
    running: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            shared: Arc::new(Mutex::new(Shared {
                mode: Mode::Tuner,
                target: None,
            })),
        }
    }
}

impl AudioState {
    /// Start capturing in the given mode. Idempotent (updates mode if running).
    pub fn start(&self, app: AppHandle, mode: Mode) -> Result<(), String> {
        self.shared.lock().unwrap().mode = mode;
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(()); // already running; mode updated above
        }
        let running = self.running.clone();
        let shared = self.shared.clone();

        // A oneshot channel lets us surface stream-build errors back to the
        // caller before the thread settles into its keep-alive loop.
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

        std::thread::spawn(move || {
            match build_stream(app, shared) {
                Ok(stream) => {
                    // Stream must stay alive (and on this thread) to keep
                    // capturing. Hold it and park until asked to stop.
                    let _ = tx.send(Ok(()));
                    while running.load(Ordering::SeqCst) {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    drop(stream); // stops capture
                }
                Err(e) => {
                    running.store(false, Ordering::SeqCst);
                    let _ = tx.send(Err(e));
                }
            }
        });

        // Wait for the thread to report whether the stream started.
        rx.recv().unwrap_or_else(|_| Err("capture thread died".into()))
    }

    /// Switch analysis mode while running.
    pub fn set_mode(&self, mode: Mode) {
        self.shared.lock().unwrap().mode = mode;
    }

    /// Set the target chord (its pitch classes) for the missing/extra diff.
    pub fn set_target(&self, pcs: Option<Vec<usize>>) {
        self.shared.lock().unwrap().target = pcs;
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// Build and start the cpal input stream. Runs on the capture thread.
fn build_stream(app: AppHandle, shared: Arc<Mutex<Shared>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no input device available")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("default input config: {e}"))?;
    let sample_rate = config.sample_rate().0 as f32;
    let channels = config.channels() as usize;

    let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::with_capacity(FFT_SIZE * 2)));
    let analyzer = Arc::new(Analyzer::new(sample_rate));

    let err_fn = |e| eprintln!("audio stream error: {e}");
    let buf_cb = buf.clone();
    let app_cb = app.clone();
    let an = analyzer.clone();
    let sh = shared.clone();

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                feed(&buf_cb, data, channels);
                drain_and_emit(&buf_cb, &an, &app_cb, &sh);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _| {
                let f: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                feed(&buf_cb, &f, channels);
                drain_and_emit(&buf_cb, &an, &app_cb, &sh);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.into(),
            move |data: &[u16], _| {
                let f: Vec<f32> = data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                feed(&buf_cb, &f, channels);
                drain_and_emit(&buf_cb, &an, &app_cb, &sh);
            },
            err_fn,
            None,
        ),
        fmt => return Err(format!("unsupported sample format: {fmt:?}")),
    }
    .map_err(|e| format!("build input stream: {e}"))?;

    stream.play().map_err(|e| format!("stream play: {e}"))?;
    Ok(stream)
}

/// Append (downmixed-to-mono) samples to the rolling buffer.
fn feed(buf: &Arc<Mutex<Vec<f32>>>, data: &[f32], channels: usize) {
    let mut b = buf.lock().unwrap();
    if channels <= 1 {
        b.extend_from_slice(data);
    } else {
        // average channels to mono
        for frame in data.chunks(channels) {
            let s: f32 = frame.iter().copied().sum::<f32>() / channels as f32;
            b.push(s);
        }
    }
    // Cap memory: keep at most 2 windows of history.
    let cap = FFT_SIZE * 2;
    if b.len() > cap {
        let drop = b.len() - cap;
        b.drain(0..drop);
    }
}

/// When we have a full window, analyze it per the current mode and emit.
fn drain_and_emit(
    buf: &Arc<Mutex<Vec<f32>>>,
    analyzer: &Analyzer,
    app: &AppHandle,
    shared: &Arc<Mutex<Shared>>,
) {
    let window = {
        let b = buf.lock().unwrap();
        if b.len() < FFT_SIZE {
            return;
        }
        b[b.len() - FFT_SIZE..].to_vec()
    };
    let (mode, target) = {
        let s = shared.lock().unwrap();
        (s.mode, s.target.clone())
    };
    match mode {
        Mode::Tuner => {
            let _ = app.emit("tuner", analyzer.analyze_tuner(&window));
        }
        Mode::Chord => {
            let _ = app.emit("chord", analyzer.analyze_chord(&window, target.as_deref()));
        }
    }
}

/// Reusable FFT + pitch/chord analysis.
struct Analyzer {
    sample_rate: f32,
    fft: Arc<dyn rustfft::Fft<f32>>,
    hann: Vec<f32>,
    book: ChordBook,
}

impl Analyzer {
    fn new(sample_rate: f32) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let hann: Vec<f32> = (0..FFT_SIZE)
            .map(|n| {
                let x = std::f32::consts::PI * n as f32 / (FFT_SIZE as f32 - 1.0);
                x.sin().powi(2) // Hann window
            })
            .collect();
        Self {
            sample_rate,
            fft,
            hann,
            book: ChordBook::build(),
        }
    }

    /// Windowed FFT magnitudes + mean-removed RMS.
    fn spectrum(&self, samples: &[f32]) -> (Vec<f32>, f32) {
        let mean = samples.iter().copied().sum::<f32>() / samples.len() as f32;
        let rms = (samples.iter().map(|s| (s - mean).powi(2)).sum::<f32>()
            / samples.len() as f32)
            .sqrt();
        let mut buf: Vec<Complex<f32>> = samples
            .iter()
            .zip(&self.hann)
            .map(|(&s, &w)| Complex::new((s - mean) * w, 0.0))
            .collect();
        self.fft.process(&mut buf);
        let mag = buf[..FFT_SIZE / 2].iter().map(|c| c.norm()).collect();
        (mag, rms)
    }

    /// 12-bin chroma with spectral-leakage suppression (see detection tuning).
    fn chroma(&self, mag: &[f32]) -> [f32; 12] {
        let bin_hz = self.sample_rate / FFT_SIZE as f32;
        let mut chroma = [0.0f32; 12];
        let lo = (CHROMA_FMIN / bin_hz).floor().max(1.0) as usize;
        let hi = ((CHROMA_FMAX / bin_hz).ceil() as usize).min(mag.len());
        for i in lo..hi {
            let f = i as f32 * bin_hz;
            let midi = 69.0 + 12.0 * (f / 440.0).log2();
            let nearest = midi.round();
            let cents = (midi - nearest).abs();
            // suppress leakage skirts: cos(pi*cents)^2, like the Python engine
            let w = (std::f32::consts::PI * cents).cos().max(0.0).powi(2);
            let pc = ((nearest as i32) % 12 + 12) % 12;
            chroma[pc as usize] += mag[i] * w;
        }
        let norm = (chroma.iter().map(|x| x * x).sum::<f32>()).sqrt();
        if norm > 0.0 {
            for x in chroma.iter_mut() {
                *x /= norm;
            }
        }
        chroma
    }

    fn analyze_chord(&self, samples: &[f32], target: Option<&[usize]>) -> ChordReading {
        let (mag, rms) = self.spectrum(samples);
        if rms < RMS_GATE {
            return ChordReading {
                active: false,
                detected: String::new(),
                cleanliness: 0.0,
                chroma: [0.0; 12],
                missing: vec![],
                extra: vec![],
                rms,
            };
        }
        let chroma = self.chroma(&mag);
        let (idx, score) = self.book.best(&chroma);
        let (missing, extra) = match target {
            Some(t) => diff(&chroma, t, PRESENCE),
            None => (vec![], vec![]),
        };
        ChordReading {
            active: true,
            detected: self.book.labels[idx].clone(),
            cleanliness: score,
            chroma,
            missing,
            extra,
            rms,
        }
    }

    fn analyze_tuner(&self, samples: &[f32]) -> TunerReading {
        // RMS for the silence gate / level meter.
        let mean = samples.iter().copied().sum::<f32>() / samples.len() as f32;
        let rms = (samples.iter().map(|s| (s - mean).powi(2)).sum::<f32>()
            / samples.len() as f32)
            .sqrt();

        if rms < RMS_GATE {
            return TunerReading {
                active: false,
                freq: 0.0,
                nearest: String::new(),
                cents: 0.0,
                rms,
            };
        }

        // Windowed FFT.
        let mut buf: Vec<Complex<f32>> = samples
            .iter()
            .zip(&self.hann)
            .map(|(&s, &w)| Complex::new((s - mean) * w, 0.0))
            .collect();
        self.fft.process(&mut buf);

        let bin_hz = self.sample_rate / FFT_SIZE as f32;
        let lo = (FMIN / bin_hz).floor() as usize;
        let hi = ((FMAX / bin_hz).ceil() as usize).min(FFT_SIZE / 2);

        // Find the strongest bin in range.
        let mut peak_i = lo;
        let mut peak_mag = 0.0_f32;
        for i in lo..hi {
            let m = buf[i].norm();
            if m > peak_mag {
                peak_mag = m;
                peak_i = i;
            }
        }

        // Parabolic interpolation around the peak for sub-bin accuracy.
        let freq = if peak_i > 0 && peak_i < FFT_SIZE / 2 - 1 {
            let a = buf[peak_i - 1].norm();
            let b = buf[peak_i].norm();
            let c = buf[peak_i + 1].norm();
            let denom = a - 2.0 * b + c;
            let delta = if denom.abs() > 1e-9 {
                0.5 * (a - c) / denom
            } else {
                0.0
            };
            (peak_i as f32 + delta) * bin_hz
        } else {
            peak_i as f32 * bin_hz
        };

        let (nearest, cents) = nearest_string(freq);
        TunerReading {
            active: true,
            freq,
            nearest: nearest.to_string(),
            cents,
            rms,
        }
    }
}

/// Snap a frequency to the nearest baritone open string; return (name, cents).
fn nearest_string(freq: f32) -> (&'static str, f32) {
    let mut best = STRINGS[0];
    let mut best_cents = f32::MAX;
    for &(name, f0) in &STRINGS {
        let cents = 1200.0 * (freq / f0).log2();
        if cents.abs() < best_cents.abs() {
            best_cents = cents;
            best = (name, f0);
        }
    }
    (best.0, best_cents)
}
