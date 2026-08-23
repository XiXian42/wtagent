---
name: adding-web-ai-provider
description: wtagent 接入新 Web AI 模型(provider)的完整步骤与踩坑经验;涉及 BaseWebAdapter 子类、provider-registry、结构完成信号、真实 Chrome CDP 分析
---

# wtagent 接入一个新 Web AI 模型

## 问题
项目要把 ChatGPT-only 的 agent 扩展成多 provider(ChatGPT/DeepSeek/Kimi/GLM/…),每个新站点的 DOM 不同、登录不同、完成判定不同,且站点常有多语言 UI 和 Cloudflare 反爬。

## 解决思路
设计文档 §4.1 早就定义了 provider 无关的 `WebModelAdapter` 接口——把"发消息→等回复→解析 XML 协议"的编排全部放进 `BaseWebAdapter`,新模型只继承并填空几个 provider 专属方法。核心原则:**能结构化的绝不靠文字**(多语言安全),**必须实测真实 DOM**(单元测试模拟不了站点)。

## 关键步骤
1. **注册**:`provider-registry.js` 把条目改 `active`,填 `adapter` 类、`baseUrl`、`profileBasename`、`defaultMode`(默认选哪个模型)、`promptsForMode: false`。
2. **写适配器**:新建 `src/browser/<name>-web-adapter.js` 继承 `BaseWebAdapter`,只实现:composer 输入框、会话 URL 规律(`conversationUrlPattern`)、消息行选择器 + `messageIdentity`(有稳定 id 用 id,没有就用数量基线)、`assistantText`(避开思考块)、`isAssistantGenerating`(见下)、登录检测(`authUrlPattern` 优先,URL 是语言无关的)、可选 `selectMode` / `deadRequestGraceMultiplier`(无停止按钮给 5×)。
3. **实测 DOM**:必须用**真实 Chrome**走 wtagent 自己的 CDP 路径开浏览器(agent-browser 的自动化指纹会被 Cloudflare 拦死,GLM/Claude 都验证过),用户登录后抓真实选择器,发一条测试消息验证 发送→读取→信封闭环。
4. **E2E 验证**:`wtagent --model <name>` 跑一个多轮本地文件任务,观察轮数/协议错误/文件产物;真实 E2E 每次都能抓出单测模拟不了的 bug(流式截断、占位符误判、提前 done)。
5. **补测试**:`<name>-adapter.test.js` 用 mock page 锁定行为;跑全量 `npm test`。

## 经验总结
- **完成判定找结构信号**:优先找"完成后才出现"的元素(停止按钮或动作条)——ChatGPT stop-button、Kimi `.segment-assistant-actions`、GLM `.copy-response-button`、DeepSeek `[role="button"].ds-button--iconLabelTertiary`。四个模型全都有,别用文字判断。
- **多语言零依赖**:URL 重定向(`/auth`、`/sign_in`)判登录;模型名(K3、GLM-5.x)不本地化;信封标签本身是语言无关的结构。
- **每个 provider 的坑**:ChatGPT 大回复会流式截断+占位符错误卡(`request-placeholder-*` 要排除);DeepSeek 爱发 Claude 风格 `<tool_calls>` 且带 `string="true"` 属性(解析器要容忍)、虚拟列表 key 会瞬态变负(用数量基线);Kimi/GLM 会提前 done 且把代码写进 message 而不是用工具。
- **运行时兜底**:纯文本无信封回复直接当最终答案展示(0 重试);工具调用塞在 done 的 message 里当协议错误回传;信封后的实质 prose 并入最终消息(模型常把真答案放信封后面)。
