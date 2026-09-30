# GitHub Trending 使用指导

本包当前仅实现OpenCLI github-trending/repos，不代表github站点的仓库管理命令已对齐。
- 后台只读读取官方Trending页面，仍需已连接的扩展和Bridge；无需登录或业务标签页。
- 使用 repos --since=weekly --language=rust --limit=5。since支持daily/weekly/monthly，language使用页面slug（例如python、c++），limit为1..25。
- stars/forks是页面展示的累计值；starsSince是请求周期新增星数。只提供请求时榜单快照，不解释为精确历史统计或全站排名。
- 只解析主区域内仓库卡片并核对周期文案；字段缺失或结构变化报错，不把推荐链接或未知数字填0。description可能为空，language可能为null。
- EMPTY_RESULT仅来自官方明确空提示；网络、HTTP、重定向、解析失败不算空榜，不自动换周期或语言。
- 本轮证据优先于历史记忆；实际验收状态见迁移记录。不执行Star、Fork、关注或仓库写操作。
