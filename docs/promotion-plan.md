# WTAgent 网站评审与推广执行计划

更新：2026-09-06。本文替代旧版仅面向 ChatGPT、独立域名与 v0.1.0 的计划。
状态：本地网站与演示素材已修改；本轮未提交、推送、部署、发布或对外发帖。
公开资料仅用于比较产品表达与工作方式，不代表已实测竞品，也不代表获得服务商许可。

## 核心决定

主张：把 ChatGPT Web 变成 Codex 式编程助手，把 Claude Web 变成 Claude Code 式编程助手。同时支持 DeepSeek、Gemini、Grok、Kimi、GLM。
首屏要求：两句用途对照与另外五家的完整名称连续显示，放在介绍正文和操作按钮之前；桌面及手机无需下滑即可看见支持范围。
解释：WTAgent 是独立 CLI，使用你的网页账号，让模型读取项目、修改文件、运行命令并验证结果。
边界：不是官方客户端，不承诺功能等同、无限额度、绝对安全或代码完全不出本机。
推广顺序：先验证陌生用户能理解并成功首跑，再扩大社区曝光；暂不购买目录收录或广告。
网站沿用 GitHub Pages，不申请独立域名。计划地址是 https://xixian42.github.io/wtagent/ ，本轮未确认线上已启用。

## 1. 当前网站：只讲是什么、怎么用

本节取代前两版的长页设计；不要再按旧截图恢复已删除区块。

首屏左侧保留两句转换广告语，紧接“同时支持 DeepSeek、Gemini、Grok、Kimi、GLM”。
首屏右侧直接放现有任务 GIF，不再使用浏览器卡片、桥接箭头和本地工具流程图。
GIF 进入可见区域后自动播放一次启动，可手动停止；滚出视口停止，不反复自动重启。
开启减少动态效果或禁用 JavaScript 时保留静态封面，提供查看完整 GIF 的链接。
演示说明保持一句：这是一次真实 ChatGPT 会话与真实本地工具执行；GIF 仅压缩等待时间，实际任务耗时 99.9 秒。

首屏后直接进入“怎么用”：安装 → 在测试项目启动并登录 → 输入任务。
提供一个选择 provider 的命令，并列出其余可替换值；不重复七套安装说明。
最后只保留三条使用提醒：账号与服务商条款、代码与输出的数据去向、本地执行的权限边界。
独立软件、非官方客户端和无服务商背书的说明保留在首屏与页脚。

已删除：重复服务商栏、See the difference、Not a snippet to copy、What changes、
Same web account、手动流程对照、能力卡片、长 FAQ、末尾重复行动号召。
保留的卖点只有：使用已有网页账号、无需模型 API Key、七家支持、开源免费。

精简版验证：中英文各 8 种视口，共 16 种；七家名称均在首屏内，桌面 GIF 位于右侧。
复制、语言记忆、自动播放和停止、减少动态效果、无脚本降级及 file:// 预览均通过。
语法检查 91 个文件通过；全量测试 469 通过、4 跳过、0 失败。
证据：review/site-2026-09-06/compact-browser-check.json。
截图：同目录 compact-en-390x664.png、compact-en-1440x900.png、
compact-zh-390x664.png、compact-zh-1440x900.png。
这是浏览器自动化与文件验证，不是人工逐图审美验收或全部 provider 在线实测。

## 2. 两个竞品：借鉴表达，准确区分产品

### 精简版补充：免责声明与卖点取舍

本次重新核对公开 README 和安全说明，以下是当前文档内容，不作法律结论。
codex-chatgpt-web 的 Disclaimer 强调独立软件、无 OpenAI 背书、使用本人账号并遵守条款；
其限制说明也提醒网页自动化可能受页面变化影响，登录资料需要保密。[S1]
DevSpace 的安全文档将其定位为对开发机器的远程访问，说明文件工具的路径限制
并不把 shell 命令变成系统沙箱；命令仍拥有本地用户的权限。[S8]
DevSpace README 对 MCP 接入的政策说明属于该项目的表述，不能据此保证
WTAgent 的浏览器自动化获得服务商许可或没有账号风险。[S2]

