"""作品创建、候选导入和版本选择。"""

import hashlib
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path

from . import core


def init_work(args):
    root = Path(args.dir).expanduser().absolute()
    edition = core.name_part(args.edition)
    source = Path(args.poem).expanduser().resolve()
    original = source.read_bytes()
    try:
        lines = [
            s.strip() for s in original.decode("utf-8-sig").splitlines() if s.strip()
        ]
    except UnicodeError as exc:
        raise core.Fail("invalid_poem", "原词文件须为 UTF-8 文本。") from exc
    if not lines:
        raise core.Fail("invalid_poem", "原词不能为空。")
    if root.is_symlink() or (
        root.exists() and (not root.is_dir() or any(root.iterdir()))
    ):
        raise core.Fail("work_exists", "作品目录须为新目录或空目录。", path=str(root))
    root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".poemfilm-init-", dir=root.parent
    ) as stage:
        # Rename a child rather than the TemporaryDirectory itself.
        draft = Path(stage) / "work"
        draft.mkdir()
        (draft / "poem.txt").write_bytes(original)
        assets = draft / "assets"
        assets.mkdir()
        references = []
        for index, item in enumerate(args.reference):
            ref = Path(item).expanduser()
            dest = assets / f"reference-{index + 1}{ref.suffix.lower()}"
            shutil.copyfile(ref, dest)
            references.append(str(dest.relative_to(draft)))
        data = {
            "schema_version": 1,
            "id": uuid.uuid4().hex,
            "title": args.title or source.stem,
            "author": args.author or "",
            "default_edition": edition,
            "poem": {
                "path": "poem.txt",
                "sha256": hashlib.sha256(original).hexdigest(),
            },
            "lines": [
                {"id": f"line-{i:02}", "kind": "poem", "text": t}
                for i, t in enumerate(lines, 1)
            ],
            "references": references,
            "image": {"size": "2048x1152", "quality": "high"},
            "video": {"width": 1920, "height": 1080, "fps": 24},
        }
        core.save_work(draft, data)
        core.write_yaml(
            core.edition_path(draft, edition),
            {
                "name": edition,
                "script": None,
                "art": {},
                "voice": {},
                "shots": [],
                "credits": [],
            },
        )
        core.load_work(draft)
        os.rename(draft, root)
    return {"work": str(root), "edition": edition, "lines": len(lines)}


def fork(work, args):
    with core.work_lock(work):
        source = core.load_edition(work, args.source)
        dest = core.edition_path(work, args.destination)
        if dest.exists():
            raise core.Fail(
                "edition_exists", "目标版本已存在。", edition=args.destination
            )
        core.write_yaml(dest, dict(source, name=args.destination))
    return {"edition": args.destination, "path": str(dest)}


def select(work, args):
    with core.work_lock(work):
        ed = core.load_edition(work, args.edition)
        record = core.load_candidate(work, args.candidate)
        kind = args.action
        if record["kind"] != kind:
            raise core.Fail("candidate_type_mismatch", "候选类型与选择命令不符。")
        if record.get("work_id") and record["work_id"] != core.load_work(work)["id"]:
            raise core.Fail("candidate_work_mismatch", "候选属于其他作品。")
        if kind == "script":
            ed["script"] = record["id"]
            core.story(work, ed)
        else:
            story = core.story(work, ed)
            rows = story["shots"] if kind == "art" else story["lines"]
            target = record.get("target")
            row = next((r for r in rows if r["id"] == target), None)
            if row is None:
                raise core.Fail(
                    "candidate_target_missing",
                    "该版分镜中找不到候选的目标。",
                    target=target,
                )
            if kind == "voice":
                if record.get("text_match") is False or record.get("text") not in {
                    None,
                    row["text"],
                }:
                    raise core.Fail(
                        "voice_text_mismatch", "音轨台词与所选分镜不符。", line=target
                    )
                if getattr(args, "reviewed", False) or getattr(args, "cues", None):
                    review = ed.setdefault("voice_review", {}).setdefault(
                        record["id"], {}
                    )
                    if args.reviewed:
                        review["reviewed"] = True
                    if args.cues:
                        cues = json.loads(Path(args.cues).read_text(encoding="utf-8"))
                        if not isinstance(cues, list) or any(
                            not isinstance(c, dict) for c in cues
                        ):
                            raise core.Fail(
                                "invalid_cues", "字幕时间码须为 JSON 对象数组。"
                            )
                        review["cues"] = cues
            ed.setdefault(kind, {})[target] = record["id"]
        core.write_yaml(core.edition_path(work, ed["name"]), ed)
    return {"edition": ed["name"], "selected": record["id"], "kind": kind}


def import_candidate(work, args):
    story = core.story(work, core.load_edition(work, args.edition))
    kind = args.action
    target = args.target
    if kind == "script":
        target = "script"
    else:
        rows = story["shots"] if kind == "art" else story["lines"]
        if target not in {row["id"] for row in rows}:
            raise core.Fail(
                "candidate_target_missing", "请用 show 查看可用目标 ID。", target=target
            )
    source = Path(args.file).expanduser()
    if not source.is_file():
        raise core.Fail("file_missing", "找不到导入的素材文件。", path=str(source))
    digest = core.sha256_file(source)
    suffix = source.suffix.lower()
    if kind == "script":
        core.read_map(source)
        if suffix not in {".json", ".yaml", ".yml"}:
            raise core.Fail("invalid_script", "分镜须为 JSON 或 YAML。")
    cue_data = None
    if args.cues:
        cue_data = json.loads(Path(args.cues).read_text(encoding="utf-8"))
        if not isinstance(cue_data, list):
            raise core.Fail("invalid_cues", "字幕时间码须为 JSON 数组。")
    metadata = [
        kind,
        target,
        digest,
        suffix,
        args.source,
        args.license,
        args.reviewed,
        cue_data,
    ]
    fingerprint = hashlib.sha256(
        json.dumps(metadata, ensure_ascii=False).encode()
    ).hexdigest()
    candidate = f"{kind}-{fingerprint[:24]}"
    folder = core.asset_path(work, Path("candidates") / candidate)
    with core.work_lock(work):
        if not folder.is_dir():
            folder.parent.mkdir(exist_ok=True, parents=True)
            with tempfile.TemporaryDirectory(
                dir=folder.parent, prefix=".import-"
            ) as temp:
                stage = Path(temp) / "item"
                stage.mkdir()
                dest = stage / ("asset" + suffix)
                shutil.copyfile(source, dest)
                if core.sha256_file(dest) != digest:
                    raise core.Fail(
                        "source_changed", "导入过程中源文件发生变化，请重新导入。"
                    )
                rec = {
                    "id": candidate,
                    "kind": kind,
                    "target": target,
                    "work_id": core.load_work(work)["id"],
                    "path": str((folder / dest.name).relative_to(work)),
                    "sha256": digest,
                    "source": args.source,
                    "license": args.license,
                }
                if kind == "voice":
                    rec["reviewed"] = args.reviewed
                    if cue_data is not None:
                        rec["cues"] = cue_data
                core.atomic_json(stage / "record.json", rec)
                os.rename(stage, folder)
        record = core.load_candidate(work, candidate)
    return record


def describe(work, args):
    data = core.load_work(work)
    ed = core.load_edition(work, args.edition)
    script = core.story(work, ed)
    return {
        "work": str(work),
        "title": data["title"],
        "edition": ed["name"],
        "lines": script["lines"],
        "shots": script["shots"],
        "selected": {key: ed.get(key) for key in ("script", "art", "voice")},
    }
