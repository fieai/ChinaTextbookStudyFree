'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildStudioLessons, SOURCE_LESSON_IDS } = require('./studio.cjs');

const siteDir = process.env.LEARNING_EXPORT_SITE_DIR || '/Users/shouzongchang/Documents/ZCTD/ChinaTextbookStudyFree/deploy-output/family-learning-share-20261027-button-stability/site';
const evidenceDir = process.env.LEARNING_EXPORT_EVIDENCE_DIR || '/Users/my-project/AI-PROJECT/thinky-wp-10/docs/learning/evidence/wp-10';
const contractDir = process.env.LEARNING_EXPORT_CONTRACT_DIR || path.join(require('./index.cjs').options([]).thinkyRoot, 'packages/learning-contract/dist');

test('five studio patches validate against the built authoritative contract', async () => {
  const { LessonDefinitionSchema } = await import(path.join(contractDir, 'index.js'));
  const { patches } = buildStudioLessons({ siteDir, evidenceDir });
  assert.equal(Object.keys(patches).length, 5);
  for (const [sourceLessonId, patch] of Object.entries(patches)) {
    LessonDefinitionSchema.parse({
      schemaVersion: 1, sourceLessonId, title: sourceLessonId,
      subject: sourceLessonId.startsWith('chinese-') ? 'chinese' : 'math', lessonKind: 'new',
      knowledgePointIds: [], textbookPages: { from: 1, to: 1 }, bookPageLabel: '1', homework: { questionRefs: [] }, ...patch,
    });
  }
});

test('openings, takeaways, cards and sampled widget text remain literal source excerpts', () => {
  const source = fs.readFileSync(path.join(siteDir, 'lesson-studio.js'), 'utf8');
  const evidence = fs.readFileSync(path.join(evidenceDir, 'five-lessons.md'), 'utf8');
  const { patches } = buildStudioLessons({ siteDir, evidenceDir });
  for (const id of Object.values(SOURCE_LESSON_IDS)) {
    const patch = patches[id];
    for (const text of [patch.opening.question, patch.opening.reveal, ...patch.takeaways.map(x => x.text), ...patch.cards.flatMap(x => [x.label, x.prompt, x.answer])]) {
      assert.ok(source.includes(`'${text}'`), `Exact source literal: ${id} ${text}`);
      assert.ok(evidence.includes(text), `Exact evidence excerpt: ${id} ${text}`);
    }
  }
  const dqs = patches['chinese-g3up-2026-u1-kp1'].basicStages.find(x => x.widget === 'read-aloud');
  assert.equal(dqs.props.sentences.length, 13);
  for (const sentence of dqs.props.sentences) assert.ok(source.includes(`'${sentence.text}'`));
  for (const pass of dqs.props.passes) {
    assert.ok(source.includes(`title: '${pass.title}'`));
    assert.ok(source.includes(`goal: '${pass.goal}'`));
  }
  const view = patches['g3up-2026-u1-l01'].basicStages[0];
  assert.equal(view.props.builds[0].name, '小台阶');
  assert.deepEqual(view.props.builds[0].visual.cubes, [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0, 1]]);
  const ruler = patches['g3up-2026-u3-l01'].extension.stages[1];
  assert.equal(ruler.props.start, 40);
  assert.equal(ruler.props.end, 75);
  assert.equal(ruler.props.unit, 'mm');
  assert.ok(source.includes('from: 4, cms: 6, start: 40, end: 75'));
  const ladder = patches['chinese-g3down-2026-u1-kp1'].basicStages.find(x => x.widget === 'recite-ladder');
  for (const level of ladder.props.levels) assert.ok(source.includes(`'${level.label}'`));
});

