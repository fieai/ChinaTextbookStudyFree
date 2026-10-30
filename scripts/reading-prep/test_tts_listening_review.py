"""Offline integrity checks for committed round-one listening decisions.

Run: .local/tools/pinyin-venv/bin/python -m unittest discover \
    -s scripts/reading-prep -p 'test_*.py'
"""
import importlib.util
import copy
import json
from pathlib import Path
import tempfile
import unittest

from pypinyin.phrases_dict import phrases_dict

SPEC = importlib.util.spec_from_file_location('tts_listening_review', Path(__file__).with_name('tts_listening_review.py'))
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)
CONTENT = Path(__file__).resolve().parents[2] / 'content' / 'reading-prep'


class ListeningReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((CONTENT / 'tts-listening-review.json').read_text())
        cls.round4_data = copy.deepcopy(cls.data)
        cls.round4_data.pop('round5Stats', None)
        cls.round4_data['provenance'].pop('round5', None)
        for row in cls.round4_data['records']:
            if row.pop('round5', None):
                row['readingText'] = row['round4']['readingText']
        cls.round3_data = copy.deepcopy(cls.round4_data)
        cls.round3_data.pop('round4Stats', None)
        cls.round3_data['provenance'].pop('round4', None)
        for row in cls.round3_data['records']:
            row.pop('round4', None)
        cls.round2_data = copy.deepcopy(cls.round3_data)
        cls.round2_data.pop('round3Stats', None)
        cls.round2_data['provenance'].pop('round3', None)
        for row in cls.round2_data['records']:
            state = row.pop('round3', None)
            row.pop('round3Rewrite', None)
            if state:
                row['readingText'] = state['readingText']
        cls.records = copy.deepcopy(cls.data['records'])
        # Verify first-round history independently of later synthesis proposals.
        for row in cls.records:
            if 'round2' in row:
                row['readingText'] = row['round2']['readingText']

    def test_review_counts_and_disjoint_stable_ids(self):
        self.assertEqual(self.data['stats'], {'approved': 211, 'rejected': 98, 'rejectedPoly': 43, 'rejectedSingle': 55, 'wholeWordFallback': 16})
        self.assertEqual(len(self.records), 309)
        ids = [entry_id for row in self.records for entry_id in row['entryIds']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all('/characters/' in value or value.endswith('/character') for value in ids))
        for row in self.records:
            self.assertTrue(row['entryIds'])
            self.assertTrue(row['text'])
            self.assertIn(row['kind'], ('poly', 'single'))
        for key in ('resultsSha256', 'originalPlanSha256', 'originalListeningDataSha256'):
            self.assertRegex(self.data['provenance'][key], r'^[a-f0-9]{64}$')

    def test_all_211_approved_keep_text_and_recorded_keys(self):
        approved = [row for row in self.records if row['status'] == 'approved']
        self.assertEqual(len(approved), 211)
        for row in approved:
            self.assertEqual(row['readingText'], row['originalReadingText'])
            self.assertRegex(row['originalCacheKey'], r'^[a-f0-9]{64}$')
            self.assertIsNone(row['substitute'])
        legacy = [row for row in approved if row['pinyin'] is None]
        self.assertEqual({row['text'] for row in legacy}, {'晃', '读'})
        self.assertTrue(all(row['entryIdsWithoutExpectedPinyin'] == row['entryIds'] for row in legacy))

    def test_poly_substitutes_have_exact_unique_toned_reading(self):
        rows = [row for row in self.records if row['status'] == 'rejected' and row['kind'] == 'poly']
        self.assertEqual(len(rows), 43)
        fallback = []
        for row in rows:
            word, substitute = row['contextWord'], row['substitute']
            self.assertTrue(word)
            self.assertIn(row['text'], word)
            if substitute:
                self.assertEqual(review.all_readings(substitute), [row['pinyin']])
                self.assertEqual(row['substituteReadings'], [row['pinyin']])
                self.assertEqual(row['readingText'], f'{substitute}，{word}的{substitute}')
                self.assertNotEqual(substitute, row['text'])
            else:
                fallback.append(row['text'])
                self.assertEqual(row['readingText'], word)
                self.assertTrue(row['fallbackReason'])
            self.assertNotEqual(row['readingText'], row['originalReadingText'])
        self.assertEqual(len(fallback), 16)
        arm = next(row for row in rows if row['text'] == '臂')
        self.assertEqual((arm['pinyin'], arm['readingText']), ('bei', '胳臂'))
        price = next(row for row in rows if row['text'] == '假')
        self.assertEqual(price['substitute'], '架')
        self.assertGreater(len(review.all_readings('价')), 1)

    def test_all_55_single_contexts_are_two_characters_with_expected_sound(self):
        rows = [row for row in self.records if row['status'] == 'rejected' and row['kind'] == 'single']
        self.assertEqual(len(rows), 55)
        for row in rows:
            word = row['contextWord']
            self.assertEqual(len(word), 2)
            self.assertIn(row['text'], word)
            actual = review.sounds(word)
            self.assertEqual(actual, row['wordEvidence']['pinyin'])
            self.assertEqual(row['wordEvidence']['characterReadings'], [review.all_readings(char) for char in word])
            for index, char in enumerate(word):
                self.assertIn(actual[index], row['wordEvidence']['characterReadings'][index])
                if char == row['text']:
                    self.assertEqual(actual[index], row['pinyin'])
            self.assertEqual(row['readingText'], f'{row["text"]}，{word}的{row["text"]}')
            self.assertNotEqual(row['readingText'], row['originalReadingText'])
            evidence = review.word_evidence(word, row['text'], row['pinyin'], CONTENT)
            self.assertEqual(evidence, row['wordEvidence'])
            if evidence.get('originalSource') == 'pypinyin-phrase-dictionary-component':
                self.assertIn(word, evidence['phrase'])
                self.assertIn(evidence['phrase'], phrases_dict)

    def test_missing_and_confirmed_chong(self):
        missing = [row for row in self.records if row['originalKind'] == 'missing']
        self.assertEqual(len(missing), 1)
        row = missing[0]
        self.assertEqual((row['text'], row['pinyin'], row['contextWord'], row['readingText']), ('旋', 'xuàn', '旋风', '绚，旋风的绚'))
        self.assertIsNone(row['originalCacheKey'])
        self.assertRegex(row['skippedCacheKey'], r'^[a-f0-9]{64}$')
        chong = next(row for row in self.records if row['text'] == '冲' and row['status'] == 'rejected')
        self.assertEqual((chong['pinyin'], chong['readingText']), ('chòng', '冲劲'))
        self.assertIn('用户明确确认', chong['pronunciationAuthority'])

    def test_non_dictionary_sources_have_explicit_authorization_or_draft(self):
        exceptions = [row for row in self.records if row.get('selectionStatus')]
        self.assertTrue(exceptions)
        if self.data['decisionStatus'] == 'draft':
            self.assertFalse(self.data['provenance']['compositionalCommonWordsAuthorized'])
            self.assertTrue(all(row['selectionStatus'] == 'pending-source-approval' for row in exceptions))
        else:
            self.assertTrue(self.data['provenance']['compositionalCommonWordsAuthorized'])
            self.assertTrue(all(row['selectionStatus'] == 'confirmed' for row in exceptions))

    def test_coordinator_decisions_are_active_and_sources_are_honest(self):
        self.assertEqual(self.data['decisionStatus'], 'ready')
        self.assertTrue(self.data['provenance']['compositionalCommonWordsAuthorized'])
        manual = [row for row in self.records if row.get('selectionStatus')]
        self.assertEqual(len(manual), 21)  # Original 17 exceptions plus four explicit replacements.
        for row in manual:
            self.assertEqual(row['selectionStatus'], 'confirmed')
            self.assertEqual(row['wordEvidence']['source'], '人工审定')
            self.assertTrue(row['wordEvidence']['originalSource'])
        for char, word in {'摸': '抚摸', '歪': '歪斜', '舱': '船舱', '钟': '钟表'}.items():
            row = next(row for row in self.records if row['text'] == char and row['status'] == 'rejected')
            self.assertEqual(row['contextWord'], word)
            self.assertEqual(row['selectionBasis'], '协调者指定儿童用词')

    def test_generator_gates_unapproved_source_exceptions(self):
        # Minimal reconstructed input proves the CLI's source-exception gate
        # without relying on private listening files or the ignored audio cache.
        rec = next(row for row in self.records if row['text'] == '喵')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            results = {rec['originalCacheKey']: {'kind': 'single', 'mark': 'bad', 'text': '喵', 'pinyin': 'miāo', 'readingText': '喵'}}
            plan = {'entries': [{'id': rec['entryIds'][0], 'text': '喵', 'kind': 'character', 'cacheKey': rec['originalCacheKey'], 'expectedPinyin': 'miāo'}]}
            listening = {'single': [{'key': rec['originalCacheKey']}], 'poly': []}
            for name, data in [('results', results), ('plan', plan), ('listening', listening)]:
                (root / name).write_text(json.dumps(data))
            args = (root / 'results', root / 'plan', root / 'listening', CONTENT)
            with self.assertRaisesRegex(ValueError, 'authorization required'):
                review.generate(*args)
            authorized = review.generate(*args, allow_compositional=True)
            self.assertEqual(authorized['decisionStatus'], 'ready')
            self.assertEqual(authorized['records'][0]['selectionStatus'], 'confirmed')

    def test_markdown_has_all_43_poly_and_55_single_rows(self):
        report = review.report(self.data)
        self.assertEqual((CONTENT / 'tts-listening-review.md').read_text(), report)
        self.assertEqual(len([line for line in report.splitlines() if line.startswith('| ')]), 138)

    def test_round2_locks_and_exact_coordinator_proposals(self):
        data = self.round2_data
        self.assertEqual(data['round2Stats'], {'approved': 83, 'rejected': 14, 'pending': 1,
                         'appliedRewrites': 14, 'blockedRewrites': 0, 'lockedApprovedTotal': 294})
        rewrites = []
        for row in data['records']:
            state = row.get('round2')
            if not state:
                self.assertEqual(row['status'], 'approved')
                continue
            self.assertRegex(state['cacheKey'], r'^[a-f0-9]{64}$')
            if state['status'] in ('approved', 'pending'):
                self.assertEqual(row['readingText'], state['readingText'])
                self.assertNotIn('round2Rewrite', row)
                if state['status'] == 'pending':
                    self.assertEqual((row['text'], row['pinyin'], row['readingText']), ('冲', 'chòng', '冲劲'))
            else:
                rewrite = row['round2Rewrite']
                rewrites.append((row['text'], row['pinyin']))
                text, substitute = review.ROUND2_REWRITES[(row['text'], row['pinyin'])]
                self.assertEqual((rewrite['readingText'], rewrite['substitute']), (text, substitute))
                readings = review.all_readings(substitute) if substitute else []
                self.assertEqual(rewrite['substituteReadings'], readings)
                valid = not substitute or readings == [row['pinyin']]
                self.assertEqual(rewrite['applied'], valid)
                self.assertEqual(rewrite['validationStatus'], 'passed' if valid else 'failed')
                self.assertEqual(row['readingText'], text if valid else state['readingText'])
            if row['text'] in '粘涨爪钻':
                self.assertEqual(row['currentKind'], 'poly')
                self.assertEqual(row['characterReadings'], review.all_readings(row['text']))
                self.assertGreater(len(row['characterReadings']), 1)
        self.assertEqual(set(rewrites), review.ROUND2_REWRITES.keys())
        self.assertEqual(data['round2ValidationFailures'], [])
        for char, expected, substitute, text in [
                ('粘', 'zhān', '瞻', '瞻，瞻贴的瞻'),
                ('爪', 'zhǎo', '沼', '沼，前沼的沼')]:
            row = next(row for row in data['records'] if (row['text'], row['pinyin']) == (char, expected))
            self.assertEqual(review.all_readings(substitute), [expected])
            self.assertEqual(row['round2Rewrite']['substitute'], substitute)
            self.assertEqual(row['readingText'], text)
        self.assertIn('只用于生成音频', data['audioOnlyReadingText'])

    def test_round2_rebuild_and_reject_mismatched_evidence(self):
        prior = copy.deepcopy(self.round2_data)
        prior.pop('round2Stats')
        prior.pop('round2ValidationFailures')
        prior.pop('audioOnlyReadingText')
        prior['provenance'].pop('round2')
        listening, results = {'poly': [], 'single': [], 'missing': []}, {}
        for row in prior['records']:
            state = row.pop('round2', None)
            if not state:
                continue
            row['readingText'] = state['readingText']
            row.pop('round2Rewrite', None)
            row.pop('currentKind', None)
            row.pop('characterReadings', None)
            listening[row['kind']].append({'text': row['text'], 'pinyin': row['pinyin'],
                                          'key': state['cacheKey'], 'readingText': state['readingText']})
            if state['status'] != 'pending':
                results[state['cacheKey']] = {'text': row['text'], 'pinyin': row['pinyin'],
                    'readingText': state['readingText'], 'note': state['note'],
                    'mark': 'ok' if state['status'] == 'approved' else 'bad'}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            rpath, lpath = root / 'results.json', root / 'listening.json'
            rpath.write_text(json.dumps(results))
            lpath.write_text(json.dumps(listening))
            rebuilt = review.apply_round2(prior, rpath, lpath)
            self.assertEqual(rebuilt['records'], self.round2_data['records'])
            self.assertEqual(rebuilt['round2Stats'], self.round2_data['round2Stats'])
            with self.assertRaisesRegex(ValueError, 'pre-round-2'):
                review.apply_round2(rebuilt, rpath, lpath)
            first = next(iter(results))
            results[first]['readingText'] = '录音与结论不匹配'
            rpath.write_text(json.dumps(results))
            with self.assertRaisesRegex(ValueError, 'does not match recording'):
                review.apply_round2(prior, rpath, lpath)

    def test_round3_locks_and_textbook_quantity_context(self):
        self.assertEqual(self.round3_data['round3Stats'], {'approved': 10, 'rejected': 1, 'pending': 3, 'appliedRewrites': 1,
                         'blockedRewrites': 0, 'lockedApprovedTotal': 304,
                         'resultsFileApproved': 10, 'userSummaryApproved': 0})
        targets = [row for row in self.round3_data['records'] if 'round3' in row]
        self.assertEqual(len(targets), 14)
        self.assertEqual({row['text'] for row in targets if row['round3']['confirmationSource'] == 'unmarked'},
                         {'缤', '喵', '汪'})
        for row in targets:
            self.assertEqual(row['round3']['readingText'], row['round2Rewrite']['readingText'])
            self.assertRegex(row['round3']['cacheKey'], r'^[a-f0-9]{64}$')
            if row['round3']['status'] == 'approved':
                self.assertEqual(row['readingText'], row['round3']['readingText'])
                self.assertNotIn('round3Rewrite', row)
            elif row['round3']['status'] == 'pending':
                self.assertEqual(row['round3']['confirmationSource'], 'unmarked')
                self.assertEqual(row['readingText'], row['round3']['readingText'])
            else:
                self.assertEqual((row['text'], row['pinyin'], row['readingText']), ('乘', 'shèng', '剩，一剩轿子的剩'))
                rewrite = row['round3Rewrite']
                self.assertEqual(rewrite['substituteReadings'], review.all_readings('剩'))
                self.assertEqual(rewrite['substituteReadings'], ['shèng'])
                self.assertEqual(rewrite['contextWord'], '一乘轿子')
                evidence = rewrite['sourceEvidence']
                self.assertEqual(evidence['lessonTitle'], '一幅名扬中外的画')
                self.assertIn('一乘轿子', evidence['quote'])
                self.assertEqual(evidence['sourceSha256'], review.sha(CONTENT / 'chinese-g3down-2026.json'))

    def test_round3_rebuild_never_infers_unmarked_approval_and_requires_exact_recordings(self):
        listening, results = {'poly': [], 'single': [], 'missing': []}, {}
        for row in self.data['records']:
            state = row.get('round3')
            if not state:
                continue
            recording = {'key': state['cacheKey'], 'text': row['text'], 'pinyin': row['pinyin'],
                         'readingText': state['readingText']}
            listening[row.get('currentKind', row['kind'])].append(recording)
            if state['confirmationSource'] == 'results-file':
                results[state['cacheKey']] = {**recording, 'mark': 'ok' if state['status'] == 'approved' else 'bad',
                                              'note': state['note']}
        with tempfile.TemporaryDirectory() as temp:
            rpath, lpath = Path(temp) / 'results.json', Path(temp) / 'listening.json'
            rpath.write_text(json.dumps(results))
            lpath.write_text(json.dumps(listening))
            rebuilt = review.apply_round3(self.round2_data, rpath, lpath, CONTENT)
            legacy_flag = review.apply_round3(self.round2_data, rpath, lpath, CONTENT, confirm_unmarked=True)
            self.assertEqual(legacy_flag, rebuilt)
            self.assertEqual(rebuilt['records'], self.round3_data['records'])
            self.assertEqual(rebuilt['round3Stats'], self.data['round3Stats'])
            with self.assertRaisesRegex(ValueError, 'pre-round-3'):
                review.apply_round3(rebuilt, rpath, lpath, CONTENT, True)
            next(iter(results.values()))['readingText'] = '与实际录音不符'
            rpath.write_text(json.dumps(results))
            with self.assertRaisesRegex(ValueError, 'does not match recording'):
                review.apply_round3(self.round2_data, rpath, lpath, CONTENT, True)


    def test_round4_rebuild_and_unmarked_remain_pending(self):
        listening, results, confirmations = {'poly': [], 'single': [], 'missing': []}, {}, {}
        for row in self.round4_data['records']:
            state = row.get('round4')
            if not state:
                continue
            recording = {'key': state['cacheKey'], 'text': row['text'], 'pinyin': row['pinyin'],
                         'readingText': state['readingText']}
            listening[row.get('currentKind', row['kind'])].append(recording)
            if state['confirmationSource'] == 'results-file':
                results[state['cacheKey']] = {**recording, 'mark': 'ok' if state['status'] == 'approved' else 'bad',
                                              'note': state['note']}
            else:
                confirmations[state['cacheKey']] = {key: value for key, value in state.items()
                    if key in ('status', 'readingText', 'note')}
                confirmations[state['cacheKey']].update(text=row['text'], pinyin=row['pinyin'])
        with tempfile.TemporaryDirectory() as temp:
            rpath, lpath = Path(temp) / 'results.json', Path(temp) / 'listening.json'
            rpath.write_text(json.dumps(results))
            lpath.write_text(json.dumps(listening))
            rebuilt = review.apply_round4(self.round3_data, rpath, lpath, confirmations)
            self.assertEqual(rebuilt['records'], self.round4_data['records'])
            self.assertEqual(rebuilt['round4Stats'], {'approved': 4, 'rejected': 1, 'lockedApprovedTotal': 308})
            pending = review.apply_round4(self.round3_data, rpath, lpath)
            chong = next(row for row in pending['records'] if row['text'] == '冲' and row.get('round4'))
            self.assertEqual(chong['round4']['status'], 'pending')
            self.assertEqual(pending['round4Stats']['lockedApprovedTotal'], 307)
            for row in rebuilt['records']:
                if row.get('round4'):
                    self.assertEqual(row['readingText'], row['round4']['readingText'])
            miao = next(row for row in rebuilt['records'] if row['text'] == '喵')
            self.assertEqual((miao['round3']['status'], miao['round4']['status'], miao['readingText']),
                             ('pending', 'rejected', '喵喵'))
            with self.assertRaisesRegex(ValueError, 'pre-round-4'):
                review.apply_round4(rebuilt, rpath, lpath, confirmations)
            invalid = copy.deepcopy(confirmations)
            next(iter(invalid.values()))['note'] = ''
            with self.assertRaisesRegex(ValueError, 'exact recording and evidence'):
                review.apply_round4(self.round3_data, rpath, lpath, invalid)
            next(iter(results.values()))['readingText'] = '录音不匹配'
            rpath.write_text(json.dumps(results))
            with self.assertRaisesRegex(ValueError, 'does not match recording'):
                review.apply_round4(self.round3_data, rpath, lpath, confirmations)

    def test_round5_selects_approved_candidate_and_preserves_every_prior_decision(self):
        changed = []
        for prior, current in zip(self.round4_data['records'], self.data['records']):
            if prior != current:
                changed.append(current)
        self.assertEqual([row['text'] for row in changed], ['喵'])
        row = changed[0]
        self.assertEqual(row['readingText'], '小猫喵喵叫')
        self.assertEqual(row['round4']['status'], 'rejected')
        self.assertEqual(row['round4']['readingText'], '喵喵')
        state = review.latest_state(row)
        self.assertEqual(state['status'], 'approved')
        self.assertEqual(state['readingText'], row['readingText'])
        self.assertEqual(state['cacheKey'], 'da511fa5c66f63640ed518068bf9f9d595ae76aab87150bbee89995e9913ca86')
        self.assertEqual(state['confirmationSource'], 'user-round5-confirmation')
        self.assertEqual(state['acceptedCandidates'], [1, 2])
        self.assertEqual(state['selectedCandidate'], 1)
        self.assertEqual(sum(review.latest_state(r)['status'] == 'approved' for r in self.data['records']), 309)
        provenance = self.data['provenance']['round5']
        self.assertEqual(provenance['userQuote'], '2 和 1 都行')
        candidates = provenance['candidates']
        self.assertEqual([c['status'] for c in candidates], ['approved', 'approved', 'rejected', 'rejected'])
        self.assertEqual((candidates[0]['readingText'], candidates[0]['cacheKey']), (state['readingText'], state['cacheKey']))
        retained = review.load(CONTENT / 'tts-candidates.json')['entries'][row['entryIds'][0]]
        self.assertEqual(retained, [c['readingText'] for c in candidates])
        self.assertEqual((CONTENT / 'tts-listening-review.md').read_text(), review.report(self.data))
        self.assertIn('累计 309 条已锁定', review.report(self.data))

    def test_round4_preserves_all_prior_approved_records_and_corrects_inference(self):
        for prior, current in zip(self.round3_data['records'], self.round4_data['records']):
            if review.latest_state(prior)['status'] == 'approved':
                self.assertEqual(prior, current)
        self.assertEqual(sum(review.latest_state(row)['status'] == 'approved' for row in self.round4_data['records']), 308)
        self.assertEqual(self.round4_data['provenance']['round3']['unmarkedPending'], ['喵', '汪', '缤'])
        self.assertNotIn('unmarkedApprovedByUserSummary', self.round4_data['provenance']['round3'])
        self.assertIn('推断为 approved 是错误', review.report(self.round4_data))


if __name__ == '__main__':
    unittest.main()
