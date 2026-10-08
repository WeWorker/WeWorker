# OpenCLI 迁移交接总览（2026-10-08）

## 基线与口径

- 公开仓库：WeWorker/WeWorker，目标分支 develop。PR #39、#40、#41 已合并；本机 HEAD 为 202ec8ae（#41）。本次没有重新核验所有远程提交，以下覆盖以当前本地迁移工作区为准。
- 当前分支 codex/opencli-wave4；头条、什么值得买、arXiv 和本交接文档随本分支提交，等待 PR 合并。同事拉 develop 暂时拿不到这些改动；需要提前协作时获取本分支，合并后统一基于新 develop 开分支。
- 来源目录清单固定为 jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112（2026-10-08 已 fetch 核验）；携程早期迁移基线为 8271afc67e8504bda94c147f446ee29775d08274，尚不能宣称携程与后续 SHA 逐项重新对齐。
- 179 个来源目录：17 个有迁移记录、4 个已有同域 v2 包但未对齐、158 个没有对应根目录 v2 包。目录不等于独立网站，含桌面应用和同域不同能力。
- 公开 Profile 当前23包；包数包含原有邮箱、发票等，不等于 OpenCLI 迁移目录数。没有根目录v2包不表示没有旧资产、探索结果或同事未合并PR。
- 已迁入≠所有命令已实现≠真实验收通过≠已发布。自动化测试只证明其覆盖场景。

## 已有迁移记录（17个来源目录）

| 来源 | WeWorker包 | 接入范围 | 最新验收重点/缺口 | 集成状态 |
|---|---|---|---|---|
| ctrip | ctrip.com | 原来源15项，另本地destination-search；共16命令 | 多项查询、航班/旅游等有真实样例；船票有数据路径等仍待验收；来源版本较早 | 已合入 |
| 12306 | 12306.cn | 9项来源命令 | 查询及服务器会话/空订单路径有样例；有订单提取未完整验证 | 已合入 |
| 51job | 51job.com | 4项 | 登录后读取有样例，非全参数验收 | 已合入 |
| boss | zhipin.com | 16项 | 搜索及跨页/筛选通过；消息发送等写操作未真实验收 | 已合入 |
| dianping | dianping.com | 4项 | 登录后部分读取通过，非全能力验收 | 已合入 |
| douban | douban.com | 11项 | 部分读取、单张WebP落盘通过；海报分类不可据此认定通过 | 已合入 |
| douyin | douyin.com | 16项来源中14项接入 | draft/publish仍未实现；验证与写操作缺口保留 | 已合入，功能未齐 |
| youdao | note.youdao.com | 1项 | 公开笔记读取有真实样例 | 已合入 |
| zhihu | zhihu.com | 22项 | 部分读取及回答Markdown+图片导出通过；全部写入未验收 | 已合入 |
| hackernews | news.ycombinator.com | 9项 | 9项只读命令真实样例通过 | 已合入 |
| 36kr | 36kr.com | 4项 | 4项真实样例通过；榜单无已验证空态，搜索卡片缺日期 | 已合入 |
| wikipedia | wikipedia.org | 5项 | 模拟测试通过，真实调用连接失败，未取得成功业务数据 | 已合入，真实待验收 |
| github-trending | github.com | repos 1项 | 模拟测试通过，真实调用传输失败；不含github登录/身份目录能力 | 已合入，真实待验收 |
| xiaohongshu | xiaohongshu.com | 25项来源+7项兼容/本地命令 | 8项真实数据样例及草稿空列表通过；creator-notes、notifications仍失败；下载等多项与写操作未验收 | 已合入，2.0.1 |
| toutiao | toutiao.com | hot/recommend/articles/login/whoami，5项 | 公开两项及服务器身份通过；articles第1页明确空态通过；有作品、多页、login未验收 | 本分支待合并，0.1.1 |
| smzdm | smzdm.com | search 1项 | 两条好价卡片样例通过；没有已验证无结果空态，不自动翻页 | 本分支待合并，0.1.0 |
| arxiv | arxiv.org | search/paper/author/recent，4项 | 四项公开读取样例通过；paper为元数据/摘要，不下载PDF全文 | 本分支待合并，0.1.0 |

