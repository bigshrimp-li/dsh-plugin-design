"""Generate immutable candidates; selecting them is a separate editorial decision."""

import base64
import hashlib
import io
import json
import os
import re
import time
import unicodedata
import wave
from datetime import datetime
from decimal import Decimal, InvalidOperation
from itertools import groupby
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image

from . import core, funding, providers

MODEL = providers.MODELS
ART_PRICES = {
    "1024x1024": {"low": "0.006", "medium": "0.053", "high": "0.211"},
    "1536x1024": {"low": "0.005", "medium": "0.041", "high": "0.165"},
    "1024x1536": {"low": "0.005", "medium": "0.041", "high": "0.165"},
}
PROMPT_VERSION = 1
STRING = {"type": "string"}
MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


def object_schema(fields):
    return {
        "type": "object",
        "properties": fields,
        "required": list(fields),
        "additionalProperties": False,
    }


LINE_SCHEMA = object_schema(
    {"id": STRING, "kind": {"type": "string", "enum": ["poem", "narration"]}, "text": STRING}
)
SHOT_SCHEMA = object_schema({"id": STRING, "line_id": STRING, "prompt": STRING})
STORY_SCHEMA = object_schema(
    {
        "lines": {"type": "array", "items": LINE_SCHEMA},
        "shots": {"type": "array", "items": SHOT_SCHEMA},
    }
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(data):
    return json.dumps(
        data, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def as_text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise core.Fail("invalid_generation_input", f"{label}不能为空。")
    return value


def find(rows, target, label):
    for row in rows:
        if row.get("id") == target:
            return row
    raise core.Fail("unknown_target", f"未找到指定的{label}。", target=target)


def script_spec(cfg):
    authored = {key: cfg.get(key) for key in ("author", "title", "lines")}
    return {
        "model": MODEL["script"],
        "store": False,
        "service_tier": "default",
        "max_output_tokens": providers.TEXT_LIMIT,
        "instructions": (
            "为这首诗词设计中式动漫分镜。先由诗人用第一人称自然交代处境，再由他朗读全词。"
            "输入中的每条原词必须原样保留编号、标点、字句和先后顺序。自述用 narration 类型，"
            "不能冒充原词或捏造确切史实。所有台词按播放次序列出，镜头也依同一次序覆盖每条台词。"
            "prompt 写清人物、地点、连续动作与光线，一个镜头只引用一个 line_id。"
        ),
        "input": canonical(authored).decode(),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "storyboard",
                "strict": True,
                "schema": STORY_SCHEMA,
            }
        },
    }


def image_settings(cfg):
    settings = cfg.get("image", {})
    if not isinstance(settings, dict):
        raise core.Fail("invalid_image_settings", "作品 image 应是含 size 和 quality 的对象。")
    size = settings.get("size", "1536x864")
    quality = settings.get("quality", "medium")
    if not isinstance(size, str) or not re.fullmatch(r"[1-9][0-9]{1,3}x[1-9][0-9]{1,3}", size):
        raise core.Fail("invalid_image_settings", "图片尺寸应为 WIDTHxHEIGHT。")
    width, height = map(int, size.split("x"))
    if (
        width % 16
        or height % 16
        or max(width, height) > 3840
        or max(width, height) > 3 * min(width, height)
        or not 655360 <= width * height <= 8294400
    ):
        raise core.Fail(
            "invalid_image_settings",
            "GPT Image 2 尺寸应为16的倍数、长宽比至多3:1，边长和总像素应在模型范围内。",
        )
    if quality not in ("low", "medium", "high"):
        raise core.Fail("invalid_image_settings", "GPT Image 2 画质可选 low、medium、high。")
    return size, quality


