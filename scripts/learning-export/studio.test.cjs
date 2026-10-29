'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildStudioLessons, SOURCE_LESSON_IDS } = require('./studio.cjs');

const siteDir = process.env.LEARNING_EXPORT_SITE_DIR || '/Users/shouzongchang/Documents/ZCTD/ChinaTextbookStudyFree/deploy-output/family-learning-share-20261027-button-stability/site';
const evidenceDir = process.env.LEARNING_EXPORT_EVIDENCE_DIR || '/Users/my-project/AI-PROJECT/thinky-wp-10/docs/learning/evidence/wp-10';
const contractDir = process.env.LEARNING_EXPORT_CONTRACT_DIR || '/Users/my-project/AI-PROJECT/thinky/packages/learning-contract/dist';

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
  assert.deepEqual(ruler.props, { start: 40, end: 75, unit: 'mm' });
  assert.ok(source.includes('from: 4, cms: 6, start: 40, end: 75'));
  const ladder = patches['chinese-g3down-2026-u1-kp1'].basicStages.find(x => x.widget === 'recite-ladder');
  for (const level of ladder.props.levels) assert.ok(source.includes(`'${level.label}'`));
});

test('unexpressed interactions have concrete field gaps; static fact panels use concept-card directly', () => {
  const { patches, gaps } = buildStudioLessons({ siteDir, evidenceDir });
  const staticPanels = new Set([
    'chinese-g3up-2026-u1-kp1/extension-5', 'chinese-g3down-2026-u1-kp1/basic-2',
    'chinese-g3down-2026-u1-kp1/basic-4', 'chinese-g3down-2026-u1-kp1/extension-2',
  ]);
  let unsupported = 0;
  for (const [id, patch] of Object.entries(patches)) {
    for (const stage of [...patch.basicStages, ...patch.extension.stages]) {
      if (stage.widget === 'concept-card') {
        if (!staticPanels.has(`${id}/${stage.key}`)) {
          unsupported++;
          assert.ok(gaps.some(gap => gap.includes(`${id}/${stage.key}`) && gap.includes('未还原该互动')));
        }
        assert.equal(stage.props.explanation, stage.moreHelp);
      }
    }
  }
  assert.equal(unsupported, 9);
  assert.ok(gaps.every(gap => !gap.includes('没有原型互动的专用 props')));
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
    for (const family of character.family) assert.ok(source.includes(`'${family.text}'`));
  }
  const writing = dqs.basicStages.find(x => x.widget === 'hanzi-write');
  assert.equal(writing.props.characters.length, 12);
  for (const character of writing.props.characters) {
    assert.ok(source.includes(`rad: '${character.parts[0].text}'`));
    assert.ok(source.includes(`tip: '${character.hint}'`));
    for (const family of character.family) assert.ok(source.includes(`'${family.text}'`));
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
