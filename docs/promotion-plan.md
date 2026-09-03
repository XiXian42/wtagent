# WTAgent 推广计划

> 更新日期：2026-08-14。目录价格、审核周期和社区规则可能变化，提交前应再次核对官网。

## 1. 推广目标

WTAgent 是一个开源 CLI Agent，将用户自己的 ChatGPT Web 会话连接到本地项目，使网页中的 GPT 能够读写本地文件、运行命令、编译代码和执行测试。

推广分为三个阶段：

1. 让目标用户在几秒内理解产品价值。
2. 让开发者完成安装并成功执行第一个本地任务。
3. 将早期用户转化为 GitHub Star、Issue、反馈、贡献者和持续用户。

当前主要入口：

- GitHub：<https://github.com/XiXian42/wtagent>
- npm：<https://www.npmjs.com/package/wtagent>
- 安装：`npm install -g wtagent`

## 2. 产品定位

### 一句话定位

英文：

> Turn your ChatGPT Web session into a local CLI agent.

中文：

> 把你自己的 ChatGPT 网页会话变成本地 CLI Agent。

### 核心价值

- 使用用户自己的 ChatGPT Web 账号、模型和额度。
- 无需 OpenAI API Key。
- 能够读写当前项目中的本地文件。
- 能够运行本地命令、构建和测试。
- 提供接近 Codex CLI 的连续对话体验。
- 开源，支持 macOS、Linux 和原生 Windows。

### 推荐表达

- `Use GPT Web as a local CLI agent.`
- `Your web model, your local tools.`
- `GPT reasons in the browser; WTAgent works on your machine.`
- `Open source. No API key required.`

### 避免使用的表达

- “无限使用 ChatGPT Pro”
- “绕过 API 费用或限制”
- “破解网页额度”
- “官方 ChatGPT/Codex 客户端”
- 无法验证的速度、能力或安全性承诺

这些说法容易造成误解，也会增加平台合规和社区反感风险。应始终强调“用户自己的会话”“本地工具桥接”和“开源 CLI”。

## 3. 推广前的基础素材

在大规模提交前，先准备以下素材：

### 必需素材

- 英文优先的极简 README。
- 一个 20～40 秒的终端录屏或 GIF。
- 一张清晰的社交分享图。
- GitHub Topics、Description 和 About 链接。
- 正式 GitHub Release 与简短 Release Notes。
- npm 页面与 GitHub README 内容一致。

### 推荐演示任务

```text
Create hello.js that writes "Hello from WTAgent" to hello.txt.
Run it with Node.js and verify the result.
```

这个任务能在很短时间内同时展示：

- Agent 创建本地代码文件。
- Agent 执行本地 Node.js 命令。
- 程序生成新的本地文件。
- Agent 读取并验证执行结果。

录屏应完整显示输入、工具调用、文件生成和最终结果，但不要展示浏览器 Cookie、个人账号信息或本地敏感路径。

### GitHub Topics 建议

`chatgpt`、`chatgpt-web`、`coding-agent`、`ai-agent`、`cli`、`developer-tools`、`terminal`、`cdp`、`browser-automation`、`nodejs`

