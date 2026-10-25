#!/usr/bin/env python3
"""Cost rollups across pi sessions.

Examples:
  python3 cost.py                                # last 7d, by day
  python3 cost.py --since 30d --by project
  python3 cost.py --since 30d --by model
  python3 cost.py --cwd /Volumes/T7/code/blanc   # one project, last 7d (the default window)
  python3 cost.py --since 30d --by session --limit 10 --show-subagents
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import sessions as S


GROUPINGS = ["total", "day", "project", "model", "session"]


def main() -> int:
    p = argparse.ArgumentParser(description="Cost rollups across pi sessions.")
    p.add_argument("--by", choices=GROUPINGS, default="day",
                   help="Grouping for the breakdown table (default: day). "
                        "'total' prints only the grand total.")
    p.add_argument("--show-subagents", action="store_true",
                   help="Also print a row with the subagent share for each group.")
    p.add_argument("--json", action="store_true", help="Emit JSON instead of a table.")
    p.add_argument("--benchmark-report", action="append", type=Path, default=[],
                   help="Read an explicit qualification JSON report instead of local sessions; repeat for comparison.")
    # Subagents are INCLUDED by default for cost so the totals reflect real spend.
    S.add_filter_args(p, subagents_default=True)
    args = p.parse_args()

    if args.benchmark_report:
        try:
            rows = benchmark_reports(args.benchmark_report)
        except (OSError, ValueError, KeyError, TypeError):
            print("Invalid qualification report; session storage was not read.", file=sys.stderr)
            return 1
        print(json.dumps(rows, indent=2))
        return 0

    # Default to last 7 days if no date filter given.
    if not args.since and not args.until and not args.session:
        args.since = "7d"

    filters = S.filters_from_args(args, subagents_default=True)
    # For grouped views, --limit caps groups, not sessions. Drop it from the
    # session-level filter so grouping sees every matching session.
    group_limit = args.limit if args.by != "total" else None
    if args.by != "total":
        filters.limit = None

    summaries = S.load_summaries(filters)

    if not summaries:
        S.stderr("No sessions matched.")
        return 0

    if args.json:
        report = build_report(summaries, args.by, group_limit)
        print(json.dumps(report, indent=2, default=str))
        return 0

    if args.by == "total":
        print_grand_total(summaries)
        return 0

    print_grand_total(summaries)
    print()
    print_grouped(summaries, args.by, show_subagents=args.show_subagents,
                  limit=group_limit)
    return 0


# ---------------------------------------------------------------------------
# Grouping
# ---------------------------------------------------------------------------


def benchmark_reports(paths) -> list[dict]:
    """Aggregate explicit qualification reports without scanning session storage."""
    from statistics import median
    groups = {}
    seen = set()

    def number(value, integer=False):
        if type(value) not in (int, float) or not 0 <= value <= 2**53 - 1:
            raise ValueError("Invalid qualification metric")
        if integer and type(value) is not int:
            raise ValueError("Expected a count")
        return value

    for path in paths:
        with path.open("rb") as source:
            content = source.read(5 * 1024 * 1024 + 1)
        if len(content) > 5 * 1024 * 1024:
            raise ValueError("Qualification report is too large")
        report = json.loads(content)
        if not isinstance(report, dict) or type(report.get("schemaVersion")) is not int or report["schemaVersion"] not in (1, 2, 3) or report.get("kind") != "live":
            raise ValueError("Expected a live qualification report")
        for field in ("runId", "modelId", "requestDigest", "fixtureDigest", "piVersion", "resourcesDigest", "harnessDigest"):
            if not isinstance(report[field], str) or not report[field] or len(report[field]) > 256:
                raise ValueError("Missing qualification identity")
        if not isinstance(report["runs"], list) or not report["runs"]:
            raise ValueError("Qualification report has no runs")
        identity = (report["runId"], report["modelId"])
        if identity in seen:
            raise ValueError("Duplicate qualification run")
        seen.add(identity)
        runtime = report.get("runtime")
        if report["schemaVersion"] >= 2:
            if report.get("runtimeVerified") is not True:
                raise ValueError("Runtime was not verified after the evaluation")
            fields = ("schemaVersion", "packageName", "version", "entryPoint", "codeDigest", "fileCount",
                      "sourceRevision", "nodeVersion", "platform", "arch")
            if not isinstance(runtime, dict) or set(runtime) != {*fields, "digest"}:
                raise ValueError("Missing runtime fingerprint")
            for field in ("packageName", "version", "entryPoint", "nodeVersion", "platform", "arch"):
                if not isinstance(runtime[field], str) or not runtime[field] or len(runtime[field]) > 256:
                    raise ValueError("Invalid runtime identity")
            for field in ("codeDigest", "digest"):
                if not isinstance(runtime[field], str) or not re.fullmatch(r"[a-f0-9]{64}", runtime[field]):
                    raise ValueError("Invalid runtime digest")
            if type(runtime["schemaVersion"]) is not int or runtime["schemaVersion"] != 1 or runtime["version"] != report["piVersion"]:
                raise ValueError("Runtime version differs")
            if number(runtime["fileCount"], integer=True) < 1:
                raise ValueError("Empty runtime fingerprint")
            if runtime["sourceRevision"] is not None and (not isinstance(runtime["sourceRevision"], str) or not re.fullmatch(r"[a-fA-F0-9]{40}", runtime["sourceRevision"])):
                raise ValueError("Invalid source revision")
            encoded = json.dumps({field: runtime[field] for field in fields}, separators=(",", ":"), ensure_ascii=False)
            if hashlib.sha256(encoded.encode("utf-8")).hexdigest() != runtime["digest"]:
                raise ValueError("Runtime fingerprint changed")
            if report["schemaVersion"] == 3:
                if report.get("executionVerified") is not True:
                    raise ValueError("Configuration was not verified after the evaluation")
                if report.get("cleanupVerified") is not True:
                    raise ValueError("Owned workspace cleanup was not verified")
                runtime_key = ("fingerprinted", runtime["digest"])
            else:
                runtime_key = ("configuration-unverified", report["runId"])
        else:
            # A legacy version string cannot establish that two runs used the same build.
            runtime = None
            runtime_key = ("legacy-unverified", report["runId"])
        fixtures = report["plan"].get("fixtures", [])
        if not isinstance(fixtures, list) or any(not isinstance(item, str) or not re.fullmatch(r"[a-z][a-z-]{0,63}", item) for item in fixtures) or len(set(fixtures)) != len(fixtures):
            raise ValueError("Invalid fixture selection")
        if report["schemaVersion"] >= 2 and not fixtures:
            raise ValueError("Missing fixture selection")
        expected_cases = None
        budgets = (None, None, None)
        if report["schemaVersion"] == 3:
            repeats = number(report["plan"].get("repeats"), integer=True)
            if not 1 <= repeats <= 10:
                raise ValueError("Invalid fixture repetition count")
            expected_cases = {(fixture, repetition) for fixture in fixtures
                              for repetition in range(1, repeats + 1)}
            max_requests = number(report["plan"].get("maxRequests"), integer=True)
            max_estimated_usd = number(report.get("maxEstimatedUsd"))
            reservation = number(report["plan"].get("reservationPerRequestUsd"))
            if not 1 <= max_requests <= 10000 or max_estimated_usd <= 0:
                raise ValueError("Invalid qualification budget")
            budgets = (max_requests, max_estimated_usd, reservation)
        context = number(report["plan"]["contextWindow"], integer=True)
        key = (report["modelId"], report["requestDigest"], report["fixtureDigest"], report["piVersion"],
               context, report["resourcesDigest"], report["harnessDigest"], json.dumps(report["profileFiles"], sort_keys=True), runtime_key, tuple(sorted(fixtures)), budgets)
        group = groups.setdefault(key, {
            "model": key[0], "request_digest": key[1], "fixture_digest": key[2], "pi_version": key[3],
            "context_window": context, "resources_digest": key[5], "harness_digest": key[6], "profile_files": report["profileFiles"],
            "runtime_status": runtime_key[0], "runtime": runtime,
            "fixtures": sorted(fixtures),
            "max_requests": budgets[0], "max_estimated_usd": budgets[1], "reservation_per_request_usd": budgets[2],
            "runs": 0, "passed": 0, "skipped": 0, "tool_errors": 0, "repeated_calls": 0,
            "retries": 0, "truncated": 0, "estimated_usage_usd": 0.0, "elapsed_ms": [],
        })
        cases = set()
        for run in report["runs"]:
            if not isinstance(run, dict) or type(run.get("passed")) is not bool or type(run.get("skipped", False)) is not bool:
                raise ValueError("Invalid run outcome")
            case = (run["fixture"], number(run["repetition"], integer=True))
            if expected_cases is not None and case not in expected_cases:
                raise ValueError("Run is outside the declared fixture plan")
            if case in cases or (run["passed"] and run.get("skipped")):
                raise ValueError("Duplicate or contradictory run")
            cases.add(case)
            group["runs"] += 1
            group["passed"] += run["passed"] is True
            group["skipped"] += run.get("skipped") is True
            metrics = run.get("metrics") or {}
            if not isinstance(metrics, dict):
                raise ValueError("Invalid metrics")
            for target, source in (("tool_errors", "toolErrors"), ("repeated_calls", "repeatedCalls"),
                                   ("retries", "retries"), ("truncated", "truncated")):
                group[target] += number(metrics.get(source, 0), integer=True)
            amount = run.get("estimatedUsageUsd")
            if amount is None:
                group["estimated_usage_usd"] = None
            else:
                number(amount)
                if group["estimated_usage_usd"] is not None:
                    group["estimated_usage_usd"] += amount
            if metrics.get("elapsedMs") is not None:
                elapsed = number(metrics["elapsedMs"])
                if run["passed"]:
                    group["elapsed_ms"].append(elapsed)
        if expected_cases is not None and cases != expected_cases:
            raise ValueError("Qualification report does not cover the declared fixture plan")
    result = []
    for group in groups.values():
        elapsed = group.pop("elapsed_ms")
        group["median_elapsed_ms"] = median(elapsed) if elapsed else None
        result.append(group)
    return sorted(result, key=lambda row: (-row["passed"] / max(row["runs"], 1), row["model"]))


def session_keys(s: S.SessionSummary, by: str):
    """Return the group key(s) a session contributes to, with the cost, message
    count and error count that belong to each key. For 'model' a session can
    split across several keys, and we re-scan the file to credit each message
    to the model that handled it. For everything else it's a single key with
    the session's own totals."""
    if by == "day":
        k = (s.started_at.astimezone().strftime("%Y-%m-%d")
             if s.started_at else "unknown")
        yield k, s.cost_total, s.message_count, s.error_count
    elif by == "project":
        yield (s.cwd or "?"), s.cost_total, s.message_count, s.error_count
    elif by == "session":
        yield s.id, s.cost_total, s.message_count, s.error_count
    elif by == "model":
        yield from _model_keys(s)
    else:
        yield "all", s.cost_total, s.message_count, s.error_count


