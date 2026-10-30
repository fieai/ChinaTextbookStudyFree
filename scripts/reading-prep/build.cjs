#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '../..')
const sourceDirectory = path.join(root, 'content/reading-prep')
const output = path.join(root, '.local/reading-prep/review')
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const lessonKey = lesson => lesson.lessonKey || String(lesson.lessonNumber).padStart(2, '0')
const bookLabel = book => {
  const match = /^chinese-g([1-6])(up|down)(?:-|$)/u.exec(book.bookId)
  return match ? `语文${'一二三四五六'[Number(match[1]) - 1]}年级${match[2] === 'up' ? '上' : '下'}册` : book.bookId
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readBook(bookId, expected, expectedPhonics = 0) {
  const filename = path.join(root, 'content/reading-prep', `${bookId}.json`)
  const book = JSON.parse(fs.readFileSync(filename, 'utf8'))
  const tablePath = path.join(sourceDirectory, 'tables', `${bookId}.json`)
  const tables = fs.existsSync(tablePath)
    ? JSON.parse(fs.readFileSync(tablePath, 'utf8'))
    : JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'character-tables.json'), 'utf8')).books.find(item => item.bookId === bookId)
  expected ||= book.expectedLessonCount || book.lessons.length
  assert(tables?.lessons.length === expected, `${bookId}: 独立核对字词表缺失`)
  assert(book.schemaVersion === 1 && book.bookId === bookId, `${bookId}: 无效版本或教材 ID`)
  assert(Array.isArray(book.lessons) && book.lessons.length === expected, `${bookId}: 课数应为 ${expected}`)
  assert(fs.existsSync(book.source.pdfPath), `${bookId}: 找不到来源 PDF`)
  assert(digest(fs.readFileSync(book.source.pdfPath)) === book.source.sha256, `${bookId}: 来源 PDF 哈希已变化`)
  const ids = new Set()
  const numbers = new Set()
  for (const lesson of book.lessons) {
    const id = `${bookId}/lesson-${lessonKey(lesson)}`
    assert(Number.isInteger(lesson.lessonNumber) && lesson.lessonNumber >= 1 && lesson.lessonNumber <= expected, `${id}: 课号无效`)
    assert(!numbers.has(lessonKey(lesson)) && /^[a-z0-9-]+$/u.test(lessonKey(lesson)), `${id}: 课号或稳定键重复/无效`)
    numbers.add(lessonKey(lesson))
    assert(typeof lesson.title === 'string' && lesson.title.trim(), `${id}: 标题缺失`)
    assert(['reviewed', 'needs-review'].includes(lesson.status), `${id}: 审核状态无效`)
    assert(Array.isArray(lesson.issues), `${id}: 缺少核对问题列表`)
    assert(lesson.status !== 'reviewed' || lesson.issues.length === 0, `${id}: 存在问题不能标审定`)
    assert(Array.isArray(lesson.pdfPages) && lesson.pdfPages.length, `${id}: 未标教材物理页`)
    const pageValid = page => Number.isInteger(page) && page >= 1 && page <= book.source.pageCount
    assert(lesson.pdfPages.every(pageValid), `${id}: 教材页越界`)
    assert(Array.isArray(lesson.paragraphs) && lesson.paragraphs.length, `${id}: 正文缺失`)
    assert(Array.isArray(lesson.sentences) && lesson.sentences.length, `${id}: 逐句文本缺失`)
    const paragraphIds = new Set()
    for (const paragraph of lesson.paragraphs) {
      assert(paragraph.id && !paragraphIds.has(paragraph.id), `${id}: 段落 ID 重复或缺失`)
      paragraphIds.add(paragraph.id)
      assert(typeof paragraph.text === 'string' && paragraph.text.trim(), `${id}: 空正文段落`)
      assert(!/人民.*出版社|仅供.*学习|未经授权|PDF|�/u.test(paragraph.text), `${id}: 正文混入页眉、水印或 OCR 残片`)
      let checkedText = paragraph.text
      for (const span of lesson.literalSpans || []) {
        assert(span.text?.trim() && pageValid(span.pdfPage), `${id}: 原文特殊文字缺少来源`)
        if (paragraph.pdfPages.includes(span.pdfPage))
          checkedText = checkedText.split(span.text).join('')
      }
      assert(!/[a-zA-Z]/u.test(checkedText), `${id}: 正文存在未核对的拉丁文字或拼音残片`)
      assert(Array.isArray(paragraph.pdfPages) && paragraph.pdfPages.length && paragraph.pdfPages.every(pageValid), `${id}: 段落缺少来源页`)
    }
    const supplementIds = new Set()
    for (const supplement of lesson.supplements || []) {
      assert(supplement.id && !supplementIds.has(supplement.id), `${id}: 图表资料 ID 缺失或重复`)
      supplementIds.add(supplement.id)
      assert(supplement.pdfPages?.length && supplement.pdfPages.every(pageValid), `${id}: 图表资料来源页缺失`)
      assert(supplement.text?.trim() || supplement.labels?.length, `${id}: 图表原始文字缺失`)
    }
    for (const part of lesson.parts || []) {
      assert(typeof part.title === 'string' && part.title.trim(), `${id}: 子篇标题缺失`)
      assert(Array.isArray(part.paragraphIds) && part.paragraphIds.every(value => paragraphIds.has(value)), `${id}: 子篇引用不存在段落`)
      assert((part.supplementIds || []).every(value => supplementIds.has(value)), `${id}: 子篇引用不存在图表资料`)
      assert(part.paragraphIds.length || part.supplementIds?.length, `${id}: 子篇既无正文又无图表文字`)
    }
    for (const sentence of lesson.sentences) {
      assert(sentence.id && !ids.has(`${id}/${sentence.id}`), `${id}: 逐句 ID 重复或缺失`)
      ids.add(`${id}/${sentence.id}`)
      assert(typeof sentence.text === 'string' && sentence.text.trim(), `${id}: 空句子`)
      assert(paragraphIds.has(sentence.paragraphId), `${id}: 句子引用不存在段落`)
    }
    // Splitting a paragraph must not silently drop punctuation or characters.
    const normalize = text => text.replace(/\s+/gu, '')
    for (const paragraph of lesson.paragraphs) {
      const joined = lesson.sentences.filter(sentence => sentence.paragraphId === paragraph.id).map(sentence => sentence.text).join('')
      assert(normalize(joined) === normalize(paragraph.text), `${id}/${paragraph.id}: 分句未完整保留正文`)
    }
    for (const field of ['recognitionCharacters', 'writingCharacters', 'words']) {
      assert(Array.isArray(lesson[field]), `${id}: ${field} 缺失`)
      const tableLesson = tables.lessons.find(item => lessonKey(item) === lessonKey(lesson))
      assert(tableLesson, `${id}: 缺少对应教材字词表`)
      const identity = item => [item.char || item.text, item.pinyin || '', item.pdfPage].join('|')
      const actual = new Set(lesson[field].map(identity))
      assert(tableLesson[field].every(item => actual.has(identity(item))), `${id}: 未完整合并教材 ${field}`)
      if (!lesson[field].length && lesson.status === 'reviewed')
        assert(lesson.sourceAbsence?.some(note => note.field === field && note.resolved), `${id}: ${field} 为空但未说明教材是否未列`)
      for (const item of lesson[field]) {
        assert(typeof (item.char || item.text) === 'string' && (item.char || item.text).trim(), `${id}: 空字词`)
        assert(pageValid(item.pdfPage), `${id}: 字词缺少来源页`)
      }
    }
  }
  const phonics = book.phonicsLessons || []
  assert(phonics.length === expectedPhonics, `${bookId}: 拼音课数应为 ${expectedPhonics}`)
  const phonicsKeys = new Set()
  for (const lesson of phonics) {
    assert(lesson.lessonKey && !phonicsKeys.has(lesson.lessonKey), `${bookId}: 拼音课稳定键缺失或重复`)
    phonicsKeys.add(lesson.lessonKey)
    assert(lesson.title && lesson.pdfPages?.length && lesson.paragraphs?.length, `${bookId}/${lesson.lessonKey}: 拼音原文或来源缺失`)
    assert(['reviewed', 'needs-review'].includes(lesson.status) && Array.isArray(lesson.issues), `${bookId}/${lesson.lessonKey}: 拼音核对状态缺失`)
    assert(lesson.status !== 'reviewed' || !lesson.issues.length, `${bookId}/${lesson.lessonKey}: 拼音未决项不能标审定`)
    for (const paragraph of lesson.paragraphs) {
      assert(paragraph.text?.trim() && paragraph.pdfPages?.length, `${bookId}/${lesson.lessonKey}: 拼音段落为空或无页码`)
      const joined = (lesson.sentences || []).filter(item => item.paragraphId === paragraph.id).map(item => item.text).join('')
      assert(joined.replace(/\s+/gu, '') === paragraph.text.replace(/\s+/gu, ''), `${bookId}/${lesson.lessonKey}: 拼音分句丢字`)
    }
  }
  return book
}

