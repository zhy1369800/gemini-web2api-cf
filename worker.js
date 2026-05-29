/**
 * gemini-web2api — Cloudflare Worker(单文件)
 *
 * 把 Google Gemini 网页版的 StreamGenerate 协议转换成 OpenAI 兼容的 API。
 * 这是 Python 版 `gemini_web2api` 包的 JS 移植,改写为 Cloudflare Workers /
 * Web Fetch 运行时(不依赖 Node,不依赖标准库)。
 *
 * 接口:
 *   OpenAI:      GET  /v1/models
 *                POST /v1/chat/completions
 *                POST /v1/responses                       (Codex CLI)
 *   Google CLI:  GET  /v1beta/models
 *                POST /v1beta/models/{model}:generateContent
 *                POST /v1beta/models/{model}:streamGenerateContent
 *
 * 部署:把这个单文件粘贴到 Cloudflare 后台
 * (Workers & Pages → Create → 粘贴 → Deploy),或执行 `wrangler deploy`。
 * 不需要 wrangler.toml 的 [vars] 或 secrets —— 改下面的 CONFIG 即可。
 *
 * 配置:编辑本文件顶部的 CONFIG 对象。每个键也都可以用同名的 Worker
 * 环境变量 / secret 覆盖(GEMINI_COOKIE / API_KEYS 建议用 secret,避免提交进仓库):
 *   GEMINI_COOKIE        完整 cookie 字符串,或 JSON {"cookie": "...", "sapisid": "..."}
 *   SAPISID              可选,显式指定 SAPISID(否则从 cookie 自动提取)
 *   API_KEYS             逗号分隔的列表或 JSON 数组;为空 = 不鉴权
 *   GEMINI_BL            Gemini 网页版构建号(会随时间变化)
 *   DEFAULT_MODEL        默认模型名
 *   RETRY_ATTEMPTS / RETRY_DELAY_SEC / REQUEST_TIMEOUT_SEC   整数
 *   LOG_REQUESTS         true/false
 *
 * 限制(与上游一致):不支持图片/多模态输入 —— Gemini 的上传走的是私有流式 RPC,
 * 模型在这里无法解码,因此图片会被替换成一段文字提示。`gemini-3.1-pro` 只有在带
 * 付费账号 cookie 时才会真正路由到 Pro,否则回退到 Flash。
 */

const VERSION = "1.1.0-worker";

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG —— 改这些值,然后直接部署本文件。
//  若设置了同名的 Worker 环境变量 / secret,会覆盖这里的值;不设则用此处的值。
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // 调用方必须携带的密钥(Authorization: Bearer <key> 或 x-api-key: <key>)。
  // 空数组 = 不鉴权(任何知道地址的人都能调用)。
  API_KEYS: [],

  // Gemini cookie。匿名访问对所有模型都可用,唯独真正的 Pro 路由需要它。
  // 原始 cookie 字符串,例如:
  //   "SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-1PSID=..."
  // 匿名就留空 ""。(出于安全考虑,建议把它设为 Worker secret。)
  GEMINI_COOKIE: "",
  SAPISID: "", // 可选;留空则自动从上面的 cookie 中提取

  // Gemini 网页版构建号。如果返回开始变空,去 gemini.google.com 页面源码里
  // 找一个新的值("boq_assistant-bard-web-server_...")。
  GEMINI_BL: "boq_assistant-bard-web-server_20260525.09_p0",

  DEFAULT_MODEL: "gemini-3.5-flash",
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_SEC: 2,
  REQUEST_TIMEOUT_SEC: 180,
  LOG_REQUESTS: true,
};

// ─── 模型 ────────────────────────────────────────────────────────────────
// MODE_CATEGORY 枚举(来自 Gemini 前端 JS):
//   1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE
const MODELS = {
  "gemini-3.5-flash": { mode: 1, think: 4, desc: "Fast general-purpose model" },
  "gemini-3.5-flash-thinking": { mode: 2, think: 0, desc: "Deep thinking mode, longest output (~20k chars)" },
  "gemini-3.1-pro": { mode: 3, think: 4, desc: "Pro model (requires cookie for real routing)" },
  "gemini-3.1-pro-enhanced": { mode: 3, think: 4, extra: { 31: 2, 80: 3 }, desc: "Pro with enhanced output (experimental)" },
  "gemini-auto": { mode: 4, think: 4, desc: "Auto model selection" },
  "gemini-3.5-flash-thinking-lite": { mode: 5, think: 0, desc: "Dynamic thinking with adaptive depth" },
  "gemini-flash-lite": { mode: 6, think: 4, desc: "Lightweight fast model" },
};

