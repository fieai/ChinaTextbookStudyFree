#!/usr/bin/env python3
"""Offline display-pinyin annotations; never rewrites the curated source books.

Run with .local/tools/pinyin-venv/bin/python -I scripts/reading-prep/annotate_pinyin.py.
Review decisions belong in pinyin-review.json, not the generated annotations.
"""

import argparse
from collections import defaultdict
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import unicodedata

import pypinyin
from pypinyin import Style, pinyin
from pypinyin.core import Pinyin
from pypinyin.phrases_dict import phrases_dict


VERSION = "1.2.0"
CHARACTER_FIELDS = ("recognitionCharacters", "writingCharacters")
WORD_FIELDS = ("words", "supplementalWords")
FIELDS = ("words", *CHARACTER_FIELDS, "supplementalWords")
DEFAULT_BOOKS = ("chinese-g3up-2026", "chinese-g3down-2026")
# Deliberately small: rare heteronyms (园 wán, 花 huá, 领 lǐng/líng, ...)
# are not ambiguity evidence. Additional characters require >=2 textbook/rule readings.
COMMON_POLYPHONIC = set("长行重还得地的着了发好为中种只少数乐觉教便调处空背藏和看相差朝传当倒都分给更假间将降难扇似喝几干没转要兴应答角落场结鲜劲露奇吓闷参作绿解曾磨漂炸舍圈泊量佛尽任待奔号挑系曲撒盛钉斗薄担度铺切散累冲称折乘模恶强禁划弹咽宿血脏率削埋正会")
NEUTRAL_WORDS = set("热闹 明白 衣服 葡萄 月亮 东西 清楚 喜欢 知道 事情 意思 时候 地方 朋友 告诉 窗户 脑袋 眼睛 耳朵 舒服 漂亮 聪明 暖和 关系 休息 学生 先生 太阳 萝卜 尾巴 头发 胳膊 豆腐 玻璃 蘑菇 钥匙 麻烦 商量 打扮 收拾 凉快 热乎 结实 踏实 厚实 力气 客气 脾气 云彩 认识 招呼 葫芦 棉花 丈夫 抬举 姑娘 稀罕 便宜 功夫 工夫 消息 规矩 容易 行李 打量 糊涂 软和 嘀咕 琢磨 寻思 精神 大方 结巴 哈欠 动静 本事 运气 福气 记性 性子 燕子 孩子 儿子 孙子 兔子 狮子 猴子 鸭子 鸽子 蚊子 种子 叶子 果子 桌子 椅子 房子 屋子 村子 日子 影子 样子 个子 身子 肚子 鼻子 脖子 肠子 胆子 脑子 帽子 裤子 袜子 鞋子 被子 杯子 盘子 瓶子 篮子 盒子 袋子 绳子 辫子 刷子 梳子 镜子 句子 调子 步子 担子 石头 木头 骨头 里头 外头 前头 后头 上头 下头 念头 馒头 拳头 我们 你们 他们 她们 它们 咱们 什么 怎么 这么 那么 多么 好的 好了 看着 见过".split())
# Coordinator spot-check of dictionary-only words (2026-10-30): pypinyin gave a
# full tone or a wrong reading for these, so they always go to human review.
NEUTRAL_WORDS |= set("答应 活泼 机灵 痛快 厉害 笑话 指甲 要是 记号 莲蓬 起来".split())
FORCED_REVIEW = {"散发": "词典读音存疑：发 应为 fā"}
NEUTRAL_ENDINGS = set("子头们么的了着过巴处候气实量服西亮朵萄蝠卜匙")
REASON_CATEGORIES = {
    "textbookConflict": "教材冲突",
    "neutralTone": "轻声",
    "yiBuTone": "一不变调",
    "polyphonicUnlisted": "多音未收词",
}
SEGMENTER = Pinyin()
POLICY = {
    "priority": "教材明确拼音 > 人工核对 reviewed > 词典 dictionary；未决条目省略 pinyin。",
    "toneSandhi": "教材词语表的标调惯例尚未确认；含一/不的词合并核对，建议统一按本调 yī / bù 处理。顶层 decision.yiBuToneStyle 填 original（本调）或 sandhi（变调），未决定为 null；不改 TTS 朗读文本。",
    "review": "编辑 pinyin-review.json：逐条 decision 填完整拼音（例如 rè nao）或 hide，可覆盖全局一/不决定；重跑本脚本并重新导出。Markdown 勾选框仅供阅读，JSON decision 才会生效。",
    "fingerprint": "decision 绑定条目、课文/词语上下文、教材已知读音、规则和词典版本；指纹变化的旧决定进入 staleDecisions，不自动沿用。",
    "polyphonicCharacter": "缺注音字优先借同课/同册/九册教材的唯一读音；有多个教材读音时用本课词语词典读音筛选；上下文冲突或无法判断则隐藏。",
    "dictionary": "词组词典已匹配的字不因异读送审；未收词仅检查内置常用多音字和九册教材/规则中实际出现至少两种读音的字。轻声仅认常见词或叠词，词典已标轻声且与规则一致则直接采用。",
}


