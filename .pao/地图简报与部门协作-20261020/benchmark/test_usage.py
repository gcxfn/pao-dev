"""标准库离线测试：所有事件均为模拟，不替代真实模型/Harbor 集成结论。"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('bench_usage', Path(__file__).parent / 'map_bench_pao/usage.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
aggregate = module.aggregate_session_usage


def usage(cost=0.1):
    return dict(input=10, output=3, cacheRead=2, cacheWrite=1, cost={'total': cost})


def assistant(identity, raw=None):
    return {'type': 'message', 'id': identity, 'message': {'role': 'assistant', 'provider': 'fake', 'model': 'simulated', 'usage': usage() if raw is None else raw}}


class UsageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def file(self, name, session, events):
        path = Path(self.temp.name) / name
        path.write_text('\n'.join(json.dumps(e) for e in [{'type': 'session', 'id': session}, *events]), encoding='utf-8')
        return path

    def test_all_roles_and_copied_files_deduplicate(self):
        roles = ['主控', '侦察', '规划', '部门', 'worker', '审核', '重试']
        files = [self.file(f'{i}.jsonl', role, [assistant('same-entry-id')]) for i, role in enumerate(roles)]
        files.append(self.file('renamed-copy.jsonl', 'worker', [assistant('same-entry-id')]))
        result = aggregate(files)
        self.assertEqual(result['events'], len(roles))
        self.assertEqual(result['input'], 13 * len(roles))
        self.assertEqual(result['cache_write'], len(roles))
        self.assertAlmostEqual(result['cost'], .7)
        self.assertTrue(result['complete'])

    def test_parent_receipt_is_not_added_to_child_again(self):
        receipt = {'type': 'message', 'id': 'receipt', 'message': {'role': 'toolResult', 'content': [{'text': '模拟 worker 汇总', 'usage': usage()}]}}
        files = [self.file('parent.jsonl', 'parent', [assistant('p'), receipt]), self.file('child.jsonl', 'child', [assistant('c')])]
        self.assertEqual(aggregate(files)['events'], 2)

    def test_auxiliary_compaction_and_branch_are_counted(self):
        events = [{'type': kind, 'id': kind, 'provider': 'fake', 'model': 'aux', 'usage': usage()} for kind in ['usage', 'compaction', 'branch_summary']]
        result = aggregate([self.file('aux.jsonl', 'aux', events)])
        self.assertEqual(result['events'], 3)
        self.assertEqual(set(result['models']), {'fake/aux'})

    def test_summary_without_usage_does_not_make_normal_compaction_unknown(self):
        events = [
            assistant('assistant'),
            {'type': 'compaction', 'id': 'compaction-missing', 'summary': '压缩摘要'},
            {'type': 'branch_summary', 'id': 'branch-missing', 'summary': '分支摘要'},
        ]
        result = aggregate([self.file('summary-without-usage.jsonl', 's', events)])
        self.assertEqual(result['events'], 1)
        self.assertEqual(result['unknown_cost'], 0)
        self.assertEqual(result['unknown_tokens'], 0)
        self.assertTrue(result['complete'])

    def test_independent_usage_event_still_counts_unknown_without_usage(self):
        events = [{'type': 'usage', 'id': 'independent-usage', 'kind': 'cache_warm'}]
        result = aggregate([self.file('usage-without-usage.jsonl', 's', events)])
        self.assertEqual(result['events'], 0)
        self.assertEqual(result['unknown_cost'], 0)
        self.assertEqual(result['unknown_tokens'], 0)
        self.assertTrue(result['complete'])

    def test_unknown_status_remain_unknown(self):
        events = [assistant('missing', {}), {'type': 'custom', 'id': 'unknown', 'customType': 'pao-native-usage-status', 'data': {'usageReported': False}},
                  {'type': 'custom', 'id': 'unknown-pre', 'customType': 'pao-precompaction-usage-status', 'data': {'status': '请求未返回用量'}}]
        result = aggregate([self.file('missing.jsonl', 's', events)])
        self.assertEqual(result['unknown_cost'], 3)
        self.assertEqual(result['unknown_tokens'], 3)
        self.assertFalse(result['complete'])

    def test_missing_cost_boolean_and_nan_are_not_free(self):
        events = [assistant(str(i), {**usage(), 'cost': value}) for i, value in enumerate([None, True, float('nan')])]
        result = aggregate([self.file('cost.jsonl', 's', events)])
        self.assertEqual(result['unknown_cost'], 3)
        self.assertFalse(result['complete'])

    def test_conflicting_duplicate_cannot_claim_complete(self):
        a = self.file('a.jsonl', 's', [assistant('same')])
        b = self.file('b.jsonl', 's', [assistant('same', usage(.2))])
        result = aggregate([a, b])
        self.assertEqual(result['events'], 1)
        self.assertTrue(result['errors'])

    def test_empty_or_corrupt_logs_do_not_claim_zero(self):
        self.assertFalse(aggregate([])['complete'])
        p = Path(self.temp.name) / 'corrupt.jsonl'
        p.write_text('{bad', encoding='utf-8')
        self.assertTrue(aggregate([p])['errors'])

    def test_aborted_before_request_is_ignored(self):
        e = assistant('abort')
        e['message'].update(stopReason='aborted', errorMessage='Operation aborted before provider request')
        self.assertEqual(aggregate([self.file('abort.jsonl', 's', [e])])['events'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