def read_refs(work, paths, *, include_bytes):
    if not isinstance(paths, list) or len(paths) > 16:
        raise core.Fail("invalid_reference", "参考图必须是列表，每次编辑最多16张。")
    refs, info = [], []
    for rel in paths:
        path = core.asset_path(work, rel)
        if not path.is_file() or path.stat().st_size > 50_000_000:
            raise core.Fail("invalid_reference", "参考图不存在或超过50 MB。", path=str(rel))
        raw = path.read_bytes()
        try:
            with Image.open(io.BytesIO(raw)) as im:
                mime = MIME[im.format]
                pixels = im.width * im.height
                im.verify()
        except (OSError, ValueError, KeyError, Image.DecompressionBombError) as exc:
            raise core.Fail(
                "invalid_reference", "参考图须为有效的 PNG、JPEG 或 WebP。", path=str(rel)
            ) from exc
        info.append({"sha256": digest(raw), "pixels": pixels, "bytes": len(raw)})
        if include_bytes:
            refs.append({"mime": mime, "data": raw})
    return refs, info


def prepare(work, cfg, ed, args):
    kind = args.action
    if kind == "script":
        return "script", script_spec(cfg), {}
    story = core.story(work, ed)
    if kind == "voice":
        row = find(story["lines"], args.line, "台词")
        text = as_text(row.get("text"), "台词")
        delivery = as_text(getattr(args, "delivery", None) or "自然", "演绎方式")
        spec = {
            "text": text,
            "voice": "marin",
            "instructions": (
                "用自然的普通话逐字朗读用户给出的原文，只输出该段朗读。保留原顺序，不补称呼或解释。"
                "将下面作为演绎指导，不要将指导念出：" + delivery
            ),
        }
        return row["id"], spec, {"text": text, "expected_text": text, "delivery": delivery}
    if kind != "art":
        raise core.Fail("invalid_command", "未知生成类型。")
    row = find(story["shots"], args.shot, "镜头")
    line = find(story["lines"], row.get("line_id"), "台词")
    prompt = as_text(row.get("prompt"), "镜头描述")
    prompt = "请绘制中国二维动漫原画，宽银幕画满，画面无字幕或水印。\n" + prompt
    prompt += "\n本镜的台词仅用作情绪参考，不要画成文字：" + line["text"]
    size, quality = image_settings(cfg)
    refs, info = read_refs(
        work, cfg.get("references", []), include_bytes=not getattr(args, "estimate_only", False)
    )
    spec = {
        "model": MODEL["art"],
        "prompt": prompt,
        "size": size,
        "quality": quality,
        "n": 1,
        "output_format": "png",
    }
    if info:
        spec["images"] = refs
    return row["id"], spec, {"prompt": prompt, "references": info, "size": size, "quality": quality}


def validate_story(data, original):
    if not isinstance(data, dict) or set(data) != {"lines", "shots"}:
        raise ValueError("分镜缺少 lines 或 shots")
    for key, fields in (("lines", LINE_SCHEMA["required"]), ("shots", SHOT_SCHEMA["required"])):
        rows = data[key]
        if not isinstance(rows, list) or not rows:
            raise ValueError("分镜列表为空")
        for row in rows:
            if (
                not isinstance(row, dict)
                or set(row) != set(fields)
                or any(not isinstance(row[f], str) or not row[f].strip() for f in fields)
            ):
                raise ValueError("分镜行缺少字段")
        ids = [core.name_part(row["id"]) for row in rows]
        if len(set(ids)) != len(ids):
            raise ValueError("分镜编号重复")
    lines = data["lines"]
    if any(row["kind"] not in {"poem", "narration"} for row in lines):
        raise ValueError("未知台词类型")

    def poem(rows):
        return [(r["id"], r["text"]) for r in rows if r["kind"] == "poem"]

    if poem(lines) != poem(original):
        raise ValueError("原词编号、文字或顺序改变")
    if [key for key, _ in groupby(row["line_id"] for row in data["shots"])] != [
        row["id"] for row in lines
    ]:
        raise ValueError("镜头没有依台词顺序完整覆盖")
    return data