参考：[GitHub Topics 文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics) 与 [GitHub Releases 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。

## 4. 渠道优先级

### P0：自有渠道

这些渠道完全可控，应最先完成：

- GitHub README、Topics、Release、Issues 和 Discussions。
- npm 包页面。
- X 账号：<https://x.com/xixian42>。
- 项目演示视频或 GIF。
- 后续可建立 `wtagent.dev` 极简主页，用于统一链接、SEO 和来源统计。

### P1：开发者社区

#### Hacker News / Show HN

适合标题：

```text
Show HN: WTAgent – Turn ChatGPT Web into a local CLI agent
```

重点写清楚：为什么做、如何实现、XML 协议如何连接网页模型和本地工具、目前的限制以及希望得到什么反馈。

注意：Show HN 要求产品已经可以直接使用，不能请求朋友集中点赞；HN 也明确反对 AI 生成或 AI 润色的发帖内容，因此发布前必须由作者亲自重写。[Show HN Guidelines](https://news.ycombinator.com/showhn.html) · [HN Guidelines](https://news.ycombinator.com/newsguidelines.html)

#### Product Hunt

适合用于正式 Launch，集中展示演示视频、截图、开源属性和跨平台支持。发布本身免费，新产品应先完成正常 Launch，再考虑广告。[Product Hunt Launch Guide](https://www.producthunt.com/launch)

建议素材：

- Tagline：`Turn your ChatGPT Web session into a local CLI agent.`
- 首图：浏览器 GPT 与本地终端之间的简单连接关系。
- Demo：从空目录到创建、运行并验证 `hello.js`。
- Maker Comment：产品缘起、技术实现、已知限制和未来计划。

#### Reddit

优先选择与 AI 编程、CLI、开源和 ChatGPT 开发相关的社区。不要只发链接，应写成技术经验或问题讨论，再自然地附上项目。

`r/ChatGPTCoding` 的推广内容应放到社区指定的每周推广帖；独立帖子更适合教程、技术复盘或讨论。[社区公告](https://www.reddit.com/r/ChatGPTCoding/comments/1ve6q2d/reopening_of_rchatgptcoding/)

#### V2EX

根据内容选择“分享创造”或“推广”节点，不要伪装成纯技术讨论。建议主题：

```text
[分享创造] WTAgent：把 ChatGPT Web 变成本地 CLI Agent
```

正文保持简短：痛点、30 秒示例、GitHub 链接、当前限制、希望获得的反馈。参考：[V2EX 节点说明](https://www.v2ex.com/help/node)。

#### 中文技术社区

- 掘金
- SegmentFault
- 知乎
- 少数派
- 开源中国
- 公众号和开发者微信群

内容不要完全复制。每个平台应选择不同角度：产品缘起、CDP/XML 技术实现、跨平台踩坑、从 alpha 到正式版的开发复盘。

### P2：开发者 Newsletter 和开源榜单

- [Console](https://console.dev/selection-criteria)：适合成熟、有实际开发者价值的工具，可免费投稿，也提供赞助位。
- [Node Weekly](https://cooperpress.com/)：WTAgent 是 Node.js CLI，适合提交项目或赞助内容。
- [awesome-agents](https://github.com/kyrolabs/awesome-agents)：按仓库贡献规则提交高质量 PR。
- 其他活跃的 AI Agent、CLI、ChatGPT、Developer Tools Awesome Lists。

提交 Awesome List 时必须逐个阅读贡献规范，避免一次性向大量无人维护的列表发送相同 PR。

### P3：付费曝光

产品拥有稳定激活数据后再投放：

- X Ads：适合短演示视频和开发者兴趣定向。
- Reddit Ads：适合按社区、兴趣和关键词定向。[Reddit Ads Targeting](https://www.business.reddit.com/advertise/targeting/community-and-interest)
- 开发者 Newsletter 赞助，如 Console、Node Weekly、TLDR。
- AI 工具目录的付费加速或 Featured 位置。
- 小型开发者 KOL、YouTube 和播客赞助。

不建议在尚未验证转化率时购买大额目录套餐或广泛展示广告。

## 5. AI 工具站提交清单

### 第一批：免费或低成本

| 优先级 | 平台 | 成本/条件 | 建议 |
| --- | --- | --- | --- |
| 1 | [ToolScout](https://toolscout.ai/submit) | 免费，人工审核 | 优先提交，选择 Open Source、Developer Tools、AI Agents |
| 2 | [Future Tools](https://futuretools.io/submit-a-tool) | 免费，可选择 Open Source | 适合通用 AI 工具曝光 |
| 3 | [AIToolnet](https://www.aitoolnet.com/submit) | 有免费队列，也有付费加速 | 先走免费，观察收录流量 |
| 4 | [AIxploria](https://www.aixploria.com/en/free-listings/) | 免费队列可能较长，页面信息偶有变化 | 提交前复核当前政策 |
| 5 | [There's An AI For That](https://theresanaiforthat.com/add/) | 需要登录，费用规则可能变化 | 先检查当前提交条件 |
| 6 | [ToolDirectory.AI](https://tooldirectory.ai/submit-tool) | 免费但审核严格 | 补齐演示、README 和项目数据后提交 |
| 7 | [ToolPilot](https://www.toolpilot.ai/pages/submit-your-ai-tool) | 免费方案可能要求反向链接 | 仅在愿意添加 badge/backlink 时提交 |
| 8 | [DevHunt](https://devhunt.org/) | 面向开发者工具 | 与正式 Launch 配合 |
| 9 | [AlternativeTo](https://alternativeto.net/) | 社区型产品目录 | 按“开发者工具/AI Agent”定位添加 |
| 10 | [SaaSHub](https://www.saashub.com/) | 软件发现与对比目录 | 作为长期搜索入口 |

### 第二批：付费目录

以下价格为 2026-08-13 调研结果，提交前必须重新核对：

| 平台 | 当时价格 | 当前建议 |
| --- | ---: | --- |
| [Futurepedia](https://www.futurepedia.io/submit-tool) | Basic 约 $247，Verified 约 $497 | 暂不购买，成本较高 |
| [Toolify.ai](https://www.toolify.ai/submit) | 约 $99 | 有稳定转化数据后评估 |
| [TopAI.tools](https://topai.tools/submit) | Fast 约 $47，Premium 约 $229 | 可作为低成本付费测试 |
| [Easy With AI](https://easywithai.com/submit-tool/) | 约 $125 | 暂缓 |
| [ToolPilot.tools](https://toolpilot.tools/submit) | Standard 免费，Featured 约 $299/月 | 注意它与 ToolPilot.ai 不是同一网站 |

注意辨别名称相近但并非同一平台的网站，例如 `Toolify.ai` 与 `thetoolify.dev`、`Futurepedia.io` 与其他相似域名。

### 统一提交文案

**Name**

```text
WTAgent
```

**Tagline**

```text
Turn your ChatGPT Web session into a local CLI agent.
```

**Short description**

```text
WTAgent is an open-source CLI agent that connects your own ChatGPT Web session to local files and commands. It can write code, run builds, and execute tests on macOS, Windows, and Linux.
```

**Categories**

```text
AI Agents, Coding Assistant, Developer Tools, Productivity,
CLI Tools, Automation, Open Source
```

**Pricing**

```text
Free / Open Source
```

**URL**

```text
https://github.com/XiXian42/wtagent
```

## 6. 内容策略

围绕同一产品持续生产不同深度的内容：

### 低成本短内容

- 20～40 秒终端演示视频。
- 单个功能 GIF：创建文件、运行测试、连续追问。
- 一张架构图：ChatGPT Web ↔ XML ↔ WTAgent ↔ Local Tools。
- 发布版本、修复真实问题和跨平台进展。
- 用户案例和 Issue 修复前后对比。

### 中等深度内容

- 为什么把 GPT Web 变成本地 Agent。
- XML 协议如何承载工具调用和结果。
- 为什么使用 CDP，以及浏览器状态管理有哪些坑。
- 如何处理长对话、空响应、连接中断和恢复。
- Windows、macOS、Linux 的跨平台差异。
- 一个开源 CLI 从想法到 npm 正式版的完整过程。

### 内容复用

一篇完整技术文章可以拆成：

- GitHub README 中的简短原理说明。
- X 上的 5～8 条 Thread。
- Reddit 的技术讨论。
- V2EX 的开发复盘。
- 掘金或知乎的中文长文。
- Dev.to/Hashnode 的英文长文。
- 30 秒演示视频和一张架构图。

## 7. 90 天执行计划

### 第 0 周：准备

- 完成 README、Topics、Release Notes。
- 制作一个稳定、无敏感信息的短演示。
- 准备 Logo、社交图、截图和统一提交文案。
- 建立推广追踪表和 UTM 命名规则。
- 确认首次安装和示例在 macOS、Windows、Linux 上都能完成。

### 第 1～2 周：小范围验证

- 发布 GitHub Release、npm 正式版和 X 首发。
- 提交 ToolScout、Future Tools、AIToolnet、AIxploria。
- 在 V2EX 或一个熟悉的中文开发者社区发布。
- 收集首次安装失败、登录、Chrome 和模型选择问题。
- 根据反馈优化 README、错误提示和演示任务。

### 第 3～4 周：集中 Launch

- 发布 Show HN。
- 发起 Product Hunt Launch。
- 在 Reddit 指定推广帖或技术讨论中分享。
- 同步发布英文技术文章和中文开发复盘。
- 联系 10～20 位真正关注 AI 编程、CLI 或开源工具的小型创作者。

### 第 2 个月：内容与生态

- 每周发布一个真实功能或修复案例。
- 提交 Newsletter、Awesome Lists、DevHunt、AlternativeTo、SaaSHub。
- 建立简单主页和搜索引擎入口。
- 给早期用户提供清晰的 Issue 模板和贡献指南。
- 从 Issue 中挑选适合社区贡献的任务。

### 第 3 个月：放大有效渠道

- 复盘各渠道带来的访问、安装、Star、Issue 和留存。
- 只为已经证明有转化的渠道增加预算。
- 小额测试 X Ads、Reddit Ads 或开发者 Newsletter。
- 选择最多一个付费 AI 目录做增量测试。
- 发布真实用户案例、稳定性数据和路线图。

## 8. 预算方案

### 零预算

- GitHub、npm、X。
- Show HN、V2EX、Reddit 合规发帖。
- 免费 AI 目录。
- Dev.to、Hashnode、掘金、知乎等内容平台。
- Awesome List PR。
- 与开源作者互相交流和交叉推荐。

### 小预算：$200～$500

- 制作更专业的演示视频或社交图。
- 测试一个低价目录或小型 Newsletter 分类广告。
- 给 2～3 个垂直小型创作者提供赞助或演示支持。
- 对已有自然转化的帖子做小额广告放大。

### 中等预算：$1,000～$3,000

- 赞助开发者 Newsletter。
- Reddit/X 精准定向测试。
- 赞助垂直 YouTube、播客或开源社区内容。
- 对比不同 Landing Page 和演示素材的转化率。

预算不应按“曝光量”分配，而应按“有效安装、成功首跑和持续使用”分配。

## 9. 数据与衡量

### 核心漏斗

```text
曝光 → GitHub/npm 访问 → 安装 → 成功首跑 → 再次使用 → 反馈/贡献
```

### 建议指标

- GitHub Unique Visitors、Clones、Stars、Forks。
- npm 周下载量及版本分布。
- README 到安装命令的转化。
- 首次成功运行率。
- 七日内再次运行的用户比例。
- Issue 数量、有效 Bug 比例和首次响应时间。
- PR、贡献者和用户案例数量。
- 各推广渠道的访问、安装和 Star 成本。

npm 下载量会包含 CI、缓存和自动化请求，不能直接等同于真实用户。应结合 GitHub Clones、Issue、匿名且自愿的产品指标以及社区反馈判断。

### 追踪表模板

| 日期 | 渠道 | 内容/提交页 | 免费/付费 | 成本 | 状态 | 点击 | GitHub Star | 安装/激活 | 备注 |
| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| YYYY-MM-DD | ToolScout | URL | 免费 | 0 | 已提交 |  |  |  |  |

所有外链使用统一 UTM，例如：

```text
?utm_source=producthunt&utm_medium=launch&utm_campaign=v0_1_0
```

## 10. 最重要的执行原则

1. 先让用户在 30 秒内看懂，再追求更多曝光。
2. 每次推广都展示真实终端结果，不只描述概念。
3. 优先获取高质量反馈，而不是购买大量低意图流量。
4. 每个平台使用符合其社区习惯的内容，不批量复制广告。
5. 不承诺“无限额度”，不暗示绕过平台限制。
6. 付费前至少观察一个月的自然流量和真实激活。
7. 将推广反馈持续转化为 README、安装体验和稳定性改进。

## 11. 近期执行清单

- [ ] 添加 GitHub Topics。
- [ ] 创建 GitHub `v0.1.0` Release 页面和 Release Notes。
- [ ] 制作 20～40 秒的英文终端演示。
- [ ] 制作一张适合 GitHub/X/Product Hunt 的社交图。
- [ ] 发布第一条 X 英文介绍。
- [ ] 提交 ToolScout。
- [ ] 提交 Future Tools。
- [ ] 提交 AIToolnet 免费队列。
- [ ] 提交 AIxploria 免费队列。
- [ ] 准备并亲自重写 Show HN 文案。
- [ ] 准备 Product Hunt 页面。
- [ ] 发布一篇中文技术复盘和一篇英文技术文章。
- [ ] 一个月后按渠道复盘，再决定是否付费投放。
