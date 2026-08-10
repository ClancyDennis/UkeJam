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
use std::sync::mpsc::TrySendError;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

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

// --- onset (attack) detection ---
// A strum is a sudden rise in energy across the whole chord band, so we track
// spectral flux (summed positive frame-to-frame magnitude change) rather than
// RMS: RMS also rises when a held chord swells, and barely moves when a new
// chord is strummed at the same volume as the one decaying under it.
//
// Flux is normalized against its own slow mean so the threshold is a *ratio*,
// not an absolute level — the same setting works for a quiet fingerpick and a
// loud strum without recalibrating.
const FLUX_SMOOTH: f32 = 0.05; // EMA weight for the slow flux baseline
const ONSET_RATIO: f32 = 2.2; // flux must exceed this multiple of the baseline
const ONSET_REFRACTORY: Duration = Duration::from_millis(60); // one strum = one onset

/// What the capture thread analyzes each window into.
#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Tuner,
    Chord,
}

/// Which ukulele the tuner is listening for.
///
/// Only the tuner cares: chord detection works off a 12-bin chroma, which is
/// octave- and tuning-agnostic, so the detector needs no change to follow a
/// re-tuned instrument.
#[derive(Clone, Copy, PartialEq, Default)]
pub enum Tuning {
    /// Standard soprano/concert/tenor re-entrant tuning: G4 C4 E4 A4.
    #[default]
    Standard,
    /// Baritone: D3 G3 B3 E4.
    Baritone,
}

impl Tuning {
    pub fn from_str(s: &str) -> Self {
        match s {
            "baritone" => Tuning::Baritone,
            _ => Tuning::Standard,
        }
    }

    /// Open strings in playing order (string 1 last), with their frequencies.
    ///
    /// Standard tuning is re-entrant — the 4th string G4 sounds *above* C4 —
    /// so this is deliberately not sorted by pitch; the frontend draws the
    /// strings in this order.
    fn strings(self) -> &'static [(&'static str, f32)] {
        match self {
            Tuning::Standard => &[("G4", 392.00), ("C4", 261.63), ("E4", 329.63), ("A4", 440.00)],
            Tuning::Baritone => &[("D3", 146.83), ("G3", 196.00), ("B3", 246.94), ("E4", 329.63)],
        }
    }
}

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
    /// Log-spaced magnitude spectrum (normalized 0..1) for the FFT display.
    pub spectrum: Vec<f32>,
    /// Notes expected by the target chord but not heard.
    pub missing: Vec<String>,
    /// Notes heard but not in the target chord.
    pub extra: Vec<String>,
    pub rms: f32,
    /// True when an attack (strum/pluck) began since the last emitted reading.
    /// Latched, not instantaneous: emits are coalesced (see MIN_EMIT_INTERVAL)
    /// but analysis runs every window, so an onset detected in a window that
    /// wasn't emitted would otherwise be lost — which is exactly the window a
    /// strum lands in.
    pub onset: bool,
    /// Spectral flux as a multiple of its slow baseline (1.0 = steady state).
    /// Exposed for tuning the onset threshold from the diagnostics drawer.
    pub flux: f32,
}

/// Runtime-adjustable analysis settings, shared with the capture thread.
struct Shared {
    mode: Mode,
    target: Option<Vec<usize>>, // target chord's pitch classes, for the diff
    gate: f32,                  // RMS silence gate (set by mic calibration)
    tuning: Tuning,             // which open strings the tuner snaps to
}

