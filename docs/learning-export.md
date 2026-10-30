# 三年级四册学习内容导出

WP-10 第一部分，执行位置为 `ChinaTextbookStudyFree-wp-10` worktree。
导出脚本、测试和配置示例位于本 worktree；生成物保存在被忽略的 `.local/` 子目录。
不修改源题、原型、既有业务代码或 Thinky；验收只运行 runner 的 validate-only，不写数据库、不发布、不提交。

## 命令

需要 Node.js 22+、Python 3，以及已安装依赖且构建完成的 Thinky 契约包。
生成有效 `package.json` 依赖 Thinky 契约 dist v1.6 第二部分，支持
`calculation → calculation | numeric | measurement`、新增活动与 `LessonAuthoringSchema`，
以及字、词、字族词的 `pinyinSource` 与可省略的字拼音；
旧 dist 会如实阻断，不绕过校验，由协调者构建。
默认 `/Users/my-project/AI-PROJECT/thinky` 仍为旧契约，当前完整测试和导出须指定已构建新契约的
`/Users/my-project/AI-PROJECT/thinky-pinyin`。契约测试通过 `options([]).thinkyRoot` 读取 `THINKY_ROOT`；
不设置时，依赖新契约的测试会失败，导出器会明确提示契约依赖，不能据此修改已确认的拼音数据。
无需在本 worktree 安装 npm 依赖。

```bash
export THINKY_ROOT=/Users/my-project/AI-PROJECT/thinky-pinyin
.local/tools/pinyin-venv/bin/python -I scripts/reading-prep/tts_context_candidates.py
node scripts/learning-export/index.cjs
node --test scripts/learning-export/*.test.cjs scripts/reading-prep/*.test.cjs
.local/tools/pinyin-venv/bin/python -I -m unittest discover -s scripts/reading-prep -p 'test_*.py'
```

默认只读输入位置：

| 输入 | 默认位置 |
| --- | --- |
| 修订版题库、原型 | 当前 worktree 若有指定原型则用当前目录；否则只读相邻 `ChinaTextbookStudyFree` 主检出 |
| Thinky 契约及包校验模块 | `/Users/my-project/AI-PROJECT/thinky`（只读） |
| WP-10 证据与本地完整数据 | `/Users/my-project/AI-PROJECT/thinky` |
| 已核语文正文、识写字与词语 | 当前 worktree `content/reading-prep/chinese-g3{up,down}-2026.json`；只读，不修改源稿 |

当前基线 `f522eee` 未跟踪修订版题库和部署原型，因此实际读取主检出的指定文件。
脚本不对该目录执行 git 操作或写入；只在当前 worktree 查询 HEAD。
题库及原有原型 JS 对照 WP-10 冻结 SHA256；笔顺 JS 与许可文件也计入本次输入指纹；PDF 对照原型元数据，
每张页图对照部署父目录 `checksums.json` 的冻结 SHA256 和字节数，并检查 PNG chunk CRC。
来源漂移、缺文件或不完整元数据均阻断，不自动刷新研究证据。

契约根按 `--thinky-root`、`THINKY_ROOT`、默认值取值；证据根独立按
`--evidence-root`、`THINKY_EVIDENCE_ROOT`、默认值取值。
只设置 `THINKY_ROOT` 或 `--thinky-root` 不迁移证据根，WP-10 的已冻结证据仍从原 Thinky 根读取。
证据及完整数据分别读取证据根下的 `docs/learning/evidence/wp-10` 和 `.local/wp-10`。
`.local/wp-10` 是未跟踪的完整证据数据，显式切换证据根时须预先准备完整文件，脚本不会自动迁移或重建。

不同目录可显式指定：

```bash
node scripts/learning-export/index.cjs \
  --source-root /path/to/read-only-content-checkout \
  --site-dir /path/to/family-learning-share-20261027-button-stability/site \
  --thinky-root /path/to/thinky \
  --evidence-root /path/to/thinky
```

导出通过后，在新契约 worktree 运行 runner 验收（`<包目录>` 取导出结果的 `outputDir`，使用绝对路径）：

```bash
cd /Users/my-project/AI-PROJECT/thinky-pinyin
node -r ts-node/register/transpile-only -r tsconfig-paths/register \
  scripts/learning-release/runner.ts import <包目录> --validate-only
```

此命令只校验包、清单和媒体，不执行真实导入或发布。

`--output-root` 可改变输出父目录，但必须位于本 worktree `.local/learning-export/` 内。
输出祖先、版本目录和媒体目录不能经软链指向其它目录。
JSON/Markdown 使用原子替换，不覆盖原有硬链接的 inode；已有媒体只验哈希，不覆盖。

