'use strict'

function statistics(content, pagesManifest, bookEvidence, cards = { lessons: [] }) {
  return content.books.map(book => {
    const pages = pagesManifest.books.find(item => item.sourceBookId === book.sourceBookId)
    const byLessonKind = {}
    for (const { content: lesson } of book.lessons) {
      const counts = byLessonKind[lesson.lessonKind] ??= { studio: 0, 'textbook-only': 0 }
      counts[lesson.level]++
    }
    return {
      ...bookEvidence.find(item => item.sourceBookId === book.sourceBookId),
      sourceBookId: book.sourceBookId, lessons: book.lessons.length,
      studio: book.lessons.filter(lesson => lesson.content.level === 'studio').length,
      textbookOnly: book.lessons.filter(lesson => lesson.content.level === 'textbook-only').length,
      byLessonKind,
      lessonsWithCards: book.lessons.filter(lesson => lesson.content.cards.length).length,
      cardCount: book.lessons.reduce((sum, lesson) => sum + lesson.content.cards.length, 0),
      noCardLessons: book.lessons.filter(lesson => !lesson.content.cards.length).map(({ content: lesson }) => ({
        sourceLessonId: lesson.sourceLessonId, title: lesson.title,
        reasons: cards.lessons.find(item => item.sourceLessonId === lesson.sourceLessonId)?.reasons ?? [],
      })),
      questions: content.questions.filter(question => question.sourceBookId === book.sourceBookId).length,
      knowledgePoints: content.knowledgePoints.filter(point => point.sourceBookId === book.sourceBookId).length,
      pageImages: pages.pages.length,
      missingPrintedPages: pages.pages.filter(page => page.printedPage === null).map(page => page.page),
      noHomeworkLessons: book.lessons.filter(lesson => !lesson.content.homework.questionRefs.length).map(lesson => lesson.content.sourceLessonId),
    }
  })
}

function sharedEndpoints(content) {
  const warnings = []
  for (const book of content.books.filter(book => book.subject === 'math')) {
    const sorted = [...book.lessons].sort((a, b) => a.content.textbookPages.from - b.content.textbookPages.from)
    sorted.forEach((lesson, index) => {
      for (const previous of sorted.slice(0, index)) {
        if (previous.content.textbookPages.to === lesson.content.textbookPages.from) warnings.push({
          code: 'D9_SHARED_ENDPOINT', sourceBookId: book.sourceBookId,
          lessons: [previous.content.sourceLessonId, lesson.content.sourceLessonId],
          physicalPage: lesson.content.textbookPages.from,
          message: 'D9 允许的首尾共页；课时页段未裁改。',
        })
      }
    })
  }
  return warnings
}