采纳：熟悉的 Codex 类比、直接安装入口、短小且具体的账号和执行风险提醒。
不采纳：无限额度、零账号风险、代码完全不出本机、笼统的合规保证或未经验证的性能优势。
本次没有从竞品照搬能力，也不增加新的功能卡片；所有保留卖点都围绕现有 WTAgent。

### 产品路线对照

以下是 2026-09-06 阅读各自公开 README 的结果，不是安装评测或性能排名。[S1][S2]

| 产品 | 对方的直接表达 | 工作方式 | WTAgent 应如何回应 |
| --- | --- | --- | --- |
| codex-chatgpt-web | 将 ChatGPT Web 作为原生 Codex 模型使用 | README 描述保留 Codex 的任务界面与工具体系，通过本地桥接与网页模型交互 | 用户坚持使用原生 Codex 时，不暗示 WTAgent 提供同一接入方式 |
| DevSpace | 把 ChatGPT 带入 Codex 式编程工作流 | 自托管 MCP server；其 ChatGPT 设置说明包含 HTTPS 隧道与连接批准 | 用户偏好在 MCP 客户端里工作时应明确区别；WTAgent 的入口是独立终端 |
| WTAgent | 网页 AI 账号 → 本地编程助手 | 独立 CLI、浏览器适配器、XML 请求、本地 Runtime 与策略检查 | 聚焦同一终端内选用多家网页 AI、操作本地项目，不宣称兼容官方客户端 |

最值得借鉴的是顺序：熟悉的产品类别 → 能完成的具体任务 → 安装，而不是先讲桥接架构。
WTAgent 的传播切口应是“少做复制粘贴，让已有网页 AI 实际修改本地代码”，多 provider 是第二层理由。
不要将“多 provider”说成独家优势，也不要把 DevSpace 简化为只支持 ChatGPT。
无论其它项目如何宣传，WTAgent 都不采用无限额度、零风险或数据不出本机等容易误解的口径；本项目独立说明实际边界。
暂不将三方大对比表放在首页：主页负责让用户认识 WTAgent，完整比较放在技术文章或文档。

## 3. 定位、受众与统一文案

优先受众：已经使用 ChatGPT / Claude 网页、愿意使用终端、经常手工复制代码与报错的个人开发者。
第二受众：需要在同一 CLI 下尝试 DeepSeek、Gemini、Grok、Kimi、GLM 网页账号的开发者。
暂不主攻：要求企业级合规保证、无人值守生产执行、严格沙箱或官方客户端完整兼容的团队。

中文主标题：把网页聊天变成本地编程助手。
英文主标题：Turn web chats into coding agents.
固定广告语：
把 ChatGPT Web 变成 Codex 式编程助手。
把 Claude Web 变成 Claude Code 式编程助手。
同时支持 DeepSeek、Gemini、Grok、Kimi、GLM。
英文采用相同顺序：Turn ChatGPT Web into a Codex-style coding agent. Turn Claude Web into a Claude Code-style coding agent. Also supports DeepSeek, Gemini, Grok, Kimi and GLM.
能力句：读取项目、修改文件、运行命令、验证结果。
费用句：WTAgent 本身开源免费，无需模型 API Key；账号付费功能和额度仍由服务商决定。
边界句：独立 CLI，并非 Codex、Claude Code 或二者的官方接入。

避免：“免费获得 Claude Code”“绕过限制”“无限调用”“比所有 coding agent 更强”“文件永不离开电脑”。
七家适配器已经在 `src/browser/provider-registry.js` 注册，但“已实现适配器”和“某账号/模型在线实测通过”必须分开。
首页用 ChatGPT 和 Claude 的两句类比建立认知，紧接醒目的“同时支持”区，列出 DeepSeek、Gemini、Grok、Kimi、GLM。不能只在下方服务商栏列出，也不能用“更多”替代完整名称。七家都在首屏明确出现，但无需展示七套安装说明。
中英文入口已经可用；`?lang=zh` 用于分享中文展示，但它不是独立服务端中文页面，不能宣称完成双语 SEO。

## 4. 素材包与在线录屏补齐方案