## 输出与身份

输出目录为 `.local/learning-export/<sourceRevision>/`，包含：

- `package.json`：只有完整校验通过才生成，严格符合 Thinky `ContentPackageSchema`。七关评分置于 `books[].lessons[].authoring`；12 份笔顺文档元数据置于顶层 `media`。
- `candidate-package.json`：包或页图清单有契约错误时生成，不能导入或发布；失败命令退出码为 1，仍输出页图清单与报告，不生成有效 `package.json`。
- `pages-manifest.json`：严格符合 Thinky `PagesManifestSchema`，包含四册每个 PDF 物理页的 SHA256、MIME、宽高及印刷页号。
- `media/<sha256>.png`：页图按内容哈希命名，优先硬链接，跨盘或权限不允许时复制；完成后核验目标哈希。
- `media/<sha256>.json`：每个会写字的笔顺文档，保留原型 Make Me a Hanzi 的 strokes/medians，按 JSON UTF-8 字节哈希命名；Character.strokeData 使用 `{sha256,kind:"document"}`。
- `media/<sha256>.mp3`：已生成的 ElevenLabs 读音，按音频字节 SHA256 命名。
- `media-manifest.json`：统一登记页图、笔顺文档与已缓存音频，字段为 schemaVersion、media[]；每项包含 sha256/kind/mime/path/byteLength。这是导出器 sidecar，使用契约 MediaReferenceSchema 加本地 Zod 严格校验，不扩展仅限页图的 PagesManifest。
- `authoring.<sourceLessonId>.json`：五份课级私有 LessonAuthoring（definition、widgetGradings），评分绑定公开关卡的相同 widget/props，保留供审阅。有评分的三课同步嵌入 `package.json` 的课时 `authoring`；另两课省略此字段，避免导入器拒绝空评分。content-sync 直接读取包内字段，不读取独立作者文件；不将 grading 放入公开 content/props。
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

`manifestSha256` 直接调用 Thinky `content-package.ts` 的 `packageHash()`，包含私有 authoring 与文档元数据：
排除 manifest 本身，books 按 sourceBookId、知识点和题目按 id、课时按 ordinal 排序，
media 按 sha256 排序；对象键递归排序后用 `JSON.stringify` 的 UTF-8 字节 SHA256；教学数组保持原顺序。
脚本用独立实现作对照，测试另比较真实 Thinky 算法和 Python 标准库 UUID v5。

## 内容决定与证据

2026-10-28 本任务用户已确认的决定优先于旧证据中的 `draft/needs-human` 状态。
2026-10-29 用户选择 A：`g3down-2026-u101-l03` 恢复 `lessons.csv` 草稿 PDF 88–91，
前课 l02 保持 PDF 86–88；两课只共用 p88，属于 D9 允许的首尾共页。
Thinky 的方案仅作为只读契约与决策依据，课程定义在本仓库导出（Q4）。

| 内容 | 来源与处理 |
| --- | --- |
| 非样例 | 保持 `textbook-only`，不写 opening、takeaways；三年级编号语文课按已核 reading-prep 生成 basicStages，其他非样例不新增基础关；卡片按下述已核数据生成，缺数据保留空数组 |
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

## 三年级语文基础关

`reading-language.cjs` 只读 `chinese-g3up-2026` / `chinese-g3down-2026` 的 reviewed、无 issues 源稿，
通过 `studio-language.cjs` 共用活动生成函数生成基础关。上册 26 个教材编号课拆为 30 个课时，
下册 27 个拆为 31 个；大青树、绝句保留原有 studio 活动，字词显示拼音应用相同标注规则，其余 59 课只增 `basicStages`。
园地、习作、口语交际、快乐读书吧等非编号课不变。