def _model_keys(s: S.SessionSummary):
    """Split one session across the models that handled it.

    Cost comes from each assistant message's own usage. A message is credited
    to the model of the nearest assistant message at or before it, because a
    user prompt and its tool results belong to the turn they are part of.
    Messages before the first assistant message wait for that model."""
    cost = defaultdict(float)
    messages = defaultdict(int)
    errors = defaultdict(int)
    current = None
    pending = 0
    for rec in S.iter_records(s.path):
        if rec.get("type") != "message":
            continue
        m = rec.get("message") or {}
        role = m.get("role")
        if role == "assistant":
            current = m.get("model") or "?"
            cost[current] += float(((m.get("usage") or {}).get("cost") or {}).get("total") or 0)
            messages[current] += pending
            pending = 0
        if current is None:
            pending += 1
            continue
        messages[current] += 1
        if role == "toolResult" and m.get("isError"):
            errors[current] += 1

    if not cost and s.models:
        # No per-message usage to read. Only the cost needs a fallback: the walk above
        # already counted messages and errors per model from the roles alone.
        for model in s.models:
            cost[model] = s.cost_total / len(s.models)

    for model, model_cost in cost.items():
        yield model, model_cost, messages[model], errors[model]


def order_groups(rows: dict, by: str) -> list:
    """Day runs chronologically; every other grouping runs dearest first."""
    items = list(rows.items())
    if by == "day":
        # An undated session groups as "unknown", which sorts after every ISO
        # date; put it first so the most-recent slice keeps the real days.
        items.sort(key=lambda kv: (kv[0] != "unknown", kv[0]))
    else:
        items.sort(key=lambda kv: kv[1]["cost"], reverse=True)
    return items


