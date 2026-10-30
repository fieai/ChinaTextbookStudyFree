# 拼音人工核对清单

总数 63 条；待核对 0 条；已确认 63 条；隐藏 0 条；过期决定 0 条。

按首要原因归类，每条只计一次；同条的其他原因保留在 JSON 和明细中。

| 原因 | 总数 | 待核对 |
| --- | ---: | ---: |
| 教材冲突 | 16 | 0 |
| 轻声 | 30 | 0 |
| 一不变调 | 4 | 0 |
| 多音未收词 | 13 | 0 |

编辑 pinyin-review.json：逐条 decision 填完整拼音（例如 rè nao）或 hide，可覆盖全局一/不决定；重跑本脚本并重新导出。Markdown 勾选框仅供阅读，JSON decision 才会生效。

教材明确拼音 > 人工核对 reviewed > 词典 dictionary；未决条目省略 pinyin。

教材词语表的标调惯例尚未确认；含一/不的词合并核对，建议统一按本调 yī / bù 处理。顶层 decision.yiBuToneStyle 填 original（本调）或 sandhi（变调），未决定为 null；不改 TTS 朗读文本。

decision 绑定条目、课文/词语上下文、教材已知读音、规则和词典版本；指纹变化的旧决定进入 staleDecisions，不自动沿用。

## 教材冲突

### chinese-g3up-2026 第 8 课 总也倒不了的老屋

- [x] 词 **意思** | 建议：yì si | 原因：教材读音冲突：思 建议 si，教材已知 sī；决定：yì si | ID `chinese-g3up-2026:8:words:意思`

### chinese-g3up-2026 第 12 课 在牛肚子里旅行

- [x] 词 **大吃一惊** | 建议：dà chī yī jīng | 原因：教材读音冲突：大 建议 dà，教材已知 dài；一/不变调：建议统一展示本调 yī / bù，教材惯例待全局确认；决定：dà chī yì jīng | ID `chinese-g3up-2026:12:words:大吃一惊`

### chinese-g3up-2026 第 16 课 富饶的西沙群岛

- [x] 词 **鹿角** | 建议：lù jiǎo | 原因：教材读音冲突：角 建议 jiǎo，教材已知 jué；未收词含常用多音字：角；决定：lù jiǎo | ID `chinese-g3up-2026:16:words:鹿角`

### chinese-g3up-2026 第 21 课 大自然的声音

- [x] 词 **大自然** | 建议：dà zì rán | 原因：教材读音冲突：大 建议 dà，教材已知 dài；决定：dà zì rán | ID `chinese-g3up-2026:21:words:大自然`

### chinese-g3down-2026 第 6 课 会摇尾巴的狼

- [x] 词 **温和** | 建议：wēn hé | 原因：教材读音冲突：和 建议 hé，教材已知 huò；决定：wēn hé | ID `chinese-g3down-2026:6:words:温和`
- [x] 词 **相信** | 建议：xiāng xìn | 原因：教材读音冲突：相 建议 xiāng，教材已知 xiàng；决定：xiāng xìn | ID `chinese-g3down-2026:6:words:相信`

### chinese-g3down-2026 第 10 课 石蜂

- [x] 词 **大约** | 建议：dà yuē | 原因：教材读音冲突：大 建议 dà，教材已知 dài；决定：dà yuē | ID `chinese-g3down-2026:10:words:大约`

### chinese-g3down-2026 第 13 课 纸的发明

- [x] 词 **伟大** | 建议：wěi dà | 原因：教材读音冲突：大 建议 dà，教材已知 dài；决定：wěi dà | ID `chinese-g3down-2026:13:words:伟大`
- [x] 词 **便宜** | 建议：pián yi | 原因：教材读音冲突：宜 建议 yi，教材已知 yí；决定：pián yi | ID `chinese-g3down-2026:13:words:便宜`

### chinese-g3down-2026 第 17 课 我变成了一棵树

