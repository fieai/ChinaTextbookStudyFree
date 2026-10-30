#!/usr/bin/env python3
"""Rebuild offline listening decisions; never writes audio caches.

Run with .local/tools/pinyin-venv/bin/python and explicit --results, --plan,
--listening-data arguments. Human word/substitute choices live below; the input
recordings and plan remain evidence, not defaults tied to one machine.
"""
import argparse
import copy
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

import pypinyin
from pypinyin import Style, pinyin
from pypinyin.phrases_dict import phrases_dict

SUBSTITUTES = {
    '假': '架', '相': '香', '弹': '蛋', '少': '绍', '骨': '姑', '处': '楚',
    '劲': '进', '参': '深', '兴': '星', '角': '决', '担': '丹', '还': '环',
    '禁': '今', '散': '伞', '蚂': '骂', '为': '围', '折': '遮', '称': '衬',
    '撒': '仨', '累': '蕾', '鲜': '显', '乘': '剩', '系': '季', '和': '货',
    '屏': '饼', '旋': '绚',
}
# These everyday words were selected manually for meaning, length and sound.
SINGLE_WORDS = dict(zip(
    '荒萧深粘缤挖眯喵孵钻婚汪丫宫舱鹦插跟浸刮楚司皆登欧鸳鸯泼翩瞎耕伸逼追滔遵尊胞殊稍摊掏嗓拨颠婴钟汹洼歪爪摸爹聪涨',
    '荒地 萧萧 深浅 粘贴 缤纷 挖土 眯眼 喵喵 孵化 钻洞 结婚 汪汪 枝丫 王宫 船舱 鹦鹉 插头 跟上 浸泡 刮风 楚王 司令 皆知 登台 北欧 鸳鸯 鸳鸯 泼洒 翩翩 瞎说 耕地 伸长 逼迫 追赶 滔天 遵从 尊重 同胞 特殊 稍微 摊子 掏出 嗓子 拨号 颠倒 婴儿 钟表 汹涌 洼地 歪斜 前爪 抚摸 阿爹 聪明 涨红'.split(),
))
COORDINATOR_WORDS = {'摸': '抚摸', '歪': '歪斜', '舱': '船舱', '钟': '钟表'}
ROUND2_REWRITES = {
    ('劲', 'jìn'): ('进，使进的进', '进'),
    ('模', 'mú'): ('一模一样', None),
    ('累', 'lěi'): ('垒，积垒的垒', '垒'),
    ('乘', 'shèng'): ('剩，剩下的剩', '剩'),
    ('系', 'jì'): ('季，季鞋带的季', '季'),
    ('和', 'huò'): ('货，货弄的货', '货'),
    ('屏', 'bǐng'): ('饼，饼住的饼', '饼'),
    ('粘', 'zhān'): ('瞻，瞻贴的瞻', '瞻'),
    ('缤', 'bīn'): ('缤纷', None),
    ('喵', 'miāo'): ('喵喵', None),
    ('钻', 'zuān'): ('钻洞的钻', None),
    ('汪', 'wāng'): ('汪汪', None),
    ('爪', 'zhǎo'): ('沼，前沼的沼', '沼'),
    ('涨', 'zhàng'): ('账，账红的账', '账'),
}


def sounds(text):
    return [row[0] for row in pinyin(text, style=Style.TONE, heteronym=False)]


def all_readings(char):
    return pinyin(char, style=Style.TONE, heteronym=True)[0]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text())


