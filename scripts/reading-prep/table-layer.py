#!/usr/bin/env python3
"""Produce source-coordinate character rows for editorial table verification.

The FZ pinyin font in these PDFs stores accented vowels at capital ASCII code
points. Decode those source codes rather than infer pronunciation from a word.
This output remains a candidate: assign course boundaries and check page images.
"""
import json
import re
import sys
from pathlib import Path

import pdfplumber

VOWELS = str.maketrans({
    'Q': 'ā', 'W': 'á', 'A': 'ǎ', 'S': 'à',
    'E': 'ē', 'R': 'é', 'D': 'ě', 'F': 'è',
    'U': 'ī', 'I': 'í', 'J': 'ǐ', 'K': 'ì',
    'T': 'ō', 'Y': 'ó', 'G': 'ǒ', 'H': 'ò',
    'O': 'ū', 'P': 'ú', 'L': 'ǔ', 'M': 'ù',
})


def export(filename, output, first, last):
    results = []
    with pdfplumber.open(filename) as document:
        for number in range(first, last + 1):
            original = document.pages[number - 1]
            page = original.within_bbox(original.bbox)
            han = [char for char in page.chars if 17 <= char['size'] < 22 and re.fullmatch(r'[\u3400-\u9fff]', char['text'])]
            groups = []
            for char in sorted(han, key=lambda item: (round(item['top'] / 3), item['x0'])):
                if not groups or abs(char['top'] - groups[-1][0]['top']) > 3:
                    groups.append([])
                groups[-1].append(char)
            rows = []
            for group in groups:
                group.sort(key=lambda item: item['x0'])
                centers = [(char['x0'] + char['x1']) / 2 for char in group]
                syllables = [[] for _ in group]
                above = [char for char in page.chars if 9 <= char['size'] <= 12
                         and re.fullmatch(r'[a-zA-Züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]', char['text'])
                         and abs(char['bottom'] - group[0]['top']) < 4]
                for char in sorted(above, key=lambda item: item['x0']):
                    center = (char['x0'] + char['x1']) / 2
                    nearest = min(range(len(group)), key=lambda index: abs(centers[index] - center))
                    syllables[nearest].append(char['text'])
                rows.append({'top': group[0]['top'], 'characters': [
                    {'char': char['text'], 'rawPinyin': ''.join(syllables[index]),
                     'pinyin': ''.join(syllables[index]).translate(VOWELS) or None, 'pdfPage': number,
                     'sourceColor': char.get('non_stroking_color')}
                    for index, char in enumerate(group)]})
            results.append({'pdfPage': number, 'rows': rows, 'rawText': page.extract_text(),
                            'decodedText': (page.extract_text() or '').translate(VOWELS)})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'method': 'Source glyph coordinates and FZ pinyin codes; editorial review required', 'pages': results}, ensure_ascii=False, indent=2) + '\n')
    print(output)


if __name__ == '__main__':
    export(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]))
