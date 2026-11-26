"""Local owner attestations, project credentials and an organization-wide spend ledger."""

import contextlib
import datetime as dt
import fcntl
import getpass
import hashlib
import http.client
import json
import math
import re
import sqlite3
import sys
import time
import uuid
import warnings
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit

from . import core
from .core import Fail
from .keychain import Keychain

MICRO = Decimal(1_000_000)
MAX_MONEY = 1_000_000_000_000_000
SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles(
 name TEXT PRIMARY KEY, org TEXT, project TEXT, keyref TEXT, fingerprint TEXT, revision INTEGER,
 rejected INTEGER DEFAULT 0, recheck_after REAL DEFAULT 0, checked REAL, record_key TEXT);
CREATE TABLE IF NOT EXISTS work_bindings(work TEXT PRIMARY KEY, profile TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attestations(profile TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots(
 org TEXT PRIMARY KEY, digest TEXT NOT NULL, checked REAL NOT NULL, data TEXT NOT NULL,
 blocked TEXT, balance INTEGER NOT NULL, margin INTEGER NOT NULL, until REAL NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(
 id TEXT PRIMARY KEY, work TEXT NOT NULL, edition TEXT NOT NULL, profile TEXT NOT NULL,
 revision INTEGER NOT NULL, scope TEXT NOT NULL, ceiling INTEGER NOT NULL,
 generations INTEGER NOT NULL, until REAL NOT NULL);
CREATE TABLE IF NOT EXISTS reconciliations(
 operation TEXT PRIMARY KEY, org TEXT NOT NULL, proof TEXT NOT NULL, reviewed REAL NOT NULL);
CREATE TABLE IF NOT EXISTS calls(
 id TEXT PRIMARY KEY, org TEXT NOT NULL, project TEXT NOT NULL, profile TEXT NOT NULL,
 revision INTEGER NOT NULL, job TEXT, work TEXT NOT NULL, edition TEXT NOT NULL, scope TEXT NOT NULL,
 op TEXT NOT NULL, target TEXT NOT NULL, upper INTEGER NOT NULL, actual INTEGER,
 state TEXT NOT NULL, model TEXT NOT NULL, pricing TEXT NOT NULL, requested REAL NOT NULL,
 settled REAL, absorbed INTEGER DEFAULT 0, usage TEXT, remote_id TEXT, reason TEXT);
CREATE INDEX IF NOT EXISTS funding_totals ON calls(org,absorbed,state);
CREATE INDEX IF NOT EXISTS work_operations ON calls(work,op,target);
CREATE INDEX IF NOT EXISTS job_operations ON calls(job,state);
"""


@contextlib.contextmanager
def _transaction():
    folder = Path(core.state_dir())
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(folder / "funding.sqlite3", timeout=20, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.executescript(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        yield db
        db.commit()
    finally:
        db.close()


def _micros(value, name, *, positive=False, ceil=False):
    if isinstance(value, (float, bool)):
        raise Fail("invalid_amount", f"{name} 须以十进制字符串给出。")
    try:
        num = Decimal(str(value))
        if not num.is_finite() or num < 0 or num > MAX_MONEY / MICRO:
            raise ValueError()
        exact = num * MICRO
        raw = int(exact.to_integral_value(rounding=ROUND_CEILING))
        if (not ceil and exact != raw) or (positive and not raw):
            raise ValueError()
        return raw
    except (InvalidOperation, TypeError, ValueError, OverflowError):
        raise Fail("invalid_amount", f"{name} 金额无效；预算最多六位小数。") from None


def _usd(raw):
    return format(Decimal(raw) / MICRO, "f")


def _iso(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.UTC).isoformat()


def _date(value, field_name):
    try:
        parsed = dt.datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.timestamp()
    except (ValueError, TypeError, OverflowError, OSError):
        raise Fail("invalid_record", f"{field_name} 须为带时区的 ISO 8601 日期。") from None


def _word(value, field_name):
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > 400
        or any(ord(c) < 32 for c in value)
    ):
        raise Fail("invalid_argument", f"{field_name} 无效。")
    return value


def _remote_id(value, field_name):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", value):
        raise Fail("invalid_argument", f"{field_name} 无效。")
    return value


def _profile(db, name):
    return db.execute("SELECT * FROM profiles WHERE name=?", (name,)).fetchone()


def _active(row):
    if not row or not row["keyref"]:
        raise Fail("credential_missing", "请先在终端执行 auth login。", 6, request_sent=False)
    if row["rejected"]:
        raise Fail("credential_rejected", "该项目密钥已被远端拒绝，请重新登录。", 6, request_sent=False)


def _key(row):
    _active(row)
    secret = Keychain().get(row["keyref"])
    if _fingerprint(secret) != row["fingerprint"]:
        raise Fail("credential_rejected", "钥匙串密钥与资金配置指纹不一致。", 6, request_sent=False)
    return secret


def _fingerprint(secret):
    return hashlib.sha256(secret.encode()).hexdigest()


def _prompt():
    if not sys.stdin.isatty():
        raise Fail("interactive_login_required", "请在您控制的终端无回显录入项目密钥。", 6)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            value = getpass.getpass("OpenAI 项目 API Key（输入隐藏）: ")
    except (getpass.GetPassWarning, EOFError, OSError):
        raise Fail("interactive_login_required", "无法安全读取项目密钥。", 6) from None
    if not value or not value.isascii() or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise Fail("invalid_credential", "密钥为空或含无效字符。", 6)
    return value


def _login(name, org, project):
    org, project = _remote_id(org, "org"), _remote_id(project, "project")
    secret = _prompt()
    fp = _fingerprint(secret)
    keyring = Keychain()
    unique = uuid.uuid4().hex
    keyring.add(unique, secret)
    try:
        with _transaction() as db:
            prev = _profile(db, name)
            revision = prev["revision"] + 1 if prev else 1
            since = time.time() if prev else 0
            db.execute(
                """INSERT OR REPLACE INTO profiles
                (name,org,project,keyref,fingerprint,revision,recheck_after)
                VALUES (?,?,?,?,?,?,?)""",
                (name, org, project, unique, fp, revision, since),
            )
    except BaseException:
        keyring.remove(unique)
        raise
    # Keep the previous key intact until the new pointer is durable.
    if prev and prev["keyref"]:
        keyring.remove(prev["keyref"])
    return {
        "profile": name,
        "organization_id": org,
        "project_id": project,
        "credential_state": "configured",
        "credential_fingerprint": fp,
        "funding_state": "unverified",
    }


def _logout(name):
    with _transaction() as db:
        row = _profile(db, name)
        if row and row["keyref"]:
            Keychain().remove(row["keyref"])
            db.execute(
                """UPDATE profiles SET keyref=NULL,fingerprint=NULL,checked=NULL,record_key=NULL,
                          revision=revision+1,rejected=0,recheck_after=? WHERE name=?""",
                (time.time(), name),
            )
    return {"profile": name, "credential_state": "missing", "funding_state": "unverified"}


def _read_models(secret, org, project):
    conn = http.client.HTTPSConnection("api.openai.com", timeout=12)
    try:
        conn.request(
            "GET",
            "/v1/models",
            headers={
                "Authorization": "Bearer " + secret,
                "OpenAI-Organization": org,
                "OpenAI-Project": project,
            },
        )
        response = conn.getresponse()
        return response.status, response.getheader("openai-organization")
    finally:
        conn.close()


def _check(name):
    with _transaction() as db:
        row = _profile(db, name)
        _active(row)
        secret = _key(row)
    try:
        status, returned_org = _read_models(secret, row["org"], row["project"])
    except (OSError, http.client.HTTPException):
        raise Fail(
            "credential_check_unknown", "模型目录检查未完成，未调用推理。", 4, request_sent=True
        ) from None
    if status == 401:
        with _transaction() as db:
            db.execute(
                "UPDATE profiles SET rejected=1 WHERE name=? AND revision=?", (name, row["revision"])
            )
        raise Fail("credential_rejected", "远端拒绝当前凭证。", 6, request_sent=True)
    if status == 403:
        raise Fail("credential_permission_denied", "该凭证无权读取模型目录。", 6, request_sent=True)
    if status != 200:
        raise Fail(
            "credential_check_unknown", "模型目录检查未确认。", 4, http_status=status, request_sent=True
        )
    if returned_org and returned_org != row["org"]:
        with _transaction() as db:
            db.execute(
                "UPDATE profiles SET rejected=1 WHERE name=? AND revision=?", (name, row["revision"])
            )
        raise Fail("credential_org_mismatch", "远端返回的组织与配置不一致。", 6, request_sent=True)
    return {
        "profile": name,
        "credential_state": "configured",
        "models_readable": True,
        "organization_confirmed": bool(returned_org),
        "funding_verified_by_check": False,
    }


def _totals(db, org):
    return db.execute(
        """SELECT
        COALESCE(SUM(CASE WHEN state IN ('success','reconciled_charged') AND absorbed=0 THEN actual ELSE 0 END),0) spent,
        COALESCE(SUM(CASE WHEN state IN ('pending','unknown') THEN upper ELSE 0 END),0) held
        FROM calls WHERE org=?""",
        (org,),
    ).fetchone()


def _funds(db, row):
    empty = {
        "state": "unverified",
        "reason": "funding_unverified",
        "platform_debit_source": "unverified",
    }
    if row is None or not row["keyref"]:
        return empty
    snap = db.execute("SELECT * FROM snapshots WHERE org=?", (row["org"],)).fetchone()
    if snap is None:
        return empty
    attested = db.execute("SELECT record FROM attestations WHERE profile=?", (row["name"],)).fetchone()
    record = json.loads(
        attested["record"] if attested and row["record_key"] == snap["digest"] else snap["data"]
    )
    totals = _totals(db, row["org"])
    room = snap["balance"] - snap["margin"] - totals["spent"] - totals["held"]
    reason = snap["blocked"]
    state = "blocked" if reason else "ready"
    if not reason and (row["record_key"] != snap["digest"] or row["checked"] is None):
        state, reason = "unverified", "funding_unverified"
    elif not reason and time.time() >= snap["until"]:
        state, reason = "blocked", "funding_expired"
    elif not reason and room <= 0:
        state, reason = "blocked", "funding_insufficient"
    if row["rejected"]:
        state, reason = "blocked", "credential_rejected"
    return {
        "state": state,
        "reason": reason,
        "organization_id": row["org"],
        "project_id": row["project"],
        "snapshot_balance_usd": _usd(snap["balance"]),
        "after_snapshot_usd": _usd(totals["spent"]),
        "reserved_usd": _usd(totals["held"]),
        "safety_margin_usd": _usd(snap["margin"]),
        "available_usd": _usd(max(0, room)),
        "effective_until": _iso(snap["until"]),
        "source": record.get("source"),
        "checked_by": record.get("checked_by"),
        "checked_at": record.get("checked_at"),
        "evidence_ref": record.get("evidence_ref"),
        "platform_debit_source": "unverified",
    }


def _status(name):
    with _transaction() as db:
        row = _profile(db, name)
        funding = _funds(db, row)
        if row:
            open_calls = db.execute(
                """SELECT id,state,upper,requested,job FROM calls
                WHERE org=? AND state IN ('unknown','pending') ORDER BY requested""",
                (row["org"],),
            )
            funding["unresolved_operations"] = [
                {
                    "operation_id": c["id"],
                    "state": c["state"],
                    "reserved_usd": _usd(c["upper"]),
                    "requested_at": _iso(c["requested"]),
                    "job": c["job"],
                }
                for c in open_calls
            ]
        state = "missing"
        if row and row["keyref"]:
            try:
                Keychain().probe(row["keyref"])
                state = "rejected" if row["rejected"] else "configured"
            except Fail as exc:
                state = "missing" if exc.code == "credential_missing" else "locked"
        if state in ("missing", "locked", "rejected") and funding["state"] == "ready":
            funding.update(state="blocked", reason=f"credential_{state}")
        return {
            "profile": name,
            "credential_state": state,
            "organization_id": row["org"] if row else None,
            "project_id": row["project"] if row else None,
            "credential_fingerprint": row["fingerprint"] if row else None,
            "funding_state": funding["state"],
            "funding": funding,
        }


def _read_record(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise Fail("invalid_record", "无法读取资金核对 JSON 文件。") from None
    if not isinstance(value, dict):
        raise Fail("invalid_record", "资金核对记录应为 JSON 对象。")
    return value


def _review(record):
    fields = (
        "organization_id",
        "project_id",
        "checked_by",
        "evidence_ref",
        "checked_at",
        "valid_until",
        "grant_expires_at",
        "source",
        "currency",
        "billing_mode",
        "grant_remaining_usd",
        "purchased_balance_usd",
        "other_funds_usd",
        "safety_reserve_usd",
        "auto_recharge",
        "exclusive_usage",
    )
    for field_name in fields:
        if field_name not in record or record[field_name] is None:
            raise Fail("funding_unverified", "缺少所有者核对字段。", 3, field=field_name)
    if type(record.get("schema_version")) is not int or record["schema_version"] != 1:
        raise Fail("invalid_record", "仅支持资金记录 schema_version=1。")
    for field_name in ("organization_id", "project_id", "checked_by", "evidence_ref"):
        _word(record[field_name], field_name)
    checked = _date(record["checked_at"], "checked_at")
    until = min(
        _date(record["valid_until"], "valid_until"),
        _date(record["grant_expires_at"], "grant_expires_at"),
    )
    if checked > time.time():
        raise Fail("funding_unverified", "核对时间在将来。", 3)
    values = {
        name: _micros(record[name], name)
        for name in (
            "grant_remaining_usd",
            "safety_reserve_usd",
            "purchased_balance_usd",
            "other_funds_usd",
        )
    }
    blocked = None
    if record["currency"] != "USD" or record["source"] != "chatgpt_subscription_api_grant":
        blocked = "funding_source_unknown"
    elif values["purchased_balance_usd"] or values["other_funds_usd"]:
        blocked = "funding_mixed"
    elif record["billing_mode"] != "prepaid" or record["auto_recharge"] is not False:
        blocked = "funding_paid_fallback"
    elif record["exclusive_usage"] is not True:
        blocked = "funding_unmanaged_traffic"
    elif until <= time.time() or until <= checked:
        blocked = "funding_expired"
    elif (
        values["safety_reserve_usd"] <= 0
        or values["grant_remaining_usd"] <= values["safety_reserve_usd"]
    ):
        blocked = "funding_insufficient"
    return checked, until, values["grant_remaining_usd"], values["safety_reserve_usd"], blocked


def _verify_bounds(work, record, record_path):
    bounds = record.get("vendor_price_bounds", [])
    if not isinstance(bounds, list):
        raise Fail("invalid_record", "vendor_price_bounds 应为受信所有者审核的报价清单。")
    if bounds and record_path.is_relative_to(work.resolve()):
        raise Fail("invalid_price_evidence", "厂商报价核对记录必须在作品目录外。", 3)
    for entry in bounds:
        if (
            not isinstance(entry, dict)
            or entry.get("provider") != "openai"
            or entry.get("basis") != "supplier_guaranteed_per_request"
        ):
            raise Fail("invalid_price_evidence", "需要 OpenAI 提供且覆盖整次请求的价格上界依据。", 3)
        url = urlsplit(_word(entry.get("source_url"), "source_url"))
        if (
            url.scheme != "https"
            or not url.hostname
            or not (url.hostname == "openai.com" or url.hostname.endswith(".openai.com"))
        ):
            raise Fail("invalid_price_evidence", "厂商报价来源须为官方 HTTPS 网址。", 3)
        _date(entry.get("valid_until"), "vendor_price_bounds.valid_until")
        _micros(entry.get("upper_usd"), "vendor_price_bounds.upper_usd", positive=True, ceil=True)
        for k in ("version", "model", "endpoint", "size", "quality"):
            _word(entry.get(k), k)
        for k in (
            "max_prompt_bytes",
            "max_reference_count",
            "max_reference_pixels",
            "max_reference_bytes",
        ):
            if type(entry.get(k)) is not int or entry[k] < 0:
                raise Fail("invalid_price_evidence", "厂商书面上界缺少输入规格限制。", 3, field=k)
        evidence = (record_path.parent / _word(entry.get("evidence_file"), "evidence_file")).resolve()
        if evidence.is_relative_to(work.resolve()) or not evidence.is_file():
            raise Fail("invalid_price_evidence", "报价证据须为作品之外的普通文件。", 3)
        expected = entry.get("evidence_sha256")
        if not isinstance(expected, str) or not re.fullmatch("[0-9a-f]{64}", expected):
            raise Fail("invalid_price_evidence", "报价证据缺少 SHA-256 指纹。", 3)
        try:
            with evidence.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
        except OSError:
            raise Fail("invalid_price_evidence", "不能读取报价证据文件。", 3) from None
        if actual != expected:
            raise Fail("invalid_price_evidence", "报价证据文件指纹与所有者记录不符。", 3)
        entry["evidence_file"] = str(evidence)


def _evidence_available(entry):
    try:
        with Path(entry["evidence_file"]).open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest() == entry["evidence_sha256"]
    except OSError:
        return False


def _approval(entry):
    return hashlib.sha256(json.dumps(entry, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def price_bounds(work, profile):
    """Read only owner-bound quotes. A reviewed document hash is not a vendor signature."""
    if not profile:
        return []
    work_id = _work_binding(work, profile)
    with _transaction() as db:
        _assert_binding(db, work_id, profile)
        row = _profile(db, profile)
        funding = _funds(db, row)
        if funding["state"] != "ready":
            return []
        stored = db.execute("SELECT record FROM attestations WHERE profile=?", (profile,)).fetchone()
        if not stored:
            return []
        record = json.loads(stored["record"])
        return [
            {**entry, "approval_digest": _approval(entry)}
            for entry in record.get("vendor_price_bounds", [])
            if _date(entry.get("valid_until"), "valid_until") > time.time()
            and _evidence_available(entry)
        ]


def _apply_reconciliations(db, org, entries, checked, previous_snapshot):
    """Close individually evidenced requests. Never infer a result from an aggregate balance."""
    if not isinstance(entries, list):
        raise Fail("invalid_record", "reconciled_operations 必须是对账结论数组。")
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise Fail("invalid_record", "每条对账结论应为对象。")
        operation = _word(entry.get("operation_id"), "operation_id")
        if operation in seen:
            raise Fail("funding_reconciliation_conflict", "同一核对记录含有重复的操作 ID。", 3)
        seen.add(operation)
        booked = db.execute("SELECT * FROM calls WHERE id=? AND org=?", (operation, org)).fetchone()
        if not booked:
            raise Fail("funding_reconciliation_unknown", "此组织没有对应的操作记录。", 3)
        expected = _micros(entry.get("expected_reserved_usd"), "expected_reserved_usd", positive=True)
        if expected != booked["upper"]:
            raise Fail("funding_reconciliation_conflict", "对账预留额与原请求不一致。", 3)
        outcome = entry.get("outcome")
        if outcome not in ("charged", "not_charged", "not_sent"):
            raise Fail("invalid_record", "对账结论应为 charged、not_charged 或 not_sent。")
        evidence = _word(entry.get("evidence_ref"), "reconciled_operations.evidence_ref")
        actual = _micros(entry.get("actual_usd"), "actual_usd")
        reflected = entry.get("reflected_in_snapshot", False)
        if type(reflected) is not bool or (
            outcome == "charged" and "reflected_in_snapshot" not in entry
        ):
            raise Fail("invalid_record", "已计费结论须明确费用是否已反映在余额快照中。")
        if (outcome == "charged") != (actual > 0):
            raise Fail("funding_reconciliation_conflict", "对账结论与实际费用不一致。", 3)
        proof = json.dumps([outcome, expected, actual, reflected, evidence], ensure_ascii=False)
        old = db.execute(
            "SELECT proof FROM reconciliations WHERE operation=? AND org=?", (operation, org)
        ).fetchone()
        if old:
            if proof != old["proof"]:
                raise Fail("funding_reconciliation_conflict", "此操作已有不同的最终对账记录。", 3)
            continue
        if (
            checked <= booked["requested"]
            or (previous_snapshot and checked <= previous_snapshot["checked"])
            or (booked["settled"] is not None and checked < booked["settled"])
        ):
            raise Fail("funding_stale_record", "必须使用请求之后的新组织快照完成对账。", 3)
        if booked["state"] not in ("pending", "unknown") or (
            booked["state"] == "pending" and _live(operation)
        ):
            raise Fail("funding_reconciliation_conflict", "只接受已结束或中断的未决请求。", 3)
        db.execute("INSERT INTO reconciliations VALUES (?,?,?,?)", (operation, org, proof, checked))
        db.execute(
            "UPDATE calls SET state=?,actual=?,absorbed=?,settled=? WHERE id=?",
            ("reconciled_" + outcome, actual, int(reflected), checked, operation),
        )


def _bind(work, name, file):
    manifest = core.load_work(work)
    path = Path(file)
    record = _read_record(path if path.is_absolute() else work / path)
    # Store only the documented accounting fields, never unrelated export fields or credentials.
    permitted = (
        "schema_version",
        "organization_id",
        "project_id",
        "source",
        "currency",
        "grant_remaining_usd",
        "purchased_balance_usd",
        "other_funds_usd",
        "billing_mode",
        "auto_recharge",
        "exclusive_usage",
        "safety_reserve_usd",
        "checked_by",
        "checked_at",
        "valid_until",
        "grant_expires_at",
        "evidence_ref",
        "credential_fingerprint",
        "accounted_operations",
        "vendor_price_bounds",
        "reconciled_operations",
    )
    record = {k: v for k, v in record.items() if k in permitted}
    record_path = path.resolve() if path.is_absolute() else (work / path).resolve()
    _verify_bounds(work, record, record_path)
    with _transaction() as db:
        row = _profile(db, name)
        _key(row)
        if (row["org"], row["project"]) != (record.get("organization_id"), record.get("project_id")):
            raise Fail("funding_identity_mismatch", "核对记录的组织或项目与登录配置不一致。", 3)
        if (
            "credential_fingerprint" in record
            and record["credential_fingerprint"] != row["fingerprint"]
        ):
            raise Fail("funding_identity_mismatch", "核对记录的密钥指纹不匹配。", 3)
        try:
            checked, until, balance, margin, blocked = _review(record)
        except Fail:
            previous = db.execute("SELECT checked FROM snapshots WHERE org=?", (row["org"],)).fetchone()
            checked = _date(record.get("checked_at"), "checked_at")
            if previous and previous["checked"] < checked <= time.time():
                db.execute(
                    "UPDATE snapshots SET blocked='funding_unverified',checked=? WHERE org=?",
                    (checked, row["org"]),
                )
                db.commit()
            raise
        snapshot = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        # The same financial snapshot can bind several projects without resetting shared spend.
        financial = {
            k: v
            for k, v in record.items()
            if k
            not in (
                "project_id",
                "credential_fingerprint",
                "vendor_price_bounds",
                "evidence_ref",
                "checked_by",
            )
        }
        digest = hashlib.sha256(
            json.dumps(financial, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        prev = db.execute("SELECT * FROM snapshots WHERE org=?", (row["org"],)).fetchone()
        if checked < row["recheck_after"] or (prev and checked < prev["checked"]):
            raise Fail("funding_stale_record", "需要更新的组织资金核对记录。", 3)
        if prev and checked == prev["checked"] and digest != prev["digest"]:
            raise Fail("funding_conflicting_record", "同一核对时间已经登记另一份快照。", 3)
        _apply_reconciliations(db, row["org"], record.get("reconciled_operations", []), checked, prev)
        accounted = record.get("accounted_operations", [])
        if not isinstance(accounted, list):
            raise Fail("invalid_record", "accounted_operations 应列出已在新快照体现的操作 ID。")
        for op in accounted:
            existing = db.execute(
                "SELECT * FROM calls WHERE id=? AND org=?", (_word(op, "operation_id"), row["org"])
            ).fetchone()
            if (
                not existing
                or existing["state"] not in ("success", "reconciled_charged")
                or existing["settled"] > checked
            ):
                raise Fail(
                    "funding_reconciliation_unknown",
                    "仅可勾销已完成、在截止时间前且已体现在快照内的本组织消耗。",
                    3,
                )
            db.execute("UPDATE calls SET absorbed=1 WHERE id=?", (op,))
        db.execute(
            "INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?,?,?,?)",
            (row["org"], digest, checked, snapshot, blocked, balance, margin, until),
        )
        db.execute("INSERT OR REPLACE INTO attestations VALUES (?,?)", (name, snapshot))
        db.execute("UPDATE profiles SET checked=?,record_key=? WHERE name=?", (checked, digest, name))
        if not blocked:
            db.execute(
                "INSERT OR REPLACE INTO work_bindings VALUES (?,?)", (_work_id(work, manifest), name)
            )
        status = _funds(db, _profile(db, name))
    if blocked:
        raise Fail(blocked, "组织核对记录含有不满足赠金准入的条件，已暂停生成。", 3, request_sent=False)
    with core.work_lock(work):
        manifest = core.load_work(work)
        manifest["profile"] = name
        core.save_work(work, manifest)
    return dict(profile=name, **status)


def _scope(value):
    if value in ("script", "script:work"):
        return "script"
    if isinstance(value, str) and ":" in value:
        kind, item = value.split(":", 1)
        if kind in ("art", "voice") and "*" not in item:
            try:
                return kind + ":" + core.name_part(item)
            except Fail:
                pass
    raise Fail(
        "job_scope_denied", "授权范围须为 script、art:镜头ID 或 voice:台词ID。", 3, request_sent=False
    )


def _job_scopes(value):
    """Accept older single-target rows and the current list of owner-approved scopes."""
    if isinstance(value, str) and value.startswith("["):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            raise Fail("job_scope_denied", "委托范围记录损坏。", 3) from None
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not value:
        raise Fail("job_scope_denied", "委托至少需要一个明确范围。", 3)
    validated = []
    for scope in value:
        item = scope if scope in ("art:*", "voice:*") else _scope(scope)
        if item not in validated:
            validated.append(item)
    return validated


def _allows_scope(granted, requested):
    choices = _job_scopes(granted)
    return requested in choices or requested.partition(":")[0] + ":*" in choices


def _work_id(work, manifest):
    return json.dumps(
        [str(Path(work).resolve()), manifest["id"]], ensure_ascii=False, separators=(",", ":")
    )


def _work_binding(work, name):
    manifest = core.load_work(work)
    if not name or manifest.get("profile") != name:
        raise Fail("funding_profile_mismatch", "作品尚未绑定此资金配置。", 3, request_sent=False)
    return _work_id(work, manifest)


def _assert_binding(db, work_id, profile):
    binding = db.execute("SELECT profile FROM work_bindings WHERE work=?", (work_id,)).fetchone()
    if not binding or binding["profile"] != profile:
        raise Fail(
            "funding_profile_mismatch", "本机未授权此作品使用指定组织配置。", 3, request_sent=False
        )


def _job_state(db, job):
    used = db.execute(
        """SELECT COALESCE(SUM(CASE WHEN state IN ('success','reconciled_charged','reconciled_not_charged','reconciled_not_sent') THEN actual ELSE upper END),0),
        count(*) FROM calls WHERE job=? AND state!='rejected'""",
        (job["id"],),
    ).fetchone()
    scopes = _job_scopes(job["scope"])
    return {
        "job": job["id"],
        "scope": scopes[0] if len(scopes) == 1 else scopes,
        "scopes": scopes,
        "edition": job["edition"],
        "profile": job["profile"],
        "expires_at": _iso(job["until"]),
        "max_usd": _usd(job["ceiling"]),
        "remaining_usd": _usd(max(0, job["ceiling"] - used[0])),
        "max_generations": job["generations"],
        "remaining_generations": max(0, job["generations"] - used[1]),
    }


def _ready(funding):
    if funding["state"] != "ready":
        raise Fail(
            funding["reason"] or "funding_unverified",
            "当前组织资金尚未满足生成条件。",
            3,
            funding_state=funding["state"],
            request_sent=False,
        )


def _authorize(work, name, args):
    work_id = _work_binding(work, name)
    edition = _word(args.edition, "edition")
    core.load_edition(work, edition)
    amount = _micros(args.max_usd, "max_usd", positive=True)
    scope = json.dumps(_job_scopes(args.scope), ensure_ascii=False, separators=(",", ":"))
    count = args.max_generations
    if type(count) is not int or not 1 <= count < 2**63:
        raise Fail("invalid_argument", "max-generations 应为正整数。")
    with _transaction() as db:
        _assert_binding(db, work_id, name)
        row = _profile(db, name)
        _key(row)
        funding = _funds(db, row)
        _ready(funding)
        until = _date(funding["effective_until"], "effective_until")
        if getattr(args, "expires_at", None):
            until = min(until, _date(args.expires_at, "expires_at"))
        if until <= time.time():
            raise Fail("job_expired", "委托截止时间已过。", 3)
        if amount > _micros(funding["available_usd"], "available_usd"):
            raise Fail("funding_insufficient", "委托最高预算超过组织当前可用赠金额。", 3)
        job_id = "job-" + uuid.uuid4().hex
        db.execute(
            "INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)",
            (job_id, work_id, edition, name, row["revision"], scope, amount, count, until),
        )
        return _job_state(db, db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())


def _get_job(work, name, id):
    work_id = _work_binding(work, name)
    with _transaction() as db:
        row = _profile(db, name)
        _assert_binding(db, work_id, name)
        job = db.execute("SELECT * FROM jobs WHERE id=?", (id,)).fetchone()
        if not job or job["work"] != work_id or job["profile"] != name:
            raise Fail("job_scope_denied", "该委托不属于当前作品和配置。", 3)
        report = _job_state(db, job)
        reasons = []
        if not row or not row["keyref"] or row["revision"] != job["revision"]:
            reasons.append("credential_changed")
        if time.time() >= job["until"]:
            reasons.append("job_expired")
        funds = _funds(db, row)
        if funds["state"] != "ready":
            reasons.append(funds["reason"])
        if report["remaining_generations"] == 0 or Decimal(report["remaining_usd"]) == 0:
            reasons.append("job_budget_exceeded")
        return dict(**report, state="blocked" if reasons else "ready", reasons=reasons)


@dataclass(frozen=True)
class Ticket:
    id: str
    org: str
    project: str
    profile: str
    key: str = field(repr=False)
    lease: object = field(repr=False, compare=False)


def _lease_path(op_id):
    folder = Path(core.state_dir()) / "inflight"
    folder.mkdir(mode=0o700, exist_ok=True)
    return folder / op_id


def _live(op_id):
    # Advisory locks disappear when the sending process dies, even after SIGKILL.
    try:
        stream = _lease_path(op_id).open("rb")
    except FileNotFoundError:
        return False
    with stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
    return False


def reserve(
    work,
    *,
    profile,
    job,
    edition,
    scope,
    op_key,
    target_key,
    upper_usd,
    max_usd,
    duration_s,
    model,
    pricing_version,
    approval_digest=None,
):
    work_id = _work_binding(work, profile)
    scope = _scope(scope)
    for field_name, value in (
        ("edition", edition),
        ("op_key", op_key),
        ("target_key", target_key),
        ("model", model),
        ("pricing_version", pricing_version),
    ):
        _word(value, field_name)
    upper = _micros(upper_usd, "upper_usd", positive=True, ceil=True)
    if max_usd is None:
        raise Fail("budget_required", "远端生成需要明确的单次最高预算。", 3, request_sent=False)
    if upper > _micros(max_usd, "max_usd", positive=True):
        raise Fail("operation_budget_exceeded", "本次保守上界超过单次授权。", 3, request_sent=False)
    if (
        isinstance(duration_s, bool)
        or not isinstance(duration_s, (int, float))
        or not math.isfinite(duration_s)
        or duration_s <= 0
    ):
        raise Fail(
            "generation_bound_unknown", "本次请求没有可验证的最长执行时间。", 3, request_sent=False
        )
    with _transaction() as db:
        _assert_binding(db, work_id, profile)
        row = _profile(db, profile)
        secret = _key(row)
        funds = _funds(db, row)
        _ready(funds)
        now = time.time()
        if scope.startswith("art:"):
            stored = db.execute(
                "SELECT record FROM attestations WHERE profile=?", (profile,)
            ).fetchone()
            quotes = json.loads(stored["record"]).get("vendor_price_bounds", []) if stored else []
            match = next((q for q in quotes if _approval(q) == approval_digest), None)
            if (
                not match
                or not _evidence_available(match)
                or match.get("model") != model
                or now + duration_s >= _date(match["valid_until"], "valid_until")
                or upper < _micros(match["upper_usd"], "upper_usd", positive=True, ceil=True)
            ):
                raise Fail(
                    "generation_bound_unknown",
                    "原画报价未经当前配置核对，或可能在请求内失效。",
                    3,
                    request_sent=False,
                )
        if now + duration_s >= _date(funds["effective_until"], "effective_until"):
            raise Fail(
                "funding_expired", "请求最长执行时间可能跨越核对或赠金到期。", 3, request_sent=False
            )
        if upper > _micros(funds["available_usd"], "available_usd"):
            raise Fail(
                "funding_insufficient", "组织剩余可用额不足以覆盖本次保守上界。", 3, request_sent=False
            )
        previous = db.execute(
            """SELECT id,op,state FROM calls WHERE work=? AND
            ((op=? AND state IN ('pending','unknown','success','reconciled_charged')) OR
             ((target=? OR scope=?) AND state IN ('pending','unknown')))""",
            (work_id, op_key, target_key, scope),
        ).fetchall()
        for prior in previous:
            if prior["state"] == "pending" and prior["op"] != op_key and _live(prior["id"]):
                continue
            code = (
                "operation_already_completed"
                if prior["state"] in ("success", "reconciled_charged")
                else "remote_outcome_unknown"
            )
            raise Fail(
                code,
                "同一输入或目标已有已完成或待核对请求。",
                4,
                operation_id=prior["id"],
                request_sent=False,
            )
        if job:
            grant = db.execute("SELECT * FROM jobs WHERE id=?", (job,)).fetchone()
            if (
                not grant
                or (
                    grant["profile"],
                    grant["revision"],
                    grant["work"],
                    grant["edition"],
                )
                != (profile, row["revision"], work_id, edition)
                or not _allows_scope(grant["scope"], scope)
            ):
                raise Fail(
                    "job_scope_denied", "委托未授权此作品、配置、版本和操作。", 3, request_sent=False
                )
            if now + duration_s >= grant["until"]:
                raise Fail("job_expired", "本次请求可能跨越委托有效期。", 3, request_sent=False)
            budget = _job_state(db, grant)
            if budget["remaining_generations"] <= 0 or upper > _micros(
                budget["remaining_usd"], "remaining_usd"
            ):
                raise Fail(
                    "job_budget_exceeded",
                    "委托剩余次数或预算不足。",
                    3,
                    remaining_usd=budget["remaining_usd"],
                    remaining_generations=budget["remaining_generations"],
                    request_sent=False,
                )
        call_id = "op-" + uuid.uuid4().hex
        db.execute(
            """INSERT INTO calls(id,org,project,profile,revision,job,work,edition,scope,op,target,upper,state,
                      model,pricing,requested) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)""",
            (
                call_id,
                row["org"],
                row["project"],
                profile,
                row["revision"],
                job,
                work_id,
                edition,
                scope,
                op_key,
                target_key,
                upper,
                model,
                pricing_version,
                now,
            ),
        )
        lease = _lease_path(call_id).open("x+b")
        fcntl.flock(lease, fcntl.LOCK_EX)
        return Ticket(call_id, row["org"], row["project"], profile, secret, lease)


def settle(ticket, *, actual_usd=None, usage=None, request_id=None, outcome="success", reason=None):
    if outcome not in ("success", "unknown", "rejected"):
        raise Fail("invalid_outcome", "无效的结算状态。")
    if outcome == "success" and (actual_usd is None or not isinstance(usage, dict) or not usage):
        outcome = "unknown"
    actual = _micros(actual_usd, "actual_usd", ceil=True) if outcome == "success" else None
    safe_reason = (
        reason if isinstance(reason, str) and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,120}", reason) else None
    )
    with _transaction() as db:
        row = db.execute("SELECT * FROM calls WHERE id=?", (ticket.id,)).fetchone()
        if not row or (row["org"], row["project"], row["profile"]) != (
            ticket.org,
            ticket.project,
            ticket.profile,
        ):
            raise Fail("operation_unknown", "找不到此操作。")
        if row["state"] != "pending":
            return {"operation_id": ticket.id, "state": row["state"]}
        db.execute(
            "UPDATE calls SET state=?,actual=?,usage=?,remote_id=?,reason=?,settled=? WHERE id=?",
            (
                outcome,
                actual,
                json.dumps(usage, ensure_ascii=False) if usage else None,
                request_id,
                safe_reason,
                time.time(),
                ticket.id,
            ),
        )
        if safe_reason == "credential_rejected":
            db.execute(
                "UPDATE profiles SET rejected=1 WHERE name=? AND revision=?",
                (ticket.profile, row["revision"]),
            )
        if (actual is not None and actual > row["upper"]) or safe_reason in {
            "credit_balance_exhausted",
            "insufficient_quota",
            "billing_hard_limit_reached",
            "billing_not_active",
            "project_spend_limit_exceeded",
            "organization_spend_limit_exceeded",
        }:
            db.execute(
                "UPDATE snapshots SET blocked=?,checked=? WHERE org=?",
                (safe_reason or "price_bound_exceeded", time.time(), ticket.org),
            )
            # Any replacement attestation must be dated after discovering this billing condition.
            db.execute(
                "UPDATE profiles SET recheck_after=max(recheck_after,?) WHERE org=?",
                (time.time(), ticket.org),
            )
        ticket.lease.close()
        _lease_path(ticket.id).unlink(missing_ok=True)
        return {"operation_id": ticket.id, "state": outcome}


def handle(args, work: Path):
    action = args.action
    name = getattr(args, "profile", None) if action == "login" else core.resolve_profile(work, args)
    if not name and args.command in ("auth", "funding") and action == "status":
        return {
            "profile": None,
            "state": "unverified",
            "credential_state": "missing",
            "funding_state": "unverified",
            "reason": "funding_unverified",
        }
    if not name:
        raise Fail("credential_missing", "作品未配置凭证，请先指定 --profile。", 6, request_sent=False)
    name = core.name_part(_word(name, "profile"))
    if args.command == "auth":
        if action == "login":
            return _login(name, args.org, args.project)
        if action == "logout":
            return _logout(name)
        if action == "check" or (action == "status" and getattr(args, "check", False)):
            result = _check(name)
            return {**_status(name), **result}
        if action == "status":
            return _status(name)
    if args.command == "funding":
        if action == "bind":
            return _bind(work, name, args.record)
        if action == "status":
            state = _status(name)
            return {"profile": name, "credential_state": state["credential_state"], **state["funding"]}
    if args.command == "job":
        if action == "authorize":
            return _authorize(work, name, args)
        if action == "status":
            return _get_job(work, name, args.job)
    raise Fail("invalid_command", "无法识别此认证或资金命令。")
