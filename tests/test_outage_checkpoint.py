"""No network: state validation, privacy and fresh-runner regressions."""
from copy import deepcopy
from datetime import timedelta
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import collect_power_pilot as power
import outage_checkpoint as checkpoint
from outage_state_store import FileState, StateError
import refresh_outages as refresh
from test_outages_refresh import NOW, fixture


def fail(now, **kwargs):
    raise power.SourceFailure('network_or_tls_error')


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.private, self.output = self.base / 'private', self.base / 'outages.json'
        refresh.initialize(self.private, self.output, now=NOW)
        self.store = FileState(self.private)

    def run_once(self, **kwargs):
        return refresh.run(self.private, self.output, now=kwargs.pop('now', NOW),
                           fetcher=kwargs.pop('fetcher', fixture), **kwargs)

    def state(self):
        return checkpoint.decode(self.store.read()[1], NOW + timedelta(days=2))

    def test_missing_state_keeps_feed_and_never_fetches(self):
        self.run_once()
        before = self.output.read_bytes()
        fetcher = Mock(side_effect=fail)
        with self.assertRaisesRegex(StateError, 'missing_state'):
            refresh.run(self.base / 'new-runner', self.output, now=NOW+timedelta(hours=3), fetcher=fetcher)
        fetcher.assert_not_called()
        self.assertEqual(before, self.output.read_bytes())

    def test_restored_checkpoint_retains_events_and_success_on_failure(self):
        self.run_once()
        before = json.loads(self.output.read_text())
        new_directory = self.base / 'restored'
        new_directory.mkdir(mode=0o700)
        # Simulates transport to a new runner; no old private directory needed.
        (new_directory / 'checkpoint.json').write_bytes(self.store.read()[1])
        result = refresh.run(new_directory, self.output, now=NOW+timedelta(hours=3), fetcher=fail)
        after = json.loads(self.output.read_text())
        self.assertEqual(result['state'], 'partial_error')
        self.assertEqual(before['events'], after['events'])
        self.assertEqual([q['lastSuccessAt'] for q in before['queries']], [q['lastSuccessAt'] for q in after['queries']])

    def test_corruption_is_not_treated_as_initialization(self):
        self.run_once()
        before = self.output.read_bytes()
        valid = checkpoint.encode(self.state())
        for raw in (b'{', b'{}', valid.replace(b'"schemaVersion":1', b'"schemaVersion":true'),
                    valid.replace(b'"endpoint":', b'"endpoint":{},"endpoint":', 1)):
            with self.subTest(raw=raw[:20]):
                self.store.path.write_bytes(raw)
                fetcher = Mock()
                with self.assertRaises(ValueError):
                    self.run_once(now=NOW+timedelta(hours=3), fetcher=fetcher)
                fetcher.assert_not_called()
                self.assertEqual(before, self.output.read_bytes())

    def test_missing_centre_or_unknown_fields_fail_closed(self):
        valid = self.state()
        variants = []
        missing = deepcopy(valid)
        del missing['snapshots']['batumi']
        variants.append(missing)
        extra = deepcopy(valid)
        extra['subscriberName'] = 'SYNTHETIC_PRIVATE'
        variants.append(extra)
        future = deepcopy(valid)
        future['updatedAt'] = power.stamp(NOW+timedelta(days=1))
        variants.append(future)
        for value in variants:
            with self.assertRaises(ValueError):
                checkpoint.decode(checkpoint.encode(value), NOW)

    def test_export_strips_unknown_fields_and_withholds_unsafe_territory(self):
        snapshots = {}
        for key, centre in power.CENTRES.items():
            payload = fixture(NOW, centre=centre)
            payload['data'][0]['subscriberName'] = 'SYNTHETIC_PRIVATE'
            snapshots[key] = power.normalize(payload, NOW, centre=centre)
            snapshots[key]['events'][0]['extra'] = 'SYNTHETIC_PRIVATE'
            snapshots[key]['private'] = 'SYNTHETIC_PRIVATE'
        exported = checkpoint.pack(self.state()['endpoint'], snapshots, NOW)
        self.assertNotIn(b'SYNTHETIC_PRIVATE', checkpoint.encode(exported))
        self.assertEqual(checkpoint.decode(checkpoint.encode(exported), NOW), exported)
        # A street-like free-text tail passes the research collector, but must
        # not enter the portable state. Do not trim it to a plausible address.
        payload = fixture(NOW, centre=power.CENTRE)
        payload['data'][0]['disconnectionArea'] += ', SYNTHETIC_PRIVATE'
        snapshots['batumi'] = power.normalize(payload, NOW)
        exported = checkpoint.pack(self.state()['endpoint'], snapshots, NOW)
        self.assertEqual(exported['snapshots']['batumi']['events'], [])
        self.assertEqual(exported['snapshots']['batumi']['quality']['quarantinedCount'], 1)
        self.assertNotIn(b'SYNTHETIC_PRIVATE', checkpoint.encode(exported))

    def test_reservation_save_failure_means_zero_requests_and_no_feed_change(self):
        self.run_once()
        before = self.output.read_bytes()
        fetcher = Mock()
        with patch.object(FileState, 'save', side_effect=StateError('offline')):
            with self.assertRaises(StateError):
                self.run_once(now=NOW+timedelta(hours=3), fetcher=fetcher)
        fetcher.assert_not_called()
        self.assertEqual(before, self.output.read_bytes())

    def test_crash_after_reservation_stops_next_run_even_after_due_time(self):
        def crash(now, **kwargs):
            raise RuntimeError('simulated process termination')
        with self.assertRaises(RuntimeError):
            self.run_once(fetcher=crash)
        self.assertTrue(self.state()['endpoint']['inFlight'])
        fetcher = Mock()
        result = self.run_once(now=NOW+timedelta(days=1), fetcher=fetcher)
        self.assertEqual(result, {'state': 'interrupted_requires_review', 'requests': 0})
        fetcher.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_failed_save_after_403_does_not_forget_uncertainty(self):
        real_save = FileState.save
        calls = []
        def save(store, value, expected):
            calls.append(1)
            if len(calls) == 2:
                raise StateError('simulated remote disconnect')
            return real_save(store, value, expected)
        def forbidden(now, **kwargs):
            raise power.SourceFailure('http_403', blocked=True)
        with patch.object(FileState, 'save', save):
            with self.assertRaises(StateError):
                self.run_once(fetcher=forbidden)
        self.assertTrue(self.state()['endpoint']['inFlight'])
        self.assertEqual(self.run_once(now=NOW+timedelta(days=1))['requests'], 0)

    def test_partial_failure_keeps_other_centre_history(self):
        self.run_once()
        before = self.state()['snapshots']['khelvachauri']
        def partial(now, *, centre):
            if centre == power.CENTRES['khelvachauri']:
                return fail(now)
            payload = fixture(now, centre=centre)
            payload['data'][0]['reconnectionDate'] = '2026-09-09 15:00'
            return payload
        result = self.run_once(now=NOW+timedelta(hours=3), fetcher=partial)
        after = self.state()['snapshots']['khelvachauri']
        self.assertEqual(result['state'], 'partial_error')
        self.assertEqual(before['events'], after['events'])
        self.assertEqual(before['collection']['lastSuccessAt'], after['collection']['lastSuccessAt'])

    def test_successful_empty_response_is_not_a_clear_command(self):
        self.run_once()
        before = json.loads(self.output.read_text())['events']
        result = self.run_once(now=NOW+timedelta(hours=3), fetcher=lambda *a, **k: {'status': 200, 'data': []})
        self.assertEqual(result['state'], 'partial_error')
        self.assertEqual(before, json.loads(self.output.read_text())['events'])

    def test_explicit_initialization_cannot_reset_or_ignore_existing_feed(self):
        with self.assertRaisesRegex(StateError, 'already_initialized'):
            refresh.initialize(self.private, self.output, now=NOW)
        self.run_once()
        with self.assertRaisesRegex(StateError, 'existing_feed'):
            refresh.initialize(self.base/'fresh', self.output, now=NOW)

    def test_explicit_history_import_preserves_refusal_and_feed(self):
        self.run_once()
        saved = self.state()
        saved['endpoint']['blocked'] = True
        target = self.base / 'imported'
        refresh.initialize(target, self.output, now=NOW, snapshots=saved['snapshots'], guard=saved['endpoint'])
        self.assertEqual(refresh.run(target, self.output, now=NOW+timedelta(days=1), fetcher=fixture)['requests'], 0)

    def test_legacy_initialization_requires_explicit_import(self):
        target = self.base / 'legacy'
        target.mkdir(mode=0o700)
        (target / 'endpoint.json').write_text('{"blocked":true}')
        with self.assertRaisesRegex(StateError, 'legacy_state'):
            refresh.initialize(target, self.output, now=NOW)

    def test_bad_output_prevents_source_request(self):
        self.output.write_text('{"user":"SYNTHETIC"}')
        fetcher = Mock()
        with self.assertRaises(ValueError):
            self.run_once(fetcher=fetcher)
        fetcher.assert_not_called()

    def test_final_output_failure_keeps_durable_completed_state(self):
        with patch.object(refresh.projection, 'write_atomic', side_effect=OSError('disk')):
            with self.assertRaises(OSError):
                self.run_once()
        self.assertFalse(self.state()['endpoint']['inFlight'])
        self.assertEqual(len(self.state()['snapshots']['batumi']['events']), 1)
        self.assertEqual(self.run_once()['state'], 'not_due')
        self.assertEqual(len(json.loads(self.output.read_text())['events']), 1)
        self.assertEqual(json.loads(self.output.read_text())['generatedAt'], power.stamp(NOW))

    def test_older_checkpoint_cannot_overwrite_newer_feed(self):
        old = self.store.read()[1]
        self.run_once()
        before = self.output.read_bytes()
        self.store.path.write_bytes(old)
        fetcher = Mock()
        with self.assertRaisesRegex(StateError, 'older_than_feed'):
            self.run_once(now=NOW+timedelta(hours=3), fetcher=fetcher)
        fetcher.assert_not_called()
        self.assertEqual(before, self.output.read_bytes())

    def test_save_failure_after_each_response_or_before_completion_stops_safely(self):
        real_save = FileState.save
        for failure_index in (2, 3, 4):
            with self.subTest(failure_index=failure_index):
                directory = self.base / f'failure-{failure_index}'
                output = self.base / f'feed-{failure_index}.json'
                refresh.initialize(directory, output, now=NOW)
                calls = []
                fetcher = Mock(side_effect=fixture)
                def save(store, value, expected):
                    calls.append(1)
                    if len(calls) == failure_index:
                        raise StateError('simulated write failure')
                    return real_save(store, value, expected)
                with patch.object(FileState, 'save', save):
                    with self.assertRaises(StateError):
                        refresh.run(directory, output, now=NOW, fetcher=fetcher)
                self.assertEqual(fetcher.call_count, min(failure_index-1, 2))
                self.assertFalse(output.exists())
                fetcher.reset_mock()
                self.assertEqual(refresh.run(directory, output, now=NOW+timedelta(days=1), fetcher=fetcher)['state'], 'interrupted_requires_review')
                fetcher.assert_not_called()

    def test_cli_missing_state_returns_failure_without_modifying_feed(self):
        self.run_once()
        before = self.output.read_bytes()
        completed = subprocess.run([sys.executable, str(refresh.REPO/'scripts/refresh_outages.py'),
                                    '--fetch', '--state-dir', str(self.base/'cli-fresh'),
                                    '--output', str(self.output)], capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 2)
        self.assertIn('stopped safely', completed.stdout)
        self.assertEqual(completed.stderr, '')
        self.assertEqual(before, self.output.read_bytes())

    def test_generated_and_recovered_feed_passes_actual_js_consumer(self):
        self.run_once()
        self.run_once(now=NOW+timedelta(hours=3), fetcher=fail)
        script = """const fs=require('node:fs'),assert=require('node:assert/strict');
const O=require(process.argv[1]);
const data=O.validate(JSON.parse(fs.readFileSync(0,'utf8')),Date.parse(process.argv[2]));
assert.equal(data.events.length,1);
assert.equal(data.queries[0].status,'error');
assert.ok(data.events[0].addresses[0].display.includes('8/1'));
console.log('generated feed accepted by outages.js');"""
        completed = subprocess.run(['node', '-e', script, str(refresh.REPO/'outages.js'),
                                    power.stamp(NOW+timedelta(hours=3))], input=self.output.read_text(),
                                   capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
