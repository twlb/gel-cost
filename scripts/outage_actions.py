#!/usr/bin/env python3
"""Manual GitHub Actions entrypoint: inspect by default; never deploys Pages.

No initialization, migration, automatic unblock, raw artifact or source retries.
The existing public feed is copied only to a temporary candidate for collection.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import tempfile

import build_outages as projection
import outage_checkpoint as checkpoint
from outage_state_store import GitState, StateError
import refresh_outages as refresh

REPOSITORY = 'twlb/gel-cost'


def context(env):
    if (env.get('GITHUB_ACTIONS') != 'true' or
            env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or
            env.get('GITHUB_REPOSITORY') != REPOSITORY or
            env.get('GITHUB_REF') != 'refs/heads/main' or
            env.get('GITHUB_SERVER_URL') != 'https://github.com'):
        raise StateError('unsupported_manual_run_context')
    mode = env.get('OUTAGE_MODE', 'inspect')
    if mode not in ('inspect', 'collect'):
        raise StateError('invalid_manual_mode')
    if mode == 'collect' and (env.get('OUTAGE_COLLECTION_ENABLED') != 'true' or
                              env.get('OUTAGE_CONFIRM_COLLECTION') != 'true'):
        raise StateError('manual_collection_not_enabled')
    token = env.get('OUTAGE_GITHUB_TOKEN')
    if not token:
        raise StateError('missing_scoped_token')
    return mode, token


def inspect(store, public_feed, now):
    refresh.validate_output(public_feed)
    revision, raw = store.read()
    if revision is None or raw is None:
        return {'state': 'missing_state_requires_review', 'requests': 0, 'sitePublished': False}
    state = checkpoint.decode(raw, now)
    refresh.protect_newer_feed(state['snapshots'], public_feed)
    if public_feed.exists():
        state = checkpoint.retain_public_history(state, projection.read_snapshot(public_feed))
    guard = state['endpoint']
    status = 'ready_for_manual_collection'
    if guard['inFlight']:
        status = 'interrupted_requires_review'
    elif guard['blocked'] or any(s['collection']['manualReviewRequired'] or
            s['collection']['status'] == 'blocked' for s in state['snapshots'].values()):
        status = 'blocked_requires_review'
    elif projection.read_stamp(guard['nextAttemptAt']) > now or any(
            s['collection']['retryNotBefore'] and
            projection.read_stamp(s['collection']['retryNotBefore']) > now
            for s in state['snapshots'].values()):
        status = 'not_due'
    feed = checkpoint.feed(state)
    return {'state': status, 'requests': 0, 'events': len(feed['events']), 'sitePublished': False}


def run(store, mode, public_feed, now=None, *, fetcher=None):
    now = now or datetime.now(timezone.utc)
    public_feed = Path(public_feed).resolve()
    if mode == 'inspect':
        return inspect(store, public_feed, now)
    if mode != 'collect':
        raise StateError('invalid_manual_mode')
    # No output path/input supplied by dispatch can target repository files.
    with tempfile.TemporaryDirectory(prefix='gamarji-outage-candidate-') as directory:
        candidate = Path(directory) / 'outages.json'
        if public_feed.exists():
            shutil.copyfile(public_feed, candidate)
        result = refresh.collect(store, candidate, now, fetcher=fetcher)
        return {**result, 'sitePublished': False}


def main():
    mode, token = context(os.environ)
    with GitState(f'https://github.com/{REPOSITORY}.git', token=token) as store:
        result = run(store, mode, refresh.REPO / 'outages.json')
    print(json.dumps(result))
    return 0 if result['state'] in ('ready_for_manual_collection', 'not_due', 'source_pause', 'collected') else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        print(json.dumps({'state': 'manual_check_requires_review', 'sitePublished': False}))
        raise SystemExit(2)
