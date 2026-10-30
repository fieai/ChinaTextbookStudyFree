"""Run using the installed isolated interpreter; all fixtures stay in memory."""

from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("annotate_pinyin", Path(__file__).with_name("annotate_pinyin.py"))
annotation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(annotation)


BOOK = "test-book"


def lesson(number=1, words=(), recognition=(), writing=()):
    return {"lessonNumber": number, "title": "测试课", "paragraphs": [{"text": "测试课文"}], "words": [{"text": text} if isinstance(text, str) else text for text in words], "recognitionCharacters": [{"char": char, "pinyin": sound} for char, sound in recognition], "writingCharacters": [{"char": char} for char in writing]}


def run(lessons, rules=None, previous=None, other_books=()):
    return annotation.annotate([{"bookId": BOOK, "lessons": lessons}, *other_books], rules or {}, previous, (BOOK,))


def entry(annotations, field, key, number=1):
    return annotations["books"][BOOK]["lessons"][str(number)][field][key]


class AnnotationTest(unittest.TestCase):
    def test_nonconflicting_single_reading_word_is_dictionary(self):
        data, review = run([lesson(words=["山坡"], recognition=[("坡", "pō")])])
        self.assertEqual(entry(data, "words", "山坡"), {"pinyin": "shān pō", "pinyinSource": "dictionary"})
        self.assertEqual(review["entries"], [])

    def test_textbook_conflict_is_hidden_with_explanation(self):
        data, review = run([lesson(words=["山坡"], recognition=[("坡", "pó")])])
        self.assertNotIn("pinyin", entry(data, "words", "山坡"))
        self.assertTrue(any("教材读音冲突" in text for text in review["entries"][0]["reasons"]))

    def test_phrase_dictionary_eliminates_rare_heteronym_false_positives(self):
        words = ["公园", "荷花", "清香", "本领", "姿势", "画家", "学校", "银行"]
        data, review = run([lesson(words=words)])
        self.assertEqual(review["entries"], [])
        for word in words:
            self.assertEqual(entry(data, "words", word)["pinyinSource"], "dictionary")

    def test_segmented_phrase_covers_polyphonic_character(self):
        data, review = run([lesson(words=["银行门口"])])
        self.assertEqual(entry(data, "words", "银行门口"), {"pinyin": "yín háng mén kǒu", "pinyinSource": "dictionary"})
        self.assertEqual(review["entries"], [])

    def test_unlisted_word_with_common_polyphonic_character_requires_review(self):
        data, review = run([lesson(words=["长木坡"])])
        self.assertNotIn("pinyin", entry(data, "words", "长木坡"))
        self.assertIn("polyphonicUnlisted", review["entries"][0]["reasonCategories"])

    def test_unlisted_word_with_only_rare_heteronym_is_not_reviewed(self):
        data, review = run([lesson(words=["园木坡"])])
        self.assertEqual(entry(data, "words", "园木坡"), {"pinyin": "yuán mù pō", "pinyinSource": "dictionary"})
        self.assertEqual(review["entries"], [])

    def test_textbook_multiple_readings_add_to_common_polyphonic_characters(self):
        lessons = [lesson(words=["园木坡"], recognition=[("园", "yuán")]), lesson(2, recognition=[("园", "wán")])]
        data, review = run(lessons)
        self.assertNotIn("pinyin", entry(data, "words", "园木坡"))
        self.assertIn("polyphonicUnlisted", review["entries"][0]["reasonCategories"])

    def test_pronunciation_rules_add_to_common_polyphonic_characters(self):
        rules = {"polyphonicContexts": {"园": {"yuán": ["公园"], "wán": ["测试罕见读音"]}}}
        data, review = run([lesson(words=["园木坡"])], rules=rules)
        self.assertNotIn("pinyin", entry(data, "words", "园木坡"))
        self.assertIn("polyphonicUnlisted", review["entries"][0]["reasonCategories"])

    def test_reliable_neutral_words_and_reduplication_require_review_when_not_neutral(self):
        words = ["热闹", "妈妈", "星星", "葡萄", "月亮", "衣服"]
        data, review = run([lesson(words=words)])
        self.assertEqual(len(review["entries"]), len(words))
        for word in words:
            self.assertNotIn("pinyin", entry(data, "words", word))
        for record in review["entries"]:
            self.assertIn("neutralTone", record["reasonCategories"])

    def test_dictionary_neutral_readings_are_adopted_without_review(self):
        data, review = run([lesson(words=["燕子", "孩子", "木头"])])
        self.assertEqual(review["entries"], [])
        for word, sound in [("燕子", "yàn zi"), ("孩子", "hái zi"), ("木头", "mù tou")]:
            self.assertEqual(entry(data, "words", word), {"pinyin": sound, "pinyinSource": "dictionary"})

    def test_added_neutral_words_hide_full_tone_dictionary_readings_for_review(self):
        expected = {
            "答应": "dā yìng", "活泼": "huó pō", "机灵": "jī líng",
            "痛快": "tòng kuài", "厉害": "lì hài", "笑话": "xiào huà",
            "指甲": "zhǐ jiǎ", "要是": "yào shì", "记号": "jì hào",
            "莲蓬": "lián péng", "起来": "qǐ lái",
        }
        data, review = run([lesson(words=expected)])
        self.assertEqual(review["summary"]["pending"], len(expected))
        self.assertEqual({record["text"] for record in review["entries"]}, set(expected))
        for record in review["entries"]:
            with self.subTest(word=record["text"]):
                self.assertEqual(record["suggestedPinyin"], expected[record["text"]])
                self.assertEqual(record["reasonCategories"], ["neutralTone"])
                self.assertIsNone(record["decision"])
                self.assertNotIn("pinyin", entry(data, "words", record["text"]))
                self.assertNotIn("pinyinSource", entry(data, "words", record["text"]))

    def test_added_neutral_word_accepts_dictionary_that_already_marks_neutral(self):
        # Simulate a corrected phrase dictionary: the review list must not force
        # a second review when its final syllable already agrees with the rule.
        for word, sound in [("答应", "dā ying"), ("起来", "qǐ lai")]:
            with self.subTest(word=word), patch.object(annotation, "phrase_readings", return_value=tuple(sound.split())):
                data, review = run([lesson(words=[word])])
                self.assertEqual(entry(data, "words", word), {"pinyin": sound, "pinyinSource": "dictionary"})
                self.assertEqual(review["entries"], [])

    def test_forced_review_hides_even_a_phrase_matched_dictionary_reading(self):
        data, review = run([lesson(words=["散发"])])
        self.assertEqual(entry(data, "words", "散发"), {"reviewId": "test-book:1:words:散发"})
        self.assertEqual(len(review["entries"]), 1)
        record = review["entries"][0]
        self.assertEqual(record["suggestedPinyin"], "sàn fà")
        self.assertIn("词典读音存疑：发 应为 fā", record["reasons"])
        self.assertIsNone(record["decision"])
        self.assertEqual(review["summary"]["pending"], 1)

    def test_forced_review_honors_manual_pinyin_and_hide_across_reruns(self):
        lessons = [lesson(words=["散发"])]
        for decision in ("sàn fā", "hide"):
            with self.subTest(decision=decision):
                _, review = run(lessons)
                review["entries"][0]["decision"] = decision
                data, review2 = run(lessons, previous=review)
                expected = {"reviewId": "test-book:1:words:散发"}
                if decision != "hide":
                    expected.update({"pinyin": "sàn fā", "pinyinSource": "reviewed"})
                self.assertEqual(entry(data, "words", "散发"), expected)
                self.assertEqual(review2["entries"][0]["decision"], decision)
                self.assertEqual(review2["summary"]["pending"], 0)
                self.assertEqual(run(lessons, previous=review2)[0], data)

    def test_explicit_textbook_pinyin_precedes_forced_and_neutral_review(self):
        lessons = [lesson(words=["散发", "活泼"])]
        _, review = run(lessons)
        for record in review["entries"]:
            record["decision"] = "hide"
        lessons[0]["words"] = [{"text": "散发", "pinyin": "sàn fā"}, {"text": "活泼", "pinyin": "huó po"}]
        data, review2 = run(lessons, previous=review)
        for word, sound in [("散发", "sàn fā"), ("活泼", "huó po")]:
            self.assertEqual(entry(data, "words", word), {"pinyin": sound, "pinyinSource": "textbook"})
        self.assertEqual(review2["entries"], [])
        self.assertEqual(len(review2["staleDecisions"]), 2)

    def test_suffix_alone_is_not_a_neutral_tone_signal(self):
        _, reasons, _ = annotation.word_analysis("公子", {}, {})
        self.assertFalse(any("轻声" in reason for reason in reasons))

    def test_sandhi_suggestions_use_citation_tones(self):
        _, review = run([lesson(words=["不是", "一天", "了不起"])])
        suggestions = {item["text"]: item for item in review["entries"]}
        self.assertEqual(suggestions["不是"]["suggestedPinyin"], "bù shì")
        self.assertEqual(suggestions["一天"]["suggestedPinyin"], "yī tiān")
        self.assertTrue(any("一/不变调" in r for r in suggestions["不是"]["reasons"]))
        self.assertIn("yiBuTone", suggestions["了不起"]["reasonCategories"])
        self.assertEqual(review["decision"], {"yiBuToneStyle": None})

    def test_global_yibu_styles_apply_and_survive_rerun(self):
        lessons = [lesson(words=["不是", "一天"])]
        for style, expected in [("original", ["bù shì", "yī tiān"]), ("sandhi", ["bú shì", "yì tiān"])]:
            with self.subTest(style=style):
                _, review = run(lessons)
                review["decision"]["yiBuToneStyle"] = style
                data, review2 = run(lessons, previous=review)
                for word, sound in zip(["不是", "一天"], expected):
                    self.assertEqual(entry(data, "words", word)["pinyin"], sound)
                    self.assertEqual(entry(data, "words", word)["pinyinSource"], "reviewed")
                self.assertEqual(review2["summary"]["pending"], 0)
                self.assertTrue(all(record["resolvedByGlobal"] for record in review2["entries"]))
                self.assertEqual(review2["decision"]["yiBuToneStyle"], style)
                self.assertEqual(run(lessons, previous=review2)[0], data)

    def test_invalid_global_yibu_style_is_rejected(self):
        with self.assertRaises(ValueError):
            run([lesson(words=["不是"])], previous={"decision": {"yiBuToneStyle": "automatic"}})

    def test_per_entry_pinyin_and_hide_override_global_yibu_style(self):
        lessons = [lesson(words=["不是", "一天"])]
        _, review = run(lessons)
        review["decision"]["yiBuToneStyle"] = "sandhi"
        review["entries"][0]["decision"] = "bù shì"
        review["entries"][1]["decision"] = "hide"
        data, review2 = run(lessons, previous=review)
        self.assertEqual(entry(data, "words", "不是")["pinyin"], "bù shì")
        self.assertNotIn("pinyin", entry(data, "words", "一天"))
        self.assertFalse(any(record["resolvedByGlobal"] for record in review2["entries"]))
        self.assertEqual(review2["summary"]["pending"], 0)

    def test_global_yibu_choice_does_not_resolve_textbook_conflict(self):
        lessons = [lesson(words=["不是"], recognition=[("是", "shí")])]
        _, review = run(lessons)
        review["decision"]["yiBuToneStyle"] = "original"
        data, review2 = run(lessons, previous=review)
        self.assertNotIn("pinyin", entry(data, "words", "不是"))
        record = review2["entries"][0]
        self.assertEqual(record["category"], "textbookConflict")
        self.assertEqual(set(record["reasonCategories"]), {"textbookConflict", "yiBuTone"})
        self.assertFalse(record["resolvedByGlobal"])
        self.assertEqual(review2["summary"]["pending"], 1)

    def test_global_yibu_choice_does_not_resolve_neutral_tone_review(self):
        rules = {"neutralToneWords": {"不是": "测试可靠轻声标记"}}
        lessons = [lesson(words=["不是"])]
        _, review = run(lessons, rules=rules)
        review["decision"]["yiBuToneStyle"] = "original"
        data, review2 = run(lessons, rules=rules, previous=review)
        self.assertNotIn("pinyin", entry(data, "words", "不是"))
        self.assertIn("neutralTone", review2["entries"][0]["reasonCategories"])
        self.assertFalse(review2["entries"][0]["resolvedByGlobal"])

    def test_borrowing_prefers_same_lesson_then_same_book_then_other_books(self):
        lessons = [lesson(recognition=[("行", "háng"), ("坡", "pō")], writing=["行", "坡", "绒"]), lesson(2, recognition=[("行", "xíng"), ("坡", "pó")])]
        other = {"bookId": "other-book", "lessons": [lesson(recognition=[("绒", "róng")])]}
        data, _ = run(lessons, other_books=[other])
        for char, expected in [("行", "háng"), ("坡", "pō"), ("绒", "róng")]:
            self.assertEqual(entry(data, "writingCharacters", char), {"pinyin": expected, "pinyinSource": "textbook"})

    def test_missing_polyphonic_character_uses_actual_lesson_word(self):
        data, _ = run([lesson(words=["银行"], writing=["行"])])
        self.assertEqual(entry(data, "writingCharacters", "行"), {"pinyin": "háng", "pinyinSource": "dictionary"})
        data, _ = run([lesson(words=["银行", "行走"], writing=["行"])])
        self.assertNotIn("pinyin", entry(data, "writingCharacters", "行"))

    def test_polyphonic_character_without_context_is_hidden(self):
        data, review = run([lesson(writing=["行"])])
        self.assertNotIn("pinyin", entry(data, "writingCharacters", "行"))
        self.assertEqual(review["summary"]["pending"], 1)

    def test_rare_heteronym_does_not_make_writing_character_ambiguous(self):
        data, review = run([lesson(writing=["园"])])
        self.assertEqual(entry(data, "writingCharacters", "园"), {"pinyin": "yuán", "pinyinSource": "dictionary"})
        self.assertEqual(review["entries"], [])

    def test_reviewed_decision_merges_and_survives_rerun(self):
        lessons = [lesson(words=["热闹", "妈妈"])]
        _, review = run(lessons)
        review["entries"][0]["decision"] = "rè nao"
        review["entries"][1]["decision"] = "hide"
        data, review2 = run(lessons, previous=review)
        value = entry(data, "words", "热闹")
        self.assertEqual((value["pinyin"], value["pinyinSource"]), ("rè nao", "reviewed"))
        self.assertNotIn("pinyin", entry(data, "words", "妈妈"))
        for key, expected in {"total": 2, "pending": 0, "confirmed": 1, "hide": 1, "staleDecisions": 0}.items():
            self.assertEqual(review2["summary"][key], expected)
        self.assertEqual(run(lessons, previous=review2)[0], data)

    def test_context_change_invalidates_decision_and_keeps_audit(self):
        lessons = [lesson(words=["热闹"])]
        _, review = run(lessons)
        review["entries"][0]["decision"] = "rè nao"
        lessons[0]["paragraphs"][0]["text"] = "修改后的课文"
        data, review2 = run(lessons, previous=review)
        self.assertNotIn("pinyin", entry(data, "words", "热闹"))
        self.assertIsNone(review2["entries"][0]["decision"])
        self.assertEqual(review2["staleDecisions"][0]["decision"], "rè nao")
        self.assertEqual(len(run(lessons, previous=review2)[1]["staleDecisions"]), 1)

    def test_explicit_textbook_pinyin_overrides_old_manual_decision(self):
        lessons = [lesson(words=["热闹"])]
        _, review = run(lessons)
        review["entries"][0]["decision"] = "hide"
        lessons[0]["words"][0]["pinyin"] = "rè nao"
        data, review2 = run(lessons, previous=review)
        self.assertEqual(entry(data, "words", "热闹"), {"pinyin": "rè nao", "pinyinSource": "textbook"})
        self.assertEqual(len(review2["staleDecisions"]), 1)

    def test_invalid_decision_is_rejected(self):
        lessons = [lesson(words=["热闹"])]
        _, review = run(lessons)
        review["entries"][0]["decision"] = "不知道"
        with self.assertRaisesRegex(ValueError, "Invalid pinyin review decision"):
            run(lessons, previous=review)

    def test_annotations_do_not_mutate_curated_input(self):
        lessons = [lesson(words=["学校"], recognition=[("坡", "pō")], writing=["坡"])]
        original = deepcopy(lessons)
        run(lessons)
        self.assertEqual(lessons, original)

    def test_statistics_count_sources_and_hidden_without_empty_pinyin(self):
        data, review = run([lesson(words=["山坡", "热闹"], recognition=[("坡", "pō")], writing=["坡", "妈", "行"])])
        stats = data["statistics"][BOOK]
        self.assertEqual(stats["words"]["dictionary"], 1)
        self.assertEqual(stats["words"]["pendingHidden"], 1)
        self.assertEqual(stats["characters"]["textbook"], 2)
        self.assertEqual(stats["characters"]["dictionary"], 1)
        self.assertEqual(stats["characters"]["pendingHidden"], 1)
        markdown = annotation.review_markdown(review)
        self.assertIn("- [ ]", markdown)
        self.assertIn("第 1 课", markdown)
        self.assertIn("decision", markdown)

    def test_reason_counts_and_markdown_sections_group_yibu_decision(self):
        lessons = [lesson(3, words=["热闹", "一天"]), lesson(1, words=["妈妈", "不是", "长木山", "山坡"], recognition=[("坡", "pó")])]
        _, review = run(lessons)
        expected = {"textbookConflict": 1, "neutralTone": 2, "yiBuTone": 2, "polyphonicUnlisted": 1}
        self.assertEqual(review["summary"]["total"], 6)
        self.assertEqual(review["summary"]["reasonCounts"], expected)
        self.assertEqual(review["summary"]["pendingReasonCounts"], expected)
        markdown = annotation.review_markdown(review)
        headings = ["教材冲突", "轻声", "一不变调", "多音未收词"]
        section_positions = [markdown.index("## " + heading) for heading in headings]
        self.assertEqual(section_positions, sorted(section_positions))
        neutral_section = markdown[section_positions[1]:section_positions[2]]
        self.assertLess(neutral_section.index("第 1 课"), neutral_section.index("第 3 课"))
        self.assertIn("yiBuToneStyle", markdown)
        for line in markdown.splitlines():
            if "不是" in line or "一天" in line:
                self.assertNotIn("- [", line)
        review["decision"]["yiBuToneStyle"] = "original"
        _, review2 = run(lessons, previous=review)
        self.assertEqual(review2["summary"]["pendingReasonCounts"]["yiBuTone"], 0)
        self.assertEqual(review2["summary"]["pending"], 4)

    def test_supplemental_word_uses_same_rules_and_separate_statistics(self):
        source = [{"bookId": BOOK, "lessonNumber": 1, "text": text, "source": "冻结 DQS.families"} for text in ("皮球", "热闹")]
        books = [{"bookId": BOOK, "lessons": [lesson(words=["山坡"]) ]}]
        data, review = annotation.annotate(books, {}, targets=[BOOK], supplemental_items=source)
        self.assertEqual(entry(data, "supplementalWords", "皮球"), {"pinyin": "pí qiú", "pinyinSource": "dictionary"})
        self.assertNotIn("pinyin", entry(data, "supplementalWords", "热闹"))
        self.assertEqual(data["statistics"][BOOK]["words"]["total"], 1)
        self.assertEqual(data["statistics"][BOOK]["supplementalWords"]["total"], 2)
        self.assertEqual(review["entries"][0]["field"], "supplementalWords")
        self.assertEqual(review["entries"][0]["source"], "冻结 DQS.families")
        review["entries"][0]["decision"] = "rè nao"
        data, _ = annotation.annotate(books, {}, previous=review, targets=[BOOK], supplemental_items=source)
        self.assertEqual(entry(data, "supplementalWords", "热闹")["pinyinSource"], "reviewed")

    def test_shared_supplemental_word_reuses_one_source_review(self):
        books = [{"bookId": BOOK, "lessons": [lesson(words=["热闹"])]}]
        source = [{"bookId": BOOK, "lessonNumber": 1, "text": "热闹", "source": "冻结 DQS.writeChars[].w"}]
        data, review = annotation.annotate(books, {}, targets=[BOOK], supplemental_items=source)
        self.assertEqual(entry(data, "supplementalWords", "热闹"), entry(data, "words", "热闹"))
        self.assertEqual(len(review["entries"]), 1)
        self.assertEqual(review["entries"][0]["field"], "words")
        self.assertEqual(data["reviewSummary"], review["summary"])
        review["entries"][0]["decision"] = "rè nao"
        data, _ = annotation.annotate(books, {}, previous=review, targets=[BOOK], supplemental_items=source)
        self.assertEqual(entry(data, "supplementalWords", "热闹")["pinyinSource"], "reviewed")

    def test_supplemental_source_is_required_and_must_reference_existing_lesson(self):
        books = [{"bookId": BOOK, "lessons": [lesson()]}]
        with self.assertRaisesRegex(ValueError, "identify its source"):
            annotation.annotate(books, {}, targets=[BOOK], supplemental_items=[{"bookId": BOOK, "lessonNumber": 1, "text": "学校"}])
        with self.assertRaisesRegex(ValueError, "no source lesson"):
            annotation.annotate(books, {}, targets=[BOOK], supplemental_items=[{"bookId": BOOK, "lessonNumber": 2, "text": "学校", "source": "原型"}])


if __name__ == "__main__":
    unittest.main()
