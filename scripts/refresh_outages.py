#!/usr/bin/env python3
"""One guarded collection + safe local-preview projection. Never publishes.

Keep private state outside the website and Git. A scheduler may invoke this
entrypoint; minimum cadence and endpoint-wide access refusal are enforced here.
No daemon, credentials, redirects, TLS bypass or source-body log is created.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import argparse
import fcntl
import json
import os

import collect_power_pilot as power
import build_outages as projection

REPO = Path(__file__).resolve().parents[1]


def run(state_dir, output, now=None, fetcher=None, interval=7200):
    now = now or datetime.now(timezone.utc)
    fetcher = fetcher or power.fetch_once
    state_dir, output = Path(state_dir).resolve(), Path(output).resolve()
    if state_dir == REPO or REPO in state_dir.parents or output == state_dir or state_dir in output.parents:
        raise power.InvalidData('private_state_must_be_outside_site')
    if interval not in (1800, 7200):
        raise power.InvalidData('unsupported_collection_interval')
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state_dir.stat().st_mode & 0o077:
        raise power.InvalidData('private_state_permissions_required')
    lock_path = state_dir / 'collector.lock'
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'state': 'already_running', 'requests': 0}
        guard_path = state_dir / 'endpoint.json'
        guard = projection.read_snapshot(guard_path) if guard_path.exists() else None
        if guard is not None:
            if not isinstance(guard, dict) or guard.get('schemaVersion') != 1 or type(guard.get('blocked')) is not bool:
                raise power.InvalidData('invalid_endpoint_state')
            due = power.read_stamp(guard.get('nextAttemptAt'))
            if guard['blocked']:
                return {'state': 'blocked_requires_review', 'requests': 0}
            if now < due:
                return {'state': 'not_due', 'requests': 0}
        snapshots = {}
        for key, centre in power.CENTRES.items():
            path = state_dir / (key + '.json')
            prior = projection.read_snapshot(path) if path.exists() else None
            snapshots[key] = power.validate_previous(prior, now, centre)
            collection = snapshots[key]['collection']
            if collection.get('manualReviewRequired') or collection.get('status') == 'blocked':
                return {'state': 'blocked_requires_review', 'requests': 0}
            if collection.get('retryNotBefore') and power.read_stamp(collection['retryNotBefore']) > now:
                return {'state': 'source_pause', 'requests': 0}
        # Persist the guard before requesting: a crash cannot cause an immediate
        # duplicate call on scheduler retry. Existing snapshot times stay intact.
        guard = {'schemaVersion': 1, 'blocked': False,
                 'nextAttemptAt': power.stamp(now + timedelta(seconds=interval))}
        power.write_atomic(guard_path, guard)
        requests, failed, blocked = 0, False, False
        for key, centre in power.CENTRES.items():
            requests += 1
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
                if blocked or exc.retry_after or exc.code == 'http_429':
                    guard['blocked'] = blocked
                    power.write_atomic(guard_path, guard)
                    power.write_atomic(state_dir / (key + '.json'), snapshots[key])
                    failed = True
                    break  # Same endpoint: another city is NOT another way in.
            power.write_atomic(state_dir / (key + '.json'), snapshots[key])
            failed |= snapshots[key]['collection']['status'] not in ('partial',)
        feed = projection.build_feed(snapshots, now)
        projection.write_atomic(output, feed)
        return {'state': 'blocked' if blocked else 'partial_error' if failed else 'collected',
                'requests': requests, 'events': len(feed['events']), 'omitted': feed['quality']['omitted']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch', action='store_true', required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--interval', type=int, choices=(1800, 7200), default=7200,
                        help='Normal 2h. 30min is an explicit operational choice, not an inferred live emergency.')
    args = parser.parse_args()
    result = run(args.state_dir, args.output, interval=args.interval)
    print(json.dumps(result))
    return 1 if result['state'] in ('blocked', 'partial_error', 'blocked_requires_review') else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        print('Collection stopped safely: local state or projection requires review.')
        raise SystemExit(2)