- [x] 词 **形状** | 建议：xíng zhuàng | 原因：教材读音冲突：状 建议 zhuàng，教材已知 zhuàn；决定：xíng zhuàng | ID `chinese-g3down-2026:17:words:形状`
- [x] 词 **互相** | 建议：hù xiāng | 原因：教材读音冲突：相 建议 xiāng，教材已知 xiàng；决定：hù xiāng | ID `chinese-g3down-2026:17:words:互相`

### chinese-g3down-2026 第 22 课 火烧云

- [x] 词 **乘凉** | 建议：chéng liáng | 原因：教材读音冲突：乘 建议 chéng，教材已知 shèng；决定：chéng liáng | ID `chinese-g3down-2026:22:words:乘凉`

### chinese-g3down-2026 第 23 课 暴风雨来临之前

- [x] 词 **奇形怪状** | 建议：qí xíng guài zhuàng | 原因：教材读音冲突：状 建议 zhuàng，教材已知 zhuàn；决定：qí xíng guài zhuàng | ID `chinese-g3down-2026:23:words:奇形怪状`
- [x] 词 **轰隆隆** | 建议：hōng lōng lóng | 原因：教材读音冲突：隆 建议 lóng，教材已知 lōng；未收词含常用多音字：隆；决定：hōng lōng lōng | ID `chinese-g3down-2026:23:words:轰隆隆`

### chinese-g3down-2026 第 25 课 慢性子裁缝和急性子顾客

- [x] 词 **大方** | 建议：dà fāng | 原因：教材读音冲突：大 建议 dà，教材已知 dài；可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：dà fang | ID `chinese-g3down-2026:25:words:大方`

### chinese-g3down-2026 第 26 课 漏

- [x] 词 **骨头** | 建议：gǔ tou | 原因：教材读音冲突：头 建议 tou，教材已知 tóu；决定：gǔ tou | ID `chinese-g3down-2026:26:words:骨头`

## 轻声

### chinese-g3up-2026 第 1 课 大青树下的小学

- [x] 词 **热闹** | 建议：rè nào | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：rè nao | ID `chinese-g3up-2026:1:words:热闹`
- [x] 扩展词 **招呼** | 建议：zhāo hū | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：zhāo hu | ID `chinese-g3up-2026:1:supplementalWords:招呼`

### chinese-g3up-2026 第 6 课 秋天的雨

- [x] 词 **频频** | 建议：pín pín | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：pín pín | ID `chinese-g3up-2026:6:words:频频`

### chinese-g3up-2026 第 8 课 总也倒不了的老屋

- [x] 词 **漂亮** | 建议：piào liàng | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：piào liang | ID `chinese-g3up-2026:8:words:漂亮`

### chinese-g3up-2026 第 11 课 宝葫芦的秘密（节选）

- [x] 词 **葫芦** | 建议：hú lú | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：hú lu | ID `chinese-g3up-2026:11:words:葫芦`
- [x] 词 **指甲** | 建议：zhǐ jiǎ | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：zhǐ jia | ID `chinese-g3up-2026:11:words:指甲`
- [x] 词 **衣服** | 建议：yī fú | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：yī fu | ID `chinese-g3up-2026:11:words:衣服`
- [x] 词 **要是** | 建议：yào shì | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：yào shi | ID `chinese-g3up-2026:11:words:要是`

### chinese-g3up-2026 第 12 课 在牛肚子里旅行

- [x] 词 **答应** | 建议：dā yìng | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：dā ying | ID `chinese-g3up-2026:12:words:答应`

### chinese-g3up-2026 第 18 课 美丽的小兴安岭

- [x] 词 **起来** | 建议：qǐ lái | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：qǐ lai | ID `chinese-g3up-2026:18:words:起来`

### chinese-g3up-2026 第 22 课 读不完的大书

- [x] 词 **精神** | 建议：jīng shén | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：jīng shén | ID `chinese-g3up-2026:22:words:精神`

