# OpenClaw Bot - Claude Code 项目指令

## 项目概述

OpenClaw Bot 运维仓库，管理 API 代理服务、Bot 配置和调试文档。

## 技术栈

- **Proxy**: Node.js (原生 http/https/net，无框架依赖)
- **部署**: macOS launchd (LaunchDaemon + LaunchAgent)
- **框架**: OpenClaw

## 关键路径

| 组件 | 仓库路径 | 部署路径 |
|------|---------|---------|
| Proxy 服务 | `proxy/proxy.js` | `/opt/qnaigc-proxy/proxy.js` |
| 调试文档 | `docs/debug/` | - |
| 运维手册 | `docs/runbook.md` | - |
| Bot 配置 | `bot-config/` | `~/.openclaw/openclaw.json` |

## 开发规范

- Proxy 代码保持零依赖（仅 Node.js 标准库）
- 调试文档使用 Obsidian 风格 Markdown（支持 wikilinks、callouts）
- 敏感信息（API Key、Token）不入仓库，用占位符替代
- 配置变更需在 runbook 中注明是否需要重启服务
