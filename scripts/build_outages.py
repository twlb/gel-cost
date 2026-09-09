#!/usr/bin/env python3
"""Project two private Energo-Pro pilot snapshots into a local-preview feed.

No network, source mutation, subscriber fields, location inference or restoration
claims. Original address text is publishable only after this structural gate;
the separate display translator does not provide privacy clearance.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata

from outage_addresses import AddressNormalizationError, house_tokens, is_verified_street, normalize_address

CENTRES = {"batumi": "ბათუმი", "khelvachauri": "ხელვაჩაური"}
PORTAL = "https://my.energo-pro.ge/ow/#/disconns"
MAX_BYTES = 16_000_000
MAX_INPUT_EVENTS = 10_000
MAX_EVENTS = 2_000
MAX_FEED_BYTES = 2_000_000
MAX_ADDRESSES = 100
PILOT_STATUSES = {"not_collected", "partial", "error", "blocked"}
ERROR_CODES = {
    "network_or_tls_error", "unexpected_http_status", "unexpected_content_type",
    "redirect_requires_review", "empty_response_unconfirmed", "no_valid_records",
    "invalid_json", "invalid_json_constant", "response_too_large", "unexpected_response",
    "history_limit_requires_review", "http_401", "http_403", "http_404", "http_408",
    "http_429", "http_500", "http_502", "http_503", "http_504",
}
TRANSLATION_STATUSES = {"verified-dictionary", "partial", "original"}
# Observed by the collecting agent in the operator's street/building field.
# This admits the source grammar, NOT an unverified Russian translation.
SOURCE_BARE_STREETS = frozenset({"პუშკინის"})
STREET_MARKER = re.compile(r"^(?P<street>.+? (?:ქუჩა|ქ\.|გამზირი|გამზ\.|გზატკეცილი|გზა|შესახვევი|ჩიხი))(?P<rest>(?:\s+.+)?)$")
HOUSE_UNIT = r"(?:N|№)?\s*[0-9]{1,4}[A-Za-zА-Яа-яЁё\u10a0-\u10ff\u1c90-\u1cbf]?"
HOUSE = re.compile(rf"{HOUSE_UNIT}(?:\s*[/\-–—]\s*{HOUSE_UNIT})*\Z")
HOUSE_PREFIX = re.compile(r"^შენ\.\s*")
PRIVATE_OR_EXTRA = re.compile(
    r"ბინა|ბინები|ბინის|აბონენტ|სადარბაზო|(?:^|\s|,)სად\.|ტელეფ|"
    r"(?<!\w)(?:apt\.?|apartment\w*|flat|suite|room|subscriber\w*|account\w*|"
    r"кв\.?|квартир\w*|подъезд\w*|абонент\w*|телефон\w*)(?![A-Za-zА-Яа-яЁё])",
    re.IGNORECASE,
)
LOCAL_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?\Z")
UTC_DATE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})\Z")


class ProjectionError(ValueError):
    """Reason codes only; source bodies and paths must not reach logs."""


class UnrecognizedStreet(ProjectionError):
    """A closed street component may be withheld without cutting house tails."""


def stamp(value):
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ProjectionError("timezone_required")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def read_stamp(value, optional=False):
    if optional and value is None:
        return None
    if not isinstance(value, str) or not UTC_DATE.fullmatch(value):
        raise ProjectionError("invalid_snapshot_time")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError as exc:
        raise ProjectionError("invalid_snapshot_time") from exc


def local_key(value, optional=False):
    if optional and value is None:
        return None
    match = LOCAL_DATE.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ProjectionError("invalid_local_time")
    y, month, day, hour, minute, second, fraction = match.groups()
    values = tuple(map(int, (y, month, day, hour, minute, second or "0")))
    try:
        datetime(*values)
    except ValueError as exc:
        raise ProjectionError("invalid_local_time") from exc
    # Compare the full source precision, without assigning a timezone or rounding.
    return (*values, int((fraction or "").ljust(7, "0")))


def _safe_name(name):
    return bool(name and len(name) <= 160 and any(c.isalpha() for c in name) and
                all(c.isalpha() or c.isdigit() or c in " .-'’" for c in name))


def _street_and_houses(body):
    parts = [part.strip() for part in body.split(",")]
    if not parts or any(not part for part in parts):
        raise ProjectionError("ambiguous_address_structure")
    first, remainder = parts[0], parts[1:]
    # Validate all continuations first. An unknown street must not hide an
    # ambiguous/free-text tail and turn the rest of the event into public data.
    for token in remainder:
        if not HOUSE.fullmatch(HOUSE_PREFIX.sub("", token, count=1)):
            raise ProjectionError("ambiguous_house_structure")
    if is_verified_street(first) or first in SOURCE_BARE_STREETS:
        street, attached = first, ""
    else:
        match = STREET_MARKER.fullmatch(first)
        if not match:
            # Exact dictionary names may have a house immediately after them.
            candidates = [i for i, c in enumerate(first) if c.isspace() and
                          (is_verified_street(first[:i]) or first[:i] in SOURCE_BARE_STREETS)]
            if not candidates:
                if not _safe_name(first):
                    raise ProjectionError("ambiguous_address_structure")
                raise UnrecognizedStreet("unrecognized_street_structure")
            split = max(candidates)
            street, attached = first[:split], first[split:].strip()
        else:
            street, attached = match.group("street"), match.group("rest").strip()
    if not _safe_name(street):
        raise ProjectionError("unrecognized_street_structure")
    houses = ([attached] if attached else []) + remainder
    for token in houses:
        house = HOUSE_PREFIX.sub("", token, count=1)
        if not HOUSE.fullmatch(house):
            raise ProjectionError("ambiguous_house_structure")
    return street, houses


def safe_addresses(territory):
    if not isinstance(territory, str) or not territory.strip() or len(territory) > 4000:
        raise ProjectionError("invalid_territory")
    if any(unicodedata.category(c) in ("Cc", "Cf", "Cs") for c in territory) or PRIVATE_OR_EXTRA.search(territory):
        raise ProjectionError("unsafe_territory")
    # Run the translator's private-content detector before any city extraction;
    # a rejected tail must not disappear and leave a seemingly safe prefix.
    try:
        normalize_address(territory)
    except AddressNormalizationError as exc:
        raise ProjectionError("unsafe_territory") from exc
    groups = []
    if territory.startswith("ბათუმი,"):
        groups = [(territory, territory[len("ბათუმი,"):].strip())]
    elif territory.startswith("ბათუმი/"):
        start = 0
        for match in re.finditer(r",\s*([^,]+)", territory):
            token = match.group(1).strip()
            if token.startswith("ბათუმი/"):
                original = territory[start:match.start()].strip()
                groups.append((original, original[len("ბათუმი/"):]))
                start = match.start(1)
            elif re.match(r"^[^\W\d_]+/", token):
                raise ProjectionError("mixed_city_territory")
        original = territory[start:].strip()
        groups.append((original, original[len("ბათუმი/"):]))
    else:
        raise ProjectionError("city_not_explicit")
    addresses, keys, withheld = [], [], 0
    for original, body in groups:
        # Deduplication retains the complete structurally valid scope, including
        # withheld unknown street names. It must not merge different reduced lists.
        keys.append(re.sub(r"\s*,\s*", ",", " ".join(body.split())))
        try:
            _street_and_houses(body)
        except UnrecognizedStreet:
            withheld += 1
            continue
        try:
            normalized = normalize_address(original)
        except AddressNormalizationError as exc:
            raise ProjectionError("unsafe_territory") from exc
        if normalized.get("original") != original or normalized.get("translationStatus") not in TRANSLATION_STATUSES:
            raise ProjectionError("invalid_translation_contract")
        if type(normalized.get("needsReview")) is not bool or not isinstance(normalized.get("houseTokens"), list):
            raise ProjectionError("invalid_translation_contract")
        display = normalized.get("display")
        if not isinstance(display, str) or not display or len(display) > 4000 or normalized["needsReview"] != (normalized["translationStatus"] != "verified-dictionary"):
            raise ProjectionError("invalid_translation_contract")
        if normalized["houseTokens"] != house_tokens(original) or house_tokens(display) != house_tokens(original) or re.findall(r"\d+", display) != re.findall(r"\d+", original):
            raise ProjectionError("translation_changed_numbers")
        # Explicit projection: extra fields in a translator result cannot escape.
        addresses.append({k: normalized[k] for k in ("original", "display", "translationStatus", "houseTokens", "needsReview")})
    if not addresses:
        raise ProjectionError("no_public_address")
    if len(addresses) > MAX_ADDRESSES:
        withheld += len(addresses) - MAX_ADDRESSES
        addresses = addresses[:MAX_ADDRESSES]
    return addresses, sorted(keys), bool(withheld)


def _metadata(snapshot, key, now):
    centre = CENTRES[key]
    expected = {"schemaVersion": 1, "stage": "research-pilot", "readyForPublication": False,
                "provider": "energo-pro", "scope": {"city": "batumi", "sourceCentre": centre}, "sourceUrl": PORTAL}
    if not isinstance(snapshot, dict) or type(snapshot.get("schemaVersion")) is not int or snapshot.get("readyForPublication") is not False or any(snapshot.get(k) != v for k, v in expected.items()):
        raise ProjectionError("invalid_snapshot")
    collection, events = snapshot.get("collection"), snapshot.get("events")
    if not isinstance(collection, dict) or collection.get("status") not in PILOT_STATUSES or not isinstance(events, list) or len(events) > MAX_INPUT_EVENTS:
        raise ProjectionError("invalid_snapshot")
    attempted = read_stamp(collection.get("lastAttemptAt"), True)
    succeeded = read_stamp(collection.get("lastSuccessAt"), True)
    status = collection["status"]
    if attempted and attempted > now or succeeded and (not attempted or succeeded > attempted):
        raise ProjectionError("invalid_snapshot_time")
    if status == "not_collected" and (attempted or succeeded or events):
        raise ProjectionError("invalid_snapshot")
    if status != "not_collected" and not attempted or status == "partial" and not succeeded:
        raise ProjectionError("invalid_snapshot")
    manual_review = collection.get("manualReviewRequired", False)
    if type(manual_review) is not bool or manual_review and status != "blocked":
        raise ProjectionError("invalid_snapshot")
    error = collection.get("error")
    if error is not None and not isinstance(error, str) or status in ("partial", "not_collected") and error is not None:
        raise ProjectionError("invalid_snapshot")
    error_code = error if isinstance(error, str) and error in ERROR_CODES else "source_error" if error else None
    query = {"key": key, "status": "missing" if status == "not_collected" else status,
             "lastAttemptAt": stamp(attempted) if attempted else None,
             "lastSuccessAt": stamp(succeeded) if succeeded else None, "errorCode": error_code}
    return query, succeeded


def _candidate(event, key, success):
    if not isinstance(event, dict) or not success:
        raise ProjectionError("invalid_event")
    task = event.get("sourceTaskId")
    if not isinstance(task, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", task) or int(task) > 2**53 - 1:
        raise ProjectionError("invalid_event_id")
    required = {"city": "batumi", "sourceCentre": CENTRES[key], "sourceUrl": PORTAL,
                "language": "ka", "timeZone": None, "endMeaning": "unconfirmed",
                "restoration": "unconfirmed", "sourcePublishedAt": None}
    if any(k not in event or event[k] != value for k, value in required.items()):
        raise ProjectionError("invalid_event")
    code = event.get("sourceType")
    if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,20}", code):
        raise ProjectionError("invalid_event_type")
    kind = {"1": "planned", "3": "unplanned"}.get(code, "unknown")
    if event.get("kind") != kind or type(event.get("inLatestResponse")) is not bool:
        raise ProjectionError("invalid_event")
    start, end = local_key(event.get("startLocal")), local_key(event.get("endLocal"), True)
    if end is not None and end < start:
        raise ProjectionError("invalid_event_time")
    first, changed, seen = (read_stamp(event.get(k)) for k in ("firstSeenAt", "changedAt", "lastSeenAt"))
    if not first <= changed <= seen <= success:
        raise ProjectionError("invalid_observation_time")
    addresses, area_keys, partially_withheld = safe_addresses(event.get("territoryOriginal"))
    identity = json.dumps([task, area_keys], ensure_ascii=False, separators=(",", ":"))
    return identity, (code, start, end), {
        "id": "energo:" + hashlib.sha256(identity.encode()).hexdigest()[:32],
        "kind": kind, "addresses": addresses, "startLocal": event["startLocal"], "endLocal": event["endLocal"],
        "endMeaning": "unconfirmed", "restoration": "unconfirmed", "firstSeenAt": stamp(first), "lastSeenAt": stamp(seen),
        "provenance": [{"query": key, "seenAt": stamp(seen), "inLatestResponse": event["inLatestResponse"]}],
    }, partially_withheld


def _count(value):
    return value if type(value) is int and 0 <= value <= MAX_INPUT_EVENTS + 5000 else 0


def build_feed(snapshots, now=None):
    now = read_stamp(stamp(now or datetime.now(timezone.utc)))
    queries, grouped, omitted = [], defaultdict(list), 0
    for key in CENTRES:
        snapshot = snapshots.get(key)
        if snapshot is None:
            queries.append({"key": key, "status": "missing", "lastAttemptAt": None, "lastSuccessAt": None, "errorCode": "missing_snapshot"})
            continue
        try:
            query, success = _metadata(snapshot, key, now)
        except ProjectionError:
            queries.append({"key": key, "status": "error", "lastAttemptAt": None, "lastSuccessAt": None, "errorCode": "invalid_snapshot"})
            omitted += min(len(snapshot.get("events", [])), MAX_INPUT_EVENTS) if isinstance(snapshot, dict) and isinstance(snapshot.get("events"), list) else 0
            continue
        queries.append(query)
        quality = snapshot.get("lastRejectedQuality", snapshot.get("quality", {}))
        if isinstance(quality, dict):
            omitted += _count(quality.get("quarantinedCount"))
        for event in snapshot["events"]:
            try:
                identity, version, candidate, partially_withheld = _candidate(event, key, success)
                grouped[identity].append((version, candidate, partially_withheld))
            except ProjectionError:
                omitted += 1
    events = []
    for records in grouped.values():
        if len({version for version, _, _ in records}) != 1:
            omitted += len(records)
            continue
        result = records[0][1]
        omitted += sum(partial for _, _, partial in records)
        result["firstSeenAt"] = min((item["firstSeenAt"] for _, item, _ in records), key=read_stamp)
        result["lastSeenAt"] = max((item["lastSeenAt"] for _, item, _ in records), key=read_stamp)
        provenance = {}
        for _, item, _ in records:
            observation = item["provenance"][0]
            previous = provenance.get(observation["query"])
            if not previous or read_stamp(observation["seenAt"]) > read_stamp(previous["seenAt"]):
                provenance[observation["query"]] = observation
        result["provenance"] = [provenance[key] for key in CENTRES if key in provenance]
        events.append(result)
    result = {"schemaVersion": 1, "stage": "local-preview", "generatedAt": stamp(now), "city": "batumi",
              "coverage": "partial", "queries": queries, "quality": {"omitted": omitted}, "events": []}
    # Match the UI's hard limits. Prefer more recent source dates, not supposedly
    # active outages; this never changes a source date or collection timestamp.
    budget = MAX_FEED_BYTES - len(_encode(result).encode("utf-8")) - 16
    ordered = sorted(events, key=lambda item: (local_key(item["startLocal"]), read_stamp(item["lastSeenAt"]), item["id"]), reverse=True)
    for item in ordered:
        size = len("\n".join("    " + line for line in json.dumps(item, ensure_ascii=False, indent=2).splitlines()).encode("utf-8")) + 2
        if len(result["events"]) >= MAX_EVENTS or size > budget:
            result["quality"]["omitted"] += 1
        else:
            result["events"].append(item)
            budget -= size
    if len(_encode(result).encode("utf-8")) > MAX_FEED_BYTES:
        raise ProjectionError("feed_too_large")
    return result


def read_snapshot(path):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ProjectionError("duplicate_json_key")
            result[key] = value
        return result
    try:
        with path.open("rb") as stream:
            raw = stream.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ProjectionError("snapshot_too_large")
        return json.loads(raw, object_pairs_hook=object_pairs, parse_constant=lambda _: (_ for _ in ()).throw(ProjectionError("invalid_json_constant")))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProjectionError("unreadable_snapshot") from exc


def _encode(feed):
    return json.dumps(feed, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def write_atomic(path, feed):
    if path.exists():
        previous = read_snapshot(path)
        if not isinstance(previous, dict) or any(previous.get(k) != v for k, v in {"schemaVersion": 1, "stage": "local-preview", "city": "batumi"}.items()):
            raise ProjectionError("unrelated_output")
    encoded = _encode(feed)
    if len(encoded.encode("utf-8")) > MAX_FEED_BYTES:
        raise ProjectionError("feed_too_large")
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
    parser.add_argument("--batumi", type=Path, required=True)
    parser.add_argument("--khelvachauri", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    inputs = {key: getattr(args, key) for key in CENTRES}
    if len({path.resolve() for path in inputs.values()}) != len(inputs) or args.output.resolve() in {path.resolve() for path in inputs.values()}:
        raise ProjectionError("paths_must_be_distinct")
    snapshots = {}
    for key, path in inputs.items():
        if not path.exists():
            snapshots[key] = None
        else:
            try:
                snapshots[key] = read_snapshot(path)
            except ProjectionError:
                snapshots[key] = {}  # Fixed invalid_snapshot state, never source/error text.
    feed = build_feed(snapshots)
    write_atomic(args.output, feed)
    print(json.dumps({"stage": feed["stage"], "events": len(feed["events"]), "omitted": feed["quality"]["omitted"],
                      "queries": [{"key": query["key"], "status": query["status"]} for query in feed["queries"]]}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ProjectionError, OSError) as exc:
        print("Outage projection stopped: " + (str(exc) if isinstance(exc, ProjectionError) else "local_io_error"))
        raise SystemExit(2)
