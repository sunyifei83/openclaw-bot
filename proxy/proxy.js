//cat /opt/qnaigc-proxy/proxy.js
const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");

const CONFIG = {
  port: 18800,
  defaultTarget: "api.qnaigc.com",
  tokens: [
    "<token1>",
    "<token2>"
  ],
  kimiDirect: {
    enabled: false,       // 手动开关：true=强制直连，false=走 qnaigc（可被自动降级覆盖）
    target: "api.moonshot.cn",
    apiKey: "<moonshot-token>",
    probeIntervalMs: 10 * 60 * 1000  // 自动降级后每 10 分钟探测恢复
  },
  stateFile: "/opt/qnaigc-proxy/state.json"
};

const CLASH_PROXY = { host: "127.0.0.1", port: 7897 };
let state = { requestCount: 0, tokenUsage: [0, 0] };

// 自动降级状态（不持久化，重启即复位走 qnaigc）
let kimiAutoFallback = false;
let probeTimer = null;

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      state = JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8"));
      console.log(`[状态] 已加载: 请求总数=${state.requestCount}, 用量=[${state.tokenUsage}]`);
    }
  } catch (e) { console.error("[状态] 加载失败:", e.message); }
}
function saveState() {
  try { fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("[状态] 保存失败:", e.message); }
}
function getToken() {
  const index = state.requestCount % CONFIG.tokens.length;
  state.requestCount++;
  state.tokenUsage[index]++;
  if (state.requestCount % 10 === 0) saveState();
  return { token: CONFIG.tokens[index], index };
}

// ---- kimi 路由判断 ----
function isKimiModel(model) {
  return model && model.includes("kimi");
}
function shouldKimiGoDirect() {
  return CONFIG.kimiDirect.enabled || kimiAutoFallback;
}

// ---- 探测：定时发一个小请求到 qnaigc 检测是否恢复 ----
function startProbeTimer() {
  if (probeTimer) return; // 已在运行
  probeTimer = setInterval(() => {
    console.log("[探测] 检测 qnaigc kimi 路径...");
    const probeBody = JSON.stringify({
      model: "moonshotai/kimi-k2.5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }]
    });
    const tokenIdx = state.requestCount % CONFIG.tokens.length;
    const options = {
      hostname: CONFIG.defaultTarget,
      port: 443,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: CONFIG.defaultTarget,
        authorization: `Bearer ${CONFIG.tokens[tokenIdx]}`,
        "content-length": Buffer.byteLength(probeBody)
      }
    };
    const req = https.request(options, (res) => {
      let data = [];
      res.on("data", c => data.push(c));
      res.on("end", () => {
        if (res.statusCode < 400) {
          console.log("[探测] qnaigc kimi 路径恢复正常，切回 qnaigc");
          kimiAutoFallback = false;
          clearInterval(probeTimer);
          probeTimer = null;
        } else {
          console.log(`[探测] qnaigc 仍异常 (${res.statusCode})，维持直连`);
        }
      });
    });
    req.on("error", (e) => {
      console.log(`[探测] 请求失败: ${e.message}，维持直连`);
    });
    req.write(probeBody);
    req.end();
  }, CONFIG.kimiDirect.probeIntervalMs);
}

// ---- 补丁函数 ----
function patchBody(body, goingDirect) {
  if (body.length === 0) return body;
  try {
    const json = JSON.parse(body.toString("utf8"));
    let changed = false;

    // 直连 Moonshot 需要去 provider 前缀
    if (goingDirect && json.model && json.model.includes("/")) {
      json.model = json.model.split("/").pop();
      changed = true;
    }

    if (json.messages && Array.isArray(json.messages)) {
      for (const m of json.messages) {
        if (m.role === "developer") {
          m.role = "system";
          changed = true;
        }
        if (m.role === "assistant" && m.reasoning_content === undefined) {
          m.reasoning_content = "";
          changed = true;
        }
      }
    }
    if (changed) return Buffer.from(JSON.stringify(json), "utf8");
  } catch (e) {}
  return body;
}

