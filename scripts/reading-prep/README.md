# 语文配音文本

正文、逐句文本和教材字词表保存在 `content/reading-prep/`。这是配音前的编辑源稿，独立于课堂关卡；整理文本不会把课本练习课改成 studio 课。

目标范围以 `content/reading-prep/inventory.json` 登记的本地现有教材为准：一、二、三年级上下册，以及四、五、六年级上册，共九册。四至六年级下册当前没有对应新版 `book.pdf`，单独登记缺口。资源 ID 的 `2026` 不是出版年份证明。

每册整理全部编号阅读课及识字课。古诗、组诗、分标题课文保留篇目划分。习作、语文园地、口语交际不算编号课文。一年级拼音内容另存 `phonicsLessons`，不混进课文配音条目。原有两课也列入清单便于检查覆盖，但不修改已经生成的音频或原有 studio 数据。

每课保留以下内容：

- `lessonNumber`、`title`、`sourceLessonId`：教材课号、标题和导出目录 ID；尚未建立导出目录的课程保留 `sourceLessonId: null`。
- `lessonKey`、`lessonType`：低年级识字/阅读课各自从 1 编号时，用稳定键区分，避免相同课号覆盖。三年级等课号全册唯一时可省略。
- `paragraphs`：全文按教材段落排列，逐段记录 PDF 物理页。
- `sentences`：后续逐句播放所需的文本，关联原段落。分句必须保留原字和标点。
- `parts`：古诗、分标题课文的子篇标题及段落归属。
- `recognitionCharacters`、`writingCharacters`：分别来自教材识字表和写字表。拼音只录教材明确标出的读音，不自动猜音。
- `words`：教材词语表或课后读记中列出的词语，保留具体来源。
- `status`、`issues`：本轮核对状态及具体未决项。教材没有列出的字词表项目允许为空，须区分未列与漏录。

`source` 固定教材 PDF 的路径、SHA-256 和总页数。`pdfPages` 均为从 1 开始的 PDF 物理页，不当作印刷页码展示。旧版 `data/passages` 只可用于辅助比对，不能覆盖新版教材。

## 生成可阅读清单与待配音条目

在本 worktree 根目录执行：

```sh
node scripts/reading-prep/build.cjs
```

脚本离线校验教材哈希、各册目录预期课数、稳定课号、段落来源页、逐句文本拼接及字词来源；有正文缺失、分句丢字或哈希变化时失败。新增各册的独立尾表在 `content/reading-prep/tables/<book-id>.json`，原三年级尾表保留在 `character-tables.json`。结果写入 `.local/reading-prep/review/`：

- `summary.md`：全册覆盖统计与待核对项。
- `chinese-g3up-2026/01.md` 等：逐课全文、生字和词语阅读稿。
- `narration-manifest.json`：带稳定 ID、文字哈希与来源页的条目清单；尚待核对的课保留 `readyForSynthesis: false`。

整理过程中可执行 `node scripts/reading-prep/build.cjs --partial` 仅预览 inventory 中标记为 `prepared` 的教材文件；清单会明确标出尚未纳入的册，不代表全量完成。默认命令要求 inventory 中的全部教材文件存在并通过校验。

本次九册全部完成：232 个编号阅读/识字课、14 个单列拼音课。古诗、书信、文言文及材料组保留教材结构；地图标注、时间表和示意图数据放在 `supplements`，不改写为讲解，也不混入普通课文配音条目。原稿中的 `literalSpans` 只记录已对照原页确认的特殊文字，例如《枫树上的喜鹊》正文确有 `a、o、e`，不能当成 OCR 杂字删掉。

另外生成 `phonics-manifest.json` 和 `supplement-manifest.json`，分别保留拼音内容与图表文字。这两类未选择具体发音/朗读形式，保留 `readyForSynthesis: false`；正文清单中的就绪标志仅表示文字已核对，不代表音频已经生成或读音已经试听。

该命令不读取语音凭据、不调用 ElevenLabs、不改变既有音频缓存，不导入数据库。清单中的生字是原字，配音读音由下面的独立准备流程处理；课文、字词清单与课堂 props 的正式挂接另行处理。

## 发音准备与批量配音计划

先重建文本清单，再运行配音准备入口。默认只生成本地计划，没有语音服务请求：

