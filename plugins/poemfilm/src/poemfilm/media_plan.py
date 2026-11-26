"""Build an edition-specific timeline from real audio samples and source media."""

import math
from fractions import Fraction
from itertools import groupby

from . import core
from .media_tools import SAMPLE_RATE, digest, duration, first_stream, near, probe, stamp


def letters(text):
    return "".join(c for c in text if c.isalnum())


def integer(value, field, low=0, high=None):
    if type(value) is not int or value < low or (high is not None and value > high):
        raise core.Fail("invalid_media_data", "媒体参数超出可用范围。", field=field)
    return value


def compile_plan(work, name):
    cfg = core.load_work(work)
    edition = core.load_edition(work, name)
    script = core.story(work, edition)
    video = cfg.get("video", {})
    fps = integer(video.get("fps", 24), "video.fps", 1, 120)
    width = integer(video.get("width", 1920), "video.width", 16, 8192)
    height = integer(video.get("height", 1080), "video.height", 16, 8192)
    if width % 2 or height % 2:
        raise core.Fail("invalid_media_data", "H.264 画面宽高必须为偶数。", field="video")
    video = {"width": width, "height": height, "fps": fps}
    issues, reviews, assets, probes = [], [], {}, {}
    selected = {}

    def issue(code, **fields):
        issues.append({"code": code, **fields})

    def inspect(rel):
        if not isinstance(rel, str) or not rel:
            raise core.Fail("invalid_media_data", "素材缺少作品内的文件路径。")
        path = core.asset_path(work, rel)
        if rel not in assets:
            if not path.is_file():
                issue("asset_missing", path=rel)
                return None
            assets[rel] = digest(path)
            try:
                probes[rel] = probe(path)
            except core.Fail as exc:
                if exc.code == "media_tool_missing":
                    raise
                issue("unreadable_asset", path=rel)
                probes[rel] = None
        return probes[rel]

    def candidate(kind, target):
        ident = edition.get(kind, {}).get(target)
        if not ident:
            issue("voice_missing" if kind == "voice" else "art_missing", target_id=target)
            return None
        try:
            item = core.load_candidate(work, ident)
        except core.Fail as exc:
            if exc.code != "file_missing":
                raise
            issue("candidate_missing", candidate_id=ident, target_id=target)
            return None
        if (
            item.get("kind") != kind
            or item.get("target") != target
            or item.get("work_id", cfg["id"]) != cfg["id"]
        ):
            issue("candidate_mismatch", candidate_id=ident, target_id=target)
            return None
        selected[ident] = item
        return item

    def open_media(rel, ident):
        try:
            return inspect(rel)
        except core.Fail as exc:
            issue(exc.code, target_id=ident, path=rel)
            return None

    controls = edition.get("credits", [])
    if not isinstance(controls, list) or any(not isinstance(x, str) for x in controls):
        raise core.Fail("invalid_media_data", "署名须为字符串列表。", field="credits")
    credits = list(dict.fromkeys(controls))
    review_by_take = edition.get("voice_review", {})
    if not isinstance(review_by_take, dict):
        raise core.Fail("invalid_media_data", "该版声音核听记录须为对象。", field="voice_review")
    base_lines = cfg.get("lines", [])
    lines = {line["id"]: line for line in script.get("lines", base_lines)}
    source_shots = edition.get("shots") or script.get("shots", [])
    if not source_shots:
        issue("story_missing")
    ids = [shot.get("id") for shot in source_shots]
    if any(not isinstance(x, str) or not x for x in ids) or len(set(ids)) != len(ids):
        raise core.Fail("invalid_media_data", "每个镜头需要作品内唯一的名称。", field="shots.id")
    voice_segments, shots, cues = [], [], []
    seen = set()
    sample = 0
    spoken_poem = []
    for line_id, group in groupby(source_shots, key=lambda s: s.get("line_id")):
        group = list(group)
        line = lines.get(line_id)
        if not line or line_id in seen:
            issue("line_missing_or_repeated", line_id=line_id)
            continue
        seen.add(line_id)
        text = line.get("text", "")
        if line.get("kind") == "poem":
            spoken_poem.append(text)
        take = candidate("voice", line_id)
        length = None
        if take:
            rel = take.get("path")
            media = open_media(rel, line_id)
            stream = first_stream(media, "audio") if media else None
            if not stream:
                issue("audio_stream_missing", line_id=line_id)
            else:
                length = near(duration(stream, media) * SAMPLE_RATE)
                if length <= 0:
                    issue("empty_audio", line_id=line_id)
                    length = None
            if length:
                voice_segments.append(
                    {
                        "line_id": line_id,
                        "path": rel,
                        "sha256": assets[rel],
                        "start_sample": sample,
                        "samples": length,
                        "text": text,
                    }
                )
                review = review_by_take.get(take["id"], {})
                if not isinstance(review, dict) or (
                    "reviewed" in review and type(review["reviewed"]) is not bool
                ):
                    raise core.Fail(
                        "invalid_media_data",
                        "录音核听标记无效。",
                        field="voice_review",
                        candidate_id=take["id"],
                    )
                if review.get("reviewed", take.get("reviewed")) is not True:
                    reviews.append(
                        {"code": "listen_pronunciation", "line_id": line_id, "candidate_id": take["id"]}
                    )
                parts = review.get("cues", take.get("cues"))
                if parts is None:
                    local = [(0, length, text)]
                else:
                    if not isinstance(parts, list):
                        raise core.Fail("invalid_media_data", "分句时间码须为列表。", field="cues")
                    local = []
                    for part in parts:
                        if not isinstance(part, dict):
                            raise core.Fail("invalid_media_data", "分句时间码须为对象。", field="cues")
                        lo = integer(part.get("start_ms"), "cues.start_ms") * 48
                        hi = integer(part.get("end_ms"), "cues.end_ms") * 48
                        # Imported millisecond endpoints can round half a millisecond past a WAV.
                        if hi - length <= 24:
                            hi = min(hi, length)
                        local.append((lo, hi, part.get("text", "")))
                if not local or any(
                    not isinstance(t, str)
                    or not t.strip()
                    or lo < 0
                    or hi > length
                    or hi <= lo
                    or (i and lo < local[i - 1][1])
                    for i, (lo, hi, t) in enumerate(local)
                ):
                    issue("invalid_voice_cues", line_id=line_id)
                elif letters("".join(t for _, _, t in local)) != letters(text):
                    issue("subtitle_text_mismatch", line_id=line_id)
                else:
                    cues.extend(
                        {
                            "line_id": line_id,
                            "start_sample": sample + lo,
                            "end_sample": sample + hi,
                            "text": t,
                        }
                        for lo, hi, t in local
                    )
        remaining = []
        fixed = 0
        specs = []
        for index, shot in enumerate(group):
            ident = shot["id"]
            spec = shot.get("media")
            if ident in edition.get("art", {}) or not spec:
                art = candidate("art", ident)
                spec = {"kind": "still", "path": art.get("path")} if art else {}
            if not isinstance(spec, dict):
                raise core.Fail("invalid_media_data", "画面素材须为对象。", field="media")
            rel = spec.get("path")
            if spec and not rel:
                issue("asset_path_missing", shot_id=ident)
            media = open_media(rel, ident) if rel else None
            kind = spec.get("kind")
            capacity = None
            start_ms = integer(spec.get("in_ms", 0), "media.in_ms")
            out_ms = spec.get("out_ms")
            if out_ms is not None:
                integer(out_ms, "media.out_ms", start_ms + 1)
            if spec.get("playback_rate", 1) != 1 or shot.get("playback_rate", 1) != 1:
                issue("non_native_speed", shot_id=ident)
            if media:
                stream = first_stream(media, "video")
                if not stream or kind not in {"motion", "still"}:
                    issue("invalid_visual", shot_id=ident)
                else:
                    fmt = set(media["format"]["format_name"].split(","))
                    still = bool(fmt & {"png_pipe", "jpeg_pipe", "webp_pipe", "bmp_pipe", "image2"})
                    if (kind == "still") != still or (still and (start_ms or out_ms is not None)):
                        issue("visual_type_mismatch", shot_id=ident)
                    if kind == "motion":
                        source_end = duration(stream, media)
                        if out_ms is not None:
                            desired_end = Fraction(out_ms, 1000)
                            if desired_end > source_end + Fraction(1, 2000):
                                issue(
                                    "source_range_invalid",
                                    shot_id=ident,
                                    source_ms=near(source_end * 1000),
                                )
                            source_end = min(source_end, desired_end)
                        capacity = max(Fraction(), source_end - Fraction(start_ms, 1000))
                    else:
                        reviews.append({"code": "limited_animation", "shot_id": ident})
            credit = spec.get("credit")
            if isinstance(credit, str) and credit and credit not in credits:
                credits.append(credit)
            value = shot.get("duration_ms")
            if value is None:
                remaining.append(index)
            else:
                fixed += integer(value, "duration_ms", 1) * 48
            specs.append((ident, rel, kind, start_ms, capacity, value))
        if length is None:
            continue
        leftover = length - fixed
        if len(remaining) > 1 or (remaining and leftover <= 0) or (not remaining and abs(leftover) > 24):
            issue(
                "line_duration_mismatch",
                line_id=line_id,
                voice_samples=length,
                allocated_samples=fixed,
                unspecified_shots=len(remaining),
            )
            sample += length
            continue
        cursor = sample
        for index, (ident, rel, kind, start_ms, capacity, value) in enumerate(specs):
            ns = leftover if value is None else value * 48
            if index == len(specs) - 1:
                ns = sample + length - cursor
            start_frame = near(Fraction(cursor * fps, SAMPLE_RATE))
            end_frame = near(Fraction((cursor + ns) * fps, SAMPLE_RATE))
            frames = end_frame - start_frame
            if frames < 1:
                issue("shot_too_short", shot_id=ident)
            if capacity is not None and frames > near(capacity * fps):
                issue(
                    "motion_too_short",
                    shot_id=ident,
                    line_id=line_id,
                    target_ms=near(Fraction(ns * 1000, SAMPLE_RATE)),
                    source_ms=near(capacity * 1000),
                    missing_ms=max(0, near(Fraction(ns * 1000, SAMPLE_RATE) - capacity * 1000)),
                )
            shots.append(
                {
                    "id": ident,
                    "line_id": line_id,
                    "kind": kind,
                    "path": rel,
                    "in_ms": start_ms,
                    "out_ms": start_ms + near(Fraction(frames * 1000, fps)) if kind == "motion" else None,
                    "start_frame": start_frame,
                    "frames": frames,
                    "start_sample": cursor,
                    "samples": ns,
                    "sha256": assets.get(rel),
                    "playback_rate": 1,
                }
            )
            cursor += ns
        sample += length
    expected = "".join(x["text"] for x in base_lines if x.get("kind") == "poem")
    if not expected or letters("".join(spoken_poem)) != letters(expected):
        issue("poem_incomplete_or_changed")
    ambience = edition.get("ambience")
    if ambience:
        if not isinstance(ambience, dict):
            raise core.Fail("invalid_media_data", "环境音配置须为对象。", field="ambience")
        rel = ambience.get("path")
        media = open_media(rel, "ambience")
        if media and not first_stream(media, "audio"):
            issue("audio_stream_missing", target_id="ambience")
        gain = ambience.get("gain_db", -15)
        if type(gain) not in (int, float) or not math.isfinite(gain) or not -96 <= gain <= 12:
            raise core.Fail("invalid_media_data", "环境音增益应介于 -96 和 +12 dB。", field="gain_db")
        ambience = {"path": rel, "sha256": assets.get(rel), "gain_db": gain}
    for item in selected.values():
        if item.get("sha256") and item["sha256"] != assets.get(item.get("path")):
            issue("candidate_content_changed", candidate_id=item["id"])
        if item.get("ai_generated") and item.get("kind") == "voice":
            label = "本片部分声音由 AI 合成（" + str(item.get("model") or "合成语音") + "）"
            if label not in credits:
                credits.append(label)
        credit = " · ".join(str(item[k]) for k in ("source", "license") if item.get(k))
        if credit and credit not in credits:
            credits.append(credit)
    lock = {
        "schema_version": 1,
        "work_id": cfg["id"],
        "edition": name,
        "title": cfg.get("title", ""),
        "author": cfg.get("author", ""),
        "video": video,
        "sample_rate": SAMPLE_RATE,
        "samples": sample,
        "frames": near(Fraction(sample * fps, SAMPLE_RATE)),
        "shots": shots,
        "voices": voice_segments,
        "subtitles": cues,
        "credits": credits,
        "ambience": ambience,
        "inputs": assets,
        "configuration_sha256": stamp([cfg, edition, script, selected]),
    }
    if sample and not lock["frames"]:
        issue("empty_video")
    lock["timeline_sha256"] = stamp(lock)
    coverage = {}
    for kind in ("motion", "still"):
        matching = [shot for shot in shots if shot["kind"] == kind]
        nframes = sum(shot["frames"] for shot in matching)
        coverage.update(
            {f"{kind}_shots": len(matching), f"{kind}_frames": nframes, f"{kind}_seconds": nframes / fps}
        )
    return {
        "schema_version": 1,
        "edition": name,
        "renderable": not issues,
        "issues": issues,
        "motion_summary": coverage,
        "review": reviews,
        "frames": lock["frames"],
        "samples": sample,
        "sample_rate": SAMPLE_RATE,
        "timeline_sha256": lock["timeline_sha256"] if not issues else None,
    }, lock