struct CaptureRuntime {
    stream: Option<cpal::Stream>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for CaptureRuntime {
    fn drop(&mut self) {
        drop(self.stream.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Tracks the capture thread. The cpal `Stream` is `!Send` on macOS, so it is
/// created, owned, and dropped entirely within a dedicated thread; here we only
/// keep the `running` flag that thread polls to know when to shut down, plus
/// the shared analysis settings.
pub struct AudioState {
    running: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            shared: Arc::new(Mutex::new(Shared {
                mode: Mode::Tuner,
                target: None,
                gate: RMS_GATE,
                tuning: Tuning::default(),
            })),
            thread: Mutex::new(None),
        }
    }
}

impl AudioState {
    /// Start capturing in the given mode. Idempotent (updates mode if running).
    pub fn start(&self, app: AppHandle, mode: Mode) -> Result<(), String> {
        self.shared.lock().unwrap().mode = mode;
        let mut thread = self.thread.lock().unwrap();
        if thread.is_some() {
            return Ok(()); // already running; mode updated above
        }
        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();
        let shared = self.shared.clone();

        // A oneshot channel lets us surface stream-build errors back to the
        // caller before the thread settles into its keep-alive loop.
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

        let handle = std::thread::spawn(move || {
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
        match rx
            .recv()
            .unwrap_or_else(|_| Err("capture thread died".into()))
        {
            Ok(()) => {
                *thread = Some(handle);
                Ok(())
            }
            Err(e) => {
                let _ = handle.join();
                Err(e)
            }
        }
    }

    /// Switch analysis mode while running.
    pub fn set_mode(&self, mode: Mode) {
        self.shared.lock().unwrap().mode = mode;
    }

    /// Set the target chord (its pitch classes) for the missing/extra diff.
    pub fn set_target(&self, pcs: Option<Vec<usize>>) {
        self.shared.lock().unwrap().target = pcs;
    }

    /// Set the RMS silence gate (from mic calibration).
    pub fn set_gate(&self, gate: f32) {
        self.shared.lock().unwrap().gate = gate.max(0.0);
    }

    /// Set the instrument tuning the tuner snaps to. Takes effect on the next
    /// analyzed window, so it can be changed while listening.
    pub fn set_tuning(&self, tuning: Tuning) {
        self.shared.lock().unwrap().tuning = tuning;
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.thread.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
}

/// Build and start the cpal input stream. Runs on the capture thread.
fn build_stream(app: AppHandle, shared: Arc<Mutex<Shared>>) -> Result<CaptureRuntime, String> {
    // On iOS the AVAudioSession must allow recording before cpal opens the
    // stream (no-op elsewhere); doing it per-start also recovers after an
    // interruption (phone call, Siri).
    crate::ios_audio::configure_session()?;
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no input device available")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("default input config: {e}"))?;
    let sample_rate = config.sample_rate().0 as f32;
    let channels = config.channels() as usize;

    let (sample_tx, sample_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(8);
    let worker_shared = shared.clone();
    let worker_app = app.clone();
    let worker = std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(FFT_SIZE * 2);
        let analyzer = Analyzer::new(sample_rate);
        let mut last_emit = Instant::now();
        while let Ok(chunk) = sample_rx.recv() {
            feed(&mut buf, &chunk);
            drain_and_emit(&buf, &analyzer, &worker_app, &worker_shared, &mut last_emit);
        }
    });

    let err_fn = |e| eprintln!("audio stream error: {e}");

    let stream_result = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                send_chunk(&sample_tx, downmix_f32(data, channels));
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _| {
                send_chunk(&sample_tx, downmix_i16(data, channels));
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.into(),
            move |data: &[u16], _| {
                send_chunk(&sample_tx, downmix_u16(data, channels));
            },
            err_fn,
            None,
        ),
        fmt => {
            drop(sample_tx);
            let _ = worker.join();
            return Err(format!("unsupported sample format: {fmt:?}"));
        }
    };
    let stream = match stream_result {
        Ok(stream) => stream,
        Err(e) => {
            let _ = worker.join();
            return Err(format!("build input stream: {e}"));
        }
    };

    if let Err(e) = stream.play() {
        drop(stream);
        let _ = worker.join();
        return Err(format!("stream play: {e}"));
    }
    Ok(CaptureRuntime {
        stream: Some(stream),
        worker: Some(worker),
    })
}

/// Append (downmixed-to-mono) samples to the rolling buffer.
fn feed(buf: &mut Vec<f32>, data: &[f32]) {
    buf.extend_from_slice(data);
    // Cap memory: keep at most 2 windows of history.
    let cap = FFT_SIZE * 2;
    if buf.len() > cap {
        let drop = buf.len() - cap;
        buf.drain(0..drop);
    }
}

fn send_chunk(tx: &std::sync::mpsc::SyncSender<Vec<f32>>, chunk: Vec<f32>) {
    match tx.try_send(chunk) {
        Ok(()) | Err(TrySendError::Full(_)) => {}
        Err(TrySendError::Disconnected(_)) => {}
    }
}

fn downmix_f32(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / channels as f32)
        .collect()
}

fn downmix_i16(data: &[i16], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.iter().map(|&s| s as f32 / 32768.0).collect();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / channels as f32)
        .collect()
}

fn downmix_u16(data: &[u16], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data
            .iter()
            .map(|&s| (s as f32 - 32768.0) / 32768.0)
            .collect();
    }
    data.chunks(channels)
        .map(|frame| {
            frame
                .iter()
                .map(|&s| (s as f32 - 32768.0) / 32768.0)
                .sum::<f32>()
                / channels as f32
        })
        .collect()
}