```sh
node scripts/reading-prep/build.cjs
node scripts/reading-prep/tts.cjs
```

入口校验教材 PDF 哈希、逐课核对状态、条目原文哈希，以及清单与当前编辑源稿是否一致。修改源稿后未重建清单会报错；不会用旧清单继续准备。

`pronunciation.cjs` 与 `content/reading-prep/pronunciation-rules.json` 负责发音规则。保留 `text` 和教材来源不变；数字等合成用改写只存在于 `readingText`，不能回写教材正文。单字使用教材词语或课文上下文带读，并结合教材明确拼音检查多音字。无法确定的读音或上下文列入阻塞清单。轻声和“一、不”变调保留汉字语境；期望拼音、古诗文通假字和罕见字列入核对记录，合成后仍须试听。书面拼音元数据本身不等于 ElevenLabs 已按该音生成。

默认输出到 `.local/reading-prep/tts-plan/`：

- `summary.md`：各册、逐课、各播放类型的条目数、阻塞项、缓存命中与去重请求统计。
- `plan.json`：每条教材原文、实际朗读文本、声音配置指纹、缓存键与预计字符消耗。
- `pronunciation-review.json`：无法确认的项目、试听提醒、读音和上下文依据。
- `pronunciation-review.md`：暂停条目的可阅读清单，标明课文、片段、读音与来源页。

这里的字符消耗包含标点和空白，按实际 `readingText` 去重后估算。credits 使用既有脚本的参考算法；没有查询账户余额或实时费率，不代表服务端报价。整篇、分篇和逐句是不同音频素材，可按用途筛选后再计算。分组去重数不能相加作为全局消耗。

支持按册、稳定课号键和播放类型准备；以下命令仍然全部是离线计划：

```sh
node scripts/reading-prep/tts.cjs --book chinese-g3up-2026 --lesson 01 --output-dir .local/reading-prep/tts-plan/g3up-01
node scripts/reading-prep/tts.cjs --book chinese-g1down-2026 --lesson reading-04 --kind character,word --output-dir .local/reading-prep/tts-plan/g1down-reading-04
node scripts/reading-prep/tts.cjs --kind whole,sentence --output-dir .local/reading-prep/tts-plan/readings
```

一年级等课号重复的册必须使用 `literacy-01`、`reading-01` 等清单中的 `lessonKey`；完整课程 ID 也可直接传给 `--lesson`。`--limit N` 只选清单中前 N 条，不能当作整册估算。

将来显式传入 `--generate` 才会启用生成，复用 `scripts/learning-export/tts-elevenlabs.cjs` 的声音设置、请求去重、并发锁、重试和缓存恢复；本次只验证离线准备和模拟请求。共享缓存仍是 `.local/tts-cache/`，新计划和运行结果不会覆盖旧入口的 `plan.json`、`result.json`。只有朗读文本、声音参数和音频哈希一致才复用，原来两课的音频不会因条目 ID 不同而失去复用机会，也不会被直接覆盖。失败或中断后重跑同一范围会检查已有缓存。

14 个拼音课和图表清单继续独立保留。普通课文中的真实 `a、o、e` 也不能直接按英文字母合成；没有选定可靠的拼音发音方式前，相关朗读条目保留为阻塞。

## 离线 OCR 辅助复查

教材为扫描件。`ocr.swift` 用 macOS PDFKit 和 Apple Vision 离线识别，保留文本框坐标及置信度，用于定位和辅助校对，不直接作为审定原文。

```sh
mkdir -p .local/reading-prep
swiftc scripts/reading-prep/ocr.swift -o .local/reading-prep/ocr
.local/reading-prep/ocr /absolute/path/book.pdf .local/reading-prep/book-id
```

可再传起止物理页。已有页会跳过，图像和 OCR 中间结果留在本地，不提交。OCR 会漏“的”、误认形近字及标点，正文与字表须对教材图像校正。

`text-layer.py` 与 `table-layer.py` 需 `pdfplumber`。对于含文字层的册，前者按正文字号筛除编码拼音与重复描红，后者保留尾表汉字和字音字形坐标，并解码教材拼音字体。二者都按真实 `page.bbox` 排除页外隐藏文本；输出仅为校对辅助，不自动判定正文边界或审核通过。
