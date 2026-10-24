# Measuring recording overhead

ClipLock does not claim zero FPS loss. Hardware encoders run on dedicated silicon, but
capture, colour conversion and encoding still use GPU time and memory bandwidth.

## Method

1. Pick a GPU-bound and a CPU-bound game scene that can be replayed consistently
   (built-in benchmark or a fixed spectator demo).
2. Measure frame times with [PresentMon](https://github.com/GameTechDev/PresentMon) or
   CapFrameX for 60 s per run, three runs each:
   - baseline: ClipLock closed
   - Instant Replay on (default settings: native or 1080p, 60 fps, 20 Mbit/s, Auto encoder)
   - Instant Replay on while saving clips every 15 s
3. Report average FPS, 1 % and 0.1 % lows, and GPU/CPU utilisation.
4. Record encoder health from ClipLock: `cliplock-capture bench --duration 60` prints
   frames, dropped frames and encode speed every 5 s (speed must stay ≥ 0.97×).

```powershell
cliplock-capture probe                                        # what this PC can encode
cliplock-capture bench --source monitor:0 --height 1080 --fps 60 --duration 60
cliplock-capture replay --seconds 30 --wait 40 --out test.mp4  # end-to-end check
```

## What to expect from the design

- Monitor capture + NVENC/AMF at native resolution: frames stay on the GPU (zero copy).
- Scaling (e.g. 1440p → 1080p): GPU-side with `scale_d3d11` when the FFmpeg build has
  it; otherwise frames are downloaded and scaled on the CPU, which costs noticeably more.
  The Home screen shows whether the GPU path is active.
- Software encoding is a fallback and can cost a lot of CPU at 1080p60.

## Results

No measurements have been recorded yet. Add results here with hardware, driver and game
details.
