#!/usr/bin/env python3
"""
Synthesizes the 14.0-second stereo 48kHz audio track for the ASI Messenger Windows XP Promo Video.
Combines:
- Nostalgic Y2K / Windows XP warm synth pad + 120 BPM groove
- Bundled ASI Messenger WAV effects (assets/sounds/signin.wav, message.wav, nudge.wav)
- Tactile UI clicks, agent invite pops, and keyboard typing ticks synced to promo/index.html
"""
import os
import wave
import numpy as np

SR = 48000
DUR = 14.0
N = int(SR * DUR)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOUNDS_DIR = os.path.join(ROOT, "assets", "sounds")
OUT_WAV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio.wav")

left = np.zeros(N, dtype=np.float64)
right = np.zeros(N, dtype=np.float64)


def mix_stereo(start_s: float, sig_l: np.ndarray, sig_r: np.ndarray | None = None, gain: float = 1.0, pan: float = 0.0):
    if sig_r is None:
        sig_r = sig_l
    i0 = max(0, int(start_s * SR))
    if i0 >= N:
        return
    m = min(len(sig_l), N - i0)
    if m <= 0:
        return
    # Constant-power pan (-1 left .. +1 right)
    angle = (pan + 1.0) * 0.25 * np.pi
    gl = gain * np.cos(angle)
    gr = gain * np.sin(angle)
    left[i0 : i0 + m] += sig_l[:m] * gl
    right[i0 : i0 + m] += sig_r[:m] * gr


