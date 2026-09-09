"""Synthetic fixtures only. No network, subscribers or actual outage assertions."""
import copy
from datetime import datetime, timedelta, timezone
from email.message import Message
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import collect_power_pilot as power

NOW = datetime(2026, 9, 8, 10, tzinfo=timezone.utc)
LATER = NOW + timedelta(hours=2)


def row(**changes):
    return {"taskId": 123, "scName": "ბათუმი", "disconnectionArea": "ბათუმი, TEST STREET 1",
            "taskType": "3", "disconnectionDate": "2026-09-08 12:30",
            "reconnectionDate": "2026-09-08 15:00:00.0000000",
            "taskNote": "PRIVATE TEST NOTE", "scEffectedCustomers": "TEST SUBSCRIBER",
            **changes}


def payload(*rows):
    return {"status": 200, "data": list(rows)}


class Response:
    def __init__(self, raw, content_type="application/json", status=200):
        self.raw, self.status = raw, status
        self.headers = Message()
        self.headers["Content-Type"] = content_type

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, limit):
        return self.raw[:limit]


class Opener:
    def __init__(self, response):
        self.response, self.calls = response, []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class PowerNormalizationTests(unittest.TestCase):
    def test_pilot_contract_keeps_source_clock_and_does_not_claim_live_supply(self):
        snapshot = power.normalize(payload(row()), NOW)
        event = snapshot["events"][0]
        self.assertFalse(snapshot["readyForPublication"])
        self.assertEqual(snapshot["collection"]["status"], "partial")
        self.assertEqual(snapshot["quality"]["coverage"], "unverified")
        self.assertIsNone(event["timeZone"])
        self.assertIsNone(event["sourcePublishedAt"])
        self.assertEqual(event["restoration"], "unconfirmed")
        self.assertEqual(event["endLocal"], row()["reconnectionDate"])
        encoded = json.dumps(snapshot)
        for private in ["taskNote", "scEffectedCustomers", "PRIVATE TEST NOTE", "TEST SUBSCRIBER"]:
            self.assertNotIn(private, encoded)

    def test_known_and_unknown_types_are_not_all_called_emergencies(self):
        for code, kind in [("1", "planned"), ("3", "unplanned"), ("2", "unknown"), ("new", "unknown")]:
            self.assertEqual(power.normalize_row(row(taskType=code))["kind"], kind)

    def test_territory_requires_both_exact_centre_and_city_in_original_area(self):
        data = payload(row(), row(taskId=124, scName="თბილისი"),
                       row(taskId=125, disconnectionArea="TEST UNKNOWN AREA"))
        result = power.normalize(data, NOW)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["quality"]["reasons"], {"wrong_centre": 1, "unresolved_territory": 1})

    def test_one_task_can_have_different_territories_and_exact_duplicates_collapse(self):
        a, b = row(), row(disconnectionArea="ბათუმი, TEST STREET 2")
        result = power.normalize(payload(a, b, a), NOW)
        self.assertEqual(len(result["events"]), 2)
        self.assertEqual(result["quality"]["duplicateCount"], 1)
        self.assertEqual(len({event["id"] for event in result["events"]}), 2)

    def test_batumi_streets_from_khelvachauri_do_not_import_neighbouring_villages(self):
        centre = power.CENTRES["khelvachauri"]
        mixed = row(scName=centre, taskType="1", disconnectionArea="ხელვაჩაური/TEST VILLAGE, ბათუმი/TEST STREET 1, ბათუმი/TEST STREET 2")
        result = power.normalize(payload(mixed), NOW, centre=centre)
        event = result["events"][0]
        self.assertEqual(event["city"], "batumi")
        self.assertEqual(event["sourceCentre"], centre)
        self.assertEqual(event["territoryOriginal"], "ბათუმი/TEST STREET 1, ბათუმი/TEST STREET 2")
        self.assertEqual(event["territorySelection"], "explicit-city-paths")
        self.assertEqual(event["kind"], "planned")
        power.validate_previous(result, LATER, centre)
        with self.assertRaises(power.InvalidData):
            power.validate_previous(result, LATER)  # Never merge centre states accidentally.

    def test_subscriber_details_in_the_area_itself_are_quarantined(self):
        for area in ["ბათუმი, TEST STREET, ბინა 1", "ბათუმი/ბინები TEST", "ბათუმი, აბონენტი TEST", "ბათუმი, TEST 123456789"]:
            with self.assertRaises(power.InvalidData) as result:
                power.normalize_row(row(disconnectionArea=area))
            self.assertEqual(str(result.exception), "subscriber_scoped_territory")
        for area in ["TEST VILLAGE, near ბათუმი", "ხელვაჩაური/ბათუმის ქუჩა", "ბათუმი", "TEST ბათუმი ADDRESS"]:
            with self.assertRaises(power.InvalidData):
                power.normalize_row(row(disconnectionArea=area))

    def test_conflicting_versions_are_quarantined_together_not_arbitrarily_chosen(self):
        a = row()
        b = row(reconnectionDate="2026-09-08 18:00")
        c = row(taskId=124)
        result = power.normalize(payload(a, b, c), NOW)
        self.assertEqual(result["quality"]["reasons"], {"conflicting_event": 2})
        self.assertEqual([e["sourceTaskId"] for e in result["events"]], ["124"])

    def test_dates_and_ids_are_strict_but_missing_end_is_not_invented(self):
        for changes in [{"taskId": True}, {"taskId": "123"}, {"taskId": 2.5}, {"taskId": 0},
                        {"disconnectionDate": "2026-02-31 12:00"}, {"disconnectionDate": "2026-09-08T12:00Z"},
                        {"reconnectionDate": "2026-09-07 12:00"}, {"reconnectionDate": "tomorrow"},
                        {"taskType": None}, {"disconnectionArea": "ბათუმი<script>"}]:
            with self.subTest(changes=changes), self.assertRaises(power.InvalidData):
                power.normalize_row(row(**changes))
        for end in (None, ""):
            event = power.normalize_row(row(reconnectionDate=end))
            self.assertIsNone(event["endLocal"])
            self.assertEqual(event["restoration"], "unconfirmed")

    def test_schema_changes_and_nonstandard_json_are_rejected(self):
        for bad in [None, [], {}, {"status": "200", "data": []}, {"status": True, "data": []},
                    {"status": 200, "data": {}}, {"status": 500, "data": []}]:
            with self.subTest(bad=bad), self.assertRaises(power.InvalidData):
                power.normalize(bad, NOW)
        for raw in [b"<html>Login</html>", b'{"status": NaN}', b'\xff', b"x" * (power.MAX_BYTES + 1)]:
            with self.assertRaises(power.InvalidData):
                power.decode_json(raw)

    def test_empty_result_cannot_erase_previous_events_or_advance_success(self):
        before = power.normalize(payload(row()), NOW)
        after = power.normalize(payload(), LATER, before)
        self.assertEqual(after["events"], before["events"])
        self.assertEqual(after["collection"]["lastSuccessAt"], power.stamp(NOW))
        self.assertEqual(after["collection"]["status"], "error")
        self.assertEqual(after["collection"]["error"], "empty_response_unconfirmed")
        first = power.normalize(payload(), NOW)
        self.assertIsNone(first["collection"]["lastSuccessAt"])

    def test_invalid_rows_retain_previous_observations_and_explain_rejection(self):
        before = power.normalize(payload(row()), NOW)
        after = power.normalize(payload(row(scName="თბილისი")), LATER, before)
        self.assertEqual(after["events"], before["events"])
        self.assertEqual(after["collection"]["lastSuccessAt"], power.stamp(NOW))
        self.assertEqual(after["lastRejectedQuality"]["reasons"], {"wrong_centre": 1})

    def test_updates_preserve_first_seen_and_missing_records_do_not_become_restored(self):
        before = power.normalize(payload(row(), row(taskId=124)), NOW)
        after = power.normalize(payload(row(reconnectionDate="2026-09-08 18:00")), LATER, before)
        self.assertEqual(after["changes"], {"added": 0, "changed": 1, "notReturned": 1})
        for event in after["events"]:
            self.assertEqual(event["firstSeenAt"], power.stamp(NOW))
            self.assertEqual(event["restoration"], "unconfirmed")
            self.assertEqual(event["inLatestResponse"], event["sourceTaskId"] == "123")
        self.assertTrue(all(e["inLatestResponse"] for e in before["events"]))
        later = power.normalize(payload(row(reconnectionDate="2026-09-08 18:00")), LATER + timedelta(hours=2), after)
        self.assertEqual(later["changes"]["changed"], 0)

    def test_returning_after_failure_does_not_lose_first_seen(self):
        before = power.normalize(payload(row()), NOW)
        failed = power.failure_snapshot(before, LATER, power.SourceFailure("network_or_tls_error"))
        after = power.normalize(payload(row()), LATER + timedelta(hours=1), failed)
        self.assertEqual(after["events"][0]["firstSeenAt"], power.stamp(NOW))
        self.assertIsNone(after["collection"]["error"])

    def test_100_rows_are_not_claimed_complete(self):
        result = power.normalize(payload(*(row(taskId=1000+i) for i in range(100))), NOW)
        self.assertTrue(result["quality"]["possibleServerLimit"])
        self.assertEqual(result["quality"]["coverage"], "unverified")

    def test_collection_age_is_not_outage_freshness_and_errors_never_look_current(self):
        state = power.normalize(payload(row()), NOW)
        self.assertEqual(power.collection_health(state, LATER)["state"], "collection_recent_partial")
        self.assertEqual(power.collection_health(state, NOW + timedelta(hours=3, seconds=1))["state"], "collection_stale")
        self.assertEqual(power.collection_health(state, LATER)["supplyStatus"], "unknown")
        failed = power.failure_snapshot(state, LATER, power.SourceFailure("http_403", blocked=True))
        self.assertEqual(power.collection_health(failed, LATER)["state"], "blocked")
        self.assertEqual(power.collection_health(power.empty_snapshot(), NOW)["state"], "not_collected")

    def test_previous_wrong_contract_corrupt_event_future_and_naive_times_are_rejected(self):
        for previous in [{"usdRub": 88}, [], {**power.empty_snapshot(), "readyForPublication": True}]:
            with self.assertRaises(power.InvalidData):
                power.validate_previous(previous, NOW)
        valid = power.normalize(payload(row()), NOW)
        broken = copy.deepcopy(valid)
        broken["events"][0]["restoration"] = "restored"
        with self.assertRaises(power.InvalidData):
            power.validate_previous(broken, LATER)
        with self.assertRaises(power.InvalidData):
            power.validate_previous(valid, NOW - timedelta(seconds=1))
        with self.assertRaises(power.InvalidData):
            power.normalize(payload(row()), datetime(2026, 9, 8))


