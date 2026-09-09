"""Synthetic public-feed fixtures only: no network or actual subscriber data."""
import copy
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_outages as public

NOW = datetime(2026, 9, 9, 8, tzinfo=timezone.utc)
LATER = NOW + timedelta(hours=2)
STREET = "ბათუმი, კობალაძის ქ., შენ. 8a"


def event(key="batumi", at=NOW, **changes):
    return {"id": "energo:" + "a" * 32, "sourceTaskId": "123", "city": "batumi",
            "sourceCentre": public.CENTRES[key], "territoryOriginal": STREET,
            "territorySelection": "explicit-city-prefix", "language": "ka", "sourceType": "1", "kind": "planned",
            "startLocal": "2026-09-09 12:00", "endLocal": "2026-09-09 14:00:00.0000000",
            "timeZone": None, "endMeaning": "unconfirmed", "restoration": "unconfirmed",
            "sourcePublishedAt": None, "sourceUrl": public.PORTAL,
            "firstSeenAt": public.stamp(at), "changedAt": public.stamp(at), "lastSeenAt": public.stamp(at),
            "inLatestResponse": True, **changes}


def snapshot(key="batumi", at=NOW, events=None):
    return {"schemaVersion": 1, "stage": "research-pilot", "readyForPublication": False,
            "provider": "energo-pro", "scope": {"city": "batumi", "sourceCentre": public.CENTRES[key]},
            "sourceUrl": public.PORTAL,
            "collection": {"status": "partial", "lastAttemptAt": public.stamp(at), "lastSuccessAt": public.stamp(at),
                           "error": None, "retryNotBefore": None, "manualReviewRequired": False},
            "quality": {"coverage": "unverified", "quarantinedCount": 0},
            "events": [event(key, at)] if events is None else events}


def feed(*events, key="batumi", at=NOW):
    return public.build_feed({key: snapshot(key, at, list(events))}, at)