// Cap how often readings cross the IPC boundary. Analysis still runs on every
// window (so the chord chroma EMA keeps its per-window cadence); we only
// coalesce the emits to ~45/s — well above the 60fps UI's needs, but far below
// the audio callback rate, which otherwise serialized a full spectrum per chunk.
const MIN_EMIT_INTERVAL: Duration = Duration::from_millis(22);

/// When we have a full window, analyze it per the current mode and emit (rate-limited).
fn drain_and_emit(
    buf: &[f32],
    analyzer: &Analyzer,
    app: &AppHandle,
    shared: &Arc<Mutex<Shared>>,
    last_emit: &mut Instant,
) {
    if buf.len() < FFT_SIZE {
        return;
    }
    let window = &buf[buf.len() - FFT_SIZE..];
    let (mode, target, gate, tuning) = {
        let s = shared.lock().unwrap();
        (s.mode, s.target.clone(), s.gate, s.tuning)
    };
    let due = last_emit.elapsed() >= MIN_EMIT_INTERVAL;
    match mode {
        Mode::Tuner => {
            let reading = analyzer.analyze_tuner(window, gate, tuning);
            if due {
                *last_emit = Instant::now();
                let _ = app.emit("tuner", reading);
            }
        }
        Mode::Chord => {
            let reading = analyzer.analyze_chord(window, target.as_deref(), gate);
            if due {
                *last_emit = Instant::now();
                // The onset latch is released only once a reading carrying it has
                // been handed to the frontend; dropping this reading would
                // otherwise swallow the strum it was set for.
                analyzer.clear_onset();
                let _ = app.emit("chord", reading);
            }
        }
    }
}

/// Reusable FFT + pitch/chord analysis.
struct Analyzer {
    sample_rate: f32,
    fft: Arc<dyn rustfft::Fft<f32>>,
    hann: Vec<f32>,
    book: ChordBook,
    /// Exponentially-smoothed chroma, so a quiet note (e.g. Am's C string)
    /// accumulates across frames instead of being judged on one instant.
    smooth: Mutex<[f32; 12]>,
    /// Reusable FFT scratch (length FFT_SIZE), so each window doesn't allocate a
    /// fresh complex buffer. Single capture thread, so contention is nil.
    scratch: Mutex<Vec<Complex<f32>>>,
    /// Onset detector state: previous window's magnitudes, the slow flux
    /// baseline, when the last onset fired (refractory gate), and the latch that
    /// carries an onset across coalesced emits.
    onset: Mutex<OnsetState>,
}

struct OnsetState {
    prev_mag: Vec<f32>,
    baseline: f32,
    last_onset: Option<Instant>,
    /// Set when an attack is detected, cleared when a reading carrying it is
    /// actually emitted (see `Analyzer::clear_onset`).
    latched: bool,
    /// Last computed flux ratio, reported for diagnostics.
    ratio: f32,
}

