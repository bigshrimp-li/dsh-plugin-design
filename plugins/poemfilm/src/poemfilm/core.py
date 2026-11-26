"""Shared on-disk contracts for a work, its editions and media candidates."""

import contextlib
import fcntl
import hashlib
import json
import os
import re
import tempfile
import unicodedata
from pathlib import Path

import yaml


class Fail(Exception):
    def __init__(self, code, message, exit_code=2, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.details = details


def state_dir():
    return Path(
        os.environ.get("POEMFILM_STATE_DIR")
        or Path.home() / "Library/Application Support/poemfilm"
    ).expanduser()


def name_part(value):
    if (
        not isinstance(value, str)
        or not value.strip()
        or value in (".", "..")
        or value.startswith(".")
        or len(value.encode("utf-8")) > 180
        or any(c in "/\\:" or unicodedata.category(c) == "Cc" for c in value)
    ):
        raise Fail(
            "invalid_name", "名称须为一个有效的文件名，不能包含路径分隔符或控制字符。"
        )
    return value


def asset_path(work, value):
    if not isinstance(value, (str, Path)) or not str(value).strip():
        raise Fail("invalid_path", "作品文件路径不能为空。")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise Fail(
            "invalid_path", "素材应使用作品目录内的相对路径。", path=str(relative)
        )
    root = Path(work).resolve()
    result = (root / relative).resolve()
    if not result.is_relative_to(root) or result == root:
        raise Fail("invalid_path", "路径超出作品目录。", path=str(relative))
    return result


def sha256_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_map(path):
    path = Path(path)
    try:
        with path.open(encoding="utf-8-sig") as stream:
            data = (
                json.load(stream) if path.suffix == ".json" else yaml.safe_load(stream)
            )
    except FileNotFoundError:
        raise Fail("file_missing", "找不到文件。", path=str(path)) from None
    except (ValueError, UnicodeError, yaml.YAMLError) as exc:
        raise Fail(
            "invalid_document", "无法解析 JSON 或 YAML。", path=str(path)
        ) from exc
    if not isinstance(data, dict):
        raise Fail("invalid_document", "文件顶层必须是对象。", path=str(path))
    return data


def atomic_text(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".writing-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def atomic_json(path, data):
    atomic_text(
        path, json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    )


def write_yaml(path, data):
    atomic_text(path, yaml.safe_dump(data, allow_unicode=True, sort_keys=False))


@contextlib.contextmanager
def work_lock(work):
    root = Path(work)
    if not (root / "work.yaml").is_file():
        raise Fail(
            "work_missing", "作品不存在，请先 init 或传入 --work。", path=str(root)
        )
    with asset_path(root, ".poemfilm.lock").open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def load_work(work):
    path = asset_path(work, "work.yaml")
    if not path.is_file():
        raise Fail(
            "work_missing", "作品不存在，请先 init 或传入 --work。", path=str(work)
        )
    data = read_map(path)
    if data.get("schema_version") != 1:
        raise Fail("schema_unsupported", "作品格式版本不受支持。")
    for field in ("id", "default_edition"):
        name_part(data.get(field))
    poem = data.get("poem")
    if not isinstance(poem, dict):
        raise Fail("invalid_poem", "作品缺少原词来源。")
    original = asset_path(work, poem.get("path"))
    if not original.is_file() or sha256_file(original) != poem.get("sha256"):
        raise Fail("poem_changed", "核定原词缺失或内容已改变。", path=str(original))
    lines = data.get("lines")
    if not isinstance(lines, list) or not lines:
        raise Fail("invalid_lines", "作品至少需要一段有编号的台词。")
    ids = set()
    canonical_text = []
    for line in lines:
        if (
            not isinstance(line, dict)
            or not isinstance(line.get("text"), str)
            or not line["text"].strip()
        ):
            raise Fail("invalid_lines", "台词缺少文字。")
        key = name_part(line.get("id"))
        if key in ids or line.get("kind") not in {"poem", "narration"}:
            raise Fail("invalid_lines", "台词编号重复或类型无效。", line_id=key)
        ids.add(key)
        if line["kind"] == "poem":
            canonical_text.append(line["text"])
    if re.sub(r"\s+", "", "".join(canonical_text)) != re.sub(
        r"\s+", "", original.read_text(encoding="utf-8-sig")
    ):
        raise Fail("poem_changed", "作品中诗句的文字或顺序与锁定原词不符。")
    return data


def save_work(work, data):
    write_yaml(asset_path(work, "work.yaml"), data)


def edition_path(work, name):
    return asset_path(work, Path("editions") / (name_part(name) + ".yaml"))


def load_edition(work, name=None):
    name = name or load_work(work)["default_edition"]
    ed = read_map(edition_path(work, name))
    if ed.get("name") != name:
        raise Fail("edition_mismatch", "版本文件与版本名称不一致。", edition=name)
    for key in ("art", "voice"):
        if not isinstance(ed.get(key, {}), dict):
            raise Fail("invalid_edition", "候选选择应为对象。", field=key)
    return ed


def load_candidate(work, candidate_id):
    folder = Path("candidates") / name_part(candidate_id)
    data = read_map(asset_path(work, folder / "record.json"))
    if data.get("id") != candidate_id or data.get("kind") not in {
        "script",
        "art",
        "voice",
    }:
        raise Fail(
            "invalid_candidate", "候选信息与文件夹不一致。", candidate=candidate_id
        )
    path = asset_path(work, data.get("path"))
    if not path.is_file():
        raise Fail("file_missing", "候选文件缺失。", path=str(path))
    return data


def story(work, ed):
    data = load_work(work)
    if ed.get("script"):
        selected = load_candidate(work, ed["script"])
        if selected["kind"] != "script":
            raise Fail("invalid_candidate", "所选分镜类型不符。")
        result = read_map(asset_path(work, selected["path"]))
    else:
        result = {"lines": data["lines"], "shots": []}
    if ed.get("shots"):
        result = dict(result, shots=ed["shots"])
    for field in ("lines", "shots"):
        rows = result.get(field)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise Fail("invalid_story", "分镜字段应为列表。", field=field)
        ids = [name_part(row.get("id")) for row in rows]
        if len(set(ids)) != len(ids):
            raise Fail("invalid_story", "分镜包含重复编号。", field=field)
    original = [
        (line["id"], line["text"]) for line in data["lines"] if line["kind"] == "poem"
    ]
    selected = [
        (line["id"], line.get("text"))
        for line in result["lines"]
        if line.get("kind") == "poem"
    ]
    if selected != original:
        raise Fail("poem_changed", "分镜中的诗词文字或顺序与锁定原词不符。")
    return result


def resolve_profile(work, args):
    profile = getattr(args, "profile", None)
    if not profile and (Path(work) / "work.yaml").is_file():
        profile = load_work(work).get("profile")
    return name_part(profile) if profile else None
