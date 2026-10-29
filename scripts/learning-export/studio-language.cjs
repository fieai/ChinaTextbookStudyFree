'use strict';

// Convert author data only. Runtime TTS, recording and child state are not media.
function createLanguageConverter(data, source, strokeDataByCharacter = {}) {
  const { DQS, JJ, READ } = data;
  const literal = text => {
    if (!source.includes(text)) throw new Error(`Missing prototype language text: ${text}`);
    return text;
  };
  const words = DQS.words.map(([text, pinyin], i) => ({
    id: `word-${i + 1}`, text, pinyin,
    context: { text: DQS.contexts[text][1], physicalPage: DQS.contexts[text][0] },
  }));
  const characters = DQS.writeChars.map(item => ({
    id: `write-${item.c}`, char: item.c, pinyin: item.py,
    parts: [{ id: 'radical', text: item.rad }],
    family: item.w.map((text, i) => ({ id: `word-${i + 1}`, text })),
    structure: item.jg, strokeCount: item.n, explanation: item.why,
    usage: item.use, warning: item.warn, commonMistakes: item.wrong, hint: item.tip,
    ...(strokeDataByCharacter[item.c] ? { strokeData: strokeDataByCharacter[item.c] } : {}),
  }));
  function readingSentences(id) {
    const cfg = READ[id], T = cfg.text;
    return T.sentences.map((text, i) => {
      const pinyin = T.pyLines?.[i];
      const syllables = pinyin?.split(' ');
      const segments = cfg.poem
        ? [{ text: [...text].slice(0, 2).join(''), pinyin: syllables.slice(0, 2).join(' ') }, { text: [...text].slice(2).join(''), pinyin: syllables.slice(2).join(' ') }]
        : text.match(/[^，]+，|[^，]+$/gu).map(text => ({ text }));
      const spans = [...text].map((char, j) => ({ text: char,
        ...(cfg.poem ? (syllables[j] ? { pinyin: syllables[j] } : {}) : (T.py[char] ? { pinyin: T.py[char] } : {})),
        role: cfg.poem && T.rhyme[i] === j ? 'emphasis' : 'text',
      }));
      return { id: `sentence-${i + 1}`, text, ...(pinyin ? { pinyin } : {}), segments, spans,
        paragraphId: `paragraph-${T.paragraphs.findIndex(para => para.includes(i)) + 1}`,
        ...(T.tone?.[i] ? { toneHint: T.tone[i] } : {}),
      };
    });
  }
  function read(id) {
    const cfg = READ[id], sentences = readingSentences(id);
    return { widget: 'read-aloud', props: {
      presentation: 'reading', sentences,
      passes: cfg.passes.map(pass => ({
        id: pass.key, title: pass.title, goal: pass.goal,
        ask: pass.ask, ratingLabels: { clear: pass.ok, unclear: pass.meh },
        presentation: { pinyin: pass.key === 'accurate',
          ...((pass.key === 'fluent' || pass.key === 'rhythm') ? { pauses: sentences.flatMap((sentence, i) => {
            if (cfg.poem) return [{ sentenceId: sentence.id, afterSegment: 0 }];
            return cfg.text.pauses.includes(i) ? sentence.segments.flatMap((segment, j) => segment.text.endsWith('，') ? [{ sentenceId: sentence.id, afterSegment: j }] : []) : [];
          }) } : {}),
        },
      })),
      parentChecks: cfg.parentChecks.map(([id, label]) => ({ id, label })),
      parentTitle: cfg.parentTitle, parentAsk: cfg.parentAsk,
      understanding: { question: cfg.understandQ, hints: cfg.hints, more: cfg.understandMore },
    } };
  }
  const poemSentences = () => readingSentences(JJ.id);
  function convert(prototypeId, index, extension) {
    if (prototypeId === DQS.id) {
      if (!extension && index === 0) return { widget: 'char-learn', props: { activity: 'characters', characters: DQS.readChars.map(([char, pinyin], i) => ({ id: `read-${i + 1}`, char, pinyin })) } };
      if (!extension && index === 1) return read(prototypeId);
      if (!extension && index === 3) return { widget: 'char-learn', props: { activity: 'words', characters: [], words, mode: 'word-and-pinyin', sourceNote: literal('词语来自本课词语表；词语拼音按《现代汉语词典》标注，“热闹”的“闹”读轻声。'), instructions: literal('点小喇叭听一听，跟着读。读熟了换成“只看拼音·写”。') } };
      if (!extension && index === 4) return { widget: 'hanzi-write', props: { characters, mode: 'watch', initialCharacterId: 'write-飘' } };
      if (!extension && index === 5) return { widget: 'char-learn', props: { activity: 'dictation', characters: [], words, mode: 'pinyin-only', dictation: { count: 5, kinds: DQS.wrongKinds.map((label, i) => ({ id: `kind-${i + 1}`, label })) }, instructions: literal('听一个，在纸上写一个') } };
      if (extension && index === 0) return { widget: 'char-learn', props: { activity: 'family', characters: DQS.families.map((family, i) => ({
        id: `family-${i + 1}`, char: family.head, pinyin: DQS.readChars.find(([char]) => char === family.head)[1],
        family: family.words.map(([text, pinyin, meaning], j) => ({ id: `word-${j + 1}`, text, pinyin, meaning })),
      })), sourceNote: literal('词语来自课本第 4 页；释义为原创的儿童化说明。') } };
      if (extension && index === 1) {
        const detective = DQS.detective.map((item, i) => ({ id: `detective-${i + 1}`, blank: item.blank, options: item.options.map((text, j) => ({ id: `option-${j + 1}`, text })) }));
        const grading = { detective: Object.fromEntries(DQS.detective.map((item, i) => [detective[i].id, {
          answer: detective[i].options.find(option => option.text === item.answer).id,
          optionExplanations: Object.fromEntries(detective[i].options.map(option => [option.id, item.why[option.text]])),
        }])) };
        return { widget: 'char-learn', props: { activity: 'detective', characters: [], detective, sourceNote: literal('原创辨字练习，只给提示，不计分。') }, grading };
      }
      if (extension && index === 2) {
        const characters = DQS.soundParts.map((item, i) => ({ id: `sound-${i + 1}`, char: item.c,
          pinyin: DQS.writeChars.find(c => c.c === item.c).py,
          question: literal('哪一半提示读音？'),
          parts: [{ id: 'meaning', text: item.meaning }, { id: 'sound', text: item.sound }],
        }));
        const grading = { characters: Object.fromEntries(DQS.soundParts.map((item, i) => [characters[i].id, {
          correctPartId: 'sound', feedback: { sound: `对！“${item.sound}”读 ${item.soundPy}。${item.hint}`, meaning: `“${item.meaning}”管意思。${item.hint}` },
        }])) };
        return { widget: 'char-learn', props: { activity: 'parts', characters, sourceNote: literal('原创归纳；声旁只提示读音，不一定读得完全一样。') }, grading };
      }
      if (extension && index === 3) return { widget: 'char-learn', props: { activity: 'imitation', characters: [], imitation: {
        places: DQS.places.map((text, i) => ({ id: `place-${i + 1}`, text })), actions: DQS.acts.map((text, i) => ({ id: `action-${i + 1}`, text })),
        maxActions: 3, template: '下课了，同学们在{place}{actions}……',
      }, sourceNote: literal('地点选项来自课本第 4 页第 3 题；句子为原创仿写练习。'), instructions: literal('在纸上写下这句话，再加一句“连＿＿也来＿＿”。') } };
    }
    if (prototypeId === JJ.id) {
      if (!extension && index === 0) return read(prototypeId);
      if (extension && index === 0) return { widget: 'recite-ladder', props: { presentation: 'scene', sentences: poemSentences(), levels: [], sceneParts: JJ.scene.map((description, i) => ({ id: `scene-${i + 1}`, sentenceId: `sentence-${i + 1}`, description, visualKey: `jj-scene-${i + 1}` })), initialCaption: literal('四句诗，四个画面。先点第一句。'), sourceNote: literal('原创示意图，非教材插图。') } };
      if (extension && index === 2) return { widget: 'recite-ladder', props: { presentation: 'pairs', sentences: poemSentences(), levels: [], pairs: JJ.pairs.map(([upper, lower], i) => ({ id: `pair-${i + 1}`, upper, lower, explanation: literal(['“泥”对“沙”，都是地上的东西；“融”对“暖”，都说春天的变化。', '“飞”是动，“睡”是静，一动一静。', '“燕子”对“鸳鸯”，都是鸟。'][i]) })), initialCaption: literal('点一对，看它们怎样对上。') } };
      if (extension && index === 3) return { widget: 'read-aloud', props: { presentation: 'listen', passes: [], parentChecks: [], sentences: JJ.other.map((text, i) => ({ id: `other-${i + 1}`, text, paragraphId: `paragraph-${i + 1}`, spans: [...text].map(char => {
        const color = JJ.colors.find(([key]) => key === char);
        return { text: char, role: color ? 'color' : 'text', ...(color ? { token: color[1] } : {}) };
      }) })), instructions: literal('这一首藏着四种颜色：黄、翠、白、青。比一比：两首诗都写春天，哪一首颜色更多？') } };
    }
    return undefined;
  }
  function teachBack(prototypeId) {
    const meta = data.META[prototypeId];
    if (prototypeId === DQS.id) return {
      prompts: [{ id: 'choose-characters', text: literal('挑 3 个你觉得最难的会写字，讲给爸爸妈妈听。') }],
      characterPrompts: characters.map(character => ({ characterId: character.id, prompts: [
        '这个字读____。', '它的偏旁是____，因为____。', '我组个词：____，说一句话：____。', '小心：别写成____。',
      ].map((text, i) => ({ id: `prompt-${i + 1}`, text: literal(text) })) })),
      parentErrorCards: DQS.writeChars.flatMap((item, i) => item.wrong.map((text, j) => ({ id: `error-${i + 1}-${j + 1}`, text: `${text}，让孩子来纠正。` }))),
    };
    return meta.teach ? {
      prompts: meta.teach.prompts.map((text, i) => ({ id: `prompt-${i + 1}`, text })),
      parentErrorCards: meta.teach.wrongs.map((text, i) => ({ id: `error-${i + 1}`, text: `${text}，让孩子来纠正。` })),
    } : undefined;
  }
  return { convert, teachBack, poemSentences };
}

module.exports = { createLanguageConverter };