test('all nine interactions use structured activities and answers remain private', async () => {
  const { LessonAuthoringSchema } = await import(path.join(contractDir, 'index.js'));
  const { patches, gaps, widgetGradings } = buildStudioLessons({ siteDir, evidenceDir });
  const expected = [
    ['g3up-2026-u3-l01', 'extension-1', 'unit-choice'], ['g3up-2026-u3-l01', 'extension-3', 'unit-compare'],
    ['chinese-g3up-2026-u1-kp1', 'basic-4', 'char-learn', 'words'],
    ['chinese-g3up-2026-u1-kp1', 'basic-6', 'char-learn', 'dictation'],
    ['chinese-g3up-2026-u1-kp1', 'extension-2', 'char-learn', 'detective'],
    ['chinese-g3up-2026-u1-kp1', 'extension-4', 'char-learn', 'imitation'],
    ['chinese-g3down-2026-u1-kp1', 'extension-1', 'recite-ladder', 'scene'],
    ['chinese-g3down-2026-u1-kp1', 'extension-3', 'recite-ladder', 'pairs'],
    ['chinese-g3down-2026-u1-kp1', 'extension-4', 'read-aloud', 'listen'],
  ];
  for (const [id, key, widget, activity] of expected) {
    const stage = [...patches[id].basicStages, ...patches[id].extension.stages].find(x => x.key === key);
    assert.equal(stage.widget, widget, `${id}/${key}`);
    if (activity) assert.equal(stage.props.activity || stage.props.presentation, activity);
    assert.doesNotMatch(JSON.stringify(stage.props), /"(?:answer|grading|correctPartId|optionExplanations|symmetric|feedback)":/);
  }
  for (const [sourceLessonId, patch] of Object.entries(patches)) {
    const definition = { schemaVersion: 1, sourceLessonId, title: sourceLessonId,
      subject: sourceLessonId.startsWith('chinese-') ? 'chinese' : 'math', lessonKind: 'new',
      knowledgePointIds: [], textbookPages: { from: 1, to: 1 }, bookPageLabel: '1', homework: { questionRefs: [] }, ...patch };
    LessonAuthoringSchema.parse({ definition, widgetGradings: widgetGradings[sourceLessonId] || [] });
  }
  const privateDqs = widgetGradings['chinese-g3up-2026-u1-kp1'];
  assert.equal(privateDqs.find(x => x.stageKey === 'extension-2').content.grading.detective['detective-1'].answer, 'option-1');
  assert.equal(privateDqs.find(x => x.stageKey === 'extension-3').content.grading.characters['sound-1'].correctPartId, 'sound');
  assert.equal(gaps.some(x => x.includes('未还原该互动')), false);
});

test('detective answers and every option feedback preserve the complete prototype reveal', () => {
  const source = fs.readFileSync(path.join(siteDir, 'lesson-studio.js'), 'utf8');
  const { DQS } = require('./studio.cjs').readPrototype(source);
  const { patches, widgetGradings } = buildStudioLessons({ siteDir, evidenceDir });
  const id = 'chinese-g3up-2026-u1-kp1';
  const stage = patches[id].extension.stages.find(x => x.key === 'extension-2');
  const grading = widgetGradings[id].find(x => x.stageKey === stage.key).content.grading;
  assert.deepEqual(DQS.detective.map(item => item.answer), ['坡', '飘', '扬', '洁']);
  stage.props.detective.forEach((item, i) => {
    const original = DQS.detective[i];
    const grade = grading.detective[item.id];
    assert.equal(item.options.find(option => option.id === grade.answer).text, original.answer);
    for (const option of item.options) assert.equal(grade.optionExplanations[option.id],
      original.why[option.text] + (option.text === original.answer ? '' : ` 想想“${original.blank.replace('＿', original.answer)}”。`));
  });
  const parts = patches[id].extension.stages.find(x => x.key === 'extension-3');
  const partGrading = widgetGradings[id].find(x => x.stageKey === parts.key).content.grading;
  assert.deepEqual(DQS.soundParts.map(item => item.sound), ['求', '乎', '票', '召', '吉', '皮']);
  parts.props.characters.forEach((item, i) => {
    const original = DQS.soundParts[i];
    const grade = partGrading.characters[item.id];
    assert.equal(item.parts.find(part => part.id === grade.correctPartId).text, original.sound);
    assert.deepEqual(grade.feedback, {
      sound: `对！“${original.sound}”读 ${original.soundPy}。${original.hint}`,
      meaning: `“${original.meaning}”管意思。${original.hint}`,
    });
  });
});

test('explicit family and writing fields are preserved without guessing generators', () => {
  const source = fs.readFileSync(path.join(siteDir, 'lesson-studio.js'), 'utf8');
  const { patches, prototypeQuestionSets, variantGenerators } = buildStudioLessons({ siteDir, evidenceDir });
  const dqs = patches['chinese-g3up-2026-u1-kp1'];
  const families = dqs.extension.stages[0];
  assert.equal(families.widget, 'char-learn');
  assert.deepEqual(families.props.characters.map(x => x.char), ['昂', '扬', '墙', '晃']);
  assert.equal(families.props.characters.flatMap(x => x.family).length, 12);
  for (const character of families.props.characters) {
    assert.ok(source.includes(`'${character.pinyin}'`));
    for (const family of character.family) {
      assert.ok(source.includes(`'${family.text}'`));
      if (family.pinyin) assert.ok(source.includes(`'${family.pinyin}'`));
      if (family.meaning) assert.ok(source.includes(`'${family.meaning}'`));
    }
  }
  const writing = dqs.basicStages.find(x => x.widget === 'hanzi-write');
  assert.equal(writing.props.characters.length, 12);
  for (const character of writing.props.characters) {
    assert.ok(source.includes(`rad: '${character.parts[0].text}'`));
    assert.ok(source.includes(`tip: '${character.hint}'`));
    for (const family of character.family) {
      assert.ok(source.includes(`'${family.text}'`));
      if (family.pinyin) assert.ok(source.includes(`'${family.pinyin}'`));
      if (family.meaning) assert.ok(source.includes(`'${family.meaning}'`));
    }
  }
  assert.deepEqual(variantGenerators['g3up-2026-u3-l01'], ['mm-read', 'mm-convert', 'mm-compare']);
  assert.equal(Object.values(prototypeQuestionSets).flat().length, 20);
  assert.equal(prototypeQuestionSets['chinese-g3up-2026-u1-kp1'][0].q, '第 1 自然段主要写了什么？');
  assert.equal(prototypeQuestionSets['chinese-g3down-2026-u1-kp1'][0].q, '这首诗写的是哪个季节的景色？');
  for (const patch of Object.values(patches)) for (const card of patch.cards) assert.equal(card.generator, undefined);
});