| 素材 | 当前文件/状态 | 用途与注意事项 |
| --- | --- | --- |
| 落地页 | `docs/index.html`、`site.css`、`site.js` | 无新增前端框架；主 CTA 是本地试用 |
| 首屏演示 | `docs/assets/chatgpt-live.gif` | 真实 ChatGPT + WTAgent 终端录屏；展示读取源码、复现失败、修改文件、重新测试 |
| GIF | `docs/assets/chatgpt-live.gif` | 800×553，72 个真实录制帧，约 21.81 秒；仅压缩等待时间，画面中的终端内容未重绘 |
| 静态关键帧 | `docs/assets/chatgpt-live-poster.png` | 减少动态效果、未播放、停止或无脚本时使用；提供 GIF 大图链接 |
| 真实运行证据 | `review/live-chatgpt-retry-2026-09-07-Fq1D5B/` | 实际任务约 99.9 秒；修复前 2 通过/1 失败，修复后 3 通过/0 失败；测试文件保持不变 |
| 分享图 | `docs/assets/social-card.png` 与 `.svg` | 1200×630；两句用途对照后突出显示另外五家完整名称，图片单独转发也能说明支持范围 |
| 页面截图 | `review/site-2026-09-06/` | 评审用，不直接当在线模型执行证据 |

旧的 `scripts/demo-session.js` / `scripts/render-demo-gif.js` 仍可作为离线回归与素材测试工具，但不再作为首页真实性证据。
当前首页 ChatGPT 演示来自一次已登录网页账号的真实 WTAgent 运行，原始终端帧、CLI 日志、测试结果和录屏时间线都保存在 `review/live-chatgpt-retry-2026-09-07-Fq1D5B/`。

正式发布前仍建议补一条 Claude 的真实在线案例；其它 provider 没有在线录屏证据时只宣传“已实现适配器”，不承诺成功率。
录屏顺序：显示任务与所选 provider → 展示本地源码 → 执行测试复现失败 → 让 Agent 修改 → 同一测试通过 → 展示 diff。
保留完整原始录屏；社交短片可以剪辑，但必须标“剪辑/加速”，不能暗示整项任务只花了片长时间。
不要展示登录凭证、Cookie、付款信息、私人目录、系统通知；不要在隐藏脚本里提前改好文件。
记录日期、系统、WTAgent 版本、网页模型、任务、测试命令、结果；失败案例同样保留。
目前已有一条可追溯的 ChatGPT 真实在线成功案例；Claude 及其它 provider 尚未因本次录屏而获得同等在线实测证明。

## 5. 发布门槛：通过后再开始对外推广

这些是建议验收标准，不是已有成绩或行业基准。

1. 理解门槛：邀请 10 位未参与项目的开发者看首屏 5 秒，至少 8 位能解释“网页账号驱动本地代码工作”，并知道不是官方客户端。
2. 激活门槛：10 位真实试用者至少 7 位依据文档完成“安装 → 登录 → 修改测试项目 → 验证”；记录失败发生在哪一步。
3. 证据门槛：ChatGPT、Claude 各有一条可追溯在线成功案例；没有在线证据的 provider 只标适配器可用，不作成功率承诺。
4. 发布门槛：静态资源、npm 安装、Pages 子路径、公开链接、版本说明与隐私提醒一致；未确认能访问的链接不作为首发入口。

通过后才由维护者启用 GitHub Pages，发布源采用 `main / docs`，保留 `.nojekyll`；这是计划步骤，本轮没有执行。[S3]
发布前审核整个 `docs/`，因为所选发布目录的其它文件也可能被公开，不能把内部文档、敏感资料混在其中。
上线后验证首页、CSS/JS、GIF、分享图、锚点、中文切换，以及外部平台是否能抓取正确 OG 图。
README 需同步首屏定位、Grok 命令列表与启动说明，并在 Pages 确认可访问后添加网站链接；本轮未改 README。
当前本地 `package.json` 是 0.3.0，但不能据此推断 npm 最新包或线上仓库与此工作区一致。
不得为更新宣传页而自动 bump 版本、执行 `npm publish`、修改账号设置或提交全部工作区。
当前 `src/`、`test/`、`.claude/` 的既有修改要与网站改动隔离审阅，不使用 `git add .`。

