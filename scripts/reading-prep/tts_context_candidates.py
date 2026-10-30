#!/usr/bin/env python3
"""Build deterministic, offline TTS context candidates without touching audio caches.

Run with .local/tools/pinyin-venv/bin/python -I scripts/reading-prep/tts_context_candidates.py.
The consumer must also validate each occurrence of the target character's sound.
"""

import argparse
from collections import Counter, defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path
import re

import pypinyin
from pypinyin.phrases_dict import phrases_dict


_spec = importlib.util.spec_from_file_location("tts_annotation_helpers", Path(__file__).with_name("annotate_pinyin.py"))
annotation = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(annotation)

VERSION = "1.2.0"
CHARACTER_FIELDS = annotation.CHARACTER_FIELDS
CONFIRMED_SOURCES = ("reviewed", "textbook", "dictionary")
HAN = re.compile(r"^[\u3400-\u9fff]+$")
DICTIONARY_LIMIT = 20
# A word-only ranking pool: these never override the dictionary's syllables.
COMMON_DICTIONARY_CONTEXTS = ("曾祖", "冲劲")
# pypinyin 0.55.0 gives zeng1 to these adverbial contexts. They are unsuitable
# evidence for a modern zeng1 example (MOE's concise dictionary gives 何曾
# he2 ceng2: https://dict.concised.moe.edu.tw/dictView.jsp?ID=19115&la=0&powerMode=0).
# Exclude their dictionary readings, while retaining any explicit reviewed or
# printed whole-word annotation.
KNOWN_UNRELIABLE_DICTIONARY_CONTEXTS = frozenset(("可曾", "何曾", "几曾"))


def syllables(value, length):
    sounds = tuple(annotation.normalized(value).split())
    if len(sounds) != length or any(not re.fullmatch(r"[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿê]+", sound) for sound in sounds):
        return ()
    return sounds


def lesson_annotation(annotations, book_id, lesson):
    return annotations.get("books", {}).get(book_id, {}).get("lessons", {}).get(str(lesson["lessonNumber"]), {})


def confirmed_character(char, lesson, annotated):
    explicit = {annotation.normalized(item.get("pinyin")) for field in CHARACTER_FIELDS for item in lesson.get(field, []) if item.get("char") == char and item.get("pinyin")}
    if explicit:
        return (next(iter(explicit)), "textbook") if len(explicit) == 1 and syllables(next(iter(explicit)), 1) else (None, None)
    entries = [annotated.get(field, {}).get(annotation.item_key(item), {}) for field in CHARACTER_FIELDS for item in lesson.get(field, []) if item.get("char") == char]
    for source in CONFIRMED_SOURCES:
        values = {annotation.normalized(entry.get("pinyin")) for entry in entries if entry.get("pinyinSource") == source and entry.get("pinyin")}
        if values:
            return (next(iter(values)), source) if len(values) == 1 and syllables(next(iter(values)), 1) else (None, None)
    return None, None


def word_readings(item, annotated):
    """Only printed/reviewed whole words override the phrase dictionary.

    An unresolved or hidden annotation is never promoted to reviewed evidence;
    the independent dictionary may still explain the same vocabulary word.
    """
    text = item.get("text", "")
    if item.get("pinyin"):
        return syllables(item["pinyin"], len(text))
    value = annotated.get("words", {}).get(annotation.item_key(item), {})
    if value.get("pinyinSource") in ("textbook", "reviewed") and value.get("pinyin"):
        return syllables(value["pinyin"], len(text))
    if text in KNOWN_UNRELIABLE_DICTIONARY_CONTEXTS:
        return ()
    return annotation.phrase_readings(text)


def matches_target(word, sounds, char, sound):
    return bool(sound and char in word and len(word) == len(sounds) and all(sounds[index] == sound for index, letter in enumerate(word) if letter == char))


def source_ids(lesson):
    values = [lesson.get("sourceLessonId"), *lesson.get("sourceLessonIds", [])]
    values.extend(part.get("sourceLessonId") for part in lesson.get("parts", []))
    return list(dict.fromkeys(value for value in values if value))


def body_phrases(lesson, dictionary):
    result, seen, base = [], set(), 0
    for paragraph in lesson.get("paragraphs", []):
        text = paragraph.get("text", "")
        for offset in range(len(text)):
            for size in range(2, 5):
                word = text[offset:offset + size]
                if len(word) == size and word not in seen and HAN.fullmatch(word) and word in dictionary and word not in KNOWN_UNRELIABLE_DICTIONARY_CONTEXTS:
                    seen.add(word)
                    result.append((word, base + offset))
        base += len(text) + 1  # A paragraph break occupies one offset position.
    return sorted(result, key=lambda row: (len(row[0]) != 2, row[1], len(row[0]), row[0]))