test('missing declarations and prototype/evidence disagreements block studio export', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-export-test-'));
  try {
    fs.writeFileSync(path.join(temporary, 'lesson-studio.js'), 'const unrelated = {};');
    assert.throws(() => buildStudioLessons({ siteDir: temporary, evidenceDir }), /Missing prototype declaration/);
    const source = fs.readFileSync(path.join(siteDir, 'lesson-studio.js'), 'utf8');
    fs.writeFileSync(path.join(temporary, 'lesson-studio.js'), source.replace("label: '先说清方向'", "label: '错误改写'"));
    assert.throws(() => buildStudioLessons({ siteDir: temporary, evidenceDir }), /Prototype\/evidence text mismatch/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('language details retain source grouping, words, strokes and teacher materials', () => {
  const strokeDataByCharacter = { 飘: { kind: 'document', sha256: 'a'.repeat(64) } };
  const { patches } = buildStudioLessons({ siteDir, evidenceDir, strokeDataByCharacter });
  const dqs = patches['chinese-g3up-2026-u1-kp1'];
  const byKey = key => [...dqs.basicStages, ...dqs.extension.stages].find(x => x.key === key);
  assert.equal(byKey('basic-4').props.words.length, 11);
  assert.deepEqual(byKey('basic-4').props.words[0], { id: 'word-1', text: '山坡', pinyin: 'shān pō', context: { text: '早晨，从山坡上，从坪坝里……走来了许多小学生。', physicalPage: 8 } });
  assert.equal(byKey('basic-6').props.dictation.count, 5);
  assert.deepEqual(byKey('basic-6').props.dictation.kinds.map(x => x.label), ['偏旁', '多笔少笔', '写成别的字', '笔画位置']);
  const reading = byKey('basic-2').props;
  assert.equal(new Set(reading.sentences.map(x => x.paragraphId)).size, 4);
  assert.ok(reading.sentences[0].spans.some(x => x.text === '傣' && x.pinyin === 'dǎi'));
  assert.equal(reading.sentences[0].segments.length, 9);
  assert.deepEqual(reading.sentences.map(x => x.paragraphId), [1, 1, 1, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4].map(i => `paragraph-${i}`));
  assert.deepEqual(reading.passes.find(x => x.id === 'fluent').presentation.pauses, reading.sentences.flatMap((x, i) => [0, 2, 5, 8].includes(i) ? x.segments.flatMap((segment, j) => segment.text.endsWith('，') ? [{ sentenceId: x.id, afterSegment: j }] : []) : []));
  assert.ok(reading.passes.find(x => x.id === 'fluent').presentation.pauses.length > 0);
  assert.equal(reading.parentTitle, '家长听 30 秒 · 只听第 3 自然段');
  const character = byKey('basic-5').props.characters.find(x => x.char === '飘');
  assert.deepEqual(character.strokeData, strokeDataByCharacter.飘);
  assert.equal(character.structure, '左右结构');
  assert.equal(character.strokeCount, 15);
  assert.ok(character.explanation && character.usage && character.warning && character.commonMistakes.length);
  assert.equal(dqs.teachBack.characterPrompts.length, 12);
  assert.equal(dqs.teachBack.parentErrorCards.length, 16);
  assert.equal(dqs.teachBack.parentErrorCards[0].text, '把“山坡”写成“山波”，让孩子来纠正。');
  const scene = patches['chinese-g3down-2026-u1-kp1'].extension.stages.find(x => x.key === 'extension-1').props;
  assert.equal(scene.sourceNote, '原创示意图，非教材插图。');
  const other = patches['chinese-g3down-2026-u1-kp1'].extension.stages.find(x => x.key === 'extension-4').props;
  assert.deepEqual(other.passes, []);
  // Prototype JJ.other renders one <p> per line, unlike the prose paragraph groups.
  assert.deepEqual(other.sentences.map(x => x.paragraphId), ['paragraph-1', 'paragraph-2', 'paragraph-3', 'paragraph-4']);
  assert.deepEqual(other.sentences.flatMap(x => x.spans).filter(x => x.role === 'color').map(x => x.text), ['黄', '翠', '白', '青']);
});