- 朗读使用逐句文本及 paragraphId；组诗按明确 parts/paragraphIds 拆分，保留诗句。
- 朗读正文注音仍采用本课识字表、明确上下文发音提示和 pronunciation-rules；多音字无对应上下文就不注。
- 字词显示拼音只读独立 `pinyin-annotations.json`，优先教材明确拼音（`textbook`），其次核对确认（`reviewed`），再取词典（`dictionary`）。没有可靠拼音时同时省略 `pinyin` 和 `pinyinSource`，不写空串。词语或听写有未确认拼音就采用 `word-only`。
- 词典使用 pypinyin `Style.TONE` 的词组读音，逐字对比九册教材字表和发音规则。实际词组分词命中的字不因多音进入清单；未收词仅检查内置 115 个常用多音字及九册字表/发音规则中确实出现至少两种读音的字。教材读音冲突始终保留。轻声仅认内置常见词、规则词表或两字叠词，后缀本身不作证据；词典已标轻声且与规则一致时直接采用。
- 缺拼音字按同课、同册、九册字表借唯一读音；仍缺时非多音字采用词典，多音字通过本课词语读音判断，无法确定就隐藏。组诗整课识写字表共用并明确标注，不推断子诗归属。
- 原型有笔顺就复用 strokeData；缺笔顺不补造，关内说明看字形、纸上练写，逐课缺字列入报告。
- 词语不少于 4 个才有非计分听写，每轮最多 5 个；缺任何类别的数据都不出空关。
- stage key 为 `<课时ID>/<活动名>`；条目采用固定 UUID v5，输入为课时 ID、类别、源句/段 id 或字词。
  插入、重排其他条目不会重置旧条目身份，缓存仍按既有音频内容与声音设置复用。

`report.json.chineseBasicStages.books` 和 report.md 的“三年级语文基础关覆盖”列出教材编号课数、
拆篇课时数、各类关卡数量、逐课缺失原因、无注音字词、缺笔顺字以及源数据问题。
源稿、发音规则、标注和生成脚本计入输入指纹；导出前逐项核对标注记录的九册原文件 SHA256，原稿变化会要求重跑标注。用户整理的原始文件始终只读。

离线标注与核对流程（解释器已安装 pypinyin，无需联网）：

```sh
.local/tools/pinyin-venv/bin/python -I scripts/reading-prep/annotate_pinyin.py
.local/tools/pinyin-venv/bin/python -I scripts/reading-prep/test_annotate_pinyin.py
```

阅读 `content/reading-prep/pinyin-review.md`：开头统计按首要原因计数，每条只计一次；按教材冲突、轻声、一不变调、多音未收词分节，节内按册、课排列。JSON 的 `reasonCategories` 保留同条全部原因，`category` 是统计及分节采用的首要原因。在对应条目的 `decision` 填完整拼音（例如 `rè nao`）或 `"hide"`，再重跑标注和导出。Markdown 勾选框仅方便查看，真正决定来自 JSON。未决定保持 `null`。决定绑定上下文指纹，源条目、课文、词语、教材读音或规则变化会把旧决定移入 `staleDecisions`，不会静默沿用。这三份标注文件与原稿分离。

含“一/不”的词在 Markdown 合并为一节，JSON 顶层 `decision.yiBuToneStyle` 支持 `"original"`（本调 `yī` / `bù`）或 `"sandhi"`（按后字声调处理变调，另处理 A一A/A不A、第一和数字串），未决定时为 `null`。当前用户已确认 `"sandhi"`，63 条逐项决定全部完成，待核对及隐藏均为 0。每条 `yiBuSuggestions` 提供两种候选；逐条完整拼音或 `"hide"` 优先于全局设置。全局决定只解决一不原因，兼有教材冲突、轻声或未收词多音的条目仍须逐条确认。仅由全局决定解决的条目标记 `resolvedByGlobal: true`、输出 `pinyinSource: "reviewed"`；`summary.pendingReasonCounts` 记录剩余待核对数。不改变 TTS 文本。决定文件由协调者与用户维护，测试修复不重写这些文件。

`report.json.pinyin` / report.md 分别记录原稿条目数和导出条目出现次数；后者含听写、字族词、组诗共用字表重复，不重复计算包内私有 authoring 镜像。`scripts/reading-prep/supplemental-pinyin-items.json` 单独记录冻结原型中的字族词及其 SHA256 来源，不加入用户整理的教材词表；这些词适用相同核对规则，与教材词表重合时共用核对决定。

兼容要求：Thinky 契约需支持 `pinyin?`（缺省不显示）和 `pinyinSource?: 'textbook' | 'reviewed' | 'dictionary'`。可只读选择另一路 worktree：

```sh
THINKY_ROOT=/Users/my-project/AI-PROJECT/thinky-pinyin \
THINKY_EVIDENCE_ROOT=/Users/my-project/AI-PROJECT/thinky \
  node --test scripts/learning-export/*.test.cjs scripts/reading-prep/*.test.cjs
node scripts/learning-export/index.cjs --thinky-root /Users/my-project/AI-PROJECT/thinky-pinyin
node scripts/learning-export/index.cjs --thinky-root /Users/my-project/AI-PROJECT/thinky-pinyin --validate /absolute/path/to/bundle/package.json
```

