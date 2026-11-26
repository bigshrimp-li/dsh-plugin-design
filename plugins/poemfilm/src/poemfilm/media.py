"""Offline plan, render, and verify commands for a single edition."""

import json
import os
import shutil
import tempfile
from fractions import Fraction
from pathlib import Path

from . import core
from .media_plan import compile_plan
from .media_tools import (
    LOCAL_INPUT,
    SAMPLE_RATE,
    call,
    digest,
    encode_clip,
    first_stream,
    measure_output,
    probe,
    stamp,
    subtitles,
)


def _read(path):
    return core.read_map(path) if path.is_file() else {}


def _resolve(work, name):
    work = Path(work).resolve()
    name = name or core.load_work(work)["default_edition"]
    folder = core.asset_path(work, Path("build") / core.name_part(name))
    folder.mkdir(parents=True, exist_ok=True)
    for subdir in ("cache", "frames"):
        core.asset_path(work, (folder / subdir).relative_to(work))
    return name, folder


def _environment():
    encoder = call(["ffmpeg", "-version"]).stdout.decode().splitlines()[0]
    # Include the encoding implementation in cache keys when the tool changes.
    return stamp([encoder, digest(Path(__file__).with_name("media_tools.py")), digest(Path(__file__))])


def _valid_build(folder, lock, runtime):
    receipt = _read(folder / "render.json")
    if receipt.get("timeline_sha256") != lock["timeline_sha256"] or receipt.get("runtime") != runtime:
        return False
    files = receipt.get("artifacts", {})
    return all(
        (folder / name).is_file() and digest(folder / name) == files.get(name)
        for name in ("master.mp4", "subtitles.srt", "credits.txt")
    )


def _locked_plan(work, name, folder):
    plan, lock = compile_plan(work, name)
    if not plan["renderable"] or _read(folder / "timeline.lock.json") != lock:
        raise core.Fail("timeline_stale", "素材或选择已改变，请重新 plan。", 5, issues=plan["issues"])
    return plan, lock


def _video_parts(work, folder, staging, lock, runtime):
    cache = core.asset_path(work, Path("build") / ".clip-cache")
    cache.mkdir(parents=True, exist_ok=True)
    concat = ["ffconcat version 1.0"]
    reused = 0
    for i, clip in enumerate(lock["shots"]):
        key = stamp([runtime, lock["video"], clip["kind"], clip["sha256"], clip["frames"], clip["in_ms"]])
        dest = cache / (key + ".mp4")
        record = cache / (key + ".json")
        if dest.is_symlink() or record.is_symlink():
            raise core.Fail("invalid_cache", "缓存文件不可为符号链接。", 5)
        if dest.is_file() and _read(record).get("sha256") == digest(dest):
            reused += 1
        else:
            temp = staging / (key + ".mp4")
            encode_clip(clip, core.asset_path(work, clip["path"]), temp, lock["video"])
            temp.replace(dest)
            core.atomic_json(record, {"sha256": digest(dest)})
        linked = staging / f"v{i}.mp4"
        os.link(dest, linked)
        concat.extend([f"file '{linked.name}'", f"duration {clip['frames'] / lock['video']['fps']:.12f}"])
    (staging / "cuts.ffconcat").write_text("\n".join(concat) + "\n", encoding="utf-8")
    return reused


