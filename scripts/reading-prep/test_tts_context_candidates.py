"""In-memory tests; run with the isolated pinyin interpreter."""

from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("tts_context_candidates", Path(__file__).with_name("tts_context_candidates.py"))
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)


def lesson(number=1, characters=(), words=(), body="", **extra):
    return {"lessonNumber": number, "sourceLessonId": f"lesson-{number}", "recognitionCharacters": [{"char": char, **({"pinyin": sound} if sound else {})} for char, sound in characters], "writingCharacters": [], "words": [{"text": word} if isinstance(word, str) else word for word in words], "paragraphs": [{"text": body}], **extra}


def book(lessons, bid="book"):
    return {"bookId": bid, "lessons": lessons}


def annotations(fields, number=1, bid="book"):
    return {"books": {bid: {"lessons": {str(number): fields}}}}


def character(data, char="行", sid="lesson-1"):
    return data["lessons"][sid]["characters"][char]


class ContextCandidatesTest(unittest.TestCase):
    def test_source_priority_and_full_syllables(self):
        books = [book([lesson(characters=[("行", "xíng")], words=["行动"], body="行人"), lesson(2, words=["行走"])]), book([lesson(3, words=["行李"])], "other")]
        rules = {"polyphonicContexts": {"行": {"xíng": ["行为"]}}}
        result = character(context.build_candidates(books, {}, rules))
        self.assertEqual([row["source"] for row in result["candidates"][:5]], ["textbook-word-table", "textbook-body-phrase", "same-book-word-table", "other-book-word-table", "dictionary-phrase"])
        self.assertEqual(result["candidates"][4]["word"], "行为")
        self.assertIsNone(result["candidates"][4]["sourceBookId"])
        for row in result["candidates"]:
            self.assertEqual(len(row["word"]), len(row["pinyin"]))
            self.assertTrue(context.matches_target(row["word"], row["pinyin"], "行", "xíng"))

    def test_rejects_wrong_reading_in_every_source(self):
        books = [book([lesson(characters=[("行", "xíng")], words=["银行"], body="银行"), lesson(2, words=["行业"])]), book([lesson(3, words=["银行家"])], "other")]
        result = character(context.build_candidates(books, {}, {}))
        self.assertTrue(all("银行" not in row["word"] and row["word"] != "行业" for row in result["candidates"]))

    def test_textbook_character_beats_reviewed_annotation(self):
        data = context.build_candidates([book([lesson(characters=[("行", "háng")], words=["银行"])])], annotations({"recognitionCharacters": {"行": {"pinyin": "xíng", "pinyinSource": "reviewed"}}}), {})
        value = character(data)
        self.assertEqual((value["pinyin"], value["pinyinSource"]), ("háng", "textbook"))
        self.assertEqual(value["candidates"][0]["word"], "银行")

    def test_reviewed_character_beats_dictionary_annotation(self):
        item = lesson(characters=[("行", None)], writingCharacters=[{"char": "行"}])
        data = context.build_candidates([book([item])], annotations({"recognitionCharacters": {"行": {"pinyin": "háng", "pinyinSource": "dictionary"}}, "writingCharacters": {"行": {"pinyin": "xíng", "pinyinSource": "reviewed"}}}), {})
        self.assertEqual(character(data)["pinyin"], "xíng")
        self.assertEqual(character(data)["pinyinSource"], "reviewed")

    def test_conflicting_textbook_characters_have_no_sound_or_candidates(self):
        item = lesson(characters=[("行", "xíng")], words=["行动"], writingCharacters=[{"char": "行", "pinyin": "háng"}])
        value = character(context.build_candidates([book([item])], {}, {}))
        self.assertNotIn("pinyin", value)
        self.assertEqual(value["candidates"], [])

    def test_conflicting_same_priority_annotations_are_hidden(self):
        item = lesson(characters=[("行", None)], writingCharacters=[{"char": "行"}])
        data = context.build_candidates([book([item])], annotations({"recognitionCharacters": {"行": {"pinyin": "háng", "pinyinSource": "reviewed"}}, "writingCharacters": {"行": {"pinyin": "xíng", "pinyinSource": "reviewed"}}}), {})
        self.assertNotIn("pinyin", character(data))

    def test_never_borrows_character_sound_from_another_lesson(self):
        data = context.build_candidates([book([lesson(characters=[("行", None)], words=["行动"]), lesson(2, characters=[("行", "xíng")])])], {}, {})
        self.assertNotIn("pinyin", character(data))
        self.assertEqual(character(data)["candidates"], [])

    def test_reviewed_whole_word_wins_and_hidden_word_uses_dictionary(self):
        item = lesson(characters=[("行", "háng")], words=["行动", "银行"])
        anno = annotations({"words": {"行动": {"pinyin": "háng dòng", "pinyinSource": "reviewed"}, "银行": {"reviewId": "hidden"}}})
        result = character(context.build_candidates([book([item])], anno, {}))
        self.assertEqual(result["candidates"][0]["pinyin"], ["háng", "dòng"])
        self.assertEqual(result["candidates"][1]["pinyin"], ["yín", "háng"])

    def test_explicit_whole_word_wins_over_reviewed(self):
        item = lesson(characters=[("行", "háng")], words=[{"text": "行动", "pinyin": "háng dòng"}])
        anno = annotations({"words": {"行动": {"pinyin": "xíng dòng", "pinyinSource": "reviewed"}}})
        self.assertEqual(character(context.build_candidates([book([item])], anno, {}))["candidates"][0]["pinyin"], ["háng", "dòng"])

    def test_repeated_target_conflicting_syllables_are_rejected(self):
        item = lesson(characters=[("行", "xíng")], words=[{"text": "行行", "pinyin": "xíng háng"}])
        value = character(context.build_candidates([book([item])], {}, {}))
        self.assertFalse(any(row["word"] == "行行" for row in value["candidates"]))
        self.assertFalse(context.matches_target("行行", ["xíng", "háng"], "行", "xíng"))

    def test_body_two_characters_first_then_offset_then_length(self):
        item = lesson(characters=[("行", "xíng")], body="行人在行人道上行走")
        dictionary = {"行人": [], "行人道": [], "行走": []}
        with patch.object(context.annotation, "phrase_readings", side_effect=lambda word: tuple("xíng" if char == "行" else "rén" for char in word)):
            value = character(context.build_candidates([book([item])], {}, {}, dictionary=dictionary))
        self.assertEqual([(row["word"], row["offset"]) for row in value["candidates"]], [("行人", 0), ("行走", 7), ("行人道", 3)])

    def test_common_actual_and_rule_polyphonic_exclude_rare_heteronyms(self):
        books = [book([lesson(characters=[("园", "yuán"), ("读", "dú"), ("系", "jì")]), lesson(2, characters=[("模", "mó")]), lesson(3, characters=[("模", "mú")])])]
        data = context.build_candidates(books, {}, {"polyphonicContexts": {"系": {"jì": ["系鞋带"], "xì": ["关系"]}}})
        self.assertNotIn("polyphonic", character(data, "园"))
        self.assertEqual(character(data, "读")["polyphonic"], ["dòu", "dú"])
        self.assertIn("mú", character(data, "模", "lesson-2")["polyphonic"])
        self.assertEqual(character(data, "系")["candidates"][0]["word"], "系鞋带")

    def test_rule_polyphony_and_dictionary_only_character_cannot_fallback(self):
        item = lesson(characters=[("园", None)])
        rules = {"polyphonicContexts": {"园": {"yuán": ["公园"], "wán": []}}}
        data = context.build_candidates([book([item])], annotations({"recognitionCharacters": {"园": {"pinyin": "yuán", "pinyinSource": "dictionary"}}}), rules)
        value = character(data, "园")
        self.assertEqual(value["polyphonic"], ["wán", "yuán"])
        self.assertEqual(value["candidates"], [])

    def test_new_target_with_zero_vocabulary_frequency_gets_dictionary_words(self):
        # 几 is absent from all vocabulary tables.  Its companion characters
        # remain familiar, and actual daily phrases determine their order.
        item = lesson(characters=[("几", "jǐ")], words=["个人", "个子", "无边", "无力"], body="几个，几个，无几")
        # Keep the frequency evidence in another lesson, so these are fallback
        # words rather than local body candidates.
        item["paragraphs"] = []
        corpus = lesson(2, body="几个，几个，无几")
        value = character(context.build_candidates([book([item, corpus])], {}, {}, dictionary={"几个": [], "无几": []}), "几")
        self.assertEqual([row["word"] for row in value["candidates"]], ["几个", "无几"])
        self.assertTrue(all(row["source"] == "dictionary-phrase" for row in value["candidates"]))

    def test_unfamiliar_target_can_use_familiar_body_only_companion(self):
        item = lesson(characters=[("挨", "āi")])
        corpus = lesson(2, body="近处近处")
        value = character(context.build_candidates([book([item, corpus])], {}, {"polyphonicContexts": {"挨": {"āi": [], "ái": []}}}, dictionary={"挨近": []}), "挨")
        self.assertEqual(value["candidates"][0]["word"], "挨近")

    def test_generation_fingerprints_data_generator_and_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = {"chinese-fixture.json": book([lesson(characters=[("行", "xíng")])]), "pinyin-annotations.json": {}, "pronunciation-rules.json": {}}
            for name, data in sources.items():
                (root / name).write_text(json.dumps(data, ensure_ascii=False))
            generated = context.generate(root)["generator"]
            self.assertEqual(generated["inputs"], {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sources})
            self.assertEqual(generated["scriptSha256"], hashlib.sha256(Path(context.__file__).read_bytes()).hexdigest())
            self.assertEqual(generated["helperSha256"], hashlib.sha256(Path(context.annotation.__file__).read_bytes()).hexdigest())

    def test_common_dictionary_pool_prioritizes_accurate_daily_contexts(self):
        item = lesson(characters=[("曾", "zēng"), ("冲", "chòng")], words=["可爱", "可能", "祖先", "祖国", "儿子", "孩子", "劲头", "干劲"])
        data = context.build_candidates([book([item])], {}, {})
        self.assertEqual(character(data, "曾")["candidates"][0]["word"], "曾祖")
        self.assertEqual(character(data, "曾")["candidates"][0]["pinyin"], ["zēng", "zǔ"])
        self.assertEqual(character(data, "冲")["candidates"][0]["word"], "冲劲")
        self.assertEqual(character(data, "冲")["candidates"][0]["pinyin"], ["chòng", "jìn"])

    def test_unreliable_dictionary_contexts_are_excluded_at_every_dictionary_source(self):
        item = lesson(characters=[("曾", "zēng")], words=["可曾", "何曾", "几曾"], body="可曾何曾几曾")
        data = context.build_candidates([book([item, lesson(2, words=["可曾", "何曾", "几曾"])])], {}, {"polyphonicContexts": {"曾": {"zēng": ["可曾", "何曾", "几曾"]}}})
        self.assertTrue(all(row["word"] not in context.KNOWN_UNRELIABLE_DICTIONARY_CONTEXTS for row in character(data, "曾")["candidates"]))
        anno = annotations({"words": {"可曾": {"pinyin": "kě zēng", "pinyinSource": "reviewed"}}})
        data = context.build_candidates([book([item])], anno, {})
        self.assertEqual(character(data, "曾")["candidates"][0]["word"], "可曾")
        self.assertEqual(character(data, "曾")["candidates"][0]["source"], "textbook-word-table")

    def test_common_dictionary_pool_never_overrides_target_reading_or_missing_entry(self):
        item = lesson(characters=[("曾", "céng"), ("冲", "chōng")])
        data = context.build_candidates([book([item])], {}, {})
        self.assertFalse(any(row["word"] == "曾祖" for row in character(data, "曾")["candidates"]))
        self.assertFalse(any(row["word"] == "冲劲" for row in character(data, "冲")["candidates"]))
        item = lesson(characters=[("曾", "zēng"), ("冲", "chòng")])
        data = context.build_candidates([book([item])], {}, {}, dictionary={})
        self.assertEqual(character(data, "曾")["candidates"], [])
        self.assertEqual(character(data, "冲")["candidates"], [])

    def test_existing_rule_words_precede_common_dictionary_pool(self):
        item = lesson(characters=[("曾", "zēng")])
        data = context.build_candidates([book([item])], {}, {"polyphonicContexts": {"曾": {"zēng": ["曾孙"]}}})
        self.assertEqual([row["word"] for row in character(data, "曾")["candidates"][:2]], ["曾孙", "曾祖"])

    def test_all_source_ids_parts_deduplication_and_determinism(self):
        item = lesson(characters=[("行", "xíng")], words=["行动"], body="行动", sourceLessonIds=["alias", "lesson-1"], parts=[{"sourceLessonId": "part"}])
        books = [book([item, lesson(2, words=["行动"])])]
        before = deepcopy(books)
        first = context.build_candidates(books, {}, {}, {"fixture.json": "abc"})
        second = context.build_candidates(books, {}, {}, {"fixture.json": "abc"})
        self.assertEqual(json.dumps(first, ensure_ascii=False), json.dumps(second, ensure_ascii=False))
        self.assertEqual(first["generator"]["inputs"], {"fixture.json": "abc"})
        self.assertEqual(first["lessons"]["lesson-1"], first["lessons"]["alias"])
        self.assertEqual(first["lessons"]["alias"], first["lessons"]["part"])
        self.assertEqual(len([row for row in character(first)["candidates"] if row["word"] == "行动"]), 1)
        self.assertEqual(books, before)


if __name__ == "__main__":
    unittest.main()
