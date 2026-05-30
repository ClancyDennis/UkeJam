"""Play-along scorer — the core feedback loop.

Ties the song model to chord detection. A song's chord sequence is laid out on
a timeline (tempo + beats-per-chord). A "performance" is what the detector
heard over time. The scorer aligns them and reports, per expected chord:
  HIT   — right chord, in its window
  WRONG — a different chord sounded in the window (+ what was played)
  MISS  — nothing detected (silence / muted)

Until a real uke is available, build_synthetic_performance() renders the song
(optionally with injected errors) and runs it through the real detector, so
the whole loop is testable headless.
"""

from dataclasses import dataclass
import numpy as np

from chords import build_templates, compute_chroma, detect_chord
from feedback import synth_fingering, diff_against_target
from fretboard import VOICINGS, expected_pitch_classes

SR = 44100


@dataclass
class ChordEvent:
    chord: str
    start: float        # seconds
    duration: float     # seconds


def build_timeline(chord_sequence, bpm=80, beats_per_chord=2):
    """Lay a chord sequence on a timeline. Returns list[ChordEvent]."""
    sec_per_chord = beats_per_chord * 60.0 / bpm
    events = []
    t = 0.0
    for chord in chord_sequence:
        events.append(ChordEvent(chord, t, sec_per_chord))
        t += sec_per_chord
    return events


@dataclass
class Verdict:
    expected: str
    detected: str | None
    status: str          # HIT | WRONG | MISS
    missing: list        # pitch classes absent vs. expected
    extra: list          # pitch classes present but not in expected


def score_performance(timeline, hop_audio, labels, templates, priors=None):
    """For each ChordEvent, look at the audio in its window and judge it.

    hop_audio: a function (start, duration) -> mono np.array for that span.
    """
    verdicts = []
    for ev in timeline:
        audio = hop_audio(ev.start, ev.duration)
        if audio is None or len(audio) < 2048:
            verdicts.append(Verdict(ev.chord, None, "MISS", [], []))
            continue
        rms = np.sqrt(np.mean(audio ** 2))
        if rms < 0.01:
            verdicts.append(Verdict(ev.chord, None, "MISS", [], []))
            continue
        # analyze the steadiest middle of the window
        mid = len(audio) // 2
        chunk = audio[max(0, mid - 4096): mid + 4096]
        chroma = compute_chroma(chunk, SR)
        detected = detect_chord(chroma, labels, templates, top=1, priors=priors)[0][0]
        target_pcs = (expected_pitch_classes(ev.chord)
                      if ev.chord in VOICINGS else None)
        missing, extra = ([], [])
        status = "HIT" if detected == ev.chord else "WRONG"
        if target_pcs is not None:
            missing, extra = diff_against_target(chroma, target_pcs)
            # Score on the pitch-class diff, which is more robust than the
            # exact template label: a HIT means all target notes are present
            # and no more than one extra note rings (tolerates harmonic
            # bleed and added-color notes like a maj7 overtone).
            status = "HIT" if (not missing and len(extra) <= 1) else "WRONG"
        verdicts.append(Verdict(ev.chord, detected, status, missing, extra))
    return verdicts


def build_synthetic_performance(timeline, errors=None):
    """Render the song to one audio buffer, optionally swapping some chords
    for wrong fingerings. errors: {event_index: substitute_chord}.

    Returns (audio, hop_fn) where hop_fn(start, dur) slices the buffer.
    """
    errors = errors or {}
    total = timeline[-1].start + timeline[-1].duration
    buf = np.zeros(int(total * SR))
    for i, ev in enumerate(timeline):
        play_chord = errors.get(i, ev.chord)
        if play_chord not in VOICINGS:
            continue  # unknown voicing -> leave silence (counts as MISS)
        tone = synth_fingering(VOICINGS[play_chord], dur=ev.duration)
        s = int(ev.start * SR)
        e = min(s + len(tone), len(buf))
        buf[s:e] += tone[:e - s]
    peak = np.max(np.abs(buf))
    if peak:
        buf /= peak

    def hop_fn(start, dur):
        s = int(start * SR)
        e = int((start + dur) * SR)
        return buf[s:e]

    return buf, hop_fn


def report(verdicts):
    hits = sum(v.status == "HIT" for v in verdicts)
    print(f"{'#':>2}  {'expected':9} {'detected':9} {'status':6}  detail")
    print("-" * 60)
    from chords import NOTE_NAMES
    for i, v in enumerate(verdicts):
        detail = ""
        if v.status == "WRONG":
            if v.extra:
                detail += "extra " + ",".join(NOTE_NAMES[p] for p in v.extra)
            if v.missing:
                detail += " missing " + ",".join(NOTE_NAMES[p] for p in v.missing)
        print(f"{i:>2}  {v.expected:9} {str(v.detected):9} {v.status:6}  {detail}")
    print("-" * 60)
    print(f"score: {hits}/{len(verdicts)} chords correct "
          f"({100*hits//len(verdicts)}%)")


if __name__ == "__main__":
    labels, templates, priors = build_templates()

    # A short progression the player will "perform".
    progression = ["G", "C", "D", "Em", "G", "C", "D", "G"]
    timeline = build_timeline(progression, bpm=80, beats_per_chord=2)

    # Inject two finger errors: chord 2 played as Em, chord 5 played as Am.
    errors = {2: "Em", 5: "Am"}
    print(f"Performing: {progression}")
    print(f"Injected errors: chord {list(errors)} played as {list(errors.values())}\n")

    audio, hop = build_synthetic_performance(timeline, errors=errors)
    verdicts = score_performance(timeline, hop, labels, templates, priors)
    report(verdicts)