def _audio(work, staging, lock):
    # Decode to one PCM clock; no padding is introduced between takes.
    pcm = staging / "voice.pcm"
    with pcm.open("wb") as track:
        for voice in lock["voices"]:
            segment = staging / "take.pcm"
            call(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-y",
                    *LOCAL_INPUT,
                    "-i",
                    core.asset_path(work, voice["path"]),
                    "-map",
                    "0:a:0",
                    "-ar",
                    str(SAMPLE_RATE),
                    "-ac",
                    "2",
                    "-c:a",
                    "pcm_s16le",
                    "-f",
                    "s16le",
                    segment,
                ]
            )
            target = voice["samples"] * 4
            size = segment.stat().st_size
            if abs(size - target) > 4:
                raise core.Fail(
                    "audio_sample_mismatch",
                    "音频解码长度与锁定采样数不一致，请导入 PCM WAV 再排镜。",
                    5,
                    line_id=voice["line_id"],
                    expected_samples=voice["samples"],
                    decoded_samples=size // 4,
                )
            with segment.open("r+b") as source:
                source.truncate(target)
                shutil.copyfileobj(source, track)
    args = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "s16le",
        "-ar",
        str(SAMPLE_RATE),
        "-ac",
        "2",
        "-i",
        pcm,
    ]
    ambience = lock["ambience"]
    norm = f"loudnorm=I=-18:TP=-1.5:LRA=11,aresample={SAMPLE_RATE},atrim=end_sample={lock['samples']}"
    if ambience:
        args += [
            *LOCAL_INPUT,
            "-i",
            core.asset_path(work, ambience["path"]),
            "-filter_complex",
            f"[1:a:0]volume={ambience['gain_db']}dB[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0,{norm}[out]",
            "-map",
            "[out]",
        ]
    else:
        args += ["-af", norm]
    call(args + ["-ac", "2", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s24le", staging / "mix.wav"])


def _render(work, name, folder):
    _, lock = _locked_plan(work, name, folder)
    runtime = _environment()
    master = folder / "master.mp4"
    if _valid_build(folder, lock, runtime):
        return {
            "master": str(master),
            "subtitles": str(folder / "subtitles.srt"),
            "credits": str(folder / "credits.txt"),
            "cached": True,
            "timeline_sha256": lock["timeline_sha256"],
        }
    with tempfile.TemporaryDirectory(prefix=".render-", dir=folder) as temp:
        staging = Path(temp)
        reused = _video_parts(work, folder, staging, lock, runtime)
        _audio(work, staging, lock)
        (staging / "subtitles.srt").write_text(subtitles(lock["subtitles"]), encoding="utf-8")
        credits = "\n".join(lock["credits"])
        (staging / "credits.txt").write_text(credits + "\n", encoding="utf-8")
        call(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-protocol_whitelist",
                "file,pipe",
                "-f",
                "concat",
                "-safe",
                "1",
                "-i",
                "cuts.ffconcat",
                "-i",
                "mix.wav",
                "-f",
                "srt",
                "-i",
                "subtitles.srt",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-map",
                "2:s:0",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "256k",
                "-c:s",
                "mov_text",
                "-disposition:s:0",
                "default",
                "-metadata:s:s:0",
                "language=zho",
                "-metadata",
                "title=" + lock["title"],
                "-metadata",
                "artist=" + lock["author"],
                "-metadata",
                "comment=" + credits,
                "-movflags",
                "+faststart",
                "master.mp4",
            ],
            cwd=staging,
        )
        # Validate before replacing the previous result. Missing/changed inputs cannot publish a stale render.
        _locked_plan(work, name, folder)
        files = {f: digest(staging / f) for f in ("subtitles.srt", "credits.txt", "master.mp4")}
        for f in files:
            (staging / f).replace(folder / f)
        core.atomic_json(
            folder / "render.json",
            {"timeline_sha256": lock["timeline_sha256"], "runtime": runtime, "artifacts": files},
        )
    return {
        "master": str(master),
        "subtitles": str(folder / "subtitles.srt"),
        "credits": str(folder / "credits.txt"),
        "cached": False,
        "clips_reused": reused,
        "clips_total": len(lock["shots"]),
        "timeline_sha256": lock["timeline_sha256"],
    }


def _verify(work, name, folder):
    plan, lock = _locked_plan(work, name, folder)
    master = folder / "master.mp4"
    if not _valid_build(folder, lock, _environment()):
        raise core.Fail("render_stale", "当前成片或配套文件与已锁定版本不符，请重新 render。", 5)
    meta = probe(master)
    v = first_stream(meta, "video") or {}
    a = first_stream(meta, "audio") or {}
    s = first_stream(meta, "subtitle") or {}
    errors = []

    def check(ok, code):
        if not ok:
            errors.append({"code": code})

    expected = lock["video"]
    fps = expected["fps"]
    check(
        (v.get("width"), v.get("height"), v.get("codec_name"))
        == (expected["width"], expected["height"], "h264"),
        "video_format",
    )
    check(Fraction(v.get("avg_frame_rate", "0")) == fps, "frame_rate")
    pts = call(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp",
            "-of",
            "json",
            master,
        ]
    ).stdout
    frames = json.loads(pts)["frames"]
    base = Fraction(v.get("time_base", "1"))
    check(
        len(frames) == lock["frames"]
        and all(
            abs(int(f["best_effort_timestamp"]) * base - Fraction(i, fps)) <= base
            for i, f in enumerate(frames)
            if "best_effort_timestamp" in f
        )
        and all("best_effort_timestamp" in f for f in frames),
        "video_clock",
    )
    check(
        a.get("codec_name") == "aac"
        and a.get("sample_rate") == str(SAMPLE_RATE)
        and a.get("channels") == 2,
        "audio_format",
    )
    audio_seconds = Fraction(a.get("duration", "0"))
    check(abs(audio_seconds - Fraction(lock["samples"], SAMPLE_RATE)) < Fraction(1, 48), "audio_clock")
    check(abs(audio_seconds - Fraction(len(frames), fps)) <= Fraction(1, fps), "av_sync")
    check(
        s.get("codec_name") == "mov_text" and s.get("disposition", {}).get("default") == 1,
        "subtitle_stream",
    )
    if s:
        actual = call(
            ["ffmpeg", "-nostdin", "-v", "error", "-i", master, "-map", "0:s:0", "-f", "srt", "-"]
        ).stdout.decode()
        check(actual.strip() == subtitles(lock["subtitles"]).strip(), "subtitle_text_or_clock")
    check(
        meta["format"].get("tags", {}).get("comment", "") == "\n".join(lock["credits"]), "missing_credit"
    )
    levels = measure_output(master)
    check(levels["integrated_lufs"] is not None and levels["integrated_lufs"] > -60, "silent_audio")
    screenshots = []
    for i, shot in enumerate(lock["shots"]):
        at = (shot["start_frame"] + shot["frames"] // 2) / fps
        preview = folder / "frames" / f"{i + 1:03d}.jpg"
        preview.parent.mkdir(exist_ok=True)
        if preview.is_symlink():
            raise core.Fail("invalid_path", "抽帧输出不可为符号链接。", 5)
        call(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-ss",
                f"{at:.8f}",
                "-i",
                master,
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                "scale=320:-2",
                preview,
            ]
        )
        screenshots.append(
            {"shot_id": shot["id"], "seconds": at, "path": str(preview.relative_to(folder))}
        )
    editorial = list(plan["review"])
    for entry in levels["black_intervals"]:
        if entry["start"] < float(audio_seconds) - 0.12 and entry["end"] > 0.12:
            errors.append({"code": "black_picture", **entry})
    for shot in lock["shots"]:
        if shot["kind"] == "motion":
            editorial.append(
                {
                    "code": "review_action",
                    "shot_id": shot["id"],
                    "playback_rate": shot["playback_rate"],
                    "seconds": shot["start_frame"] / fps,
                }
            )
    report = {
        "schema_version": 1,
        "edition": name,
        "passed": not errors,
        "errors": errors,
        "manual_review": editorial,
        "motion_summary": plan["motion_summary"],
        "decoded_frames": len(frames),
        "frames_per_second": fps,
        "voice_samples": lock["samples"],
        "audio_seconds": float(audio_seconds),
        "subtitles": len(lock["subtitles"]),
        "credits": lock["credits"],
        "loudness": levels,
        "shots": screenshots,
        "timeline_sha256": lock["timeline_sha256"],
        "master_sha256": digest(master),
    }
    core.atomic_json(folder / "report.json", report)
    if errors:
        raise core.Fail(
            "verification_failed",
            "成片验收未通过。",
            5,
            errors=errors,
            report=str(folder / "report.json"),
        )
    return {
        "passed": True,
        "report": str(folder / "report.json"),
        "decoded_frames": len(frames),
        "manual_review": editorial,
        "motion_summary": plan["motion_summary"],
        "loudness": levels,
    }


def handle(args, work: Path):
    work = Path(work).resolve()
    with core.work_lock(work):
        name, folder = _resolve(work, args.edition)
        if args.command == "plan":
            lockfile = folder / "timeline.lock.json"
            try:
                plan, lock = compile_plan(work, name)
            except core.Fail:
                lockfile.unlink(missing_ok=True)
                raise
            if plan["renderable"]:
                core.atomic_json(lockfile, lock)
            else:
                lockfile.unlink(missing_ok=True)
            core.atomic_json(folder / "plan.json", plan)
            return {**plan, "plan": str(folder / "plan.json")}
        if args.command == "render":
            return _render(work, name, folder)
        if args.command == "verify":
            return _verify(work, name, folder)
        raise core.Fail("unknown_command", "未知媒体命令。")
