#!/usr/bin/env python3
"""Export Chinese body-sized glyphs with coordinates, without encoded pinyin.

This is a selection aid, not a final passage extractor: the same font size can
also occur in word lists. Check page images and select actual passage regions.
"""
import json
import re
import sys
from pathlib import Path

import pdfplumber


def export(pdf_path, directory):
    directory.mkdir(parents=True, exist_ok=True)
    with pdfplumber.open(pdf_path) as document:
        for number, page in enumerate(document.pages, 1):
            left, top, right, bottom = page.bbox
            selected = [char for char in page.chars
                        if 17 <= char['size'] < 27
                        and left <= char['x0'] <= char['x1'] <= right
                        and top <= char['top'] <= char['bottom'] <= bottom
                        and re.fullmatch(r'[\u3400-\u9fff0-9，。！？；：、“”‘’（）《》〈〉—…·]', char['text'])]
            groups = []
            for char in sorted(selected, key=lambda item: (round(item['top'] / 3), item['x0'])):
                if not groups or abs(char['top'] - groups[-1][0]['top']) > 3:
                    groups.append([])
                groups[-1].append(char)
            lines = []
            for group in groups:
                group.sort(key=lambda item: item['x0'])
                lines.append({
                    'text': ''.join(char['text'] for char in group),
                    'x': (min(char['x0'] for char in group) - left) / page.width,
                    'y': (min(char['top'] for char in group) - top) / page.height,
                    'height': max(char['size'] for char in group) / page.height,
                    'fontSizes': sorted({round(char['size'], 2) for char in group}),
                })
            result = {'pdfPage': number, 'method': 'PDF glyph selection, 17<=size<27, encoded pinyin excluded', 'lines': lines}
            (directory / f'p{number:03}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f'{pdf_path}: {len(document.pages)} pages exported to {directory}')


if __name__ == '__main__':
    export(Path(sys.argv[1]), Path(sys.argv[2]))