def normalized(value):
    return unicodedata.normalize("NFC", str(value or "").strip().lower())


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def item_key(item):
    return str(item.get("id") or item.get("text") or item.get("char") or "")


@lru_cache(maxsize=None)
def readings(char):
    result = pinyin(char, style=Style.TONE, heteronym=True, strict=True)
    return tuple(dict.fromkeys(normalized(s) for s in result[0])) if len(result) == 1 else ()


@lru_cache(maxsize=None)
def phrase_readings(text):
    result = pinyin(text, style=Style.TONE, heteronym=False, strict=True)
    if len(result) != len(text) or any(len(row) != 1 or re.search(r"[\u3400-\u9fff]", row[0]) for row in result):
        return ()
    # pypinyin's phrase dictionary sometimes returns surface sandhi (e.g. 不是).
    return tuple("yī" if c == "一" else "bù" if c == "不" else normalized(row[0]) for c, row in zip(text, result))


@lru_cache(maxsize=None)
def phrase_matched_positions(text):
    """Use the very same segmentation as pypinyin; fallback singletons are not hits."""
    positions, offset = set(), 0
    for segment in SEGMENTER.seg(text):
        if len(segment) > 1 and segment in phrases_dict:
            positions.update(range(offset, offset + len(segment)))
        offset += len(segment)
    return frozenset(positions)


def tone_number(sound):
    for number, mark in enumerate(("\u0304", "\u0301", "\u030c", "\u0300"), 1):
        if mark in unicodedata.normalize("NFD", sound):
            return number
    return 0


def yi_bu_readings(text, sounds, style):
    result = list(sounds)
    for index, char in enumerate(text):
        if char not in "一不":
            continue
        result[index] = "yī" if char == "一" else "bù"
        if style != "sandhi":
            continue
        previous = text[index - 1] if index else ""
        following = text[index + 1] if index + 1 < len(text) else ""
        next_tone = tone_number(sounds[index + 1]) if following else 0
        if previous and previous == following:  # 看一看 / 好不好
            result[index] = "yi" if char == "一" else "bu"
        elif char == "不" and next_tone == 4:
            result[index] = "bú"
        elif char == "一" and previous != "第" and following not in "一二三四五六七八九零〇":
            if next_tone:
                result[index] = "yí" if next_tone == 4 else "yì"
    return tuple(result)


def build_known(books, rules):
    lesson_known, book_known, all_known = defaultdict(lambda: defaultdict(set)), defaultdict(lambda: defaultdict(set)), defaultdict(set)
    for book in books:
        bid = book["bookId"]
        for lesson in book["lessons"]:
            for field in CHARACTER_FIELDS:
                for item in lesson.get(field, []):
                    char, sound = item.get("char"), normalized(item.get("pinyin"))
                    if char and sound:
                        lesson_known[(bid, str(lesson["lessonNumber"]))][char].add(sound)
                        book_known[bid][char].add(sound)
                        all_known[char].add(sound)
    # Rules provide known possible readings, not evidence that an entire word
    # was explicitly printed with pinyin in the textbook.
    for char, variants in rules.get("polyphonicContexts", {}).items():
        all_known[char].update(normalized(sound) for sound in variants)
    return lesson_known, book_known, all_known


