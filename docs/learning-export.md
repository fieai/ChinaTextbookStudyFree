# 三年级四册学习内容导出

WP-10 第一部分，执行位置为 `ChinaTextbookStudyFree-wp-10` worktree。
仅新增导出脚本、测试、本文及 `.gitignore` 的 `/.local/learning-export/` 一行。
不修改源题、原型、既有业务代码或 Thinky，不调用导入、数据库、发布接口，不提交。

## 命令

需要 Node.js 22+、Python 3，以及已安装依赖且构建完成的 Thinky 契约包。
生成有效 `package.json` 依赖 Thinky 契约 dist v1.6 第二部分，支持
`calculation → calculation | numeric | measurement`、新增活动与 `LessonAuthoringSchema`；
旧 dist 会如实阻断，不绕过校验，由协调者构建。
无需在本 worktree 安装 npm 依赖。

```bash
node scripts/learning-export/index.cjs
node --test scripts/learning-export/*.test.cjs
```

默认只读输入位置：

| 输入 | 默认位置 |
| --- | --- |
| 修订版题库、原型 | 当前 worktree 若有指定原型则用当前目录；否则只读相邻 `ChinaTextbookStudyFree` 主检出 |
| Thinky 契约及包校验模块 | `/Users/my-project/AI-PROJECT/thinky` |
| WP-10 证据与本地完整数据 | `/Users/my-project/AI-PROJECT/thinky-wp-10` |

当前基线 `f522eee` 未跟踪修订版题库和部署原型，因此实际读取主检出的指定文件。
脚本不对该目录执行 git 操作或写入；只在当前 worktree 查询 HEAD。
题库及原有原型 JS 对照 WP-10 冻结 SHA256；笔顺 JS 与许可文件也计入本次输入指纹；PDF 对照原型元数据，
每张页图对照部署父目录 `checksums.json` 的冻结 SHA256 和字节数，并检查 PNG chunk CRC。
来源漂移、缺文件或不完整元数据均阻断，不自动刷新研究证据。

不同目录可显式指定：

```bash
node scripts/learning-export/index.cjs \
  --source-root /path/to/read-only-content-checkout \
  --site-dir /path/to/family-learning-share-20261027-button-stability/site \
  --thinky-root /path/to/thinky \
  --evidence-root /path/to/thinky-wp-10
```

`--output-root` 可改变输出父目录，但必须位于本 worktree `.local/learning-export/` 内。
输出祖先、版本目录和媒体目录不能经软链指向其它目录。
JSON/Markdown 使用原子替换，不覆盖原有硬链接的 inode；已有媒体只验哈希，不覆盖。

## 输出与身份

输出目录为 `.local/learning-export/<sourceRevision>/`，包含：

- `package.json`：只有完整校验通过才生成，严格符合 Thinky `ContentPackageSchema`。
- `candidate-package.json`：包或页图清单有契约错误时生成，不能导入或发布；失败命令退出码为 1，仍输出页图清单与报告，不生成有效 `package.json`。
- `pages-manifest.json`：严格符合 Thinky `PagesManifestSchema`，包含四册每个 PDF 物理页的 SHA256、MIME、宽高及印刷页号。
- `media/<sha256>.png`：页图按内容哈希命名，优先硬链接，跨盘或权限不允许时复制；完成后核验目标哈希。
- `media/<sha256>.json`：每个会写字的笔顺文档，保留原型 Make Me a Hanzi 的 strokes/medians，按 JSON UTF-8 字节哈希命名；Character.strokeData 使用 `{sha256,kind:"document"}`。
- `media-manifest.json`：统一登记页图与笔顺文档，字段为 schemaVersion、media[]；每项包含 sha256/kind/mime/path/byteLength。这是导出器 sidecar，使用契约 MediaReferenceSchema 加本地 Zod 严格校验，不扩展仅限页图的 PagesManifest。
- `authoring.<sourceLessonId>.json`：五份课级私有 LessonAuthoring（definition、widgetGradings），评分绑定公开关卡的相同 widget/props；与 package.json 分文件保存。content-sync 私有评分导入格式尚未定义，由协调者对齐，不直接传入公共课程接口。
- `Make-Me-a-Hanzi-LICENSE.txt` / `Make-Me-a-Hanzi-NOTICE.txt`：原型附带的 Arphic Public License 原文、上游来源和 JSON 提取说明。
- `report.json`：分项校验结果、四册统计与逐页证据、全部警告、表达缺口、完整输入指纹及逐题 provenance。
- `report.md`：便于审阅的统计、错误、缺印刷页号页表、警告、缺口与决定来源。