def quote(work, profile, kind, spec, meta):
    upper = providers.upper(kind)
    rates = providers.PRICING
    result = {
        "model": MODEL[kind],
        "upper_usd": str(upper) if upper is not None else None,
        "pricing_version": rates,
        "source": providers.PRICE_SOURCE,
        "basis": "model_input_limit_and_output_cap",
    }
    if kind != "art":
        return result
    result.update(
        basis="output_calculator_is_an_estimate",
        source="https://developers.openai.com/api/docs/guides/image-generation#calculating-costs",
    )
    size, quality = spec["size"], spec["quality"]
    width, height = map(int, size.split("x"))
    reference = size if size in ART_PRICES else ("1536x1024" if width >= height else "1024x1536")
    result.update(
        size=size,
        quality=quality,
        reference_output_price={
            "usd": ART_PRICES[reference][quality],
            "size": reference,
            "quality": quality,
            "matches_requested_size": size == reference,
            "includes_inputs": False,
            "source": "https://developers.openai.com/api/docs/guides/image-generation#historical-output-costs",
            "note": "仅为官方示例中该规格的单图输出价。输入文字和参考图另计，不能用作整次费用上限。",
        },
    )
    if not profile:
        return result
    reqs = {
        "max_prompt_bytes": len(spec["prompt"].encode()),
        "max_reference_count": len(meta["references"]),
        "max_reference_pixels": sum(r["pixels"] for r in meta["references"]),
        "max_reference_bytes": sum(r["bytes"] for r in meta["references"]),
    }
    endpoint = "/v1/images/edits" if "images" in spec else "/v1/images/generations"
    matches = []
    try:
        approvals = funding.price_bounds(work, profile)
    except core.Fail as exc:
        if exc.code != "funding_profile_mismatch":
            raise
        approvals = []
    for row in approvals:
        try:
            host = urlsplit(row["source_url"])
            if (
                row["basis"] != "supplier_guaranteed_per_request"
                or row["provider"] != "openai"
                or row["model"] != spec["model"]
                or row["endpoint"] != endpoint
                or row["size"] != spec["size"]
                or row["quality"] != spec["quality"]
                or host.scheme != "https"
                or not (
                    host.hostname == "openai.com" or (host.hostname or "").endswith(".openai.com")
                )
            ):
                continue
            until = datetime.fromisoformat(row["valid_until"])
            if until.tzinfo is None or until.timestamp() <= time.time() + providers.TIMEOUT:
                continue
            if any(type(row[k]) is not int or row[k] < v for k, v in reqs.items()):
                continue
            usd = Decimal(str(row["upper_usd"]))
            if (
                not usd.is_finite()
                or usd <= 0
                or any(not row[k] for k in ("version", "approval_digest", "evidence_sha256"))
            ):
                continue
            matches.append((usd, row))
        except (KeyError, TypeError, ValueError, InvalidOperation):
            continue
    if matches:
        usd, row = min(matches, key=lambda x: x[0])
        result.update(
            upper_usd=str(usd),
            basis=row["basis"],
            source=row["source_url"],
            approval_digest=row["approval_digest"],
            supplier_quote_version=row["version"],
            valid_until=row["valid_until"],
        )
    return result


def letters(text):
    return "".join(
        c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P")
    )