def apply_group_limit(items: list, by: str, limit) -> list:
    """--limit caps groups, in both the table and the JSON.

    A cost-ordered grouping keeps the dearest groups. The day trend is
    chronological, so it keeps the most recent days and stays in order:
    trimming from the front would drop the days a reader asked for."""
    if not limit:
        return items
    return items[-limit:] if by == "day" else items[:limit]


def build_report(summaries, by: str, limit=None) -> dict:
    rows = defaultdict(lambda: dict(cost=0.0, sessions=0, messages=0, errors=0,
                                    sub_cost=0.0, sub_sessions=0))
    for s in summaries:
        for k, cost, messages, errors in session_keys(s, by):
            r = rows[k]
            r["cost"] += cost
            r["sessions"] += 1
            r["messages"] += messages
            r["errors"] += errors
            if s.is_subagent:
                r["sub_cost"] += cost
                r["sub_sessions"] += 1
    return {
        "grouping": by,
        "total_cost": sum(s.cost_total for s in summaries),
        "total_sessions": len(summaries),
        "groups": dict(apply_group_limit(order_groups(rows, by), by, limit)),
    }


# ---------------------------------------------------------------------------
# Printing
# ---------------------------------------------------------------------------


def print_grand_total(summaries) -> None:
    total = sum(s.cost_total for s in summaries)
    top_level = [s for s in summaries if not s.is_subagent]
    sub = [s for s in summaries if s.is_subagent]
    tok_in = sum(s.tok_input for s in summaries)
    tok_out = sum(s.tok_output for s in summaries)
    cache_r = sum(s.cost_cache_read for s in summaries)
    cache_w = sum(s.cost_cache_write for s in summaries)

    print(f"Total cost:  {S.fmt_money(total)}")
    print(f"  sessions:  {len(top_level)} top-level"
          + (f"  +  {len(sub)} subagent" if sub else ""))
    print(f"  cache:     read {S.fmt_money(cache_r)}   write {S.fmt_money(cache_w)}")
    print(f"  tokens:    in {tok_in:,}   out {tok_out:,}")
    if summaries:
        first = min((s.started_at for s in summaries if s.started_at), default=None)
        last = max((s.started_at for s in summaries if s.started_at), default=None)
        if first and last:
            print(f"  window:    {S.fmt_short_ts(first)}  →  {S.fmt_short_ts(last)}")