const CHROMA_SMOOTH: f32 = 0.4; // EMA weight for the newest frame

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
            smooth: Mutex::new([0.0; 12]),
            scratch: Mutex::new(vec![Complex::new(0.0, 0.0); FFT_SIZE]),
            onset: Mutex::new(OnsetState {
                prev_mag: vec![0.0; FFT_SIZE / 2],
                baseline: 0.0,
                last_onset: None,
                latched: false,
                ratio: 0.0,
            }),
        }
    }

    /// Bin range of the chord band, shared by `chroma` and the onset detector so
    /// both judge the same frequencies.
    fn chroma_bins(&self, len: usize) -> (usize, usize) {
        let bin_hz = self.sample_rate / FFT_SIZE as f32;
        let lo = (CHROMA_FMIN / bin_hz).floor().max(1.0) as usize;
        let hi = ((CHROMA_FMAX / bin_hz).ceil() as usize).min(len);
        (lo, hi)
    }

    /// Update the onset detector from this window's magnitudes. Returns
    /// (latched_onset, flux_ratio).
    ///
    /// `now` is passed in rather than read here so the tests can drive the
    /// refractory gate deterministically.
    fn track_onset(&self, mag: &[f32], now: Instant) -> (bool, f32) {
        let (lo, hi) = self.chroma_bins(mag.len());
        let mut st = self.onset.lock().unwrap();
        let flux: f32 = (lo..hi)
            .map(|i| (mag[i] - st.prev_mag[i]).max(0.0))
            .sum::<f32>();
        st.prev_mag[..mag.len()].copy_from_slice(mag);

        // Ratio against the slow baseline. Until the baseline has any energy at
        // all (first windows, or after silence) there is nothing to compare
        // against, so report a steady state rather than firing on the ramp-up.
        let ratio = if st.baseline > 1e-6 {
            flux / st.baseline
        } else {
            0.0
        };
        st.ratio = ratio;

        let clear_of_refractory = st
            .last_onset
            .is_none_or(|t| now.duration_since(t) >= ONSET_REFRACTORY);
        if ratio >= ONSET_RATIO && clear_of_refractory {
            st.last_onset = Some(now);
            st.latched = true;
        }

        // Baseline tracks flux *after* the decision, so a strum doesn't raise the
        // bar it was just measured against.
        st.baseline = FLUX_SMOOTH * flux + (1.0 - FLUX_SMOOTH) * st.baseline;
        (st.latched, ratio)
    }

    /// Clear the onset latch — called once a reading carrying it has been emitted.
    fn clear_onset(&self) {
        self.onset.lock().unwrap().latched = false;
    }

    /// Forget onset history (on silence): the next note is a fresh attack, and a
    /// stale baseline from before the gap would mis-scale it.
    fn reset_onset(&self) {
        let mut st = self.onset.lock().unwrap();
        st.prev_mag.iter_mut().for_each(|m| *m = 0.0);
        st.baseline = 0.0;
        st.last_onset = None;
        st.latched = false;
        st.ratio = 0.0;
    }

    /// Windowed FFT magnitudes + mean-removed RMS.
    fn spectrum(&self, samples: &[f32]) -> (Vec<f32>, f32) {
        let mean = samples.iter().copied().sum::<f32>() / samples.len() as f32;
        let rms =
            (samples.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / samples.len() as f32).sqrt();
        let mut buf = self.scratch.lock().unwrap();
        for (slot, (&s, &w)) in buf.iter_mut().zip(samples.iter().zip(&self.hann)) {
            *slot = Complex::new((s - mean) * w, 0.0);
        }
        self.fft.process(&mut buf);
        let mag = buf[..FFT_SIZE / 2].iter().map(|c| c.norm()).collect();
        (mag, rms)
    }

    /// 12-bin chroma with spectral-leakage suppression (see detection tuning).
    fn chroma(&self, mag: &[f32]) -> [f32; 12] {
        let bin_hz = self.sample_rate / FFT_SIZE as f32;
        let mut chroma = [0.0f32; 12];
        let (lo, hi) = self.chroma_bins(mag.len());
        for (i, &magnitude) in mag.iter().enumerate().take(hi).skip(lo) {
            let f = i as f32 * bin_hz;
            let midi = 69.0 + 12.0 * (f / 440.0).log2();
            let nearest = midi.round();
            let cents = (midi - nearest).abs();
            // suppress leakage skirts: cos(pi*cents)^2, like the Python engine
            let w = (std::f32::consts::PI * cents).cos().max(0.0).powi(2);
            let pc = ((nearest as i32) % 12 + 12) % 12;
            chroma[pc as usize] += magnitude * w;
        }
        let norm = (chroma.iter().map(|x| x * x).sum::<f32>()).sqrt();
        if norm > 0.0 {
            for x in chroma.iter_mut() {
                *x /= norm;
            }
        }
        chroma
    }

    /// Bin the spectrum into `n` log-spaced bands over the chroma range,
    /// normalized 0..1 — for the horizontal FFT display.
    fn log_spectrum(&self, mag: &[f32], n: usize) -> Vec<f32> {
        let bin_hz = self.sample_rate / FFT_SIZE as f32;
        let (fmin, fmax) = (70.0f32, 2000.0f32);
        let ratio = (fmax / fmin).powf(1.0 / n as f32);
        let mut out = vec![0.0f32; n];
        for (k, band) in out.iter_mut().enumerate() {
            let lo_f = fmin * ratio.powi(k as i32);
            let hi_f = fmin * ratio.powi(k as i32 + 1);
            let lo = (lo_f / bin_hz).floor() as usize;
            let hi = ((hi_f / bin_hz).ceil() as usize).min(mag.len());
            let mut peak = 0.0f32;
            for &magnitude in mag.iter().take(hi).skip(lo) {
                if magnitude > peak {
                    peak = magnitude;
                }
            }
            *band = peak;
        }
        let max = out.iter().cloned().fold(0.0f32, f32::max);
        if max > 0.0 {
            for x in out.iter_mut() {
                *x /= max;
            }
        }
        out
    }

    fn analyze_chord(&self, samples: &[f32], target: Option<&[usize]>, gate: f32) -> ChordReading {
        let (mag, rms) = self.spectrum(samples);
        if rms < gate {
            *self.smooth.lock().unwrap() = [0.0; 12]; // reset on silence
            self.reset_onset();
            return ChordReading {
                active: false,
                detected: String::new(),
                cleanliness: 0.0,
                chroma: [0.0; 12],
                spectrum: vec![0.0; 96],
                missing: vec![],
                extra: vec![],
                rms,
                onset: false,
                flux: 0.0,
            };
        }
        let (onset, flux) = self.track_onset(&mag, Instant::now());
        let raw = self.chroma(&mag);

        // Exponential moving average so a quiet third (e.g. Am's C) builds up
        // over the strum rather than flickering to a power chord on one frame.
        let chroma = {
            let mut s = self.smooth.lock().unwrap();
            for k in 0..12 {
                s[k] = CHROMA_SMOOTH * raw[k] + (1.0 - CHROMA_SMOOTH) * s[k];
            }
            let norm = (s.iter().map(|x| x * x).sum::<f32>()).sqrt();
            let mut c = *s;
            if norm > 0.0 {
                for x in c.iter_mut() {
                    *x /= norm;
                }
            }
            c
        };

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
            spectrum: self.log_spectrum(&mag, 96),
            missing,
            extra,
            rms,
            onset,
            flux,
        }
    }

    fn analyze_tuner(&self, samples: &[f32], gate: f32, tuning: Tuning) -> TunerReading {
        // RMS for the silence gate / level meter.
        let mean = samples.iter().copied().sum::<f32>() / samples.len() as f32;
        let rms =
            (samples.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / samples.len() as f32).sqrt();

        if rms < gate {
            return TunerReading {
                active: false,
                freq: 0.0,
                nearest: String::new(),
                cents: 0.0,
                rms,
            };
        }

        // Windowed FFT (reusing the shared scratch buffer).
        let mut buf = self.scratch.lock().unwrap();
        for (slot, (&s, &w)) in buf.iter_mut().zip(samples.iter().zip(&self.hann)) {
            *slot = Complex::new((s - mean) * w, 0.0);
        }
        self.fft.process(&mut buf);

        let bin_hz = self.sample_rate / FFT_SIZE as f32;
        let lo = (FMIN / bin_hz).floor() as usize;
        let hi = ((FMAX / bin_hz).ceil() as usize).min(FFT_SIZE / 2);

        // Find the strongest bin in range.
        let mut peak_i = lo;
        let mut peak_mag = 0.0_f32;
        for (i, sample) in buf.iter().enumerate().take(hi).skip(lo) {
            let m = sample.norm();
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

        let (nearest, cents) = nearest_string(freq, tuning);
        TunerReading {
            active: true,
            freq,
            nearest: nearest.to_string(),
            cents,
            rms,
        }
    }
}