def build_candidates(books, annotations, rules, inputs=None, dictionary=None):
    dictionary = phrases_dict if dictionary is None else dictionary
    _, _, known = annotation.build_known(books, rules)
    known["读"].update(("dú", "dòu"))
    common = annotation.COMMON_POLYPHONIC | {char for char, sounds in known.items() if len(sounds) >= 2} | {"读"}
    vocabulary_frequency = Counter(char for book in books for lesson in book["lessons"] for item in lesson.get("words", []) for char in item.get("text", "") if HAN.fullmatch(char))
    body_frequency = Counter()
    body_char_frequency = Counter()
    for book in books:
        for lesson in book["lessons"]:
            for paragraph in lesson.get("paragraphs", []):
                text = paragraph.get("text", "")
                body_char_frequency.update(char for char in text if HAN.fullmatch(char))
                body_frequency.update(text[index:index + 2] for index in range(len(text) - 1) if HAN.fullmatch(text[index:index + 2]))
    # The target itself can be new vocabulary and must not fail a frequency
    # gate. Only the other characters need to be familiar corpus characters.
    # Actual two-character occurrences rank daily expressions before phrases
    # whose individual characters merely happen to be common.
    dictionary_by_char = defaultdict(list)
    for word in dictionary:
        if len(word) == 2 and HAN.fullmatch(word) and word not in KNOWN_UNRELIABLE_DICTIONARY_CONTEXTS:
            for char in dict.fromkeys(word):
                if all(other == char or vocabulary_frequency[other] >= 2 or body_char_frequency[other] >= 2 for other in word):
                    dictionary_by_char[char].append(word)
    for char, words in dictionary_by_char.items():
        words.sort(key=lambda word: (-body_frequency[word], -sum(vocabulary_frequency[c] for c in word if c != char), -sum(body_char_frequency[c] for c in word if c != char), word))

    words_by_char = defaultdict(list)
    for book in books:
        bid = book["bookId"]
        for lesson in book["lessons"]:
            annotated = lesson_annotation(annotations, bid, lesson)
            for item in lesson.get("words", []):
                word = item.get("text", "")
                if len(word) < 2 or not HAN.fullmatch(word):
                    continue
                sounds = word_readings(item, annotated)
                if len(sounds) != len(word):
                    continue
                record = {"word": word, "pinyin": list(sounds), "sourceBookId": bid, "lessonNumber": lesson["lessonNumber"]}
                for char in dict.fromkeys(word):
                    words_by_char[char].append(record)

    output = {"schemaVersion": 1, "generator": {"name": "tts_context_candidates.py", "version": VERSION, "pypinyinVersion": pypinyin.__version__, "inputs": inputs or {}}, "lessons": {}}
    for book in books:
        bid = book["bookId"]
        for lesson in book["lessons"]:
            annotated = lesson_annotation(annotations, bid, lesson)
            characters = dict.fromkeys(item["char"] for field in CHARACTER_FIELDS for item in lesson.get(field, []) if len(item.get("char", "")) == 1)
            body = body_phrases(lesson, dictionary)
            dest = {}
            for char in characters:
                sound, sound_source = confirmed_character(char, lesson, annotated)
                value = {"candidates": []}
                if sound:
                    value.update(pinyin=sound, pinyinSource=sound_source)
                if char in common:
                    options = set(known.get(char, ()))
                    if char in annotation.COMMON_POLYPHONIC:
                        options.update(annotation.readings(char))
                    if sound:
                        options.add(sound)
                    value["polyphonic"] = sorted(options)
                seen = set()

                def add(record, source):
                    word = record["word"]
                    if word not in seen and matches_target(word, record["pinyin"], char, sound):
                        seen.add(word)
                        value["candidates"].append({**record, "source": source})

                records = words_by_char.get(char, [])
                for record in records:
                    if record["sourceBookId"] == bid and str(record["lessonNumber"]) == str(lesson["lessonNumber"]):
                        add(record, "textbook-word-table")
                for word, offset in body:
                    if char in word:
                        add({"word": word, "pinyin": list(annotation.phrase_readings(word)), "sourceBookId": bid, "lessonNumber": lesson["lessonNumber"], "offset": offset}, "textbook-body-phrase")
                for record in records:
                    if record["sourceBookId"] == bid and str(record["lessonNumber"]) != str(lesson["lessonNumber"]):
                        add(record, "same-book-word-table")
                for record in records:
                    if record["sourceBookId"] != bid:
                        add(record, "other-book-word-table")
                if char in common and sound_source in ("reviewed", "textbook"):
                    nominated = rules.get("polyphonicContexts", {}).get(char, {}).get(sound, [])
                    preferred = [word for word in [*nominated, *COMMON_DICTIONARY_CONTEXTS] if word in dictionary and word not in KNOWN_UNRELIABLE_DICTIONARY_CONTEXTS and len(word) >= 2 and HAN.fullmatch(word)]
                    fallback = dict.fromkeys([*preferred, *dictionary_by_char.get(char, [])])
                    count = 0
                    for word in fallback:
                        before = len(value["candidates"])
                        add({"word": word, "pinyin": list(annotation.phrase_readings(word)), "sourceBookId": None, "lessonNumber": None}, "dictionary-phrase")
                        count += len(value["candidates"]) > before
                        if count >= DICTIONARY_LIMIT:
                            break
                dest[char] = value
            for source_id in source_ids(lesson):
                if source_id in output["lessons"] and output["lessons"][source_id] != {"characters": dest}:
                    raise ValueError(f"Conflicting sourceLessonId: {source_id}")
                output["lessons"][source_id] = {"characters": dest}
    return output


def generate(content_dir):
    book_paths = sorted(content_dir.glob("chinese-*.json"))
    paths = [*book_paths, content_dir / "pinyin-annotations.json", content_dir / "pronunciation-rules.json"]
    inputs = {str(path.relative_to(content_dir)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
    books = [json.loads(path.read_text()) for path in book_paths]
    annotations = json.loads((content_dir / "pinyin-annotations.json").read_text())
    rules = json.loads((content_dir / "pronunciation-rules.json").read_text())
    output = build_candidates(books, annotations, rules, inputs)
    output["generator"]["scriptSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    output["generator"]["helperSha256"] = hashlib.sha256(Path(annotation.__file__).read_bytes()).hexdigest()
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--content-dir", type=Path, default=Path(__file__).resolve().parents[2] / "content" / "reading-prep")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or args.content_dir / "tts-context-candidates.json"
    data = generate(args.content_dir)
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {output}: {len(data['lessons'])} source lessons")


if __name__ == "__main__":
    main()