## 6. 渠道优先级：先找到会实际试用的人

以下优先级是本项目的执行建议，不是渠道转化率排名。

| 顺序 | 渠道 | 具体内容与动作 | 进入条件 |
| --- | --- | --- | --- |
| P0 | GitHub、npm、Pages | 保持一句话定位一致；安装入口、演示、限制、Issue 模板互相连接 | 公开包与仓库版本确实可用 |
| P1 | 熟悉的开发者群、小范围邀请 | 邀请 10 位真实开发者完成测试项目，不要求点赞或好评 | 能提供安装支持并记录失败 |
| P1 | V2EX 或一个中文技术社区 | 作者公开身份，讲复制粘贴痛点、一个修复案例和已知限制 | 阅读当日节点规则；有在线案例 |
| P1 | 维护者可正常使用的 X 账号 | 一条主张 + 一个演示 + 一个安装入口；随后发布具体修复过程 | 不批量回复、不群发、不规避账号限制 |
| P2 | Hacker News / Show HN | 面向可下载试用的项目本身，不把本次网站改版当作产品发布 | 产品可试用，作者能亲自参与讨论 |
| P2 | Reddit | 选择允许自荐的位置；用技术案例而不是伪装用户推荐 | 发帖当日检查该社区规则与置顶帖 |
| P3 | Product Hunt | 整理图库、演示和产品说明后再集中发布 | 激活门槛通过且有人负责答疑 |
| P3 | Newsletter、Awesome List | 按各自收录标准联系，展示一个实际开发用途 | 已有外部用户案例；不购买批量收录 |

HN 要求可试用的作品，不接受仅落地页式的 Show HN；禁止拉票，其社区指南也禁止生成或 AI 润色的发帖文本。[S4][S5]
因此本文不给可复制发布的 HN 帖子；由作者依据真实经历独立撰写，不能把下节草稿拿去稍作润色后发布。
Product Hunt 官方指南说明可自行提交、不必寻找第三方 hunter，也不应直接索要点赞；无需为“包上榜”付费。[S6]
Reddit/V2EX 的具体允许位置在发布当日核实，本文不延用旧计划中未经本轮确认的周推广帖规则。
首轮不铺几十个 AI 目录，不投放广告，不制造假评论、假使用案例或“路人发现”的帖子。

## 7. 14 天执行安排

D0 指维护者完成视觉确认、决定进入发布准备的当天，不是已发生的发布日期。
未达到发布门槛就延后外部发布；不为了凑日期带着安装阻断问题推广。

| 时间 | 维护者要做的事 | 交付物与检查点 |
| --- | --- | --- |
| D0–D1 | 看桌面/手机截图，完成 10 人首屏理解测试；修正文案 | 记录每人对“它是什么”的原话，区分官方客户端误认 |
| D2–D3 | ChatGPT、Claude 各录一次真实在线小项目修复 | 完整原片、可公开短片、版本与测试结果；失败也记录 |
| D4–D5 | 邀请 10 人照文档安装，不在旁边替他们操作 | 安装/登录/首任务/验证阶段数据，至少 7 人成功后继续 |
| D6 | 修复最常见的首跑问题；核对 README 与 npm 包 | 安装说明、已知限制、可复现 Issue；不夹带无关源码改动 |
| D7 | 审核提交范围，由维护者发布 Pages 与必要的项目更新 | 线上资源与 OG 图可访问；没有代码版本变化就不硬发新版本 |
| D8 | 发一个中文社区案例与维护者自有渠道介绍 | 一个主链接、一个可复现任务，明确作者身份与演示类型 |
| D9–D10 | 集中处理真实问题，更新快速开始；作者独立准备 HN 内容 | 常见失败原因及修复；发布前重读规则 |
| D11–D12 | 条件成熟再做 Show HN 或一个允许自荐的英文社区 | 两者不必同日；维护者能参与讨论，不拉票 |
| D13–D14 | 复盘；选一个值得继续投入的渠道 | 首跑成功人数、回访样本、阻断问题；决定是否筹备 Product Hunt |