## 已有包但未对齐（4个来源目录）

| 来源 | 包 | 接手说明 |
|---|---|---|
| bilibili | bilibili.com | 原有能力不能算OpenCLI对齐；逐命令比较搜索、视频、评论、字幕、动态、关注、创作者统计等 |
| jd | jd.com | 已有京东流程；逐项对比来源搜索/商品/评论/购物车/登录，避免覆盖已用能力而不说明兼容性 |
| juejin | juejin.cn | 优先补齐来源hot/recommend；适合独立小批次 |
| github | github.com | 来源目录为登录/身份注册；与已迁github-trending区分，改同包需协调 |

## 建议分工（建议，尚未分配给具体同事）

| 工作包 | 建议范围 | 交付重点 |
|---|---|---|
| A：既有包补齐 | 掘金，再选B站或京东 | 先列差异，明确旧命令兼容性和确认策略 |
| B：社区新站 | V2EX、微博 | 公开读取先验收；账号读与签到/发布/删除分开记录 |
| C：学术新站 | PubMed、OpenAlex、Semantic Scholar等 | 先检查来源实现和网络可达性，定义限流、分页、错误与空态 |
| D：现有迁移收尾 | 小红书两项失败、Wikipedia/GitHub真实验证、抖音缺失两项 | 以既有失败trace和文档为起点，不能把源码存在当完成 |

这些是候选范围，不代表已审计C组等全部源码。不要并发修改同一包。

### 正在进行的其他PR（本次已查询）

- #29 codex/tieba-extension-adapter：贴吧已有开放PR；不要直接从“无包”清单重复开发。
- #27 codex/zhihu-extension-adapter：知乎已有开放PR，和已合入的OpenCLI知乎包可能重叠，先与作者协调范围；未审查该PR具体兼容性。
- #31 codex/fix-webcli-generation-harness-tests：生成测试相关开放PR，涉及该区域前先核对。

## 开发与验收约定

1. 每人独立分支/工作区，一批围绕少量站点；基于已同步的develop。没有安排自动委派或向同事发送消息。
2. 接手先读AGENTS.md、ROADMAP.md、站点manifest/guidance和迁移记录；每批再次核验上游SHA，并固定来源、许可证和命令清单。
3. 站点代码使用根目录adapters/<域名>/v2包和现有Extension Runner；不引入旁路OpenCLI进程、不修改通用协议来迁就单站。普通参数用--key=value。
4. 新写能力保留确认边界，写导航不自动重放；已存在的确认策略不要无依据改变。真实发布/删除等另获明确授权，不因迁移就执行。
5. 通用框架变化按现有约定同步内外仓；公开站点代码/Profile/站点测试仅放公开仓。保留无关文章与原有内部lockfile改动。
6. fixtures只用虚构数据；真实账号/Cookie/响应/带签名链接/开发者路径不得提交。真实日志放仓库外，文档只记脱敏范围、结果和trace。
7. 每批交付manifest、guidance、来源清单/许可证、聚焦测试、Profile注册、.adapt校验和真实样例；显式区分失败、未执行、验证过的空态、有数据路径。缺字段不能默认为空或0。
8. Profile、目录映射、ROADMAP和汇总文档由批次负责人统一集成，避免多人同时改全局JSON。真实浏览器使用共享会话时排队验收，避免导航互相干扰。
9. 不删除WeWorker-Archive，不清理或回滚他人的工作。CI/发布等遵守AGENTS.md的单独授权规则。

## 证据入口