class PowerTransportTests(unittest.TestCase):
    def test_one_read_only_post_in_georgian_without_auth_and_with_timeout(self):
        opener = Opener(Response(json.dumps(payload(row())).encode()))
        result = power.fetch_once(NOW, opener)
        self.assertEqual(result["status"], 200)
        self.assertEqual(len(opener.calls), 1)
        request, timeout = opener.calls[0]
        self.assertEqual(request.full_url, power.API)
        self.assertEqual(json.loads(request.data), {"search": "ბათუმი"})
        self.assertEqual(timeout, 20)
        for header in ("Authorization", "Cookie", "Origin", "Referer"):
            self.assertIsNone(request.get_header(header))

    def test_tls_and_timeouts_are_errors_without_retry(self):
        for error in [urllib.error.URLError("certificate verify failed"), TimeoutError()]:
            opener = Opener(error)
            with self.assertRaises(power.SourceFailure) as result:
                power.fetch_once(NOW, opener)
            self.assertEqual(result.exception.code, "network_or_tls_error")
            self.assertEqual(len(opener.calls), 1)

    def test_khelvachauri_query_is_explicit_and_unknown_centres_never_fetch(self):
        opener = Opener(Response(json.dumps(payload()).encode()))
        power.fetch_once(NOW, opener, centre=power.CENTRES["khelvachauri"])
        self.assertEqual(json.loads(opener.calls[0][0].data), {"search": "ხელვაჩაური"})
        with self.assertRaises(power.InvalidData):
            power.fetch_once(NOW, opener, centre="unknown")
        self.assertEqual(len(opener.calls), 1)

    def test_200_html_redirect_and_oversized_responses_are_not_empty_successes(self):
        opener = Opener(Response(b"<html>Login</html>", "text/html"))
        with self.assertRaises(power.SourceFailure):
            power.fetch_once(NOW, opener)
        with self.assertRaises(power.SourceFailure) as result:
            power.NoRedirect().redirect_request(None, None, 302, "", {}, "http://elsewhere.invalid")
        self.assertTrue(result.exception.blocked)
        with self.assertRaises(power.InvalidData):
            power.fetch_once(NOW, Opener(Response(b"x" * (power.MAX_BYTES + 1))))

    def test_403_is_blocked_and_429_carries_retry_after(self):
        for status in (401, 403, 429, 503):
            headers = Message()
            headers["Retry-After"] = "7200"
            error = urllib.error.HTTPError(power.API, status, "", headers, None)
            with self.assertRaises(power.SourceFailure) as result:
                power.fetch_once(NOW, Opener(error))
            self.assertEqual(result.exception.blocked, status in (401, 403))
            self.assertEqual(result.exception.retry_after, power.stamp(LATER))
        self.assertEqual(power.retry_time("Tue, 08 Sep 2026 12:00:00 GMT", NOW), power.stamp(LATER))
        self.assertIsNone(power.retry_time("invalid", NOW))


