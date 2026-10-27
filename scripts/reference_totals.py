#!/usr/bin/env python3
"""Independent read only reference checker for Claude Code transcript usage.

Usage: python3 -I scripts/reference_totals.py [--tz Asia/Dhaka] [--out FILE] ROOT [ROOT ...]

Reads transcript files under each ROOT (a folder of project folders), applies the
agreed discovery and deduplication rules, and prints usage totals as JSON.
Standard library only. Nothing is written except the JSON output.
"""

import argparse
import json
import math
import os
import stat
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


# ---------------------------------------------------------------- helpers

def local_zone_name():
    """Best effort lookup of the system IANA zone name, or None."""
    tz = os.environ.get("TZ")
    if tz:
        tz = tz.lstrip(":")
        try:
            ZoneInfo(tz)
            return tz
        except Exception:
            pass
    try:
        target = os.path.realpath("/etc/localtime")
    except OSError:
        return None
    marker = "zoneinfo/"
    idx = target.rfind(marker)
    if idx >= 0:
        name = target[idx + len(marker):]
        try:
            ZoneInfo(name)
            return name
        except Exception:
            return None
    return None


def num(value):
    """Non negative integer from a JSON value; anything else is 0."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value if value > 0 else 0
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value) or value <= 0:
            return 0
        return int(value)
    return 0


def get_obj(d, key):
    v = d.get(key) if isinstance(d, dict) else None
    return v if isinstance(v, dict) else None


def nonempty_str(v):
    return isinstance(v, str) and v != ""


def parse_ts(value):
    """Aware UTC datetime, or None when the value is not a parseable timestamp."""
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ---------------------------------------------------------------- pricing

# Rates in milli USD per million tokens: (input, output, cache write 5m, cache write 1h, cache read).
# Tokens times milli USD per million tokens is exactly nano USD.
RATES = {
    "claude-opus-5-5": (4000, 20000, 5000, 8000, 200),
    "claude-sonnet-5-5": (2000, 10000, 2500, 4000, 100),
    "claude-sonnet-5": (2000, 10000, 2500, 4000, 200),
    "claude-haiku-5-5": (100, 500, 125, 200, 10),
    "claude-haiku-4-5": (1000, 5000, 1250, 2000, 100),
    "claude-haiku-4-5-20251001": (1000, 5000, 1250, 2000, 100),
}
HAIKU_LONG_RATES = (500, 2500, 625, 1000, 50)
LONG_PROMPT_LIMIT = 100000


def event_cost(model, vals):
    """Return (cost in nano USD, priced flag) for one winning usage event."""
    rates = RATES.get(model)
    if rates is None:
        return 0, False
    if model == "claude-haiku-5-5":
        prompt = vals["input"] + vals["cache_read"] + vals["cache_write"]
        if prompt > LONG_PROMPT_LIMIT:
            rates = HAIKU_LONG_RATES
    r_in, r_out, r_w5, r_w1, r_read = rates
    if model == "claude-opus-5-5" and vals["speed"] == "fast":
        r_in, r_out, r_w5, r_w1, r_read = (2 * r_in, 2 * r_out, 2 * r_w5, 2 * r_w1, 2 * r_read)
    w5 = vals["cache_write_5m"]
    w1 = vals["cache_write_1h"]
    rest = vals["cache_write"] - w5 - w1
    if rest > 0:
        w5 += rest
    cost = (vals["input"] * r_in + vals["output"] * r_out + w5 * r_w5
            + w1 * r_w1 + vals["cache_read"] * r_read)
    if vals["geo"] == "us":
        cost = (cost * 11 + 5) // 10
    return cost, True


# ---------------------------------------------------------------- discovery

def is_reg(path):
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def is_real_dir(path):
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def top_level_session(name):
    """Session id for an accepted top level file name, or None."""
    if name.endswith(".jsonl") or ".jsonl.superseded-" in name:
        pass
    else:
        return None
    sid = name.split(".", 1)[0]
    if not sid:
        return None
    if name == sid + ".jsonl":
        return sid
    if name.startswith(sid + ".orphaned-") and name.endswith(".jsonl"):
        return sid
    if name.startswith(sid + ".jsonl.superseded-"):
        return sid
    return None


def discover(roots):
    """Return a list of (path, session_id, is_top_level), in a stable order."""
    found = []
    for root in roots:
        try:
            entries = sorted(os.listdir(root))
        except OSError:
            continue
        for pname in entries:
            ppath = os.path.join(root, pname)
            if not is_real_dir(ppath):
                continue
            try:
                items = sorted(os.listdir(ppath))
            except OSError:
                continue
            for iname in items:
                ipath = os.path.join(ppath, iname)
                try:
                    mode = os.lstat(ipath).st_mode
                except OSError:
                    continue
                if stat.S_ISREG(mode):
                    sid = top_level_session(iname)
                    if sid is not None:
                        found.append((ipath, sid, True))
                elif stat.S_ISDIR(mode):
                    sub = os.path.join(ipath, "subagents")
                    if not is_real_dir(sub):
                        continue
                    try:
                        agents = sorted(os.listdir(sub))
                    except OSError:
                        continue
                    for aname in agents:
                        if aname.startswith("agent-") and aname.endswith(".jsonl") and len(aname) > len("agent-.jsonl"):
                            apath = os.path.join(sub, aname)
                            if is_reg(apath):
                                found.append((apath, iname, False))
    return found


# ---------------------------------------------------------------- reading

def read_lines(path):
    """Yield complete raw lines (without the newline). A final partial line is dropped."""
    with open(path, "rb") as fh:
        for raw in fh:
            if not raw.endswith(b"\n"):
                return
            yield raw[:-1]


class Event:
    __slots__ = ("rank", "usage_vals", "model", "time", "session", "session_top")

    def __init__(self):
        self.rank = None
        self.usage_vals = None
        self.model = None
        self.time = None
        self.session = None
        self.session_top = False


def usage_values(usage):
    cc = get_obj(usage, "cache_creation")
    otd = get_obj(usage, "output_tokens_details")
    stu = get_obj(usage, "server_tool_use")
    return {
        "input": num(usage.get("input_tokens")),
        "output": num(usage.get("output_tokens")),
        "cache_read": num(usage.get("cache_read_input_tokens")),
        "cache_write": num(usage.get("cache_creation_input_tokens")),
        "cache_write_5m": num(cc.get("ephemeral_5m_input_tokens")) if cc else 0,
        "cache_write_1h": num(cc.get("ephemeral_1h_input_tokens")) if cc else 0,
        "thinking": num(otd.get("thinking_tokens")) if otd else 0,
        "web_search": num(stu.get("web_search_requests")) if stu else 0,
        "web_fetch": num(stu.get("web_fetch_requests")) if stu else 0,
        "speed": usage.get("speed"),
        "geo": usage.get("inference_geo"),
    }


def compute(roots, tzname):
    zone = ZoneInfo(tzname)
    files = discover(roots)

    seen_inodes = set()
    n_top = 0
    n_sub = 0
    malformed = 0

    events = {}  # key -> Event
    tool_names = {}  # tool_use id -> name
    messages = {}  # uuid -> (kind, sidechain)
    session_ids = set()

    for path, file_sid, is_top in files:
        try:
            st = os.stat(path)
        except OSError:
            continue
        ident = (st.st_dev, st.st_ino)
        if ident in seen_inodes:
            continue
        seen_inodes.add(ident)
        if is_top:
            n_top += 1
        else:
            n_sub += 1

        try:
            lines = read_lines(path)
            for raw in lines:
                if raw == b"":
                    continue
                try:
                    rec = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError, RecursionError):
                    malformed += 1
                    continue
                if not isinstance(rec, dict):
                    malformed += 1
                    continue

                rtype = rec.get("type")
                ts = parse_ts(rec.get("timestamp"))

                if rtype == "assistant":
                    msg = get_obj(rec, "message")
                    usage = get_obj(msg, "usage") if msg else None
                    if (
                        msg is not None
                        and usage is not None
                        and ts is not None
                        and msg.get("model") != "<synthetic>"
                        and rec.get("isApiErrorMessage") is not True
                        and nonempty_str(msg.get("id"))
                    ):
                        rid = rec.get("requestId")
                        key = msg["id"] + "|" + rid if nonempty_str(rid) else msg["id"]
                        if is_top:
                            session_ids.add(file_sid)
                        vals = usage_values(usage)
                        sr = msg.get("stop_reason")
                        rank = (1 if nonempty_str(sr) else 0, vals["output"])
                        model = msg.get("model")
                        if not isinstance(model, str):
                            model = "unknown"
                        line_sid = rec.get("sessionId")
                        sid = line_sid if nonempty_str(line_sid) else file_sid

                        ev = events.get(key)
                        if ev is None:
                            ev = Event()
                            ev.rank = rank
                            ev.usage_vals = vals
                            ev.model = model
                            ev.time = ts
                            ev.session = sid
                            ev.session_top = is_top
                            events[key] = ev
                        else:
                            if rank > ev.rank:
                                ev.rank = rank
                                ev.usage_vals = vals
                                ev.model = model
                            if ts < ev.time:
                                ev.time = ts
                            if is_top and not ev.session_top:
                                ev.session = sid
                                ev.session_top = True

                        content = msg.get("content")
                        if isinstance(content, list):
                            for block in content:
                                if (
                                    isinstance(block, dict)
                                    and block.get("type") == "tool_use"
                                    and isinstance(block.get("id"), str)
                                    and isinstance(block.get("name"), str)
                                ):
                                    tool_names.setdefault(block["id"], block["name"])

                elif rtype == "user":
                    uuid = rec.get("uuid")
                    if isinstance(uuid, str) and ts is not None:
                        if is_top:
                            session_ids.add(file_sid)
                        if uuid not in messages:
                            msg = get_obj(rec, "message")
                            content = msg.get("content") if msg else None
                            if rec.get("isCompactSummary") is True:
                                kind = "compact_summary"
                            elif rec.get("isMeta") is True:
                                kind = "meta"
                            elif isinstance(content, list) and any(
                                isinstance(b, dict) and b.get("type") == "tool_result" for b in content
                            ):
                                kind = "tool_result"
                            else:
                                kind = "prompt"
                            messages[uuid] = (kind, rec.get("isSidechain") is True)
        except OSError:
            continue

    # ---- aggregate
    totals = {k: 0 for k in (
        "input", "output", "cache_read", "cache_write", "cache_write_5m",
        "cache_write_1h", "thinking", "web_search", "web_fetch")}
    totals["cost_nanos"] = 0
    unpriced_events = 0
    per_model, per_day, per_session = {}, {}, {}

    def bump(table, name, vals, cost, priced):
        row = table.get(name)
        if row is None:
            row = {"events": 0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
                   "cost_nanos": 0}
            if table is per_model:
                row["unpriced"] = 0
            table[name] = row
        row["events"] += 1
        for f in ("input", "output", "cache_read", "cache_write"):
            row[f] += vals[f]
        row["cost_nanos"] += cost
        if table is per_model and not priced:
            row["unpriced"] += 1

    for ev in events.values():
        vals = ev.usage_vals
        for k in totals:
            if k != "cost_nanos":
                totals[k] += vals[k]
        cost, priced = event_cost(ev.model, vals)
        totals["cost_nanos"] += cost
        if not priced:
            unpriced_events += 1
        day = ev.time.astimezone(zone).strftime("%Y-%m-%d")
        bump(per_model, ev.model, vals, cost, priced)
        bump(per_day, day, vals, cost, priced)
        bump(per_session, ev.session, vals, cost, priced)

    by_name = {}
    for name in tool_names.values():
        by_name[name] = by_name.get(name, 0) + 1

    msg_out = {k: {"main": 0, "sidechain": 0} for k in ("compact_summary", "meta", "prompt", "tool_result")}
    for kind, side in messages.values():
        msg_out[kind]["sidechain" if side else "main"] += 1

    def ordered(d):
        return {k: d[k] for k in sorted(d)}

    return {
        "tz": tzname,
        "files": {"top_level": n_top, "subagent": n_sub},
        "malformed_lines": malformed,
        "usage_events": len(events),
        "unpriced_events": unpriced_events,
        "totals": ordered(totals),
        "per_model": ordered(per_model),
        "per_day": ordered(per_day),
        "per_session": ordered(per_session),
        "tool_calls": {"total": len(tool_names), "by_name": ordered(by_name)},
        "messages": ordered(msg_out),
        "sessions": len(session_ids),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Reference usage totals from Claude Code transcripts (read only).")
    ap.add_argument("--tz", default=None, help="IANA zone name, for example Asia/Dhaka")
    ap.add_argument("--out", default=None, help="write JSON here instead of stdout")
    ap.add_argument("roots", nargs="+", metavar="ROOT")
    args = ap.parse_args(argv)

    tzname = args.tz or local_zone_name()
    if not tzname:
        ap.error("could not determine the local time zone, pass --tz")
    try:
        ZoneInfo(tzname)
    except Exception:
        ap.error("unknown time zone: " + tzname)

    out_path = None
    if args.out:
        out_path = os.path.realpath(os.path.expanduser(args.out))
        forbidden = os.path.realpath(os.path.expanduser("~/.claude"))
        if out_path == forbidden or out_path.startswith(forbidden + os.sep):
            ap.error("--out must not be under ~/.claude")

    roots = [os.path.expanduser(r) for r in args.roots]
    result = compute(roots, tzname)
    text = json.dumps(result, sort_keys=True, indent=2) + "\n"
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
