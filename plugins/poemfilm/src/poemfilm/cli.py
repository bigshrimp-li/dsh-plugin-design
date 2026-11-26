"""命令行与稳定 JSON 输出。"""

import argparse
import json
import sys
from pathlib import Path

from . import __version__, core, workspace


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise core.Fail("invalid_arguments", message)


def parser():
    root = Parser(
        prog="poemfilm",
        description="古诗视频制作 · API 赠金与离线剪辑",
        epilog="全局参数 --work DIR、--json 可放在子命令前后。",
    )
    root.add_argument("--version", action="version", version=f"poemfilm {__version__}")
    root.add_argument("--work", metavar="DIR", help="作品目录，默认当前目录")
    root.add_argument("--json", action="store_true", help="输出机器可读的 JSON")
    groups = root.add_subparsers(dest="command", required=True)

    def sub(group, actions):
        cmds = group.add_subparsers(dest="action", required=True)
        return {
            name: cmds.add_parser(name, help=desc) for name, desc in actions.items()
        }

    init = groups.add_parser("init", help="从原词建立本机作品")
    init.add_argument("dir")
    init.add_argument("--poem", required=True)
    init.add_argument("--edition", default="初版")
    init.add_argument("--author")
    init.add_argument("--title")
    init.add_argument("--reference", action="append", default=[])
    auth = sub(
        groups.add_parser("auth", help="本地项目密钥"),
        {
            "login": "无回显保存到钥匙串",
            "status": "离线读取凭证状态",
            "check": "在线读取模型目录",
            "logout": "移除本机密钥",
        },
    )
    for name, cmd in auth.items():
        cmd.add_argument("--profile", required=name in {"login", "logout"})
    auth["login"].add_argument("--org", required=True)
    auth["login"].add_argument("--project", required=True)
    funds = sub(
        groups.add_parser("funding", help="赠金核对与余额"),
        {"bind": "绑定资金核对记录", "status": "查看礼金与本机预留"},
    )
    funds["bind"].add_argument("--record", required=True)
    for cmd in funds.values():
        cmd.add_argument("--profile")
    jobs = sub(
        groups.add_parser("job", help="管理委托预算"),
        {"authorize": "按作品、操作和预算签发任务", "status": "查看任务状态"},
    )
    jobs["authorize"].add_argument("--edition")
    jobs["authorize"].add_argument("--expires-at", help="含时区的授权截止时间")
    jobs["authorize"].add_argument(
        "--scope",
        required=True,
        action="append",
        help="可重复，例 voice:line-05 或 art:*",
    )
    jobs["authorize"].add_argument("--max-usd", required=True)
    jobs["authorize"].add_argument("--max-generations", type=int)
    jobs["status"].add_argument("--job", required=True)
    editions = sub(
        groups.add_parser("edition", help="管理作品版本"),
        {"fork": "从既有版本创建对照版"},
    )
    editions["fork"].add_argument("source")
    editions["fork"].add_argument("destination")
    for group in ("generate", "select", "import"):
        cmds = sub(
            groups.add_parser(
                group,
                help={
                    "generate": "生成或离线估价",
                    "select": "选入版本",
                    "import": "导入已有素材",
                }[group],
            ),
            {"script": "分镜", "art": "镜头原画", "voice": "音轨"},
        )
        for name, cmd in cmds.items():
            cmd.add_argument("--edition")
            if group == "generate":
                cmd.add_argument("--max-usd")
                cmd.add_argument("--estimate-only", action="store_true")
                cmd.add_argument("--take", help="显式命名新候选，以便断点恢复")
                cmd.add_argument("--job", help="可信宿主绑定的任务 ID")
                if name == "voice":
                    cmd.add_argument("--line", required=True)
                    cmd.add_argument("--delivery", required=True)
                if name == "art":
                    cmd.add_argument("--shot", required=True)
            elif group == "select":
                cmd.add_argument("candidate")
                if name == "voice":
                    cmd.add_argument(
                        "--reviewed", action="store_true", help="确认已人工逐句核听"
                    )
                    cmd.add_argument(
                        "--cues", help="该版本已核对的句内字幕时间码 JSON 文件"
                    )
            else:
                cmd.add_argument("--file", required=True)
                cmd.add_argument("--source", required=True, help="素材来源或表演者")
                cmd.add_argument(
                    "--license", required=True, help="作品可以使用它的依据"
                )
                cmd.add_argument("--target", required=name != "script")
                if name == "voice":
                    cmd.add_argument(
                        "--reviewed", action="store_true", help="人已逐句核听过该录音"
                    )
                    cmd.add_argument("--cues", help="已核对的 JSON 句内时间码")
                else:
                    cmd.set_defaults(reviewed=False, cues=None)
    for name, desc in {
        "show": "显示台词、镜头、候选与选择",
        "plan": "构建离线剪辑清单",
        "render": "按锁定时间线出片",
        "verify": "核验实际媒体",
    }.items():
        groups.add_parser(name, help=desc).add_argument("--edition")
    bridge = groups.add_parser("mcp", help="向工具型宿主提供本机 stdio MCP 接口")
    bridge.add_argument("--edition")
    bridge.add_argument("--job", help="宿主分配给本会话的任务，省略时仅允许离线操作")
    bridge.add_argument(
        "--allow-edit", action="store_true", help="允许选择候选和导出绑定版本"
    )
    return root


