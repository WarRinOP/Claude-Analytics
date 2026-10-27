import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference_totals as rt  # noqa: E402


def asst(mid, rid="r1", ts="2026-01-01T10:00:00Z", out=1, stop=None, model="m1",
         inp=10, sid="s1", content=None, **extra):
    msg = {
        "id": mid, "model": model, "stop_reason": stop,
        "usage": {"input_tokens": inp, "output_tokens": out},
        "content": content or [],
    }
    rec = {"type": "assistant", "timestamp": ts, "sessionId": sid, "message": msg}
    if rid is not None:
        rec["requestId"] = rid
    rec.update(extra)
    return rec


def write(path, recs, tail=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for r in recs:
            fh.write((r if isinstance(r, str) else json.dumps(r)) + "\n")
        fh.write(tail)


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.root = os.path.join(self._td.name, "projects")
        self.proj = os.path.join(self.root, "p1")
        os.makedirs(self.proj)

    def run_rt(self, tz="UTC"):
        return rt.compute([self.root], tz)


class Tests(Base):
    def test_earlier_larger_output_without_stop_loses_to_stop_line(self):
        write(os.path.join(self.proj, "s1.jsonl"), [
            asst("a", out=50, stop=None, inp=1),
            asst("a", out=5, stop="end_turn", inp=2),
        ])
        r = self.run_rt()
        self.assertEqual(r["usage_events"], 1)
        self.assertEqual(r["totals"]["output"], 5)
        self.assertEqual(r["totals"]["input"], 2)

    def test_larger_output_wins_without_stop(self):
        write(os.path.join(self.proj, "s1.jsonl"), [
            asst("a", out=5), asst("a", out=9), asst("a", out=7),
        ])
        self.assertEqual(self.run_rt()["totals"]["output"], 9)

    def test_equal_rank_keeps_first(self):
        write(os.path.join(self.proj, "s1.jsonl"), [
            asst("a", out=5, inp=111, model="first"),
            asst("a", out=5, inp=222, model="second"),
        ])
        r = self.run_rt()
        self.assertEqual(r["totals"]["input"], 111)
        self.assertEqual(list(r["per_model"]), ["first"])

    def test_earliest_time_across_midnight(self):
        write(os.path.join(self.proj, "s1.jsonl"), [
            asst("a", out=9, stop="end_turn", ts="2026-01-02T00:30:00Z"),
            asst("a", out=1, ts="2026-01-01T23:30:00Z"),
        ])
        r = self.run_rt("UTC")
        self.assertEqual(list(r["per_day"]), ["2026-01-01"])
        # 23:30Z is already the next day in Dhaka (UTC+6)
        r = self.run_rt("Asia/Dhaka")
        self.assertEqual(list(r["per_day"]), ["2026-01-02"])

    def test_synthetic_and_api_error_excluded(self):
        write(os.path.join(self.proj, "s1.jsonl"), [
            asst("a", model="<synthetic>"),
            asst("b", isApiErrorMessage=True),
            asst("c"),
        ])
        self.assertEqual(self.run_rt()["usage_events"], 1)

    def test_key_without_request_id(self):
        write(os.path.join(self.proj, "s1.jsonl"), [asst("a", rid=None), asst("a", rid="x")])
        self.assertEqual(self.run_rt()["usage_events"], 2)

    def test_symlinked_folder_and_loop_skipped(self):
        write(os.path.join(self.proj, "s1.jsonl"), [asst("a")])
        os.symlink(self.proj, os.path.join(self.root, "alias"))
        os.symlink(self.proj, os.path.join(self.proj, "p1"))  # loop inside
        r = self.run_rt()
        self.assertEqual(r["files"]["top_level"], 1)
        self.assertEqual(r["usage_events"], 1)

    def test_symlinked_file_skipped(self):
        write(os.path.join(self.proj, "s1.jsonl"), [asst("a")])
        os.symlink(os.path.join(self.proj, "s1.jsonl"), os.path.join(self.proj, "s2.jsonl"))
        self.assertEqual(self.run_rt()["files"]["top_level"], 1)

    def test_partial_final_line_ignored(self):
        write(os.path.join(self.proj, "s1.jsonl"), [asst("a")], tail=json.dumps(asst("b")))
        r = self.run_rt()
        self.assertEqual(r["usage_events"], 1)
        self.assertEqual(r["malformed_lines"], 0)

    def test_malformed_counted_empty_skipped(self):
        write(os.path.join(self.proj, "s1.jsonl"), ["{bad", "", "[1]", asst("a")])
        r = self.run_rt()
        self.assertEqual(r["malformed_lines"], 2)
        self.assertEqual(r["usage_events"], 1)

    def test_hard_link_read_once(self):
        a = os.path.join(self.proj, "s1.jsonl")
        write(a, [asst("a")])
        os.link(a, os.path.join(self.proj, "s1.orphaned-1-x.jsonl"))
        r = self.run_rt()
        self.assertEqual(r["files"]["top_level"], 1)
        self.assertEqual(r["usage_events"], 1)

    def test_extra_file_name_forms(self):
        write(os.path.join(self.proj, "s1.jsonl"), [asst("a")])
        write(os.path.join(self.proj, "s1.orphaned-9-z.jsonl"), [asst("b")])
        write(os.path.join(self.proj, "s1.jsonl.superseded-9"), [asst("c")])
        write(os.path.join(self.proj, "notes.txt"), [asst("d")])
        r = self.run_rt()
        self.assertEqual(r["files"]["top_level"], 3)
        self.assertEqual(r["usage_events"], 3)
        self.assertEqual(r["sessions"], 1)

    def test_tool_use_on_non_winner_line(self):
        tu = [{"type": "tool_use", "id": "t1", "name": "Bash"}]
        tu2 = [{"type": "tool_use", "id": "t2", "name": "Read"}, {"type": "tool_use", "id": "t1", "name": "Bash"}]
        write(os.path.join(self.proj, "s1.jsonl"), [
            asst("a", out=1, content=tu),
            asst("a", out=9, stop="end_turn", content=tu2),
            asst("z", model="<synthetic>", content=[{"type": "tool_use", "id": "t9", "name": "X"}]),
        ])
        r = self.run_rt()
        self.assertEqual(r["tool_calls"]["total"], 2)
        self.assertEqual(r["tool_calls"]["by_name"], {"Bash": 1, "Read": 1})

    def test_subagent_files_and_session_attribution(self):
        write(os.path.join(self.proj, "s1", "subagents", "agent-ab.jsonl"),
              [asst("a", sid="sub")])
        write(os.path.join(self.proj, "s1", "subagents", "other.jsonl"), [asst("q")])
        write(os.path.join(self.proj, "s1", "deeper", "subagents", "agent-x.jsonl"), [asst("q")])
        r = self.run_rt()
        self.assertEqual(r["files"], {"top_level": 0, "subagent": 1})
        self.assertEqual(r["sessions"], 0)
        # now the main file holds the same key: attribution moves to the top level line
        write(os.path.join(self.proj, "s1.jsonl"), [asst("a", sid="main")])
        r = self.run_rt()
        self.assertEqual(r["usage_events"], 1)
        self.assertEqual(list(r["per_session"]), ["main"])
        self.assertEqual(r["sessions"], 1)

    def test_messages(self):
        def u(uuid, **kw):
            rec = {"type": "user", "uuid": uuid, "timestamp": "2026-01-01T00:00:00Z",
                   "message": {"content": "hi"}}
            rec.update(kw)
            return rec
        write(os.path.join(self.proj, "s1.jsonl"), [
            u("1"), u("1"), u("2", isMeta=True), u("3", isCompactSummary=True, isMeta=True),
            u("4", message={"content": [{"type": "tool_result"}]}, isSidechain=True),
            u("5", timestamp="nope"), {"type": "user", "timestamp": "2026-01-01T00:00:00Z"},
        ])
        r = self.run_rt()
        m = r["messages"]
        self.assertEqual(m["prompt"], {"main": 1, "sidechain": 0})
        self.assertEqual(m["meta"], {"main": 1, "sidechain": 0})
        self.assertEqual(m["compact_summary"], {"main": 1, "sidechain": 0})
        self.assertEqual(m["tool_result"], {"main": 0, "sidechain": 1})
        self.assertEqual(r["sessions"], 1)

    def test_bad_numbers_are_zero(self):
        rec = asst("a")
        rec["message"]["usage"] = {"input_tokens": -4, "output_tokens": "x",
                                   "cache_read_input_tokens": True, "cache_creation_input_tokens": 7,
                                   "cache_creation": {"ephemeral_5m_input_tokens": 3},
                                   "server_tool_use": {"web_search_requests": 2}}
        write(os.path.join(self.proj, "s1.jsonl"), [rec])
        t = self.run_rt()["totals"]
        self.assertEqual((t["input"], t["output"], t["cache_read"], t["cache_write"]), (0, 0, 0, 7))
        self.assertEqual((t["cache_write_5m"], t["cache_write_1h"], t["web_search"]), (3, 0, 2))

    def test_unparseable_timestamp_not_candidate(self):
        write(os.path.join(self.proj, "s1.jsonl"), [asst("a", ts="garbage")])
        self.assertEqual(self.run_rt()["usage_events"], 0)


def priced(mid, model, usage, rid="r1", sid="s1", ts="2026-01-01T10:00:00Z", stop="end_turn"):
    return {"type": "assistant", "timestamp": ts, "sessionId": sid, "requestId": rid,
            "message": {"id": mid, "model": model, "stop_reason": stop, "usage": usage, "content": []}}


class CostTests(Base):
    def cost_of(self, model, usage):
        write(os.path.join(self.proj, "s1.jsonl"), [priced("a", model, usage)])
        r = self.run_rt()
        self.assertEqual(r["totals"]["cost_nanos"], r["per_model"][model]["cost_nanos"])
        return r

    def nanos(self, model, usage):
        return self.cost_of(model, usage)["totals"]["cost_nanos"]

    def test_opus_arithmetic(self):
        u = {"input_tokens": 1000, "output_tokens": 200, "cache_read_input_tokens": 3000,
             "cache_creation_input_tokens": 600,
             "cache_creation": {"ephemeral_5m_input_tokens": 400, "ephemeral_1h_input_tokens": 200}}
        # 4,000,000 + 4,000,000 + 2,000,000 + 1,600,000 + 600,000
        r = self.cost_of("claude-opus-5-5", u)
        self.assertEqual(r["totals"]["cost_nanos"], 12200000)
        self.assertEqual(r["per_model"]["claude-opus-5-5"]["unpriced"], 0)
        self.assertEqual(r["unpriced_events"], 0)

    def test_sonnet_5_arithmetic(self):
        u = {"input_tokens": 1000, "output_tokens": 100, "cache_read_input_tokens": 1000,
             "cache_creation_input_tokens": 300,
             "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200}}
        # 2,000,000 + 1,000,000 + 250,000 + 800,000 + 200,000
        self.assertEqual(self.nanos("claude-sonnet-5", u), 4250000)

    def test_sonnet_5_5_arithmetic_cache_read_100(self):
        u = {"input_tokens": 1000, "output_tokens": 100, "cache_read_input_tokens": 1000,
             "cache_creation_input_tokens": 300,
             "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200}}
        # 2,000,000 + 1,000,000 + 250,000 + 800,000 + 100,000 (cache read at 100, not 200)
        self.assertEqual(self.nanos("claude-sonnet-5-5", u), 4150000)

    def test_haiku_5_5_arithmetic(self):
        u = {"input_tokens": 1000, "output_tokens": 1000, "cache_read_input_tokens": 1000,
             "cache_creation_input_tokens": 2000,
             "cache_creation": {"ephemeral_5m_input_tokens": 1000, "ephemeral_1h_input_tokens": 1000}}
        # 100,000 + 500,000 + 125,000 + 200,000 + 10,000
        self.assertEqual(self.nanos("claude-haiku-5-5", u), 935000)

    def test_haiku_4_5_arithmetic_both_names(self):
        u = {"input_tokens": 100, "output_tokens": 100, "cache_read_input_tokens": 100,
             "cache_creation_input_tokens": 200,
             "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 100}}
        # 100,000 + 500,000 + 125,000 + 200,000 + 10,000
        for m in ("claude-haiku-4-5", "claude-haiku-4-5-20251001"):
            self.assertEqual(self.nanos(m, u), 935000)

    def test_remainder_goes_to_5m(self):
        u = {"cache_creation_input_tokens": 1000,
             "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200}}
        # remainder 700 joins 5m: 800 * 2500 + 200 * 4000
        self.assertEqual(self.nanos("claude-sonnet-5", u), 2800000)
        # no breakdown at all: everything at the 5m rate
        self.assertEqual(self.nanos("claude-sonnet-5", {"cache_creation_input_tokens": 1000}), 2500000)

    def test_breakdown_larger_than_total_adds_nothing(self):
        u = {"cache_creation_input_tokens": 100,
             "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200}}
        self.assertEqual(self.nanos("claude-sonnet-5", u), 100 * 2500 + 200 * 4000)

    def test_haiku_5_5_long_tier_boundary(self):
        at = {"input_tokens": 60000, "cache_read_input_tokens": 30000,
              "cache_creation_input_tokens": 10000, "output_tokens": 10}
        over = dict(at, input_tokens=60001)
        # 100000 exactly is the normal tier: 60000*100 + 10*500 + 30000*10 + 10000*125 (remainder at 5m)
        self.assertEqual(self.nanos("claude-haiku-5-5", at), 6000000 + 5000 + 300000 + 1250000)
        # 100001 is the long tier: 60001*500 + 10*2500 + 30000*50 + 10000*625
        self.assertEqual(self.nanos("claude-haiku-5-5", over), 30000500 + 25000 + 1500000 + 6250000)

    def test_long_tier_only_for_haiku_5_5(self):
        u = {"input_tokens": 200000}
        self.assertEqual(self.nanos("claude-haiku-4-5", u), 200000 * 1000)
        self.assertEqual(self.nanos("claude-sonnet-5", u), 200000 * 2000)

    def test_long_tier_uses_cache_write_total_field(self):
        # prompt size uses cache_creation_input_tokens, not the 5m and 1h breakdown
        u = {"input_tokens": 50000, "cache_read_input_tokens": 40000,
             "cache_creation_input_tokens": 10001,
             "cache_creation": {"ephemeral_5m_input_tokens": 1, "ephemeral_1h_input_tokens": 1}}
        # remainder 9999 joins 5m (10000 in all), 1h stays 1
        want = 50000 * 500 + 40000 * 50 + 10000 * 625 + 1 * 1000
        self.assertEqual(self.nanos("claude-haiku-5-5", u), want)

    def test_fast_mode_doubles_opus_only(self):
        u = {"input_tokens": 1000, "output_tokens": 100, "cache_read_input_tokens": 1000,
             "cache_creation_input_tokens": 500,
             "cache_creation": {"ephemeral_5m_input_tokens": 300, "ephemeral_1h_input_tokens": 200},
             "speed": "fast"}
        slow = dict(u, speed="standard")
        base = 1000 * 4000 + 100 * 20000 + 300 * 5000 + 200 * 8000 + 1000 * 200
        self.assertEqual(self.nanos("claude-opus-5-5", slow), base)
        self.assertEqual(self.nanos("claude-opus-5-5", u), 2 * base)
        sonnet = 1000 * 2000 + 100 * 10000 + 300 * 2500 + 200 * 4000 + 1000 * 100
        self.assertEqual(self.nanos("claude-sonnet-5-5", u), sonnet)
        haiku = 1000 * 100 + 100 * 500 + 300 * 125 + 200 * 200 + 1000 * 10
        self.assertEqual(self.nanos("claude-haiku-5-5", u), haiku)

    def test_geo_us_rounding_boundary(self):
        us = {"inference_geo": "us"}
        # exact 100 nanos (1 haiku 5.5 input token) -> 1100 + 5 = 1105 // 10 = 110
        self.assertEqual(self.nanos("claude-haiku-5-5", dict(us, input_tokens=1)), 110)
        # exact 125 nanos (1 haiku 5.5 cache write at 5m) -> 1375 + 5 = 1380 // 10 = 138 (137.5 rounds up)
        self.assertEqual(self.nanos("claude-haiku-5-5", dict(us, cache_creation_input_tokens=1)), 138)
        # exact 10 nanos (1 cache read) -> 110 + 5 = 115 // 10 = 11
        self.assertEqual(self.nanos("claude-haiku-5-5", dict(us, cache_read_input_tokens=1)), 11)
        # without the geo field the exact value is kept
        self.assertEqual(self.nanos("claude-haiku-5-5", {"cache_creation_input_tokens": 1}), 125)

    def test_geo_other_values_do_not_change_cost(self):
        base = {"input_tokens": 1000, "output_tokens": 100}
        want = 1000 * 2000 + 100 * 10000
        self.assertEqual(self.nanos("claude-sonnet-5", base), want)
        for geo in (None, "eu", "global", "US"):
            self.assertEqual(self.nanos("claude-sonnet-5", dict(base, inference_geo=geo)), want)
        self.assertEqual(self.nanos("claude-sonnet-5", dict(base, inference_geo="us")), (want * 11 + 5) // 10)

    def test_fast_plus_geo_on_opus(self):
        u = {"input_tokens": 1000, "output_tokens": 100, "cache_read_input_tokens": 1000,
             "speed": "fast", "inference_geo": "us"}
        base = 2 * (1000 * 4000 + 100 * 20000 + 1000 * 200)
        self.assertEqual(base, 12400000)
        self.assertEqual(self.nanos("claude-opus-5-5", u), (base * 11 + 5) // 10)
        self.assertEqual(self.nanos("claude-opus-5-5", u), 13640000)

    def test_geo_applies_after_haiku_long_tier(self):
        u = {"input_tokens": 100001, "output_tokens": 10, "inference_geo": "us"}
        exact = 100001 * 500 + 10 * 2500
        self.assertEqual(self.nanos("claude-haiku-5-5", u), (exact * 11 + 5) // 10)

    def test_unknown_model_unpriced(self):
        write(os.path.join(self.proj, "s1.jsonl"), [
            priced("a", "mystery-model", {"input_tokens": 5000, "output_tokens": 5000}),
            priced("b", "claude-sonnet-5", {"input_tokens": 1}, rid="r2"),
        ])
        r = self.run_rt()
        self.assertEqual(r["unpriced_events"], 1)
        self.assertEqual(r["per_model"]["mystery-model"]["cost_nanos"], 0)
        self.assertEqual(r["per_model"]["mystery-model"]["unpriced"], 1)
        self.assertEqual(r["per_model"]["claude-sonnet-5"]["unpriced"], 0)
        self.assertEqual(r["totals"]["cost_nanos"], 2000)
        self.assertEqual(r["usage_events"], 2)

    def test_dedup_cost_uses_winner_only(self):
        write(os.path.join(self.proj, "s1.jsonl"), [
            priced("a", "claude-opus-5-5", {"input_tokens": 9000, "output_tokens": 50000}, stop=None),
            priced("a", "claude-opus-5-5", {"input_tokens": 10, "output_tokens": 20, "speed": "fast"},
                   stop="end_turn"),
        ])
        r = self.run_rt()
        self.assertEqual(r["usage_events"], 1)
        self.assertEqual(r["totals"]["cost_nanos"], 2 * (10 * 4000 + 20 * 20000))

    def test_cost_by_day_and_session(self):
        write(os.path.join(self.proj, "s1.jsonl"), [
            priced("a", "claude-sonnet-5", {"input_tokens": 10}, sid="s1", ts="2026-01-01T10:00:00Z"),
            priced("b", "claude-sonnet-5", {"input_tokens": 20}, sid="s2", rid="r2",
                   ts="2026-01-02T10:00:00Z"),
            priced("c", "claude-opus-5-5", {"input_tokens": 1}, sid="s2", rid="r3",
                   ts="2026-01-02T11:00:00Z"),
        ])
        r = self.run_rt()
        self.assertEqual(r["per_day"]["2026-01-01"]["cost_nanos"], 20000)
        self.assertEqual(r["per_day"]["2026-01-02"]["cost_nanos"], 44000)
        self.assertEqual(r["per_session"]["s1"]["cost_nanos"], 20000)
        self.assertEqual(r["per_session"]["s2"]["cost_nanos"], 44000)
        self.assertEqual(r["per_model"]["claude-sonnet-5"]["cost_nanos"], 60000)
        self.assertEqual(r["totals"]["cost_nanos"], 64000)


if __name__ == "__main__":
    unittest.main()