- docs/opencli_clis_alignment_map.json：179目录互斥分类，当前17+4+158。
- docs/opencli_ctrip_migration.md：携程阶段与验收。
- docs/opencli_batch_migration.md + opencli_batch_inventory.json：八站83项来源，81已接入、2待实现。
- docs/opencli_news_wave2_migration.md + inventory：HN/36氪13项。
- docs/opencli_reference_wave3_migration.md + inventory：Wikipedia/GitHub Trending6项。
- docs/opencli_xiaohongshu_migration.md + inventory：25来源+7兼容/本地，真实样例级状态。
- docs/opencli_wave4_migration.md + inventory：当前3站10项。专项130项、相关回归148项通过；23包prepare、WebCLI构建和头条0.1.1独立包校验通过。
- docs/opencli_remaining_sites_20261008.md：迁移前161项历史快照，不作为最新剩余名单。

## 尚无对应根目录v2包（158个来源目录）

下列直接从当前分类JSON生成，按目录名排序；不是“158个纯网站”，也不表示没有同事在做。
1. `1688`
2. `1point3acres`
3. `aibase`
4. `amazon`
5. `antigravity`
6. `apple-podcasts`
7. `archive`
8. `autohome`
9. `baidu-scholar`
10. `band`
11. `barchart`
12. `bbc`
13. `binance`
14. `bloomberg`
15. `bluesky`
16. `booking`
17. `brave`
18. `chaoxing`
19. `chatgpt`
20. `chatgpt-app`
21. `chatwise`
22. `chess`
23. `claude`
24. `cnki`
25. `codex`
26. `coingecko`
27. `confluence`
28. `coupang`
29. `crates`
30. `cursor`
31. `dblp`
32. `deepseek`
33. `defillama`
34. `devto`
35. `dictionary`
36. `discord-app`
37. `dockerhub`
38. `dongchedi`
39. `doubao`
40. `doubao-app`
41. `dribbble`
42. `duckduckgo`
43. `eastmoney`
44. `endoflife`
45. `facebook`
46. `flathub`
47. `flomo`
48. `gemini`
49. `geogebra`
50. `gitee`
51. `gmail`
52. `google`
53. `google-scholar`
54. `goproxy`
55. `gov-law`
56. `gov-policy`
57. `grok`
58. `guazi`
59. `hf`
60. `hltv`
61. `homebrew`
62. `huodongxing`
63. `hupu`
64. `imdb`
65. `indeed`
66. `instagram`
67. `jianyu`
68. `jike`
69. `jimeng`
70. `jira`
71. `ke`
72. `kimi`
73. `lesswrong`
74. `lichess`
75. `linkedin`
76. `linkedin-learning`
77. `linux-do`
78. `lobsters`
79. `maimai`
80. `manus`
81. `maven`
82. `mdn`
83. `medium`
84. `mercury`
85. `midjourney`
86. `minimax`
87. `mubu`
88. `notebooklm`
89. `nowcoder`
90. `npm`
91. `nuget`
92. `nvd`
93. `oeis`
94. `ones`
95. `openalex`
96. `openfda`
97. `openreview`
98. `osv`
99. `packagist`
100. `paperreview`
101. `pinterest`
102. `pixiv`
103. `powerchina`
104. `producthunt`
105. `pubmed`
106. `pypi`
107. `qoder`
108. `quark`
109. `qwen`
110. `reddit`
111. `rednote`
112. `rest-countries`
113. `reuters`
114. `rfc`
115. `rubygems`
116. `semanticscholar`
117. `sinablog`
118. `sinafinance`
119. `slock`
120. `spotify`
121. `stackoverflow`
122. `steam`
123. `substack`
124. `suno`
125. `taobao`
126. `tdx`
127. `ths`
128. `tieba`
129. `tiktok`
130. `trae-cn`
131. `trae-solo`
132. `trip`
133. `tvmaze`
134. `twitter`
135. `uisdc`
136. `uiverse`
137. `upwork`
138. `v2ex`
139. `wanfang`
140. `web`
141. `wechat-channels`
142. `weibo`
143. `weixin`
144. `weread`
145. `weread-official`
146. `wikidata`
147. `wttr`
148. `xianyu`
149. `xiaoe`
150. `xiaoyuzhou`
151. `xueqiu`
152. `yahoo`
153. `yahoo-finance`
154. `yollomi`
155. `youtube`
156. `yuanbao`
157. `zlibrary`
158. `zsxq`