function markdownReport(report) {
  const lines = [
    '# 三年级四册内容导出报告', '',
    `- sourceRevision: \`${report.sourceRevision}\``,
    `- 契约校验：${report.valid ? '通过' : '阻断'}`,
    `- manifestSha256: \`${report.manifestSha256}\``,
    `- 输入摘要：\`${report.inputSha256}\``,
    `- 页图清单摘要：\`${report.pagesManifestSha256}\``,
    `- 物理页 ${report.assets.physicalPages}；按内容去重后 media 文件 ${report.assets.uniqueMediaFiles}。`,
    '- 来源文件、逐题原始数据及规则出处完整保存在 report.json。',
    '- 每册总页数、PDF SHA256、逐页印刷页号证据及媒体路径保存在 report.json 的 books 中。',
    '', '| 教材 | 课程 | studio | textbook-only | 题目 | 知识点 | 页图 | 缺印刷页号 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const book of report.books) lines.push(`| ${book.sourceBookId} | ${book.lessons} | ${book.studio} | ${book.textbookOnly} | ${book.questions} | ${book.knowledgePoints} | ${book.pageImages} | ${book.missingPrintedPages.length} |`)
  if (report.chineseBasicStages) {
    lines.push('', '## 三年级语文基础关覆盖', '',
      '| 教材 | 教材编号课 | 拆篇后课时 | 有基础关 | 新生成 / 保留样板 | 读课文 | 认读生字 | 词语 | 写字 | 听写 |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const book of report.chineseBasicStages.books) {
      const c = book.stageCounts
      lines.push(`| ${book.sourceBookId} | ${book.numberedSourceLessons} | ${book.numberedLessons} | ${book.lessonsWithBasicStages} | ${book.generatedLessons} / ${book.preservedStudio} | ${c.reading} | ${c.characters} | ${c.words} | ${c.writing} | ${c.dictation} |`)
    }
    lines.push('', '两节 studio 样板保留原活动，字词显示拼音统一应用本轮标注规则。其余编号课在 textbook-only 层级携带 basicStages；不新增开场或三件事。',
      '组诗只拆分所属诗句；识写字表按教材编号课共用，并在关内标注。写字缺笔顺时省略 strokeData，保留看字形、纸上练写；缺可靠拼音时省略拼音字段。',
      '', '### 逐课关卡与缺失原因', '')
    for (const book of report.chineseBasicStages.books) {
      lines.push(`- ${book.sourceBookId} 缺笔顺字（去重 ${book.missingStrokeCharacters.length}）：${book.missingStrokeCharacters.join('、') || '无'}。`)
      for (const lesson of book.lessons) {
        lines.push(`- ${lesson.sourceLessonId} ${lesson.title}：${lesson.preservedStudio ? '保留 studio；' : ''}${lesson.stages.join('、') || '无基础关'}。`)
        for (const item of lesson.missing) lines.push(`  - ${item.kind}：${item.reason}`)
        if (lesson.missingStrokeCharacters.length) lines.push(`  - 缺笔顺：${lesson.missingStrokeCharacters.join('、')}。`)
        if (lesson.writingWithoutPinyin.length) lines.push(`  - 写字未注音：${lesson.writingWithoutPinyin.join('、')}。`)
        if (lesson.wordsWithoutPinyin.length) lines.push(`  - 词语未注音：${lesson.wordsWithoutPinyin.join('、')}。`)
        for (const issue of lesson.dataIssues) lines.push(`  - 源数据问题：${issue}`)
      }
    }
  }
  if (report.pinyin) {
    lines.push('', '## 拼音来源与人工核对', '', report.pinyin.scope, '',
      '| 教材 | 类别 | 总数 | textbook | reviewed | dictionary | 待核对隐藏 |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |')
    for (const book of report.pinyin.books) for (const [kind, title] of [['words', '词语（含听写、字族）'], ['characters', '字（识字、写字及扩展）']]) {
      const c = book[kind]
      lines.push(`| ${book.sourceBookId} | ${title} | ${c.total} | ${c.textbook} | ${c.reviewed} | ${c.dictionary} | ${c.pendingHidden} |`)
    }
    lines.push('', '原稿条目统计（每教材编号课一次，不重复计算组诗、听写）：', '',
      '| 教材 | 类别 | 总数 | textbook | reviewed | dictionary | 待核对隐藏 |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |')
    for (const [id, book] of Object.entries(report.pinyin.annotations || {})) for (const [kind, title] of [['words', '词语'], ['characters', '字'], ['supplementalWords', '原型补充字族词（与词表有交集）']]) {
      const c = book[kind]
      lines.push(`| ${id} | ${title} | ${c.total} | ${c.textbook} | ${c.reviewed} | ${c.dictionary} | ${c.pendingHidden} |`)
    }
    lines.push('', `核对清单：\`${report.pinyin.reviewMarkdown}\`；编辑 \`${report.pinyin.reviewFile}\` 中 decision 为完整拼音或 \`hide\`，重跑标注与导出。`,
      '待核对不输出 pinyin/pinyinSource，也不输出空串。教材标调惯例待确认；含“一/不”的词可通过清单 JSON 顶层 decision.yiBuToneStyle 一次选择 original（本调）或 sandhi（变调），逐条 decision 可覆盖。',
      'TTS 仍使用原有文本、组词、带词读与覆写，显示标注在音频选择之后应用；本轮不合成音频。')
    if (report.pinyin.reviewSummary) {
      const r = report.pinyin.reviewSummary
      lines.push(`核对条目 ${r.total}；待核对 ${r.pending}；已确认 ${r.confirmed}；明确隐藏 ${r.hide}；过期决定 ${r.staleDecisions}。`)
    }
  }
  if (report.cards) {
    lines.push('', '## 卡片覆盖与来源', '', '| 教材 | 有卡片课数 / 总课数 | 卡片总数 |', '| --- | ---: | ---: |')
    for (const book of report.books) lines.push(`| ${book.sourceBookId} | ${book.lessonsWithCards} / ${book.lessons} | ${book.cardCount} |`)
    lines.push('', '每个新增有卡片课程为 3–8 张；studio 五课原卡片不变。来源与逐卡出处见 report.json.cards。',
      '数学概念、结论和提示取冻结原型的项目原创配套讲解，未经教师审定；题库也属于项目配套，非教材课后原题。语文字词、古诗只采用当前教材哈希匹配且 reviewed、无 issues 的源稿。缺同课拼音或组词不补猜，整组古诗字表不强分到单首。', '',
      '| 教材 | 总课数 | 概念/结论/提示 | 识字表 | 写字表 | 词语表 | 已核正文 | 古诗正文 | 配套题库 | 可独立问答的短答案题 | 教材课后原题 | 日积月累原文 |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const item of report.cards.sourceCoverage) lines.push(`| ${item.sourceBookId} | ${item.totalLessons} | ${item.knowledge} | ${item.recognitionCharacters} | ${item.writingCharacters} | ${item.words} | ${item.reviewedReading} | ${item.poemText} | ${item.questions} | ${item.shortAnswerQuestions} | ${item.textbookExercises} | ${item.dailyAccumulation} |`)
    lines.push('', '上表按导出课时计数，含 studio；整组诗字表存在不等于能精确分配给每首。0 表示没有已核且对应本课的结构化来源，不表示教材本身没有该内容。词语覆盖同时计入冻结原型已核词表，词表仅有词形时不生成无答案读音卡。数学课后题和例题未作新的 OCR 推断。', '', '### 无卡片课清单', '')
    for (const book of report.books) for (const lesson of book.noCardLessons)
      lines.push(`- ${book.sourceBookId} / ${lesson.sourceLessonId} ${lesson.title}：${lesson.reasons.join('；')}`)
  }
  if (report.audio) {
    lines.push('', '## 音频覆盖', '', '| 课程 | 条目 | 缓存有音频 | 缺音频 | props 已引用 | 契约不支持或超限 | 跳过 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const item of report.audio.lessons) lines.push(`| ${item.lessonId} | ${item.total} | ${item.withAudio} | ${item.missingAudio} | ${item.attached} | ${item.unsupported} | ${item.skipped} |`)
    lines.push('', '缓存有音频表示本机存在已核字节；仅 props 已引用的音频随包携带。字族词写入 family 项的 audio，整篇朗读写入 ReadAloud props.audio，详见 report.json.audio.entries。Thinky content-sync 支持音频导入、发布和下发；本报告不代表已部署或完成播放验收。')
    if (report.audio.characterContextSources) lines.push('', `单字上下文来源（关卡条目数）：${Object.entries(report.audio.characterContextSources).map(([source, count]) => `${source} ${count}`).join('；')}。`)
    if (report.audio.singleReadings?.length) lines.push('', `单读：${report.audio.singleReadings.map(item => `${item.text}（${item.id}）`).join('、')}。`)
    if (report.audio.rejectedMedia?.length) {
      lines.push('', '### 超限音频', '', '以下录音保留在本机缓存，未挂载或打包；对应条目使用设备朗读。', '')
      for (const item of report.audio.rejectedMedia) lines.push(`- ${item.id}：${item.byteLength} 字节；${item.reason}。`)
    }
    if (report.audio.listeningReview?.length) lines.push('', `请人工试听多音字：${report.audio.listeningReview.map(item => `${item.text}（${item.id}；${item.readings.join('/')}）`).join('、')}。`)
    if (report.audio.missingWords?.length) lines.push('', `无组词或读音待核对：${report.audio.missingWords.map(item => `${item.text}（${item.id}：${item.reason}）`).join('、')}。`)
  }
  lines.push('', '## 九处交互导出', '', '| 课程 | 关卡 | 交互 | 导出 |', '| --- | --- | --- | --- |')
  for (const item of report.interactions ?? []) lines.push(`| ${item.sourceLessonId} | ${item.stageKey} | ${item.title} | ${item.widget}${item.activity ? ` / ${item.activity}` : ''}${item.presentation ? ` / ${item.presentation}` : ''} |`)
  if (report.strokeData) lines.push('', '## 笔顺与私有作者文件', '',
    `- 会写字覆盖 ${report.strokeData.covered.length}/${report.strokeData.required.length}：${report.strokeData.covered.join('、')}。缺数据：${report.strokeData.missing.join('、') || '无'}。`,
    `- 来源：${report.strokeData.source}；许可：${report.strokeData.license}；原文随包附于 ${report.strokeData.licenseFile}，转换说明见 ${report.strokeData.noticeFile}。`,
    `- 每字 JSON 按字节 SHA256 命名，Character.strokeData 引用 kind=document；${report.assets.strokeDocuments} 份文档与页图共同登记于 media-manifest.json。`,
    `- 私有 authoring 文件 ${report.authoringFiles.length} 份，逐份通过 LessonAuthoringSchema 并核对公开 definition/props；文件名与摘要见 report.json。`,
    '- content-sync 从 package.json 的 books[].lessons[].authoring 读取七关完整私有评分；顶层 media 登记笔顺文档的 sha256/kind/mime。独立 authoring 文件保留供审阅，公开 content/props 不含 grading。',
    '- 题目 sourceLabel 原先被 QuestionCard 直接显示为内部 output 路径；已从公开题目删除，溯源仅保留 report.json 的 questionProvenance。')
  lines.push('', '## 课程类型与空作业', '')
  for (const book of report.books) lines.push(`- ${book.sourceBookId}：\`${JSON.stringify(book.byLessonKind)}\`；无作业引用：${book.noHomeworkLessons.join('、') || '无'}。`)
  lines.push('', '## 缺印刷页号的物理页', '')
  for (const book of report.books) lines.push(`- ${book.sourceBookId}：${book.missingPrintedPages.join('、') || '无'}。`)
  lines.push('', '## 校验错误', '')
  for (const issue of report.issues) lines.push(`- ${issue.path}: ${issue.message}`)
  if (!report.issues.length) lines.push('无。')
  lines.push('', '## 警告', '')
  for (const warning of report.warnings) lines.push(`- ${warning.code ?? 'CONTRACT_WARNING'}：${warning.message}${warning.locator ? `（${warning.locator}）` : ''}${warning.physicalPage !== undefined ? ` ${warning.lessons.join(' / ')} p${warning.physicalPage}` : ''}`)
  lines.push('', '## 原型与契约表达缺口', '')
  for (const gap of report.gaps) lines.push(`- ${gap}`)
  lines.push('', '## 已确认内容决定', '',
    '- 2026-10-28 用户决定优先于旧草稿的待确认状态；Q1/Q4/D9 为导出边界。',
    '- 2026-10-29 用户选择 A：g3down-2026-u101-l03 恢复草稿 PDF 88–91，前课 l02 保持 86–88，仅首尾共用 p88，符合 D9。',
    '- 数学页段读取 human-review.csv：fix 使用确认页段，approve 使用确认页段并核对 lessons.csv 草稿；原 8 项 needs-human 的依据保留于输入证据。',
    '- calculation 保留源类型，按推断导出 numeric/measurement；有效包依赖 Thinky 契约 dist v1.6 的映射支持。',
    '- 语文用 confirmedFrom/To；中华传统节日固定 PDF 60。',
    '- assign-v2 保留唯一归属与练习课共用引用；原题答案不复算，单位不自动换算。',
    '- 四个人工答案决定均在 report.json 的 resolvedMetadata 中标为 explicit。',
    '', '本报告只证明本地导出和结构校验，不涉及 Thinky 导入、发布或前端互动验收。', '')
  return lines.join('\n')
}

module.exports = { statistics, sharedEndpoints, markdownReport }