def material(kind, reply, cfg, meta):
    if kind == "script":
        if reply.payload.get("status") != "completed":
            raise ValueError("分镜响应未完整完成")
        parts = [
            p for m in reply.payload["output"] if m.get("type") == "message" for p in m["content"]
        ]
        if any(p.get("type") == "refusal" for p in parts):
            raise ValueError("模型拒绝输出分镜")
        document = json.loads("".join(p["text"] for p in parts if p.get("type") == "output_text"))
        validate_story(document, cfg["lines"])
        return "storyboard.json", json.dumps(document, ensure_ascii=False, indent=2).encode(), {}
    if kind == "art":
        data = reply.payload["data"]
        if len(data) != 1:
            raise ValueError("应只返回一张画面")
        png = base64.b64decode(data[0]["b64_json"], validate=True)
        with Image.open(io.BytesIO(png)) as im:
            if im.format != "PNG" or f"{im.width}x{im.height}" != meta["size"]:
                raise ValueError("返回图片规格不符")
            im.load()
        return "art.png", png, {}
    if reply.payload.get("status") != "completed" or not reply.pcm or len(reply.pcm) % 2:
        raise ValueError("朗读未完整完成或 PCM 无效")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(reply.pcm)
    transcript = reply.transcript
    if not isinstance(transcript, str):
        raise TypeError("返回转写类型无效")
    matched = bool(transcript) and letters(transcript) == letters(meta["expected_text"])
    return (
        "voice.wav",
        buf.getvalue(),
        {
            "transcript": transcript,
            "text_match": matched,
            "reviewed": False,
            "review_status": "transcript_matched" if matched else "needs_review",
            "duration_s": len(reply.pcm) / 48000,
            "ai_generated": True,
        },
    )


def cached(work, ident, fingerprint):
    if not core.asset_path(work, f"candidates/{ident}/record.json").is_file():
        return None
    old = core.load_candidate(work, ident)
    if old.get("fingerprint") != fingerprint or core.sha256_file(
        core.asset_path(work, old["path"])
    ) != old.get("sha256"):
        raise core.Fail(
            "cache_corrupt", "候选内容与原指纹不一致，请修复本地文件。", candidate_id=ident
        )
    return dict(old, candidate_id=ident, cached=True, request_sent=False)


