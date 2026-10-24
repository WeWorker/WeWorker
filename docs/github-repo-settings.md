# GitHub 仓库设置信息

> 用于设置 GitHub 仓库的描述、话题标签等信息

---

## 仓库描述

**AI 驱动的网页自动化工具，通过浏览器扩展将网站操作封装为工具，供 AI Agent 调用，实现对任意网站的自动化操控。**

---

## 话题标签 (Topics)

```
ai
automation
browser-extension
electron
web-automation
agent
playwright
desktop-app
cli-tool
workflow-automation
```

---

## 社交预览图

**文件位置**: `docs/assets/social-preview.html`

### 生成步骤

1. 用浏览器打开 `social-preview.html`
2. 按 `F12` 打开开发者工具
3. 设置设备模拟为 `1280x640`
4. 截图保存为 PNG

### 尺寸要求

- **GitHub 社交预览图**: 1280 x 640 像素
- **格式**: PNG 或 JPG
- **文件大小**: < 1MB

---

## 仓库 URL

```
https://github.com/WeWorker/WeWorker
```

---

## 设置步骤

1. 访问仓库页面: https://github.com/WeWorker/WeWorker
2. 点击右侧齿轮图标 (⚙️) 编辑仓库信息
3. 填写:
   - **Description**: AI 驱动的网页自动化工具，通过浏览器扩展将网站操作封装为工具，供 AI Agent 调用，实现对任意网站的自动化操控。
   - **Website**: https://www.weworker.cc
   - **Topics**: ai, automation, browser-extension, electron, web-automation, agent, playwright, desktop-app, cli-tool, workflow-automation
4. 上传社交预览图
5. 点击 **Save** 保存

---

## 自动设置 (GitHub CLI)

如果安装了 `gh` CLI，可以使用以下命令：

```bash
# 设置仓库描述
gh repo edit WeWorker/WeWorker --description "AI 驱动的网页自动化工具，通过浏览器扩展将网站操作封装为工具，供 AI Agent 调用，实现对任意网站的自动化操控。"

# 设置话题标签
gh repo edit WeWorker/WeWorker --add-topic ai,automation,browser-extension,electron,web-automation,agent,playwright,desktop-app,cli-tool,workflow-automation

# 设置网站
gh repo edit WeWorker/WeWorker --homepage "https://www.weworker.cc"
```