`THINKY_EVIDENCE_ROOT` 允许显式选择证据根；主检出已是默认证据根，通常只需设置 `THINKY_ROOT`。显式 `--evidence-root` 优先。缺少 `PinyinSourceSchema` 的旧契约在导出前明确阻断；其他契约校验失败仍输出候选包与诊断，不填占位拼音、不删字词绕过。源代码已修改但 dist 未构建时也会阻断，本任务不构建或修改 Thinky。
字族词 `CharacterFamily` 也输出同一来源字段；如果 Thinky 只更新 `Character` / `LanguageWord`、未更新 `CharacterFamily.pinyinSource`，报告将明确列出 `Unrecognized key: "pinyinSource"`，仍生成候选包。

契约完整支持后，重新导出有效包，再在对应 worktree 运行只校验命令：

```sh
cd /Users/my-project/AI-PROJECT/thinky-pinyin
NODE_ENV=learning-local node -r ts-node/register/transpile-only -r tsconfig-paths/register \
  scripts/learning-release/runner.ts import /absolute/path/to/bundle --validate-only
```

runner 验收须使用通过新契约校验后生成的有效 `package.json`；候选包不能当成有效包使用。

TTS 与导出器读取相同基础关和条目 ID，收集逐句、整篇、单字带词读、词语与卡片。导出器在 TTS 选择缓存之后应用显示注音，核对结果不改变原有带词读、朗读文本与缓存键。
整篇 audio 位于 ReadAloud props，单句 audio 位于 sentences；现有契约没有独立整段音频槽，
段落通过 paragraphId 分组。有有效缓存才附 audio，无则省略并回退设备朗读。
只处理三年级两册：

```sh
node scripts/learning-export/tts-elevenlabs.cjs --dry-run \
  --book chinese-g3up-2026 --book chinese-g3down-2026
# 用户在可联网环境执行实际生成（本次未生成音频）
node scripts/learning-export/tts-elevenlabs.cjs \
  --book chinese-g3up-2026 --book chinese-g3down-2026
```

`--book` 可重复；dry-run 输出逐册条目数、实际朗读字符数、缓存数及去重后新请求字符数。
卡片仍没有可下发 audio 的契约字段，准备缓存不代表卡片已具备音频引用。未挂载的卡片录音保留缓存命中及 `contract-unsupported` 报告，但不写入包内媒体；与支持的活动共享同一录音时，仍按该活动的实际引用打包。
Thinky 单音频上限为 2 MiB（2,097,152 字节）。超过上限的缓存保持原样，导出时不挂载或打包，条目回退设备朗读；
`report.json.audio.rejectedMedia` 与 Markdown 的“超限音频”列明条目、大小及原因。

## textbook-only 卡片与来源覆盖

`cards.cjs` 在原有课时、题目归属组装后提取卡片。每课有至少 3 个可靠候选才保留，最多 8 张；不足 3 张时保留 `cards: []`，不重复内容凑数。studio 五课的 15 张原卡不变。

- 数学优先使用冻结 `textbook-data.js` 中明确映射到本课的 `knowledge.coreConcept/keyFormula/tips`，只为原文答案添加问句。它们是项目原创配套讲解，未经教师审定，不能称为教材原文。不足时才从已归属配套题库挑独立可读、无图示依赖且有唯一简短答案的题；保留原答案，不复算，不把错句当概念。知识点标题本身不作答案。
- 语文先核对源稿教材 SHA256、总页数与冻结版一致，且本课为 `reviewed`、`issues: []`。优先写字表、其次识字表；单字必须同时有本课识字表唯一明确拼音和本课词语表组词。不跨课借读音，不猜组词。词语本身无明确整词拼音时不生成词音卡，不能用单字读音拼接而忽略轻声等差异。
- 古诗只从 `parts.paragraphIds` 关联的原文诗行生成“接下一句”卡。分篇 ID 或同书同组内唯一精确标题必须对应；整组诗共用字表不能强分给子诗。三上每诗单段四行、三下每诗四段均按所属 `sentences` 提取。原有绝句 studio 卡不追加。
- `key` 使用固定 UUID v5 命名空间，输入为课时 ID 加来源 ID：知识点 ID/字段、生字或词语的教材课号/文字、诗篇/上句、题库文件/section/源题 ID（缺 ID 才用内容哈希）。不使用候选次序、句序、题目数组下标，源数组插入或重排不会重置同一卡片身份。

