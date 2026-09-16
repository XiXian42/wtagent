# 站点维护与发布

## WTAgent 官网

- 公开地址：https://xixian42.github.io/wtagent/
- GitHub Pages 从 `main` 分支的 `docs/` 目录发布。
- `docs/index.html` 提供默认英文内容；`docs/site.js` 中的 `chinese` 表提供中文翻译。新增可翻译文字需同时添加 HTML 的 `data-i18n` 标记与中文文案。
- 底部友情链接位于 `.footer-friends`：中文显示「友情链接 / 紫微斗数」，英文显示「Friends / Zi Wei Dou Shu」，均链接至 https://zi-wei-dou-shu.com/ 。
- 页脚样式位于 `docs/site.css`，支持窄屏自动换行。
- 发布时仅提交对应改动并推送 `main`，等待 GitHub Pages 构建成功，再核对公开地址返回的内容。

2026-09-16：新增中英文友情链接。

## WTAgent ChatGPT Site

- 公开地址：https://wtagent.xxxian886.chatgpt.site/
- 独立源码目录：`~/newstart/xx/wtagent-chatgpt-site`，站点 ID 为 `appgprj_6aa9f95f92188191a28e0cfddab73c03`。
- 静态文件在 `dist/`，来自本仓库的 `docs/index.html`、`docs/site.css`、`docs/site.js`、`docs/assets/`。同步时将 canonical、Open Graph 地址调整为 ChatGPT Site 域名，保留中英文友情链接。
- 无构建步骤；`.openai/hosting.json` 的 `static.directory` 为 `dist`。ChatGPT Site 与 GitHub Pages 分别发布，推送本仓库不会自动更新 ChatGPT Site。

## 紫微斗数排盘 ChatGPT Site

- 公开地址：https://zi-wei-dou-shu.xxxian886.chatgpt.site/
- 独立源码目录：`~/newstart/xx/ziwei-chatgpt-site`，复用站点 ID `appgprj_6aa977cc803881918c5a39c19ddcf205`。
- 定位仅为排盘工具：使用 iztro 在浏览器本地排盘，保留阳历/农历、真太阳时、三方四正和多语言。没有站内 AI 解读、登录或支付功能。
- 首页主区域、顶部品牌、页脚都有指向 https://zi-wei-dou-shu.com/ 的普通 HTML 外链，不带 `nofollow`，无需运行 JavaScript 就能发现。
- 命盘下的解读按钮跳回原站对应语言的 `/result` 页面，通过 `#extension=...` 传递出生资料，兼容原站现有接收逻辑；查询参数仅包含 `utm_source=chatgpt_site` 等来源标记。
- 由原站的 `ext/vercel` 工具独立适配，未修改或部署原站应用。可选城市搜索仍使用 Open-Meteo。
- `npm run build` 生成 `dist/`，`npm test` 检查排盘、语言、参数交接与产物；当前 6 项测试通过。站点同时输出 robots.txt 和 sitemap.xml，但不承诺搜索引擎收录。

## ChatGPT Sites 维护

- 两个站点均设置为 `public`，允许无需登录公开访问。
- 更新时使用各自目录中的 `.openai/hosting.json` 复用原站点，勿重复创建。
- 源码提交并推送至对应 Sites 源码仓库后，以该完整提交 SHA 打包、保存并部署。Git 凭证仅临时用于单次命令，不写入文件或远程地址。
- 上线后检查部署成功，以及匿名 HTTP 请求中的页面、资源和外链。浏览器交互回归需单独执行。

2026-09-16：创建 WTAgent ChatGPT Site，并将紫微 ChatGPT Site 发布为仅排盘、解读跳回原站的公开工具。