def word_evidence(word, char, expected, content_dir):
    actual = sounds(word)
    character_readings = [all_readings(c) for c in word]
    if (len(word) != 2 or len(actual) != 2 or char not in word
            or any(sound not in readings for sound, readings in zip(actual, character_readings))
            or any(actual[i] != expected for i, c in enumerate(word) if c == char)):
        raise ValueError(f'Incorrect two-character context: {char} {expected}: {word} {actual}')
    evidence = {'pinyin': actual, 'characterReadings': character_readings, 'pypinyinVersion': pypinyin.__version__}
    # Record actual sources, including full dictionary phrases when extracting
    # a familiar two-character component (e.g. 缤纷 from 落英缤纷).
    candidates = load(content_dir / 'tts-context-candidates.json')
    for lesson_id, lesson in candidates['lessons'].items():
        for candidate in lesson['characters'].get(char, {}).get('candidates', []):
            if candidate['word'] == word and candidate.get('pinyin') == actual:
                return {**evidence, 'source': 'tts-context-candidates', 'lessonId': lesson_id, 'candidateSource': candidate['source']}
    table_books = load(content_dir / 'character-tables.json')['books']
    table_books += [load(path) for path in sorted((content_dir / 'tables').glob('*.json'))]
    for book in table_books:
        for lesson in book['lessons']:
            for item in lesson.get('words', []):
                if item.get('text') == word:
                    return {**evidence, 'source': 'textbook-word-table', 'sourceBookId': book['bookId'], 'lessonNumber': lesson['lessonNumber']}
    if word in phrases_dict:
        return {**evidence, 'source': 'pypinyin-phrase-dictionary', 'phrase': word}
    containing = [phrase for phrase in phrases_dict if word in phrase]
    if containing:
        phrase = min(containing, key=lambda value: (len(value), value))
        return {**evidence, 'source': '人工审定', 'originalSource': 'pypinyin-phrase-dictionary-component', 'phrase': phrase}
    for path in sorted(content_dir.glob('chinese-*.json')):
        book = load(path)
        for lesson in book['lessons']:
            for item in lesson.get('words', []):
                if word in item.get('text', ''):
                    return {**evidence, 'source': '人工审定', 'originalSource': 'textbook-word-table-component', 'word': item['text'], 'sourceBookId': book['bookId'], 'lessonNumber': lesson['lessonNumber']}
    occurrence = None
    for path in sorted(content_dir.glob('chinese-*.json')):
        book = load(path)
        for lesson in book['lessons']:
            if any(word in paragraph.get('text', '') for paragraph in lesson.get('paragraphs', [])):
                occurrence = {'sourceBookId': book['bookId'], 'lessonNumber': lesson['lessonNumber']}
                break
        if occurrence:
            break
    return {**evidence, 'source': '人工审定', 'originalSource': 'reviewed-common-word-compositional-pinyin', 'textbookBodyOccurrence': occurrence}


def substitute_evidence(char, content_dir):
    occurrences = []
    for path in sorted(content_dir.glob('chinese-*.json')):
        book = load(path)
        for lesson in book['lessons']:
            fields = ('recognitionCharacters', 'writingCharacters')
            if any(item.get('char') == char for field in fields for item in lesson.get(field, [])):
                occurrences.append({'sourceBookId': book['bookId'], 'lessonNumber': lesson['lessonNumber'], 'source': 'textbook-character-table'})
            elif any(char in item.get('text', '') for item in lesson.get('paragraphs', [])):
                occurrences.append({'sourceBookId': book['bookId'], 'lessonNumber': lesson['lessonNumber'], 'source': 'textbook-body'})
    occurrences.sort(key=lambda row: (int(re.search(r'-g(\d)', row['sourceBookId'])[1]), row['sourceBookId'], row['lessonNumber']))
    return {'selection': 'human-reviewed-common-character', 'earliestTextbookOccurrence': occurrences[0] if occurrences else None,
            'reason': '优先一二年级教材常用字；无早期同音字时选常用字，排除pypinyin多音字和生僻字。'}