function entriesFor(book, lesson) {
  const prefix = `${book.bookId}/lesson-${lessonKey(lesson)}`
  const common = {
    bookId: book.bookId, lessonNumber: lesson.lessonNumber, lessonKey: lessonKey(lesson), lessonTitle: lesson.title,
    sourceLessonId: lesson.sourceLessonId, reviewStatus: lesson.status,
    readyForSynthesis: lesson.status === 'reviewed', sourcePdfSha256: book.source.sha256,
    pronunciationHints: lesson.pronunciationHints || [],
    literalSpans: lesson.literalSpans || [],
  }
  const entries = []
  const add = (suffix, kind, text, pages, extra = {}) => entries.push({
    ...common, id: `${prefix}/${suffix}`, kind, text, textSha256: digest(text), pdfPages: pages, ...extra,
  })
  add('whole', 'whole', lesson.paragraphs.map(paragraph => paragraph.text).join('\n'), lesson.pdfPages)
  for (const [index, part] of (lesson.parts || []).entries()) {
    const paragraphs = lesson.paragraphs.filter(paragraph => part.paragraphIds.includes(paragraph.id))
    if (!paragraphs.length) continue
    add(`parts/${index + 1}`, 'part', paragraphs.map(paragraph => paragraph.text).join('\n'),
      [...new Set(paragraphs.flatMap(paragraph => paragraph.pdfPages))], {
        partTitle: part.title, sourceLessonId: part.sourceLessonId || lesson.sourceLessonId,
        author: part.author || null, dynasty: part.dynasty || null,
      })
  }
  for (const sentence of lesson.sentences) {
    const paragraph = lesson.paragraphs.find(item => item.id === sentence.paragraphId)
    add(`sentences/${sentence.id}`, 'sentence', sentence.text, paragraph.pdfPages)
  }
  for (const field of ['recognitionCharacters', 'writingCharacters']) {
    for (const [index, item] of lesson[field].entries())
      add(`${field}/${index + 1}`, 'character', item.char, [item.pdfPage], { category: field, pinyin: item.pinyin ?? null })
  }
  for (const [index, word] of lesson.words.entries())
    add(`words/${index + 1}`, 'word', word.text, [word.pdfPage], { wordSource: word.source })
  return entries
}