`pages-manifest.json` 顶层仅有 `schemaVersion` 与 `books`，每册仅有 `sourceBookId` 与 `pages`，
每页仅有 `page`、`printedPage`、`sha256`、`mime`、`width`、`height`：

```json
{
  "schemaVersion": 1,
  "books": [{
    "sourceBookId": "math-g3-up",
    "pages": [{
      "page": 7,
      "printedPage": "1",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "mime": "image/png",
      "width": 1000,
      "height": 1414
    }]
  }]
}
```

`page` 为从 1 起的 PDF 物理页；`printedPage` 为最长 16 字符的字符串或 `null`，
源 `printedPageNumber` 为数字时转为字符串，`null` 保持不变。
清单不携带 `physicalPage`、`printedPageNumber`、`printedPageEvidence`、`mediaPath`、`totalPages` 或 `pdfSha256`。
这些来源信息保留在 `report.json`：`books[]` 包含 `totalPages`、`pdfSha256`，
其 `pages[]` 保留 `physicalPage`、`printedPageNumber`、`printedPageEvidence` 与 `mediaPath`。
媒体文件路径仍为 `media/<sha256>.<ext>`，导入端按 `sha256` 与 `mime` 找文件；
`image/png`、`image/jpeg`、`image/webp` 分别对应 `.png`、`.jpg`、`.webp`。

页图硬链接不可就地编辑；如需修改内容，应修改获授权的新源版本后重新导出。
输出没有时间戳、随机教学内容或依赖遍历顺序的 ID，两次相同输入导出逐文件字节一致。
所有生成物均被忽略，不进入 git。

`sourceRevision` 为**当前 worktree HEAD 的 7 位短哈希**加输入摘要前 20 位。
摘要包含稳定标签及内容 SHA256，覆盖脚本实现、源题、原型、PDF、478 张页图、OCR/页码证据、
课时 CSV（含 `math-lessons/human-review.csv`）、归属 JSON、推断规则、实际使用的 Thinky 契约 dist、权威包结构与校验源码。
绝对目录和文件时间不参与摘要；完整摘要在报告中保留。

UUID v5 命名空间固定为 `7cf6f510-4932-5bc9-99bc-35ce4d897d72`。
书、课、题分别使用 `book/<sourceBookId>`、`lesson/<sourceLessonId>`、
`question/<源相对路径>#/<section>/questions/<数组下标>` 生成逻辑键。
题目 `id` 直接使用其逻辑键；练习课引用相同题目 ID，不复制题目记录。

`manifestSha256` 直接调用 Thinky `content-package.ts` 的 `packageHash()`：
排除 manifest 本身，books 按 sourceBookId、知识点和题目按 id、课时按 ordinal 排序，
对象键递归排序后用 `JSON.stringify` 的 UTF-8 字节 SHA256；教学数组保持原顺序。
脚本用独立实现作对照，测试另比较真实 Thinky 算法和 Python 标准库 UUID v5。

## 内容决定与证据

