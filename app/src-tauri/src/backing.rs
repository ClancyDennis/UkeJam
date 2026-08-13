//! Backing-track playback: render an imported MIDI through a bundled SoundFont
//! (rustysynth) to a cpal *output* stream, so the player hears the real band
//! while the chord highway scrolls.
//!
//! Mirrors the capture side's threading: a cpal `Stream` is `!Send` on macOS,
//! so the output stream is built, owned, and dropped on a dedicated thread.
//! That thread pulls rendered stereo samples from a shared `MidiFileSequencer`.
//! The frontend ships the MIDI bytes (load_backing); we keep the sequencer
//! behind a mutex so play/pause/seek/mute mutate it between render calls.

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustysynth::{MidiFile, MidiFileSequencer, SoundFont, Synthesizer, SynthesizerSettings};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::soundfont;

// Returned to the frontend (as an Err string) when no SoundFont is installed
// yet, so it can show the install/download panel instead of a raw error.
pub const NO_SOUNDFONT: &str = "no-soundfont";

const OUT_SAMPLE_RATE: i32 = 44100;
const BLOCK: usize = 1024; // samples per render block per channel
const MAX_VLQ: u64 = 0x0FFF_FFFF;

#[derive(Serialize, Clone)]
pub struct BackingStatus {
    pub playing: bool,
    pub pos: f64,    // samples RENDERED so far, in seconds (leads the speaker)
    pub length: f64, // total length in seconds
    pub loaded: bool,
    // Output pipeline latency in seconds (cpal's playback-vs-callback
    // timestamp gap): how far `pos` runs ahead of what is audible right now.
    // The frontend subtracts this so the highway playhead tracks the sound,
    // not the render cursor. 0.0 when the host can't report it.
    pub latency: f64,
}

/// The synthesizer + sequencer + loaded song, shared with the output thread.
struct Engine {
    sequencer: MidiFileSequencer,
    sample_rate: f64,
    length: f64, // seconds (0 if nothing loaded)
    pos: f64,    // seconds rendered so far
    playing: bool,
    loaded: bool,
    looping: bool,
    latency: f64, // last measured output latency in seconds (see BackingStatus)
    midi: Option<Arc<MidiFile>>, // kept so the synth can rebuild at device rate
    raw: Option<Arc<Vec<u8>>>, // original (unfiltered) MIDI, for re-filtering channels
}

pub struct BackingState {
    running: Arc<AtomicBool>,
    // Both are lazily initialized: an `Engine` can't be built without a
    // SoundFont, and we no longer bundle one. `ensure_ready` resolves a
    // SoundFont from disk on first use and builds the engine then.
    engine: Arc<Mutex<Option<Engine>>>,
    sound_font: Mutex<Option<Arc<SoundFont>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Default for BackingState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            engine: Arc::new(Mutex::new(None)),
            sound_font: Mutex::new(None),
            thread: Mutex::new(None),
        }
    }
}

fn new_engine(sound_font: &Arc<SoundFont>, sample_rate: f64) -> Engine {
    let settings = SynthesizerSettings::new(sample_rate as i32);
    let synth = Synthesizer::new(sound_font, &settings).expect("synth init");
    Engine {
        sequencer: MidiFileSequencer::new(synth),
        sample_rate,
        length: 0.0,
        pos: 0.0,
        playing: false,
        loaded: false,
        looping: true,
        latency: 0.0,
        midi: None,
        raw: None,
    }
}

/// Filter the raw MIDI to `allowed` channels (or keep all) and parse it.
fn parse_filtered(raw: &[u8], allowed: Option<&[u8]>) -> Result<Arc<MidiFile>, String> {
    let bytes = match allowed {
        Some(chs) => filter_channels(raw, chs)?,
        None => raw.to_vec(),
    };
    MidiFile::new(&mut Cursor::new(bytes))
        .map(Arc::new)
        .map_err(|e| format!("parse midi: {e}"))
}