def generate(results_path, plan_path, listening_path, content_dir, allow_compositional=False, draft=False):
    results, plan, listening = load(results_path), load(plan_path), load(listening_path)
    originals = {row['key']: row for kind in ('poly', 'single') for row in listening[kind]}
    records = []
    for key, review in results.items():
        missing = review['kind'] == 'missing'
        if missing:
            entries = [entry for entry in plan['entries'] if entry.get('kind') == 'character' and entry['text'] == review['text'] and entry.get('expectedPinyin') == review['pinyin'] and entry.get('skipped')]
            if len(entries) != 1:
                raise ValueError('Expected exactly one missing 旋 xuàn entry')
            entry = entries[0]
            old_text, old_key, context = entry['readingText'], None, '旋风'
        else:
            entries = [entry for entry in plan['entries'] if entry.get('kind') == 'character' and entry.get('cacheKey') == key]
            old_text, old_key = review['readingText'], key
            context = originals[key].get('context')
        if not entries:
            raise ValueError(f'No character entry for {key}')
        rec = {'text': review['text'], 'pinyin': review.get('pinyin'), 'originalReadingText': old_text,
               'originalCacheKey': old_key, 'status': 'approved' if review.get('mark') == 'ok' else 'rejected',
               'note': review.get('note', ''), 'kind': 'poly' if missing else review['kind'],
               'entryIds': [entry['id'] for entry in entries], 'readingText': old_text,
               'contextWord': context, 'substitute': None, 'substituteReadings': [], 'wordEvidence': None,
               'originalWhere': review.get('where'), 'originalKind': review['kind']}
        if missing:
            rec['skippedCacheKey'] = entries[0]['cacheKey']
        missing_pinyin = [entry['id'] for entry in entries if not entry.get('expectedPinyin')]
        if missing_pinyin:
            rec['entryIdsWithoutExpectedPinyin'] = missing_pinyin
        if rec['status'] == 'rejected' and rec['kind'] == 'poly':
            substitute = SUBSTITUTES.get(rec['text'])
            if substitute:
                readings = all_readings(substitute)
                if readings != [rec['pinyin']]:
                    raise ValueError(f'Invalid substitute {substitute}: {readings} != {rec["pinyin"]}')
                rec.update(substitute=substitute, substituteReadings=readings,
                           readingText=f'{substitute}，{context}的{substitute}',
                           substituteEvidence=substitute_evidence(substitute, content_dir))
            else:
                rec.update(readingText=context, fallbackReason='轻声只能整词朗读' if rec['pinyin'] == 'bei' else '未找到读音唯一且常见、适合儿童的同音替身字，保留整词语境。')
            if rec['text'] == '冲':
                rec['pronunciationAuthority'] = '用户明确确认：冲劲的冲读chòng；试听note仅描述旧音频，不覆盖期望拼音。'
            if missing:
                rec['wordEvidence'] = {'source': 'user-confirmed-context', 'word': '旋风', 'pinyin': sounds('旋风')}
        elif rec['status'] == 'rejected':
            word = SINGLE_WORDS[rec['text']]
            evidence = word_evidence(word, rec['text'], rec['pinyin'], content_dir)
            rec.update(contextWord=word, readingText=f'{rec["text"]}，{word}的{rec["text"]}', wordEvidence=evidence)
            if evidence['source'] not in ('pypinyin-phrase-dictionary', 'tts-context-candidates', 'textbook-word-table'):
                rec['selectionStatus'] = 'confirmed' if allow_compositional else 'pending-source-approval'
                rec['selectionBasis'] = '协调者指定儿童用词' if COORDINATOR_WORDS.get(rec['text']) == word else '协调者批准选词来源例外'
        records.append(rec)
    pending = [record for record in records if record.get('selectionStatus') == 'pending-source-approval']
    if pending and not draft:
        raise ValueError('Explicit --allow-compositional-common-words authorization required for: ' + '、'.join(record['contextWord'] for record in pending))
    counts = Counter(record['status'] for record in records)
    return {'schemaVersion': 1, 'decisionStatus': 'draft' if pending else 'ready', 'generator': {'name': 'tts_listening_review.py', 'version': '1.0.0', 'pypinyinVersion': pypinyin.__version__},
            'provenance': {'resultsSha256': sha(results_path), 'originalPlanSha256': sha(plan_path), 'originalListeningDataSha256': sha(listening_path),
                           'review': '用户人工试听第一轮；按cacheKey去重；新读法尚未试听。', 'compositionalCommonWordsAuthorized': allow_compositional},
            'stats': {'approved': counts['approved'], 'rejected': counts['rejected'], 'rejectedPoly': sum(r['status']=='rejected' and r['kind']=='poly' for r in records),
                      'rejectedSingle': sum(r['status']=='rejected' and r['kind']=='single' for r in records),
                      'wholeWordFallback': sum('fallbackReason' in r for r in records)}, 'records': records}