def load_wav_resampled(path: str) -> tuple[np.ndarray, np.ndarray]:
    with wave.open(path, "rb") as wf:
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        sr = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if sw == 2:
        data = np.frombuffer(frames, dtype=np.int16).astype(np.float64) / 32768.0
    elif sw == 1:
        data = (np.frombuffer(frames, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    else:
        data = np.frombuffer(frames, dtype=np.int32).astype(np.float64) / 2147483648.0

    if ch >= 2:
        data = data.reshape(-1, ch)
        l_in, r_in = data[:, 0], data[:, 1]
    else:
        l_in = r_in = data

    if sr != SR:
        new_len = int(len(l_in) * SR / sr)
        x_old = np.linspace(0.0, 1.0, len(l_in))
        x_new = np.linspace(0.0, 1.0, new_len)
        l_in = np.interp(x_new, x_old, l_in)
        r_in = np.interp(x_new, x_old, r_in)
    return l_in, r_in


def add_xp_boot_shimmer(start_s: float = 0.05):
    """Warm E-major / B-major nostalgic crystalline chord reminiscent of early-2000s desktop boot."""
    notes = [329.63, 493.88, 659.25, 830.61, 987.77, 1318.51]  # E4, B4, E5, G#5, B5, E6
    dur = 2.6
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    sig_l = np.zeros_like(t)
    sig_r = np.zeros_like(t)
    for idx, f in enumerate(notes):
        delay = idx * 0.055
        mask = t >= delay
        tt = np.maximum(0.0, t - delay)
        env = np.exp(-tt * 1.9) * (1.0 - np.exp(-tt * 35.0)) * mask
        voice_l = (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * (f * 2.0) * tt)) * env
        voice_r = (np.sin(2 * np.pi * (f * 1.002) * tt + 0.4) + 0.3 * np.sin(2 * np.pi * (f * 2.001) * tt)) * env
        sig_l += voice_l * 0.18
        sig_r += voice_r * 0.18
    mix_stereo(start_s, sig_l, sig_r, gain=0.42)


def add_backing_groove():
    """120 BPM (beat = 0.5s) light warm Rhodes-style chord pulse + soft sub kick & hi-hat from t=1.5s to 14.0s."""
    bpm = 120.0
    beat_s = 60.0 / bpm  # 0.5s
    # Chord progression every 4 beats (2.0s): E maj9 -> C#m9 -> A maj9 -> B13
    chords = [
        [164.81, 246.94, 329.63, 415.30, 493.88, 622.25],  # Emaj9
        [138.59, 207.65, 329.63, 415.30, 493.88, 587.33],  # C#m11
        [110.00, 220.00, 329.63, 415.30, 493.88, 659.25],  # Amaj9
        [123.47, 246.94, 370.00, 440.00, 554.37, 659.25],  # B13
    ]
    for bar in range(6):
        bar_t0 = 1.5 + bar * 2.0
        chord = chords[bar % len(chords)]
        dur = 2.05
        t = np.linspace(0, dur, int(SR * dur), endpoint=False)
        env = (1.0 - np.exp(-t * 25.0)) * np.exp(-t * 1.15)
        pad_l = np.zeros_like(t)
        pad_r = np.zeros_like(t)
        for i, f in enumerate(chord):
            pad_l += np.sin(2 * np.pi * f * t) * (0.22 / (1 + 0.2 * i))
            pad_r += np.sin(2 * np.pi * (f * 1.0015) * t + 0.3 * i) * (0.22 / (1 + 0.2 * i))
        mix_stereo(bar_t0, pad_l * env, pad_r * env, gain=0.22)

    # Subtle pulse kick & crisp shaker on beats 1.5s .. 11.5s
    rng = np.random.default_rng(42)
    for beat_idx in range(21):
        bt = 1.5 + beat_idx * beat_s
        # Soft kick on every beat
        kd = 0.14
        kt = np.linspace(0, kd, int(SR * kd), endpoint=False)
        f_sweep = 48.0 + 95.0 * np.exp(-kt * 36.0)
        phase = 2 * np.pi * np.cumsum(f_sweep) / SR
        kick = np.sin(phase) * np.exp(-kt * 22.0)
        mix_stereo(bt, kick, kick, gain=0.20)

        # Off-beat hi-hat tick
        ht_start = bt + 0.25
        if ht_start < 11.5:
            hd = 0.035
            ht = np.linspace(0, hd, int(SR * hd), endpoint=False)
            noise = rng.normal(0, 1, len(ht))
            # Simple high-pass via diff
            noise = np.diff(noise, prepend=0.0)
            hat = noise * np.exp(-ht * 95.0)
            mix_stereo(ht_start, hat, hat, gain=0.045, pan=0.15)


def add_click(t_s: float, pitch: float = 1350.0, pan: float = 0.0):
    dur = 0.028
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    sig = (
        np.sin(2 * np.pi * pitch * t) * np.exp(-t * 160.0)
        + 0.5 * np.sin(2 * np.pi * (pitch * 2.4) * t) * np.exp(-t * 280.0)
    )
    mix_stereo(t_s, sig, sig, gain=0.28, pan=pan)


def add_pop(t_s: float, freq: float = 520.0, pan: float = 0.0):
    dur = 0.08
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    f_curve = freq * (1.0 + 0.65 * (1.0 - np.exp(-t * 45.0)))
    phase = 2 * np.pi * np.cumsum(f_curve) / SR
    sig = np.sin(phase) * np.exp(-t * 38.0) * (1.0 - np.exp(-t * 200.0))
    mix_stereo(t_s, sig, sig, gain=0.24, pan=pan)


def add_key_tick(t_s: float, idx: int):
    dur = 0.016
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    pitch = 1900.0 + ((idx * 173) % 500)
    sig = np.sin(2 * np.pi * pitch * t) * np.exp(-t * 260.0)
    mix_stereo(t_s, sig, sig, gain=0.11, pan=-0.1 + 0.02 * (idx % 5))


def add_finale_swell(start_s: float = 11.45):
    """Bright resolving E-major9 shimmer for the finale card."""
    notes = [164.81, 329.63, 415.30, 493.88, 659.25, 987.77, 1318.51]
    dur = 2.45
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    env = (1.0 - np.exp(-t * 8.0)) * np.exp(-t * 1.1)
    sig_l = np.zeros_like(t)
    sig_r = np.zeros_like(t)
    for i, f in enumerate(notes):
        sig_l += np.sin(2 * np.pi * f * t) * (0.20 / (1 + 0.15 * i))
        sig_r += np.sin(2 * np.pi * (f * 1.002) * t + 0.25 * i) * (0.20 / (1 + 0.15 * i))
    mix_stereo(start_s, sig_l * env, sig_r * env, gain=0.38)


def main():
    add_xp_boot_shimmer(0.05)
    add_backing_groove()

    # Load actual ASI Messenger sound assets
    signin_l, signin_r = load_wav_resampled(os.path.join(SOUNDS_DIR, "signin.wav"))
    msg_l, msg_r = load_wav_resampled(os.path.join(SOUNDS_DIR, "message.wav"))
    nudge_l, nudge_r = load_wav_resampled(os.path.join(SOUNDS_DIR, "nudge.wav"))

    # UI clicks: double click desktop icon (1.0, 1.24), Invite button (3.0), Send button (5.1), Nudge button (10.6)
    add_click(1.00, 1450.0, pan=-0.65)
    add_click(1.24, 1620.0, pan=-0.65)
    add_click(3.00, 1380.0, pan=0.45)
    add_click(5.10, 1520.0, pan=0.10)
    add_click(10.60, 1480.0, pan=0.25)

    # MSN Sign-in toast & window open at 1.42s
    mix_stereo(1.42, signin_l, signin_r, gain=0.65, pan=0.2)

    # Agent invite badge pop-ins (Claude #2, Antigravity, Codex)
    add_pop(3.35, 523.25, pan=-0.15)
    add_pop(3.65, 659.25, pan=0.05)
    add_pop(3.95, 783.99, pan=0.25)

    # Typing burst (4.30s .. 5.02s)
    for i, ts in enumerate(np.linspace(4.30, 5.02, 16)):
        add_key_tick(float(ts), i)

    # Chat message arrivals + .boards/session.log updates
    msg_times = [
        (5.18, 0.20, 0.48),   # User @all message
        (5.95, -0.25, 0.55),  # Claude Code [claude-1] FINDING
        (7.20, -0.15, 0.55),  # Claude Code #2 [claude-2] CLAIM
        (8.40, -0.05, 0.55),  # Antigravity [agy-1] STATUS
        (9.45, 0.10, 0.60),   # Codex [codex-1] DONE
    ]
    for ts, pan, g in msg_times:
        mix_stereo(ts, msg_l, msg_r, gain=g, pan=pan)
        # Subtle terminal log append blip 120ms later
        add_pop(ts + 0.12, 880.0, pan=0.45)

    # Classic MSN Nudge shake sound at 10.60s
    mix_stereo(10.60, nudge_l, nudge_r, gain=0.80, pan=0.0)

    # Finale chord swell at 11.45s
    add_finale_swell(11.45)

    # Smooth fade-in (40ms) and fade-out (450ms at the end)
    fade_in = int(0.04 * SR)
    fade_out = int(0.45 * SR)
    left[:fade_in] *= np.linspace(0.0, 1.0, fade_in)
    right[:fade_in] *= np.linspace(0.0, 1.0, fade_in)
    left[-fade_out:] *= np.linspace(1.0, 0.0, fade_out)
    right[-fade_out:] *= np.linspace(1.0, 0.0, fade_out)

    # Soft limiter / normalization to -1 dBFS
    peak = max(np.max(np.abs(left)), np.max(np.abs(right)), 1e-6)
    target = 0.89
    scale = min(1.0, target / peak) if peak > target else (target / peak)
    stereo = np.stack([left * scale, right * scale], axis=-1)
    pcm16 = np.clip(stereo * 32767.0, -32768, 32767).astype(np.int16)

    with wave.open(OUT_WAV, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm16.tobytes())

    print(f"Wrote {OUT_WAV} ({DUR:.1f}s, {SR}Hz stereo, peak={peak:.3f})")


if __name__ == "__main__":
    main()