/// Build a fresh sequencer for `midi` at `rate`, silently fast-forwarded to
/// `pos` seconds. Allocates and renders entirely on the caller's stack — it
/// touches no shared state, so callers run it WITHOUT holding the engine lock
/// (the long fast-forward render must not block the audio callback).
fn build_seq_at(
    sound_font: &Arc<SoundFont>,
    midi: &Arc<MidiFile>,
    rate: f64,
    looping: bool,
    pos: f64,
) -> MidiFileSequencer {
    let settings = SynthesizerSettings::new(rate as i32);
    let synth = Synthesizer::new(sound_font, &settings).expect("synth init");
    let mut seq = MidiFileSequencer::new(synth);
    seq.play(midi, looping);
    if pos > 0.0 {
        let frames = (pos * rate) as usize;
        let mut scratch_l = vec![0f32; frames.min(rate as usize * 2).max(1)];
        let mut scratch_r = vec![0f32; scratch_l.len()];
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(scratch_l.len());
            seq.render(&mut scratch_l[..n], &mut scratch_r[..n]);
            done += n;
        }
    }
    seq
}

impl BackingState {
    /// Lazily resolve + load a SoundFont from disk and build the engine. Returns
    /// the loaded SoundFont (cloned `Arc`) so callers can rebuild sequencers.
    /// Errors with `NO_SOUNDFONT` when the user hasn't installed one yet (the
    /// frontend keys on this to show the install panel). Safe to call repeatedly
    /// — a SoundFont downloaded after startup is picked up with no restart.
    fn ensure_ready(&self, app: &AppHandle) -> Result<Arc<SoundFont>, String> {
        let sf = {
            let mut guard = self.sound_font.lock().unwrap();
            if guard.is_none() {
                let path = soundfont::resolve_path(app).ok_or(NO_SOUNDFONT)?;
                let bytes = std::fs::read(&path).map_err(|e| format!("read soundfont: {e}"))?;
                let sf = SoundFont::new(&mut Cursor::new(bytes))
                    .map_err(|e| format!("invalid soundfont: {e}"))?;
                *guard = Some(Arc::new(sf));
            }
            guard.as_ref().unwrap().clone()
        };
        let mut eng = self.engine.lock().unwrap();
        if eng.is_none() {
            *eng = Some(new_engine(&sf, OUT_SAMPLE_RATE as f64));
        }
        Ok(sf)
    }

    /// Parse MIDI bytes and arm the sequencer (paused at the start). When
    /// `allowed` is Some, only voice events on those channels (0..15) are kept
    /// — e.g. bass + drums for a play-along where the user plays the rest.
    pub fn load(
        &self,
        app: &AppHandle,
        bytes: Vec<u8>,
        allowed: Option<Vec<u8>>,
    ) -> Result<f64, String> {
        self.ensure_ready(app)?;
        let raw = Arc::new(bytes);
        let midi = parse_filtered(&raw, allowed.as_deref())?;
        let length = midi.get_length();
        let mut guard = self.engine.lock().unwrap();
        let eng = guard.as_mut().unwrap();
        let looping = eng.looping;
        eng.sequencer.play(&midi, looping); // arm at the start (pos 0)
        eng.length = length;
        eng.pos = 0.0;
        eng.playing = false;
        eng.loaded = true;
        eng.midi = Some(midi);
        eng.raw = Some(raw);
        Ok(length)
    }

    /// Re-filter the already-loaded MIDI to a new set of channels WITHOUT the
    /// frontend resending the file, preserving the current position and play
    /// state. Used by the track picker so toggling an instrument is cheap and
    /// doesn't restart the song.
    pub fn set_channels(&self, app: &AppHandle, allowed: Option<Vec<u8>>) -> Result<f64, String> {
        let sf = self.ensure_ready(app)?;
        // snapshot what we need, then build the new sequencer off-lock
        let (raw, rate, pos, looping) = {
            let guard = self.engine.lock().unwrap();
            let eng = guard.as_ref().unwrap();
            match &eng.raw {
                Some(raw) => (raw.clone(), eng.sample_rate, eng.pos, eng.looping),
                None => return Err("no backing track loaded".into()),
            }
        };
        let midi = parse_filtered(&raw, allowed.as_deref())?;
        let length = midi.get_length();
        let seq = build_seq_at(&sf, &midi, rate, looping, pos);
        let mut guard = self.engine.lock().unwrap();
        let eng = guard.as_mut().unwrap();
        eng.sequencer = seq;
        eng.midi = Some(midi);
        eng.length = length;
        eng.loaded = true;
        // keep eng.pos and eng.playing as-is so playback continues seamlessly
        Ok(length)
    }

