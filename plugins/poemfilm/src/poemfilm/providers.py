"""Single-attempt OpenAI transports. All destinations and billing identities are explicit."""

import base64
import binascii
import json
import secrets
import time
from dataclasses import dataclass
from decimal import Decimal
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

TEXT_MODEL = "gpt-5.4-mini-2026-03-17"
ART_MODEL = "gpt-image-2-2026-04-21"
VOICE_MODEL = "gpt-realtime-2.1-mini"
MODELS = {"script": TEXT_MODEL, "art": ART_MODEL, "voice": VOICE_MODEL}
PRICING = "openai-standard-2026-11-26"
PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing"
TEXT_LIMIT, VOICE_LIMIT = 4096, 1024
TIMEOUT = 120
MAX_BODY = 48 * 1024 * 1024
MILLION = Decimal(1_000_000)


class RemoteProblem(Exception):
    def __init__(self, reason, *, rejected=False, request_id=None):
        self.reason = reason
        self.rejected = rejected
        self.request_id = request_id
        super().__init__(reason)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _headers(ticket):
    return {
        "Authorization": "Bearer " + ticket.key,
        "OpenAI-Organization": ticket.org,
        "OpenAI-Project": ticket.project,
        "Content-Type": "application/json",
    }


def _response_error(status, rid, body=b""):
    reason = {401: "credential_rejected", 403: "permission_denied"}.get(status, f"http_{status}")
    # Preserve actionable billing error codes without leaking response bodies or credentials.
    try:
        code = json.loads(body)["error"]["code"]
        if status in {400, 402, 403, 429} and code in {
            "insufficient_quota",
            "billing_hard_limit_reached",
            "billing_not_active",
            "credit_balance_exhausted",
            "project_spend_limit_exceeded",
            "organization_spend_limit_exceeded",
            "rate_limit_exceeded",
        }:
            reason = code
    except (ValueError, TypeError, KeyError, UnicodeDecodeError):
        pass
    return RemoteProblem(
        reason, rejected=status in {400, 401, 402, 403, 404, 413, 415, 422, 429}, request_id=rid
    )


@dataclass
class Reply:
    payload: dict
    request_id: str | None = None
    pcm: bytes = b""
    transcript: str = ""


def _edit_form(payload):
    boundary = secrets.token_hex(24)
    delimiter = f"--{boundary}\r\n".encode("ascii")
    chunks = []
    for field in ("model", "prompt", "size", "quality", "n", "output_format"):
        chunks.extend(
            (
                delimiter,
                f'Content-Disposition: form-data; name="{field}"\r\n\r\n'.encode("ascii"),
                str(payload[field]).encode("utf-8"),
                b"\r\n",
            )
        )
    for index, ref in enumerate(payload["images"], start=1):
        mime = ref["mime"]
        extension = {"image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp"}[mime]
        headers = (
            f'Content-Disposition: form-data; name="image[]"; filename="reference-{index:02d}.{extension}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        )
        chunks.extend((delimiter, headers.encode("ascii"), ref["data"], b"\r\n"))
    chunks.append(f"--{boundary}--\r\n".encode("ascii"))
    # urllib accepts an iterable body. Supplying its size avoids copying large images or chunked transfer.
    return chunks, {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(sum(map(len, chunks))),
    }


def post(ticket, route, payload):
    headers = _headers(ticket)
    if route == "images/edits":
        data, form_headers = _edit_form(payload)
        headers.update(form_headers)
    else:
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
    req = Request("https://api.openai.com/v1/" + route, headers=headers, data=data, method="POST")
    rid = None
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=TIMEOUT) as response:
            rid = response.headers.get("x-request-id")
            body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise RemoteProblem("response_too_large", request_id=rid)
        return Reply(json.loads(body), rid)
    except HTTPError as exc:
        raise _response_error(exc.code, exc.headers.get("x-request-id"), exc.read(65536)) from None
    except (OSError, ValueError) as exc:
        raise RemoteProblem(type(exc).__name__, request_id=rid) from None