def apply_round2(prior, results_path, listening_path):
    """Apply only valid coordinator rewrites; retain failed proposals verbatim.

    First-round fields remain historical evidence. round2.readingText/cacheKey
    identify the actual recording reviewed, including the unmarked 冲劲.
    """
    data = copy.deepcopy(prior)
    if any('round2' in row for row in data['records']):
        raise ValueError('Round 2 must start from the pre-round-2 decision file')
    results, listening = load(results_path), load(listening_path)
    originals = {}
    for kind in ('poly', 'single'):
        for row in listening[kind]:
            identity = (row['text'], row['pinyin'], row['readingText'])
            if identity in originals:
                raise ValueError(f'Duplicate listening identity: {identity}')
            originals[identity] = row
    if Counter(row['mark'] for row in results.values()) != {'ok': 83, 'bad': 14}:
        raise ValueError('Expected exactly 83 ok and 14 bad round-2 results')
    bad = {(row['text'], row['pinyin']) for row in results.values() if row['mark'] == 'bad'}
    if bad != ROUND2_REWRITES.keys():
        raise ValueError('Round-2 bad readings differ from the 14 coordinator choices')
    consumed, blocked, states = set(), [], Counter()
    for row in data['records']:
        if row['status'] == 'approved':
            continue
        identity = (row['text'], row['pinyin'])
        old = originals.get((*identity, row['readingText']))
        if not old or old['readingText'] != row['readingText']:
            raise ValueError(f'Round-2 recording does not match prior decision: {identity}')
        key = old['key']
        if not re.fullmatch(r'[a-f0-9]{64}', key):
            raise ValueError(f'Invalid round-2 cache key: {identity}')
        result = results.get(key)
        if result:
            if ((result['text'], result['pinyin']) != identity
                    or result['readingText'] != old['readingText']):
                raise ValueError(f'Round-2 result does not match recording: {identity}')
            consumed.add(key)
        elif identity != ('冲', 'chòng'):
            raise ValueError(f'Unexpected unmarked round-2 recording: {identity}')
        status = {'ok': 'approved', 'bad': 'rejected'}.get(result['mark']) if result else 'pending'
        row['round2'] = {'status': status, 'readingText': old['readingText'], 'cacheKey': key,
                         'note': result.get('note', '') if result else '第二轮未标记，保持原状待定。'}
        states[status] += 1
        if identity[0] in '粘涨爪钻':
            row['currentKind'] = 'poly'
            row['characterReadings'] = all_readings(row['text'])
        if status != 'rejected':
            continue
        text, substitute = ROUND2_REWRITES[identity]
        readings = all_readings(substitute) if substitute else []
        valid = not substitute or readings == [row['pinyin']]
        row['round2Rewrite'] = {
            'readingText': text, 'substitute': substitute, 'substituteReadings': readings,
            'pypinyinVersion': pypinyin.__version__, 'validationStatus': 'passed' if valid else 'failed',
            'applied': valid, 'selection': 'coordinator-exact-reading-text',
        }
        if valid:
            row['readingText'] = text
        else:
            blocked.append({'text': row['text'], 'pinyin': row['pinyin'], 'substitute': substitute,
                            'readings': readings, 'proposedReadingText': text})
    if consumed != set(results) or states != {'approved': 83, 'rejected': 14, 'pending': 1}:
        raise ValueError('Round-2 results must cover exactly the 98 prior rejected recordings')
    data['audioOnlyReadingText'] = 'readingText 只用于生成音频，孩子看到的字、词不变。'
    data['provenance']['round2'] = {
        'resultsSha256': sha(results_path), 'listeningDataSha256': sha(listening_path),
        'review': '第二轮人工试听，按 cacheKey 对应实际录音；ok 与第一轮 approved 同等锁定；冲劲未标记待定。',
    }
    data['round2Stats'] = {**states, 'appliedRewrites': 14 - len(blocked), 'blockedRewrites': len(blocked),
                           'lockedApprovedTotal': 211 + states['approved']}
    data['round2ValidationFailures'] = blocked
    return data