    /// Rebuild the synth/sequencer at a new sample rate (the output device may
    /// be 48kHz while the synth defaulted to 44.1kHz — without this, playback
    /// would be ~9% sharp/fast). Re-arms the current MIDI at the saved position.
    fn ensure_rate(&self, rate: f64) {
        // Requires a loaded SoundFont + engine (callers run after ensure_ready).
        let sf = match self.sound_font.lock().unwrap().clone() {
            Some(sf) => sf,
            None => return,
        };
        // snapshot under the lock; the (potentially long) fast-forward render
        // then runs OFF-lock so it never blocks the audio callback.
        let (midi, pos, looping, was_playing) = {
            let guard = self.engine.lock().unwrap();
            let eng = match guard.as_ref() {
                Some(eng) => eng,
                None => return,
            };
            if (eng.sample_rate - rate).abs() < 0.5 {
                return;
            }
            (eng.midi.clone(), eng.pos, eng.looping, eng.playing)
        };
        match midi {
            Some(midi) => {
                let seq = build_seq_at(&sf, &midi, rate, looping, pos);
                let mut guard = self.engine.lock().unwrap();
                let eng = guard.as_mut().unwrap();
                eng.sequencer = seq;
                eng.sample_rate = rate;
                eng.pos = pos;
                eng.playing = was_playing;
            }
            None => {
                // nothing loaded — just retune the empty sequencer for next load
                let settings = SynthesizerSettings::new(rate as i32);
                let synth = Synthesizer::new(&sf, &settings).expect("synth init");
                let mut guard = self.engine.lock().unwrap();
                let eng = guard.as_mut().unwrap();
                eng.sequencer = MidiFileSequencer::new(synth);
                eng.sample_rate = rate;
            }
        }
    }

    /// Start the output stream (if not already) and begin playing.
    pub fn play(&self, app: AppHandle) -> Result<(), String> {
        self.ensure_ready(&app)?;
        {
            let guard = self.engine.lock().unwrap();
            if !guard.as_ref().unwrap().loaded {
                return Err("no backing track loaded".into());
            }
        }
        // Match the synth to the output device's sample rate before playing.
        if let Some(dev) = cpal::default_host().default_output_device() {
            if let Ok(cfg) = dev.default_output_config() {
                self.ensure_rate(cfg.sample_rate().0 as f64);
            }
        }
        self.engine.lock().unwrap().as_mut().unwrap().playing = true;
        let mut thread = self.thread.lock().unwrap();
        if thread.is_some() {
            return Ok(()); // stream already running; playing flag set above
        }
        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();
        let engine = self.engine.clone();

        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let handle = std::thread::spawn(move || match build_output(engine, app) {
            Ok(stream) => {
                let _ = tx.send(Ok(()));
                while running.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(80));
                }
                drop(stream);
            }
            Err(e) => {
                running.store(false, Ordering::SeqCst);
                let _ = tx.send(Err(e));
            }
        });
        match rx
            .recv()
            .unwrap_or_else(|_| Err("output thread died".into()))
        {
            Ok(()) => {
                *thread = Some(handle);
                Ok(())
            }
            Err(e) => {
                let _ = handle.join();
                if let Some(eng) = self.engine.lock().unwrap().as_mut() {
                    eng.playing = false;
                }
                Err(e)
            }
        }
    }

    /// Pause without tearing down the stream (so resume is instant).
    pub fn pause(&self) {
        if let Some(eng) = self.engine.lock().unwrap().as_mut() {
            eng.playing = false;
        }
    }

    /// Stop playback and tear down the output stream; keep the loaded song.
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.thread.lock().unwrap().take() {
            let _ = handle.join();
        }
        if let Some(eng) = self.engine.lock().unwrap().as_mut() {
            eng.playing = false;
        }
    }

    pub fn set_looping(&self, looping: bool) {
        if let Some(eng) = self.engine.lock().unwrap().as_mut() {
            eng.looping = looping;
        }
    }

    pub fn status(&self) -> BackingStatus {
        match self.engine.lock().unwrap().as_ref() {
            Some(eng) => BackingStatus {
                playing: eng.playing,
                pos: eng.pos,
                length: eng.length,
                loaded: eng.loaded,
                latency: eng.latency,
            },
            None => BackingStatus {
                playing: false,
                pos: 0.0,
                length: 0.0,
                loaded: false,
                latency: 0.0,
            },
        }
    }
}