/**
 * 把模型名解析成路由参数。
 * 未知名称会回退到 `def` 而不是报错(客户端可能传任意 id)。
 * 支持 `@think=N` 后缀来覆盖思考深度。
 * 返回 { name, modeId, thinkMode, extra },或 { error }。
 */
function resolveModel(modelName, def) {
  let thinkOverride = null;
  if (modelName.includes("@think=")) {
    const idx = modelName.lastIndexOf("@think=");
    const thinkStr = modelName.slice(idx + "@think=".length);
    modelName = modelName.slice(0, idx);
    if (!/^-?\d+$/.test(thinkStr)) return { error: `Invalid think level: ${thinkStr}` };
    thinkOverride = parseInt(thinkStr, 10);
  }
  let cfg = MODELS[modelName];
  if (!cfg) {
    modelName = def;
    cfg = MODELS[def];
  }
  return {
    name: modelName,
    modeId: cfg.mode,
    thinkMode: thinkOverride !== null ? thinkOverride : cfg.think,
    extra: cfg.extra || null,
  };
}

// ─── 配置 ──────────────────────────────────────────────────────────────────
function parseBool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function parseIntDefault(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseApiKeys(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  v = String(v).trim();
  if (v.startsWith("[")) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.map(String);
    } catch (_) { /* 继续往下走 */ }
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// 当 env[key] 设置了非空值时返回它,否则返回内嵌的默认值。
function envOr(env, key, fallback) {
  const v = env[key];
  return v !== undefined && v !== null && v !== "" ? v : fallback;
}

function getConfig(env) {
  env = env || {};
  let cookie = envOr(env, "GEMINI_COOKIE", CONFIG.GEMINI_COOKIE) || "";
  let sapisid = envOr(env, "SAPISID", CONFIG.SAPISID) || "";
  if (cookie && cookie.trim().startsWith("{")) {
    // JSON 形式:{"cookie": "...", "sapisid": "..."}
    try {
      const o = JSON.parse(cookie);
      cookie = o.cookie || "";
      if (!sapisid) sapisid = o.sapisid || "";
    } catch (_) { /* 当作原始字符串处理 */ }
  }
  if (cookie && !sapisid) {
    const m = /(?:^|;\s*)SAPISID=([^;]+)/.exec(cookie);
    if (m) sapisid = m[1];
  }
  return {
    gemini_bl: envOr(env, "GEMINI_BL", CONFIG.GEMINI_BL),
    default_model: envOr(env, "DEFAULT_MODEL", CONFIG.DEFAULT_MODEL),
    retry_attempts: parseIntDefault(envOr(env, "RETRY_ATTEMPTS", CONFIG.RETRY_ATTEMPTS), 3),
    retry_delay_sec: parseIntDefault(envOr(env, "RETRY_DELAY_SEC", CONFIG.RETRY_DELAY_SEC), 2),
    request_timeout_sec: parseIntDefault(envOr(env, "REQUEST_TIMEOUT_SEC", CONFIG.REQUEST_TIMEOUT_SEC), 180),
    log_requests: parseBool(envOr(env, "LOG_REQUESTS", CONFIG.LOG_REQUESTS), true),
    api_keys: parseApiKeys(envOr(env, "API_KEYS", CONFIG.API_KEYS)),
    cookie,
    sapisid,
  };
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────
function log(cfg, msg) {
  if (cfg && cfg.log_requests) {
    try { console.error(`[gemini-web2api] ${msg}`); } catch (_) {}
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    return AbortSignal.timeout(ms);
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

function randomBytes(n) {
  const arr = new Uint8Array(n);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return arr;
}

/** 生成 `n` 个十六进制字符的随机串(n/2 个随机字节)。 */
function randHex(n) {
  const bytes = randomBytes(Math.ceil(n / 2));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s.slice(0, n);
}

function uuid() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

/** SAPISIDHASH 鉴权头(对 "<ts> <sapisid> <origin>" 做 SHA-1)。 */
async function makeSapisidHash(sapisid) {
  const ts = nowSec();
  const data = new TextEncoder().encode(`${ts} ${sapisid} https://gemini.google.com`);
  const buf = await globalThis.crypto.subtle.digest("SHA-1", data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `SAPISIDHASH ${ts}_${hex}`;
}

function tokenEst(s) {
  return Math.floor((s ? s.length : 0) / 4);
}

// ─── Gemini StreamGenerate 协议 ────────────────────────────────────────────
/**
 * 构造 f.req 表单体。`inner` 是一个 102 槽的数组,对应 Gemini 网页前端发送的
 * 字段;字段 [79] 用于选择模型(MODE_CATEGORY)。
 */
function buildPayload(prompt, modelId, thinkMode, fileRefs, extra) {
  const inner = new Array(102).fill(null);
  if (fileRefs && fileRefs.length) {
    const refs = fileRefs.map((ref) => [null, null, ref]);
    inner[0] = [prompt, 0, null, refs, null, null, 0];
  } else {
    inner[0] = [prompt, 0, null, null, null, null, 0];
  }
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[thinkMode]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = uuid();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelId;
  if (extra) {
    for (const k of Object.keys(extra)) inner[Number(k)] = extra[k];
  }
  const outer = [null, JSON.stringify(inner)];
  return new URLSearchParams({ "f.req": JSON.stringify(outer) }).toString();
}

function getUrl(cfg) {
  const reqid = nowSec() % 1000000;
  return (
    "https://gemini.google.com/_/BardChatUi/data/" +
    "assistant.lamda.BardFrontendService/StreamGenerate" +
    `?bl=${encodeURIComponent(cfg.gemini_bl)}&hl=en&_reqid=${reqid}&rt=c`
  );
}

async function buildHeaders(cfg) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://gemini.google.com",
    "Referer": "https://gemini.google.com/app",
    "X-Same-Domain": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  if (cfg.sapisid) headers["Authorization"] = await makeSapisidHash(cfg.sapisid);
  return headers;
}

function stripArtifacts(text) {
  if (!text) return "";
  text = text.replace(
    /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g,
    ""
  );
  text = text.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, "");
  return text;
}

// 整段清理:去掉残留标记并裁剪首尾空白。
function cleanText(text) {
  return stripArtifacts(text).trim();
}

/** 解析单行 `wrb.fr`,返回其中包含的文本字符串。 */
function extractTextsFromLine(line) {
  if (!line.includes('"wrb.fr"') || line.length < 200) return [];
  try {
    const arr = JSON.parse(line);
    const innerStr = arr[0][2];
    if (!innerStr || innerStr.length < 50) return [];
    const inner = JSON.parse(innerStr);
    if (!(Array.isArray(inner) && inner.length > 4 && inner[4])) return [];
    const texts = [];
    for (const part of inner[4]) {
      if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
        for (const t of part[1]) {
          if (typeof t === "string" && t) texts.push(t);
        }
      }
    }
    return texts;
  } catch (_) {
    return [];
  }
}

function extractResponseText(raw) {
  let lastText = "";
  for (const line of raw.split("\n")) {
    for (const t of extractTextsFromLine(line)) {
      if (t.length > lastText.length) lastText = t;
    }
  }
  return cleanText(lastText);
}

/** 非流式生成(带重试)。返回最终的响应文本。 */
async function generate(cfg, prompt, modelId, thinkMode, extra) {
  const body = buildPayload(prompt, modelId, thinkMode, null, extra);
  const url = getUrl(cfg);
  const headers = await buildHeaders(cfg);
  let lastErr;
  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: timeoutSignal(cfg.request_timeout_sec * 1000),
      });
      const raw = await resp.text();
      if (!resp.ok) log(cfg, `upstream status ${resp.status}`);
      return extractResponseText(raw);
    } catch (e) {
      lastErr = e;
      if (attempt < cfg.retry_attempts - 1) {
        log(cfg, `Retry ${attempt + 1}/${cfg.retry_attempts}: ${e}`);
        await sleep(cfg.retry_delay_sec * 1000);
      }
    }
  }
  throw lastErr;
}