def _audio_events(ws, spec, deadline):
    # No microphone, default conversation or VAD. Only this one response can accrue output.
    have_sent = False
    response_id = None
    chunks = bytearray()
    transcript = ""
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RemoteProblem("deadline", request_id=response_id)
        event = json.loads(ws.recv(timeout=remaining))
        kind = event["type"]
        if kind == "error":
            raise RemoteProblem("realtime_error", request_id=response_id)
        if kind == "session.created" and not have_sent:
            ws.send(
                json.dumps(
                    {
                        "type": "session.update",
                        "session": {
                            "type": "realtime",
                            "output_modalities": ["audio"],
                            "audio": {
                                "input": {"turn_detection": None},
                                "output": {
                                    "format": {"type": "audio/pcm", "rate": 24000},
                                    "voice": spec["voice"],
                                },
                            },
                        },
                    }
                )
            )
        elif kind == "session.updated" and not have_sent:
            have_sent = True
            ws.send(
                json.dumps(
                    {
                        "type": "response.create",
                        "response": {
                            "conversation": "none",
                            "output_modalities": ["audio"],
                            "max_output_tokens": VOICE_LIMIT,
                            "instructions": spec["instructions"],
                            "input": [
                                {
                                    "type": "message",
                                    "role": "user",
                                    "content": [{"type": "input_text", "text": spec["text"]}],
                                }
                            ],
                        },
                    },
                    ensure_ascii=False,
                )
            )
        elif kind == "response.created":
            if response_id is not None:
                raise RemoteProblem("unexpected_second_response", request_id=response_id)
            response_id = event["response"]["id"]
        elif (
            kind == "response.output_audio.delta"
            and response_id
            and event.get("response_id") == response_id
        ):
            chunks.extend(base64.b64decode(event["delta"], validate=True))
            if len(chunks) > MAX_BODY:
                raise RemoteProblem("response_too_large", request_id=response_id)
        elif (
            kind == "response.output_audio_transcript.done"
            and response_id
            and event.get("response_id") == response_id
        ):
            transcript = event.get("transcript", "")
        elif kind == "response.done" and response_id and event["response"]["id"] == response_id:
            return Reply(event["response"], response_id, bytes(chunks), transcript)


def voice(ticket, spec):
    try:
        from websockets.exceptions import InvalidStatus
        from websockets.sync.client import connect
    except ImportError:
        raise RemoteProblem("missing_websockets", rejected=True) from None
    deadline = time.monotonic() + TIMEOUT
    try:
        with connect(
            "wss://api.openai.com/v1/realtime?model=" + VOICE_MODEL,
            additional_headers=_headers(ticket),
            open_timeout=15,
            close_timeout=3,
            max_size=8 * 1024 * 1024,
            proxy=None,
        ) as ws:
            return _audio_events(ws, spec, deadline - 3)
    except InvalidStatus as exc:
        # A failed websocket handshake cannot have submitted our response.create.
        reason = _response_error(
            exc.response.status_code,
            exc.response.headers.get("x-request-id"),
            exc.response.body or b"",
        )
        raise RemoteProblem(reason.reason, rejected=True, request_id=reason.request_id) from None
    except RemoteProblem:
        raise
    except (OSError, EOFError, ValueError, KeyError, binascii.Error) as exc:
        raise RemoteProblem(type(exc).__name__) from None


def perform(ticket, kind, spec):
    if kind == "voice":
        return voice(ticket, spec)
    if kind == "script":
        return post(ticket, "responses", spec)
    return post(ticket, "images/edits" if "images" in spec else "images/generations", spec)


def _count(d, name):
    v = d[name]
    if type(v) is not int or v < 0:
        raise ValueError("invalid token count")
    return v


def price(kind, usage):
    """Return the Standard USD charge for the available token breakdown; never guess missing billing data."""
    inp, out = _count(usage, "input_tokens"), _count(usage, "output_tokens")
    if _count(usage, "total_tokens") != inp + out:
        raise ValueError("inconsistent token total")
    if kind == "script":
        cached = _count(usage["input_tokens_details"], "cached_tokens")
        if cached > inp:
            raise ValueError("invalid cached count")
        return (
            Decimal(".75") * (inp - cached) + Decimal(".075") * cached + Decimal("4.50") * out
        ) / MILLION
    if kind == "art":
        details = usage["input_tokens_details"]
        text, img = _count(details, "text_tokens"), _count(details, "image_tokens")
        if text + img != inp:
            raise ValueError("unpriced image input")
        # Direct Images API has no cached-input discount.
        return (5 * Decimal(text) + 8 * Decimal(img) + 30 * Decimal(out)) / MILLION
    ins, outs = usage["input_token_details"], usage["output_token_details"]
    cached = _count(ins, "cached_tokens")
    text_input = _count(ins, "text_tokens")
    at, ot = _count(outs, "audio_tokens"), _count(outs, "text_tokens")
    if text_input != inp or cached > inp or at + ot != out:
        raise ValueError("unexpected modalities or unaccounted tokens")
    return (
        Decimal(".6") * (inp - cached)
        + Decimal(".06") * cached
        + 20 * Decimal(at)
        + Decimal("2.4") * ot
    ) / MILLION


def upper(kind):
    if kind == "script":
        # Published max input of the pinned model; output includes reasoning tokens.
        return (272000 * Decimal(".75") + TEXT_LIMIT * Decimal("4.50")) / MILLION
    if kind == "voice":
        # One isolated, text-only input. Charge the highest output rate for every permitted token.
        return (128000 * Decimal(".60") + VOICE_LIMIT * Decimal(20)) / MILLION
    return None
