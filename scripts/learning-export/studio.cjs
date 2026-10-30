'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLanguageConverter } = require('./studio-language.cjs');
const { createMathConverter } = require('./studio-math.cjs');

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

function buildStudioLessons({ siteDir, evidenceDir, strokeDataByCharacter = {} }) {
  const studioFile = path.join(siteDir, 'lesson-studio.js');
  const fiveFile = path.join(evidenceDir, 'five-lessons.md');
  const source = fs.readFileSync(studioFile, 'utf8');
  const data = readPrototype(source);
  const evidence = parseEvidence(fs.readFileSync(fiveFile, 'utf8'));
  const patches = {};
  const gaps = [];
  const widgetGradings = {};
  const math = createMathConverter(data, source);
  const language = createLanguageConverter(data, source, strokeDataByCharacter);
  const staticConceptStages = new Set([
    'chinese-g3up-2026-u1-kp1/extension-5',
    'chinese-g3down-2026-u1-kp1/basic-2',
    'chinese-g3down-2026-u1-kp1/basic-4',
    'chinese-g3down-2026-u1-kp1/extension-2',
  ]);
  const exact = text => {
    if (!source.includes(text)) throw new Error(`Missing literal in prototype: ${text}`);
    return text;
  };
  const concept = stage => ({ widget: 'concept-card', props: { concept: stage.title, explanation: stage.body, reminders: [] } });

  for (const [prototypeId, sourceLessonId] of Object.entries(SOURCE_LESSON_IDS)) {
    const meta = data.META[prototypeId];
    const proof = evidence[prototypeId];
    if (!meta) throw new Error(`Missing prototype META: ${prototypeId}`);
    assertEvidence(meta, proof, prototypeId);
    function convert(stage, index, extension) {
      const key = `${extension ? 'extension' : 'basic'}-${index + 1}`;
      const converted = math(prototypeId, index, extension) || language.convert(prototypeId, index, extension);
      let widget;
      if (converted) {
        const { grading, ...definition } = converted;
        widget = definition;
        if (grading) (widgetGradings[sourceLessonId] ||= []).push({ stageKey: key, content: { ...definition, grading } });
      }
      if (!widget) {
        widget = concept(stage);
        const id = `${sourceLessonId}/${key}`;
        if (!staticConceptStages.has(id)) throw new Error(`Unreviewed concept-card conversion: ${id}`);
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
          presentation: 'ladder', sentences: language.poemSentences(),
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
      ...(language.teachBack(prototypeId) ? { teachBack: language.teachBack(prototypeId) } : {}),
    };
  }
  gaps.push(
    '绝句 basic-4「写对 · 容易写错的字」仍是静态字形提示（鸳、鸯、融、暖）；原型 stroke-data.js 没有这四字的笔顺数据，未伪造 Character.strokeData。笔顺覆盖统计的 12/12 指大青树 hanzi-write 的会写字。',
    '毫米尺：readoutSteps 保存原型默认端点的真实读数示例；契约没有动态读数模板，移动端点后的文案变化由组件根据 start/end 生成。',
    '语文：read-aloud 已导出自然段、分段、注音 spans、节奏停顿、语气、逐遍自评和家长任务。原型 reviewPass 是复习模式替代遍，契约没有对应专槽，未把它追加为必做新遍；设备 TTS 和本机临时录音不是可哈希媒体，未伪造 audio 引用。',
    '绝句 extension-1：sceneParts.visualKey 保留四组原创画面稳定键（jj-scene-1 至 jj-scene-4）；契约没有 SVG 媒体字段，实际画面需由消费端按键实现。extension-4 用 listen 和四色 spans 表达，只听完整诗，未编造朗读遍。',
    '大青树 extension-4：imitation.template 按原型组句结构导出为“下课了，同学们在{place}{actions}……”，place/actions 为选项替换位；契约没有模板语法约定，消费端仍需对齐这两个占位符。',
    '大青树小老师：原型 META[DQS.id] 没有 teach/wrongs，实际 dqsTeach 按 DQS.writeChars[].wrong 渲染家长故意出错卡，已逐条导出全部16条及“让孩子来纠正”任务。12 个会写字均有 characterPrompts；孩子最多选择 3 字的限制、按所选字动态显示家长卡，以及动态读顺卡/错字卡持久化不在当前作者字段表达范围。',
    '五课：已从 basicStages 移除原型课后题、读懂题及一题多变关卡。导出器的 homework 取 output 源题及 assign-v2 归属，不等同原型 SETS；原型手工 tb*/c* 题与 output 题须逐题核对，未核对时不得宣称已由 homework 承接。完整原型手工题清单由 prototypeQuestionSets 返回。',
    '五课：META.keys 没有 gen/generator 字段，原型 collectCards 也只拷贝 key.q/key.a，因此3张静态卡未臆测 generator。动态变式的 generator 绑定仅在 VARIANT_SETS，已由 variantGenerators 返回供独立导入；当前 studio patches 未把动态生成题或其错因卡写入静态内容包，不能宣称 variants 已覆盖原型随机变式。',
    '五课内容沿用冻结原型，尚未经教师审定；studio 表示内容层级，不表示教师审定。',
  );
  // Assert a literal used as a section label is present in the evidence as well.
  exact('先猜后折');
  const prototypeQuestionSets = Object.fromEntries(Object.entries(data.SETS).map(([id, questions]) => [SOURCE_LESSON_IDS[id], questions]));
  const variantGenerators = Object.fromEntries(Object.entries(data.VARIANT_SETS).map(([id, keys]) => [SOURCE_LESSON_IDS[id], keys]));
  return { patches, gaps, widgetGradings, prototypeQuestionSets, variantGenerators, inputFiles: [studioFile, fiveFile] };
}

module.exports = { SOURCE_LESSON_IDS, buildStudioLessons, readPrototype, parseEvidence };