class PowerCommandTests(unittest.TestCase):
    def test_saved_response_requires_its_retrieval_time_and_never_fetches(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory)/"source.json", Path(directory)/"pilot.json"
            source.write_text(json.dumps(payload(row())))
            with patch.object(power, "fetch_once") as fetch, patch("sys.stdout", new_callable=io.StringIO):
                result = power.main(["--input", str(source), "--fetched-at", power.stamp(NOW), "--output", str(output)])
                self.assertEqual(result, 0)
                fetch.assert_not_called()
                self.assertEqual(json.loads(output.read_text())["collection"]["lastSuccessAt"], power.stamp(NOW))
            with patch("sys.stderr", new_callable=io.StringIO), self.assertRaises(SystemExit):
                power.main(["--input", str(source), "--output", str(output)])

    def test_unrelated_existing_output_and_original_input_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory)/"source.json", Path(directory)/"rates.json"
            source.write_text(json.dumps(payload(row())))
            output.write_text('{"usdRub":88}')
            with self.assertRaises(power.InvalidData):
                power.main(["--input", str(source), "--fetched-at", power.stamp(NOW), "--output", str(output)])
            self.assertEqual(output.read_text(), '{"usdRub":88}')
            with self.assertRaises(power.InvalidData):
                power.main(["--input", str(source), "--fetched-at", power.stamp(NOW), "--output", str(source)])

    def test_403_blocks_following_run_and_preserves_previous_events(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/"pilot.json"
            baseline = power.normalize(payload(row()), NOW)
            power.write_atomic(output, baseline)
            with patch.object(power, "fetch_once", side_effect=power.SourceFailure("http_403", blocked=True)) as fetch, patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(power.main(["--fetch", "--output", str(output)]), 1)
                self.assertEqual(power.main(["--fetch", "--output", str(output)]), 2)
                self.assertEqual(fetch.call_count, 1)
            snapshot = json.loads(output.read_text())
            self.assertEqual(snapshot["events"], baseline["events"])
            self.assertEqual(snapshot["collection"]["lastSuccessAt"], power.stamp(NOW))

    def test_retry_after_prevents_early_network_call(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/"pilot.json"
            state = power.empty_snapshot()
            state["collection"]["retryNotBefore"] = power.stamp(datetime.now(timezone.utc) + timedelta(hours=1))
            power.write_atomic(output, state)
            with patch.object(power, "fetch_once") as fetch, patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(power.main(["--fetch", "--output", str(output)]), 2)
                fetch.assert_not_called()

    def test_atomic_writer_never_replaces_good_output_with_nonfinite_json(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/"pilot.json"
            power.write_atomic(output, power.empty_snapshot())
            before = output.read_bytes()
            with self.assertRaises(ValueError):
                power.write_atomic(output, {"bad": float("nan")})
            self.assertEqual(output.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
