# proxy.js 路由策略重构

> 状态: **已完成** (2026-02-08)
> 优先级: ~~低~~ → 已随 qnaigc 修复一并完成
> 前置: [[reasoning_content问题的深度分析]]

## 背景

原 proxy.js 硬编码 kimi 直连 Moonshot（绕过 qnaigc），原因是 qnaigc 会剥离 `reasoning_content` 导致 kimi 400 错误。

2026-02-08 确认 **qnaigc 已修复该问题**，遂重构为统一走 qnaigc + 自动降级备灾。

## 已完成的工作

### 1. A/B 测试验证 qnaigc 修复

| 测试 | 路径 | 结果 |
|------|------|------|
| 单轮对话 | qnaigc | `reasoning_content` 正常返回 |
| 单轮对话 | Moonshot 直连 | `reasoning_content` 正常返回 |
| 多轮含历史 `reasoning_content` | qnaigc | 不报 400，正常 |

### 2. 简化路由：移除 kimi 直连默认路径

**删除的代码：**
- `kimiTarget` / `kimiApiKey` 作为默认路由配置
- `isKimi` 路由分支（默认走 qnaigc）
- Model ID 重写 `moonshotai/kimi-k2.5` → `kimi-k2.5`（qnaigc 需要完整 provider 前缀）

**保留的防御补丁（2 个）：**
- `developer` → `system`：OpenClaw thinking 模式发 `developer` role，kimi 只支持 `system/assistant/user/tool`
- `reasoning_content: ""`：历史 assistant 消息可能缺此字段，Moonshot API thinking 模式要求必须有

### 3. 自动降级 + 探测恢复机制

不再需要手动切换，proxy 自行处理 qnaigc 故障：

```
kimi 请求 → qnaigc
            ├─ 正常 → 直接返回
            └─ 400 → [自动降级] retry 直连 Moonshot
                      ├─ 成功 → kimiAutoFallback=true
                      │         后续 kimi 全走直连
                      │         每 10min 探测 qnaigc
                      │         恢复 → 自动切回
                      └─ 失败 → 返回错误给客户端
```

**关键设计：**
- 自动降级状态 `kimiAutoFallback` 不持久化，proxy 重启即复位走 qnaigc
- `kimiDirect.enabled: true` 可手动强制直连（覆盖自动逻辑）
- 直连时自动去 model 前缀（`moonshotai/kimi-k2.5` → `kimi-k2.5`）

### 4. 日志标签

| 场景 | 日志标签 |
|------|----------|
| 默认走 qnaigc | `→qnaigc(A)` / `→qnaigc(B)` |
| 手动强制直连 | `→Moonshot(manual)` |
| 自动降级直连 | `→Moonshot(auto-fallback)` |

## 当前架构

```
openclaw.json                    proxy.js (127.0.0.1:18800)
  provider "qnaigc"
  baseUrl=127.0.0.1:18800  →  默认: api.qnaigc.com (token A/B 轮换)
  model: moonshotai/kimi-k2.5     备灾: api.moonshot.cn (自动降级/手动开关)
                                   补丁: developer→system, reasoning_content=""
                                   隧道: CONNECT → Clash:7897 → 外网
```

## 应急操作手册

### qnaigc 再次剥离 reasoning_content（自动处理）

正常情况下 proxy 会自动检测并降级，无需人工干预。日志会出现：
```
[自动降级] qnaigc 返回 400，切换 kimi 至 Moonshot 直连并重试
```

### 手动强制直连（备用）

编辑 `/opt/qnaigc-proxy/proxy.js`：
```javascript
kimiDirect: {
    enabled: true,   // false → true
```

重启：
```bash
sudo launchctl kickstart -k system/com.agentteam.qnaigc-proxy
```

## 原始设计中的静态路由规则表

原计划将路由重构为声明式规则表（`ROUTES` 数组 + `PATCHES` 注册表），但鉴于：
- qnaigc 已修复，不再需要 model 级别的路由分流
- 当前只有 kimi 一个模型需要特殊处理，且已用自动降级覆盖
- 过度抽象反而增加维护成本

**决定：暂不实施规则表抽象**，当前方案（统一 qnaigc + 自动降级备灾）已足够。未来若新增更多需要直连的模型再考虑。