盘点范围与覆盖按导出课时计算，包含 studio，详见新包 `report.json.cards.sourceCoverage` 和 `report.md`。识字/写字表的整组三诗会计入各子诗的“有来源”覆盖，但实际提卡不将共享字表强分到单首。当前来源范围为：

| 来源 | 覆盖与限制 |
| --- | --- |
| 冻结知识讲解 | 数学 86 知识点映射到 105/108 课；语文 105/105 目录项有配套讲解，但不代替本次字词或古诗依据 |
| 已核语文正文 | 三上 26、三下 27 个教材编号课，对应 30/52、31/53 个导出目录项；12 首古诗有明确分篇 |
| 识字表 | 三上 30/52、三下 31/53 个目录项有来源，共 494 条；含整组诗共用字表 |
| 写字表 | 三上 23/52、三下 25/53 个目录项有来源，共 441 条；缺明确拼音的会写字不补音 |
| 词语表 | 冻结原型三上 20/52、三下 22/53，共 521 词（含园地）；编号课源稿 470 词，不含园地；仅词形不足以生成读音/释义问答 |
| 配套题库 | 数学 656、语文 790 道，全部有原答案与解释；有题引用覆盖及可独立短答覆盖逐册记录，不称教材课后原题 |
| studio 与 companion guides | 五课 15 张原卡；guides 仅毫米、大青树两课各 2 个明确自编例子，不作全册教材例题来源 |
| 日积月累、单元要点、教材例题/课后题 | 有教材扫描页，但没有新的已核逐课结构化原文，本次不靠 OCR 或目录摘要编造；不把已有配套讲解标为教材原结论 |
| 旧版 `data/passages` | 无当前版本教材哈希，不作为本轮来源 |

报告每册新增 `lessonsWithCards`、`cardCount`、`noCardLessons`（ID、标题、原因），逐卡来源保存在 `cards.provenance`。未核稿、没有字词原文、缺明确拼音/组词交集、少于 3 张候选分别解释。源稿与脚本均参与输入指纹，读取中发生变化会阻断。

卡片文本接入现有 `tts-elevenlabs.cjs`，可用 `--dry-run --only <sourceLessonId>` 查看，稳定条目 ID 为 `<lesson>/cards/<card.key>/<field>`。生字沿用组词带读和覆写机制；本次不合成音频。当前 `CardDefinitionSchema` 无 `audio` 字段，收集条目标记 `supportsAudio: false`，不会向公开卡片增加契约外字段；缓存可准备，但下发播放仍需消费端另行接线。含拉丁变量/单位的数学文本不做删字合成。

重新生成后可用 release runner 离线验包（参数为整个目录）：

```bash
cd /Users/my-project/AI-PROJECT/thinky
node -r ts-node/register/transpile-only -r tsconfig-paths/register \
  scripts/learning-release/runner.ts import /absolute/path/to/bundle --validate-only
```

该命令不连数据库、不写媒体、不导入或发布内容。

`edition: "2026"` 保留原型的应用版本标识，不表示官方出版年份。
publisher 使用已核四册的人民教育出版社；教材标题保持原型标题。

物理页与印刷页分离：数学只在逐页记录明示的正文区间使用 `physical - 6`；
语文只采用目录已核起页，不按固定偏移填满中间页。无法确定的印刷页号为 `null`，全部列入报告。
`bookPageLabel` 只采用现有已采信的印刷页号证据，不推算偏移，也不显示 PDF 物理页序：
本课范围内每一页都有印刷页号且为连续整数时，生成“书上第 a–b 页”，单页生成“书上第 a 页”；
否则，起始物理页有可靠印刷页号时生成“书上第 a 页起”，其余生成“课本原页”。
数学 D9 允许相邻课时首尾共页，其它内部交叠阻断；语文同页多诗、共享练习允许重叠。

## 校验与测试

脚本在内存转译并读取 Thinky `content-package.ts`、`content-validation.ts`、`activity-validation.ts`，
使用其真实 `ContentPackageSchema`、`validateContentPackage()` 和已构建契约包。
页图清单使用同一契约 dist 导出的 `PagesManifestSchema` 校验，结果并入报告的 `checks`、`valid` 与 `issues`；
未知字段或其它清单错误与包错误一样阻断有效包输出。
不构建或写入 Thinky。即使包级结构错误导致 Thinky 提前返回，仍独立运行并报告：

- 每课 `LessonDefinitionSchema` 及 `validateLessonDefinition()`，覆盖黑名单、totalPages、同书 questionRefs。
- `validateLessonCatalog()`，覆盖知识点引用及数学内部页段交叠。
- 每题 `validateQuestionImport()`，传入已知知识点与原始显式元数据。
- 唯一身份、同书/单元归属、页码和引用等发布端附加检查由 Thinky 权威校验执行。

