'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPrototype } = require('./studio.cjs');
const { createMathConverter } = require('./studio-math.cjs');

const siteDir = process.env.LEARNING_EXPORT_SITE_DIR || '/Users/shouzongchang/Documents/ZCTD/ChinaTextbookStudyFree/deploy-output/family-learning-share-20261027-button-stability/site';
const contractDir = process.env.LEARNING_EXPORT_CONTRACT_DIR || '/Users/my-project/AI-PROJECT/thinky/packages/learning-contract/dist';
const source = fs.readFileSync(path.join(siteDir, 'lesson-studio.js'), 'utf8');
const data = readPrototype(source);
const convert = createMathConverter(data, source);

test('unit-choice preserves the four real prompts and private per-option prototype feedback', () => {
  const result = convert(data.MM.id, 0, true);
  assert.equal(result.widget, 'unit-choice');
  assert.equal(result.props.items.length, 4);
  assert.deepEqual(result.props.items.map(item => item.prompt), data.MM.units.map(([q]) => q));
  result.props.items.forEach((item, i) => {
    const [q, a, why] = data.MM.units[i];
    const grade = result.grading.items[i];
    assert.deepEqual(item.options, ['厘米', '毫米']);
    assert.deepEqual(grade, {
      id: item.id, answer: a, explanation: why,
      optionExplanations: Object.fromEntries(item.options.map(option => [option, option === a ? `${q} ${a}。` : why])),
    });
    assert.ok(!JSON.stringify(result.props).includes(why));
    assert.deepEqual(Object.keys(item).sort(), ['id', 'options', 'prompt']);
  });
});

test('unit-compare keeps both operands and all relationship feedback in grading', () => {
  const { widget, props, grading } = convert(data.MM.id, 2, true);
  assert.equal(widget, 'unit-compare');
  assert.equal(props.items.length, 3);
  props.items.forEach((item, i) => {
    const [left, right, answer, why] = data.MM.compare[i];
    assert.deepEqual(item, { id: `compare-${i + 1}`, left, right });
    assert.deepEqual(grading.items[i], {
      id: item.id, answer, explanation: why,
      optionExplanations: { '>': why, '<': why, '=': why },
    });
    assert.ok(!JSON.stringify(props).includes(why));
  });
});

test('cube activities preserve actual builds and explicit front/top deduction clues', () => {
  const observe = convert(data.VIEWS.id, 0, false).props;
  const build = convert(data.VIEWS.id, 1, false).props;
  const compare = convert(data.VIEWS.id, 0, true).props;
  const deduce = convert(data.VIEWS.id, 1, true).props;
  assert.deepEqual([observe.activity, build.activity, compare.activity, deduce.activity], ['observe', 'build', 'compare', 'deduce']);
  assert.deepEqual(observe.builds.map(item => item.visual.cubes), data.VIEWS.builds.map(item => item.cubes));
  // The prototype build activity uses the build chosen in the observe activity.
  assert.equal(build.buildSourceStageKey, 'basic-1');
  assert.deepEqual(build.builds, observe.builds);
  assert.deepEqual(compare.directions, ['front', 'top']);
  assert.deepEqual(compare.builds.map(item => item.visual.cubes), data.VIEWS.sameFront.map(item => item.cubes));
  assert.deepEqual(deduce.builds.map(item => item.visual.cubes), data.VIEWS.deduce.map(item => item.cubes));
  assert.deepEqual(deduce.knownProjections, ['front', 'top'].map(direction => ({
    direction, visual: { kind: 'projection', grid: [[false, true, false], [true, true, true]] },
  })));
  for (const phrase of deduce.explanation.split('\n')) assert.ok(source.includes(phrase));
});

test('ruler exports the 4–10 cm viewport, both preset endpoints and ordered author readout text', () => {
  const regular = convert(data.MM.id, 1, false).props;
  assert.deepEqual(regular.viewport, { fromMm: 0, toMm: 80 });
  assert.equal(regular.editable, true);
  assert.deepEqual(regular.presets.map(({ start, end }) => [start, end]), [[0, 23], [30, 53]]);
  assert.ok(source.includes('s.end = s.start + 23'));
  assert.deepEqual(regular.readoutSteps, ['终点 2 厘米 3 毫米 − 起点 0 毫米', '= 2 厘米 3 毫米 = 23 毫米', regular.readingHints.zero]);
  const broken = convert(data.MM.id, 1, true).props;
  assert.deepEqual(broken.viewport, { fromMm: 40, toMm: 100 });
  assert.deepEqual([broken.start, broken.end, broken.brokenEdge, broken.editable], [40, 75, true, false]);
  for (const phrase of broken.readoutSteps) assert.ok(source.includes(phrase));
  const mm = convert(data.MM.id, 0, false).props;
  assert.ok(source.includes(mm.captions.cells));
  assert.ok(source.includes(mm.captions.lines));
});