/// Snap a frequency to the nearest open string of `tuning`; return (name, cents).
fn nearest_string(freq: f32, tuning: Tuning) -> (&'static str, f32) {
    let strings = tuning.strings();
    let mut best = strings[0];
    let mut best_cents = f32::MAX;
    for &(name, f0) in strings {
        let cents = 1200.0 * (freq / f0).log2();
        if cents.abs() < best_cents.abs() {
            best_cents = cents;
            best = (name, f0);
        }
    }
    (best.0, best_cents)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pure sine at `hz`, one FFT window long.
    fn sine(hz: f32) -> Vec<f32> {
        sine_amp(hz, 0.25)
    }

    /// A pure sine at `hz` and the given amplitude, one FFT window long.
    fn sine_amp(hz: f32, amp: f32) -> Vec<f32> {
        (0..FFT_SIZE)
            .map(|n| {
                let t = n as f32 / 44_100.0;
                (2.0 * std::f32::consts::PI * hz * t).sin() * amp
            })
            .collect()
    }

    /// Feed a window through the onset detector at a given virtual time.
    fn onset_at(analyzer: &Analyzer, samples: &[f32], at: Instant) -> bool {
        let (mag, _) = analyzer.spectrum(samples);
        let (latched, _) = analyzer.track_onset(&mag, at);
        analyzer.clear_onset(); // one "emit" per window in these tests
        latched
    }

    #[test]
    fn nearest_string_reports_zero_cents_on_open_strings() {
        let (name, cents) = nearest_string(196.0, Tuning::Baritone);
        assert_eq!(name, "G3");
        assert!(cents.abs() < 0.01);

        let (name, cents) = nearest_string(261.63, Tuning::Standard);
        assert_eq!(name, "C4");
        assert!(cents.abs() < 0.01);
    }

    /// The same pitch must snap to different strings per tuning — 392 Hz is
    /// standard's open 4th, but on a baritone it is nothing (nearest is E4).
    #[test]
    fn nearest_string_follows_the_tuning() {
        assert_eq!(nearest_string(392.0, Tuning::Standard).0, "G4");
        assert_eq!(nearest_string(392.0, Tuning::Baritone).0, "E4");
    }

    #[test]
    fn tuner_detects_synthetic_g3() {
        let analyzer = Analyzer::new(44_100.0);
        let reading = analyzer.analyze_tuner(&sine(196.0), 0.001, Tuning::Baritone);
        assert!(reading.active);
        assert_eq!(reading.nearest, "G3");
        assert!(reading.cents.abs() < 5.0, "cents={}", reading.cents);
    }

    #[test]
    fn tuner_detects_synthetic_a4_in_standard_tuning() {
        let analyzer = Analyzer::new(44_100.0);
        let reading = analyzer.analyze_tuner(&sine(440.0), 0.001, Tuning::Standard);
        assert!(reading.active);
        assert_eq!(reading.nearest, "A4");
        assert!(reading.cents.abs() < 5.0, "cents={}", reading.cents);
    }

    /// A held tone is not a strum: after the note has settled, the flux baseline
    /// catches up and no further onsets fire.
    #[test]
    fn sustained_tone_fires_at_most_one_onset() {
        let analyzer = Analyzer::new(44_100.0);
        let tone = sine(261.63);
        let t0 = Instant::now();
        // Windows are ~186ms of audio at 8192/44.1k, so space them well past the
        // refractory period — any onset here is the detector's own decision.
        let onsets = (0..12)
            .filter(|i| onset_at(&analyzer, &tone, t0 + Duration::from_millis(200 * i)))
            .count();
        assert!(onsets <= 1, "steady tone produced {onsets} onsets");
    }

    /// The case the feature exists for: a new attack over an already-sounding
    /// note. A second, louder note entering must register even though the first
    /// one never stopped — this is what RMS alone would miss.
    #[test]
    fn new_attack_over_a_sounding_note_fires_an_onset() {
        let analyzer = Analyzer::new(44_100.0);
        let held = sine_amp(261.63, 0.25);
        let t0 = Instant::now();
        // Let the baseline settle on the held note.
        for i in 0..8 {
            onset_at(&analyzer, &held, t0 + Duration::from_millis(200 * i));
        }
        // Now strum: the C keeps ringing and an E joins it.
        let strum: Vec<f32> = held
            .iter()
            .zip(sine_amp(329.63, 0.3).iter())
            .map(|(a, b)| a + b)
            .collect();
        assert!(onset_at(
            &analyzer,
            &strum,
            t0 + Duration::from_millis(1600)
        ));
    }

    /// Two windows in quick succession are one strum, not two: the refractory
    /// gate suppresses the second. Without it a single strum's attack spans
    /// several overlapping windows and would be counted repeatedly.
    #[test]
    fn refractory_period_collapses_one_strum_into_one_onset() {
        let analyzer = Analyzer::new(44_100.0);
        let quiet = sine_amp(261.63, 0.02);
        let t0 = Instant::now();
        for i in 0..8 {
            onset_at(&analyzer, &quiet, t0 + Duration::from_millis(200 * i));
        }
        let loud = sine_amp(261.63, 0.5);
        let first = onset_at(&analyzer, &loud, t0 + Duration::from_millis(1600));
        // 20ms later — inside ONSET_REFRACTORY (60ms).
        let second = onset_at(&analyzer, &loud, t0 + Duration::from_millis(1620));
        assert!(first, "expected the attack to register");
        assert!(!second, "refractory period should have suppressed this");
    }

    /// Silence resets the detector, so the first note after a gap is an attack
    /// rather than being scaled against a stale baseline.
    #[test]
    fn silence_resets_the_onset_detector() {
        let analyzer = Analyzer::new(44_100.0);
        let tone = sine(261.63);
        for _ in 0..8 {
            analyzer.analyze_chord(&tone, None, 0.001);
        }
        // Below the gate: this is the silence path.
        let silent = analyzer.analyze_chord(&sine_amp(261.63, 0.0001), None, 0.01);
        assert!(!silent.active);
        assert!(!silent.onset);
        assert_eq!(silent.flux, 0.0);

        let st = analyzer.onset.lock().unwrap();
        assert_eq!(st.baseline, 0.0);
        assert!(st.last_onset.is_none());
    }

    /// A string 30 cents flat should still identify as that string, and report
    /// the offset — that is the whole job of the tuner.
    #[test]
    fn tuner_reports_flat_string_as_negative_cents() {
        let analyzer = Analyzer::new(44_100.0);
        let flat = 261.63 * 2f32.powf(-30.0 / 1200.0);
        let reading = analyzer.analyze_tuner(&sine(flat), 0.001, Tuning::Standard);
        assert_eq!(reading.nearest, "C4");
        assert!(
            (reading.cents + 30.0).abs() < 5.0,
            "expected ~-30 cents, got {}",
            reading.cents
        );
    }
}