/// Rewrite a Standard MIDI File keeping only channel-voice events on the
/// `allowed` channels (0..15); tempo/time-sig/track-name/all meta + sysex are
/// always kept. Delta-times of dropped events are folded into the next kept
/// event so timing is preserved.
fn filter_channels(data: &[u8], allowed: &[u8]) -> Result<Vec<u8>, String> {
    let allow: [bool; 16] = {
        let mut a = [false; 16];
        for &c in allowed {
            if c < 16 {
                a[c as usize] = true;
            }
        }
        a
    };
    if data.len() < 14 || &data[0..4] != b"MThd" {
        return Err("invalid midi header".into());
    }
    let header_len = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
    if header_len != 6 {
        return Err(format!("unsupported midi header length {header_len}"));
    }
    let ntrk = u16::from_be_bytes([data[10], data[11]]) as usize;
    let mut out: Vec<u8> = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[0..14]); // header chunk verbatim

    let mut i = 14usize;
    for _ in 0..ntrk {
        if i + 8 > data.len() || &data[i..i + 4] != b"MTrk" {
            return Err("missing midi track chunk".into());
        }
        let tlen =
            u32::from_be_bytes([data[i + 4], data[i + 5], data[i + 6], data[i + 7]]) as usize;
        let end = i
            .checked_add(8)
            .and_then(|n| n.checked_add(tlen))
            .ok_or("midi track length overflow")?;
        if end > data.len() {
            return Err("truncated midi track".into());
        }
        let mut j = i + 8;
        let mut status = 0u8;
        let mut pending_dt: u64 = 0; // accumulated delta from dropped events
        let mut body: Vec<u8> = Vec::with_capacity(tlen);

        while j < end {
            // read delta-time (vlq)
            let (dt, nj) = read_vlq(data, j)?;
            j = nj;
            let mut b = *data.get(j).ok_or("missing midi event status")?;
            let mut keep = true;
            let mut event: Vec<u8> = Vec::new();

            if b & 0x80 != 0 {
                status = b;
                j += 1;
            } else if status == 0 {
                return Err("running status before status byte".into());
            } else {
                b = status; // running status
            }

            if b == 0xFF {
                // meta: FF type len data — always keep
                let mtype = *data.get(j).ok_or("missing midi meta type")?;
                j += 1;
                let (len, nj) = read_vlq(data, j)?;
                j = nj;
                event.push(0xFF);
                event.push(mtype);
                push_vlq(&mut event, len)?;
                let len = len as usize;
                event.extend_from_slice(data.get(j..j + len).ok_or("truncated midi meta event")?);
                j += len;
            } else if b == 0xF0 || b == 0xF7 {
                let (len, nj) = read_vlq(data, j)?;
                j = nj;
                event.push(b);
                push_vlq(&mut event, len)?;
                let len = len as usize;
                event.extend_from_slice(data.get(j..j + len).ok_or("truncated midi sysex event")?);
                j += len;
            } else {
                let hi = b & 0xF0;
                let ch = b & 0x0F;
                let nbytes = match hi {
                    0x80 | 0x90 | 0xA0 | 0xB0 | 0xE0 => 2,
                    0xC0 | 0xD0 => 1,
                    _ => return Err(format!("unsupported midi event status 0x{b:02X}")),
                };
                keep = allow[ch as usize];
                // reconstruct with explicit status (drop running-status ambiguity)
                event.push(b);
                event.extend_from_slice(
                    data.get(j..j + nbytes)
                        .ok_or("truncated midi channel event")?,
                );
                j += nbytes;
            }

            if keep {
                let total_dt = pending_dt
                    .checked_add(dt)
                    .ok_or("midi delta-time overflow")?;
                push_vlq(&mut body, total_dt)?;
                pending_dt = 0;
                body.extend_from_slice(&event);
            } else {
                pending_dt = pending_dt
                    .checked_add(dt)
                    .ok_or("midi delta-time overflow")?; // carry the time forward
                if pending_dt > MAX_VLQ {
                    return Err("midi delta-time too large after channel filtering".into());
                }
            }
        }

        if body.len() > u32::MAX as usize {
            return Err("filtered midi track too large".into());
        }
        out.extend_from_slice(b"MTrk");
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        i = end;
    }
    Ok(out)
}