class PublicProjectionTests(unittest.TestCase):
    def test_exact_allowlist_contract_drops_extra_fields_even_on_old_missing_records(self):
        source = snapshot()
        source["PRIVATE_TOP"] = "SYNTHETIC PRIVATE"
        source["collection"]["subscriber"] = "SYNTHETIC PRIVATE"
        source["events"][0].update(subscriberName="SYNTHETIC PRIVATE", taskNote="SYNTHETIC PRIVATE", inLatestResponse=False)
        before = copy.deepcopy(source)
        result = public.build_feed({"batumi": source}, LATER)
        self.assertEqual(source, before)
        self.assertEqual(set(result), {"schemaVersion", "stage", "generatedAt", "city", "coverage", "queries", "quality", "events"})
        self.assertEqual(set(result["queries"][0]), {"key", "status", "lastAttemptAt", "lastSuccessAt", "errorCode"})
        item = result["events"][0]
        self.assertEqual(set(item), {"id", "kind", "addresses", "startLocal", "endLocal", "endMeaning", "restoration", "firstSeenAt", "lastSeenAt", "provenance"})
        self.assertEqual(set(item["addresses"][0]), {"original", "display", "translationStatus", "houseTokens", "needsReview"})
        self.assertNotIn("SYNTHETIC PRIVATE", json.dumps(result))
        self.assertNotIn("sourceTaskId", item)
        self.assertEqual(item["restoration"], "unconfirmed")
        self.assertFalse(item["provenance"][0]["inLatestResponse"])

    def test_bare_pushkin_building_suffix_is_preserved_without_invented_translation(self):
        area = "ბათუმი, პუშკინის, შენ. 156v"
        address = feed(event(territoryOriginal=area))["events"][0]["addresses"][0]
        self.assertEqual(address["original"], area)
        self.assertIn("156v", address["display"])
        self.assertIn("პუშკინის", address["display"])
        self.assertEqual(address["translationStatus"], "partial")
        self.assertTrue(address["needsReview"])

    def test_numeric_lists_ranges_suffixes_and_fractions_are_never_truncated(self):
        area = "ბათუმი/კობალაძის ქ., შენ. 8a, 9ა, 10/2, 12–14"
        address = feed(event(territoryOriginal=area))["events"][0]["addresses"][0]
        self.assertEqual(address["original"], area)
        self.assertEqual(address["houseTokens"], ["8a", "9ა", "10/2", "12–14"])
        for token in address["houseTokens"]:
            self.assertIn(token, address["display"])

    def test_unknown_bare_street_parts_can_be_withheld_only_when_every_part_is_closed(self):
        area = "ბათუმი/კობალაძის ქ., შენ. 8a, ბათუმი/ხანძთის, ბათუმი/აეროპორტის გზატკეცილი, შენ. 2"
        result = feed(event(territoryOriginal=area))
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual([a["original"] for a in result["events"][0]["addresses"]],
                         ["ბათუმი/კობალაძის ქ., შენ. 8a", "ბათუმი/აეროპორტის გზატკეცილი, შენ. 2"])
        self.assertEqual(result["quality"]["omitted"], 1)
        self.assertNotIn("ხანძთის", json.dumps(result, ensure_ascii=False))

    def test_unknown_continuation_is_not_cut_off_even_inside_a_withheld_street_part(self):
        for area in ["ბათუმი/კობალაძის ქ., შენ. 8a, UNKNOWN TAIL",
                     "ბათუმი/კობალაძის ქ., შენ. 8a, ბათუმი/ხანძთის, UNKNOWN TAIL",
                     "ბათუმი, თამარ მეფის გამზირი, შენ. 48ა(მშენებარე), სად. 09-903"]:
            with self.subTest(area=area):
                result = feed(event(territoryOriginal=area))
                self.assertEqual(result["events"], [])
                self.assertEqual(result["quality"]["omitted"], 1)

    def test_whole_territory_privacy_gate_precedes_partial_city_extraction(self):
        unsafe = ["apt. 4", "кв.4", "ბინა 4", "აბო\u200bნენტი TEST", "+995 555 12 34 56",
                  "test@example.invalid", "<script>TEST</script>", "\u202eTEST", "TEST\x00", "TEST\nTEXT"]
        for tail in unsafe:
            with self.subTest(tail=tail):
                area = "ბათუმი/კობალაძის ქ., შენ. 8a, ბათუმი/ხანძთის " + tail
                result = feed(event(territoryOriginal=area))
                self.assertEqual(result["events"], [])
                self.assertEqual(result["quality"]["omitted"], 1)
                self.assertNotIn(tail, json.dumps(result, ensure_ascii=False))

    def test_explicit_batumi_scope_never_imports_another_city_or_unknown_scope(self):
        for area in ["ბათუმი/კობალაძის ქ., ხელვაჩაური/TEST", "ბათუმი, კობალაძის ქ.; ხელვაჩაური, TEST",
                     "თბილისი/კობალაძის ქ.", "კობალაძის ქ.", "ბათუმი", "ბათუმი, კობალაძის ქ., თბილისი/TEST"]:
            with self.subTest(area=area):
                self.assertEqual(feed(event(territoryOriginal=area))["events"], [])
        self.assertEqual(feed(event(sourceCentre=public.CENTRES["khelvachauri"]))["events"], [])
        self.assertEqual(len(feed(event("khelvachauri"), key="khelvachauri")["events"]), 1)

    def test_same_task_and_scope_merge_across_centres_with_both_observations(self):
        result = public.build_feed({key: snapshot(key) for key in public.CENTRES}, NOW)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual([p["query"] for p in result["events"][0]["provenance"]], list(public.CENTRES))
        self.assertEqual(result["quality"]["omitted"], 0)
        reversed_result = public.build_feed(dict(reversed([(key, snapshot(key)) for key in public.CENTRES])), NOW)
        self.assertEqual(result, reversed_result)

    def test_different_house_scripts_case_or_territories_never_merge(self):
        records = [event(territoryOriginal="ბათუმი, კობალაძის ქ., შენ. " + number) for number in ["8a", "8A", "8а", "8ა", "9"]]
        result = feed(*records)
        self.assertEqual(len(result["events"]), 5)
        self.assertEqual(len({e["id"] for e in result["events"]}), 5)

    def test_dedup_identity_keeps_hidden_scope_and_does_not_merge_reduced_address_lists(self):
        a = event(territoryOriginal="ბათუმი/კობალაძის ქ., ბათუმი/ხანძთის")
        b = event(territoryOriginal="ბათუმი/კობალაძის ქ., ბათუმი/სატესტო")
        result = feed(a, b)
        self.assertEqual(len(result["events"]), 2)
        self.assertNotEqual(result["events"][0]["id"], result["events"][1]["id"])

    def test_conflicting_versions_are_quarantined_together_not_chosen_by_query_order(self):
        a, b = snapshot(), snapshot("khelvachauri")
        b["events"][0]["endLocal"] = "2026-09-09 18:00"
        result = public.build_feed({"batumi": a, "khelvachauri": b}, NOW)
        self.assertEqual(result["events"], [])
        self.assertEqual(result["quality"]["omitted"], 2)

    def test_equivalent_source_time_precision_does_not_create_a_false_conflict(self):
        a, b = snapshot(), snapshot("khelvachauri")
        b["events"][0].update(startLocal="2026-09-09 12:00:00.0000000", endLocal="2026-09-09 14:00")
        result = public.build_feed({"batumi": a, "khelvachauri": b}, NOW)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(len(result["events"][0]["provenance"]), 2)
        self.assertEqual(result["events"][0]["startLocal"], a["events"][0]["startLocal"])
        self.assertEqual(result["quality"]["omitted"], 0)

    def test_one_fresh_query_cannot_refresh_failed_query_observations(self):
        old = snapshot("khelvachauri", events=[event("khelvachauri", sourceTaskId="456")])
        old["collection"].update(status="error", lastAttemptAt=public.stamp(LATER), error="network_or_tls_error")
        result = public.build_feed({"batumi": snapshot(at=LATER), "khelvachauri": old}, LATER)
        self.assertEqual(result["queries"][1]["lastSuccessAt"], public.stamp(NOW))
        self.assertEqual(result["queries"][1]["status"], "error")
        preserved = next(e for e in result["events"] if e["provenance"][0]["query"] == "khelvachauri")
        self.assertEqual(preserved["lastSeenAt"], public.stamp(NOW))
        self.assertEqual(preserved["provenance"][0]["seenAt"], public.stamp(NOW))
        later_feed = public.build_feed({"khelvachauri": old}, LATER + timedelta(days=1))
        self.assertEqual(later_feed["events"][0]["lastSeenAt"], public.stamp(NOW))
        self.assertNotIn("fresh", later_feed["events"][0])

    def test_missing_empty_blocked_and_error_states_never_become_no_outages(self):
        missing = public.build_feed({}, NOW)
        self.assertEqual([q["status"] for q in missing["queries"]], ["missing", "missing"])
        for status, error in [("error", "empty_response_unconfirmed"), ("blocked", "http_403")]:
            source = snapshot()
            source["collection"].update(status=status, error=error, manualReviewRequired=status == "blocked", lastAttemptAt=public.stamp(LATER))
            result = public.build_feed({"batumi": source}, LATER)
            self.assertEqual(result["queries"][0]["lastSuccessAt"], public.stamp(NOW))
            self.assertEqual(result["queries"][0]["status"], status)
            self.assertEqual(result["events"][0]["restoration"], "unconfirmed")

    def test_error_codes_are_fixed_and_do_not_echo_source_or_exception_text(self):
        source = snapshot()
        source["collection"].update(status="error", error="SYNTHETIC PRIVATE EXCEPTION")
        result = public.build_feed({"batumi": source}, NOW)
        self.assertEqual(result["queries"][0]["errorCode"], "source_error")
        self.assertNotIn("SYNTHETIC", json.dumps(result))

    def test_strict_collection_status_and_timestamp_order_reject_bad_snapshots(self):
        changes = [{"status": "fresh"}, {"lastAttemptAt": public.stamp(NOW - timedelta(seconds=1))},
                   {"lastSuccessAt": public.stamp(NOW + timedelta(seconds=1))},
                   {"lastAttemptAt": None}, {"lastSuccessAt": None}, {"manualReviewRequired": True},
                   {"lastAttemptAt": "2026-02-30T08:00:00Z"}, {"lastSuccessAt": "2026-09-09T08:00:00"}]
        for change in changes:
            with self.subTest(change=change):
                source = snapshot();source["collection"].update(change)
                result = public.build_feed({"batumi": source}, NOW)
                self.assertEqual(result["events"], [])
                self.assertEqual(result["queries"][0]["errorCode"], "invalid_snapshot")

    def test_invalid_event_times_types_ids_and_future_observations_are_withheld(self):
        changes = [{"startLocal": None}, {"startLocal": "2026-02-30 12:00"}, {"startLocal": "2026-09-09 12:00:99"},
                   {"endLocal": "2026-09-09 11:59"}, {"endLocal": "2026-09-09T14:00Z"},
                   {"sourceTaskId": "9007199254740992"}, {"sourceTaskId": 123}, {"inLatestResponse": "true"},
                   {"kind": "restored"}, {"timeZone": "Asia/Tbilisi"}, {"restoration": "restored"},
                   {"lastSeenAt": public.stamp(LATER)}, {"firstSeenAt": public.stamp(LATER)}]
        for change in changes:
            with self.subTest(change=change):
                self.assertEqual(feed(event(**change))["events"], [])

    def test_local_times_keep_source_precision_and_never_infer_actual_restoration(self):
        start, end = "2026-09-09 12:00:00.1234567", "2026-09-09 12:00:00.1234568"
        result = feed(event(startLocal=start, endLocal=end, inLatestResponse=False))["events"][0]
        self.assertEqual((result["startLocal"], result["endLocal"]), (start, end))
        self.assertEqual(result["endMeaning"], "unconfirmed")
        self.assertEqual(feed(event(startLocal=end, endLocal=start))["events"], [])
        self.assertIsNone(feed(event(endLocal=None))["events"][0]["endLocal"])

    def test_subsecond_observation_times_merge_by_time_not_lexicographic_iso_order(self):
        later = NOW + timedelta(microseconds=1)
        a, b = snapshot(), snapshot("khelvachauri", at=later)
        result = public.build_feed({"batumi": a, "khelvachauri": b}, later)["events"][0]
        self.assertEqual(result["firstSeenAt"], public.stamp(NOW))
        self.assertEqual(result["lastSeenAt"], public.stamp(later))

    def test_upstream_quarantine_count_is_preserved_without_its_reasons_or_raw_rows(self):
        source = snapshot();source["quality"].update(quarantinedCount=3, reasons={"SYNTHETIC PRIVATE": 3})
        result = public.build_feed({"batumi": source}, NOW)
        self.assertEqual(result["quality"], {"omitted": 3})
        self.assertNotIn("SYNTHETIC PRIVATE", json.dumps(result))

    def test_event_limit_keeps_recent_source_dates_and_counts_omissions_without_freshening(self):
        records = [event(sourceTaskId=str(day), startLocal=f"2026-09-{day:02d} 12:00", endLocal=None) for day in [1, 2, 3]]
        with patch.object(public, "MAX_EVENTS", 2):
            result = feed(*records)
        self.assertEqual([item["startLocal"] for item in result["events"]], ["2026-09-03 12:00", "2026-09-02 12:00"])
        self.assertEqual(result["quality"]["omitted"], 1)
        self.assertTrue(all(item["lastSeenAt"] == public.stamp(NOW) for item in result["events"]))
        self.assertEqual(public.MAX_EVENTS, 2000)

    def test_serialized_feed_limit_matches_the_bytes_the_cli_writes(self):
        single = feed(event())
        limit = len(public._encode(single).encode("utf-8")) + 50
        with patch.object(public, "MAX_FEED_BYTES", limit):
            result = feed(*(event(sourceTaskId=str(n)) for n in [1, 2, 3]))
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["quality"]["omitted"], 2)
        self.assertLessEqual(len(public._encode(result).encode("utf-8")), limit)
        self.assertEqual(public.MAX_FEED_BYTES, 2_000_000)

    def test_address_limit_cuts_only_whole_groups_and_preserves_each_house_list(self):
        area = "ბათუმი/კობალაძის ქ., შენ. 8a, 9, ბათუმი/აეროპორტის გზატკეცილი, შენ. 2"
        with patch.object(public, "MAX_ADDRESSES", 1):
            result = feed(event(territoryOriginal=area))
        self.assertEqual(result["quality"]["omitted"], 1)
        self.assertEqual(result["events"][0]["addresses"][0]["houseTokens"], ["8a", "9"])
        self.assertEqual(result["events"][0]["addresses"][0]["original"], "ბათუმი/კობალაძის ქ., შენ. 8a, 9")
        self.assertEqual(public.MAX_ADDRESSES, 100)

    def test_translator_extras_are_stripped_and_number_regressions_fail_closed(self):
        original = public.normalize_address
        def extras(text):
            return {**original(text), "private": "SYNTHETIC PRIVATE"}
        with patch.object(public, "normalize_address", side_effect=extras):
            result = feed(event())
        self.assertEqual(len(result["events"]), 1)
        self.assertNotIn("SYNTHETIC PRIVATE", json.dumps(result))
        def changed_number(text):
            result = original(text);result["display"] += " 99";return result
        with patch.object(public, "normalize_address", side_effect=changed_number):
            result = feed(event())
        self.assertEqual(result["events"], [])