### chinese-g3up-2026 第 25 课 手术台就是阵地

- [x] 词 **匆匆** | 建议：cōng cōng | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：cōng cōng | ID `chinese-g3up-2026:25:words:匆匆`

### chinese-g3down-2026 第 2 课 燕子

- [x] 词 **活泼** | 建议：huó pō | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：huó po | ID `chinese-g3down-2026:2:words:活泼`

### chinese-g3down-2026 第 3 课 荷花

- [x] 词 **莲蓬** | 建议：lián péng | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：lián peng | ID `chinese-g3down-2026:3:words:莲蓬`

### chinese-g3down-2026 第 6 课 会摇尾巴的狼

- [x] 词 **认识** | 建议：rèn shí | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：rèn shi | ID `chinese-g3down-2026:6:words:认识`
- [x] 词 **收拾** | 建议：shōu shí | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：shōu shi | ID `chinese-g3down-2026:6:words:收拾`

### chinese-g3down-2026 第 7 课 鹿角和鹿腿

- [x] 词 **痛快** | 建议：tòng kuài | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：tòng kuai | ID `chinese-g3down-2026:7:words:痛快`
- [x] 词 **机灵** | 建议：jī líng | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：jī ling | ID `chinese-g3down-2026:7:words:机灵`

### chinese-g3down-2026 第 9 课 海底世界

- [x] 词 **清楚** | 建议：qīng chǔ | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：qīng chu | ID `chinese-g3down-2026:9:words:清楚`

### chinese-g3down-2026 第 10 课 石蜂

- [x] 词 **记号** | 建议：jì hào | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：jì hao | ID `chinese-g3down-2026:10:words:记号`

### chinese-g3down-2026 第 16 课 胡萝卜先生的长胡子

- [x] 词 **结实** | 建议：jiē shí | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：jiē shi | ID `chinese-g3down-2026:16:words:结实`

### chinese-g3down-2026 第 17 课 我变成了一棵树

- [x] 词 **喜欢** | 建议：xǐ huān | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：xǐ huan | ID `chinese-g3down-2026:17:words:喜欢`
- [x] 词 **容易** | 建议：róng yì | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：róng yì | ID `chinese-g3down-2026:17:words:容易`
- [x] 词 **麻烦** | 建议：má fán | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：má fan | ID `chinese-g3down-2026:17:words:麻烦`
- [x] 词 **眼睛** | 建议：yǎn jīng | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：yǎn jing | ID `chinese-g3down-2026:17:words:眼睛`

### chinese-g3down-2026 第 18 课 童年的水墨画

- [x] 词 **葫芦** | 建议：hú lú | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：hú lu | ID `chinese-g3down-2026:18:words:葫芦`

### chinese-g3down-2026 第 22 课 火烧云

- [x] 词 **偏偏** | 建议：piān piān | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：piān piān | ID `chinese-g3down-2026:22:words:偏偏`

### chinese-g3down-2026 第 23 课 暴风雨来临之前

- [x] 词 **动静** | 建议：dòng jìng | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：dòng jing | ID `chinese-g3down-2026:23:words:动静`

### chinese-g3down-2026 第 25 课 慢性子裁缝和急性子顾客

- [x] 词 **笑话** | 建议：xiào huà | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：xiào hua | ID `chinese-g3down-2026:25:words:笑话`

### chinese-g3down-2026 第 26 课 漏

- [x] 词 **厉害** | 建议：lì hài | 原因：可能轻声：常见轻声词或叠词与词典标调不一致，须按本课核对；决定：lì hai | ID `chinese-g3down-2026:26:words:厉害`

## 一不变调

含一/不的词（共 5 个）：建议统一按本调（original，yī / bù）处理。教材标调惯例待用户确认。

只需一次设置顶层 `decision.yiBuToneStyle` 为 `original` 或 `sandhi`；当前值：`"sandhi"`。每条完整拼音或 hide 仍可覆盖；其他原因未解决时继续隐藏。

