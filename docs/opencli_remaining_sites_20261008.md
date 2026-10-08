# OpenCLI 后续迁移盘点（2026-10-08）

本文件为本批迁移开始前的盘点快照。随后 PR #41 已合并，今日头条、什么值得买、arXiv 三站已接入，最新状态为 17 个已有迁移记录、4 个有包未对齐、158 个无包；参见 opencli_wave4_migration.md 和 opencli_clis_alignment_map.json。下文 161 项保留为迁移前基线。

## 核验口径

本次 fetch 后 OpenCLI origin/main 仍为 `24136945847afbfad266c6c46a8cd335377f9112`。与当前公开迁移分支的根目录 v2 Adapter 包及迁移记录交叉核对，179 个来源目录的分类未变化：14 个已有迁移记录、4 个有包未对齐、161 个无对应包。排除 `_shared`、`_atlassian` 等辅助目录。目录数不等于独立网站数，也不等于真实验收完成数。

PR #41 仍 OPEN，目标 develop；本清单包含其尚未合并的新闻、百科、趋势及小红书成果。不能将本分支覆盖率视为已发布或主线覆盖率。

## 有包但尚未对齐（4）

| 来源目录 | 当前包 | 后续重点 |
|---|---|---|
| bilibili | bilibili.com | 对照搜索、视频、评论、字幕、动态、收藏、关注及创作者统计等逐命令梳理 |
| jd | jd.com | 对照搜索、商品、评论、购物车及登录能力 |
| juejin | juejin.cn | 来源 hot/recommend 两项，可作为补齐现有包的短批次 |
| github | github.com | 当前迁移的是 github-trending；github 目录实际为共享注册器生成的登录/身份能力，不能算 Trending 已覆盖 |

## 已有迁移记录（14）

12306、36kr、51job、boss、ctrip、dianping、douban、douyin、github-trending、hackernews、wikipedia、xiaohongshu、youdao、zhihu。

仍需独立跟踪验收缺口：抖音 draft/publish 未实现；小红书 creator-notes/notifications 未通过，其余未覆盖范围见专项文档；Wikipedia/GitHub Trending 未取得成功真实业务数据。已有迁移记录不意味着所有功能完成。

## 建议顺序

1. 新站优先：今日头条（hot/recommend 公开读取先行，articles 和登录另列）、什么值得买（search）、arXiv（search/paper/author/recent）。已经读取来源命令声明；登录依赖较少、读取边界清晰，但实际网络可达性和反爬情况仍需验证。
2. 补齐已有包：掘金 hot/recommend，再逐命令评估 B 站和京东。不要因已有同域包直接计为已迁移。
3. 社区扩展：V2EX、微博。V2EX 有公开读取、登录读取及签到写入；微博包括发布/删除等能力，按读写分别验收。
4. 更后批次：电商、金融、学术及国际社区按实际需求分组；桌面应用单列，不直接套网站 Extension Adapter。

`rednote` 指向 rednote.com，独立于 xiaohongshu.com，当前仍无包。名称包含 app 或看似桌面工具的目录仅能作为候选分类，未逐个审计其实现，本次不提供虚假的“纯网站总数”。

## 无对应包的完整来源目录（161）

以下按目录名排序，是可复核的缺口清单；未做逐项命令级审计。
1. `1688`
2. `1point3acres`
3. `aibase`
4. `amazon`
5. `antigravity`
6. `apple-podcasts`
7. `archive`
8. `arxiv`
9. `autohome`
10. `baidu-scholar`
11. `band`
12. `barchart`
13. `bbc`
14. `binance`
15. `bloomberg`
16. `bluesky`
17. `booking`
18. `brave`
19. `chaoxing`
20. `chatgpt`
21. `chatgpt-app`
22. `chatwise`
23. `chess`
24. `claude`
25. `cnki`
26. `codex`
27. `coingecko`
28. `confluence`
29. `coupang`
30. `crates`
31. `cursor`
32. `dblp`
33. `deepseek`
34. `defillama`
35. `devto`
36. `dictionary`
37. `discord-app`
38. `dockerhub`
39. `dongchedi`
40. `doubao`
41. `doubao-app`
42. `dribbble`
43. `duckduckgo`
44. `eastmoney`
45. `endoflife`
46. `facebook`
47. `flathub`
48. `flomo`
49. `gemini`
50. `geogebra`
51. `gitee`
52. `gmail`
53. `google`
54. `google-scholar`
55. `goproxy`
56. `gov-law`
57. `gov-policy`
58. `grok`
59. `guazi`
60. `hf`
61. `hltv`
62. `homebrew`
63. `huodongxing`
64. `hupu`
65. `imdb`
66. `indeed`
67. `instagram`
68. `jianyu`
69. `jike`
70. `jimeng`
71. `jira`
72. `ke`
73. `kimi`
74. `lesswrong`
75. `lichess`
76. `linkedin`
77. `linkedin-learning`
78. `linux-do`
79. `lobsters`
80. `maimai`
81. `manus`
82. `maven`
83. `mdn`
84. `medium`
85. `mercury`
86. `midjourney`
87. `minimax`
88. `mubu`
89. `notebooklm`
90. `nowcoder`
91. `npm`
92. `nuget`
93. `nvd`
94. `oeis`
95. `ones`
96. `openalex`
97. `openfda`
98. `openreview`
99. `osv`
100. `packagist`
101. `paperreview`
102. `pinterest`
103. `pixiv`
104. `powerchina`
105. `producthunt`
106. `pubmed`
107. `pypi`
108. `qoder`
109. `quark`
110. `qwen`
111. `reddit`
112. `rednote`
113. `rest-countries`
114. `reuters`
115. `rfc`
116. `rubygems`
117. `semanticscholar`
118. `sinablog`
119. `sinafinance`
120. `slock`
121. `smzdm`
122. `spotify`
123. `stackoverflow`
124. `steam`
125. `substack`
126. `suno`
127. `taobao`
128. `tdx`
129. `ths`
130. `tieba`
131. `tiktok`
132. `toutiao`
133. `trae-cn`
134. `trae-solo`
135. `trip`
136. `tvmaze`
137. `twitter`
138. `uisdc`
139. `uiverse`
140. `upwork`
141. `v2ex`
142. `wanfang`
143. `web`
144. `wechat-channels`
145. `weibo`
146. `weixin`
147. `weread`
148. `weread-official`
149. `wikidata`
150. `wttr`
151. `xianyu`
152. `xiaoe`
153. `xiaoyuzhou`
154. `xueqiu`
155. `yahoo`
156. `yahoo-finance`
157. `yollomi`
158. `youtube`
159. `yuanbao`
160. `zlibrary`
161. `zsxq`