test('symmetry separates fold feedback, ordered axis counts and character answers from public shapes', () => {
  const fold = convert(data.SYM.id, 0, false);
  for (const [id, shape] of Object.entries(data.SYM.shapes)) {
    assert.equal(fold.grading.shapes[id].symmetric, shape.yes);
    const feedback = fold.grading.shapes[id].feedback;
    assert.equal(feedback.correctGuess, '你猜对了。');
    assert.equal(feedback.incorrectGuess, '和你猜的不一样，再看一看。');
    assert.equal(shape.yes ? feedback.match : feedback.mismatch, shape.yes
      ? `完全重合！${shape.name}是轴对称图形，折痕就是对称轴。`
      : '对不上，有的地方露出来了。平行四边形沿这条线折不能重合。');
  }
  const axes = convert(data.SYM.id, 1, false);
  for (const [id, shape] of Object.entries(data.SYM.axes)) {
    assert.deepEqual(axes.grading.shapes[id].axes.lines, shape.lines);
    assert.equal(axes.grading.shapes[id].axes.count, id === 'circle' ? 'infinite' : shape.lines.length);
  }
  const chars = convert(data.SYM.id, 1, true);
  assert.equal(chars.props.activity, 'characters');
  assert.deepEqual(chars.props.shapes, []);
  data.SYM.chars.forEach(([char, yes], i) => {
    assert.deepEqual(chars.props.characters[i], { id: `char-${i + 1}`, char });
    assert.equal(chars.grading.characters[`char-${i + 1}`].symmetric, yes);
  });
  for (const { props } of [fold, axes, chars])
    assert.ok(!/"(?:symmetric|feedback|axes|answer|optionExplanations)":/.test(JSON.stringify(props)));
  const grid = convert(data.SYM.id, 0, true);
  assert.equal(grid.props.activity, 'complete-grid');
  assert.deepEqual(grid.props.shapes, []);
  assert.deepEqual(grid.props.grid.cells, data.SYM.grid.target);
});

test('every mathematical public widget and private authoring pair validates against built v1.6 schema', async () => {
  const contract = await import(path.join(contractDir, 'index.js'));
  const publicSchemas = {
    'cube-views': contract.CubeViewsPropsSchema, ruler: contract.RulerPropsSchema,
    'mm-cells': contract.MmCellsPropsSchema, 'symmetry-fold': contract.SymmetryFoldPropsSchema,
    'unit-choice': contract.UnitChoicePropsSchema, 'unit-compare': contract.UnitComparePropsSchema,
  };
  const authoringSchemas = {
    'symmetry-fold': contract.SymmetryFoldAuthoringSchema,
    'unit-choice': contract.UnitChoiceAuthoringSchema, 'unit-compare': contract.UnitCompareAuthoringSchema,
  };
  let count = 0, privateCount = 0;
  for (const id of [data.VIEWS.id, data.MM.id, data.SYM.id]) {
    for (const extension of [false, true]) for (let i = 0; i < 5; i++) {
      const result = convert(id, i, extension);
      if (!result) continue;
      count++;
      assert.deepEqual(publicSchemas[result.widget].parse(result.props), result.props);
      if (result.grading) {
        privateCount++;
        authoringSchemas[result.widget].parse({ props: result.props, grading: result.grading });
        assert.equal(publicSchemas[result.widget].safeParse({ ...result.props, grading: result.grading }).success, false);
      }
    }
  }
  assert.equal(count, 13);
  assert.equal(privateCount, 5);
});

test('conversion fails if required author instructions drift instead of fabricating replacements', () => {
  assert.throws(() => createMathConverter(data, source.replace('从 0 开始，终点的读数就是长度。', '已改文案')), /Missing math prototype literal/);
  assert.equal(convert('unrelated-lesson', 0, false), undefined);
});
