"""Keep validated public observations without reconstructing private source IDs.

Absence from a newer successful query is not proof of restored supply. Limits
fail closed rather than silently truncating a preserved history.
"""
from copy import deepcopy
import json
import re

import build_outages as projection


class HistoryError(ValueError):
    pass


def require(condition):
    if not condition:
        raise HistoryError('invalid_public_history')


def utc(value, optional=False):
    if value is None and optional:
        return None
    require(isinstance(value, str) and value.endswith('Z'))
    return projection.read_stamp(value)


def validate(feed, now):
    """Strict public allowlist, including the collector's structural address gate."""
    try:
        require(isinstance(feed, dict) and set(feed) == {
            'schemaVersion', 'stage', 'generatedAt', 'city', 'coverage', 'queries', 'quality', 'events'})
        require(type(feed['schemaVersion']) is int and feed['schemaVersion'] == 1 and
                feed['stage'] == 'local-preview' and feed['city'] == 'batumi' and feed['coverage'] == 'partial')
        generated = utc(feed['generatedAt'])
        require(generated <= now)
        require(isinstance(feed['queries'], list) and len(feed['queries']) == 2)
        queries = {}
        for q in feed['queries']:
            require(isinstance(q, dict) and set(q) in (
                {'key', 'status', 'lastAttemptAt', 'lastSuccessAt'},
                {'key', 'status', 'lastAttemptAt', 'lastSuccessAt', 'errorCode'}))
            require(q['key'] in projection.CENTRES and q['key'] not in queries)
            require(q['status'] in {'ok', 'partial', 'missing', 'error', 'blocked'})
            attempted = utc(q['lastAttemptAt'], True)
            succeeded = utc(q['lastSuccessAt'], True)
            require(not attempted or attempted <= generated)
            require(not succeeded or bool(attempted and succeeded <= attempted))
            require(q['status'] not in ('ok', 'partial') or succeeded is not None)
            require(q.get('errorCode') in projection.ERROR_CODES | {None, 'missing_snapshot', 'invalid_snapshot', 'source_error'})
            queries[q['key']] = succeeded
        require(isinstance(feed['events'], list) and len(feed['events']) <= projection.MAX_EVENTS)
        ids = set()
        for event in feed['events']:
            require(isinstance(event, dict) and set(event) == {
                'id', 'kind', 'addresses', 'startLocal', 'endLocal', 'endMeaning',
                'restoration', 'firstSeenAt', 'lastSeenAt', 'provenance'})
            require(isinstance(event['id'], str) and re.fullmatch(r'energo:[a-f0-9]{32,64}', event['id']) and event['id'] not in ids)
            ids.add(event['id'])
            require(event['kind'] in {'planned', 'unplanned', 'unknown'})
            require(event['restoration'] == event['endMeaning'] == 'unconfirmed')
            start, end = projection.local_key(event['startLocal']), projection.local_key(event['endLocal'], True)
            require(end is None or start <= end)
            first, last = utc(event['firstSeenAt']), utc(event['lastSeenAt'])
            require(first <= last <= generated)
            require(isinstance(event['addresses'], list) and 1 <= len(event['addresses']) <= projection.MAX_ADDRESSES)
            for address in event['addresses']:
                require(isinstance(address, dict))
                require(type(address.get('needsReview')) is bool)
                clean, _, withheld = projection.safe_addresses(address['original'])
                require(not withheld and len(clean) == 1 and clean[0] == address)
            require(isinstance(event['provenance'], list) and 1 <= len(event['provenance']) <= 2)
            seen, query_keys = [], set()
            for p in event['provenance']:
                require(isinstance(p, dict) and set(p) == {'query', 'seenAt', 'inLatestResponse'})
                require(p['query'] in queries and p['query'] not in query_keys and type(p['inLatestResponse']) is bool)
                query_keys.add(p['query'])
                seen_at = utc(p['seenAt'])
                require(queries[p['query']] is not None and first <= seen_at <= last and seen_at <= queries[p['query']])
                seen.append(seen_at)
            require(max(seen) == last)
        require(isinstance(feed['quality'], dict) and set(feed['quality']) == {'omitted'})
        require(type(feed['quality']['omitted']) is int and 0 <= feed['quality']['omitted'] <= 2**53-1)
        require(len(projection._encode(feed).encode()) <= projection.MAX_FEED_BYTES)
        return deepcopy(feed)
    except (KeyError, TypeError, AttributeError, ValueError) as exc:
        raise HistoryError('invalid_public_history') from exc


def merge(previous, current, now):
    current = validate(current, now)
    if previous is None:
        return current
    previous = validate(previous, now)
    require(projection.read_stamp(previous['generatedAt']) <= projection.read_stamp(current['generatedAt']))
    queries = {q['key']: q for q in current['queries']}
    for old in previous['queries']:
        prior = projection.read_stamp(old['lastSuccessAt'], True)
        latest = projection.read_stamp(queries[old['key']]['lastSuccessAt'], True)
        if prior and (not latest or latest < prior):
            raise HistoryError('history_observations_would_be_lost')
    old_events = {e['id']: e for e in previous['events']}
    new_events = {e['id']: e for e in current['events']}
    result = []
    for identity in old_events.keys() | new_events.keys():
        old, new = old_events.get(identity), new_events.get(identity)
        if old and new:
            old_seen, new_seen = projection.read_stamp(old['lastSeenAt']), projection.read_stamp(new['lastSeenAt'])
            if old_seen == new_seen and any(old[k] != new[k] for k in ('kind', 'startLocal', 'endLocal', 'addresses')):
                raise HistoryError('conflicting_history_version')
            event = deepcopy(new if new_seen >= old_seen else old)
            event['firstSeenAt'] = min(old['firstSeenAt'], new['firstSeenAt'], key=projection.read_stamp)
        else:
            event = deepcopy(new or old)
        observations = {}
        for source in (old, new):
            if source:
                for p in source['provenance']:
                    prior = observations.get(p['query'])
                    if not prior or projection.read_stamp(p['seenAt']) >= projection.read_stamp(prior['seenAt']):
                        observations[p['query']] = deepcopy(p)
        # Never advance seenAt just because the feed was refreshed. A successful
        # newer query without this exact observation changes only its presence.
        for key, p in observations.items():
            latest = projection.read_stamp(queries[key]['lastSuccessAt'])
            if projection.read_stamp(p['seenAt']) < latest:
                p['inLatestResponse'] = False
        event['provenance'] = [observations[k] for k in projection.CENTRES if k in observations]
        event['lastSeenAt'] = max((p['seenAt'] for p in event['provenance']), key=projection.read_stamp)
        result.append(event)
    current['events'] = sorted(result, key=lambda e: (projection.local_key(e['startLocal']), projection.read_stamp(e['lastSeenAt']), e['id']), reverse=True)
    # Current filtering count is not a cumulative count of missing incidents.
    return validate(current, now)


def combine_saved(first, second, now):
    """Combine already observed copies in time order; reject inconsistent clocks."""
    if first is None:
        return validate(second, now)
    ordered = sorted((first, second), key=lambda feed: projection.read_stamp(feed['generatedAt']))
    return merge(*ordered, now)
