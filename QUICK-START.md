# AI-DLC CLI 快速开始指南

## 🚀 快速安装

### 方式一：全局安装（推荐）
```bash
npm install -g aidlc
```

### 方式二：使用 npx（无需安装）
```bash
npx aidlc --help
```

## ⚡ 5分钟快速设置

### 1. 验证安装
```bash
aidlc --version
```

### 2. 初始化项目
```bash
cd your-project
aidlc init
```

### 3. 检查状态
```bash
aidlc status
```

### 4. 开始使用
在你的 AI 助手中（Kiro CLI 或 Amazon Q Developer）输入：
```
Using AI-DLC, I want to build a user authentication system
```

## 🎯 核心命令

| 命令 | 功能 | 示例 |
|------|------|------|
| `aidlc init` | 初始化 AI-DLC | `aidlc init --platform all` |
| `aidlc setup` | 交互式设置向导 | `aidlc setup` |
| `aidlc status` | 查看状态 | `aidlc status --verbose` |
| `aidlc validate` | 验证配置 | `aidlc validate --fix` |
| `aidlc version` | 版本信息 | `aidlc version --json` |

## 🔧 平台配置

### Kiro CLI
```bash
# 仅为 Kiro CLI 设置
aidlc init --platform kiro

# 启动 Kiro CLI
kiro-cli

# 检查上下文
/context show
```

### Amazon Q Developer
```bash
# 仅为 Amazon Q 设置
aidlc init --platform amazonq

# 在 IDE 中检查 Rules 按钮
```

### Claude Code
```bash
# 仅为 Claude Code 设置
aidlc init --platform claude

# 在 Claude Code 界面中使用
```

### Cursor
```bash
# 仅为 Cursor 设置
aidlc init --platform cursor

# 在 Cursor AI 聊天中使用
```

### OpenAI Codex
```bash
# 仅为 Codex 设置
aidlc init --platform codex

# 通过 API 集成使用
```

### Antigravity
```bash
# 仅为 Antigravity 设置
aidlc init --platform antigravity

# 在 Antigravity 界面中使用
```

### 多个平台
```bash
# 设置特定平台组合
aidlc init --platform kiro,claude,cursor

# 设置所有平台
aidlc init --platform all
```

## 📋 常见场景

### 新项目
```bash
mkdir my-new-project
cd my-new-project
npm init -y
git init
aidlc init
```

### 现有项目
```bash
cd existing-project
aidlc status
aidlc validate --fix
```

### 团队协作
```bash
git clone project-repo
cd project
npm install
aidlc status
```

## 🔍 故障排除

### 问题：找不到规则文件
```bash
aidlc validate --fix
```

### 问题：Kiro CLI 未找到
```bash
npm install -g @kiro-dev/cli
# 或使用 Amazon Q
aidlc init --platform amazonq
```

### 问题：需要重新设置
```bash
aidlc init --force --platform all
```

## 📚 更多资源

- **完整文档**: [README-CLI.md](README-CLI.md)
- **使用示例**: [EXAMPLES.md](EXAMPLES.md)
- **AI-DLC 博客**: https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/
- **方法论文档**: https://prod.d13rzhkk8cj2z0.amplifyapp.com/

## 💡 提示

1. **定期验证**: `aidlc validate`
2. **查看详细状态**: `aidlc status --verbose`
3. **使用设置向导**: `aidlc setup`
4. **保持更新**: `npm update -g aidlc`

开始你的 AI-DLC 之旅吧！🎉