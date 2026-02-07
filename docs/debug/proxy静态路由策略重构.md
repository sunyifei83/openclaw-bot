# proxy.js 静态路由策略重构

> 状态: **待开展**
> 优先级: 低（当前 hardcoded 方案已正常工作）
> 前置: [[reasoning_content问题的深度分析]]

## 背景

当前 proxy.js 中 kimi 的路由和 patch 逻辑是硬编码的（`json.model.includes("kimi")`）。将其重构为**声明式的静态路由规则表**，使未来新增模型路由只需加一条规则，不用改代码逻辑。

## 目标

- 路由规则声明式配置，新增模型不改代码逻辑
- Patch 函数按名称注册、按需组合
- 行为与当前完全一致，纯重构

## 设计

### 路由规则表

```javascript
const ROUTES = [
  {
    match: /kimi/i,           // 模型名正则匹配
    target: "api.moonshot.cn",
    apiKey: "sk-mjoDr...",
    stripPrefix: true,        // moonshotai/kimi-k2.5 → kimi-k2.5
    patches: ["developerToSystem", "ensureReasoningContent"]
  }
  // 未来示例：
  // {
  //   match: /deepseek-reasoner/i,
  //   target: "api.deepseek.com",
  //   apiKey: "sk-73fd...",
  //   stripPrefix: true,
  //   patches: ["ensureReasoningContent"]
  // }
];
```

- 未命中任何规则 → 走默认 qnaigc（token 轮换）
- `match`: 正则匹配请求体的 `model` 字段
- `patches`: 从预定义的 patch 函数注册表中按名称引用

### Patch 函数注册表

```javascript
const PATCHES = {
  developerToSystem(messages) {
    for (const m of messages) {
      if (m.role === "developer") m.role = "system";
    }
  },
  ensureReasoningContent(messages) {
    for (const m of messages) {
      if (m.role === "assistant" && m.reasoning_content === undefined) {
        m.reasoning_content = "";
      }
    }
  }
};
```

### 路由匹配函数

```javascript
function resolveRoute(body) {
  if (body.length === 0) return { body, route: null };
  try {
    const json = JSON.parse(body.toString("utf8"));
    if (!json.model) return { body, route: null };

    const route = ROUTES.find(r => r.match.test(json.model));
    if (!route) return { body, route: null };

    if (route.stripPrefix && json.model.includes("/")) {
      json.model = json.model.split("/").pop();
    }

    if (json.messages && Array.isArray(json.messages) && route.patches) {
      for (const name of route.patches) {
        if (PATCHES[name]) PATCHES[name](json.messages);
      }
    }

    return { body: Buffer.from(JSON.stringify(json), "utf8"), route };
  } catch (e) {}
  return { body, route: null };
}
```

## 变更范围

只改 `/opt/qnaigc-proxy/proxy.js` 一个文件：

1. `CONFIG.kimiTarget` / `CONFIG.kimiApiKey` → 移入 `ROUTES` 规则表
2. `patchAndRoute()` → 拆为 `resolveRoute()` + `PATCHES` 注册表
3. 请求转发逻辑简化

## 验证

1. 重启 proxy 后发消息给旺仔2号
2. 检查日志确认 kimi 请求走 `→api.moonshot.cn`
3. 检查日志确认其他模型走 `→qnaigc`
4. 确认 tool call 场景无 400 错误