同时有教材冲突或轻声疑点的词已列在前两节，本节不重复展开。

- chinese-g3up-2026 第 15 课 金色的草地：一本正经（yī běn zhèng jīng）〔覆盖：yì běn zhèng jīng〕
- chinese-g3up-2026 第 25 课 手术台就是阵地：当头一棒（dāng tóu yī bàng）〔覆盖：dāng tóu yí bàng〕
- chinese-g3down-2026 第 3 课 荷花：了不起（liǎo bù qǐ）〔覆盖：liǎo bu qǐ〕
- chinese-g3down-2026 第 14 课 赵州桥：不但（bù dàn）〔覆盖：bú dàn〕

## 多音未收词

### chinese-g3up-2026 第 1 课 大青树下的小学

- [x] 写字 **读** | 建议：dòu / dú | 原因：九册教材/规则有多个读音，本课词语无法唯一确定；决定：dú | ID `chinese-g3up-2026:1:writingCharacters:读`

### chinese-g3up-2026 第 4 课 古诗三首

- [x] 写字 **相** | 建议：xiàng / xiāng | 原因：九册教材/规则有多个读音，本课词语无法唯一确定；决定：xiāng | ID `chinese-g3up-2026:4:writingCharacters:相`
- [x] 写字 **落** | 建议：luò / là / lào | 原因：九册教材/规则有多个读音，本课词语无法唯一确定；决定：luò | ID `chinese-g3up-2026:4:writingCharacters:落`

### chinese-g3up-2026 第 11 课 宝葫芦的秘密（节选）

- [x] 词 **得到** | 建议：dé dào | 原因：未收词含常用多音字：得；决定：dé dào | ID `chinese-g3up-2026:11:words:得到`
- [x] 词 **最好** | 建议：zuì hǎo | 原因：未收词含常用多音字：好；决定：zuì hǎo | ID `chinese-g3up-2026:11:words:最好`

### chinese-g3up-2026 第 15 课 金色的草地

- [x] 词 **盛开** | 建议：shèng kāi | 原因：未收词含常用多音字：盛；决定：shèng kāi | ID `chinese-g3up-2026:15:words:盛开`
- [x] 写字 **盛** | 建议：chéng / shèng | 原因：九册教材/规则有多个读音，本课词语无法唯一确定；决定：shèng | ID `chinese-g3up-2026:15:writingCharacters:盛`
- [x] 写字 **朝** | 建议：cháo / zhāo | 原因：九册教材/规则有多个读音，本课词语无法唯一确定；决定：cháo | ID `chinese-g3up-2026:15:writingCharacters:朝`

### chinese-g3up-2026 第 17 课 海滨小城

- [x] 词 **散发** | 建议：sàn fà | 原因：词典读音存疑：发 应为 fā；决定：sàn fā | ID `chinese-g3up-2026:17:words:散发`

### chinese-g3down-2026 第 5 课 守株待兔

- [x] 写字 **待** | 建议：dài / dāi | 原因：九册教材/规则有多个读音，本课词语无法唯一确定；决定：dài | ID `chinese-g3down-2026:5:writingCharacters:待`

### chinese-g3down-2026 第 7 课 鹿角和鹿腿

- [x] 写字 **喝** | 建议：hè / hē | 原因：九册教材/规则有多个读音，本课词语无法唯一确定；决定：hē | ID `chinese-g3down-2026:7:writingCharacters:喝`

### chinese-g3down-2026 第 10 课 石蜂

- [x] 词 **减少** | 建议：jiǎn shǎo | 原因：未收词含常用多音字：少；决定：jiǎn shǎo | ID `chinese-g3down-2026:10:words:减少`

### chinese-g3down-2026 第 16 课 胡萝卜先生的长胡子

- [x] 写字 **系** | 建议：jì / xì | 原因：九册教材/规则有多个读音，本课词语无法唯一确定；决定：jì | ID `chinese-g3down-2026:16:writingCharacters:系`