def apply_round3(prior, results_path, listening_path, content_dir, confirm_unmarked=False):
    """Unlisted recordings stay pending; the legacy confirmation flag has no effect."""
    data = copy.deepcopy(prior)
    if any('round3' in row for row in data['records']):
        raise ValueError('Round 3 must start from the pre-round-3 decision file')
    results, listening = load(results_path), load(listening_path)
    recordings = {row['key']: row for kind in ('poly', 'single') for row in listening[kind]}
    if len(recordings) != 14 or len(listening['poly']) + len(listening['single']) != 14:
        raise ValueError('Expected exactly 14 unique round-3 recordings')
    targets = [row for row in data['records'] if row.get('round2Rewrite', {}).get('applied')]
    if len(targets) != 14 or not set(results) <= recordings.keys():
        raise ValueError('Round-3 results differ from the 14 prior rewrites')
    unmarked, consumed = [], set()
    for row in targets:
        matches = [old for old in recordings.values() if (old['text'], old['pinyin'], old['readingText'])
                   == (row['text'], row['pinyin'], row['readingText'])]
        if len(matches) != 1:
            raise ValueError('Round-3 recording does not match prior decision')
        old = matches[0]
        key = old['key']
        if not re.fullmatch(r'[a-f0-9]{64}', key) or key in consumed:
            raise ValueError('Invalid or duplicate round-3 cache key')
        consumed.add(key)
        result = results.get(key)
        if result:
            if any(result.get(field) != old[field] for field in ('text', 'pinyin', 'readingText')):
                raise ValueError('Round-3 result does not match recording')
            if result.get('mark') not in ('ok', 'bad'):
                raise ValueError('Invalid round-3 mark')
        else:
            unmarked.append(row['text'])
        status = {'ok': 'approved', 'bad': 'rejected'}[result['mark']] if result else 'pending'
        row['round3'] = {'status': status, 'readingText': old['readingText'], 'cacheKey': key,
                         'note': result.get('note', '') if result else '结果文件未单列，未确认；更正此前依据汇总推断通过的错误。',
                         'confirmationSource': 'results-file' if result else 'unmarked'}
    if consumed != set(recordings) or Counter(row['round3']['status'] for row in targets) != {'approved': 10, 'rejected': 1, 'pending': 3}:
        raise ValueError('Expected 10 approved, one rejected and three pending round-3 recordings')
    rejected = next(row for row in targets if row['round3']['status'] == 'rejected')
    if (rejected['text'], rejected['pinyin']) != ('乘', 'shèng'):
        raise ValueError('Only 乘 shèng may be rejected in round 3')
    readings = all_readings('剩')
    if readings != ['shèng']:
        raise ValueError(f'Invalid substitute 剩: {readings}')
    book_path = content_dir / 'chinese-g3down-2026.json'
    book = load(book_path)
    lesson = next(lesson for lesson in book['lessons'] if lesson['title'] == '一幅名扬中外的画')
    paragraph = next(p['text'] for p in lesson['paragraphs'] if '一乘轿子' in p['text'])
    rejected['round3Rewrite'] = {
        'readingText': '剩，一剩轿子的剩', 'substitute': '剩', 'substituteReadings': readings,
        'pypinyinVersion': pypinyin.__version__, 'validationStatus': 'passed', 'applied': True,
        'selection': 'coordinator-exact-reading-text', 'contextWord': '一乘轿子',
        'sourceEvidence': {'source': 'textbook-body', 'sourceBookId': book['bookId'],
                           'lessonNumber': lesson['lessonNumber'], 'lessonTitle': lesson['title'],
                           'quote': paragraph, 'sourceSha256': sha(book_path)},
        'reason': '用户确认本课“乘”是量词 shèng；词取自课文“一乘轿子”。“剩下的剩”意思不对；替身“剩”仅用于音频。',
    }
    rejected['readingText'] = rejected['round3Rewrite']['readingText']
    data['provenance']['round3'] = {
        'resultsSha256': sha(results_path), 'listeningDataSha256': sha(listening_path),
        'resultsFileCount': len(results), 'unmarkedPending': sorted(unmarked),
        'review': '第三轮结果文件实际为10条ok、1条bad；缤、喵、汪未单列，均未确认。更正此前按汇总推断通过的错误；未出现在结果文件里的条目一律未确认。',
    }
    data['round3Stats'] = {'approved': 10, 'rejected': 1, 'pending': 3, 'appliedRewrites': 1,
                           'blockedRewrites': 0, 'lockedApprovedTotal': data['round2Stats']['lockedApprovedTotal'] + 10,
                           'resultsFileApproved': 10, 'userSummaryApproved': 0}
    return data


def latest_state(row):
    return row.get('round5', row.get('round4', row.get('round3', row.get('round2', row))))