def handle(args, work: Path):
    cfg = core.load_work(work)
    ed = core.load_edition(work, getattr(args, "edition", None))
    kind = args.action
    target, spec, meta = prepare(work, cfg, ed, args)
    params = dict(spec)
    if "images" in params:
        params["images"] = meta["references"]
    take = str(getattr(args, "take", None) or "1")
    fingerprint = digest(
        canonical(
            [
                PROMPT_VERSION,
                cfg["id"],
                cfg["poem"]["sha256"],
                kind,
                target,
                MODEL[kind],
                params,
                take,
            ]
        )
    )
    ident = f"{kind}-{fingerprint[:24]}"
    hit = cached(work, ident, fingerprint)
    preview = bool(getattr(args, "estimate_only", False))
    if hit:
        if preview:
            return {
                "candidate_id": ident,
                "cached": True,
                "upper_usd": "0",
                "estimate_only": True,
                "request_sent": False,
            }
        return hit
    profile = core.resolve_profile(work, args)
    bound = quote(work, profile, kind, spec, meta)
    if preview:
        return dict(bound, estimate_only=True, cached=False, request_sent=False)
    if not bound["upper_usd"]:
        raise core.Fail(
            "pricing_unbounded",
            "供应商未为此规格提供可核验的整次费用上界。",
            3,
            request_sent=False,
            **bound,
        )
    scope = "script" if kind == "script" else kind + ":" + target
    options = {"approval_digest": bound["approval_digest"]} if "approval_digest" in bound else {}
    base = core.asset_path(work, "candidates")
    base.mkdir(exist_ok=True)
    stage = core.asset_path(work, f"candidates/.staged-{ident}")
    dest = core.asset_path(work, f"candidates/{ident}")
    try:
        ticket = funding.reserve(
            work,
            profile=profile,
            job=getattr(args, "job", None),
            edition=ed["name"],
            scope=scope,
            op_key=fingerprint,
            target_key=scope,
            upper_usd=bound["upper_usd"],
            max_usd=getattr(args, "max_usd", None),
            duration_s=providers.TIMEOUT,
            model=MODEL[kind],
            pricing_version=providers.PRICING,
            **options,
        )
    except core.Fail as exc:
        if exc.code == "operation_already_completed":
            completed = cached(work, ident, fingerprint)
            if completed:
                return completed
        if (
            exc.code == "operation_already_completed"
            and (stage / "record.json").is_file()
            and not dest.exists()
        ):
            info = core.read_map(stage / "record.json")
            leaf = Path(info["path"]).name
            if (
                info.get("operation_id") == exc.details.get("operation_id")
                and info.get("fingerprint") == fingerprint
                and core.sha256_file(stage / leaf) == info.get("sha256")
            ):
                stage.rename(dest)
                return cached(work, ident, fingerprint)
        raise
    try:
        reply = providers.perform(ticket, kind, spec)
    except providers.RemoteProblem as exc:
        funding.settle(
            ticket,
            outcome="rejected" if exc.rejected else "unknown",
            request_id=exc.request_id,
            reason=exc.reason,
        )
        raise core.Fail(
            "remote_rejected" if exc.rejected else "remote_outcome_unknown",
            "服务拒绝该请求。" if exc.rejected else "远端可能已经计费，已保留预算。",
            4,
            operation_id=ticket.id,
            reason=exc.reason,
        ) from None
    except (Exception, KeyboardInterrupt):  # noqa: BLE001 - a sent operation must always retain its financial reservation.
        funding.settle(ticket, outcome="unknown", reason="transport_interrupted")
        raise core.Fail(
            "remote_outcome_unknown", "无法确认远端结果，已保留预算。", 4, operation_id=ticket.id
        ) from None
    try:
        if reply.payload.get("model", MODEL[kind]) != MODEL[kind] or (
            kind == "script" and reply.payload.get("service_tier", "default") != "default"
        ):
            raise ValueError("unexpected billing model or service tier")
        usage = reply.payload["usage"]
        actual = providers.price(kind, usage)
    except (KeyError, ValueError, TypeError, AttributeError):
        funding.settle(
            ticket, outcome="unknown", request_id=reply.request_id, reason="invalid_usage"
        )
        raise core.Fail(
            "remote_outcome_unknown", "没有完整用量，已保留预算待核对。", 4, operation_id=ticket.id
        ) from None
    details = {
        "operation_id": ticket.id,
        "request_id": reply.request_id,
        "usage": usage,
        "actual_usd": str(actual),
        "cost_basis": "provider_usage_at_standard_rates",
    }
    if actual > Decimal(bound["upper_usd"]):
        funding.settle(
            ticket, outcome="success", actual_usd=actual, usage=usage, request_id=reply.request_id
        )
        raise core.Fail(
            "price_bound_exceeded", "实际费用超过已核实上界，该资金配置需重新核对。", 4, **details
        )
    try:
        filename, blob, extra = material(kind, reply, cfg, meta)
        record = dict(
            id=ident,
            schema_version=1,
            work_id=cfg["id"],
            kind=kind,
            target=target,
            edition=ed["name"],
            take=take,
            model=MODEL[kind],
            fingerprint=fingerprint,
            sha256=digest(blob),
            path=f"candidates/{ident}/{filename}",
            pricing_version=providers.PRICING,
            **meta,
            **extra,
            **details,
        )
        stage.mkdir(exist_ok=False)
        with (stage / filename).open("wb") as stream:
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        if kind == "voice":
            core.atomic_text(stage / "transcript.txt", reply.transcript)
        core.atomic_json(stage / "record.json", record)
    except (OSError, KeyError, TypeError, ValueError, core.Fail) as exc:
        funding.settle(ticket, actual_usd=actual, usage=usage, request_id=reply.request_id)
        raise core.Fail(
            "paid_result_invalid", "已核实计费，但候选未通过校验或未成功保存。", 4, **details
        ) from exc
    funding.settle(ticket, actual_usd=actual, usage=usage, request_id=reply.request_id)
    stage.rename(dest)
    return dict(record, candidate_id=ident, cached=False, request_sent=True)