def word_analysis(text, known, rules, common_polyphonic=None):
    proposed = phrase_readings(text)
    reasons = []
    candidates = {char: list(readings(char)) for char in dict.fromkeys(text)}
    if not proposed:
        reasons.append("词典不能逐字生成完整拼音")
    else:
        for char, sound in zip(text, proposed):
            if known.get(char) and sound not in known[char]:
                reasons.append(f"教材读音冲突：{char} 建议 {sound}，教材已知 {' / '.join(sorted(known[char]))}")
    common = COMMON_POLYPHONIC | {c for c, sounds in known.items() if len(sounds) >= 2} if common_polyphonic is None else common_polyphonic
    matched = phrase_matched_positions(text)
    multiple = list(dict.fromkeys(char for index, char in enumerate(text) if index not in matched and char in common))
    if multiple:
        reasons.append("未收词含常用多音字：" + "、".join(multiple))
    neutral_words = NEUTRAL_WORDS | set(rules.get("neutralToneWords", {}))
    # A suffix alone is insufficient (莲子、木头人、原子、花朵、量气...).
    # Only a complete listed word or two-character reduplication is a signal.
    neutral = text in neutral_words or (len(text) == 2 and text[0] == text[1])
    neutral_agrees = bool(proposed) and tone_number(proposed[-1]) == 0
    if neutral and not neutral_agrees:
        reasons.append("可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对")
    if neutral and neutral_agrees:
        # The final neutral syllable is already resolved by the reliable word rule.
        multiple = [char for char in multiple if char != text[-1]]
        reasons = [reason for reason in reasons if not reason.startswith("未收词含常用多音字")]
        if multiple:
            reasons.append("未收词含常用多音字：" + "、".join(multiple))
    if text in FORCED_REVIEW:
        reasons.append(FORCED_REVIEW[text])
    if "一" in text or "不" in text:
        reasons.append("一/不变调：建议统一展示本调 yī / bù，教材惯例待全局确认")
    return " ".join(proposed), reasons, candidates


def context_character(char, lesson, rules):
    """Use actual lesson vocabulary, never a generic unrelated context word."""
    matches = []
    for word in lesson.get("words", []):
        text = word.get("text", "")
        sounds = phrase_readings(text)
        if len(sounds) != len(text):
            continue
        for index, letter in enumerate(text):
            if letter == char and index in phrase_matched_positions(text):
                matches.append((text, sounds[index]))
    variants = {sound for _, sound in matches}
    return variants, matches


def character_analysis(char, lesson, local, book, globally, rules):
    candidates = {char: list(readings(char))}
    for name, source in (("同课", local), ("同册", book), ("九册教材/规则", globally)):
        known = source.get(char, set())
        if len(known) == 1:
            return next(iter(known)), "textbook", [], candidates, {"borrowedFrom": name}
        if len(known) > 1:
            variants, matches = context_character(char, lesson, rules)
            if len(variants) == 1 and variants.issubset(known):
                return next(iter(variants)), "dictionary", [], candidates, {"contextWords": [text for text, _ in matches]}
            return " / ".join(sorted(known)), None, [f"{name}有多个读音，本课词语无法唯一确定"], candidates, {"contextWords": [text for text, _ in matches]}
    options = readings(char)
    if options and (len(options) == 1 or char not in COMMON_POLYPHONIC and len(globally.get(char, ())) < 2):
        return options[0], "dictionary", [], candidates, {}
    variants, matches = context_character(char, lesson, rules)
    if len(variants) == 1 and variants.issubset(set(options)):
        return next(iter(variants)), "dictionary", [], candidates, {"contextWords": [text for text, _ in matches]}
    return " / ".join(options), None, ["多音字，本课词语无法唯一确定"], candidates, {"contextWords": [text for text, _ in matches]}


def valid_decision(decision):
    if decision in (None, "", "hide"):
        return True
    return isinstance(decision, str) and bool(re.fullmatch(r"[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿêÊ\s'’·-]+", normalized(decision)))


def reason_categories(reasons):
    categories = set()
    for reason in reasons:
        if reason.startswith("教材读音冲突") or reason.startswith("词典不能"):
            categories.add("textbookConflict")
        elif reason.startswith("可能轻声"):
            categories.add("neutralTone")
        elif reason.startswith("一/不变调"):
            categories.add("yiBuTone")
        else:
            categories.add("polyphonicUnlisted")
    return [category for category in REASON_CATEGORIES if category in categories]


