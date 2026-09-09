"""No network: synthetic source and temporary private state only."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import refresh_outages as refresh
import collect_power_pilot as power

NOW = datetime(2026, 9, 9, 5, tzinfo=timezone.utc)


def fixture(now, *, centre):
    return {'status': 200, 'data': [{'taskId': 123, 'scName': centre,
        'disconnectionArea': 'ბათუმი, ფრიდონ ხალვაშის გამზირი, შენ. 8/1',
        'taskType': '1', 'disconnectionDate': '2026-09-09 10:00', 'reconnectionDate': None}]}


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.state, self.output = self.base/'private', self.base/'outages.json'
        refresh.initialize(self.state, self.output, now=NOW)

    def run_once(self, **kwargs):
        return refresh.run(self.state, self.output, now=kwargs.pop('now', NOW), fetcher=kwargs.pop('fetcher', fixture), **kwargs)

    def test_two_queries_then_cadence_prevents_duplicates(self):
        self.assertEqual(self.run_once()['requests'], 2)
        self.assertEqual(self.run_once(now=NOW+timedelta(seconds=7199)), {'state':'not_due','requests':0})
        self.assertEqual(self.run_once(now=NOW+timedelta(hours=2))['requests'], 2)
        self.assertEqual(self.state.stat().st_mode & 0o077, 0)
        self.assertEqual(len(json.loads(self.output.read_text())['events']), 1)

    def test_403_stops_same_endpoint_and_future_runs(self):
        calls=[]
        def blocked(now, **kw):
            calls.append(kw);raise power.SourceFailure('http_403', blocked=True)
        self.assertEqual(self.run_once(fetcher=blocked)['requests'], 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.run_once(now=NOW+timedelta(days=1), fetcher=blocked)['requests'], 0)

    def test_retry_after_stops_other_query_and_respects_longer_pause(self):
        def paused(now, **kw):
            raise power.SourceFailure('http_429', retry_after=power.stamp(NOW+timedelta(hours=5)))
        self.assertEqual(self.run_once(fetcher=paused)['requests'], 1)
        self.assertEqual(self.run_once(now=NOW+timedelta(hours=3))['requests'], 0)

    def test_source_failure_cannot_change_last_success(self):
        self.run_once()
        before=json.loads(self.output.read_text())
        def fail(now, **kw):
            raise power.SourceFailure('network_or_tls_error')
        result=self.run_once(now=NOW+timedelta(hours=2), fetcher=fail)
        after=json.loads(self.output.read_text())
        self.assertEqual(result['state'], 'partial_error')
        self.assertEqual([q['lastSuccessAt'] for q in before['queries']], [q['lastSuccessAt'] for q in after['queries']])
        self.assertEqual(before['events'], after['events'])

    def test_private_state_cannot_be_served_from_project(self):
        with self.assertRaises(power.InvalidData):
            refresh.run(refresh.REPO/'private-test', self.output, now=NOW, fetcher=fixture)

    def test_output_cannot_expose_private_directory(self):
        with self.assertRaises(power.InvalidData):
            refresh.run(self.state, self.state/'outages.json', now=NOW, fetcher=fixture)

    def test_unrelated_output_is_not_overwritten(self):
        self.output.write_text('{"user":"TEST"}')
        with self.assertRaises(ValueError): self.run_once()
        self.assertEqual(json.loads(self.output.read_text()), {'user':'TEST'})