/**
 * 流式生成。每步 yield 一段文本增量(本次新追加的后缀)。
 * 只在尚未 yield 过任何内容时才重试,以避免重复输出。
 */
async function* generateStream(cfg, prompt, modelId, thinkMode, extra) {
  const body = buildPayload(prompt, modelId, thinkMode, null, extra);
  const url = getUrl(cfg);
  const headers = await buildHeaders(cfg);
  let lastErr;
  let yielded = false;

  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: timeoutSignal(cfg.request_timeout_sec * 1000),
      });
      if (!resp.body) {
        const text = extractResponseText(await resp.text());
        if (text) {
          yielded = true;
          yield text;
        }
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let prev = "";
      const consumeLine = function* (line) {
        for (const t of extractTextsFromLine(line)) {
          if (t.length > prev.length) {
            // 每段增量:去掉残留标记,但流式过程中不裁剪空白,
            // 以保留分块之间的空格(比如 "1, 2, 3" 而不是 "1, 2,3")。
            // 只有第一段增量会裁掉它的前导空白。
            const isFirst = prev === "";
            let delta = stripArtifacts(t.slice(prev.length));
            prev = t;
            if (isFirst) delta = delta.replace(/^\s+/, "");
            if (delta) yield delta;
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          for (const delta of consumeLine(line)) {
            yielded = true;
            yield delta;
          }
        }
      }
      buf += decoder.decode();
      if (buf) {
        for (const delta of consumeLine(buf)) {
          yielded = true;
          yield delta;
        }
      }
      return;
    } catch (e) {
      lastErr = e;
      if (!yielded && attempt < cfg.retry_attempts - 1) {
        log(cfg, `Stream retry ${attempt + 1}/${cfg.retry_attempts}: ${e}`);
        await sleep(cfg.retry_delay_sec * 1000);
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;
}

// ─── 工具调用 / 消息转换 ─────────────────────────────────────────────────────
function buildToolChoiceInstruction(toolChoice) {
  if (toolChoice === "none") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (toolChoice === "required") return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  if (toolChoice && typeof toolChoice === "object") {
    const fn = (toolChoice.function || {}).name || "";
    if (fn) return `\n\nIMPORTANT: You MUST call the tool "${fn}". Do not call other tools.`;
  }
  return "";
}

/** OpenAI messages -> [promptString, images]。images 恒为 [](不支持图片输入)。 */
function messagesToPrompt(messages, tools, toolChoice) {
  const parts = [];
  const images = [];

  if (tools && toolChoice !== "none") {
    const toolDefs = [];
    for (const tool of tools) {
      const fn = tool.type === "function" ? (tool.function || tool) : tool;
      toolDefs.push({
        name: fn.name != null ? fn.name : (tool.name || ""),
        description: fn.description != null ? fn.description : (tool.description || ""),
        parameters: fn.parameters != null ? fn.parameters : (tool.parameters || {}),
      });
    }
    if (toolDefs.length) {
      const constraint = buildToolChoiceInstruction(toolChoice);
      parts.push(
        "# Tool Use\n\n" +
          "You can call the following tools. Call format:\n" +
          '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n' +
          "When calling tools, output ONLY the tool_call block(s).\n\n" +
          `Available tools:\n${JSON.stringify(toolDefs, null, 2)}` +
          constraint
      );
    }
  }

  for (const msg of messages) {
    const role = msg.role || "user";
    let content = msg.content != null ? msg.content : "";

    if (Array.isArray(content)) {
      const textParts = [];
      for (const c of content) {
        const t = c && c.type;
        if (t === "text" || t === "input_text") {
          textParts.push(c.text || "");
        } else if (t === "image_url" || t === "image") {
          textParts.push("[Note: Image input not supported in this API. Please describe the image in text.]");
        }
      }
      content = textParts.join(" ");
    }

    if (role === "system") {
      parts.push(`[System instruction]: ${content}`);
    } else if (role === "assistant") {
      if (msg.tool_calls) {
        const tcStrs = msg.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return '```tool_call\n{"name": "' + fn.name + '", "arguments": ' + (fn.arguments || "{}") + "}\n```";
        });
        parts.push(`[Assistant]: ${content || ""}\n` + tcStrs.join("\n"));
      } else {
        parts.push(`[Assistant]: ${content}`);
      }
    } else if (role === "tool") {
      parts.push(`[Tool result for ${msg.name || ""}]: ${content}`);
    } else {
      parts.push(content ? content : "");
    }
  }

  return [parts.filter((p) => p).join("\n\n"), images];
}

