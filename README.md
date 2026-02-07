# OpenClaw Bot

基于 [OpenClaw](https://github.com/nicepkg/openclaw) 框架的 AI Bot 运维仓库 -- 管理代理服务、Bot 配置、调试记录与运维脚本。

## 项目结构

```
openclaw-bot/
├── proxy/          # API 代理服务 (proxy.js)
├── bot-config/     # Bot 配置文件
├── docs/           # 文档
│   └── debug/      # 调试分析与问题记录
├── scripts/        # 运维工具脚本
└── docs/runbook.md # 运维手册
```

## 主要构建方向

### 1. API Proxy 服务 (`proxy/`)

Node.js 反向代理，部署在 OpenClaw gateway 前端，负责：

- **多模型路由**: 根据请求中的 model 字段路由到不同 API 后端 (qnaigc / Moonshot 直连)
- **请求 Patch**: 处理各厂商 API 兼容性差异 (reasoning_content 补充、role 替换、model prefix 剥离)
- **Token 轮换**: qnaigc 多 token 负载均衡
- **CONNECT 隧道**: HTTPS 请求转发到 Clash 代理

**当前状态**: 硬编码 kimi 路由已可用，待重构为声明式路由表 → [proxy静态路由策略重构](docs/debug/proxy静态路由策略重构.md)

### 2. Bot 配置管理 (`bot-config/`)

OpenClaw Bot 的配置文件版本化管理：

- 模型定义 (model capabilities, reasoning flags)
- Agent 默认参数 (thinkingDefault, subagents)
- 多 Bot 实例配置

### 3. 调试与问题记录 (`docs/debug/`)

生产问题的排查分析与经验沉淀：

- [reasoning_content 问题深度分析](docs/debug/reasoning_content问题的深度分析.md) -- kimi-k2.5 thinking 模式兼容性问题的完整排查
- [proxy 静态路由策略重构](docs/debug/proxy静态路由策略重构.md) -- 路由配置化设计方案

### 4. 运维脚本 (`scripts/`)

服务管理、监控、部署相关的自动化脚本 (待建设)。

## 环境

- **运行机器**: Mac Mini M4 (192.168.3.196)
- **Proxy 服务**: `http://127.0.0.1:18800`
- **OpenClaw Gateway**: macOS LaunchAgent
- **日志位置**: 见 [运维手册](docs/runbook.md)

## 快速参考

```bash
# Proxy 服务管理
sudo launchctl kickstart -k system/com.agentteam.qnaigc-proxy
tail -f /opt/qnaigc-proxy/proxy.log

# Gateway 服务管理
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
tail -f ~/.openclaw/logs/gateway.log
```

## License

BSD 3-Clause License
