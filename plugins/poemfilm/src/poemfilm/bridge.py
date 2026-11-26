"""A local, stdio-only tool surface with a host-pinned work, edition and budget."""

from pathlib import Path
from typing import Any, Literal

from . import core
from .cli import invoke


def create_server(work: Path, edition: str, job: str | None, allow_edit: bool):
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError as exc:
        raise core.Fail(
            "mcp_dependency_missing", "请安装 poemfilm[agent] 以启用本机 MCP。"
        ) from exc
    server = FastMCP(
        "poemfilm", instructions="所有操作绑定当前作品和版本。费用只由本机 CLI 核算。"
    )

    def run(*args):
        return invoke([f"--work={work}", "--json", *args])[1]

    def asset_args(asset, target, delivery):
        if asset == "script":
            if target or delivery:
                raise ValueError("分镜操作无需目标和读法。")
            return []
        if not target:
            raise ValueError("请输入 show 返回的目标 ID。")
        if asset == "art":
            if delivery:
                raise ValueError("只有声音操作使用读法。")
            return [f"--shot={target}"]
        if not delivery:
            raise ValueError("请指定此段表演的读法。")
        return [f"--line={target}", f"--delivery={delivery}"]

    @server.tool()
    def show() -> dict[str, Any]:
        """列出本版台词、镜头和已有候选。"""
        return run("show", f"--edition={edition}")

    @server.tool()
    def plan() -> dict[str, Any]:
        """按声音排镜，检查缺少的素材。"""
        return run("plan", f"--edition={edition}")

    @server.tool()
    def status() -> dict[str, Any]:
        """读取本地凭证与赠金准入状态。"""
        return run("auth", "status")

    @server.tool()
    def estimate(
        asset: Literal["script", "art", "voice"], target: str = "", delivery: str = ""
    ) -> dict[str, Any]:
        """在本地估算一个生成请求。"""
        return run(
            "generate",
            asset,
            f"--edition={edition}",
            "--estimate-only",
            *asset_args(asset, target, delivery),
        )

    @server.tool()
    def verify() -> dict[str, Any]:
        """检查实际成片并返回人工审看项。"""
        return run("verify", f"--edition={edition}")

    if job:

        @server.tool()
        def job_status() -> dict[str, Any]:
            """查看本任务的累计预算和剩余预留。"""
            return run("job", "status", f"--job={job}")

        @server.tool()
        def generate(
            asset: Literal["script", "art", "voice"],
            max_usd: str,
            target: str = "",
            delivery: str = "",
            take: str = "",
        ) -> dict[str, Any]:
            """在本会话已获授权的目标和总额内生成一个候选。"""
            flags = [f"--take={take}"] if take else []
            return run(
                "generate",
                asset,
                f"--edition={edition}",
                f"--job={job}",
                f"--max-usd={max_usd}",
                *asset_args(asset, target, delivery),
                *flags,
            )

    if allow_edit:

        @server.tool()
        def select(
            asset: Literal["script", "art", "voice"], candidate: str
        ) -> dict[str, Any]:
            """将已有候选选入绑定版本。"""
            core.name_part(candidate)
            return run("select", asset, f"--edition={edition}", "--", candidate)

        @server.tool()
        def render() -> dict[str, Any]:
            """在本机按锁定的时间线导出版本。"""
            return run("render", f"--edition={edition}")

    return server


def serve(work, edition, job, allow_edit=False):
    create_server(work, edition, job, allow_edit).run(transport="stdio")
