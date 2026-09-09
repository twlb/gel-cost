#!/usr/bin/env python3
"""One guarded collection. No scheduler or website publishing.

Missing/corrupt/interrupted state fails closed. Initialization is a separate,
explicit operation. Git mode reserves each run remotely BEFORE source requests.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
import argparse
import fcntl
import json

import collect_power_pilot as power
import build_outages as projection
import outage_checkpoint as checkpoint
from outage_state_store import FileState, GitState, StateError

REPO = Path(__file__).resolve().parents[1]


def validate_output(output):
    if output.exists():
        previous = projection.read_snapshot(output)
        if not isinstance(previous, dict) or any(previous.get(k) != v for k, v in
                {'schemaVersion': 1, 'stage': 'local-preview', 'city': 'batumi'}.items()):
            raise power.InvalidData('unrelated_output')
    if not output.parent.is_dir():
        raise power.InvalidData('missing_output_directory')


def protect_newer_feed(snapshots, output):
    """An older restored checkpoint must not replace a newer published history."""
    if not output.exists():
        return
    previous = projection.read_snapshot(output)
    queries = previous.get('queries')
    if not isinstance(queries, list) or len(queries) != len(power.CENTRES):
        raise StateError('invalid_feed_history')
    if any(not isinstance(query, dict) for query in queries) or {q.get('key') for q in queries} != set(power.CENTRES):
        raise StateError('invalid_feed_history')
    for query in queries:
        old = projection.read_stamp(query.get('lastSuccessAt'), optional=True)
        restored = projection.read_stamp(snapshots[query['key']]['collection']['lastSuccessAt'], optional=True)
        if old and (restored is None or restored < old):
            raise StateError('checkpoint_older_than_feed_requires_review')


def restore_output(state, output):
    # Re-project a completed checkpoint after an output-write failure. Retain
    # its actual timestamp; this is recovery, not a new successful collection.
    feed = checkpoint.feed(state)
    projection.write_atomic(output, feed)


@contextmanager
def local_store(state_dir, output):
    state_dir, output = Path(state_dir).resolve(), Path(output).resolve()
    if state_dir == REPO or REPO in state_dir.parents or output == state_dir or state_dir in output.parents:
        raise power.InvalidData('private_state_must_be_outside_site')
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state_dir.stat().st_mode & 0o077:
        raise power.InvalidData('private_state_permissions_required')
    with (state_dir / 'collector.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise StateError('already_running') from exc
        yield FileState(state_dir)


def initialize_store(store, output, now, *, snapshots=None, guard=None):
    """Explicit one-time seed. Existing feed requires BOTH history and guard.

    This never fetches, resets an existing checkpoint, or unblocks an endpoint.
    Operators must verify any seed against the latest saved collector state.
    """
    output = Path(output)
    validate_output(output)
    if store.read()[0] is not None:
        raise StateError('state_already_initialized')
    if (snapshots is None) != (guard is None):
        raise StateError('incomplete_initial_state')
    if snapshots is None:
        if output.exists():
            raise StateError('existing_feed_requires_history_and_guard')
        snapshots = {key: power.empty_snapshot(centre) for key, centre in power.CENTRES.items()}
        guard = {'blocked': False, 'inFlight': False, 'nextAttemptAt': power.stamp(now)}
    value = checkpoint.pack(guard, snapshots, now)
    # Do not seed a replacement history that loses already published events.
    if output.exists():
        before = projection.read_snapshot(output)
        after = projection.build_feed(value['snapshots'], now)
        if before.get('events') != after['events'] or any(
                old.get('lastSuccessAt') != new['lastSuccessAt']
                for old, new in zip(before.get('queries', []), after['queries'])) or len(before.get('queries', [])) != len(after['queries']):
            raise StateError('seed_does_not_match_existing_feed')
    store.save(value, None)
    return {'state': 'initialized', 'requests': 0}


def initialize(state_dir, output, now=None, **kwargs):
    with local_store(state_dir, output) as store:
        # Never mistake legacy files for permission to reset earlier protection.
        if any((Path(state_dir) / name).exists() for name in ('endpoint.json', 'batumi.json', 'khelvachauri.json')):
            raise StateError('legacy_state_requires_explicit_import')
        return initialize_store(store, output, now or datetime.now(timezone.utc), **kwargs)


def collect(store, output, now=None, fetcher=None, interval=7200):
    now = now or datetime.now(timezone.utc)
    fetcher = fetcher or power.fetch_once
    output = Path(output).resolve()
    if interval not in (1800, 7200):
        raise power.InvalidData('unsupported_collection_interval')
    validate_output(output)  # No source request for a bad destination.
    revision, raw = store.read()
    if revision is None or raw is None:
        raise StateError('missing_state_requires_review')
    state = checkpoint.decode(raw, now)
    guard, snapshots = state['endpoint'], state['snapshots']
    protect_newer_feed(snapshots, output)
    if output.exists():
        state = checkpoint.retain_public_history(state, projection.read_snapshot(output))
    history = state.get('history')
    if guard['blocked']:
        if not guard['inFlight']:
            restore_output(state, output)
        return {'state': 'blocked_requires_review', 'requests': 0}
    if guard['inFlight']:
        return {'state': 'interrupted_requires_review', 'requests': 0}
    if now < power.read_stamp(guard['nextAttemptAt']):
        restore_output(state, output)
        return {'state': 'not_due', 'requests': 0}
    for snapshot in snapshots.values():
        collection = snapshot['collection']
        if collection['manualReviewRequired'] or collection['status'] == 'blocked':
            restore_output(state, output)
            return {'state': 'blocked_requires_review', 'requests': 0}
        if collection['retryNotBefore'] and power.read_stamp(collection['retryNotBefore']) > now:
            restore_output(state, output)
            return {'state': 'source_pause', 'requests': 0}

    def save():
        nonlocal revision, snapshots
        value = checkpoint.pack(guard, snapshots, now, history)
        revision = store.save(value, revision)
        snapshots = value['snapshots']

    guard = {'blocked': False, 'inFlight': True,
             'nextAttemptAt': power.stamp(now + timedelta(seconds=interval))}
    save()  # Durable reservation; failure here means zero source requests.
    requests, failed, blocked = 0, False, False
    for key, centre in power.CENTRES.items():
        requests += 1
        stop = False
        try:
            payload = fetcher(now, centre=centre)
            snapshots[key] = power.normalize(payload, now, snapshots[key], centre)
        except power.InvalidData:
            snapshots[key] = power.failure_snapshot(snapshots[key], now, power.SourceFailure('unexpected_response'), centre)
        except power.SourceFailure as exc:
            snapshots[key] = power.failure_snapshot(snapshots[key], now, exc, centre)
            blocked = exc.blocked
            if exc.retry_after:
                guard['nextAttemptAt'] = power.stamp(max(power.read_stamp(guard['nextAttemptAt']), power.read_stamp(exc.retry_after)))
            stop = blocked or bool(exc.retry_after) or exc.code == 'http_429'
            guard['blocked'] = blocked
        failed |= snapshots[key]['collection']['status'] != 'partial'
        save()  # Persist refusal/partial progress before another source request.
        if stop:
            break
    feed = checkpoint.feed(checkpoint.pack(guard, snapshots, now, history))
    history = feed
    guard['inFlight'] = False
    save()  # Never output uncommitted observations.
    projection.write_atomic(output, feed)
    return {'state': 'blocked' if blocked else 'partial_error' if failed else 'collected',
            'requests': requests, 'events': len(feed['events']), 'omitted': feed['quality']['omitted']}


def run(state_dir, output, now=None, fetcher=None, interval=7200):
    with local_store(state_dir, output) as store:
        return collect(store, output, now, fetcher, interval)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--fetch', action='store_true')
    mode.add_argument('--initialize', action='store_true', help='Explicit EMPTY seed only; refuses an existing feed/history')
    storage = parser.add_mutually_exclusive_group(required=True)
    storage.add_argument('--state-dir', type=Path)
    storage.add_argument('--state-remote', help='Operator-configured Git remote; writes only outage-collector-state')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--interval', type=int, choices=(1800, 7200), default=7200)
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    if args.state_remote:
        with GitState(args.state_remote) as store:
            result = initialize_store(store, args.output, now) if args.initialize else collect(store, args.output, now, interval=args.interval)
    elif args.initialize:
        result = initialize(args.state_dir, args.output, now)
    else:
        result = run(args.state_dir, args.output, now, interval=args.interval)
    print(json.dumps(result))
    return 0 if result['state'] in ('collected', 'initialized', 'not_due', 'source_pause') else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        print('Collection stopped safely: state or output requires review; no automatic reset.')
        raise SystemExit(2)