2026-10-28 本任务用户已确认的决定优先于旧证据中的 `draft/needs-human` 状态。
2026-10-29 用户选择 A：`g3down-2026-u101-l03` 恢复 `lessons.csv` 草稿 PDF 88–91，
前课 l02 保持 PDF 86–88；两课只共用 p88，属于 D9 允许的首尾共页。
Thinky 的方案仅作为只读契约与决策依据，课程定义在本仓库导出（Q4）。

| 内容 | 来源与处理 |
| --- | --- |
| 非样例 | Q1：全部 `textbook-only`，不写 opening、takeaways、basicStages，不生成通用课程文案 |
| 数学课时 | D9 与 `math-lessons/lessons.csv`，108 课时，含原 8 项 needs-human；读取 `math-lessons/human-review.csv`，fix 使用 confirmedFrom/confirmedTo 覆盖草稿，approve 使用确认页段并核对草稿一致；未知课、未知 verdict 或 approve 不一致均阻断 |
| 数学知识点 | `math-lessons/kp-map.csv` 的 86 项，逐课对照 CSV 双向映射；标题原样保留 |
| 语文 | 原型目录 105 项；其中 103 个非样例取 `page-candidates.csv` 的 machine-verified confirmedFrom/To；中华传统节日固定 PDF 60 |
| 大青树页段 | 该样例不在确认 CSV 中；用 `page-notes.md` 与 `lesson-guides.js` 明确的完整课文及课后要求 PDF 8–10 |
| 绝句页段 | 该样例不在确认 CSV 中；用 `review-chinese.md` 明示的 PDF 8 上半诗文及 PDF 9 三首诗共用练习，取 8–9 |
| 语文 lessonKind | 阅读/例文为 new；目录中的口语交际、习作、专题活动、园地、快乐读书吧为 activity；依据 `pdf-toc-chinese-ocr.txt`，显式标题表在 catalog.cjs |
| 语文知识点 | 原型课文 ID/标题作为标签，供 790 道题的精确同书同单元匹配使用，不另写标题 |
| 题目归属 | `.local/wp-10/math-question-assignment.json` 的 assign-v2；practice 共用引用，exam 仍唯一归属 |
| 源题元数据 | 运行 `inference_v1.py` / `numeric_inference_v1.py`，保存 rulesetVersion/ruleId/status；现有显式元数据必须一致 |
| 四个人工题 | 日期 count 号、周长 measurement dm、钟点 count 时、用电 measurement kWh，标为 explicit；不复算答案，不改原题干 |
| calculation 源题 | 保留 `sourceType/sourceKind: calculation`，目标 kind 按推断输出 numeric/measurement，保留 countUnit/units；使用 Thinky v1.6 映射校验 |
| 五课 | `five-lessons.md` 与 `lesson-studio.js` 原始数据；opening、三件事、卡片问答、字表、诗文、朗读目标逐字提取，不读取 Thinky 前端 mock 作内容源 |

`edition: "2026"` 保留原型的应用版本标识，不表示官方出版年份。
publisher 使用已核四册的人民教育出版社；教材标题保持原型标题。

物理页与印刷页分离：数学只在逐页记录明示的正文区间使用 `physical - 6`；
语文只采用目录已核起页，不按固定偏移填满中间页。无法确定的印刷页号为 `null`，全部列入报告。
`bookPageLabel` 只采用现有已采信的印刷页号证据，不推算偏移，也不显示 PDF 物理页序：
本课范围内每一页都有印刷页号且为连续整数时，生成“书上第 a–b 页”，单页生成“书上第 a 页”；
否则，起始物理页有可靠印刷页号时生成“书上第 a 页起”，其余生成“课本原页”。
数学 D9 允许相邻课时首尾共页，其它内部交叠阻断；语文同页多诗、共享练习允许重叠。

## 校验与测试

脚本在内存转译并读取 Thinky `content-package.ts`、`content-validation.ts`，
使用其真实 `ContentPackageSchema`、`validateContentPackage()` 和已构建契约包。
页图清单使用同一契约 dist 导出的 `PagesManifestSchema` 校验，结果并入报告的 `checks`、`valid` 与 `issues`；
未知字段或其它清单错误与包错误一样阻断有效包输出。
不构建或写入 Thinky。即使包级结构错误导致 Thinky 提前返回，仍独立运行并报告：

