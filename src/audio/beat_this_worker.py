"""Long-lived Beat This! worker (src/audio/beatThis.js talks to it).

Protocol (one JSON object per line):
  stdout, once at start: {"ready": true, "device": "cuda"} or {"ready": false, "error": "..."}
  stdin:  {"id": 1, "path": "/abs/audio/file"}
  stdout: {"id": 1, "ok": true, "beats": [...], "downbeats": [...], "inferMs": 1234}
          {"id": 1, "ok": false, "error": "..."}

The model loads once (~11 s on the production GTX 970); each track then takes
1-2 s for the whole song. Audio is decoded by ffmpeg so any container the bot
downloads (webm/opus, m4a, ...) works without a torchaudio backend.
"""
import json
import subprocess
import sys
import time

import numpy as np

SR = 22050


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def decode(path):
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
         "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg exited with {proc.returncode}: {proc.stderr.decode(errors='replace')[-200:]}")
    signal = np.frombuffer(proc.stdout, dtype=np.float32)
    if signal.size < SR:
        raise RuntimeError("decoded audio is shorter than 1 s")
    return signal


def main():
    device = sys.argv[1] if len(sys.argv) > 1 else "cuda"
    try:
        import torch
        from beat_this.inference import Audio2Beats
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA is not available")
        model = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)
    except Exception as err:  # noqa: BLE001 - report any startup failure to the parent
        emit({"ready": False, "error": str(err)[:300]})
        return 1
    emit({"ready": True, "device": device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            signal = decode(req["path"])
            started = time.monotonic()
            beats, downbeats = model(signal, SR)
            emit({
                "id": req_id,
                "ok": True,
                "beats": [round(float(b), 3) for b in beats],
                "downbeats": [round(float(b), 3) for b in downbeats],
                "inferMs": round((time.monotonic() - started) * 1000),
            })
        except Exception as err:  # noqa: BLE001 - one bad track must not kill the worker
            emit({"id": req_id, "ok": False, "error": str(err)[:300]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