/** 提取 ```tool_call``` 代码块 -> [cleanText, toolCalls]。 */
function parseToolCalls(text) {
  const toolCalls = [];
  const re = /```tool_call\s*\n([\s\S]*?)\n```/g;
  const cleanParts = [];
  let lastEnd = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    cleanParts.push(text.slice(lastEnd, m.index));
    lastEnd = m.index + m[0].length;
    try {
      const data = JSON.parse(m[1].trim());
      if (data.name === undefined) throw new Error("no name");
      toolCalls.push({
        id: `call_${randHex(8)}`,
        type: "function",
        function: {
          name: data.name,
          arguments: JSON.stringify(data.arguments != null ? data.arguments : {}),
        },
      });
    } catch (_) { /* 跳过格式错误的块 */ }
  }
  cleanParts.push(text.slice(lastEnd));
  return [cleanParts.join("").trim(), toolCalls];
}

// ─── Google 原生 API 辅助函数 ────────────────────────────────────────────────
function buildToolPrompt(toolDefs) {
  const spec = JSON.stringify(toolDefs, null, 2);
  return (
    "# Tool Use\n\n" +
    "You can call the following tools to help accomplish tasks. " +
    "These tools connect to the user's local environment and will execute when called.\n\n" +
    "Call format (use this exact format):\n" +
    "```function_call\n" +
    '{"name": "<tool_name>", "args": {<arguments>}}\n' +
    "```\n\n" +
    "When calling tools:\n" +
    "- Output ONLY the function_call block(s), nothing else\n" +
    "- You may call multiple tools with multiple blocks\n" +
    "- After receiving a [Tool result for ...], use that data to answer the user\n\n" +
    `Available tools:\n${spec}`
  );
}