fn read_vlq(d: &[u8], mut i: usize) -> Result<(u64, usize), String> {
    let mut v: u64 = 0;
    for _ in 0..4 {
        let b = *d.get(i).ok_or("truncated midi vlq")?;
        i += 1;
        v = (v << 7) | (b & 0x7f) as u64;
        if b & 0x80 == 0 {
            return Ok((v, i));
        }
    }
    Err("midi vlq is longer than 4 bytes".into())
}

fn push_vlq(out: &mut Vec<u8>, mut v: u64) -> Result<(), String> {
    if v > MAX_VLQ {
        return Err("midi vlq value is too large".into());
    }
    let mut buf = [0u8; 4];
    let mut n = 0;
    buf[n] = (v & 0x7f) as u8;
    n += 1;
    v >>= 7;
    while v > 0 {
        buf[n] = ((v & 0x7f) as u8) | 0x80;
        n += 1;
        v >>= 7;
    }
    // buf holds the bytes least-significant first with continuation bits set on
    // all but the first; emit most-significant first
    for k in (0..n).rev() {
        out.push(buf[k]);
    }
    Ok(())
}

/// Build the cpal output stream; runs on the dedicated playback thread.
fn build_output(engine: Arc<Mutex<Option<Engine>>>, app: AppHandle) -> Result<cpal::Stream, String> {
    // iOS: route playback to the speaker (not the earpiece) and keep the
    // session valid alongside mic capture; no-op on desktop.
    crate::ios_audio::configure_session()?;
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no output device available")?;
    let config = device
        .default_output_config()
        .map_err(|e| format!("default output config: {e}"))?;
    let out_channels = config.channels() as usize;

    // Scratch buffers reused across callbacks.
    let mut left = vec![0f32; BLOCK];
    let mut right = vec![0f32; BLOCK];
    let app_cb = app.clone();
    let eng_cb = engine.clone();
    let mut emit = EmitState::new(); // for throttling status emits

    let err_fn = |e| eprintln!("backing output error: {e}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &config.into(),
            move |out: &mut [f32], info| {
                fill_output(
                    out,
                    out_channels,
                    &mut left,
                    &mut right,
                    &eng_cb,
                    &app_cb,
                    &mut emit,
                    output_latency(info),
                );
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => {
            let mut mix = Vec::<f32>::new();
            device.build_output_stream(
                &config.into(),
                move |out: &mut [i16], info| {
                    if mix.len() < out.len() {
                        mix.resize(out.len(), 0.0);
                    }
                    fill_output(
                        &mut mix[..out.len()],
                        out_channels,
                        &mut left,
                        &mut right,
                        &eng_cb,
                        &app_cb,
                        &mut emit,
                        output_latency(info),
                    );
                    for (dst, src) in out.iter_mut().zip(&mix) {
                        *dst = f32_to_i16(*src);
                    }
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let mut mix = Vec::<f32>::new();
            device.build_output_stream(
                &config.into(),
                move |out: &mut [u16], info| {
                    if mix.len() < out.len() {
                        mix.resize(out.len(), 0.0);
                    }
                    fill_output(
                        &mut mix[..out.len()],
                        out_channels,
                        &mut left,
                        &mut right,
                        &eng_cb,
                        &app_cb,
                        &mut emit,
                        output_latency(info),
                    );
                    for (dst, src) in out.iter_mut().zip(&mix) {
                        *dst = f32_to_u16(*src);
                    }
                },
                err_fn,
                None,
            )
        }
        fmt => return Err(format!("unsupported output sample format: {fmt:?}")),
    }
    .map_err(|e| format!("build output stream: {e}"))?;

    stream.play().map_err(|e| format!("output play: {e}"))?;
    Ok(stream)
}

/// How far the frontend playhead may drift before a fresh position event is
/// worth an IPC round-trip. The frontend dead-reckons between events, so this
/// only bounds how long a rate mismatch can accumulate.
const EMIT_INTERVAL_SECS: f64 = 0.05;

/// Per-stream state for throttling `backing` status emits.
struct EmitState {
    last_pos: f64,
    last_playing: bool,
}

impl EmitState {
    fn new() -> Self {
        Self {
            // forces an emit on the first playing callback
            last_pos: f64::NEG_INFINITY,
            last_playing: false,
        }
    }
}

/// The gap between "this callback is running" and "these samples reach the
/// speaker", per cpal's stream timestamps. None/zero on hosts that don't
/// report it — the frontend then simply gets no latency compensation.
fn output_latency(info: &cpal::OutputCallbackInfo) -> f64 {
    let ts = info.timestamp();
    ts.playback
        .duration_since(&ts.callback)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// Render synth audio into the device output buffer, honoring play/pause.
fn fill_output(
    out: &mut [f32],
    channels: usize,
    left: &mut [f32],
    right: &mut [f32],
    engine: &Arc<Mutex<Option<Engine>>>,
    app: &AppHandle,
    emit: &mut EmitState,
    latency: f64,
) {
    let frames = out.len() / channels.max(1);
    let mut written = 0;
    let mut pos_secs = 0.0;
    let mut playing;
    let mut hit_end = false;
    while written < frames {
        let n = (frames - written).min(left.len());
        {
            let mut guard = engine.lock().unwrap();
            // The stream is only built after the engine exists; if it somehow
            // vanished, render silence rather than panic.
            let Some(eng) = guard.as_mut() else {
                for s in out.iter_mut() {
                    *s = 0.0;
                }
                return;
            };
            playing = eng.playing && eng.loaded;
            eng.latency = latency;
            if playing {
                eng.sequencer.render(&mut left[..n], &mut right[..n]);
                eng.pos += n as f64 / eng.sample_rate;
                // loop / end handling
                if eng.length > 0.0 && eng.pos >= eng.length {
                    if eng.looping {
                        eng.pos = 0.0;
                    } else {
                        eng.playing = false;
                        hit_end = true;
                    }
                }
                pos_secs = eng.pos;
            }
        }
        for i in 0..n {
            let (l, r) = if playing {
                (left[i], right[i])
            } else {
                (0.0, 0.0)
            };
            let base = (written + i) * channels;
            if channels >= 2 {
                out[base] = l;
                out[base + 1] = r;
                for c in 2..channels {
                    out[base + c] = 0.0;
                }
            } else if channels == 1 {
                out[base] = 0.5 * (l + r);
            }
        }
        written += n;
    }

    // Throttle status events by MUSICAL TIME, not callback count: the old
    // every-8th-callback rule meant one event per ~170ms with a typical 1024-
    // frame device buffer — the highway playhead visibly advanced in steps.
    // The frontend dead-reckons between events now, so all an emit has to do
    // is re-anchor the extrapolation and report play/pause flips promptly.
    let st = {
        let guard = engine.lock().unwrap();
        guard.as_ref().map(|eng| BackingStatus {
            playing: eng.playing,
            pos: if pos_secs > 0.0 { pos_secs } else { eng.pos },
            length: eng.length,
            loaded: eng.loaded,
            latency: eng.latency,
        })
    };
    if let Some(st) = st {
        let due = st.playing && (st.pos - emit.last_pos).abs() >= EMIT_INTERVAL_SECS;
        if due || st.playing != emit.last_playing || hit_end {
            emit.last_pos = st.pos;
            emit.last_playing = st.playing;
            let _ = app.emit("backing", st);
        }
    }
}

fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

fn f32_to_u16(sample: f32) -> u16 {
    ((sample.clamp(-1.0, 1.0) * 0.5 + 0.5) * u16::MAX as f32).round() as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn midi_with_track(body: &[u8]) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(b"MThd");
        data.extend_from_slice(&6u32.to_be_bytes());
        data.extend_from_slice(&0u16.to_be_bytes());
        data.extend_from_slice(&1u16.to_be_bytes());
        data.extend_from_slice(&480u16.to_be_bytes());
        data.extend_from_slice(b"MTrk");
        data.extend_from_slice(&(body.len() as u32).to_be_bytes());
        data.extend_from_slice(body);
        data
    }

    fn first_track_body(data: &[u8]) -> &[u8] {
        let start = 14 + 8;
        let len = u32::from_be_bytes([data[18], data[19], data[20], data[21]]) as usize;
        &data[start..start + len]
    }

    #[test]
    fn filter_keeps_selected_channel_and_expands_running_status() {
        let midi = midi_with_track(&[
            0, 0x90, 60, 100, // ch0, dropped
            0, 0x91, 64, 100, // ch1, kept
            0, 67, 100, // running status ch1, kept with explicit status
            0, 0xFF, 0x2F, 0, // end of track
        ]);

        let filtered = filter_channels(&midi, &[1]).unwrap();
        assert_eq!(
            first_track_body(&filtered),
            &[0, 0x91, 64, 100, 0, 0x91, 67, 100, 0, 0xFF, 0x2F, 0,]
        );
    }

    #[test]
    fn filter_folds_dropped_delta_into_next_kept_event() {
        let midi = midi_with_track(&[
            5, 0x90, 60, 100, // ch0, dropped
            7, 0x91, 64, 100, // ch1, kept at delta 12
            0, 0xFF, 0x2F, 0,
        ]);

        let filtered = filter_channels(&midi, &[1]).unwrap();
        assert_eq!(
            first_track_body(&filtered),
            &[12, 0x91, 64, 100, 0, 0xFF, 0x2F, 0]
        );
    }

    #[test]
    fn filter_rejects_delta_time_that_cannot_be_encoded_as_vlq() {
        let mut huge_delta = Vec::new();
        push_vlq(&mut huge_delta, MAX_VLQ).unwrap();
        let mut body = huge_delta;
        body.extend_from_slice(&[
            0x90, 60, 100, // ch0, dropped
            1, 0x91, 64, 100, // ch1, kept after MAX_VLQ + 1
            0, 0xFF, 0x2F, 0,
        ]);
        let midi = midi_with_track(&body);

        let err = filter_channels(&midi, &[1]).unwrap_err();
        assert!(err.contains("too large"));
    }

    #[test]
    fn filter_rejects_truncated_tracks() {
        let mut midi = midi_with_track(&[0, 0xFF, 0x2F, 0]);
        midi[18..22].copy_from_slice(&100u32.to_be_bytes());

        let err = filter_channels(&midi, &[0]).unwrap_err();
        assert!(err.contains("truncated"));
    }

    #[test]
    fn sample_conversion_clamps() {
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), -i16::MAX);
        assert_eq!(f32_to_u16(2.0), u16::MAX);
        assert_eq!(f32_to_u16(-2.0), 0);
    }
}