def annotate(books, rules, previous=None, targets=DEFAULT_BOOKS, supplemental_items=()):
    previous = previous or {}
    old_entries = {entry["id"]: entry for entry in previous.get("entries", [])}
    stale = list(previous.get("staleDecisions", []))
    stale_keys = {(entry.get("id"), entry.get("fingerprint")) for entry in stale}
    lesson_known, book_known, all_known = build_known(books, rules)
    common_polyphonic = COMMON_POLYPHONIC | {char for char, sounds in all_known.items() if len(sounds) >= 2}
    global_decision = previous.get("decision", {})
    if not isinstance(global_decision, dict):
        raise ValueError("Invalid global pinyin decision: expected an object")
    yi_bu_style = global_decision.get("yiBuToneStyle")
    if yi_bu_style not in (None, "original", "sandhi"):
        raise ValueError(f"Invalid yiBuToneStyle: {yi_bu_style!r}")
    annotations = {"schemaVersion": 1, "generator": {"name": "annotate_pinyin.py", "version": VERSION, "pypinyinVersion": pypinyin.__version__}, "policies": POLICY, "books": {}, "statistics": {}}
    review = {"schemaVersion": 1, "instructions": POLICY, "decision": {"yiBuToneStyle": yi_bu_style}, "entries": [], "staleDecisions": stale}
    visited = set()
    supplements = defaultdict(list)
    source_lessons = {(book["bookId"], str(lesson["lessonNumber"])) for book in books for lesson in book["lessons"]}
    for item in supplemental_items:
        location = (item["bookId"], str(item["lessonNumber"]))
        if location not in source_lessons:
            raise ValueError(f"Supplemental word has no source lesson: {location}")
        if not item.get("source"):
            raise ValueError(f"Supplemental word must identify its source: {item}")
        supplements[location].append(item)
    for book in books:
        bid = book["bookId"]
        if bid not in targets:
            continue
        annotations["books"][bid] = {"lessons": {}}
        stats = {field: dict.fromkeys(("textbook", "reviewed", "dictionary", "pendingHidden", "total"), 0) for field in FIELDS}
        for lesson in book["lessons"]:
            number = str(lesson["lessonNumber"])
            dest = annotations["books"][bid]["lessons"][number] = {field: {} for field in FIELDS}
            local = lesson_known[(bid, number)]
            for field in FIELDS:
                items = supplements[(bid, number)] if field == "supplementalWords" else lesson.get(field, [])
                for item in items:
                    key = item_key(item)
                    text = item.get("text") if field in WORD_FIELDS else item.get("char")
                    if not key or not text:
                        raise ValueError(f"Missing item identity: {bid}/{number}/{field}")
                    if key in dest[field]:
                        raise ValueError(f"Duplicate annotation key: {bid}/{number}/{field}/{key}")
                    if field == "supplementalWords":
                        shared = next((source for source in lesson.get("words", []) if source.get("text") == text), None)
                        if shared:
                            # Same lesson, same word: one human decision and review row.
                            value = dict(dest["words"][item_key(shared)])
                            dest[field][key] = value
                            stats[field][value.get("pinyinSource", "pendingHidden")] += 1
                            stats[field]["total"] += 1
                            continue
                    rid = f"{bid}:{number}:{field}:{key}"
                    visited.add(rid)
                    metadata = {}
                    explicit = normalized(item.get("pinyin"))
                    if explicit:
                        proposed, source, reasons, candidates = explicit, "textbook", [], {}
                    elif field in WORD_FIELDS:
                        # Prefer the closest textbook evidence for conflict checks.
                        known = {char: local.get(char) or book_known[bid].get(char) or all_known.get(char, set()) for char in text}
                        proposed, reasons, candidates = word_analysis(text, known, rules, common_polyphonic)
                        source = "dictionary" if not reasons else None
                    else:
                        proposed, source, reasons, candidates, metadata = character_analysis(text, lesson, local, book_known[bid], all_known, rules)
                    categories = reason_categories(reasons)
                    fingerprint = digest({"version": VERSION, "pypinyinVersion": pypinyin.__version__, "bookId": bid, "lessonNumber": number, "title": lesson.get("title"), "item": item, "field": field, "paragraphs": lesson.get("paragraphs", []), "words": lesson.get("words", []), "known": {c: {"local": sorted(local.get(c, [])), "book": sorted(book_known[bid].get(c, [])), "all": sorted(all_known.get(c, []))} for c in text}, "rules": rules, "proposed": proposed, "reasons": reasons})
                    old = old_entries.get(rid, {})
                    decision = old.get("decision") if old.get("fingerprint") == fingerprint else None
                    if old.get("decision") not in (None, "") and old.get("fingerprint") != fingerprint and (rid, old.get("fingerprint")) not in stale_keys:
                        stale.append({**old, "staleReason": "条目或读音上下文变化，请在当前条目重新确认"})
                        stale_keys.add((rid, old.get("fingerprint")))
                    if not valid_decision(decision):
                        raise ValueError(f"Invalid pinyin review decision for {rid}: {decision!r}")
                    resolved_by_global = bool(yi_bu_style and categories == ["yiBuTone"] and proposed)
                    value = {}
                    if explicit:
                        value = {"pinyin": explicit, "pinyinSource": "textbook"}
                    elif decision not in (None, ""):
                        if decision != "hide":
                            value = {"pinyin": normalized(decision), "pinyinSource": "reviewed"}
                    elif resolved_by_global:
                        value = {"pinyin": " ".join(yi_bu_readings(text, proposed.split(), yi_bu_style)), "pinyinSource": "reviewed"}
                    elif source and proposed:
                        value = {"pinyin": proposed, "pinyinSource": source}
                    if reasons:
                        value["reviewId"] = rid
                        review["entries"].append({"id": rid, "fingerprint": fingerprint, "bookId": bid, "lessonNumber": lesson["lessonNumber"], "lessonTitle": lesson.get("title", ""), "field": field, "itemKey": key, "text": text, "suggestedPinyin": proposed, "reasons": reasons, "reasonCategories": categories, "category": categories[0], "resolvedByGlobal": resolved_by_global and decision in (None, ""), "candidateReadings": candidates, **({"yiBuSuggestions": {style: " ".join(yi_bu_readings(text, proposed.split(), style)) for style in ("original", "sandhi")}} if "yiBuTone" in categories and proposed else {}), **({"source": item["source"]} if field == "supplementalWords" else {}), **metadata, "decision": decision})
                    dest[field][key] = value
                    stats[field][value.get("pinyinSource", "pendingHidden")] += 1
                    stats[field]["total"] += 1
        stats["characters"] = {key: stats["recognitionCharacters"][key] + stats["writingCharacters"][key] for key in stats["words"]}
        annotations["statistics"][bid] = stats
    for rid, old in old_entries.items():
        if rid not in visited and old.get("decision") not in (None, "") and (rid, old.get("fingerprint")) not in stale_keys:
            stale.append({**old, "staleReason": "原条目已不存在或不在当前导出范围"})
    book_order = {bid: index for index, bid in enumerate(targets)}
    review["entries"].sort(key=lambda e: (list(REASON_CATEGORIES).index(e["category"]), book_order[e["bookId"]], e["lessonNumber"]))
    pending = lambda e: e["decision"] in (None, "") and not e["resolvedByGlobal"]
    review["summary"] = {"total": len(review["entries"]), "pending": sum(pending(e) for e in review["entries"]), "confirmed": sum(e["decision"] not in (None, "", "hide") or e["resolvedByGlobal"] for e in review["entries"]), "hide": sum(e["decision"] == "hide" for e in review["entries"]), "staleDecisions": len(stale), "reasonCounts": {category: sum(e["category"] == category for e in review["entries"]) for category in REASON_CATEGORIES}, "pendingReasonCounts": {category: sum(e["category"] == category and pending(e) for e in review["entries"]) for category in REASON_CATEGORIES}}
    annotations["reviewSummary"] = dict(review["summary"])
    return annotations, review


