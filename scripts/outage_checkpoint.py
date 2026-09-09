"""Portable allowlisted collector state. Never persist raw source responses."""
from copy import deepcopy
from datetime import datetime, timezone
import json

import build_outages as projection
import collect_power_pilot as power
import outage_history

MAX_BYTES = 16_000_000


def endpoint(value):
    keys = {'blocked', 'inFlight', 'nextAttemptAt'}
    if not isinstance(value, dict) or set(value) != keys:
        raise power.InvalidData('invalid_endpoint_state')
    if any(type(value[key]) is not bool for key in ('blocked', 'inFlight')):
        raise power.InvalidData('invalid_endpoint_state')
    projection.read_stamp(value['nextAttemptAt'])
    return deepcopy(value)


def clean_snapshot(snapshot, key, now):
    """Export known fields only; never cut an address tail to make it publishable."""
    centre = power.CENTRES[key]
    previous = power.validate_previous(snapshot, now, centre)
    _, success = projection._metadata(previous, key, now)
    result = power.empty_snapshot(centre)
    collection = previous['collection']
    for field in result['collection']:
        result['collection'][field] = collection.get(field)
    if type(result['collection']['manualReviewRequired']) is not bool:
        raise power.InvalidData('invalid_review_state')
    retry = result['collection']['retryNotBefore']
    if retry is not None:
        projection.read_stamp(retry)
    error = result['collection']['error']
    if error is not None and error not in projection.ERROR_CODES:
        raise power.InvalidData('unrecognized_error_code')
    dropped = 0
    for event in previous['events']:
        try:
            _, _, _, withheld = projection._candidate(event, key, success)
            if withheld:
                raise projection.ProjectionError('partially_withheld_address')
        except projection.ProjectionError:
            dropped += 1
            continue
        # Reconstruct the contract: no arbitrary metadata/translator fields.
        row = {'taskId': int(event['sourceTaskId']), 'scName': centre,
               'disconnectionArea': event['territoryOriginal'], 'taskType': event['sourceType'],
               'disconnectionDate': event['startLocal'], 'reconnectionDate': event['endLocal']}
        clean = power.normalize_row(row, centre)
        for field in ('firstSeenAt', 'lastSeenAt', 'changedAt', 'inLatestResponse'):
            clean[field] = event[field]
        result['events'].append(clean)
    # Keep omission evidence, but not free-form reasons or raw rejected records.
    for field in ('quality', 'lastRejectedQuality'):
        if field not in previous:
            continue
        quality = previous[field]
        if not isinstance(quality, dict):
            raise power.InvalidData('invalid_quality_state')
        count = quality.get('quarantinedCount', 0)
        if type(count) is not int or not 0 <= count <= 15000:
            raise power.InvalidData('invalid_quality_state')
        result[field] = {**power.empty_snapshot(centre)['quality'],
                         'quarantinedCount': min(15000, count + dropped)}
    return result


def pack(guard, snapshots, now, history=None):
    now = power.utc(now)
    if not isinstance(snapshots, dict) or set(snapshots) != set(power.CENTRES):
        raise power.InvalidData('missing_centre_state')
    result = {'schemaVersion': 1, 'stage': 'collector-checkpoint',
              'updatedAt': power.stamp(now), 'endpoint': endpoint(guard),
              'snapshots': {key: clean_snapshot(snapshots[key], key, now) for key in power.CENTRES}}
    if history is not None:
        result['schemaVersion'] = 2
        result['history'] = outage_history.validate(history, now)
    if len(encode(result)) > MAX_BYTES:
        raise power.InvalidData('checkpoint_too_large')
    return result


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False,
                       separators=(',', ':')) + '\n').encode('utf-8')


def decode(raw, now=None):
    """Reject corrupt/noncanonical input; do not silently repair restored state."""
    now = now or datetime.now(timezone.utc)
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise power.InvalidData('duplicate_checkpoint_key')
            result[key] = value
        return result
    try:
        if len(raw) > MAX_BYTES:
            raise power.InvalidData('checkpoint_too_large')
        value = json.loads(raw, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        updated = projection.read_stamp(value['updatedAt'])
        if updated > power.utc(now):
            raise power.InvalidData('checkpoint_from_future')
        canonical = pack(value['endpoint'], value['snapshots'], updated, value.get('history'))
        if encode(canonical) != encode(value):
            raise power.InvalidData('invalid_checkpoint_contract')
        return canonical
    except (KeyError, TypeError, AttributeError, UnicodeError, ValueError) as exc:
        raise power.InvalidData('invalid_checkpoint_requires_review') from exc


def feed(state):
    now = projection.read_stamp(state['updatedAt'])
    current = projection.build_feed(state['snapshots'], now)
    return outage_history.merge(state.get('history'), current, now)


def retain_public_history(state, previous):
    """Offline v1 -> v2 adoption. Guard, source IDs and collection times unchanged."""
    now = projection.read_stamp(state['updatedAt'])
    history = outage_history.combine_saved(state.get('history'), previous, now)
    value = pack(state['endpoint'], state['snapshots'], now, history)
    # Validate merged observation times before persisting any migration.
    value['history'] = feed(value)
    return value