每次只变一个主要因素，例如首屏标题或演示形式，不同时更换标题、渠道、用户群和安装步骤。
讨论多但试用少时检查 CTA 与安装阻力；安装多但验证少时修首跑；首跑成功但不回来时访谈实际用途。
这些是排查假设，不能只凭一次帖子的点击数下因果结论。

## 8. 宣传文案草稿（不用于 HN）

以下用于维护者审核后的自有渠道或允许此类内容的平台。发布前替换实际可访问链接，核对平台规则。

### 中文社区版本
标题：把 ChatGPT、Claude 网页变成本地编程助手，同时支持 DeepSeek、Gemini、Grok、Kimi、GLM
正文：用网页 AI 写代码时，我经常在聊天、编辑器和终端之间复制代码与报错，所以做了 WTAgent。
它用你自己的网页账号，在独立终端里执行“读项目 → 改文件 → 跑测试”的循环，无需模型 API Key。
把 ChatGPT Web 变成 Codex 式编程助手。
把 Claude Web 变成 Claude Code 式编程助手。
同时支持 DeepSeek、Gemini、Grok、Kimi、GLM。
这是独立 CLI，提供类似的本地编程工作流，并非官方 Codex 或 Claude Code 客户端。
这段 GIF 来自真实 ChatGPT 会话和真实 WTAgent 终端执行；为了阅读体验压缩了等待时间，实际任务耗时约 99.9 秒。
希望了解的是：照安装说明能否完成第一个任务，哪个步骤卡住，以及你会拿它处理什么小任务。
工具在本地执行，但返回对话的代码和输出会发送给所选网页 AI 服务商，仍受账号额度和使用条款约束。
项目：[填写已验证 GitHub 链接]；网站：[填写已验证 Pages 链接]。

### English short post
Turn ChatGPT Web into a Codex-style coding agent.
Turn Claude Web into a Claude Code-style coding agent.
Also supports DeepSeek, Gemini, Grok, Kimi and GLM.
WTAgent reads your project, edits files and runs tests using your own web AI account—no model API key.
Independent CLI, not the official Codex or Claude Code client. Account limits still apply.
Demo: real ChatGPT session and real local tool execution. Waiting time is shortened in the GIF; the recorded task took 99.9 seconds. Start with a disposable project: [verified link].

### 目录 / Product Hunt 素材
Tagline: Turn ChatGPT, Claude & more web AIs into coding agents.
Description: Turn ChatGPT Web into a Codex-style coding agent. Turn Claude Web into a Claude Code-style coding agent. Also supports DeepSeek, Gemini, Grok, Kimi and GLM. WTAgent is an independent open-source CLI that reads local files, edits code and runs tests using your own web account. No model API key is required. Provider terms and account limits still apply.
图库顺序：首图同时展示两句 ChatGPT/Claude 转换广告语和 DeepSeek、Gemini、Grok、Kimi、GLM → 本地修复过程 → 三步安装 → 非官方、数据去向与使用限制。支持范围不能只出现在第二张图或展开后的正文。
Maker 介绍由作者补充真实开发经历和已知问题，不编造“数千用户”“节省百分之多少”等数据。

### HN 仅提供作者自写提纲
解释你为什么亲自做它、与原生 Codex 桥接/MCP 服务的差别、实现中最难的一点、可试用入口和真实限制。
不提供可粘贴标题或正文，不以本文草稿替代作者自己的表达。[S4][S5]

## 9. 数据与复盘：首跑成功比 Star 更接近目标

本轮网站没有接入分析服务、埋点后端或 CLI 遥测。不能报告网站到安装的转化率，也不能通过按钮点击判断安装成功。
URL 上添加 UTM 只是标记来源，不会自动产生统计；浏览器 localStorage 目前只保存语言偏好，不保存用户身份。
GitHub Traffic 可查看近 14 天访客、完整克隆及来源等数据，但这是仓库流量，不是 Pages 访问或 CLI 活跃人数。[S7]

首轮采用自愿试用反馈，不采集 Cookie、账号标识、提示词、源码或完整终端日志。
建议记录：匿名试用编号、来源、系统、WTAgent 版本、provider、是否装好、是否登录、首任务是否验证、失败阶段、七日回访。
只有试用者明确愿意被联系时才安排回访；不要收集不需要的私人账号资料。

