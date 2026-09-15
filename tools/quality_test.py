#!/usr/bin/env python3
"""
Quality test runner for VoiceDenoise.

Measures PESQ and STOI of processed audio against reference.

Usage:
    uv run quality_test.py --ref clean.wav --deg processed.wav

Requires: pip install pesq pystoi numpy
(or: uv add pesq pystoi numpy)
"""

import argparse
import wave
from pathlib import Path

import numpy as np


def read_wav(path: str) -> tuple[np.ndarray, int]:
    """Read WAV file, return (samples, sample_rate) as mono float32."""
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        width = w.getsampwidth()
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype=np.uint8)

    if width == 2:
        samples = raw.view(np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        # 32-bit WAV from our encoder is float32
        samples = raw.view(np.float32)
    elif width == 3:
        # 24-bit → int32
        b = np.zeros((raw.size // 3, 4), dtype=np.uint8)
        b[:, :3] = raw.reshape(-1, 3)
        samples = b.view(np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported sample width: {width * 8} bit")

    if nch > 1:
        samples = samples.reshape(-1, nch).mean(axis=1)

    return samples, sr


def main():
    parser = argparse.ArgumentParser(description="VoiceDenoise quality test")
    parser.add_argument("--ref", required=True, help="Reference (clean) WAV")
    parser.add_argument("--deg", required=True, help="Degraded (processed) WAV")
    parser.add_argument("--sr", type=int, default=48000, help="Sample rate")
    args = parser.parse_args()

    print(f"Reference: {args.ref}")
    print(f"Degraded:  {args.deg}")

    ref_audio, ref_sr = read_wav(args.ref)
    deg_audio, deg_sr = read_wav(args.deg)

    if ref_sr != deg_sr:
        print(f"Warning: sample rate mismatch ({ref_sr} vs {deg_sr})")

    # Match lengths
    min_len = min(len(ref_audio), len(deg_audio))
    ref_audio = ref_audio[:min_len]
    deg_audio = deg_audio[:min_len]

    sr = ref_sr

    # STOI
    try:
        from pystoi import stoi

        stoi_score = stoi(ref_audio, deg_audio, sr, extended=False)
        print(f"STOI:  {stoi_score:.4f}  (target: >= 0.95)")
    except ImportError:
        print("STOI:  pystoi not installed (pip install pystoi)")

    # PESQ (supports 8kHz and 16kHz only, requires resampling)
    try:
        from pesq import pesq

        if sr == 48000:
            # PESQ only supports 8k/16k; downsample for measurement
            import scipy.signal

            ref_16k = scipy.signal.resample(ref_audio, len(ref_audio) * 16000 // sr)
            deg_16k = scipy.signal.resample(deg_audio, len(deg_audio) * 16000 // sr)
            sr_pesq = 16000
        else:
            ref_16k = ref_audio
            deg_16k = deg_audio
            sr_pesq = sr

        pesq_score = pesq(sr_pesq, ref_16k, deg_16k, "nb" if sr_pesq == 8000 else "wb")
        print(f"PESQ:  {pesq_score:.4f}  (target: >= 3.5)")
    except ImportError:
        print("PESQ:  pesq not installed (pip install pesq)")
    except Exception as e:
        print(f"PESQ:  error: {e}")

    # RMS noise floor (silent segment)
    if min_len > sr:
        # Find quietest 1-second segment
        seg_len = sr
        rms_values = []
        for start in range(0, min_len - seg_len, seg_len // 2):
            seg = deg_audio[start : start + seg_len]
            rms = np.sqrt(np.mean(seg**2))
            rms_values.append(rms)
        noise_floor_db = 20 * np.log10(min(rms_values) + 1e-10)
        print(f"Noise floor: {noise_floor_db:.1f} dBFS  (target: <= -60 dBFS)")


if __name__ == "__main__":
    main()
