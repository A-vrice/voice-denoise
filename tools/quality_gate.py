#!/usr/bin/env python3
"""Quality gate (regression): PESQ / STOI vs a recorded baseline.

Compares each ``<name>_processed.wav`` (from tools/quality/run_chain.ts) against
``<name>_clean.wav`` and fails if a metric drops more than a tolerance below the
recorded baseline (tools/quality/baseline.json).

The spec targets (PESQ >= 3.5 / STOI >= 0.95) are printed for reference; they are
not enforced here because the fixture set (synthetic noise) does not reach them
(see SPEC). This gate detects regressions instead.

Usage:
    # check (CI)
    uv run tools/quality_gate.py --fixtures tools/quality/fixtures --out tools/quality/out
    # record/refresh the baseline (after an intentional change)
    uv run tools/quality_gate.py --update-baseline

On Windows, ``pesq`` needs MSVC; pass ``--skip-pesq`` to check STOI only.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import wave
from pathlib import Path

import numpy as np


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        width = w.getsampwidth()
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype=np.uint8)
    if width == 2:
        samples = raw.view(np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        samples = raw.view(np.float32)
    else:
        raise ValueError(f"Unsupported sample width: {width * 8} bit ({path})")
    if nch > 1:
        samples = samples.reshape(-1, nch).mean(axis=1)
    return samples, sr


def pesq_wb(ref: np.ndarray, deg: np.ndarray, sr: int) -> float:
    from pesq import pesq

    if sr != 16000:
        import scipy.signal

        ref = scipy.signal.resample(ref, int(len(ref) * 16000 / sr))
        deg = scipy.signal.resample(deg, int(len(deg) * 16000 / sr))
    return float(pesq(16000, ref, deg, "wb"))


def main() -> int:
    ap = argparse.ArgumentParser(description="VoiceDenoise quality gate (regression)")
    ap.add_argument("--fixtures", default="tools/quality/fixtures")
    ap.add_argument("--out", default="tools/quality/out")
    ap.add_argument("--baseline", default="tools/quality/baseline.json")
    ap.add_argument("--tol-stoi", type=float, default=0.02)
    ap.add_argument("--tol-pesq", type=float, default=0.2)
    ap.add_argument("--stoi-target", type=float, default=0.95, help="spec target (reference only)")
    ap.add_argument("--pesq-target", type=float, default=3.5, help="spec target (reference only)")
    ap.add_argument("--skip-pesq", action="store_true", help="check STOI only (no pesq)")
    ap.add_argument("--update-baseline", action="store_true", help="write measured values as the baseline")
    ap.add_argument("--report", default="", help="write measured metrics + environment JSON here")
    args = ap.parse_args()

    try:
        from pystoi import stoi
    except ImportError:
        print("pystoi is required", file=sys.stderr)
        return 2

    check_pesq = not args.skip_pesq
    if check_pesq:
        try:
            import pesq  # noqa: F401
        except ImportError:
            print("pesq is required for the PESQ gate (or pass --skip-pesq)", file=sys.stderr)
            return 2

    fixtures = Path(args.fixtures)
    out = Path(args.out)
    baseline_path = Path(args.baseline)
    cleans = sorted(fixtures.glob("*_clean.wav"))
    if not cleans:
        print(f"no *_clean.wav in {fixtures}", file=sys.stderr)
        return 2

    measured: dict[str, dict[str, float]] = {"stoi": {}, "pesq": {}}
    for cpath in cleans:
        name = cpath.name[: -len("_clean.wav")]
        ppath = out / f"{name}_processed.wav"
        if not ppath.exists():
            print(f"missing processed file for {name}: {ppath}", file=sys.stderr)
            return 2
        ref, sr = read_wav(cpath)
        deg, sr2 = read_wav(ppath)
        if sr != sr2:
            print(f"sample rate mismatch for {name}", file=sys.stderr)
            return 2
        n = min(len(ref), len(deg))
        measured["stoi"][name] = round(float(stoi(ref[:n], deg[:n], sr, extended=False)), 4)
        if check_pesq:
            measured["pesq"][name] = round(pesq_wb(ref[:n], deg[:n], sr), 3)

    if args.report:
        report = {
            "environment": {
                "python": sys.version.split()[0],
                "platform": sys.platform,
                "machine": platform.machine(),
            },
            "measured": measured,
        }
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        print(f"report written: {report_path}")

    if args.update_baseline:
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(json.dumps(measured, indent=2) + "\n")
        print(f"baseline written: {baseline_path}")
        for name in sorted(measured["stoi"]):
            p = measured["pesq"].get(name)
            print(f"  {name:<28} STOI {measured['stoi'][name]:.4f}" + (f"  PESQ {p:.3f}" if p is not None else ""))
        return 0

    if not baseline_path.exists():
        print(f"baseline not found: {baseline_path} (run --update-baseline)", file=sys.stderr)
        return 2
    baseline = json.loads(baseline_path.read_text())

    print(f"{'name':<28} {'STOI':>7} {'base':>7}  {'PESQ':>7} {'base':>7}  {'ok':>4}")
    failures = 0
    for name in sorted(measured["stoi"]):
        s = measured["stoi"][name]
        sb = baseline.get("stoi", {}).get(name)
        ok = sb is None or s >= sb - args.tol_stoi
        p = measured["pesq"].get(name)
        pb = baseline.get("pesq", {}).get(name)
        p_ok = True
        if check_pesq and p is not None and pb is not None:
            p_ok = p >= pb - args.tol_pesq
        ok = ok and p_ok
        if not ok:
            failures += 1
        pcol = f"{p:7.3f}" if p is not None else "   n/a "
        pbase = f"{pb:7.3f}" if pb is not None else "   n/a "
        print(f"{name:<28} {s:7.4f} {sb if sb is not None else float('nan'):7.4f}  {pcol} {pbase}  {'PASS' if ok else 'FAIL':>4}")

    print(f"\nreference targets (not enforced): STOI >= {args.stoi_target}, PESQ >= {args.pesq_target}")
    if failures:
        print(f"FAIL: {failures} clip(s) below baseline - tolerance")
        return 1
    print("PASS: no regression vs baseline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
