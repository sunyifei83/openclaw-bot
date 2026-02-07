cat /opt/qnaigc-proxy/proxy.js
const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");

const CONFIG = {
  port: 18800,
  // 默认目标（非 kimi 请求）
  defaultTarget: "api.qnaigc.com",
  tokens: [
    "<qnaigc-token1>",
    "<qnaigc-token2>"
  ],
  // kimi 请求直连 Moonshot（qnaigc 会剥离 reasoning_content 导致 400）
  kimiTarget: "api.moonshot.cn",
  kimiApiKey: "<moonshot-token>",
  stateFile: "/opt/qnaigc-proxy/state.json"
};

const CLASH_PROXY = { host: "127.0.0.1", port: 7897 };
let state = { requestCount: 0, tokenUsage: [0, 0] };

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

// 补丁 + 路由判断
function patchAndRoute(body) {
  let isKimi = false;
  if (body.length === 0) return { body, isKimi };

  try {
    const json = JSON.parse(body.toString("utf8"));

    // 检测是否为 kimi 模型
    if (json.model && json.model.includes("kimi")) {
      isKimi = true;
      // 去掉 provider 前缀：moonshotai/kimi-k2.5 → kimi-k2.5
      if (json.model.includes("/")) {
        json.model = json.model.split("/").pop();
      }
    }

    if (!json.messages || !Array.isArray(json.messages)) {
      if (isKimi) return { body: Buffer.from(JSON.stringify(json), "utf8"), isKimi };
      return { body, isKimi };
    }

    let changed = isKimi; // model rename already counts as change
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

    if (changed) {
      return { body: Buffer.from(JSON.stringify(json), "utf8"), isKimi };
    }
  } catch (e) {}

  return { body, isKimi };
}

const server = http.createServer((req, res) => {
  const { token, index } = getToken();
  const tokenLabel = index === 0 ? "A" : "B";

  let body = [];
  req.on("data", chunk => body.push(chunk));
  req.on("end", () => {
    body = Buffer.concat(body);

    let target = CONFIG.defaultTarget;
    let authToken = token;

    if (req.method === "POST" && req.url.includes("/chat/completions")) {
      const result = patchAndRoute(body);
      body = result.body;
      if (result.isKimi) {
        target = CONFIG.kimiTarget;
        authToken = CONFIG.kimiApiKey;
      }
    }

    const routeLabel = target === CONFIG.kimiTarget ? "→Moonshot" : `→qnaigc(${tokenLabel})`;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${routeLabel} (总请求: ${state.requestCount})`);

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
          console.error(`[resp-${proxyRes.statusCode}] ${Buffer.concat(respBody).toString("utf8").slice(0, 300)}`);
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
  });
});

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

loadState();
server.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`[启动] qnaigc 轮换代理运行在 http://127.0.0.1:${CONFIG.port}`);
  console.log(`[配置] 默认: ${CONFIG.defaultTarget} (Token x${CONFIG.tokens.length})`);
  console.log(`[配置] Kimi: ${CONFIG.kimiTarget} (直连)`);
  console.log(`[配置] CONNECT 隧道 → Clash ${CLASH_PROXY.host}:${CLASH_PROXY.port}`);
});
process.on("SIGTERM", () => { console.log("[退出] 保存状态..."); saveState(); process.exit(0); });
process.on("SIGINT", () => { console.log("[退出] 保存状态..."); saveState(); process.exit(0); });