def apply_round4(prior, results_path, listening_path, explicit_confirmations=None):
    """Apply only exact recording marks or separately supplied explicit user evidence."""
    data = copy.deepcopy(prior)
    if any('round4' in row for row in data['records']):
        raise ValueError('Round 4 must start from the pre-round-4 decision file')
    results, listening = load(results_path), load(listening_path)
    recordings = {row['key']: row for kind in ('poly', 'single') for row in listening[kind]}
    if len(recordings) != sum(len(listening[kind]) for kind in ('poly', 'single')):
        raise ValueError('Duplicate round-4 recording cache key')
    explicit_confirmations = explicit_confirmations or {}
    if not set(results) <= recordings.keys() or not set(explicit_confirmations) <= recordings.keys():
        raise ValueError('Round-4 decisions have no matching recording')
    consumed = set()
    for row in data['records']:
        matches = [old for old in recordings.values() if (old['text'], old['pinyin'], old['readingText'])
                   == (row['text'], row['pinyin'], row['readingText'])]
        if not matches:
            continue
        if len(matches) != 1 or latest_state(row)['status'] == 'approved':
            raise ValueError('Round-4 target must be one unapproved prior recording')
        old = matches[0]
        key = old['key']
        if not re.fullmatch(r'[a-f0-9]{64}', key) or key in consumed:
            raise ValueError('Invalid or duplicate round-4 cache key')
        consumed.add(key)
        result = results.get(key)
        confirmation = explicit_confirmations.get(key)
        if result:
            if any(result.get(field) != old[field] for field in ('text', 'pinyin', 'readingText')):
                raise ValueError('Round-4 result does not match recording')
            if result.get('mark') not in ('ok', 'bad'):
                raise ValueError('Invalid round-4 mark')
            status, source, note = {'ok': 'approved', 'bad': 'rejected'}[result['mark']], 'results-file', result.get('note', '')
        elif confirmation:
            if (confirmation.get('status') not in ('approved', 'rejected')
                    or not isinstance(confirmation.get('note'), str) or not confirmation['note'].strip()
                    or any(confirmation.get(field) != old[field] for field in ('text', 'pinyin', 'readingText'))):
                raise ValueError('Explicit round-4 confirmation must name exact recording and evidence')
            status, source, note = confirmation['status'], 'user-round4-confirmation', confirmation['note']
        else:
            status, source, note = 'pending', 'unmarked', '结果文件未单列，未确认。'
        row['round4'] = {'status': status, 'readingText': old['readingText'], 'cacheKey': key,
                         'note': note, 'confirmationSource': source}
    if consumed != set(recordings):
        raise ValueError('Round-4 recording does not match prior decision')
    states = Counter(row['round4']['status'] for row in data['records'] if 'round4' in row)
    data['round4Stats'] = {**states, 'lockedApprovedTotal': sum(latest_state(row)['status'] == 'approved' for row in data['records'])}
    data['provenance']['round4'] = {'resultsSha256': sha(results_path), 'listeningDataSha256': sha(listening_path),
        'resultsFileCount': len(results), 'explicitConfirmations': copy.deepcopy(explicit_confirmations),
        'review': '仅结果文件逐项标记或用户明确指名的本轮确认生效；未列条目保持未确认。喵喵bad，应两个均为第一声；候选选定前不锁定、不改正式readingText。'}
    return data


