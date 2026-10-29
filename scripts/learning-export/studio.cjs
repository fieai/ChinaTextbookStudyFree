'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE_LESSON_IDS = Object.freeze({
  'g3up-2026-u1-kp1': 'g3up-2026-u1-l01',
  'g3up-2026-u3-kp1': 'g3up-2026-u3-l01',
  'g3down-2026-u1-kp1': 'g3down-2026-u1-l01',
  'chinese-g3up-2026-u1-kp1': 'chinese-g3up-2026-u1-kp1',
  'chinese-g3down-2026-u1-kp1': 'chinese-g3down-2026-u1-kp1',
});

// Read only the prototype's top-level data declarations, without running its UI.
function declaration(source, name) {
  const marker = `  const ${name} = {`;
  const from = source.indexOf(marker);
  const to = source.indexOf('\n  };', from);
  if (from < 0 || to < 0) throw new Error(`Missing prototype declaration: ${name}`);
  return source.slice(from, to + '\n  };'.length);
}

function readPrototype(source) {
  const names = ['META', 'DQS', 'JJ', 'READ', 'VIEWS', 'MM', 'SYM'];
  const code = names.map(name => declaration(source, name)).join('\n');
  const ladder = source.match(/  const ladder = (\[[^\n]+\]);/);
  if (!ladder) throw new Error('Missing prototype recitation ladder');
  const variantSets = source.match(/  const VARIANT_SETS = (\{[^\n]+\});/);
  if (!variantSets) throw new Error('Missing prototype variant bindings');
  // These small helpers retain SETS author data, not its rendered SVG or bank merge.
  const questionCode = `const rulerSVG = () => undefined; const opt = (label, correct, cause) => ({label, correct:!!correct, ...(cause ? {cause} : {})}); const bankQuestions = () => [];\n${declaration(source, 'SETS')}`;
  return JSON.parse(vm.runInNewContext(`${code}\n${questionCode}\nJSON.stringify({${names.join(',')}, SETS, VARIANT_SETS:${variantSets[1]}, ladder:${ladder[1]}})`, {}, { timeout: 1000 }));
}

