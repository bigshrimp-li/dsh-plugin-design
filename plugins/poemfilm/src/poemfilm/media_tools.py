"""Local media I/O. Subprocesses read only local media and never use a shell."""

import json
import re
import subprocess
from fractions import Fraction
from hashlib import sha256
from pathlib import Path

from .core import Fail

SAMPLE_RATE = 48000
INPUT_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,wav,aiff,flac,mp3,aac,ogg,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,image2"
LOCAL_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist", INPUT_FORMATS]


def call(argv, *, cwd=None):
    try:
        proc = subprocess.run(
            [str(x) for x in argv],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            cwd=cwd,
        )
    except OSError as exc:
        raise Fail("media_tool_missing", "本机无法运行媒体工具。", 5, tool=argv[0]) from exc
    if proc.returncode:
        detail = proc.stderr.decode(errors="replace").strip()[-1200:]
        raise Fail("media_tool_failed", "本地媒体读取或处理失败。", 5, tool=argv[0], diagnostic=detail)
    return proc


def digest(path):
    with Path(path).open("rb") as handle:
        h = sha256()
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
        return h.hexdigest()


def stamp(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256(raw.encode()).hexdigest()


def probe(path):
    command = [
        "ffprobe",
        "-v",
        "error",
        *LOCAL_INPUT,
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        path,
    ]
    return json.loads(call(command).stdout)


def first_stream(meta, kind):
    return next((s for s in meta["streams"] if s["codec_type"] == kind), None)


def duration(stream, meta):
    if stream.get("duration_ts") is not None and stream.get("time_base"):
        return int(stream["duration_ts"]) * Fraction(stream["time_base"])
    seconds = stream.get("duration") or meta["format"].get("duration")
    return Fraction(str(seconds or 0))


def near(value):
    value = Fraction(value)
    return (2 * value.numerator + value.denominator) // (2 * value.denominator)


def timecode(ms):
    h, rest = divmod(ms, 3600000)
    m, rest = divmod(rest, 60000)
    s, ms = divmod(rest, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def subtitles(cues):
    rows = []
    for i, cue in enumerate(cues, 1):
        start = timecode(near(Fraction(cue["start_sample"] * 1000, SAMPLE_RATE)))
        end = timecode(near(Fraction(cue["end_sample"] * 1000, SAMPLE_RATE)))
        rows.append(f"{i}\n{start} --> {end}\n{cue['text']}\n")
    return "\n".join(rows) + "\n"


def encode_clip(spec, path, out, video):
    args = ["ffmpeg", "-nostdin", "-v", "error", "-y"]
    fps = video["fps"]
    if spec["kind"] == "still":
        args += ["-loop", "1", "-framerate", str(fps)]
    elif spec["in_ms"]:
        args += ["-ss", f"{spec['in_ms'] / 1000:.6f}"]
    w, h = video["width"], video["height"]
    filt = (
        f"fps={fps},scale={w}:{h}:force_original_aspect_ratio=increase,"
        f"crop={w}:{h},setsar=1,format=yuv420p"
    )
    args += [
        *LOCAL_INPUT,
        "-i",
        path,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-vf",
        filt,
        "-frames:v",
        str(spec["frames"]),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-threads",
        "3",
        "-x264-params",
        "scenecut=0",
        "-video_track_timescale",
        str(fps * 1000),
        out,
    ]
    call(args)
    stream = first_stream(probe(out), "video")
    if not stream or int(stream.get("nb_frames", 0)) != spec["frames"]:
        raise Fail("source_frame_shortfall", "源镜头无法按原速给出指定帧数。", 5, shot_id=spec["id"])


def measure_output(path):
    args = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        path,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-vf",
        "blackdetect=d=0.12:pic_th=0.98:pix_th=0.06",
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
    ]
    log = call(args).stderr.decode(errors="replace")
    summary = log.rsplit("Summary:", 1)[-1]

    def measured(pattern):
        match = re.search(pattern, summary)
        if not match or match[1] == "-inf":
            return None
        return float(match[1])

    blacks = re.findall(r"black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)", log)
    return {
        "integrated_lufs": measured(r"I:\s*([-\d.inf]+) LUFS"),
        "true_peak_dbtp": measured(r"Peak:\s*([-\d.inf]+) dBFS"),
        "black_intervals": [
            {"start": float(s), "end": float(e), "duration": float(d)} for s, e, d in blacks
        ],
    }