class ProjectionCommandTests(unittest.TestCase):
    def test_cli_reads_two_inputs_without_mutation_and_logs_only_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = {key: Path(directory) / (key + ".json") for key in public.CENTRES}
            for key, path in paths.items():
                path.write_text(json.dumps(snapshot(key, datetime.now(timezone.utc) - timedelta(seconds=1))), encoding="utf-8")
            before = {key: path.read_bytes() for key, path in paths.items()}
            output = Path(directory) / "outages.json"
            with patch("sys.stdout", new_callable=io.StringIO) as log:
                self.assertEqual(public.main(["--batumi", str(paths["batumi"]), "--khelvachauri", str(paths["khelvachauri"]), "--output", str(output)]), 0)
            self.assertEqual({key: path.read_bytes() for key, path in paths.items()}, before)
            self.assertEqual(len(json.loads(output.read_text())["events"]), 1)
            self.assertNotIn("კობალაძის", log.getvalue())

    def test_source_collision_and_unrelated_output_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b, out = (Path(directory) / name for name in ("a.json", "b.json", "rates.json"))
            a.write_text(json.dumps(snapshot()));b.write_text(json.dumps(snapshot("khelvachauri")));out.write_text('{"usdRub": 88}')
            for output in (a, b, out):
                before = output.read_bytes()
                with self.assertRaises(public.ProjectionError):
                    public.main(["--batumi", str(a), "--khelvachauri", str(b), "--output", str(output)])
                self.assertEqual(output.read_bytes(), before)

    def test_malformed_duplicate_nonfinite_and_oversized_json_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            for content in [b'{"schemaVersion":1,"schemaVersion":2}', b'{"bad":NaN}', b"<html>TEST</html>", b"\xff"]:
                path.write_bytes(content)
                with self.assertRaises(public.ProjectionError):
                    public.read_snapshot(path)
            path.write_bytes(b" " * 33)
            with patch.object(public, "MAX_BYTES", 32), self.assertRaises(public.ProjectionError):
                public.read_snapshot(path)

    def test_atomic_write_failure_preserves_the_last_good_feed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outages.json"
            good = public.build_feed({}, NOW)
            public.write_atomic(path, good);before = path.read_bytes()
            with self.assertRaises(ValueError):
                public.write_atomic(path, {**good, "bad": float("nan")})
            self.assertEqual(path.read_bytes(), before)
            with patch.object(Path, "replace", side_effect=OSError("SYNTHETIC")), self.assertRaises(OSError):
                public.write_atomic(path, good)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual([item.name for item in path.parent.iterdir()], ["outages.json"])

    def test_missing_or_invalid_query_is_explicit_and_cannot_import_other_files(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b, out = (Path(directory) / name for name in ("missing.json", "bad.json", "outages.json"))
            b.write_text('{"usdRub":88}')
            with patch("sys.stdout", new_callable=io.StringIO):
                public.main(["--batumi", str(a), "--khelvachauri", str(b), "--output", str(out)])
            result = json.loads(out.read_text())
            self.assertEqual([q["status"] for q in result["queries"]], ["missing", "error"])
            self.assertEqual(result["events"], [])


if __name__ == "__main__":
    unittest.main()