function parseEvidence(markdown) {
  const result = {};
  for (const section of markdown.split(/^## /m).slice(1)) {
    const sourceId = section.match(/- 课程 ID：`([^`]+)`/)?.[1];
    if (!sourceId) continue;
    const headings = [...section.matchAll(/^### (.+)$/gm)];
    const parts = {};
    headings.forEach((match, i) => {
      parts[match[1]] = section.slice(match.index + match[0].length, headings[i + 1]?.index ?? section.length).trim();
    });
    const stages = name => {
      const text = parts[name];
      if (!text) throw new Error(`Missing ${name}: ${sourceId}`);
      return text.split(/^#### /m).slice(1).map(block => {
        const newline = block.indexOf('\n');
        const heading = block.slice(0, newline).replace(/^\d+\. /, '');
        const split = heading.lastIndexOf(' · ');
        return {
          title: split >= 0 ? heading.slice(0, split) : heading,
          ...(split >= 0 ? { eyebrow: heading.slice(split + 3) } : {}),
          body: block.slice(newline + 1).trim(),
        };
      });
    };
    result[sourceId] = { raw: section, basic: stages('基础关卡（默认态）'), extension: stages('拓展（默认态）') };
  }
  return result;
}

function assertEvidence(meta, evidence, sourceId) {
  if (!evidence) throw new Error(`Missing five-lessons evidence: ${sourceId}`);
  const literals = [meta.hook.q, meta.hook.a, ...meta.keys.flatMap(key => [key.label, key.q, key.a])];
  for (const text of literals) {
    if (!evidence.raw.includes(text)) throw new Error(`Prototype/evidence text mismatch (${sourceId}): ${text}`);
  }
  if (meta.keys.length !== 3) throw new Error(`Expected three takeaways: ${sourceId}`);
}

function buildStudioLessons({ siteDir, evidenceDir }) {
  const studioFile = path.join(siteDir, 'lesson-studio.js');
  const fiveFile = path.join(evidenceDir, 'five-lessons.md');
  const source = fs.readFileSync(studioFile, 'utf8');
  const data = readPrototype(source);
  const evidence = parseEvidence(fs.readFileSync(fiveFile, 'utf8'));
  const patches = {};
  const gaps = [];
  const staticConceptStages = new Set([
    'chinese-g3up-2026-u1-kp1/extension-5',
    'chinese-g3down-2026-u1-kp1/basic-2',
    'chinese-g3down-2026-u1-kp1/basic-4',
    'chinese-g3down-2026-u1-kp1/extension-2',
  ]);
  const unsupportedInteractions = {
    'g3up-2026-u3-l01/extension-1': '原型 MM.units 是生活物体的单位二选一（厘米/毫米），只给 q、正确单位 a 和错答说明 why；unit-convert 的 items 必须有 value/fromUnit/toUnit，只能表达已知单位换算，无法存物体提示、单位选项及逐选项反馈，不为此题编造 fromUnit',
    'g3up-2026-u3-l01/extension-3': '原型 MM.compare 是两个带单位操作数之间选择 >/< /=，并有关系答案及反馈；unit-convert 只有单个 value/fromUnit/toUnit，无右操作数、关系选项或关系答案字段',
    'chinese-g3up-2026-u1-kp1/basic-4': '原型 DQS.words/contexts 有双字词及整词拼音、三种字/拼音显隐模式、原句和教材跳页；char-learn.characters.char 只能是一个汉字，family 仅有 id/text，不能存整词拼音、词卡显隐模式或原句页码',
    'chinese-g3up-2026-u1-kp1/basic-6': '原型 dictation 从 DQS.words 抽取一轮5个词，设备念词后纸上写字、自查错字和错因；char-learn/hanzi-write 只有单字认写，read-aloud 是孩子朗读，没有听写词表、抽题数、逐词流程或听写自查字段，原型亦无可引用的录音文件',
    'chinese-g3up-2026-u1-kp1/extension-2': '原型 DQS.detective 有缺字词语 blank、候选字 options、正确字 answer 和逐候选 why；char-learn 只有 characters/parts/family/hint，不含词语空格、候选答案和逐选项反馈，未将辨字题改作认字',
    'chinese-g3up-2026-u1-kp1/extension-4': '原型 DQS.places/acts 有地点单选、活动最多3项多选和现场组句；所有已冻结 widget props 均无地点/活动选择、选择上限或句式模板字段',
    'chinese-g3down-2026-u1-kp1/extension-1': '原型 JJ.lines/scene 及 poemScene 用选择诗句切换原创SVG中的四组画面并显示逐句说明；concept-card 只有单一可选 image，read-aloud 只有句子和朗读遍，无句子到分组画面的映射及高亮状态，未把SVG臆造为媒体引用',
    'chinese-g3down-2026-u1-kp1/extension-3': '原型 JJ.pairs 是成对词语选择及每一对的对仗说明；char-learn 仅支持单字和部件选择，不能表示两行词语配对及逐对说明',
    'chinese-g3down-2026-u1-kp1/extension-4': '原型 JJ.other/colors 是另一首完整诗、四色标记和设备朗读按钮；read-aloud 必须配置至少一遍 title/goal，但该关没有朗读遍目标，且无颜色标记字段或音频文件，未编写新的朗读遍',
  };
  const exact = text => {
    if (!source.includes(text)) throw new Error(`Missing literal in prototype: ${text}`);
    return text;
  };
  const shapeNames = { tri: 'isosceles', heart: 'heart', rect: 'rectangle', para: 'parallelogram' };
  const axisShapes = { square: 'square', rect: 'rectangle', tri: 'equilateral', circle: 'circle' };
  const builds = list => list.map((build, i) => ({ id: `build-${i + 1}`, name: build.name, visual: { kind: 'voxels', cubes: build.cubes } }));
  const cube = list => ({ widget: 'cube-views', props: { builds: builds(list), directions: ['front', 'right', 'top'] } });
  const concept = stage => ({ widget: 'concept-card', props: { concept: stage.title, explanation: stage.body, reminders: [] } });
  const characters = data.DQS.writeChars.map(item => ({
    id: `write-${item.c}`, char: item.c, pinyin: item.py,
    parts: [{ id: 'radical', text: item.rad }],
    family: item.w.map((word, i) => ({ id: `word-${i + 1}`, text: word })), hint: item.tip,
  }));
  const read = id => ({ widget: 'read-aloud', props: {
    sentences: data.READ[id].text.sentences.map((text, i) => ({
      id: `sentence-${i + 1}`, text,
      ...(data.READ[id].text.pyLines ? { pinyin: data.READ[id].text.pyLines[i] } : {}),
    })),
    passes: data.READ[id].passes.map(pass => ({ id: pass.key, title: pass.title, goal: pass.goal })),
    parentChecks: data.READ[id].parentChecks.map(([id, label]) => ({ id, label })),
  } });

  for (const [prototypeId, sourceLessonId] of Object.entries(SOURCE_LESSON_IDS)) {
    const meta = data.META[prototypeId];
    const proof = evidence[prototypeId];
    if (!meta) throw new Error(`Missing prototype META: ${prototypeId}`);
    assertEvidence(meta, proof, prototypeId);
    function convert(stage, index, extension) {
      const key = `${extension ? 'extension' : 'basic'}-${index + 1}`;
      let widget;
      if (prototypeId === data.VIEWS.id) {
        if (!extension && index === 0) widget = cube(data.VIEWS.builds);
        if (!extension && index === 1) widget = cube([data.VIEWS.builds[0]]);
        if (extension) widget = cube(index === 0 ? data.VIEWS.sameFront : data.VIEWS.deduce);
      } else if (prototypeId === data.MM.id) {
        if (!extension && index === 0) widget = { widget: 'mm-cells', props: { centimeters: 1, cellsPerCentimeter: 10 } };
        if (!extension && index === 1) widget = { widget: 'ruler', props: { start: 0, end: 23, unit: 'mm' } };
        if (extension && index === 1) widget = { widget: 'ruler', props: { start: 40, end: 75, unit: 'mm' } };
      } else if (prototypeId === data.SYM.id) {
        const props = { shapes: [] };
        if (!extension && index === 0) props.shapes = Object.entries(data.SYM.shapes).map(([id, shape]) => ({ id, name: shape.name, visual: { kind: 'shape', shape: shapeNames[id] }, foldAxis: 'vertical' }));
        if (!extension && index === 1) props.shapes = Object.entries(data.SYM.axes).map(([id, shape]) => ({ id, name: shape.name, visual: { kind: 'shape', shape: axisShapes[id] }, foldAxis: 'vertical' }));
        if (extension) {
          props.shapes = [{ id: 'tri', name: data.SYM.shapes.tri.name, visual: { kind: 'shape', shape: 'isosceles' }, foldAxis: 'vertical' }];
          if (index === 0) props.grid = { kind: 'grid', cells: data.SYM.grid.target, columns: data.SYM.grid.cols, rows: data.SYM.grid.rows, half: true };
          if (index === 1) props.characters = data.SYM.chars.map(([char], i) => ({ id: `char-${i + 1}`, char }));
        }
        widget = { widget: 'symmetry-fold', props };
      } else if (prototypeId === data.DQS.id) {
        if (!extension && index === 0) widget = { widget: 'char-learn', props: { characters: data.DQS.readChars.map(([char, pinyin], i) => ({ id: `read-${i + 1}`, char, pinyin })) } };
        if (!extension && index === 1) widget = read(prototypeId);
        if (!extension && index === 4) widget = { widget: 'hanzi-write', props: { characters, mode: 'watch' } };
        if (extension && index === 0) widget = { widget: 'char-learn', props: { characters: data.DQS.families.map((family, i) => ({
          id: `family-${i + 1}`, char: family.head,
          pinyin: data.DQS.readChars.find(([char]) => char === family.head)[1],
          family: family.words.map(([text], j) => ({ id: `word-${j + 1}`, text })),
        })) } };
        if (extension && index === 2) widget = { widget: 'char-learn', props: { characters: data.DQS.soundParts.map((item, i) => ({ id: `sound-${i + 1}`, char: item.c, pinyin: data.DQS.writeChars.find(c => c.c === item.c).py, parts: [{ id: 'meaning', text: item.meaning }, { id: 'sound', text: item.sound }], hint: item.hint })) } };
      } else if (prototypeId === data.JJ.id && !extension && index === 0) widget = read(prototypeId);
      if (!widget) {
        widget = concept(stage);
        const id = `${sourceLessonId}/${key}`;
        if (!staticConceptStages.has(id)) {
          if (!unsupportedInteractions[id]) throw new Error(`Unreviewed concept-card conversion: ${id}`);
          gaps.push(`${id}「${stage.title}」：${unsupportedInteractions[id]}；仅通过 concept-card 原文保留默认态文本，未还原该互动。`);
        }
      }
      return { key, title: stage.title, ...(stage.eyebrow ? { eyebrow: stage.eyebrow } : {}), moreHelp: stage.body, ...widget };
    }
    // Shared questions are assembled by the exporter; report the separate prototype SETS inventory below.
    const basic = proof.basic.map((stage, i) => ({ stage, i })).filter(({ stage }) => !/^课后题|^一题多变|^读懂 · 中心和重点/.test(stage.title)).map(({ stage, i }) => convert(stage, i, false));
    if (prototypeId === data.JJ.id) {
      const passes = data.READ[prototypeId].passes;
      const recitePass = passes.find(pass => pass.key === 'recite');
      basic.splice(1, 0, {
        key: 'recite-ladder', title: recitePass.title, moreHelp: recitePass.goal, widget: 'recite-ladder', props: {
          sentences: data.JJ.lines.map(([text, pinyin, punct], i) => ({ id: `sentence-${i + 1}`, text: text + punct, pinyin })),
          levels: data.ladder.map((label, i) => ({ id: `level-${i + 1}`, label, reveal: ['all', 'first-two', 'first', 'none'][i] })),
        },
      });
    }
    patches[sourceLessonId] = {
      level: 'studio',
      opening: { question: meta.hook.q, reveal: meta.hook.a },
      takeaways: meta.keys.map(item => ({ id: item.id, text: item.label })),
      basicStages: basic,
      cards: meta.keys.map((item, i) => ({ key: item.id, kind: prototypeId.startsWith('chinese-') ? (prototypeId === data.DQS.id && i < 2 ? 'character' : 'reading') : 'concept', label: item.label, prompt: item.q, answer: item.a })),
      extension: { title: '拓展', stages: proof.extension.map((stage, i) => convert(stage, i, true)) },
      ...(meta.teach ? { teachBack: { prompts: meta.teach.prompts.map((text, i) => ({ id: `prompt-${i + 1}`, text })) } } : {}),
    };
  }
  gaps.push(
    'g3up-2026-u1-l01：cube-views props 可存搭法与观察方向，但不能存原型推一推的两个已知投影、推理揭晓状态；默认态文字保留于 moreHelp。',
    'g3up-2026-u3-l01：ruler props 不能表达断尺显示范围 4–10 厘米、起点预设按钮或原型的逐步读数文案；保留真实起终点 40/75 mm，未猜测新增 props。',
    'g3down-2026-u1-l01：symmetry-fold props 无原型每图 yes、完整对称轴坐标/条数和逐条展示顺序、汉字对称答案；保留图形枚举、竖直折线、完整原始目标格及汉字，未推定额外 props。',
    'chinese-g3up-2026-u1-kp1：read-aloud props 不支持原型逐字 ruby、自然段分组、停顿/语气标记、设备录音与复习遍；hanzi-write props 不携带 Make Me a Hanzi 笔顺数据。原型正文/三遍目标/家长勾选项及会写字提示已逐字导出。',
    'chinese-g3up-2026-u1-kp1：字族已用 char-learn 显式保留4个根字、原型拼音及全部12个词。family 仅有 id/text，不能存每词拼音和释义；默认扬字族的拼音/释义还保留在该关 moreHelp，其他三字族的拼音/释义未进入契约字段。会写字已保留原型 rad 为 parts、w 为 family、tip 为 hint；CharacterSchema 无结构 jg、笔画数 n、why/use/warn/wrong 专用字段。',
    'chinese-g3up-2026-u1-kp1：原型小老师按孩子选择 1–3 字动态生成，契约 teachBack 只有固定 prompts；未替孩子选字或编写 prompts。',
    '五课：契约 teachBack 不能单独携带 META.teach.wrongs 家长故意出错卡；原文仍可从已哈希输入的 five-lessons.md 追溯。',
    '五课：已从 basicStages 移除原型课后题、读懂题及一题多变关卡。导出器的 homework 取 output 源题及 assign-v2 归属，不等同原型 SETS；原型手工 tb*/c* 题与 output 题须逐题核对，未核对时不得宣称已由 homework 承接。完整原型手工题清单由 prototypeQuestionSets 返回。',
    '五课：META.keys 没有 gen/generator 字段，原型 collectCards 也只拷贝 key.q/key.a，因此3张静态卡未臆测 generator。动态变式的 generator 绑定仅在 VARIANT_SETS，已由 variantGenerators 返回供独立导入；当前 studio patches 未把动态生成题或其错因卡写入静态内容包，不能宣称 variants 已覆盖原型随机变式。',
    '五课内容沿用冻结原型，尚未经教师审定；studio 表示内容层级，不表示教师审定。',
  );
  // Assert a literal used as a section label is present in the evidence as well.
  exact('先猜后折');
  const prototypeQuestionSets = Object.fromEntries(Object.entries(data.SETS).map(([id, questions]) => [SOURCE_LESSON_IDS[id], questions]));
  const variantGenerators = Object.fromEntries(Object.entries(data.VARIANT_SETS).map(([id, keys]) => [SOURCE_LESSON_IDS[id], keys]));
  return { patches, gaps, prototypeQuestionSets, variantGenerators, inputFiles: [studioFile, fiveFile] };
}

module.exports = { SOURCE_LESSON_IDS, buildStudioLessons, readPrototype, parseEvidence };