def report(data):
    if 'round5Stats' in data:
        historical = copy.deepcopy(data)
        historical.pop('round5Stats')
        for row in historical['records']:
            if row.pop('round5', None):
                row['readingText'] = row['round4']['readingText']
        s = data['round5Stats']
        rows = ['# 单字试听决定（第五轮）', '', data['audioOnlyReadingText'], '',
                f'第五轮 {s["approved"]} 条通过并锁定，累计 {s["lockedApprovedTotal"]} 条已锁定。',
                '用户原话：“2 和 1 都行”。用户认可候选 1“小猫喵喵叫”和候选 2“喵喵叫”；协调者选定候选 1。',
                'tts-candidates.json 保留四条候选作为试听历史；正式条目采用第五轮决定，不再待选。', '',
                '| 字 | 期望 | 选定 readingText | 决定 | cacheKey |', '|---|---|---|---|---|']
        for row in data['records']:
            if 'round5' in row:
                state = row['round5']
                rows.append(f'| {row["text"]} | {row["pinyin"]} | {state["readingText"]} | 已通过并锁定 | {state["cacheKey"]} |')
        rows += ['', '正式条目与候选 1 使用同一缓存键规则，直接命中已生成音频；第四轮“喵喵”不通过的记录保留。']
        return '\n'.join(rows) + '\n\n## 第四轮决定历史\n\n' + report(historical)
    if 'round4Stats' in data:
        historical = copy.deepcopy(data)
        historical.pop('round4Stats')
        for row in historical['records']:
            row.pop('round4', None)
        s = data['round4Stats']
        rows = ['# 单字试听决定（第四轮）', '', data['audioOnlyReadingText'], '',
                f'第四轮 {s.get("approved", 0)} 条通过并锁定，{s.get("rejected", 0)} 条不通过，累计 {s["lockedApprovedTotal"]} 条已锁定。',
                '乘（剩，一剩轿子的剩）、缤纷、汪汪来自结果文件 ok；冲劲由用户明确确认读 chòng，现有音频通过。',
                '喵喵 bad，应两个都是第一声。正式 readingText 保持“喵喵”，候选选定前保持 rejected、不锁定。',
                '更正：此前把第三轮未单列的缤、喵、汪推断为 approved 是错误的，三条历史均改为未确认。今后未出现在结果文件的条目一律未确认；明确指名的用户确认单独记录来源。', '',
                '| 字 | 期望 | 本轮试听文本 | 决定 | 来源 |', '|---|---|---|---|---|']
        for row in data['records']:
            if 'round4' in row:
                state = row['round4']
                label = {'approved': '已通过并锁定', 'rejected': '不通过，待候选试听', 'pending': '未确认'}[state['status']]
                rows.append(f'| {row["text"]} | {row["pinyin"]} | {state["readingText"]} | {label} | {state["confirmationSource"]} |')
        return '\n'.join(rows) + '\n\n## 第三轮决定历史（已更正）\n\n' + report(historical)
    if 'round3Stats' in data:
        historical = copy.deepcopy(data)
        historical.pop('round3Stats')
        for row in historical['records']:
            state = row.pop('round3', None)
            row.pop('round3Rewrite', None)
            if state:
                row['readingText'] = state['readingText']
        s = data['round3Stats']
        rows = ['# 单字试听决定（第三轮）', '', data['audioOnlyReadingText'], '',
                f'第三轮 10 条 ok 已锁定，3 条未确认，累计 {s["lockedApprovedTotal"]} 条；乘 bad 的新读法当时仍待试听。',
                '结果文件实际为 11 条（10 ok、1 bad）；未单列的缤、喵、汪均未确认。此前据汇总推断通过有误，已更正。',
                '冲劲（冲 chòng）仍待定。乘 shèng 是本课量词，词取自三下《一幅名扬中外的画》“一乘轿子”；“剩下的剩”意思不对。',
                '新 readingText 为“剩，一剩轿子的剩”；pypinyin 全读音校验：剩只有 shèng，校验通过不代表新音频已试听。', '',
                '| 字 | 期望 | 本轮试听文本 | 决定 | 当前 readingText |', '|---|---|---|---|---|']
        for row in data['records']:
            if 'round3' in row:
                state = {'approved': '已通过并锁定', 'rejected': '已改写，待试听', 'pending': '未确认'}[row['round3']['status']]
                rows.append(f'| {row["text"]} | {row["pinyin"]} | {row["round3"]["readingText"]} | {state} | {row["readingText"]} |')
        return '\n'.join(rows) + '\n\n## 第二轮决定历史\n\n' + report(historical)
    # Keep the first-round report reproducible from its historical decisions.
    historical = copy.deepcopy(data)
    for row in historical['records']:
        if 'round2' in row:
            row['readingText'] = row['round2']['readingText']
    if 'round2Stats' in data:
        s = data['round2Stats']
        rows = ['# 单字试听决定（第二轮）', '', data['audioOnlyReadingText'], '',
                f'第一轮 211 条 approved 与第二轮 83 条 ok 共 {s["lockedApprovedTotal"]} 条锁定；readingText/cacheKey 均保持实际试听版本。',
                '冲劲（冲 chòng）第二轮未标记，原 readingText/cacheKey 不变，保持待定。',
                f'第二轮 14 条 bad 按协调者给定文本逐条校验；已应用 {s["appliedRewrites"]} 条。'
                + (f'{s["blockedRewrites"]} 条替身字校验不通过，保留旧读法等待决定，未自行换字。'
                   if s['blockedRewrites'] else '全部通过校验，待重新试听。'), '',
                'TTS 会误读词内的多音字；本轮通过校验的替身字同时用于词内。粘、涨、爪、钻确为多音字，第一轮 kind 保留为历史分类，currentKind 记为 poly。',
                '新读法尚未人工试听；pypinyin 的唯一读音校验不能代替试听。', '',
                '| 字 | 期望 | 指定 readingText | 替身字全部读音 | 应用情况 |', '|---|---|---|---|---|']
        for row in data['records']:
            rewrite = row.get('round2Rewrite')
            if rewrite:
                readings = ' / '.join(rewrite['substituteReadings']) or '—'
                state = '已应用，待试听' if rewrite['applied'] else '校验失败，未应用'
                rows.append(f'| {row["text"]} | {row["pinyin"]} | {rewrite["readingText"]} | {readings} | {state} |')
        rows += ['', '## 第一轮决定历史', '', report_round1(historical).replace('# 第一轮单字试听修订', '### 第一轮单字试听修订', 1)]
        return '\n'.join(rows)
    return report_round1(data)


