# 运维手册

## 服务架构

```
客户端 → OpenClaw Gateway → proxy.js (18800) ─┬→ api.moonshot.cn (kimi 直连)
                                                └→ api.qnaigc.com  (其他模型, token 轮换)
                                                └→ Clash (7897)    (CONNECT 隧道)
```

## 服务管理

### Proxy 服务

- **配置文件**: `/Library/LaunchDaemons/com.agentteam.qnaigc-proxy.plist`
- **代码路径**: `/opt/qnaigc-proxy/proxy.js`
- **状态文件**: `/opt/qnaigc-proxy/state.json`

```bash
# 重启
sudo launchctl kickstart -k system/com.agentteam.qnaigc-proxy

# 日志
tail -f /opt/qnaigc-proxy/proxy.log
tail -f /opt/qnaigc-proxy/proxy-error.log
```

### OpenClaw Gateway

- **配置文件**: `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
- **主配置**: `~/.openclaw/openclaw.json`

```bash
# 重启
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# 日志
tail -f ~/.openclaw/logs/gateway.log

# 运行时日志
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log
```

## 注意事项

- `reasoning` 标志修改需要**重启 gateway** 才能生效（不支持热重载）
- `thinkingDefault` 和 `subagents.thinking` 支持热重载
- kimi 请求必须直连 Moonshot，不能经过 qnaigc（会剥离 reasoning_content）