- 每课 `LessonDefinitionSchema` 及 `validateLessonDefinition()`，覆盖黑名单、totalPages、同书 questionRefs。
- `validateLessonCatalog()`，覆盖知识点引用及数学内部页段交叠。
- 每题 `validateQuestionImport()`，传入已知知识点与原始显式元数据。
- 唯一身份、同书/单元归属、页码和引用等发布端附加检查由 Thinky 权威校验执行。

单独只读校验一个包：

```bash
node scripts/learning-export/index.cjs --validate .local/learning-export/REVISION/package.json
```

测试包括真实四册两次全量导出逐文件字节比较（含媒体）、权威哈希、UUID v5、源文本抽样、
用户决定、共享题引用、页图清单契约通过、印刷页号转字符串与报告证据保留，
三种页码标签规则及单页写法、真实包所有 `bookPageLabel` 均无“PDF”或重复起止页码，
以及清单多余字段阻断、缺字段、黑名单、越界、坏引用、数学交叠、未知知识点、
推断歧义、人工规则失效、显式元数据冲突、冻结媒体漂移、坏 PNG CRC、输出软链、复制损坏等反例。
契约 dist 为旧版本时，依赖 v1.6 映射的测试会失败，必须报告具体失败与版本原因；
负向校验使用真实导出包的内存副本，不绕过映射校验，不据此宣称真实包校验通过。

## 当前表达缺口

保留以下可追溯缺口，逐关详情以最新 report.json/report.md 为准：

- 周长题保留原句“一个正方形边长是5分米，求它的周长。”；按用户决定判分为 dm，
  待作者将末句补为“它的周长是多少分米？”。
- 原先九处 concept-card 降级全部改为真实活动：unit-choice/compare、words/dictation/detective/imitation、scene/pairs/listen；答案和逐选反馈保存在私有 authoring，不进入公开 props。
- cube 活动与已知投影、ruler 视口与预设/步骤、对称私有反馈与轴序/汉字答案、朗读自然段与注音/停顿/家长任务、字族拼音释义、字符教学字段和小老师/家长出错卡均已导出。
- 当前 12 个会写字均有真实笔顺文档。设备 TTS 与临时录音没有稳定媒体，不伪造音频；复习模式替代遍没有专用作者字段，不新增必做遍。
- 绝句“写对”中的鸳、鸯、融、暖保持静态字形提示，原型笔顺文件没有这四字的数据，报告明确列出。
- scene visualKey 对应的画面、仿说模板占位符、移动尺子后的动态读数仍需消费端接线；按选字筛家长卡等运行约束与动态卡持久化不由导出包代替。
- 原型题集 SETS 的手工课本题、额外读懂题，以及动态变式规则，与 output 题库并非同一集合；
  本次按已确认 assign-v2 导出源题，未伪造这部分题目的归属或把默认快照当成动态定义。
- 7 个数学课时没有题目引用，保留空数组并警告；页图已齐全不等于印刷页码证据已齐全。

题目公开 sourceLabel 原先被前端 QuestionCard 直接显示成内部 output 路径，现已删除；
完整 locator 与原始题目保存在 report.json.questionProvenance，题目 UUID 与归属不变。
homework.notice 说明配套题库来源；未逐题核对的原型手工题不自动写入 Stage.questionRefs。
`--validate` 会同时回读校验包、页图清单、统一媒体清单及五份私有 authoring，并核对实际媒体字节与引用。

本任务只提供本地导出、校验和审阅结果。Thinky 侧导入、校验后发布及真实前端 widget 验收属于后续工作。

建议提交信息（本次不提交）：`feat(export): add deterministic grade-three learning v2 content exporter`。