function main() {
  const inventory = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'inventory.json'), 'utf8'))
  const partial = process.argv.includes('--partial')
  const targets = inventory.books.filter(book => !partial || book.status === 'prepared')
  const parsed = targets.map(book => readBook(book.bookId, book.expectedLessonCount, book.expectedPhonicsCount))
  const entries = parsed.flatMap(book => book.lessons.flatMap(lesson => entriesFor(book, lesson)))
  const lessons = parsed.flatMap(book => book.lessons)
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'narration-manifest.json'), `${JSON.stringify({
    schemaVersion: 1, purpose: 'text-preparation-only', providerCalled: false,
    declaredBookIds: inventory.books.map(book => book.bookId),
    includedBookIds: parsed.map(book => book.bookId), partial: parsed.length !== inventory.books.length, entries,
  }, null, 2)}\n`)
  const lines = ['# 语文配音文本整理', '',
    '按当前教材逐课整理。此清单只准备文本，没有调用语音服务；审核状态保留在每课及每条文本中。', '',
    `当前目录共有 ${inventory.books.length} 册语文教材，本次清单包含 ${parsed.length} 册。资源 ID 中的 2026 不等同于出版年份。`, '',
    `本地尚缺的年级学期：${inventory.missingLocalCurrentBooks.map(bookId => bookLabel({ bookId })).join('、')}。`, '',
    `共 ${lessons.length} 课，${lessons.reduce((sum, lesson) => sum + lesson.paragraphs.length, 0)} 段、${lessons.reduce((sum, lesson) => sum + lesson.sentences.length, 0)} 句；识字 ${lessons.reduce((sum, lesson) => sum + lesson.recognitionCharacters.length, 0)} 条、写字 ${lessons.reduce((sum, lesson) => sum + lesson.writingCharacters.length, 0)} 条、词语 ${lessons.reduce((sum, lesson) => sum + lesson.words.length, 0)} 条（均按课计，包含重复字词和教材多音字项目）。`, '',
    '| 教材 | 课 | 课名 | 正文段 | 逐句 | 会认字 | 会写字 | 词语 | 核对状态 |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |']
  for (const book of parsed) {
    for (const lesson of book.lessons) {
      const status = lesson.status === 'reviewed' ? '已对照教材' : '待核对'
      const lessonLink = `[${lesson.title}](${book.bookId}/${lessonKey(lesson)}.md)`
      const courseNumber = lessonKey(lesson).startsWith('literacy-') ? `识字${lesson.lessonNumber}` : lesson.lessonNumber
      lines.push(`| ${bookLabel(book)} | ${courseNumber} | ${lessonLink} | ${lesson.paragraphs.length} | ${lesson.sentences.length} | ${lesson.recognitionCharacters.length} | ${lesson.writingCharacters.length} | ${lesson.words.length} | ${status} |`)
      const paragraphs = lesson.paragraphs.flatMap(item => {
        const part = lesson.parts?.find(value => value.paragraphIds[0] === item.id)
        const attribution = part?.author ? `${part.dynasty ? `[${part.dynasty}] ` : ''}${part.author}` : ''
        return part ? [`### ${part.title}`, '', ...(attribution ? [attribution, ''] : []), ...(part.title === item.text.trim() ? [] : [item.text, ''])] : [item.text, '']
      })
      const supplements = (lesson.supplements || []).flatMap(item => {
        const part = lesson.parts?.find(value => value.supplementIds?.includes(item.id))
        const source = item.source || part?.source
        return [
          `### ${part ? `${part.title} · ` : ''}${item.title || item.id}`, '', `教材物理页：${item.pdfPages.join('、')}${source ? `；教材标注来源：${source}` : ''}`, '',
          ...(item.text ? [item.text, ''] : []), ...(item.labels || []).map(label => `- ${label}`), '',
        ]
      })
      const plain = [`# ${courseNumber} ${lesson.title}`, '', ...(lesson.author ? [`作者：${lesson.author}`, ''] : []), '## 全文', '', ...paragraphs, '',
        ...(supplements.length ? ['## 补充图表原始文字', '', ...supplements] : []),
        '## 会认字', '', lesson.recognitionCharacters.map(item => item.char + (item.pinyin ? `（${item.pinyin}）` : '')).join(' '), '',
        '## 会写字', '', lesson.writingCharacters.map(item => item.char + (item.pinyin ? `（${item.pinyin}）` : '')).join(' '), '',
        '## 词语', '', lesson.words.map(item => item.text).join('、'), '', '## 核对记录', '',
        `状态：${lesson.status}；教材物理页：${lesson.pdfPages.join('、')}`, ...lesson.issues.map(issue => `- ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`),
        ...(lesson.notes || []).map(note => `- 说明：${typeof note === 'string' ? note : JSON.stringify(note)}`),
        ...(lesson.sourceAbsence || []).map(note => `- 教材未列：${typeof note === 'string' ? note : (note.message || note.reason)}`), '']
      const directory = path.join(output, book.bookId)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, `${lessonKey(lesson)}.md`), plain.join('\n'))
    }
  }
  const phonicsRecords = []
  lines.push('', '## 单独保留的拼音课', '', '拼音文本不混入普通课文配音请求。', '')
  for (const book of parsed) {
    for (const lesson of book.phonicsLessons || []) {
      const filename = `${lesson.lessonKey}.md`
      const directory = path.join(output, book.bookId)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, filename), [
        `# ${lesson.title}`, '', ...lesson.paragraphs.flatMap(item => [item.text, '']),
        '## 会认字', '', (lesson.recognitionCharacters || []).map(item => item.char + (item.pinyin ? `（${item.pinyin}）` : '')).join(' '), '',
        '## 会写字', '', (lesson.writingCharacters || []).map(item => item.char).join(' '), '',
        '## 词语', '', (lesson.words || []).map(item => item.text).join('、'), '',
        `核对状态：${lesson.status}；教材物理页：${lesson.pdfPages.join('、')}`, '',
        ...(lesson.notes || []), ...lesson.issues.map(issue => `- ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`), '',
        ...(lesson.sourceAbsence || []).map(note => `- 教材未列：${typeof note === 'string' ? note : (note.message || note.reason)}`), '',
      ].join('\n'))
      lines.push(`- [${lesson.title}](${book.bookId}/${filename})：教材物理页 ${lesson.pdfPages.join('、')}，${lesson.status === 'reviewed' ? '已对照教材' : '待核对'}。`)
      phonicsRecords.push({ bookId: book.bookId, ...lesson, readyForSynthesis: false })
    }
  }
  fs.writeFileSync(path.join(output, 'phonics-manifest.json'), `${JSON.stringify({ schemaVersion: 1,
    purpose: 'phonics-text-only; requires phoneme-specific speech review', providerCalled: false, lessons: phonicsRecords }, null, 2)}\n`)
  const supplementRecords = parsed.flatMap(book => book.lessons.flatMap(lesson => (lesson.supplements || []).map(item => ({
    bookId: book.bookId, lessonKey: lessonKey(lesson), lessonTitle: lesson.title,
    ...item, readyForSynthesis: false, note: '教材图表原始文字；未改写成讲解，朗读形式待后续选择。',
  }))))
  fs.writeFileSync(path.join(output, 'supplement-manifest.json'), `${JSON.stringify({ schemaVersion: 1,
    purpose: 'source-diagrams-tables-and-labels', providerCalled: false, entries: supplementRecords }, null, 2)}\n`)
  lines.push('', '## 待核对项', '')
  for (const book of inventory.books.filter(item => !parsed.some(value => value.bookId === item.bookId)))
    lines.push(`- ${book.bookId}：尚在整理，未计入上表及配音条目。`)
  for (const book of parsed)
    for (const lesson of book.lessons)
      for (const issue of lesson.issues)
        lines.push(`- ${book.bookId} 第 ${lesson.lessonNumber} 课《${lesson.title}》：${typeof issue === 'string' ? issue : JSON.stringify(issue)}`)
  fs.writeFileSync(path.join(output, 'summary.md'), `${lines.join('\n')}\n`)
  console.log(JSON.stringify({ books: parsed.length, lessons: parsed.reduce((sum, book) => sum + book.lessons.length, 0), entries: entries.length,
    readyEntries: entries.filter(entry => entry.readyForSynthesis).length, phonicsLessons: phonicsRecords.length,
    supplements: supplementRecords.length, output }, null, 2))
}

if (require.main === module) main()
module.exports = { readBook, entriesFor }
