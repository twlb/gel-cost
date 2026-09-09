"""Offline regression: preserved public history is not reconstructed raw data."""
from copy import deepcopy
from datetime import timedelta
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import build_outages as projection
import collect_power_pilot as power
import outage_checkpoint as checkpoint
import outage_history as history
from outage_state_store import FileState, GitState
import refresh_outages as refresh
from test_outages_refresh import NOW, fixture


def snapshots(now, tasks=(123, 456)):
    result = {}
    for key, centre in power.CENTRES.items():
        payload = fixture(now, centre=centre)
        row = payload['data'][0]
        payload['data'] = [{**row, 'taskId': task} for task in tasks]
        result[key] = power.normalize(payload, now, centre=centre)
    return result


def pair():
    old = projection.build_feed(snapshots(NOW), NOW)
    later = NOW + timedelta(hours=3)
    new = projection.build_feed(snapshots(later, (123,)), later)
    return old, new, later


class HistoryTests(unittest.TestCase):
    def test_missing_event_is_kept_without_advancing_observation_time(self):
        old, new, now = pair()
        result = history.merge(old, new, now)
        self.assertEqual(len(result['events']), 2)
        removed = next(e for e in old['events'] if e['id'] not in {r['id'] for r in new['events']})
        kept = next(e for e in result['events'] if e['id'] == removed['id'])
        self.assertEqual(kept['firstSeenAt'], removed['firstSeenAt'])
        self.assertEqual(kept['lastSeenAt'], removed['lastSeenAt'])
        self.assertEqual(kept['startLocal'], removed['startLocal'])
        self.assertEqual(kept['restoration'], 'unconfirmed')
        self.assertTrue(all(not p['inLatestResponse'] for p in kept['provenance']))

    def test_matching_id_is_not_duplicated_and_first_observation_is_retained(self):
        old, new, now = pair()
        result = history.merge(old, new, now)
        identity = new['events'][0]['id']
        event = next(e for e in result['events'] if e['id'] == identity)
        self.assertEqual(sum(e['id'] == identity for e in result['events']), 1)
        self.assertEqual(event['firstSeenAt'], power.stamp(NOW))
        self.assertEqual(event['lastSeenAt'], power.stamp(now))
        self.assertTrue(all(p['inLatestResponse'] for p in event['provenance']))

    def test_merge_is_idempotent_and_does_not_mutate_inputs(self):
        old, new, now = pair()
        originals = deepcopy((old, new))
        result = history.merge(old, new, now)
        self.assertEqual(history.merge(result, new, now), result)
        self.assertEqual((old, new), originals)

    def test_source_failure_does_not_invent_absence_or_success(self):
        old, _, now = pair()
        failed = {key: power.failure_snapshot(s, now, power.SourceFailure('network_or_tls_error'), power.CENTRES[key])
                  for key, s in snapshots(NOW).items()}
        result = history.merge(old, projection.build_feed(failed, now), now)
        self.assertEqual(old['events'], result['events'])
        self.assertTrue(all(q['status'] == 'error' for q in result['queries']))
        self.assertTrue(all(q['lastSuccessAt'] == power.stamp(NOW) for q in result['queries']))

    def test_reappearing_event_uses_new_source_values_but_keeps_first_seen(self):
        old, new, now = pair()
        saved = history.merge(old, new, now)
        later = now + timedelta(hours=3)
        back = projection.build_feed(snapshots(later), later)
        for e in back['events']:
            e['endLocal'] = '2026-09-09 19:00'
        result = history.merge(saved, back, later)
        self.assertEqual(len(result['events']), 2)
        self.assertTrue(all(e['firstSeenAt'] == power.stamp(NOW) for e in result['events']))
        self.assertTrue(all(e['endLocal'] == '2026-09-09 19:00' for e in result['events']))
        self.assertTrue(all(all(p['inLatestResponse'] for p in e['provenance']) for e in result['events']))

    def test_older_snapshot_cannot_replace_newer_history(self):
        old, new, now = pair()
        with self.assertRaises(history.HistoryError):
            history.merge(new, old, now)

    def test_conflicting_equal_time_version_is_not_silently_selected(self):
        old, _, _ = pair()
        other = deepcopy(old)
        other['events'][0]['endLocal'] = '2026-09-09 19:00'
        with self.assertRaisesRegex(history.HistoryError, 'conflicting_history'):
            history.merge(old, other, NOW)

    def test_private_or_unknown_fields_and_invalid_types_are_rejected(self):
        old, _, _ = pair()
        changes = [lambda f: f.update(subscriber='PRIVATE'),
                   lambda f: f['events'][0].update(sourceTaskId='PRIVATE'),
                   lambda f: f['events'][0]['addresses'][0].update(display='PRIVATE'),
                   lambda f: f['events'][0]['addresses'][0].update(needsReview=0),
                   lambda f: f['events'][0]['provenance'][0].update(seenAt='2026-09-09T05:00:00+00:00'),
                   lambda f: f.update(schemaVersion=True),
                   lambda f: f['queries'].pop()]
        for mutate in changes:
            value = deepcopy(old)
            mutate(value)
            with self.assertRaises(ValueError):
                history.validate(value, NOW)

    def test_history_limit_stops_instead_of_deleting_old_events(self):
        old, new, now = pair()
        new['events'][0]['id'] = 'energo:' + 'f'*32
        with patch.object(projection, 'MAX_EVENTS', 2):
            with self.assertRaises(ValueError):
                history.merge(old, new, now)

    def test_source_identifier_is_never_reconstructed_for_archived_entries(self):
        old, _, now = pair()
        current = snapshots(now, (123,))
        guard = {'blocked': True, 'inFlight': False, 'nextAttemptAt': power.stamp(now+timedelta(hours=2))}
        original = checkpoint.pack(guard, current, now)
        migrated = checkpoint.retain_public_history(original, old)
        self.assertEqual(migrated['schemaVersion'], 2)
        self.assertEqual(original['endpoint'], migrated['endpoint'])
        self.assertEqual(original['snapshots'], migrated['snapshots'])
        self.assertEqual(original['updatedAt'], migrated['updatedAt'])
        self.assertNotIn('sourceTaskId', json.dumps(migrated['history']))
        self.assertEqual(checkpoint.decode(checkpoint.encode(migrated), now), migrated)

    def test_v1_checkpoint_still_decodes_without_automatic_history_invention(self):
        state = checkpoint.pack({'blocked': False, 'inFlight': False, 'nextAttemptAt': power.stamp(NOW)}, snapshots(NOW), NOW)
        self.assertEqual(checkpoint.decode(checkpoint.encode(state), NOW)['schemaVersion'], 1)
        self.assertNotIn('history', state)

    def test_migrated_checkpoint_survives_new_git_runner_without_original_file(self):
        old, _, now = pair()
        state = checkpoint.pack({'blocked': False, 'inFlight': False, 'nextAttemptAt': power.stamp(now+timedelta(hours=2))}, snapshots(now, (123,)), now)
        state = checkpoint.retain_public_history(state, old)
        with tempfile.TemporaryDirectory() as directory:
            remote = str(Path(directory)/'state.git')
            subprocess.run(['git', 'init', '--quiet', '--bare', remote], check=True, capture_output=True)
            with GitState(remote) as first:
                first.save(state, None)
            with GitState(remote) as second:
                restored = checkpoint.decode(second.read()[1], now)
                self.assertEqual(checkpoint.feed(restored), checkpoint.feed(state))
                self.assertEqual(len(checkpoint.feed(restored)['events']), 2)

    def test_collect_adopts_existing_public_history_before_any_request(self):
        old, _, now = pair()
        state = checkpoint.pack({'blocked': False, 'inFlight': False, 'nextAttemptAt': power.stamp(now)}, snapshots(now, (123,)), now)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private = root/'private'
            private.mkdir(mode=0o700)
            store = FileState(private)
            store.save(state, None)
            output = root/'outages.json'
            projection.write_atomic(output, old)
            def crash(*args, **kwargs):
                persisted = checkpoint.decode(store.read()[1], now)
                self.assertTrue(persisted['endpoint']['inFlight'])
                self.assertEqual(len(persisted['history']['events']), 2)
                raise RuntimeError('simulated interruption')
            with self.assertRaises(RuntimeError):
                refresh.run(private, output, now=now, fetcher=crash)
            self.assertEqual(projection.read_snapshot(output), old)

    def test_actual_js_consumer_marks_retained_event_missing_not_restored(self):
        old, new, now = pair()
        result = history.merge(old, new, now)
        script = """const O=require(process.argv[1]),fs=require('node:fs'),a=require('node:assert/strict');
const data=O.validate(JSON.parse(fs.readFileSync(0,'utf8')),Date.parse(process.argv[2]));
a.equal(data.events.length,2);
a.equal(data.events.filter(e=>O.eventState(e,data.queries,Date.parse(process.argv[2])).missing).length,1);"""
        run = subprocess.run(['node','-e',script,str(refresh.REPO/'outages.js'),power.stamp(now)],
                             input=json.dumps(result),text=True,capture_output=True,timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
