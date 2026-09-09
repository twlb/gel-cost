#!/usr/bin/env python3
"""Isolated Energo-Pro/Batumi research collector. No UI, scheduler or publishing.

Source contract observed in the public portal, not a guaranteed operator API.
Never interpret missing rows or reconnectionDate as confirmed restoration.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata
import urllib.error
import urllib.request

API = "https://my.energo-pro.ge/owback/searchAlerts"
PORTAL = "https://my.energo-pro.ge/ow/#/disconns"
CENTRES = {"batumi": "ბათუმი", "khelvachauri": "ხელვაჩაური"}
CENTRE = CENTRES["batumi"]
MAX_BYTES = 2_000_000
MAX_ROWS = 5000
MAX_EVENTS = 10000
PRIVATE_SCOPE = re.compile(r"ბინა|ბინები|აბონენტ|\bapt\b|apartment|квартир|кв\.|абонент|subscriber|\b\d{9,}\b|\+?995[\s()-]*\d", re.I)
LOCAL_DATE = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?\Z")


class InvalidData(ValueError):
    pass


class SourceFailure(Exception):
    def __init__(self, code, *, blocked=False, retry_after=None):
        self.code, self.blocked, self.retry_after = code, blocked, retry_after


def utc(value):
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise InvalidData("timezone_required")
    return value.astimezone(timezone.utc)


def stamp(value):
    return utc(value).isoformat().replace("+00:00", "Z")


def read_stamp(value):
    try:
        return utc(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except (AttributeError, TypeError, ValueError) as exc:
        raise InvalidData("invalid_snapshot_time") from exc


def plain(value, limit=4000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise InvalidData("invalid_text")
    if re.search(r"[<>\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]", value):
        raise InvalidData("unsafe_text")
    return unicodedata.normalize("NFC", value.strip())


def local_date(value, optional=False):
    if optional and value in (None, ""):
        return None
    if not isinstance(value, str) or not LOCAL_DATE.fullmatch(value):
        raise InvalidData("invalid_date")
    try:
        # Keep source wall-clock text. No unconfirmed UTC offset is attached.
        datetime.fromisoformat(value)
    except ValueError as exc:
        raise InvalidData("invalid_date") from exc
    return value


def city_territory(value):
    plain(value)  # Validate, but retain exact source spelling and number suffixes.
    area = value
    # The public field itself sometimes contains apartment/subscriber detail.
    # Do not copy it just because other subscriber columns have been excluded.
    if any(unicodedata.category(c).startswith("C") for c in area) or PRIVATE_SCOPE.search(area):
        raise InvalidData("subscriber_scoped_territory")
    if re.search(r"(?:^|,)\s*[ა-ჰ]+(?: [ა-ჰ]+)*/", area):
        components = [part.strip() for part in area.split(",")]
        # Every component must name its city. Never silently discard a bare
        # house number / continuation and turn a house outage into a street one.
        if not all(re.fullmatch(r"[ა-ჰ]+(?: [ა-ჰ]+)*/[^,;]+", part) for part in components):
            raise InvalidData("ambiguous_territory_continuation")
        parts = [part for part in components if part.startswith("ბათუმი/")]
        if parts:
            return ", ".join(dict.fromkeys(parts)), "explicit-city-paths"
    elif area.startswith("ბათუმი,") and ";" not in area and not re.search(r"(?:ხელვაჩაური|თბილისი|ქობულეთი|ქუთაისი)\s*[,/]", area):
        return area, "explicit-city-prefix"
    raise InvalidData("unresolved_territory")


def normalize_row(row, centre=CENTRE):
    if not isinstance(row, dict):
        raise InvalidData("invalid_row")
    task_id = row.get("taskId")
    if type(task_id) is not int or not 0 < task_id <= 2**53 - 1:
        raise InvalidData("invalid_id")
    if centre not in CENTRES.values() or row.get("scName") != centre:
        raise InvalidData("wrong_centre")
    area, selection = city_territory(row.get("disconnectionArea"))
    start = local_date(row.get("disconnectionDate"))
    end = local_date(row.get("reconnectionDate"), optional=True)
    if end and datetime.fromisoformat(end) < datetime.fromisoformat(start):
        raise InvalidData("end_before_start")
    code = plain(row.get("taskType"), limit=20)
    identity = json.dumps([str(task_id), centre, area], ensure_ascii=False)
    return {
        "id": "energo:" + hashlib.sha256(identity.encode()).hexdigest()[:32],
        "sourceTaskId": str(task_id), "city": "batumi", "sourceCentre": centre,
        "territoryOriginal": area, "territorySelection": selection, "language": "ka", "sourceType": code,
        "kind": {"1": "planned", "3": "unplanned"}.get(code, "unknown"),
        "startLocal": start, "endLocal": end,
        "timeZone": None, "endMeaning": "unconfirmed", "restoration": "unconfirmed",
        "sourcePublishedAt": None, "sourceUrl": PORTAL,
    }


def empty_snapshot(centre=CENTRE):
    if centre not in CENTRES.values():
        raise InvalidData("unsupported_centre")
    return {
        "schemaVersion": 1, "stage": "research-pilot", "readyForPublication": False,
        "provider": "energo-pro", "scope": {"city": "batumi", "sourceCentre": centre},
        "sourceUrl": PORTAL,
        "collection": {"status": "not_collected", "lastAttemptAt": None,
                       "lastSuccessAt": None, "error": None, "retryNotBefore": None,
                       "manualReviewRequired": False},
        "quality": {"coverage": "unverified", "timeSemantics": "unverified",
                    "usageTerms": "unverified"},
        "changes": {"added": 0, "changed": 0, "notReturned": 0}, "events": [],
    }


def validate_previous(previous, now, centre=CENTRE):
    if previous is None:
        return empty_snapshot(centre)
    if not isinstance(previous, dict):
        raise InvalidData("invalid_previous_snapshot")
    expected = empty_snapshot(centre)
    for key in ("schemaVersion", "stage", "readyForPublication", "provider", "scope", "sourceUrl"):
        if previous.get(key) != expected[key]:
            raise InvalidData("different_snapshot_contract")
    collection, events = previous.get("collection"), previous.get("events")
    if not isinstance(collection, dict) or not isinstance(events, list) or len(events) > MAX_EVENTS:
        raise InvalidData("invalid_previous_snapshot")
    for key in ("lastAttemptAt", "lastSuccessAt"):
        if collection.get(key) and read_stamp(collection[key]) > utc(now):
            raise InvalidData("snapshot_from_future")
    seen = set()
    for event in events:
        try:
            row = {"taskId": int(event["sourceTaskId"]), "scName": event["sourceCentre"],
                   "disconnectionArea": event["territoryOriginal"], "taskType": event["sourceType"],
                   "disconnectionDate": event["startLocal"], "reconnectionDate": event["endLocal"]}
            normalized = normalize_row(row, centre)
            if any(event.get(k) != v for k, v in normalized.items()):
                raise InvalidData("invalid_previous_event")
            if event["id"] in seen or type(event["inLatestResponse"]) is not bool:
                raise InvalidData("invalid_previous_event")
            first, last, changed = (read_stamp(event[k]) for k in ("firstSeenAt", "lastSeenAt", "changedAt"))
            if not first <= changed <= last <= utc(now):
                raise InvalidData("invalid_previous_event_time")
            seen.add(event["id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidData("invalid_previous_event") from exc
    return deepcopy(previous)


def failure_snapshot(previous, now, failure, centre=CENTRE):
    snapshot = validate_previous(previous, now, centre)
    snapshot["collection"].update({
        "status": "blocked" if failure.blocked else "error", "lastAttemptAt": stamp(now),
        "error": failure.code, "retryNotBefore": failure.retry_after,
        "manualReviewRequired": failure.blocked,
    })
    # Retain last valid observations and their timestamps. No false recovery.
    snapshot["changes"] = {"added": 0, "changed": 0, "notReturned": 0}
    return snapshot


def normalize(payload, now, previous=None, centre=CENTRE):
    baseline = validate_previous(previous, now, centre)
    if not isinstance(payload, dict) or type(payload.get("status")) is not int or payload["status"] != 200:
        raise InvalidData("unexpected_response")
    rows = payload.get("data")
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise InvalidData("unexpected_response")
    if not rows:
        return failure_snapshot(baseline, now, SourceFailure("empty_response_unconfirmed"), centre)
    reasons, candidates, conflicts, duplicates = Counter(), {}, set(), 0
    for row in rows:
        try:
            event = normalize_row(row, centre)
        except InvalidData as exc:
            reasons[str(exc)] += 1
            continue
        key = event["id"]
        if key in conflicts:
            reasons["conflicting_event"] += 1
        elif key not in candidates:
            candidates[key] = event
        elif candidates[key] == event:
            duplicates += 1
        else:
            del candidates[key]
            conflicts.add(key)
            reasons["conflicting_event"] += 2
    quality = {**empty_snapshot()["quality"], "receivedCount": len(rows),
               "acceptedCount": len(candidates), "quarantinedCount": sum(reasons.values()),
               "duplicateCount": duplicates, "reasons": dict(reasons),
               "possibleServerLimit": len(rows) >= 100}
    if not candidates:
        snapshot = failure_snapshot(baseline, now, SourceFailure("no_valid_records"), centre)
        snapshot["lastRejectedQuality"] = quality
        return snapshot
    old = {event["id"]: event for event in baseline["events"]}
    events, added, changed = [], 0, 0
    for key, event in candidates.items():
        prior = old.get(key)
        updated = prior is not None and any(prior.get(k) != v for k, v in event.items())
        added += prior is None
        changed += updated
        events.append({**event, "firstSeenAt": prior["firstSeenAt"] if prior else stamp(now),
                       "lastSeenAt": stamp(now), "changedAt": stamp(now) if not prior or updated else prior["changedAt"],
                       "inLatestResponse": True})
    missing = [event for key, event in old.items() if key not in candidates]
    events.extend({**event, "inLatestResponse": False} for event in missing)
    if len(events) > MAX_EVENTS:
        raise InvalidData("history_limit_requires_review")
    snapshot = empty_snapshot(centre)
    snapshot["collection"].update({"status": "partial", "lastAttemptAt": stamp(now), "lastSuccessAt": stamp(now)})
    snapshot["quality"] = quality
    snapshot["events"] = sorted(events, key=lambda event: event["id"])
    snapshot["changes"] = {"added": added, "changed": changed, "notReturned": len(missing)}
    return snapshot


def decode_json(raw):
    if len(raw) > MAX_BYTES:
        raise InvalidData("response_too_large")
    def reject_constant(value):
        raise InvalidData("invalid_json_constant")
    try:
        return json.loads(raw, parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise InvalidData("invalid_json") from exc


def collection_health(snapshot, now):
    """Age of our last usable collection, NOT freshness of the outage itself."""
    collection = snapshot["collection"]
    success = collection["lastSuccessAt"]
    age = (utc(now) - read_stamp(success)).total_seconds() if success else None
    if age is not None and age < 0:
        raise InvalidData("snapshot_from_future")
    state = collection["status"]
    if state == "partial":
        state = "collection_stale" if age is None or age > 3 * 3600 else "collection_recent_partial"
    return {"state": state, "secondsSinceSuccess": age, "supplyStatus": "unknown"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SourceFailure("redirect_requires_review", blocked=True)


def retry_time(value, now):
    if not value:
        return None
    try:
        target = utc(now) + timedelta(seconds=int(value)) if value.isdecimal() else parsedate_to_datetime(value)
        return stamp(max(utc(now), utc(target)))
    except (AttributeError, ValueError, OverflowError, InvalidData):
        return None


def fetch_once(now, opener=None, centre=CENTRE):
    # Default TLS validation stays on. No cookies, tokens, browser impersonation,
    # redirect following or automatic retries. This endpoint is a public search.
    if centre not in CENTRES.values():
        raise InvalidData("unsupported_centre")
    request = urllib.request.Request(API, data=json.dumps({"search": centre}).encode(), headers={
        "Content-Type": "application/json", "Accept": "application/json",
        "User-Agent": "Gamarji-outages-pilot/0.1 (+https://github.com/twlb/gel-cost)",
    })
    opener = opener or urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            if response.status != 200:
                raise SourceFailure("unexpected_http_status")
            if response.headers.get_content_type() != "application/json":
                raise SourceFailure("unexpected_content_type")
            return decode_json(response.read(MAX_BYTES + 1))
    except urllib.error.HTTPError as exc:
        raise SourceFailure("http_" + str(exc.code), blocked=exc.code in (401, 403),
                            retry_after=retry_time(exc.headers.get("Retry-After"), now)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SourceFailure("network_or_tls_error") from exc


def write_atomic(path, payload):
    encoded = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--input", type=Path, help="Previously retrieved public JSON; no network")
    mode.add_argument("--fetch", action="store_true", help="One public HTTPS search, no retries")
    parser.add_argument("--fetched-at", help="Required for a saved input: its actual retrieval time with timezone")
    parser.add_argument("--centre", choices=CENTRES, default="batumi", help="One source-centre query per independent snapshot; target territory stays Batumi")
    parser.add_argument("--output", type=Path, required=True, help="Private pilot snapshot, not outages.json for publication")
    args = parser.parse_args(argv)
    centre = CENTRES[args.centre]
    clock = datetime.now(timezone.utc)
    if bool(args.input) != bool(args.fetched_at):
        parser.error("--input requires --fetched-at; --fetch must not override its clock")
    now = read_stamp(args.fetched_at) if args.input else clock
    if now > clock:
        raise InvalidData("future_input_timestamp")
    if args.input and args.input.resolve() == args.output.resolve():
        raise InvalidData("input_must_not_be_overwritten")
    previous = decode_json(args.output.read_bytes()) if args.output.exists() else None
    baseline = validate_previous(previous, now, centre)  # Never overwrite an unrelated JSON/centre.
    if args.fetch:
        collection = baseline["collection"]
        if collection.get("manualReviewRequired") or collection.get("status") == "blocked":
            print("Blocked: source access requires review; no network request made.")
            return 2
        if collection.get("retryNotBefore") and read_stamp(collection["retryNotBefore"]) > now:
            print("Source requested a pause; no network request made.")
            return 2
    try:
        payload = decode_json(args.input.read_bytes()) if args.input else fetch_once(now, centre=centre)
        snapshot = normalize(payload, now, baseline, centre)
    except InvalidData as exc:
        snapshot = failure_snapshot(baseline, now, SourceFailure(str(exc)), centre)
    except SourceFailure as exc:
        snapshot = failure_snapshot(baseline, now, exc, centre)
    write_atomic(args.output, snapshot)
    # Only counts/status in the log: no subscriber notes or full street text.
    print(json.dumps({"status": snapshot["collection"]["status"], "error": snapshot["collection"]["error"],
                      "quality": snapshot["quality"], "changes": snapshot["changes"],
                      "collectionHealth": collection_health(snapshot, clock),
                      "retainedEvents": len(snapshot["events"]), "readyForPublication": False}, ensure_ascii=False))
    return 0 if snapshot["collection"]["status"] == "partial" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InvalidData, OSError) as exc:
        # Do not echo source bodies, file content or authentication details.
        print("Pilot stopped without replacing output: " + (str(exc) if isinstance(exc, InvalidData) else "local_io_error"))
        raise SystemExit(2)
