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
import sys
from pathlib import Path

import numpy as np


def read_wav(path: str) -> tuple[np.ndarray, int]:
    """Read WAV file, return (samples, sample_rate)."""
    import struct

    with open(path, "rb") as f:
        data = f.read()

    # Parse WAV header
    if data[:4] != b"RIFF":
        raise ValueError(f"Not a WAV file: {path}")

    # Find fmt chunk
    pos = 12
    sample_rate = 48000
    bits_per_sample = 16
    num_channels = 1

    while pos < len(data) - 8:
        chunk_id = data[pos : pos + 4]
        chunk_size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        if chunk_id == b"fmt ":
            fmt_data = data[pos + 8 : pos + 8 + chunk_size]
            audio_format = struct.unpack("<H", fmt_data[0:2])[0]
            num_channels = struct.unpack("<H", fmt_data[2:4])[0]
            sample_rate = struct.unpack("<I", fmt_data[4:8])[0]
            bits_per_sample = struct.unpack("<H", fmt_data[14:16])[0]
        elif chunk_id == b"data":
            raw_data = data[pos + 8 : pos + 8 + chunk_size]
            break
        pos += 8 + chunk_size

    # Convert to float32
    if bits_per_sample == 16:
        dtype = np.int16
        scale = 32768.0
    elif bits_per_sample == 32:
        dtype = np.int32
        scale = 2147483648.0
    else:
        dtype = np.float32
        scale = 1.0

    samples = np.frombuffer(raw_data, dtype=dtype).astype(np.float32) / scale

    # Mix to mono
    if num_channels > 1:
        samples = samples.reshape(-1, num_channels).mean(axis=1)

    return samples, sample_rate


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
