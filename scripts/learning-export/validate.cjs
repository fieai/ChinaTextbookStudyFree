'use strict'

/** Run each named check even if a package-level schema error short-circuits Thinky validation. */
function validateExport(content, authority, questionContractIssues = [], pagesManifest) {
  const result = authority.validateContentPackage(content).report
  const issues = [...result.issues]
  const contract = authority.contract
  const collect = (prefix, parsed) => {
    if (!parsed.success) for (const issue of parsed.error.issues)
      issues.push({ path: [prefix, ...issue.path].filter(part => part !== '').join('.'), message: issue.message })
    return parsed.success
  }
  const schema = authority.ContentPackageSchema.safeParse(content)
  const pagesSchema = contract.PagesManifestSchema.safeParse(pagesManifest)
  collect('pages-manifest', pagesSchema)
  const lessons = content.books.flatMap((book, bi) => book.lessons.map((lesson, li) => ({
    book, lesson, prefix: `books.${bi}.lessons.${li}.content`,
  })))
  let lessonShapes = true, lessonRules = true
  for (const { book, lesson, prefix } of lessons) {
    lessonShapes = collect(prefix, contract.LessonDefinitionSchema.safeParse(lesson.content)) && lessonShapes
    lessonRules = collect(prefix, contract.validateLessonDefinition(lesson.content, {
      totalPages: book.totalPages,
      questionIds: content.questions.filter(question => question.sourceBookId === book.sourceBookId).map(question => question.id),
    })) && lessonRules
  }
  const catalog = contract.validateLessonCatalog(content.books.map(book => ({
    sourceBookId: book.sourceBookId, lessons: book.lessons.map(lesson => lesson.content),
  })), content.knowledgePoints)
  collect('', catalog)
  const known = content.knowledgePoints.map(point => point.id)
  let questions = questionContractIssues.length === 0
  content.questions.forEach((question, index) => {
    questions = collect(`questions.${index}.payload`, contract.validateQuestionImport(question.payload, {}, known)) && questions
  })
  for (const entry of questionContractIssues) {
    const index = content.questions.findIndex(question => question.payload.question.sourceLabel === entry.locator)
    for (const issue of entry.issues)
      issues.push({ path: [`questions.${index}.payload`, ...issue.path].join('.'), message: issue.message })
  }
  const unique = [...new Map(issues.map(issue => [`${issue.path}:${issue.message}`, issue])).values()]
  return {
    valid: result.valid && unique.length === 0,
    issues: unique,
    warnings: result.warnings,
    checks: {
      ContentPackageSchema: { valid: schema.success },
      PagesManifestSchema: { valid: pagesSchema.success },
      LessonDefinitionSchema: { valid: lessonShapes, count: lessons.length },
      validateLessonDefinition: { valid: lessonRules, count: lessons.length, includes: ['blacklist', 'totalPages', 'questionRefs'] },
      validateLessonCatalog: { valid: catalog.success, includes: ['knowledgePoints', 'D9 interior overlap'] },
      validateQuestionImport: { valid: questions, count: content.questions.length, knownKnowledgePoints: known.length },
      validateContentPackage: { valid: result.valid },
    },
  }
}

module.exports = { validateExport }
