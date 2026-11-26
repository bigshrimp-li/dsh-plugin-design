import asyncio
import json
import sys

import pytest

from poemfilm import core
from poemfilm.bridge import create_server
from poemfilm.cli import invoke


@pytest.fixture
def work(tmp_path, monkeypatch):
    monkeypatch.setenv("POEMFILM_STATE_DIR", str(tmp_path / "state"))
    path = tmp_path / "work"
    poem = tmp_path / "原文.txt"
    poem.write_text("莫听穿林打叶声。\n何妨吟啸且徐行。\n")
    code, result = invoke(["init", str(path), "--poem", str(poem), "--edition", "温叙"])
    assert code == 0, result
    return path


def run(work, *args):
    return invoke(["--json", "--work", str(work), *args])


def test_import_select_and_fork(work, tmp_path):
    data = run(work, "show")[1]["data"]
    shots = [
        {"id": f"shot-{i}", "line_id": line["id"], "prompt": "竹杖芒鞋"}
        for i, line in enumerate(data["lines"])
    ]
    script = tmp_path / "script.json"
    script.write_text(json.dumps({"lines": data["lines"], "shots": shots}))
    args = (
        "import",
        "script",
        "--file",
        str(script),
        "--source",
        "本地",
        "--license",
        "原创",
    )
    code, result = run(work, *args)
    assert code == 0, result
    candidate = result["data"]["id"]
    assert run(work, *args)[1]["data"]["id"] == candidate
    assert run(work, "select", "script", candidate)[0] == 0
    assert run(work, "edition", "fork", "温叙", "行吟")[0] == 0
    assert run(work, "show", "--edition", "行吟")[1]["data"]["shots"] == shots
    assert run(work, "edition", "fork", "温叙", "行吟")[0] != 0
    script.write_text(json.dumps({"lines": data["lines"][::-1], "shots": shots}))
    changed = run(work, *args)[1]["data"]["id"]
    assert run(work, "select", "script", changed)[1]["error"]["code"] == "poem_changed"
    assert run(work, "show")[1]["data"]["selected"]["script"] == candidate


def test_locked_poem_and_traversal(work):
    assert run(work, "edition", "fork", "温叙", "../越界")[0] == 2
    with pytest.raises(core.Fail):
        core.asset_path(work, "../other")
    (work / "poem.txt").write_text("另一首诗。")
    assert run(work, "show")[1]["error"]["code"] == "poem_changed"


def test_status_and_local_plan_without_profile(work):
    assert run(work, "auth", "status")[1]["data"]["credential_state"] == "missing"
    assert run(work, "funding", "status")[1]["data"]["state"] == "unverified"
    code, result = run(work, "plan")
    assert code == 0 and result["data"]["renderable"] is False


def test_budgetless_mcp_surface(work):
    async def check():
        local = create_server(work, "温叙", None, False)
        tools = {tool.name for tool in await local.list_tools()}
        assert {"show", "plan", "estimate", "verify", "status"} == tools
        scoped = create_server(work, "温叙", "job-example", True)
        extra = {tool.name for tool in await scoped.list_tools()} - tools
        assert extra == {"job_status", "generate", "select", "render"}

    asyncio.run(check())


def test_stdio_handshake_and_offline_call(work):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def exercise():
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "poemfilm", "--work", str(work), "mcp", "--edition", "温叙"],
        )
        async with (
            stdio_client(params) as (incoming, outgoing),
            ClientSession(incoming, outgoing) as client,
        ):
            await client.initialize()
            result = await client.call_tool("show", {})
            assert not result.isError
            payload = result.structuredContent
            if "result" in payload:
                payload = payload["result"]
            assert payload["data"]["edition"] == "温叙"
            assert len(payload["data"]["lines"]) == 2

    asyncio.run(exercise())