function googleToolChoiceInstruction(req) {
  const fc = (req.toolConfig || {}).functionCallingConfig || {};
  const mode = fc.mode || "AUTO";
  const allowed = fc.allowedFunctionNames || [];
  if (mode === "NONE") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (mode === "ANY") {
    if (allowed.length) {
      const names = allowed.map((n) => `"${n}"`).join(", ");
      return `\n\nIMPORTANT: You MUST call one of these tools: ${names}. Do not respond with text only.`;
    }
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  return "";
}

/** Google 的 contents/tools/systemInstruction -> [promptString, images]。 */
function googleContentsToPrompt(req) {
  const parts = [];
  const images = [];

  const fcMode = ((req.toolConfig || {}).functionCallingConfig || {}).mode || "AUTO";
  const tools = req.tools;
  const toolDefs = [];
  if (tools && fcMode !== "NONE") {
    for (const group of tools) {
      for (const fn of group.functionDeclarations || []) {
        const td = { name: fn.name || "", description: fn.description || "" };
        const params = fn.parameters || fn.parametersJsonSchema;
        if (params) td.parameters = params;
        toolDefs.push(td);
      }
    }
  }

  const sysInst = req.systemInstruction;
  if (sysInst) {
    const sysText = (sysInst.parts || []).filter((p) => p.text).map((p) => p.text).join(" ");
    if (sysText) {
      if (toolDefs.length) {
        parts.push(sysText + "\n\n" + buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
      } else {
        parts.push(sysText);
      }
    }
  } else if (toolDefs.length) {
    parts.push(buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
  }

  for (const content of req.contents || []) {
    const role = content.role || "user";
    const msgParts = [];
    for (const p of content.parts || []) {
      if (p.text) {
        msgParts.push(p.text);
      } else if (p.inlineData) {
        msgParts.push("[Note: Image input not supported in this API. Please describe the image in text.]");
      } else if (p.functionCall) {
        const fc = p.functionCall;
        msgParts.push("```function_call\n" + JSON.stringify({ name: fc.name, args: fc.args || {} }) + "\n```");
      } else if (p.functionResponse) {
        const fr = p.functionResponse;
        msgParts.push(`[Tool result for ${fr.name || ""}]: ${JSON.stringify(fr.response || {})}`);
      }
    }
    const text = msgParts.join("\n");
    if (role === "model") parts.push(`[Assistant]: ${text}`);
    else parts.push(text);
  }

  return [parts.filter((p) => p).join("\n\n"), images];
}

/** 提取 ```function_call``` 代码块(3 种格式)-> [cleanText, functionCalls]。 */
function parseGoogleFunctionCalls(text) {
  const functionCalls = [];
  const patterns = [
    /```function_call\s*\n([\s\S]*?)\n```/g,
    /(?:^|\n)function_call\s*\n(\{[^`]*?\})/g,
  ];
  let clean = text;
  for (const pat of patterns) {
    for (const m of clean.matchAll(new RegExp(pat.source, pat.flags))) {
      try {
        const data = JSON.parse(m[1].trim());
        if (data && "name" in data) {
          functionCalls.push({ name: data.name, args: data.args != null ? data.args : (data.arguments != null ? data.arguments : {}) });
        }
      } catch (_) { /* 跳过 */ }
    }
    clean = clean.replace(new RegExp(pat.source, pat.flags), "").trim();
  }
  if (!functionCalls.length && clean.trim().startsWith("{")) {
    try {
      const data = JSON.parse(clean.trim());
      if (data && "name" in data && ("args" in data || "arguments" in data)) {
        functionCalls.push({ name: data.name, args: data.args != null ? data.args : data.arguments });
        clean = "";
      }
    } catch (_) { /* skip */ }
  }
  return [clean, functionCalls];
}

// ─── HTTP 辅助函数 ──────────────────────────────────────────────────────────────
function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*" };
}

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function authorized(request, cfg) {
  const keys = cfg.api_keys || [];
  if (!keys.length) return true;
  const auth = request.headers.get("authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : (request.headers.get("x-api-key") || "");
  return keys.includes(key);
}

/**
 * 构造一个 SSE 响应,响应体由 `producer(write)` 生成。
 * `write(str)` 会入队一个 UTF-8 分块。producer 结束后流会自动关闭。
 */
function sseResponse(producer) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (s) => controller.enqueue(encoder.encode(s));
      try {
        await producer(write);
      } catch (_) {
        /* 尽力而为:停止流式输出 */
      } finally {
        try { controller.close(); } catch (_) {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...corsHeaders(),
    },
  });
}

// ─── 处理函数 ──────────────────────────────────────────────────────────────────

// POST /v1/chat/completions
async function handleChat(req, cfg) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const tools = req.tools;
  const toolChoice = req.tool_choice != null ? req.tool_choice : "auto";
  const [prompt] = messagesToPrompt(req.messages || [], tools, toolChoice);
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty prompt" } }, 400);

  const stream = req.stream || false;
  const cid = `chatcmpl-${randHex(12)}`;

  if (stream && (!tools || toolChoice === "none")) {
    return sseResponse(async (write) => {
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra)) {
          write(`data: ${JSON.stringify({
            id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`);
        }
      } finally {
        write(`data: ${JSON.stringify({
          id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        write("data: [DONE]\n\n");
      }
    });
  }

  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (tools && text && toolChoice !== "none") {
    const [clean, tc] = parseToolCalls(text);
    text = clean;
    toolCalls = tc.length ? tc : null;
  }
  const msg = { role: "assistant", content: text || null };
  if (toolCalls) msg.tool_calls = toolCalls;
  const finish = toolCalls ? "tool_calls" : "stop";

  if (stream) {
    return sseResponse(async (write) => {
      write(`data: ${JSON.stringify({
        id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
        choices: [{ index: 0, delta: msg, finish_reason: finish }],
      })}\n\n`);
      write("data: [DONE]\n\n");
    });
  }

  return jsonResponse({
    id: cid, object: "chat.completion", created: nowSec(), model: rm.name,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: {
      prompt_tokens: tokenEst(prompt),
      completion_tokens: tokenEst(text),
      total_tokens: tokenEst(prompt) + tokenEst(text),
    },
  });
}

// POST /v1/responses(Codex CLI 用)
async function handleResponses(req, cfg) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const inputItems = req.input != null ? req.input : [];
  let tools = req.tools;
  const messages = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });

  if (typeof inputItems === "string") {
    messages.push({ role: "user", content: inputItems });
  } else if (Array.isArray(inputItems)) {
    for (const item of inputItems) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item && typeof item === "object") {
        if (item.type === "function_call_output") {
          messages.push({ role: "tool", tool_call_id: item.call_id || "", name: item.name || "", content: item.output || "" });
        } else if (item.role === "assistant" || (item.type === "message" && item.role === "assistant")) {
          const cp = item.content != null ? item.content : [];
          let textAcc = "";
          const tcList = [];
          if (Array.isArray(cp)) {
            for (const c of cp) {
              if (c && typeof c === "object") {
                if (c.type === "output_text") textAcc += c.text || "";
                else if (c.type === "function_call") tcList.push(c);
              }
            }
          } else if (typeof cp === "string") {
            textAcc = cp;
          }
          const m = { role: "assistant", content: textAcc || null };
          if (tcList.length) {
            m.tool_calls = tcList.map((tc, i) => ({
              id: tc.call_id || `call_${i}`, type: "function",
              function: { name: tc.name || "", arguments: tc.arguments || "{}" },
            }));
          }
          messages.push(m);
        } else {
          const role = item.role || "user";
          let content = item.content != null ? item.content : "";
          if (Array.isArray(content)) {
            content = content.filter((c) => c.type === "text" || c.type === "input_text").map((c) => c.text || "").join(" ");
          }
          messages.push({ role, content });
        }
      }
    }
  }

  if (tools) {
    tools = tools.map((t) =>
      t.type === "function" && !("function" in t)
        ? { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } }
        : t
    );
  }

  const toolChoice = req.tool_choice != null ? req.tool_choice : "auto";
  const [prompt] = messagesToPrompt(messages, tools, toolChoice);
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty input" } }, 400);

  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (tools && text && toolChoice !== "none") {
    const [clean, tc] = parseToolCalls(text);
    text = clean;
    toolCalls = tc.length ? tc : null;
  }

  const rid = `resp_${randHex(16)}`;
  const mid = `msg_${randHex(12)}`;
  const output = [];
  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
    }
  }
  if (text || !toolCalls) {
    output.push({ type: "message", id: mid, role: "assistant", status: "completed", content: [{ type: "output_text", text: text || "", annotations: [] }] });
  }

  const usage = { input_tokens: tokenEst(prompt), output_tokens: tokenEst(text), total_tokens: tokenEst(prompt) + tokenEst(text) };

  if (req.stream) {
    return sseResponse(async (write) => {
      write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: rid, object: "response", status: "in_progress", model: rm.name, output: [] } })}\n\n`);
      for (const item of output) {
        if (item.type === "function_call") {
          write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments })}\n\n`);
        } else if (item.type === "message") {
          item.content.forEach((cp, ci) => {
            write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: item.id, content_index: ci, text: cp.text })}\n\n`);
          });
        }
      }
      const respObj = { id: rid, object: "response", status: "completed", model: rm.name, output, usage };
      write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: respObj })}\n\n`);
    });
  }

  return jsonResponse({ id: rid, object: "response", created_at: nowSec(), status: "completed", model: rm.name, output, usage });
}

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
async function handleGoogleGenerate(req, cfg, path, stream) {
  const m = /\/v1beta\/models\/([^:?]+)/.exec(path);
  const rm = resolveModel(m ? m[1] : cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const fcMode = ((req.toolConfig || {}).functionCallingConfig || {}).mode || "AUTO";
  const hasTools = !!req.tools && fcMode !== "NONE";
  const [prompt] = googleContentsToPrompt(req);
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty content" } }, 400);

  log(cfg, `Google API: model=${rm.name} stream=${stream} tools=${hasTools} prompt_len=${prompt.length}`);

  if (stream && !hasTools) {
    return sseResponse(async (write) => {
      let fullText = "";
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra)) {
          if (!delta) continue;
          fullText += delta;
          write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: delta }], role: "model" }, index: 0 }], modelVersion: rm.name })}\n\n`);
        }
      } finally {
        write(`data: ${JSON.stringify({
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: tokenEst(prompt), candidatesTokenCount: tokenEst(fullText), totalTokenCount: tokenEst(prompt) + tokenEst(fullText) },
          modelVersion: rm.name,
        })}\n\n`);
      }
    });
  }

  let text;
  try {
    text = await generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }
  if (!text) log(cfg, "Warning: empty response from Gemini");

  const responseParts = [];
  if (hasTools && text) {
    const [clean, fcs] = parseGoogleFunctionCalls(text);
    if (fcs.length) {
      if (clean) responseParts.push({ text: clean });
      for (const fc of fcs) responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
    } else {
      responseParts.push({ text });
    }
  } else {
    responseParts.push({ text: text || "I apologize, but I was unable to generate a response. Please try again." });
  }

  const responseObj = {
    candidates: [{ content: { parts: responseParts, role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: tokenEst(prompt), candidatesTokenCount: tokenEst(text), totalTokenCount: tokenEst(prompt) + tokenEst(text) },
    modelVersion: rm.name,
  };

  if (stream) {
    return sseResponse(async (write) => { write(`data: ${JSON.stringify(responseObj)}\n\n`); });
  }
  return jsonResponse(responseObj);
}

// ─── 路由 ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders(), "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*" },
      });
    }

    // 只有 /v1/* 需要鉴权(与上游一致;/v1beta/* 对 Gemini CLI 开放)。
    if (path.startsWith("/v1/") && !authorized(request, cfg)) {
      return jsonResponse({ error: { message: "invalid api key" } }, 401);
    }

    try {
      if (method === "GET") {
        if (path === "/v1/models") {
          return jsonResponse({
            object: "list",
            data: Object.entries(MODELS).map(([n, c]) => ({ id: n, object: "model", created: 1700000000, owned_by: "google", description: c.desc })),
          });
        }
        if (path.startsWith("/v1beta/models")) {
          return jsonResponse({
            models: Object.entries(MODELS).map(([n, c]) => ({ name: `models/${n}`, displayName: n, description: c.desc, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] })),
          });
        }
        if (path === "/") {
          return jsonResponse({ status: "ok", version: VERSION, models: Object.keys(MODELS) });
        }
        return jsonResponse({ error: "not found" }, 404);
      }

      if (method === "POST") {
        const bodyText = await request.text();
        const req = parseJson(bodyText);

        if (path === "/v1/chat/completions") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleChat(req, cfg);
        }
        if (path === "/v1/responses") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleResponses(req, cfg);
        }
        if (path.includes(":generateContent")) {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleGoogleGenerate(req, cfg, path, false);
        }
        if (path.includes(":streamGenerateContent")) {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleGoogleGenerate(req, cfg, path, true);
        }
        return jsonResponse({ error: "not found" }, 404);
      }

      return jsonResponse({ error: "not found" }, 404);
    } catch (e) {
      log(cfg, `error: ${(e && e.stack) || e}`);
      return jsonResponse({ error: { message: String((e && e.message) || e) } }, 500);
    }
  },
};

// 导出给本地测试用(Workers 运行时会忽略)。
export {
  MODELS, resolveModel, getConfig, buildPayload, getUrl, buildHeaders, cleanText,
  extractTextsFromLine, extractResponseText, generate, generateStream,
  messagesToPrompt, parseToolCalls, googleContentsToPrompt, parseGoogleFunctionCalls,
  makeSapisidHash,
};