def review_markdown(review):
    summary = review["summary"]
    lines = ["# 拼音人工核对清单", "", f"总数 {summary['total']} 条；待核对 {summary['pending']} 条；已确认 {summary['confirmed']} 条；隐藏 {summary['hide']} 条；过期决定 {summary['staleDecisions']} 条。", "", "按首要原因归类，每条只计一次；同条的其他原因保留在 JSON 和明细中。", "", "| 原因 | 总数 | 待核对 |", "| --- | ---: | ---: |"]
    for category, label in REASON_CATEGORIES.items():
        lines.append(f"| {label} | {summary['reasonCounts'][category]} | {summary['pendingReasonCounts'][category]} |")
    lines.extend(["", POLICY["review"], "", POLICY["priority"], "", POLICY["toneSandhi"], "", POLICY["fingerprint"], ""])
    for category, label in REASON_CATEGORIES.items():
        lines.extend([f"## {label}", ""])
        entries = [e for e in review["entries"] if e["category"] == category]
        if category == "yiBuTone":
            affected = [e for e in review["entries"] if "yiBuTone" in e["reasonCategories"]]
            lines.extend([f"含一/不的词（共 {len(affected)} 个）：建议统一按本调（original，yī / bù）处理。教材标调惯例待用户确认。", "", f"只需一次设置顶层 `decision.yiBuToneStyle` 为 `original` 或 `sandhi`；当前值：`{json.dumps(review['decision']['yiBuToneStyle'])}`。每条完整拼音或 hide 仍可覆盖；其他原因未解决时继续隐藏。", ""])
            if len(affected) > len(entries):
                lines.extend(["同时有教材冲突或轻声疑点的词已列在前两节，本节不重复展开。", ""])
            grouped = defaultdict(list)
            for e in entries:
                grouped[(e['bookId'], e['lessonNumber'], e['lessonTitle'])].append(e)
            for (bid, number, title), words in grouped.items():
                details = "、".join(f"{e['text']}（{e['suggestedPinyin']}）" + (f"〔覆盖：{e['decision']}〕" if e['decision'] not in (None, '') else '') for e in words)
                lines.append(f"- {bid} 第 {number} 课 {title}：{details}")
            lines.append("")
            continue
        if not entries:
            lines.extend(["无。", ""])
            continue
        group = None
        for entry in entries:
            current = (entry["bookId"], entry["lessonNumber"])
            if current != group:
                if group is not None:
                    lines.append("")
                group = current
                lines.extend([f"### {group[0]} 第 {group[1]} 课 {entry['lessonTitle']}", ""])
            kind = {"words": "词", "supplementalWords": "扩展词", "recognitionCharacters": "识字", "writingCharacters": "写字"}[entry["field"]]
            checked = "x" if entry["decision"] not in (None, "") else " "
            decision = f"；决定：{entry['decision']}" if checked == "x" else ""
            lines.append(f"- [{checked}] {kind} **{entry['text']}** | 建议：{entry['suggestedPinyin'] or '无'} | 原因：{'；'.join(entry['reasons'])}{decision} | ID `{entry['id']}`")
        lines.append("")
    if review["staleDecisions"]:
        lines.extend(["## 过期决定（没有应用，需重新核对）", ""])
        lines.extend(f"- {e['id']}：{e['decision']}；{e['staleReason']}" for e in review["staleDecisions"])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--content-dir", type=Path, default=Path(__file__).resolve().parents[2] / "content" / "reading-prep")
    parser.add_argument("--supplemental-items", type=Path, default=Path(__file__).with_name("supplemental-pinyin-items.json"))
    args = parser.parse_args()
    root = args.content_dir
    books = [json.loads(path.read_text()) for path in sorted(root.glob("chinese-*.json"))]
    rules = json.loads((root / "pronunciation-rules.json").read_text())
    review_path = root / "pinyin-review.json"
    previous = json.loads(review_path.read_text()) if review_path.exists() else None
    supplemental = json.loads(args.supplemental_items.read_text())
    annotations, review = annotate(books, rules, previous, supplemental_items=supplemental["items"])
    annotations["generator"]["supplementalProvenance"] = supplemental.get("provenance", {})
    annotations["generator"]["inputs"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(root.glob("chinese-*.json"))}
    annotations["generator"]["inputs"]["pronunciation-rules.json"] = hashlib.sha256((root / "pronunciation-rules.json").read_bytes()).hexdigest()
    annotations["generator"]["inputs"][os.path.relpath(args.supplemental_items, root)] = hashlib.sha256(args.supplemental_items.read_bytes()).hexdigest()
    for name, data in (("pinyin-annotations.json", annotations), ("pinyin-review.json", review)):
        (root / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    (root / "pinyin-review.md").write_text(review_markdown(review))
    print(json.dumps({"statistics": annotations["statistics"], "review": review["summary"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
