# 站点维护与发布

## WTAgent 官网

- 公开地址：https://xixian42.github.io/wtagent/
- GitHub Pages 从 `main` 分支的 `docs/` 目录发布。
- `docs/index.html` 提供默认英文内容；`docs/site.js` 中的 `chinese` 表提供中文翻译。新增可翻译文字需同时添加 HTML 的 `data-i18n` 标记与中文文案。
- 底部友情链接位于 `.footer-friends`：中文显示「友情链接 / 紫微斗数」，英文显示「Friends / Zi Wei Dou Shu」，均链接至 https://zi-wei-dou-shu.com/ 。
- 页脚样式位于 `docs/site.css`，支持窄屏自动换行。
- 发布时仅提交对应改动并推送 `main`，等待 GitHub Pages 构建成功，再核对公开地址返回的内容。

2026-09-16：新增中英文友情链接。