def print_grouped(summaries, by: str, *, show_subagents: bool, limit) -> None:
    # build_report already orders the groups and applies the group limit.
    items = list(build_report(summaries, by, limit)["groups"].items())

    label = {"day": "DATE", "project": "PROJECT", "model": "MODEL",
             "session": "SESSION"}[by]
    # Compute column widths
    keycol = max(len(label), max((len(_render_key(k, by)) for k, _ in items), default=4))
    keycol = min(keycol, 70)

    headers = [label.ljust(keycol), "COST".rjust(10), "SESS".rjust(5),
               "MSGS".rjust(6), "ERR".rjust(5)]
    if show_subagents:
        headers.append("SUB$".rjust(9))
    print("  ".join(headers))
    print("  ".join("-" * len(h) for h in headers))

    for k, r in items:
        key_disp = _render_key(k, by)
        if len(key_disp) > keycol:
            key_disp = "…" + key_disp[-(keycol - 1):]
        row = [
            key_disp.ljust(keycol),
            S.fmt_money(r["cost"]).rjust(10),
            str(r["sessions"]).rjust(5),
            str(r["messages"]).rjust(6),
            str(r["errors"]).rjust(5),
        ]
        if show_subagents:
            row.append(S.fmt_money(r["sub_cost"]).rjust(9))
        print("  ".join(row))


def _render_key(k: str, by: str) -> str:
    if by == "session":
        return k[:8] if k else "?"
    return k or "?"


if __name__ == "__main__":
    sys.exit(main())