content-sync 的文档元数据格式为 `media:[{sha256,kind:"document",mime:"application/json"}]`，
不含 path/byteLength，也不在此数组放页图；媒体文件仍为 `media/<sha256>.json`。
包中每个笔顺引用和文档元数据必须双向匹配。导入器会核对文件字节哈希及 strokes/medians 结构。
authoring.definition 必须等于同一课的 content，每条 widgetGradings 绑定相同 stageKey/widget/props。

本轮七关答案均已核对冻结原型 `lesson-studio.js`，没有缺答案的关卡：

| 课程与关卡 | 原型答案 | 原型位置 |
| --- | --- | --- |
| 毫米 extension-1 | 毫米、厘米、毫米、厘米 | 734；反馈 772 |
| 毫米 extension-3 | >、=、< | 735；反馈 780 |
| 轴对称 basic-1 | 等腰三角形、爱心、长方形为是，平行四边形为否 | 790–793；反馈 804 |
| 轴对称 basic-2 | 正方形 4、长方形 2、等边三角形 3、圆 infinite，含轴坐标 | 796–799；圆说明 829 |
| 轴对称 extension-2 | 中田王山为是，我七为否 | 802；解释 844 |
| 大青树 extension-2 | 坡、飘、扬、洁 | 222–225；含错误选项追加提示的完整反馈 347 |
| 大青树 extension-3 | 声旁求、乎、票、召、吉、皮 | 245–250；反馈 351 |

使用真实 content-sync 作不连库校验：

```bash
cd /Users/my-project/AI-PROJECT/thinky
NODE_ENV=learning-local node -r ts-node/register/transpile-only -r tsconfig-paths/register scripts/content-sync/cli.ts validate /absolute/path/to/bundle
```

单独只读校验一个包：

```bash
node scripts/learning-export/index.cjs --validate .local/learning-export/REVISION/package.json
```

测试包括真实四册两次全量导出逐文件字节比较（含媒体）、权威哈希、UUID v5、源文本抽样、
用户决定、共享题引用、页图清单契约通过、印刷页号转字符串与报告证据保留，
三种页码标签规则及单页写法、真实包所有 `bookPageLabel` 均无“PDF”或重复起止页码，
以及清单多余字段阻断、缺字段、黑名单、越界、坏引用、数学交叠、未知知识点、
推断歧义、人工规则失效、显式元数据冲突、冻结媒体漂移、坏 PNG CRC、输出软链、复制损坏等反例。
额外覆盖旧包 19 个错误重现、七关逐项评分缺失、包内作者数据与审阅文件一致、
私有评分参与包哈希、文档元数据排序，以及真实 content-sync CLI 对完整目录的校验。
契约 dist 为旧版本时，依赖 v1.6 映射的测试会失败，必须报告具体失败与版本原因；
负向校验使用真实导出包的内存副本，不绕过映射校验，不据此宣称真实包校验通过。

## 生成读音音频

使用 Node.js 22+ 内置 `fetch`，无需新增依赖。真实合成由用户在有网络的环境运行；测试只使用模拟 fetch，不调用 ElevenLabs。

1. 在仓库根目录复制配置示例，编辑 `.env.local`，填写 `ELEVENLABS_API_KEY` 和 `ELEVENLABS_VOICE_ID`。不要提交真实 key，不要把 key 放进命令参数或分享终端环境。环境变量优先于文件；API key 只从这两个位置读取。

   ```bash
   cp .env.local.example .env.local
   ```

2. 先预览数量与字数。dry-run 同时显示模型、language_code 是否生效，以及单字的实际朗读文本示例。没有 key 或 voice id 也可以 dry-run；填写实际 voice id 后重跑，缓存命中统计才对应这套声音。

   ```bash
   node scripts/learning-export/tts-elevenlabs.cjs --dry-run
   ```