// ---- 发送请求到指定目标 ----
function forwardRequest(req, res, body, target, authToken, routeLabel, kimiRetryBody) {
  const options = {
    hostname: target,
    port: 443,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: target,
      authorization: `Bearer ${authToken}`,
      "content-length": body.length
    }
  };

  const proxyReq = https.request(options, proxyRes => {
    if (proxyRes.statusCode >= 400) {
      let respBody = [];
      proxyRes.on("data", chunk => respBody.push(chunk));
      proxyRes.on("end", () => {
        const respText = Buffer.concat(respBody).toString("utf8").slice(0, 300);

        // 自动降级：kimi 走 qnaigc 得到 400 且未在直连模式 → 重试直连
        if (proxyRes.statusCode === 400 && kimiRetryBody && !shouldKimiGoDirect()) {
          console.error(`[自动降级] qnaigc 返回 400，切换 kimi 至 Moonshot 直连并重试`);
          console.error(`[resp-400] ${respText}`);
          kimiAutoFallback = true;
          startProbeTimer();

          const directBody = patchBody(kimiRetryBody, true);
          forwardRequest(req, res, directBody, CONFIG.kimiDirect.target, CONFIG.kimiDirect.apiKey, "→Moonshot(auto-fallback)", null);
          return;
        }

        console.error(`[resp-${proxyRes.statusCode}] ${respText}`);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(Buffer.concat(respBody));
      });
    } else {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  });
  proxyReq.on("error", err => {
    console.error(`[错误] ${routeLabel}:`, err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });
  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

// ---- HTTP 服务 ----
const server = http.createServer((req, res) => {
  const { token, index } = getToken();
  const tokenLabel = index === 0 ? "A" : "B";

  let body = [];
  req.on("data", chunk => body.push(chunk));
  req.on("end", () => {
    body = Buffer.concat(body);

    let target = CONFIG.defaultTarget;
    let authToken = token;
    let routeLabel = `→qnaigc(${tokenLabel})`;
    let kimiRetryBody = null;  // 非 null 表示可以触发 kimi 自动降级重试

    if (req.method === "POST" && req.url.includes("/chat/completions")) {
      // 检测是否为 kimi 模型
      let isKimi = false;
      try {
        const peek = JSON.parse(body.toString("utf8"));
        isKimi = isKimiModel(peek.model);
      } catch (e) {}

      if (isKimi && shouldKimiGoDirect()) {
        // 直连模式（手动或自动降级）
        body = patchBody(body, true);
        target = CONFIG.kimiDirect.target;
        authToken = CONFIG.kimiDirect.apiKey;
        routeLabel = CONFIG.kimiDirect.enabled ? "→Moonshot(manual)" : "→Moonshot(auto-fallback)";
      } else {
        // 走 qnaigc
        if (isKimi) kimiRetryBody = Buffer.from(body);  // 保存原始 body 供降级重试
        body = patchBody(body, false);
      }
    }

    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${routeLabel} (总请求: ${state.requestCount})`);
    forwardRequest(req, res, body, target, authToken, routeLabel, kimiRetryBody);
  });
});

// ---- CONNECT 隧道 ----
server.on("connect", (req, clientSocket, head) => {
  const [host, port] = req.url.split(":");
  const targetPort = parseInt(port) || 443;
  console.log(`[${new Date().toISOString()}] CONNECT ${host}:${targetPort} → Clash`);
  const proxySocket = net.connect(CLASH_PROXY.port, CLASH_PROXY.host, () => {
    proxySocket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`);
  });
  proxySocket.once("data", (chunk) => {
    if (chunk.toString().includes("200")) {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) proxySocket.write(head);
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
    } else {
      console.error(`[CONNECT] ${host}:${targetPort} Clash 返回: ${chunk.toString().split("\r\n")[0]}`);
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
      proxySocket.end();
    }
  });
  proxySocket.on("error", (err) => {
    console.error(`[CONNECT] ${host}:${targetPort} error: ${err.message}`);
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.end();
  });
  clientSocket.on("error", () => proxySocket.destroy());
});

// ---- 启动 ----
loadState();
server.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`[启动] qnaigc 轮换代理运行在 http://127.0.0.1:${CONFIG.port}`);
  console.log(`[配置] 目标: ${CONFIG.defaultTarget} (Token x${CONFIG.tokens.length})`);
  console.log(`[配置] Kimi 直连: ${CONFIG.kimiDirect.enabled ? "手动开启 → " + CONFIG.kimiDirect.target : "关闭 (自动降级待命)"}`);
  console.log(`[配置] 探测间隔: ${CONFIG.kimiDirect.probeIntervalMs / 1000}s`);
  console.log(`[配置] CONNECT 隧道 → Clash ${CLASH_PROXY.host}:${CLASH_PROXY.port}`);
});
process.on("SIGTERM", () => { console.log("[退出] 保存状态..."); saveState(); process.exit(0); });
process.on("SIGINT", () => { console.log("[退出] 保存状态..."); saveState(); process.exit(0); });