| 指标 | 定义 | 当前获取方式 / 局限 |
| --- | --- | --- |
| 五秒理解率 | 能正确说明产品的人 / 接受观察的人 | 人工观察；10 人是方向性样本，不是市场估计 |
| 首跑成功率 | 成功完成独立可验证任务的人 / 实际尝试首跑的人 | 自愿反馈；不能只计算提交了成功截图的人 |
| 七日再次使用 | 七日内确实再次使用的人 / 同批首跑成功的人 | 自愿回访；未回应单列未知，同时报告回访覆盖率 |
| 用户阻断问题 | 导致不能安装、登录或完成任务的独立问题 | 脱敏 Issue，去重并记录系统/provider |
| 渠道效果 | 每渠道实际尝试、验证成功人数与维护成本 | 自愿来源说明；不要从总下载量反推精准归因 |
| 关注与下载 | Star、clone、npm download 等汇总信号 | 仅作辅助；不能直接等同独立用户或激活 |

追踪表字段：日期｜渠道｜已发布链接｜内容版本｜明确试用人数｜验证成功人数｜失败阶段｜未知人数｜维护时间｜现金成本。
所有计划值留空或标“目标”，没有采集到的数据写“未测”，不填 0 冒充没有失败或没有成本。
建议目标仍是理解 8/10、首跑 7/10；若达到，只说明可以开展下一轮，不说明产品已验证市场匹配。

## 10. 预算、长期内容与交付边界

前 14 天建议广告与目录预算为 0，优先投入安装支持、案例录制、文档和浏览器适配稳定性。
必须扩展曝光时，先复用已有录屏与图，不购买“保证收录”“保证上榜”或未经披露的用户推荐。
在自然流量来源、首跑样本和持续用途尚不清楚前，不用小样本激活率预测付费回报。

后续每周发布一个真实案例：一个 bug 的修复、一次登录失败如何定位、一处恢复机制的取舍。
再考虑三篇长期技术内容：网页聊天与本地工具如何闭环；独立 CLI、原生 Codex 桥接与 MCP 的工作方式；网页改版与失败恢复。
每篇使用实际命令、当前版本和结果，明确适配器实现与在线验证范围；不批量制造 provider/模型关键词页面。
先把单页英文入口做好；确有中文自然搜索需求时再做独立静态语言页面与对应元数据，而不是宣称当前客户端切换已完成双语搜索优化。

本轮已完成的网站、GIF 和自动化证据不代表已上线，也不代表已通过 10 人理解/激活测试。
仍需维护者执行：视觉确认、在线录屏、真实首跑、公开包核对、Pages 启用及对外发布。
README、旧的独立 SVG 架构图和 demo.tape 未因本轮改版被自动删除或覆盖，后续只在确认依赖关系后整理。
网站不再引用旧 hero-flow.svg / architecture.svg；保留原文件不影响新首屏。
最终提交时分别审阅网站/素材、演示脚本、推广文档和验证产物；不要连同原有运行时代码修改一起提交。

## 11. 外部资料与核对范围

精简版再次核对了 [S1]、[S2]，并补充 [S8]；其余渠道资料沿用此前记录，发布前需重新核实。
[S8] DevSpace Security Model：https://github.com/Waishnav/devspace/blob/main/docs/security.md

以下页面于 2026-09-06 读取。仓库描述用于准确比较定位；平台规则仍应在实际发布当日复核。
[S1] codex-chatgpt-web README：https://github.com/miuuyy/codex-chatgpt-web
[S2] DevSpace README：https://github.com/Waishnav/devspace
[S3] GitHub Pages 发布源：https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
[S4] Show HN Guidelines：https://news.ycombinator.com/showhn.html
[S5] Hacker News Guidelines：https://news.ycombinator.com/newsguidelines.html
[S6] Product Hunt Launch Guide：https://www.producthunt.com/launch
[S7] GitHub 仓库流量说明：https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository

本轮没有安装竞品、购买曝光、发布帖子、访问私人 AI 账号或验证全部在线 provider。
不延用旧文档的目录价格、审核时间、账号状态或推荐节点作为当前事实。