3. 先选一课生成对比样本。`--sample` 必须与 `--only` 一起使用，从指定课按稳定顺序选择 3 个单字、3 个词语、2 个句子，共 8 条，方便一次试听。每类按原文本去重并排除跳过项，数量不足时直接报错，不调用合成；不能与 `--limit` 同用。课程 ID 沿用导出器；五课中的三节数学课当前没有这些语文读音条目。

   ```bash
   node scripts/learning-export/tts-elevenlabs.cjs --only chinese-g3up-2026-u1-kp1 --sample
   ```

   终端与 `.local/tts-cache/sample.txt` 列出真实生成的每条样本的条目 ID、实际朗读文本，以及 `.local/tts-cache/` 下 MP3 文件的绝对路径和状态。可加 `--dry-run` 预览，报告写入独立的 `.local/tts-dry-run/plan.json`、`sample.txt`，不写入音频缓存目录，此时 `planned` 表示尚未生成；`success` / `cached` 可直接试听，`failed` 需重试。真实生成的 `.local/tts-cache/plan.json`（预览为 `.local/tts-dry-run/plan.json`）也含条目 ID、实际朗读文本和缓存键；按路径打开音频试听。多音字会在终端及计划的 `needsListeningReview` 提醒。需要调整时，编辑入库的 `scripts/learning-export/tts-overrides.json`，重跑 dry-run 和 sample。例如：

   ```json
   {
     "entries": {
       "chinese-g3up-2026-u1-kp1/basic-1/characters/read-12": { "skip": true }
     },
     "texts": {
       "闹": { "word": "热闹" },
       "扬": { "text": "扬，飘扬的扬" }
     }
   }
   ```

   上面的 ID 仅演示格式，实际 ID 从 plan.json 复制。`entries` 按精确条目 ID 优先，`texts` 按原文本匹配；覆盖优先于自动选词。值可为字符串或 `{ "text": "实际朗读文本" }`；单字也可用 `{ "word": "组词" }` 指定带读词，`{ "skip": true }` 跳过。覆写只改变合成文本，条目 ID 和课程显示文字保持原样。

4. 全量生成，然后重新导出，交给协调者在 Thinky 补齐音频支持后导入、发布。

   ```bash
   node scripts/learning-export/tts-elevenlabs.cjs --concurrency 2
   node scripts/learning-export/index.cjs
   node --test scripts/learning-export/*.test.cjs
   ```

   `--only chinese-g3down-2026-u1-kp1` 可只生成绝句课，`--limit N` 按稳定条目顺序限制试生成范围。脚本与导出器共用 `--source-root`、`--site-dir`、`--thinky-root` 和 `--evidence-root` 输入选项。失败条目不阻塞其他条目，结果写 `result.json`，有失败时退出码为 1。429/5xx 使用指数退避，默认最多重试 3 次。同一缓存目录的真实生成通过 `.generation.lock` 互斥；重复启动会直接提示已有任务，避免重复计费和清单互相覆盖。正常结束或可捕获错误会释放锁；若进程被强制结束，先确认没有生成任务在运行，再手动删除 `.local/tts-cache/.generation.lock` 后重试。

可选变量见 `.env.local.example`：模型默认 `eleven_v4`，`ELEVENLABS_LANGUAGE_CODE` 默认 `zh`（普通话），可在 `.env.local` 覆盖或设为空以关闭语言指定。仅当模型不是 `eleven_multilingual_v2` 且语言代码非空时发送 `language_code`。`eleven_multilingual_v2` 不支持该参数；若保留旧模型配置并配置了语言代码，终端会提示“该模型不支持指定中文，建议改为 eleven_v4”。脚本不会修改用户的 `.env.local`，切换模型需自行编辑。格式默认 `mp3_44100_128`，语速 `ELEVENLABS_SPEED=0.85`、稳定度 `ELEVENLABS_STABILITY=0.65`、相似度 `ELEVENLABS_SIMILARITY_BOOST=0.75`，另可设置 `ELEVENLABS_STYLE`、`ELEVENLABS_USE_SPEAKER_BOOST`。这些是试听起点，可按声音调整。

单字默认带词读，例如“扬，飘扬的扬”；`tts-overrides.json` 始终最高优先。新增语文基础关从 `tts-context-candidates.json` 取本课字音与候选，教材明确字音优先，其次取本课 `pinyin-annotations.json` 中的已核字音，绝不从另一课借字音。每个候选中该字的每次出现都必须与本课确认音（含声调）一致，来源依次为：

1. 本课词语表，保持词表顺序。
2. 课文正文中真实被 pypinyin 词组词典收录的 2–4 字词，优先二字词，其次正文位置。
3. 同册其他课词语表，其次九册其他词语表。
4. 非多音字仍无词时单读，报告标“单读”；多音字仅在字音为 `textbook` / `reviewed` 时继续找同音的常用词典词，无匹配才暂停。

候选生成器只读九册原稿、拼音标注和发音规则，不重写数据或决定；产物携带输入和脚本 SHA-256，过期时导出/TTS 阻断并提示重生成。候选本身不进入课文、词语表或显示内容，只改变朗读文本与相应音频缓存键。当前 pypinyin 词组词典未收录“罚站”“斜阳”，不能把它们伪标成正文词典来源。原 studio 和卡片保持既有选词方式；单字覆写依旧适用。

