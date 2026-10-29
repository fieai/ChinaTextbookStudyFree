'use strict'

function statistics(content, pagesManifest, bookEvidence) {
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