def dispatch(args, work):
    cmd = args.command
    if cmd == "init":
        return workspace.init_work(args)
    if cmd in {"auth", "funding", "job"}:
        from . import funding

        if cmd == "job" and args.action == "authorize":
            args.edition = core.load_edition(work, args.edition)["name"]
        return funding.handle(args, work)
    cfg = core.load_work(work)
    if cmd == "edition":
        with core.work_lock(work):
            edition = core.load_edition(work, args.source)
            target = core.edition_path(work, args.destination)
            if target.exists():
                raise core.Fail("edition_exists", "该版本已经存在。")
            edition["name"] = args.destination
            core.write_yaml(target, edition)
        return {"edition": args.destination, "from": args.source}
    args.edition = args.edition or cfg["default_edition"]
    ed = core.load_edition(work, args.edition)
    if cmd == "show":
        folder = core.asset_path(work, "candidates")
        candidates = [
            path.parent.name
            for path in sorted(folder.glob("*/record.json"))
            if not path.parent.name.startswith(".")
        ]
        return {
            "title": cfg["title"],
            "edition": args.edition,
            **core.story(work, ed),
            "selected": {k: ed.get(k) for k in ("script", "art", "voice")},
            "candidates": candidates,
        }
    if cmd == "import":
        return workspace.import_candidate(work, args)
    if cmd == "select":
        return workspace.select(work, args)
    if cmd == "generate":
        from . import generate

        return generate.handle(args, work)
    if cmd == "mcp":
        from .bridge import serve

        serve(work, args.edition, args.job, args.allow_edit)
        return None
    from . import media

    return media.handle(args, work)


def invoke(argv):
    # Extract globals first so scripts and humans can use either flag position.
    global_parser = Parser(add_help=False, allow_abbrev=False)
    global_parser.add_argument("--work", default=".")
    global_parser.add_argument("--json", action="store_true")
    command = None
    try:
        opts, remaining = global_parser.parse_known_args(argv)
        args = parser().parse_args(remaining)
        command = args.command
        action = getattr(args, "action", None)
        if action:
            command += "." + action
        data = dispatch(args, Path(opts.work).expanduser().resolve())
        return 0, {"schema_version": 1, "ok": True, "command": command, "data": data}
    except core.Fail as exc:
        error, status = (
            {"code": exc.code, "message": str(exc), **exc.details},
            exc.exit_code,
        )
    except (OSError, UnicodeError, ValueError) as exc:
        error, status = {"code": "input_or_io_error", "message": str(exc)}, 2
    return status, {
        "schema_version": 1,
        "ok": False,
        "command": command,
        "error": error,
    }


def main():
    args = sys.argv[1:]
    status, result = invoke(args)
    if result.get("command") == "mcp" and result.get("ok"):
        return status
    if "--json" in args:
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    elif result["ok"]:
        print(json.dumps(result["data"], ensure_ascii=False, indent=2, allow_nan=False))
    else:
        error = result["error"]
        print(f"{error['code']}: {error['message']}", file=sys.stderr)
    return status
