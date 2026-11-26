import json
import math
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest
from PIL import Image

from poemfilm import core
from poemfilm.cli import invoke

pytestmark = pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="offline media tests need ffmpeg and ffprobe",
)


def run(work, *args):
    return invoke(["--work", str(work), "--json", *args])


def make_wav(path, seconds):
    sr = 48000
    samples = (round(11000 * math.sin(2 * math.pi * 170 * i / sr)) for i in range(round(seconds * sr)))
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, sr, 0, "NONE", "not compressed"))
        out.writeframes(b"".join(struct.pack("<h", value) for value in samples))


@pytest.fixture
def project(tmp_path):
    poem = tmp_path / "原词.txt"
    poem.write_text("谁怕？\n", encoding="utf-8")
    work = tmp_path / "作品"
    assert run(work, "init", str(work), "--poem", str(poem), "--edition", "初版")[0] == 0
    cfg = core.load_work(work)
    cfg["video"] = {"width": 160, "height": 90, "fps": 24}
    core.save_work(work, cfg)
    still = work / "assets" / "竹.png"
    Image.new("RGB", (320, 180), (48, 112, 61)).save(still)
    ed = core.load_edition(work, "初版")
    ed["credits"] = ["原词：苏轼"]
    ed["shots"] = [{"id": "rain", "line_id": "line-01"}]
    core.write_yaml(core.edition_path(work, "初版"), ed)
    voice = tmp_path / "原声.wav"
    make_wav(voice, 0.5)
    for kind, path, target in (("voice", voice, "line-01"), ("art", still, "rain")):
        status, response = run(
            work,
            "import",
            kind,
            "--file",
            str(path),
            "--target",
            target,
            "--source",
            "本地测试",
            "--license",
            "测试用",
        )
        assert status == 0, response
        assert run(work, "select", kind, response["data"]["id"])[0] == 0
    return work


def test_offline_plan_render_verify_and_resume(project):
    code, plan = run(project, "plan")
    assert code == 0 and plan["data"]["renderable"]
    code, first = run(project, "render")
    assert code == 0, first
    main = Path(first["data"]["master"])
    stamp = main.stat().st_mtime_ns
    assert run(project, "render")[1]["data"]["cached"]
    assert main.stat().st_mtime_ns == stamp
    code, result = run(project, "verify")
    assert code == 0, result
    report = json.loads(Path(result["data"]["report"]).read_text())
    assert report["decoded_frames"] == 12 and report["subtitles"] == 1
    assert report["loudness"]["integrated_lufs"] > -60
    assert any(item["code"] == "listen_pronunciation" for item in report["manual_review"])
    assert "苏轼" in (main.parent / "credits.txt").read_text()
    ed = core.load_edition(project, "初版")
    ed["credits"].append("署名已修订")
    core.write_yaml(core.edition_path(project, "初版"), ed)
    assert run(project, "render")[1]["error"]["code"] == "timeline_stale"
    assert run(project, "plan")[1]["data"]["renderable"]
    assert run(project, "verify")[1]["error"]["code"] == "render_stale"
    code, revised = run(project, "render")
    assert code == 0 and revised["data"]["clips_reused"] == 1
    assert "修订" in (main.parent / "credits.txt").read_text()


def test_short_action_returns_gap_and_invalidates_old_lock(project):
    assert run(project, "plan")[1]["data"]["renderable"]
    action = project / "assets" / "step.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=navy:s=160x90:r=24",
            "-frames:v",
            "6",
            "-c:v",
            "libx264",
            str(action),
        ],
        check=True,
    )
    ed = core.load_edition(project, "初版")
    ed["art"].clear()
    ed["shots"][0]["media"] = {"kind": "motion", "path": "assets/step.mp4"}
    core.write_yaml(core.edition_path(project, "初版"), ed)
    status, res = run(project, "plan")
    assert status == 0 and not res["data"]["renderable"]
    gap = next(i for i in res["data"]["issues"] if i["code"] == "motion_too_short")
    assert gap["line_id"] == "line-01" and gap["missing_ms"] == 250
    assert not (project / "build" / "初版" / "timeline.lock.json").exists()
    assert run(project, "render")[1]["error"]["code"] == "timeline_stale"


def test_selected_audio_edit_is_not_silently_reused(project):
    assert run(project, "plan")[1]["data"]["renderable"]
    ed = core.load_edition(project, "初版")
    take = core.load_candidate(project, ed["voice"]["line-01"])
    make_wav(project / take["path"], 0.7)
    assert run(project, "render")[1]["error"]["code"] == "timeline_stale"
    result = run(project, "plan")[1]["data"]
    assert not result["renderable"] and any(
        i["code"] == "candidate_content_changed" for i in result["issues"]
    )


def test_selected_art_and_edition_specific_voice_review_override(project):
    ed = core.load_edition(project, "初版")
    ed["shots"][0]["media"] = {"kind": "motion", "path": "assets/obsolete.mp4"}
    take = ed["voice"]["line-01"]
    core.write_yaml(core.edition_path(project, "初版"), ed)
    assert run(project, "edition", "fork", "初版", "复核")[0] == 0
    ed = core.load_edition(project, "复核")
    ed["voice_review"] = {
        take: {"reviewed": True, "cues": [{"start_ms": 40, "end_ms": 420, "text": "谁怕？"}]}
    }
    core.write_yaml(core.edition_path(project, "复核"), ed)
    result = run(project, "plan", "--edition", "复核")[1]["data"]
    assert result["renderable"] and result["motion_summary"]["still_shots"] == 1
    assert not any(r["code"] == "listen_pronunciation" for r in result["review"])
    lock = core.read_map(project / "build/复核/timeline.lock.json")
    assert lock["subtitles"][0]["start_sample"] == 1920
    assert lock["shots"][0]["path"] == core.load_candidate(project, ed["art"]["rain"])["path"]
    assert not core.load_candidate(project, take)["reviewed"]
    other = run(project, "plan", "--edition", "初版")[1]["data"]
    assert any(r["code"] == "listen_pronunciation" for r in other["review"])