`plan.json.characterContextSources`、`singleReadings` 与导出报告的同名字段分别列出来源条目数和单读详情；暂停另列 `pronunciationIssue`。这些数量按关卡出现次数统计，识字/写字和组诗共用字表重复计算。

### 声调不准时怎么办

先试听 `eleven_v4` + `ELEVENLABS_LANGUAGE_CODE=zh` 与单字带词读；原来写有 `ELEVENLABS_MODEL_ID=eleven_multilingual_v2` 的 `.env.local` 需要手动改为 `eleven_v4`。多音字优先用 `tts-overrides.json` 指定符合本课语境的组词或完整朗读文本，再用 `--sample --only` 试听。仍不准确时，可考虑支持拼音标注的语音服务。

费用按**实际送入合成的文本字符数**估算，含覆写后的上下文、标点和空白。计划给出所选条目总字数、命中缓存数、需新生成数，以及去重后新请求的计费字数；同文本在不同关卡共用一次请求。计划中的 credit 数仅作参考，实际模型费率、额度、套餐及金额以 ElevenLabs 账户结算为准，不在脚本内固定金额。重试已到达服务端的请求可能再次计费。

音频及清单位于被忽略的 `.local/tts-cache/`：`<cacheKey>.mp3`、每键 JSON 校验记录、`manifest.json`（ID → 缓存键 → 音频 SHA256/字符数，并保存历史缓存索引）、`plan.json`、`result.json`、`sample.txt`（对比样本列表）。API key 不进入这些清单、文件名或日志。缓存键覆盖实际朗读文本、voice id、model id、language_code、全部 voice settings 和输出格式；命中且字节哈希正确才复用。改 `ELEVENLABS_VOICE_ID` 会生成新的缓存键并重新请求，切回旧声音可复用旧缓存。改读法、语速、模型或语言代码同样如此。重跑无需删除缓存，删除缓存可能造成再次计费。

收集范围直接复用 studio 转换后的课、关卡、条目 ID：识字单字、词语/听写词、会写字及其字族词、逐句与整篇朗读、绝句各关的诗句及对仗、再读一首。每课覆盖见 `report.json.audio.lessons` / `report.md` 的“音频覆盖”；详细条目列出 `attached`、`missing`、`skipped` 或 `contract-unsupported`。有文件与 props 已引用分开统计。

**Thinky 当前支持边界（本次只读核查）**：

- 契约允许 `characters[].audio`、`characters[].family[].audio`、`words[].audio`、`sentences[].audio`、`pairs[].audio` 及 `ReadAloudProps.audio`，引用严格为 `{sha256,kind:"audio"}`；有缓存即写入，缺缓存省略以保留设备朗读兜底。字族词保留 `text`/`word` 两种文案；整篇文本按 sentences 顺序以换行拼接，适用于 reading/listen。
- 音频元数据写入 `package.json.media`（`sha256/kind:"audio"/mime:"audio/mpeg"`）及 `media-manifest.json`（另含 `path/byteLength`），文件为 `media/<sha256>.mp3`。Thinky content-sync 校验音频引用、清单、文件大小、SHA256 和完整 MP3 帧，并支持导入与发布。
- Thinky 媒体接口支持 MP3 下发与单段 Range 请求、206/416 响应。报告 `deliverySupported` 表示主检出源码具备该能力；本次没有修改 Thinky，也不代表已部署或完成实际播放音质验收。

## 当前表达缺口

保留以下可追溯缺口，逐关详情以最新 report.json/report.md 为准：

- 周长题保留原句“一个正方形边长是5分米，求它的周长。”；按用户决定判分为 dm，
  待作者将末句补为“它的周长是多少分米？”。
- 原先九处 concept-card 降级全部改为真实活动：unit-choice/compare、words/dictation/detective/imitation、scene/pairs/listen；答案和逐选反馈保存在私有 authoring，不进入公开 props。
- cube 活动与已知投影、ruler 视口与预设/步骤、对称私有反馈与轴序/汉字答案、朗读自然段与注音/停顿/家长任务、字族拼音释义、字符教学字段和小老师/家长出错卡均已导出。
- 当前 12 个会写字均有真实笔顺文档。ElevenLabs 缓存可作为稳定音频媒体；设备 TTS 与临时录音不作为媒体源；复习模式替代遍没有专用作者字段，不新增必做遍。
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