def report_round1(data):
    pending_count = sum(r.get('selectionStatus') == 'pending-source-approval' for r in data['records'])
    state = f'当前为未生效草稿，{pending_count} 条选词来源例外待用户确认；生成器禁止应用该草稿。' if pending_count else '决定已生效；协调者批准原 17 条选词来源例外及全部替身字，并指定摸→抚摸、歪→歪斜、舱→船舱、钟→钟表；rejected 的新读法尚未经过第二轮人工试听。'
    rows = ['# 第一轮单字试听修订' + ('（未生效草稿）' if data['decisionStatus'] == 'draft' else ''), '', state, '', '211 条 approved 保持原 readingText 和 cacheKey；98 条 rejected（含补齐旋 xuàn）使用新读法，仍须重新试听。', '',
            '替身字逐一用 pypinyin 0.55.0 的 heteronym=True 验证，必须只有期望的一个含调读音。价含 jià / jie / jiè，故假 jià 使用架。',
            '冲劲的冲按用户确认读 chòng。16 条无合格常见替身或轻声采用整词，未强行使用生僻字。', '',
            '| 字 | 期望拼音 | 替身字 | 替身字全部读音 | 新 readingText |', '|---|---|---|---|---|']
    for r in data['records']:
        if r['status'] == 'rejected' and r['kind'] == 'poly':
            rows.append(f'| {r["text"]} | {r["pinyin"]} | {r["substitute"] or "整词"} | {" / ".join(r["substituteReadings"]) or "—"} | {r["readingText"]} |')
    rows += ['', '## 单字选词', '', '来源按实际情况记录；词组词典组件保留完整原词组，人工常用组合不伪称词典条目。', '',
             '| 字 | 期望拼音 | 词 | 词语拼音 | 来源 | 新 readingText |', '|---|---|---|---|---|---|']
    for r in data['records']:
        if r['status'] == 'rejected' and r['kind'] == 'single':
            e = r['wordEvidence']
            source = {'pypinyin-phrase-dictionary': '词组词典二字词', '人工审定': '人工审定＋逐字校验', 'tts-context-candidates': '已有候选', 'textbook-word-table': '教材词语表'}[e['source']] + (f'（原长词：{e["phrase"]}）' if e.get('originalSource') == 'pypinyin-phrase-dictionary-component' else f'（{e["phrase"]}）' if 'phrase' in e else '')
            if r.get('selectionStatus') == 'pending-source-approval':
                source += '，待确认来源例外'
            rows.append(f'| {r["text"]} | {r["pinyin"]} | {r["contextWord"]} | {" ".join(e["pinyin"])} | {source} | {r["readingText"]} |')
    return '\n'.join(rows) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('results', 'plan', 'listening-data'):
        parser.add_argument('--' + flag, type=Path)
    parser.add_argument('--prior-decisions', type=Path, help='Pre-round-2 decisions; selects round-2 mode')
    parser.add_argument('--round', type=int, choices=(2, 3, 4), default=2)
    parser.add_argument('--confirm-round3-unmarked-from-user-summary', action='store_true',
                        help='Deprecated compatibility flag; unmarked recordings always stay pending')
    parser.add_argument('--explicit-confirmations', type=Path, help='Exact recording confirmations with explicit user evidence for round 4')
    parser.add_argument('--content-dir', type=Path, default=Path(__file__).resolve().parents[2] / 'content' / 'reading-prep')
    parser.add_argument('--draft', action='store_true', help='Produce explicitly inactive draft, including pending source exceptions')
    parser.add_argument('--allow-compositional-common-words', action='store_true', help='Only after user authorizes the explicit source exception')
    args = parser.parse_args()
    if args.prior_decisions:
        if not args.results or not args.listening_data:
            parser.error('Round 2 requires --results and --listening-data')
        if args.round == 4:
            data = apply_round4(load(args.prior_decisions), args.results, args.listening_data,
                                load(args.explicit_confirmations) if args.explicit_confirmations else None)
        elif args.round == 3:
            data = apply_round3(load(args.prior_decisions), args.results, args.listening_data, args.content_dir,
                                args.confirm_round3_unmarked_from_user_summary)
        else:
            data = apply_round2(load(args.prior_decisions), args.results, args.listening_data)
    else:
        if not args.results or not args.plan or not args.listening_data:
            parser.error('Round 1 requires --results, --plan and --listening-data')
        data = generate(args.results, args.plan, args.listening_data, args.content_dir, args.allow_compositional_common_words, args.draft)
    (args.content_dir / 'tts-listening-review.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    (args.content_dir / 'tts-listening-review.md').write_text(report(data))
    print(json.dumps(data.get('round4Stats', data.get('round3Stats', data.get('round2Stats', data['stats']))), ensure_ascii=False))
    for failure in data.get('round2ValidationFailures', []):
        print(f'未应用 {failure["text"]} {failure["pinyin"]}: {failure["substitute"]} = {failure["readings"]}')


if __name__ == '__main__':
    main()
