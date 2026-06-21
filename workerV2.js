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
 *   GEMINI_ORIGIN        上游源站;部署被 Google 429 限流时,指向干净 IP 的反向代理
 *   UPSTREAM_SOCKET      true/false;true=上游优先用裸 socket(绕开 fetch 的 429)
 *   DEFAULT_MODEL        默认模型名
 *   RETRY_ATTEMPTS / RETRY_DELAY_SEC / REQUEST_TIMEOUT_SEC   整数
 *   LOG_REQUESTS         true/false
 *   CURRENT_INPUT_FILE_MIN_BYTES   超过该 UTF-8 字节数才把上下文上传为 txt
 *   STRUCTURED_OUTPUT_STREAM_MODE  reject/best_effort
 *
 * 限制:图片/多模态输入需要登录态 —— 设置了 GEMINI_COOKIE 时,图片会经 Scotty
 * 上传到 Gemini 再绑进会话;未设置 cookie 时图片会被忽略(匿名带图会被后端以
 * 1100 拒绝),并在 prompt 里加一句提示。`gemini-3.1-pro` 也只有带付费账号 cookie
 * 时才会真正路由到 Pro,否则回退到 Flash。
 */

const VERSION = "1.1.0-worker";

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG —— 改这些值,然后直接部署本文件。
//  若设置了同名的 Worker 环境变量 / secret,会覆盖这里的值;不设则用此处的值。
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // 调用方必须携带的密钥(Authorization: Bearer <key> 或 x-api-key: <key>)。
  // 空数组 = 不鉴权(任何知道地址的人都能调用)。
  API_KEYS: ["sk-Cc2Tr1NH3ULYCCGlz"],

  // Gemini cookie。匿名访问对所有模型都可用,唯独真正的 Pro 路由需要它。
  // 原始 cookie 字符串,例如:
  //   "SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-1PSID=..."
  // 匿名就留空 ""。(出于安全考虑,建议把它设为 Worker secret。)
  GEMINI_COOKIE: "",
  SAPISID: "", // 可选;留空则自动从上面的 cookie 中提取

  // Gemini 网页版构建号。如果返回开始变空,去 gemini.google.com 页面源码里
  // 找一个新的值("boq_assistant-bard-web-server_...")。
  GEMINI_BL: "boq_assistant-bard-web-server_20260610.04_p0",

  // 上游源站。默认直连 gemini.google.com。若部署在 Cloudflare/无服务器平台
  // 被 Google 以 429 限流(出口 IP 被拦),把它指向一个跑在“干净 IP”上的反向
  // 代理(转发到 gemini.google.com 并保留 Host/Origin),即可绕开。例:
  //   GEMINI_ORIGIN = "https://your-relay.example.com"
  GEMINI_ORIGIN: "https://gemini.google.com",

  // 上游请求是否优先用裸 socket(cloudflare:sockets)绕开 fetch 的 429 限流。
  // true=优先 socket,不可用/失败再回退 fetch;false=只用 fetch。
  UPSTREAM_SOCKET: true,

  DEFAULT_MODEL: "gemini-3.5-flash",
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_SEC: 2,
  REQUEST_TIMEOUT_SEC: 180,
  LOG_REQUESTS: true,

  // Pass large request context as Gemini text attachments only when the inline
  // prompt is larger than CURRENT_INPUT_FILE_MIN_BYTES and a cookie is present.
  CURRENT_INPUT_FILE_ENABLED: true,
  CURRENT_INPUT_FILE_MIN_BYTES: 95000,
  CURRENT_INPUT_FILE_NAME: "message.txt",
  CURRENT_TOOLS_FILE_NAME: "tools.txt",

  // Reject structured-output streaming by default because this worker can only
  // validate and canonicalize final JSON after the full model output is known.
  // Set to "best_effort" to stream with prompt-only guidance.
  STRUCTURED_OUTPUT_STREAM_MODE: "reject",

};

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

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
 * 未知名称直接报错,避免调用方误以为使用了指定模型。
 * 支持 `@think=N` 后缀来覆盖思考深度。
 * 返回 { name, modeId, thinkMode, extra },或 { error }。
 */
function resolveModel(modelName, def) {
  modelName = String(modelName || def || "").trim();
  let thinkOverride = null;
  if (modelName.includes("@think=")) {
    const idx = modelName.lastIndexOf("@think=");
    const thinkStr = modelName.slice(idx + "@think=".length);
    modelName = modelName.slice(0, idx);
    if (!/^-?\d+$/.test(thinkStr)) return { error: `Invalid think level: ${thinkStr}` };
    thinkOverride = parseInt(thinkStr, 10);
  }
  const cfg = MODELS[modelName];
  if (!cfg) {
    return { error: `model ${modelName || "(empty)"} is not available` };
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
  if (Array.isArray(v)) return v.map((item) => item == null ? "" : String(item)).filter(Boolean);
  v = String(v).trim();
  if (v.startsWith("[")) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.map((item) => item == null ? "" : String(item)).filter(Boolean);
    } catch (_) { /* 继续往下走 */ }
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// 当 env[key] 设置了非空值时返回它,否则返回内嵌的默认值。
function envOr(env, key, fallback) {
  const v = env[key];
  return v !== undefined && v !== null && v !== "" ? v : fallback;
}

const CONFIG_ENV_KEYS = [
  "GEMINI_COOKIE",
  "SAPISID",
  "GEMINI_BL",
  "GEMINI_ORIGIN",
  "UPSTREAM_SOCKET",
  "DEFAULT_MODEL",
  "RETRY_ATTEMPTS",
  "RETRY_DELAY_SEC",
  "REQUEST_TIMEOUT_SEC",
  "LOG_REQUESTS",
  "CURRENT_INPUT_FILE_ENABLED",
  "CURRENT_INPUT_FILE_MIN_BYTES",
  "CURRENT_INPUT_FILE_NAME",
  "CURRENT_TOOLS_FILE_NAME",
  "STRUCTURED_OUTPUT_STREAM_MODE",
  "API_KEYS",
];
let _configCacheKey = null;
let _configCacheValue = null;

function configCacheKey(env) {
  env = env || {};
  let out = "";
  for (const key of CONFIG_ENV_KEYS) {
    const value = env[key];
    out += key + "\x00" + (value === undefined || value === null ? "" : String(value)) + "\x01";
  }
  return out;
}

function getConfig(env) {
  env = env || {};
  const cacheKey = configCacheKey(env);
  if (_configCacheValue && _configCacheKey === cacheKey) return _configCacheValue;
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
  const cfg = {
    gemini_bl: envOr(env, "GEMINI_BL", CONFIG.GEMINI_BL),
    gemini_origin: String(envOr(env, "GEMINI_ORIGIN", CONFIG.GEMINI_ORIGIN)).replace(/\/$/, ""),
    upstream_socket: parseBool(envOr(env, "UPSTREAM_SOCKET", CONFIG.UPSTREAM_SOCKET), true),
    default_model: envOr(env, "DEFAULT_MODEL", CONFIG.DEFAULT_MODEL),
    retry_attempts: parseIntDefault(envOr(env, "RETRY_ATTEMPTS", CONFIG.RETRY_ATTEMPTS), 3),
    retry_delay_sec: parseIntDefault(envOr(env, "RETRY_DELAY_SEC", CONFIG.RETRY_DELAY_SEC), 2),
    request_timeout_sec: parseIntDefault(envOr(env, "REQUEST_TIMEOUT_SEC", CONFIG.REQUEST_TIMEOUT_SEC), 180),
    log_requests: parseBool(envOr(env, "LOG_REQUESTS", CONFIG.LOG_REQUESTS), true),
    current_input_file_enabled: parseBool(envOr(env, "CURRENT_INPUT_FILE_ENABLED", CONFIG.CURRENT_INPUT_FILE_ENABLED), true),
    current_input_file_min_bytes: parseIntDefault(
      envOr(env, "CURRENT_INPUT_FILE_MIN_BYTES", CONFIG.CURRENT_INPUT_FILE_MIN_BYTES),
      CONFIG.CURRENT_INPUT_FILE_MIN_BYTES
    ),
    current_input_file_name: envOr(env, "CURRENT_INPUT_FILE_NAME", CONFIG.CURRENT_INPUT_FILE_NAME),
    current_tools_file_name: envOr(env, "CURRENT_TOOLS_FILE_NAME", CONFIG.CURRENT_TOOLS_FILE_NAME),
    structured_output_stream_mode: String(envOr(env, "STRUCTURED_OUTPUT_STREAM_MODE", CONFIG.STRUCTURED_OUTPUT_STREAM_MODE) || "reject").trim().toLowerCase(),
    api_keys: parseApiKeys(envOr(env, "API_KEYS", CONFIG.API_KEYS)),
    cookie,
    sapisid,
  };
  _configCacheKey = cacheKey;
  _configCacheValue = cfg;
  return cfg;
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────
function log(cfg, msg) {
  if (cfg && cfg.log_requests) {
    try { console.error(`[gemini-web2api] ${msg}`); } catch (_) {}
  }
}

function logInfo(cfg, msg) {
  if (cfg && cfg.log_requests) {
    try { console.log(`[gemini-web2api] ${msg}`); } catch (_) {}
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutSignal(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    return AbortSignal.timeout(n);
  }
  if (typeof AbortController === "undefined") return undefined;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), n);
  return ac.signal;
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason ? String(reason) : "request aborted");
  err.name = "AbortError";
  err.code = "request_aborted";
  return err;
}

function isAbortError(e) {
  return !!e && (e.name === "AbortError" || e.code === "request_aborted");
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal);
}

function linkedSignal(...signals) {
  const live = signals.filter(Boolean);
  if (!live.length) return { signal: undefined, cleanup() {} };
  if (live.length === 1) return { signal: live[0], cleanup() {} };
  const ac = new AbortController();
  const listeners = [];
  const cleanup = () => {
    while (listeners.length) {
      const [signal, listener] = listeners.pop();
      try { signal.removeEventListener("abort", listener); } catch (_) {}
    }
  };
  const abort = (signal) => {
    cleanup();
    if (!ac.signal.aborted) {
      try { ac.abort(signal && signal.reason); } catch (_) { ac.abort(); }
    }
  };
  for (const signal of live) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    listeners.push([signal, listener]);
    signal.addEventListener("abort", listener, { once: true });
  }
  return { signal: ac.signal, cleanup };
}

function canFallbackAfterSocketError(_method, error) {
  // socketHttp only throws here before it has returned a Response object to the
  // caller. In production Cloudflare sockets can close before any response
  // headers are readable; falling back to fetch preserves the old working
  // behavior for POST generation requests.
  return !(error && typeof error === "object" && error.upstreamStatus);
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
let _sapisidHashCache = { key: "", value: "" };

async function makeSapisidHash(sapisid) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error("crypto.subtle is required to build SAPISIDHASH");
  }
  const ts = nowSec();
  const cacheKey = `${ts}\x00${sapisid}`;
  if (_sapisidHashCache.key === cacheKey) return _sapisidHashCache.value;
  const data = TEXT_ENCODER.encode(`${ts} ${sapisid} https://gemini.google.com`);
  const buf = await globalThis.crypto.subtle.digest("SHA-1", data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const value = `SAPISIDHASH ${ts}_${hex}`;
  _sapisidHashCache = { key: cacheKey, value };
  return value;
}

function tokenEst(s) {
  const text = asTokenText(s);
  if (!text) return 0;
  const counts = tokenCharCounts(text);
  return tokenCountFromCharCounts(counts.asciiChars, counts.nonASCIIChars);
}

function tokenCharCounts(text) {
  const source = String(text || "");
  let asciiChars = 0;
  let nonASCIIChars = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code < 128) asciiChars += 1;
    else {
      nonASCIIChars += 1;
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < source.length) {
        const next = source.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) i += 1;
      }
    }
  }
  return { asciiChars, nonASCIIChars };
}

function tokenCountFromCharCounts(asciiChars, nonASCIIChars) {
  const n = Math.floor(asciiChars / 4) + Math.floor((nonASCIIChars * 10 + 7) / 13);
  return n < 1 ? 1 : n;
}

function createTokenCounter() {
  let asciiChars = 0;
  let nonASCIIChars = 0;
  let hasText = false;
  let pendingHighSurrogate = false;
  return {
    append(text) {
      const source = asTokenText(text);
      if (!source) return;
      hasText = true;
      for (let i = 0; i < source.length; i++) {
        const code = source.charCodeAt(i);
        if (pendingHighSurrogate) {
          pendingHighSurrogate = false;
          if (code >= 0xDC00 && code <= 0xDFFF) continue;
        }
        if (code < 128) {
          asciiChars += 1;
        } else {
          nonASCIIChars += 1;
          if (code >= 0xD800 && code <= 0xDBFF) {
            if (i + 1 < source.length) {
              const next = source.charCodeAt(i + 1);
              if (next >= 0xDC00 && next <= 0xDFFF) i += 1;
            } else {
              pendingHighSurrogate = true;
            }
          }
        }
      }
    },
    tokens() {
      return hasText ? tokenCountFromCharCounts(asciiChars, nonASCIIChars) : 0;
    },
    counts() {
      return { asciiChars, nonASCIIChars, hasText };
    },
  };
}

function addTokenCharCounts(target, source) {
  if (!source || !source.hasText) return target;
  target.asciiChars += source.asciiChars || 0;
  target.nonASCIIChars += source.nonASCIIChars || 0;
  target.hasText = true;
  return target;
}

function tokenCountFromCounts(counts) {
  return counts && counts.hasText ? tokenCountFromCharCounts(counts.asciiChars || 0, counts.nonASCIIChars || 0) : 0;
}

function buildTextWithTokens(parts, keepText = true) {
  const out = keepText ? [] : null;
  const counter = createTokenCounter();
  for (const part of parts || []) {
    const text = asTokenText(part);
    if (!text) continue;
    if (out) out.push(text);
    counter.append(text);
  }
  const counts = counter.counts();
  return { text: out ? out.join("") : "", tokens: tokenCountFromCounts(counts), counts };
}

function withGeminiNativeHiddenToolsPromptWithTokens(prompt, keepText = true) {
  const base = String(prompt || "").trimEnd();
  if (!base) {
    const text = prompt || "";
    return buildTextWithTokens([text], keepText);
  }
  return buildTextWithTokens([base, "\n\n", GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT], keepText);
}

function appendStructuredOutputInstructionWithTokens(prompt, requirement, keepText = true) {
  if (!requirement || !requirement.instruction) {
    const text = prompt || "";
    return buildTextWithTokens([text], keepText);
  }
  const base = String(prompt || "").trimEnd();
  const prepared = base
    ? buildTextWithTokens([base, "\n\n", requirement.instruction], keepText)
    : buildTextWithTokens([requirement.instruction], keepText);
  return prepared;
}

function appendStructuredOutputInstructionToPrepared(prepared, requirement, keepText = true) {
  if (!requirement || !requirement.instruction) {
    return keepText ? prepared : { ...prepared, text: "" };
  }
  if (!prepared || !prepared.counts || (keepText && String(prepared.text || "").trimEnd() !== String(prepared.text || ""))) {
    return appendStructuredOutputInstructionWithTokens(prepared && prepared.text, requirement, keepText);
  }
  const parts = [];
  const counts = { asciiChars: 0, nonASCIIChars: 0, hasText: false };
  addTokenCharCounts(counts, prepared.counts);
  if (prepared.counts.hasText) {
    parts.push(prepared.text || "");
    const sepCounts = tokenCharCounts("\n\n");
    addTokenCharCounts(counts, { ...sepCounts, hasText: true });
    if (keepText) parts.push("\n\n");
  }
  const instruction = requirement.instruction;
  const instructionCounts = tokenCharCounts(instruction);
  addTokenCharCounts(counts, { ...instructionCounts, hasText: !!instruction });
  if (keepText) parts.push(instruction);
  return { text: keepText ? parts.join("") : "", tokens: tokenCountFromCounts(counts), counts };
}

function asTokenText(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return asTokenText(v[0]);
  if (v == null) return "";
  return String(v);
}

function promptByteLength(v) {
  const text = asTokenText(v);
  if (!text) return 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7F) bytes += 1;
    else if (code <= 0x7FF) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function codePointLengthAtLeast(text, min) {
  const source = String(text || "");
  if (source.length < min) return false;
  let count = 0;
  for (let i = 0; i < source.length; i++) {
    count += 1;
    const code = source.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < source.length) {
      const next = source.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) i += 1;
    }
    if (count >= min) return true;
  }
  return false;
}

function codePointLength(text) {
  const source = String(text || "");
  let count = 0;
  for (let i = 0; i < source.length; i++) {
    count += 1;
    const code = source.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < source.length) {
      const next = source.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) i += 1;
    }
  }
  return count;
}

function trimContinuationOverlap(existing, incoming) {
  if (!incoming) return "";
  if (!existing) return incoming;
  if (incoming.startsWith(existing)) return incoming.slice(existing.length);
  if (existing.startsWith(incoming)) return "";
  return incoming;
}

// ─── Gemini StreamGenerate 协议 ────────────────────────────────────────────
/**
 * 构造 f.req 表单体。`inner` 是一个 102 槽的数组,对应 Gemini 网页前端发送的
 * 字段;字段 [79] 用于选择模型(MODE_CATEGORY)。
 */
function buildPayload(prompt, modelId, thinkMode, fileRefs, extra) {
  const inner = new Array(102).fill(null);
  if (fileRefs && fileRefs.length) {
    // 每个上传文件表示为 [[fileRef, 1], filename](格式来自 gemini_webapi,
    // 已实测能被后端接受 —— 详见 test/live-image.mjs 的诊断)。
    const files = fileRefs.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return [[item.ref || item.fileRef || item.id || "", 1], item.name || item.filename || "file.txt"];
      }
      return [[item, 1], "file.txt"];
    });
    inner[0] = [prompt, 0, null, files, null, null, 0];
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
  const origin = (cfg.gemini_origin || "https://gemini.google.com").replace(/\/$/, "");
  return (
    origin +
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate" +
    `?bl=${encodeURIComponent(cfg.gemini_bl)}&hl=en&_reqid=${reqid}&rt=c`
  );
}

async function getFreshGeminiBuildLabel(cfg) {
  try {
    const headers = { "User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9" };
    if (cfg.cookie) headers["Cookie"] = cfg.cookie;
    const resp = await httpFetch(`${cfg.gemini_origin || "https://gemini.google.com"}/app`, {
      headers,
      timeoutMs: 30000,
      socket: cfg.upstream_socket,
      cfg,
    });
    const html = await resp.text();
    const match = /"cfb2h":"([^"]+)"/.exec(html) || /boq_assistant-bard-web-server_[0-9A-Za-z_.-]+/.exec(html);
    return match ? (match[1] || match[0]) : "";
  } catch (e) {
    log(cfg, `failed to refresh Gemini BL: ${e}`);
    return "";
  }
}

async function buildHeaders(cfg) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://gemini.google.com",
    "Referer": "https://gemini.google.com/app",
    "X-Same-Domain": "1",
    "User-Agent": _UA,
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  if (cfg.sapisid) headers["Authorization"] = await makeSapisidHash(cfg.sapisid);
  return headers;
}

// ─── Socket 上游(绕开 fetch)──────────────────────────────────────────────────
// Cloudflare Workers 的 fetch 子请求走共享出口、易被 Google 429。改用
// cloudflare:sockets 的 connect() 裸 TCP+TLS 自行拼 HTTP/1.1,出口路径不同,
// 常能避开限流。Node(测试)拿不到该模块 -> resolveConnect() 返回 null -> 回退 fetch。
let _connect; // undefined=未解析, null=不可用, function=可用
async function resolveConnect() {
  if (_connect !== undefined) return _connect;
  try {
    const mod = await import("cloudflare:sockets");
    _connect = mod.connect || null;
  } catch (_) {
    _connect = null;
  }
  return _connect;
}
const MAX_SOCKET_HEADER_BYTES = 64 * 1024;

function _joinByteChunks(chunks, totalLength) {
  if (!chunks || !chunks.length) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function bytesFromBody(body) {
  if (body == null) return null;
  if (typeof body === "string") return TEXT_ENCODER.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Uint8Array(body);
}

function socketTimeoutError(stage, timeoutMs) {
  const err = new Error(`socket: ${stage} timed out after ${timeoutMs}ms`);
  err.code = "socket_timeout";
  return err;
}

function closeSocketQuietly(socket) {
  try { socket.close(); } catch (_) {}
}

function withSocketTimeout(promise, timeoutMs, stage, socket, signal) {
  throwIfAborted(signal);
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) {
    return Promise.resolve(promise).then((value) => {
      throwIfAborted(signal);
      return value;
    });
  }
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      closeSocketQuietly(socket);
      reject(socketTimeoutError(stage, n));
    }, n);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        try {
          throwIfAborted(signal);
          resolve(value);
        } catch (e) {
          reject(e);
        }
      },
      (err) => {
        clearTimeout(timer);
        try {
          throwIfAborted(signal);
          reject(err);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

function createByteQueue(initial) {
  const chunks = [];
  let headOffset = 0;
  let length = 0;
  if (initial && initial.length) {
    chunks.push(initial);
    length = initial.length;
  }
  const compact = () => {
    while (chunks.length && headOffset >= chunks[0].length) {
      headOffset -= chunks[0].length;
      chunks.shift();
    }
  };
  const readByte = () => {
    compact();
    if (!chunks.length) return -1;
    const value = chunks[0][headOffset++];
    length -= 1;
    compact();
    return value;
  };
  const api = {
    get length() { return length; },
    push(chunk) {
      if (!chunk || !chunk.length) return;
      chunks.push(chunk);
      length += chunk.length;
    },
    read(n) {
      n = Math.max(0, Math.min(Number(n) || 0, length));
      if (!n) return new Uint8Array(0);
      const out = new Uint8Array(n);
      let offset = 0;
      while (offset < n) {
        compact();
        const first = chunks[0];
        const take = Math.min(n - offset, first.length - headOffset);
        out.set(first.subarray(headOffset, headOffset + take), offset);
        headOffset += take;
        offset += take;
        length -= take;
      }
      compact();
      return out;
    },
    readLine() {
      const out = [];
      for (;;) {
        const b = readByte();
        if (b < 0) return null;
        if (b === 13) {
          const next = readByte();
          if (next === 10) return new Uint8Array(out);
          out.push(b);
          if (next >= 0) out.push(next);
          continue;
        }
        out.push(b);
      }
    },
    readLineIfAvailable() {
      compact();
      let prev = -1;
      let pos = 0;
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        const start = c === 0 ? headOffset : 0;
        for (let i = start; i < chunk.length; i++) {
          const b = chunk[i];
          if (prev === 13 && b === 10) {
            const line = api.read(pos - 1);
            api.skipCRLF();
            return line;
          }
          prev = b;
          pos += 1;
        }
      }
      return null;
    },
    skipCRLF() {
      const a = readByte();
      const b = readByte();
      return a === 13 && b === 10;
    },
    drain(controller) {
      compact();
      if (!length) return;
      while (chunks.length) {
        const first = chunks[0];
        const out = headOffset ? first.subarray(headOffset) : first;
        if (out.length) controller.enqueue(out);
        chunks.shift();
        headOffset = 0;
      }
      length = 0;
    },
  };
  return api;
}

// 用裸 socket 发一个 HTTP/1.1 请求,返回类 Response 对象:{status, ok, headers, body, text()}。
// body 是已解码(去 chunked、identity 编码)的 ReadableStream<Uint8Array>,支持流式。
async function socketHttp(connect, url, { method = "GET", headers = {}, body, timeoutMs = 180000, signal } = {}) {
  throwIfAborted(signal);
  const u = new URL(url);
  const secure = u.protocol !== "http:";
  const port = u.port ? Number(u.port) : (secure ? 443 : 80);
  const socket = connect({ hostname: u.hostname, port }, { secureTransport: secure ? "on" : "off", allowHalfOpen: false });

  const onAbort = () => closeSocketQuietly(socket);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  const bodyBytes = bytesFromBody(body);
  // 自管 Host/Connection/Accept-Encoding(identity 避免 gzip)/Content-Length
  const reqHeaders = { Host: u.host, "Accept-Encoding": "identity", Connection: "close" };
  for (const [k, v] of Object.entries(headers)) {
    if (/^(host|connection|accept-encoding|content-length)$/i.test(k)) continue;
    reqHeaders[k] = v;
  }
  if (bodyBytes) reqHeaders["Content-Length"] = String(bodyBytes.length);
  let head = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(reqHeaders)) head += `${k}: ${v}\r\n`;
  head += "\r\n";

  const writer = socket.writable.getWriter();
  try {
    await withSocketTimeout(writer.write(TEXT_ENCODER.encode(head)), timeoutMs, "request headers write", socket, signal);
    if (bodyBytes) await withSocketTimeout(writer.write(bodyBytes), timeoutMs, "request body write", socket, signal);
    // Do not close the writer here. In Cloudflare Workers sockets, closing the
    // writable side can make Gemini close before response headers are readable.
  } catch (e) {
    if (signal) signal.removeEventListener("abort", onAbort);
    closeSocketQuietly(socket);
    throw e;
  }
  try { writer.releaseLock(); } catch (_) {}

  const reader = socket.readable.getReader();
  const failBeforeBody = (message) => {
    if (signal) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch (_) {}
    closeSocketQuietly(socket);
    throwIfAborted(signal);
    throw new Error(message);
  };
  let pending = new Uint8Array(0);
  let status = 0;
  let respHeaders = new Headers();
  const readHeaderBlock = async (initial) => {
    const chunks = [];
    let total = 0;
    let matched = 0;
    let headerEnd = -1;
    const pattern = [13, 10, 13, 10];
    const push = (value) => {
      if (!value || !value.length || headerEnd >= 0) return;
      chunks.push(value);
      const base = total;
      for (let i = 0; i < value.length; i++) {
        const b = value[i];
        if (b === pattern[matched]) {
          matched += 1;
          if (matched === pattern.length) {
            headerEnd = base + i - pattern.length + 1;
            break;
          }
        } else {
          matched = b === pattern[0] ? 1 : 0;
        }
      }
      total += value.length;
    };
    push(initial);
    while (headerEnd < 0) {
      const { done, value } = await withSocketTimeout(reader.read(), timeoutMs, "response headers", socket, signal);
      if (done) break;
      push(value);
      if (headerEnd < 0 && total > MAX_SOCKET_HEADER_BYTES) {
        failBeforeBody(`socket: HTTP response headers exceed ${MAX_SOCKET_HEADER_BYTES} bytes`);
      }
    }
    if (headerEnd < 0) failBeforeBody("socket: incomplete HTTP response headers");
    const joined = _joinByteChunks(chunks, total);
    return { headerBytes: joined.subarray(0, headerEnd), pending: joined.subarray(headerEnd + 4) };
  };
  for (;;) {
    const headerBlock = await readHeaderBlock(pending);
    const headerText = TEXT_DECODER.decode(headerBlock.headerBytes);
    pending = headerBlock.pending;
    const hlines = headerText.split("\r\n");
    status = parseInt((hlines[0] || "").split(" ")[1], 10) || 0;
    respHeaders = new Headers();
    for (let i = 1; i < hlines.length; i++) {
      const c = hlines[i].indexOf(":");
      if (c > 0) { try { respHeaders.append(hlines[i].slice(0, c).trim(), hlines[i].slice(c + 1).trim()); } catch (_) {} }
    }
    if (status >= 100 && status < 200 && status !== 101) {
      continue;
    }
    break;
  }
  const chunked = /chunked/i.test(respHeaders.get("transfer-encoding") || "");
  let clen = null;
  if (respHeaders.has("content-length")) {
    const rawContentLength = String(respHeaders.get("content-length") || "").trim();
    if (!/^(0|[1-9]\d*)$/.test(rawContentLength)) failBeforeBody(`socket: invalid Content-Length: ${rawContentLength}`);
    clen = Number(rawContentLength);
    if (!Number.isSafeInteger(clen)) failBeforeBody(`socket: invalid Content-Length: ${rawContentLength}`);
  }
  const noBody = method.toUpperCase() === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200);

  let cleanupDone = false;
  const cleanupBody = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    if (signal) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch (_) {}
    closeSocketQuietly(socket);
  };

  const queue = createByteQueue(pending);
  let fixedRemaining = clen == null ? null : clen;
  let chunkRemaining = 0;
  let bodyDone = false;

  const pullToQueue = async () => {
    const { done, value } = await withSocketTimeout(reader.read(), timeoutMs, "response body idle", socket, signal);
    if (done) return false;
    queue.push(value);
    return true;
  };

  const readAvailableLine = async () => {
    let line = queue.readLineIfAvailable();
    while (line === null) {
      if (!(await pullToQueue())) return null;
      line = queue.readLineIfAvailable();
    }
    return line;
  };

  const closeController = (controller) => {
    if (bodyDone) return;
    bodyDone = true;
    cleanupBody();
    controller.close();
  };

  const stream = new ReadableStream({
    start(controller) {
      if (noBody) closeController(controller);
    },
    async pull(controller) {
      if (bodyDone) return;
      try {
        if (chunked) {
          for (;;) {
            if (chunkRemaining > 0) {
              while (queue.length <= 0) {
                if (!(await pullToQueue())) throw new Error("socket: incomplete chunked body");
              }
              const take = Math.min(chunkRemaining, queue.length);
              const out = queue.read(take);
              chunkRemaining -= out.length;
              controller.enqueue(out);
              if (chunkRemaining === 0) {
                while (queue.length < 2) {
                  if (!(await pullToQueue())) throw new Error("socket: incomplete chunked body");
                }
                if (!queue.skipCRLF()) throw new Error("socket: invalid chunk terminator");
              }
              return;
            }
            const line = await readAvailableLine();
            if (line === null) throw new Error("socket: incomplete chunked body");
            const sizeText = TEXT_DECODER.decode(line).trim().split(";")[0];
            if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error(`socket: invalid chunk size: ${sizeText}`);
            chunkRemaining = parseInt(sizeText, 16);
            if (chunkRemaining === 0) {
              for (;;) {
                const trailer = await readAvailableLine();
                if (trailer === null || trailer.length === 0) {
                  closeController(controller);
                  return;
                }
              }
            }
          }
        } else if (fixedRemaining != null) {
          if (fixedRemaining <= 0) {
            closeController(controller);
            return;
          }
          while (queue.length <= 0) {
            if (!(await pullToQueue())) throw new Error("socket: incomplete fixed-length body");
          }
          const out = queue.read(Math.min(fixedRemaining, queue.length));
          fixedRemaining -= out.length;
          controller.enqueue(out);
          if (fixedRemaining <= 0) closeController(controller);
        } else {
          if (queue.length) {
            queue.drain(controller);
            return;
          }
          const { done, value } = await withSocketTimeout(reader.read(), timeoutMs, "response body idle", socket, signal);
          if (done) {
            closeController(controller);
            return;
          }
          if (value && value.length) controller.enqueue(value);
        }
      } catch (e) {
        bodyDone = true;
        cleanupBody();
        controller.error(e);
      }
    },
    cancel() { cleanupBody(); },
  });

  const res = { status, ok: status >= 200 && status < 300, headers: respHeaders, body: stream };
  res.text = async () => {
    const r = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      if (!value || !value.length) continue;
      chunks.push(value);
      total += value.length;
    }
    return TEXT_DECODER.decode(_joinByteChunks(chunks, total));
  };
  return res;
}

// 统一上游入口:socket 优先,失败/不可用则回退 fetch。返回类 Response 对象。
async function httpFetch(url, { method = "GET", headers = {}, body, timeoutMs = 180000, socket = true, signal, cfg } = {}) {
  throwIfAborted(signal);
  if (socket) {
    const connect = await resolveConnect();
    if (connect) {
      try {
        const resp = await socketHttp(connect, url, { method, headers, body, timeoutMs, signal });
        try { console.log(`[gemini-web2api] socket upstream succeeded: ${method} ${url} status=${resp.status}`); } catch (_) {}
        return resp;
      } catch (e) {
        if (isAbortError(e) || (signal && signal.aborted)) throw abortError(signal);
        if (!canFallbackAfterSocketError(method, e)) {
          log(cfg, `socket upstream failed; not falling back after upstream response for ${method}: ${upstreamErrorMessage(e)}`);
          throw e;
        }
        try { console.error(`[gemini-web2api] socket upstream failed; falling back to fetch: ${upstreamErrorMessage(e)}`); } catch (_) {}
        // socket 连接层失败(非 HTTP 错误)-> 回退 fetch
      }
    }
  }
  const linked = linkedSignal(signal, timeoutSignal(timeoutMs));
  try {
    return await fetch(url, { method, headers, body, signal: linked.signal });
  } finally {
    linked.cleanup();
  }
}

// ─── 多模态:图片上传(Scotty 续传)───────────────────────────────────────────
// 说明:图片输入需要登录态(GEMINI_COOKIE)。匿名会话上传文件能成功,但带图
// 生成会被后端以 BardErrorInfo[1100] 拒绝(权限门)。无 cookie 时不上传,
// 改为在 prompt 里追加一句提示,降级为纯文本。详见 test/live-image.mjs。

const _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
let _pageTokens = { key: "", tokens: null, ts: 0 };
let _pageTokensPending = { key: "", promise: null };

function base64ToBytes(b64) {
  const normalized = String(b64 || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  if (typeof atob === "function") {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(padded, "base64"));
  }
  throw new Error("base64 decoder is not available in this runtime");
}

// 解析 OpenAI image_url:data:URL(base64)或 http(s) URL。返回 {b64,mime} 或 {url} 或 null。
function parseImageUrl(url) {
  if (!url || typeof url !== "string") return null;
  const m = /^data:([^,]*?);base64,([\s\S]*)$/i.exec(url);
  if (m) return { b64: m[2], mime: (m[1].split(";")[0] || "image/png").toLowerCase() };
  if (/^https?:\/\//i.test(url)) return { url };
  return null;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function sanitizeUploadFilename(name) {
  if (typeof name !== "string" && typeof name !== "number") return "";
  name = String(name || "").trim();
  if (!name) return "";
  name = name.replace(/\0/g, "").replace(/[\r\n\t]/g, " ").trim();
  name = name.split(/[\\/]/).filter(Boolean).pop() || "";
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name === "." || name === "..") return "";
  return name.slice(0, 180);
}

function filenameFromUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const u = new URL(url);
    const last = decodeURIComponent((u.pathname || "").split("/").filter(Boolean).pop() || "");
    return sanitizeUploadFilename(last);
  } catch (_) {
    const path = String(url || "").split(/[?#]/)[0];
    return sanitizeUploadFilename(path);
  }
}

function imageFilenameFromObject(obj) {
  if (!obj || typeof obj !== "object") return "";
  const source = obj.source && typeof obj.source === "object" ? obj.source : null;
  const imageUrl = obj.image_url && typeof obj.image_url === "object" ? obj.image_url : null;
  const inlineData = (obj.inlineData && typeof obj.inlineData === "object" ? obj.inlineData : null)
    || (obj.inline_data && typeof obj.inline_data === "object" ? obj.inline_data : null);
  const fileData = (obj.fileData && typeof obj.fileData === "object" ? obj.fileData : null)
    || (obj.file_data && typeof obj.file_data === "object" ? obj.file_data : null);
  const file = obj.file && typeof obj.file === "object" ? obj.file : null;
  return firstNonEmptyString(...[
    obj.filename, obj.fileName, obj.file_name, obj.name, obj.displayName, obj.display_name,
    source && (source.filename || source.fileName || source.file_name || source.name || source.displayName || source.display_name),
    imageUrl && (imageUrl.filename || imageUrl.fileName || imageUrl.file_name || imageUrl.name || imageUrl.displayName || imageUrl.display_name),
    inlineData && (inlineData.filename || inlineData.fileName || inlineData.file_name || inlineData.name || inlineData.displayName || inlineData.display_name),
    fileData && (fileData.filename || fileData.fileName || fileData.file_name || fileData.name || fileData.displayName || fileData.display_name),
    file && (file.filename || file.fileName || file.file_name || file.name || file.displayName || file.display_name)
  ].map(sanitizeUploadFilename));
}

function imageFilenameFromMime(mime, index) {
  const base = `image${index > 1 ? `-${index}` : ""}`;
  const typ = String(mime || "").split(";")[0].trim().toLowerCase();
  switch (typ) {
    case "image/jpeg":
    case "image/jpg":
      return `${base}.jpg`;
    case "image/webp":
      return `${base}.webp`;
    case "image/gif":
      return `${base}.gif`;
    case "image/bmp":
      return `${base}.bmp`;
    case "image/heic":
      return `${base}.heic`;
    case "image/heif":
      return `${base}.heif`;
    case "image/png":
    default:
      return `${base}.png`;
  }
}

// 抓取 gemini.google.com/app 页面里的上传 token(带 10 分钟缓存)。
async function getPageTokens(cfg) {
  const now = Date.now();
  const cacheKey = `${cfg.gemini_origin || "https://gemini.google.com"}\x00${cfg.cookie || ""}`;
  if (_pageTokens.tokens && _pageTokens.key === cacheKey && now - _pageTokens.ts < 600000) return _pageTokens.tokens;
  if (_pageTokensPending.promise && _pageTokensPending.key === cacheKey) return _pageTokensPending.promise;
  const promise = (async () => {
    const headers = { "User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9" };
    if (cfg.cookie) headers["Cookie"] = cfg.cookie;
    const tokens = {};
    try {
      const resp = await httpFetch(`${cfg.gemini_origin || "https://gemini.google.com"}/app`, { headers, timeoutMs: 30000, socket: cfg.upstream_socket, cfg });
      const html = await resp.text();
      for (const [k, re] of [["push_id", /"qKIAYe":"([^"]+)"/], ["pctx", /"Ylro7b":"([^"]+)"/], ["at", /"SNlM0e":"([^"]+)"/]]) {
        const mm = re.exec(html);
        if (mm) tokens[k] = mm[1];
      }
    } catch (e) {
      /* 用默认值兜底 */
    }
    _pageTokens = { key: cacheKey, tokens, ts: now };
    return tokens;
  })();
  _pageTokensPending = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (_pageTokensPending.promise === promise) _pageTokensPending = { key: "", promise: null };
  }
}

// Scotty 续传上传一张图,返回文件引用(形如 "/contrib_service/ttl_1d/...")。
async function uploadImage(cfg, bytes, mime) {
  const tokens = await getPageTokens(cfg);
  const pushId = tokens.push_id || "feeds/mcudyrk2a4khkz";
  const pctx = tokens.pctx || "CgcSBWjK7pYx";

  const startHeaders = {
    "Push-ID": pushId,
    "X-Tenant-Id": "bard-storage",
    "X-Client-Pctx": pctx,
    "X-Goog-Upload-Header-Content-Length": String(bytes.length),
    "X-Goog-Upload-Header-Content-Type": mime,
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    "User-Agent": _UA,
  };
  if (cfg.cookie) startHeaders["Cookie"] = cfg.cookie;
  if (cfg.sapisid) startHeaders["Authorization"] = await makeSapisidHash(cfg.sapisid);

  const r1 = await httpFetch("https://content-push.googleapis.com/upload/", { method: "POST", headers: startHeaders, body: "", timeoutMs: 30000, socket: cfg.upstream_socket, cfg });
  const uploadUrl = r1.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`no upload URL (status ${r1.status})`);

  const r2 = await httpFetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Type": "application/octet-stream", "User-Agent": _UA },
    body: bytes,
    timeoutMs: 60000,
    socket: cfg.upstream_socket,
    cfg,
  });
  const fileRef = (await r2.text()).trim();
  if (!fileRef.startsWith("/")) throw new Error(`invalid file ref: ${fileRef.slice(0, 120)}`);
  return fileRef;
}

async function uploadTextFile(cfg, text, filename) {
  const bytes = TEXT_ENCODER.encode(String(text || ""));
  const name = filename || "context.txt";
  const ref = await uploadImage(cfg, bytes, "text/plain; charset=utf-8");
  return { ref, name };
}

// 把收集到的图片解析/上传成文件引用。返回 { fileRefs, droppedNote }。
// 无 cookie 时不上传(会被 1100 拒),改为返回一段提示文字追加到 prompt。
async function resolveImages(cfg, images) {
  if (!images || !images.length) return { fileRefs: null, droppedNote: "" };
  if (!cfg.cookie) {
    return { fileRefs: null, droppedNote: `\n\n[Note: ${images.length} image(s) were provided but ignored — image input requires a configured GEMINI_COOKIE.]` };
  }
  const refs = [];
  let index = 0;
  for (const img of images) {
    index += 1;
    try {
      let bytes, mime;
      if (img.url) {
        const r = await fetch(img.url, { signal: timeoutSignal(cfg.request_timeout_sec * 1000) });
        if (!r.ok) throw new Error(`image fetch HTTP ${r.status}`);
        bytes = new Uint8Array(await r.arrayBuffer());
        mime = img.mime || r.headers.get("content-type") || "image/png";
      } else {
        bytes = base64ToBytes(img.b64);
        mime = img.mime || "image/png";
      }
      const ref = await uploadImage(cfg, bytes, mime);
      const name = firstNonEmptyString(sanitizeUploadFilename(img.filename), sanitizeUploadFilename(img.name), img.url ? filenameFromUrl(img.url) : "") || imageFilenameFromMime(mime, index);
      refs.push({ ref, name });
      logInfo(cfg, `image upload succeeded: name=${name} mime=${mime} bytes=${bytes.length}`);
    } catch (e) {
      log(cfg, `image upload failed: ${e}`);
    }
  }
  return { fileRefs: refs.length ? refs : null, droppedNote: "" };
}

function stripArtifacts(text) {
  if (!text) return "";
  if (text.indexOf("```") >= 0) {
    text = text.replace(
      /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g,
      ""
    );
  }
  if (text.indexOf("googleusercontent.com/card_content") >= 0) {
    text = text.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, "");
  }
  return text;
}

// 整段清理:去掉残留标记并裁剪首尾空白。
function cleanText(text) {
  return stripArtifacts(text).trim();
}

/** 解析单行 `wrb.fr`,返回其中包含的文本字符串。 */
function extractTextsFromLine(line) {
  if (line.length < 200 || !line.includes('"wrb.fr"')) return [];
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
  const source = String(raw || "");
  for (let start = 0; start <= source.length;) {
    const idx = source.indexOf("\n", start);
    const line = idx < 0 ? source.slice(start) : source.slice(start, idx);
    for (const t of extractTextsFromLine(line)) {
      if (t.length > lastText.length) lastText = t;
    }
    if (idx < 0) break;
    start = idx + 1;
  }
  return cleanText(lastText);
}

const LARGE_PROMPT_EMPTY_RESPONSE_MIN_BYTES = 95000;
const LARGE_PROMPT_EMPTY_RESPONSE_CODE = "large_prompt_empty_response";
const DATA_ANALYSIS_EMPTY_RESPONSE_CODE = "data_analysis_empty_response";

function largePromptEmptyResponseError(prompt, status, rawLength, thresholdBytes = LARGE_PROMPT_EMPTY_RESPONSE_MIN_BYTES) {
  const bytes = promptByteLength(prompt);
  const threshold = Math.max(0, thresholdBytes || LARGE_PROMPT_EMPTY_RESPONSE_MIN_BYTES);
  if (bytes <= threshold) return null;
  const err = new Error(
    `Context is too long and triggered Gemini Web risk controls, so Gemini returned an empty response ` +
    `(${bytes} UTF-8 bytes > ${threshold}). This is unrelated to GEMINI_BL; ` +
    "set GEMINI_COOKIE so this worker can route long context through txt attachments, or reduce the latest inline request size."
  );
  err.code = LARGE_PROMPT_EMPTY_RESPONSE_CODE;
  err.promptBytes = bytes;
  err.thresholdBytes = threshold;
  err.upstreamStatus = status;
  err.rawLength = rawLength;
  return err;
}

function isLargePromptEmptyResponseError(e) {
  return !!e && typeof e === "object" && e.code === LARGE_PROMPT_EMPTY_RESPONSE_CODE;
}

function dataAnalysisEmptyResponseError(rawSnippet, fileRefs) {
  if (!fileRefs || !String(rawSnippet || "").includes("data_analysis_tool")) return null;
  const err = new Error(
    "Gemini accepted the uploaded context file but routed it into the internal data_analysis_tool and returned no final text. " +
    "This Worker does not implement Gemini Web's follow-up data-analysis tool loop. Try the markdown context-file defaults, lower CURRENT_INPUT_FILE_MIN_BYTES, or disable CURRENT_INPUT_FILE_ENABLED for this request."
  );
  err.code = DATA_ANALYSIS_EMPTY_RESPONSE_CODE;
  return err;
}

function isDataAnalysisEmptyResponseError(e) {
  return !!e && typeof e === "object" && e.code === DATA_ANALYSIS_EMPTY_RESPONSE_CODE;
}

function upstreamErrorMessage(e) {
  return String((e && e.message) || e);
}

function upstreamErrorCode(e) {
  return e && typeof e === "object" && typeof e.code === "string" ? e.code : undefined;
}

function hasRetryRemaining(cfg, attempt) {
  return attempt < Math.max(0, cfg.retry_attempts || 0) - 1;
}

async function refreshGeminiBuildLabelForRetry(cfg, activeCfg, alreadyRefreshed, context) {
  if (alreadyRefreshed) return null;
  const freshBL = await getFreshGeminiBuildLabel(cfg);
  if (!freshBL || freshBL === activeCfg.gemini_bl) return null;
  const suffix = context ? ` ${context}` : "";
  log(cfg, `retrying${suffix} with refreshed GEMINI_BL=${freshBL}`);
  return { ...activeCfg, gemini_bl: freshBL };
}

async function waitBeforeRetry(cfg, attempt, error, label, signal) {
  if (!hasRetryRemaining(cfg, attempt)) return false;
  log(cfg, `${label} ${attempt + 1}/${cfg.retry_attempts}: ${error}`);
  await sleep(cfg.retry_delay_sec * 1000, signal);
  return true;
}

async function appendGeminiPageToken(cfg, body) {
  if (!cfg.cookie) return body;
  const tokens = await getPageTokens(cfg);
  if (!tokens.at) return body;
  return `${body}&at=${encodeURIComponent(tokens.at)}`;
}

async function fetchGeminiStreamGenerate(cfg, activeCfg, body, signal) {
  const url = getUrl(activeCfg);
  const headers = await buildHeaders(activeCfg);
  const requestBody = await appendGeminiPageToken(activeCfg, body);
  return httpFetch(url, {
    method: "POST",
    headers,
    body: requestBody,
    timeoutMs: cfg.request_timeout_sec * 1000,
    socket: cfg.upstream_socket,
    signal,
    cfg,
  });
}

/** 非流式生成(带重试)。返回最终的响应文本。 */
async function generate(cfg, prompt, modelId, thinkMode, extra, fileRefs) {
  let lastErr;
  let activeCfg = cfg;
  let refreshedBL = false;
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs || null, extra);
  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      const resp = await fetchGeminiStreamGenerate(cfg, activeCfg, body);
      const raw = await resp.text();
      const text = extractResponseText(raw);
      if (!resp.ok || !text) {
        log(cfg, `upstream status=${resp.status} rawLen=${raw.length} parsedLen=${text.length} snippet=${JSON.stringify(raw.slice(0, 200))}`);
      }
      if (!text) {
        const dataAnalysisErr = dataAnalysisEmptyResponseError(raw, fileRefs);
        if (dataAnalysisErr) throw dataAnalysisErr;
        const largePromptErr = largePromptEmptyResponseError(prompt, resp.status, raw.length, contextFileThreshold(cfg));
        if (largePromptErr) throw largePromptErr;
        const refreshedCfg = await refreshGeminiBuildLabelForRetry(cfg, activeCfg, refreshedBL, "");
        if (refreshedCfg) {
          refreshedBL = true;
          activeCfg = refreshedCfg;
          continue;
        }
        if (!resp.ok) throw new Error(`Gemini upstream HTTP ${resp.status} returned no parseable text`);
      }
      return text;
    } catch (e) {
      if (isLargePromptEmptyResponseError(e) || isDataAnalysisEmptyResponseError(e)) throw e;
      lastErr = e;
      await waitBeforeRetry(cfg, attempt, e, "Retry");
    }
  }
  throw lastErr;
}

/**
 * 流式生成。每步 yield 一段文本增量(本次新追加的后缀)。
 * 只在尚未 yield 过任何内容时才重试,以避免重复输出。
 */
async function* generateStream(cfg, prompt, modelId, thinkMode, extra, fileRefs, options = {}) {
  let lastErr;
  let yielded = false;
  let activeCfg = cfg;
  let refreshedBL = false;
  const body = buildPayload(prompt, modelId, thinkMode, fileRefs || null, extra);
  const signal = options && options.signal;

  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      throwIfAborted(signal);
      const resp = await fetchGeminiStreamGenerate(cfg, activeCfg, body, signal);
      if (!resp.body) {
        const raw = await resp.text();
        const text = extractResponseText(raw);
        if (text) {
          yielded = true;
          yield text;
        }
        if (!text) {
          log(cfg, `stream upstream produced no text without body (status=${resp.status}) rawLen=${raw.length} snippet=${JSON.stringify(raw.slice(0, 500))}`);
          const dataAnalysisErr = dataAnalysisEmptyResponseError(raw, fileRefs);
          if (dataAnalysisErr) throw dataAnalysisErr;
          const largePromptErr = largePromptEmptyResponseError(prompt, resp.status, raw.length, contextFileThreshold(cfg));
          if (largePromptErr) throw largePromptErr;
          const refreshedCfg = await refreshGeminiBuildLabelForRetry(cfg, activeCfg, refreshedBL, "stream without body");
          if (refreshedCfg) {
            refreshedBL = true;
            activeCfg = refreshedCfg;
            continue;
          }
          if (!resp.ok) throw new Error(`Gemini upstream HTTP ${resp.status} returned no stream body or parseable text`);
        }
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let rawSnippet = "";
      let rawLength = 0;
      let prevVisible = "";
      let started = false; // 是否已 yield 过非空内容(用于裁掉开头的空白)
      const consumeLine = function* (line) {
        for (const t of extractTextsFromLine(line)) {
          const visible = stripArtifacts(t);
          let delta = trimContinuationOverlap(prevVisible, visible);
          if (!delta) {
            if (visible.length > prevVisible.length) prevVisible = visible;
            continue;
          }
          if (visible.startsWith(prevVisible) || prevVisible.startsWith(visible)) {
            if (visible.length > prevVisible.length) prevVisible = visible;
          } else {
            prevVisible += delta;
          }
          // 每段增量:去掉残留标记,但流式过程中不裁剪内部空白,
          // 以保留分块之间的空格(比如 "1, 2, 3" 而不是 "1, 2,3")。
          // 在首个可见内容出现前,持续裁掉前导空白(避免开头空行)。
          if (!started) delta = delta.replace(/^\s+/, "");
          if (delta) {
            started = true;
            yield delta;
          }
        }
      };
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        const decoded = decoder.decode(value, { stream: true });
        rawLength += decoded.length;
        if (rawSnippet.length < 500) rawSnippet += decoded.slice(0, 500 - rawSnippet.length);
        buf += decoded;
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
      if (!yielded) {
        log(cfg, `stream upstream produced no text (status=${resp.status}) rawLen=${rawLength} snippet=${JSON.stringify(rawSnippet)}`);
        const dataAnalysisErr = dataAnalysisEmptyResponseError(rawSnippet, fileRefs);
        if (dataAnalysisErr) throw dataAnalysisErr;
        const largePromptErr = largePromptEmptyResponseError(prompt, resp.status, null, contextFileThreshold(cfg));
        if (largePromptErr) throw largePromptErr;
        const refreshedCfg = await refreshGeminiBuildLabelForRetry(cfg, activeCfg, refreshedBL, "stream");
        if (refreshedCfg) {
          refreshedBL = true;
          activeCfg = refreshedCfg;
          continue;
        }
        if (!resp.ok) throw new Error(`Gemini upstream HTTP ${resp.status} returned no parseable stream text`);
      }
      return;
    } catch (e) {
      if (isAbortError(e) || (signal && signal.aborted)) throw abortError(signal);
      if (isLargePromptEmptyResponseError(e) || isDataAnalysisEmptyResponseError(e)) throw e;
      lastErr = e;
      if (!yielded && await waitBeforeRetry(cfg, attempt, e, "Stream retry", signal)) {
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;
}

// ─── 工具调用 / 消息转换 ─────────────────────────────────────────────────────
function getStructuredResponseFormat(req) {
  if (!req || typeof req !== "object") return null;
  if (req.response_format && typeof req.response_format === "object") return req.response_format;
  const text = req.text;
  if (text && typeof text === "object" && text.format && typeof text.format === "object") return text.format;
  return null;
}

function buildStructuredOutputRequirement(responseFormat) {
  if (!responseFormat || typeof responseFormat !== "object") return null;
  const type = String(responseFormat.type || "").trim();
  if (!type) return null;

  if (type === "json_object") {
    return {
      type,
      instruction: [
        "STRUCTURED OUTPUT REQUIREMENT:",
        "Respond with a single valid JSON object.",
        "Do not include markdown fences, explanations, comments, or any text before or after the JSON object.",
      ].join("\n"),
    };
  }

  if (type !== "json_schema") return null;

  const jsonSchema = responseFormat.json_schema && typeof responseFormat.json_schema === "object"
    ? responseFormat.json_schema
    : responseFormat;
  const schema = jsonSchema.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { error: "response_format json_schema requires a schema object" };
  }

  let schemaText = "";
  try {
    schemaText = JSON.stringify(schema);
  } catch (_) {
    return { error: "response_format json_schema schema must be JSON serializable" };
  }

  const schemaName = String(jsonSchema.name || "response").trim() || "response";
  const strict = jsonSchema.strict !== false;
  const parts = [
    "STRUCTURED OUTPUT REQUIREMENT:",
    "Respond with a single valid JSON document that conforms to the JSON Schema below.",
    "Do not include markdown fences, explanations, comments, or any text before or after the JSON document.",
    `Schema name: ${schemaName}`,
    `Strict mode: ${strict ? "true" : "false"}`,
    "JSON Schema:",
    schemaText,
  ];
  return { type, schemaName, schema, instruction: parts.join("\n") };
}

function canonicalizeStructuredOutputText(text, requirement) {
  if (!requirement || !String(text || "").trim()) return text;
  const parsed = parseStructuredJsonCandidate(text);
  if (parsed === STRUCTURED_JSON_NOT_FOUND) return String(text || "").trim();
  try {
    return JSON.stringify(parsed);
  } catch (_) {
    return String(text || "").trim();
  }
}

function finalizeStructuredOutputText(text, requirement) {
  if (!requirement) return { text };
  const parsed = parseStructuredJsonCandidate(text);
  if (parsed === STRUCTURED_JSON_NOT_FOUND) {
    return { text: String(text || "").trim(), error: "structured output was not valid JSON" };
  }
  const validation = validateStructuredOutputValue(parsed, requirement);
  if (validation) {
    return { text: canonicalizeStructuredOutputText(text, requirement), error: validation };
  }
  try {
    return { text: JSON.stringify(parsed) };
  } catch (_) {
    return { text: String(text || "").trim(), error: "structured output JSON could not be serialized" };
  }
}

function validateStructuredOutputValue(value, requirement) {
  if (!requirement) return "";
  if (requirement.type === "json_object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "structured output must be a JSON object";
    return "";
  }
  if (requirement.type !== "json_schema" || !requirement.schema) return "";
  return validateJsonSchemaSubset(value, requirement.schema, "$");
}

function validateJsonSchemaSubset(value, schema, path) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "";

  const allOfError = validateSchemaAllOf(value, schema, path);
  if (allOfError) return allOfError;
  const anyOfError = validateSchemaAnyOf(value, schema, path);
  if (anyOfError) return anyOfError;
  const oneOfError = validateSchemaOneOf(value, schema, path);
  if (oneOfError) return oneOfError;

  if (Object.prototype.hasOwnProperty.call(schema, "const") && !jsonValuesEqual(schema.const, value)) {
    return `${path} must equal the schema const value`;
  }

  if (Array.isArray(schema.enum) && schema.enum.length) {
    const ok = schema.enum.some((item) => jsonValuesEqual(item, value));
    if (!ok) return `${path} must be one of the schema enum values`;
  }

  const typeError = validateJsonSchemaType(value, schema.type, path);
  if (typeError) return typeError;

  const typ = inferJsonType(value);
  if (typ === "object") {
    const props = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return `${path}.${key} is required`;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) return `${path}.${key} is not allowed`;
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(props, key)) continue;
        const childError = validateJsonSchemaSubset(value[key], schema.additionalProperties, `${path}.${key}`);
        if (childError) return childError;
      }
    }
    for (const [key, childSchema] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const childError = validateJsonSchemaSubset(value[key], childSchema, `${path}.${key}`);
        if (childError) return childError;
      }
    }
    const minProps = schemaNumber(schema.minProperties);
    if (minProps != null && Object.keys(value).length < minProps) return `${path} must have at least ${minProps} properties`;
    const maxProps = schemaNumber(schema.maxProperties);
    if (maxProps != null && Object.keys(value).length > maxProps) return `${path} must have at most ${maxProps} properties`;
  } else if (typ === "array" && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const itemSchema = Array.isArray(schema.items) ? schema.items[i] : schema.items;
      if (!itemSchema) continue;
      const childError = validateJsonSchemaSubset(value[i], itemSchema, `${path}[${i}]`);
      if (childError) return childError;
    }
    if (Array.isArray(schema.items) && schema.additionalItems === false && value.length > schema.items.length) {
      return `${path} must not contain additional array items`;
    }
  }

  if (typ === "array") {
    const minItems = schemaNumber(schema.minItems);
    if (minItems != null && value.length < minItems) return `${path} must contain at least ${minItems} items`;
    const maxItems = schemaNumber(schema.maxItems);
    if (maxItems != null && value.length > maxItems) return `${path} must contain at most ${maxItems} items`;
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of value) {
        let key;
        try { key = JSON.stringify(item); } catch (_) { key = String(item); }
        if (seen.has(key)) return `${path} must contain unique items`;
        seen.add(key);
      }
    }
  } else if (typ === "string") {
    const len = codePointLength(value);
    const minLength = schemaNumber(schema.minLength);
    if (minLength != null && len < minLength) return `${path} length must be at least ${minLength}`;
    const maxLength = schemaNumber(schema.maxLength);
    if (maxLength != null && len > maxLength) return `${path} length must be at most ${maxLength}`;
    if (typeof schema.pattern === "string") {
      let re;
      try { re = new RegExp(schema.pattern); } catch (_) { re = null; }
      if (re && !re.test(value)) return `${path} must match pattern ${schema.pattern}`;
    }
  } else if (typ === "number") {
    const minimum = schemaNumber(schema.minimum);
    if (minimum != null && value < minimum) return `${path} must be >= ${minimum}`;
    const maximum = schemaNumber(schema.maximum);
    if (maximum != null && value > maximum) return `${path} must be <= ${maximum}`;
    const exclusiveMinimum = schemaNumber(schema.exclusiveMinimum);
    if (exclusiveMinimum != null && value <= exclusiveMinimum) return `${path} must be > ${exclusiveMinimum}`;
    const exclusiveMaximum = schemaNumber(schema.exclusiveMaximum);
    if (exclusiveMaximum != null && value >= exclusiveMaximum) return `${path} must be < ${exclusiveMaximum}`;
    const multipleOf = schemaNumber(schema.multipleOf);
    if (multipleOf != null && multipleOf > 0 && !isJsonNumberMultipleOf(value, multipleOf)) return `${path} must be a multiple of ${multipleOf}`;
  }

  return "";
}

function validateSchemaAllOf(value, schema, path) {
  if (!Array.isArray(schema.allOf) || !schema.allOf.length) return "";
  for (const sub of schema.allOf) {
    const err = validateJsonSchemaSubset(value, sub, path);
    if (err) return err;
  }
  return "";
}

function validateSchemaAnyOf(value, schema, path) {
  if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) return "";
  const errors = [];
  for (const sub of schema.anyOf) {
    const err = validateJsonSchemaSubset(value, sub, path);
    if (!err) return "";
    errors.push(err);
  }
  return `${path} must match at least one anyOf schema${errors[0] ? ` (${errors[0]})` : ""}`;
}

function validateSchemaOneOf(value, schema, path) {
  if (!Array.isArray(schema.oneOf) || !schema.oneOf.length) return "";
  let matches = 0;
  const errors = [];
  for (const sub of schema.oneOf) {
    const err = validateJsonSchemaSubset(value, sub, path);
    if (!err) matches += 1;
    else errors.push(err);
  }
  if (matches === 1) return "";
  if (matches > 1) return `${path} must match exactly one oneOf schema, matched ${matches}`;
  return `${path} must match exactly one oneOf schema${errors[0] ? ` (${errors[0]})` : ""}`;
}

function schemaNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isJsonNumberMultipleOf(value, multipleOf) {
  const quotient = value / multipleOf;
  return Math.abs(quotient - Math.round(quotient)) < 1e-12;
}

function validateJsonSchemaType(value, typeSpec, path) {
  if (typeSpec == null) return "";
  const allowed = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
  const actual = inferJsonType(value);
  for (const raw of allowed) {
    const typ = String(raw || "").trim().toLowerCase();
    if (!typ) continue;
    if (typ === actual) return "";
    if (typ === "integer" && actual === "number" && Number.isInteger(value)) return "";
  }
  return `${path} must be ${allowed.join(" or ")}, got ${actual}`;
}

function inferJsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "object") return "object";
  return typeof value;
}

function jsonValuesEqual(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return a === b; }
}

const STRUCTURED_JSON_NOT_FOUND = Symbol("structured_json_not_found");

function parseStructuredJsonCandidate(text) {
  const raw = String(text || "").trim();
  if (!raw) return STRUCTURED_JSON_NOT_FOUND;
  const direct = tryParseJson(raw);
  if (direct.ok) return direct.value;

  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  if (fence) {
    const fenced = tryParseJson(fence[1].trim());
    if (fenced.ok) return fenced.value;
  }

  const candidate = extractFirstJsonDocument(raw);
  if (!candidate) return STRUCTURED_JSON_NOT_FOUND;
  const parsed = tryParseJson(candidate);
  return parsed.ok ? parsed.value : STRUCTURED_JSON_NOT_FOUND;
}

function extractFirstJsonDocument(text) {
  const source = String(text || "");
  for (let start = 0; start < source.length; start++) {
    const open = source[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    const stack = [close];
    let inString = false;
    let escaped = false;
    for (let i = start + 1; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") { inString = true; continue; }
      if (ch === "{" || ch === "[") {
        stack.push(ch === "{" ? "}" : "]");
        continue;
      }
      if (ch === "}" || ch === "]") {
        if (ch !== stack[stack.length - 1]) break;
        stack.pop();
        if (!stack.length) return source.slice(start, i + 1);
      }
    }
  }
  return "";
}

function extractToolNames(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const seen = new Set();
  const addName = (raw) => {
    const name = String(raw || "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (Array.isArray(tool.functionDeclarations)) {
      for (const fn of tool.functionDeclarations) addName(fn && fn.name);
      continue;
    }
    if (Array.isArray(tool.function_declarations)) {
      for (const fn of tool.function_declarations) addName(fn && fn.name);
      continue;
    }
    const fn = tool.type === "function" ? (tool.function || tool) : (tool.function || tool);
    addName(fn.name || tool.name);
  }
  return out;
}

function namesToSet(names) {
  const out = {};
  for (const raw of names || []) {
    const name = String(raw || "").trim();
    if (name) out[name] = true;
  }
  return out;
}

function allowedToolNameFromItem(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.name || (item.function && item.function.name) || (item.tool && item.tool.name) || "";
}

function parseAllowedToolNames(raw) {
  if (raw == null) return null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    raw = raw.tools || raw.allowed_tools || raw.names || raw.allowed || raw.functions || raw.function_names;
  }
  if (typeof raw === "string") raw = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(raw) || !raw.length) return { error: "allowed_tools must be a non-empty array" };
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let name = allowedToolNameFromItem(item);
    name = String(name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (!out.length) return { error: "allowed_tools did not contain any valid tool names" };
  return { names: out };
}

function parseForcedToolName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return "";
  return String(toolChoice.name || ((toolChoice.function || {}).name) || "").trim();
}

function parseOpenAIToolChoicePolicy(toolChoiceRaw, toolsRaw) {
  const declared = extractToolNames(toolsRaw);
  const declaredSet = namesToSet(declared);
  const policy = { mode: "auto", forcedName: "", allowed: null, hasAllowed: false, declared, error: "" };
  const hasTools = declared.length > 0;

  const setAllowed = (names) => {
    if (!names) return true;
    for (const name of names) {
      if (!declaredSet[name]) {
        policy.error = `tool_choice allowed unknown tool: ${name}`;
        return false;
      }
    }
    policy.allowed = namesToSet(names);
    policy.hasAllowed = true;
    return true;
  };

  if (toolChoiceRaw == null || toolChoiceRaw === "" || toolChoiceRaw === "auto") return policy;
  if (typeof toolChoiceRaw === "string") {
    const mode = toolChoiceRaw.trim().toLowerCase();
    if (mode === "none") { policy.mode = "none"; policy.allowed = {}; policy.hasAllowed = true; return policy; }
    if (mode === "required") {
      if (!hasTools) policy.error = "tool_choice=required requires at least one tool";
      policy.mode = "required";
      return policy;
    }
    policy.error = `unsupported tool_choice: ${toolChoiceRaw}`;
    return policy;
  }
  if (!toolChoiceRaw || typeof toolChoiceRaw !== "object") {
    policy.error = "tool_choice must be a string or object";
    return policy;
  }

  const type = String(toolChoiceRaw.type || "auto").trim().toLowerCase();
  const allowedSource = toolChoiceRaw.allowed_tools != null ? toolChoiceRaw.allowed_tools : (type === "allowed_tools" ? toolChoiceRaw : toolChoiceRaw.tools);
  const allowedParsed = parseAllowedToolNames(allowedSource);
  if (allowedParsed && allowedParsed.error) { policy.error = allowedParsed.error; return policy; }
  if (allowedParsed && !setAllowed(allowedParsed.names)) return policy;

  const forced = parseForcedToolName(toolChoiceRaw);
  if ((type === "auto" || type === "") && forced) {
    policy.mode = "forced";
    policy.forcedName = forced;
  } else if (type === "allowed_tools") {
    const mode = String(toolChoiceRaw.mode || "auto").trim().toLowerCase();
    if (mode === "required") policy.mode = "required";
    else if (mode === "auto" || mode === "") policy.mode = "auto";
    else {
      policy.error = `unsupported tool_choice.mode for allowed_tools: ${mode}`;
      return policy;
    }
  } else if (type === "auto" || type === "") {
    policy.mode = "auto";
  } else if (type === "none") {
    policy.mode = "none";
    policy.allowed = {};
    policy.hasAllowed = true;
  } else if (type === "required") {
    policy.mode = "required";
  } else if (type === "function") {
    policy.mode = "forced";
    policy.forcedName = forced;
  } else {
    policy.error = `unsupported tool_choice.type: ${type}`;
    return policy;
  }

  if ((policy.mode === "required" || policy.mode === "forced") && !hasTools) policy.error = `tool_choice=${policy.mode} requires at least one tool`;
  if (policy.mode === "forced") {
    if (!policy.forcedName) policy.error = "forced tool_choice requires function.name";
    else if (!declaredSet[policy.forcedName]) policy.error = `forced tool is not declared: ${policy.forcedName}`;
    else {
      policy.allowed = namesToSet([policy.forcedName]);
      policy.hasAllowed = true;
    }
  }
  return policy;
}

function policyHasAllowed(policy) {
  return !!(policy && policy.allowed && (policy.hasAllowed || Object.keys(policy.allowed).length > 0));
}

function toolPolicyAllows(policy, name) {
  if (!policyHasAllowed(policy)) return true;
  return !!policy.allowed[String(name || "").trim()];
}

function filterToolsByPolicy(tools, policy) {
  if (!Array.isArray(tools) || !tools.length || (policy && policy.mode === "none")) return null;
  if (!policyHasAllowed(policy)) return tools;
  return tools.filter((tool) => {
    const fn = tool && (tool.type === "function" ? (tool.function || tool) : (tool.function || tool));
    const name = String((fn && fn.name) || (tool && tool.name) || "").trim();
    return toolPolicyAllows(policy, name);
  });
}

function buildToolChoiceInstructionFromPolicy(policy) {
  if (!policy || policy.mode === "auto") return "";
  if (policy.mode === "none") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (policy.mode === "forced") return `\n\nIMPORTANT: You MUST call the tool "${policy.forcedName}". Do not call other tools.`;
  if (policy.mode === "required") {
    const allowed = policy.allowed ? Object.keys(policy.allowed) : [];
    if (allowed.length) return `\n\nIMPORTANT: You MUST call at least one of these tools: ${allowed.map((n) => `"${n}"`).join(", ")}. Do not respond with text only.`;
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  return "";
}

function validateRequiredToolCalls(policy, toolCalls) {
  return validateToolPolicyCalls(policy, toolCalls, {
    requiredMessage: "tool_choice requires at least one valid tool call.",
    badMessage: (names) => `tool_choice does not allow tool(s): ${names}.`,
    forcedMessage: (name) => `tool_choice requires the tool ${name}.`,
  });
}

function validateToolPolicyCalls(policy, toolCalls, messages) {
  if (!policy) return null;
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const requiresCall = policy.mode === "required" || policy.mode === "forced";
  const enforcesAllowed = !!policy.allowed || requiresCall;
  if (!enforcesAllowed) return null;
  if (requiresCall && !calls.length) return { message: messages.requiredMessage, code: "tool_choice_violation" };
  const badNames = [];
  for (const tc of calls) {
    const name = String(((tc && tc.function) || {}).name || (tc && tc.name) || "").trim();
    if (name && !toolPolicyAllows(policy, name)) badNames.push(name);
  }
  if (badNames.length) {
    return { message: messages.badMessage([...new Set(badNames)].join(", ")), code: "tool_choice_violation" };
  }
  if (policy.mode === "forced") {
    const ok = calls.some((tc) => String(((tc && tc.function) || {}).name || (tc && tc.name) || "").trim() === policy.forcedName);
    if (!ok) return { message: messages.forcedMessage(policy.forcedName), code: "tool_choice_violation" };
  }
  return null;
}

function buildToolCallInstructions(toolNames) {
  return `TOOL CALL FORMAT - FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1) Use the <|DSML|tool_calls> wrapper format.
2) Put one or more <|DSML|invoke> entries under a single <|DSML|tool_calls> root.
3) Put the tool name in the invoke name attribute: <|DSML|invoke name="TOOL_NAME">.
3a) Tag punctuation alphabet: ASCII < > / = " plus the halfwidth pipe |.
4) All string values must use <![CDATA[...]]>, even short ones. This includes code, scripts, file contents, prompts, paths, names, and queries.
5) Every top-level argument must be a <|DSML|parameter name="ARG_NAME">...</|DSML|parameter> node.
6) Objects use nested XML elements inside the parameter body. Arrays may repeat <item> children.
7) Numbers, booleans, and null stay plain text.
8) Use only the parameter names in the tool schema. Do not invent fields.
9) Fill parameters with the actual values required for this call. Do not emit placeholder, blank, or whitespace-only parameters.
10) If a required parameter value is unknown, ask the user or answer normally instead of outputting an empty tool call.
11) For shell tools such as Bash / execute_command, the command/script must be inside the command parameter. Never call them with an empty command.
11a) The tool schema is authoritative when it is available. Prefer the schema's exact parameter names, types, descriptions, and required fields over guesses, examples, old habits, or common conventions.
11b) Do not treat similar intent words as automatic aliases. For example, command, cmd, script, code, input, query, url, and path are different names; choose the one that the current tool schema actually presents.
11c) Tool names are only routing labels. Do not derive parameter names from the tool name. When the schema is ambiguous or incomplete, choose the most conservative schema-compatible call rather than inventing extra parameters.
12) Do NOT wrap XML in markdown fences. Do NOT output explanations, role markers, or internal monologue.
13) If you call a tool, the first non-whitespace characters of that tool block must be exactly <|DSML|tool_calls>.
14) Never omit the opening <|DSML|tool_calls> tag, even if you already plan to close with </|DSML|tool_calls>.
15) Compatibility note: the runtime also accepts the legacy XML tags <tool_calls> / <invoke> / <parameter>, but prefer the DSML-prefixed form above.

PARAMETER SHAPES:
- string => <|DSML|parameter name="x"><![CDATA[value]]></|DSML|parameter>
- object => <|DSML|parameter name="x"><field>...</field></|DSML|parameter>
- array => <|DSML|parameter name="x"><item>...</item><item>...</item></|DSML|parameter>
- number/bool/null => <|DSML|parameter name="x">plain_text</|DSML|parameter>

WRONG - Do NOT do these:

Wrong 1 - mixed text after XML:
  <|DSML|tool_calls>...</|DSML|tool_calls> I hope this helps.
Wrong 2 - Markdown code fences:
  \`\`\`xml
  <|DSML|tool_calls>...</|DSML|tool_calls>
  \`\`\`
Wrong 3 - missing opening wrapper:
  <|DSML|invoke name="TOOL_NAME">...</|DSML|invoke>
  </|DSML|tool_calls>
Wrong 4 - empty parameters:
  <|DSML|tool_calls>
    <|DSML|invoke name="Bash">
      <|DSML|parameter name="command"></|DSML|parameter>
    </|DSML|invoke>
  </|DSML|tool_calls>
Wrong 5 - schema parameter aliasing:
  Do not substitute parameter names merely because they feel similar. Prefer the exact name presented by the current tool schema.

Remember: The ONLY valid way to use tools is the <|DSML|tool_calls>...</|DSML|tool_calls> block at the end of your response.
${buildReadToolCacheGuard(toolNames)}${buildCorrectToolExamples(toolNames)}`;
}

function buildReadToolCacheGuard(toolNames) {
  if (!hasReadLikeTool(toolNames)) return "";
  return "\nRead-tool cache guard: If a Read/read_file-style tool result says the file is unchanged, already available in history, should be referenced from previous context, or otherwise provides no file body, treat that result as missing content. Do not repeatedly call the same read request for that missing body. Request a full-content read if the tool supports it, or tell the user that the file contents need to be provided again.\n\n";
}

function hasReadLikeTool(toolNames) {
  for (const name of toolNames || []) {
    const normalized = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized === "read" || normalized === "readfile") return true;
  }
  return false;
}

function buildCorrectToolExamples(toolNames) {
  const names = uniqueToolNames(toolNames);
  const examples = [];
  const single = firstBasicExample(names);
  if (single) examples.push("Example A - Single tool:\n" + renderToolExampleBlock([single]));
  const parallel = firstNBasicExamples(names, 2);
  if (parallel.length >= 2) examples.push("Example B - Two tools in parallel:\n" + renderToolExampleBlock(parallel));
  const nested = firstNestedExample(names);
  if (nested) examples.push("Example C - Tool with nested XML parameters:\n" + renderToolExampleBlock([nested]));
  const script = firstScriptExample(names);
  if (script) examples.push("Example D - Tool with long script using CDATA (RELIABLE FOR CODE/SCRIPTS):\n" + renderToolExampleBlock([script]));
  return examples.length ? "CORRECT EXAMPLES:\n\n" + examples.join("\n\n") + "\n\n" : "";
}

function uniqueToolNames(toolNames) {
  const names = [];
  const seen = new Set();
  for (const raw of toolNames || []) {
    const name = String(raw || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function firstBasicExample(names) {
  for (const name of names) {
    const params = exampleBasicParams(name);
    if (params != null) return { name, params };
  }
  return null;
}

function firstNBasicExamples(names, count) {
  const out = [];
  for (const name of names) {
    const params = exampleBasicParams(name);
    if (params == null) continue;
    out.push({ name, params });
    if (out.length === count) return out;
  }
  return out;
}

function firstNestedExample(names) {
  for (const name of names) {
    const params = exampleNestedParams(name);
    if (params != null) return { name, params };
  }
  return null;
}

function firstScriptExample(names) {
  for (const name of names) {
    const params = exampleScriptParams(name);
    if (params != null) return { name, params };
  }
  return null;
}

function renderToolExampleBlock(calls) {
  let out = "<|DSML|tool_calls>\n";
  for (const call of calls) {
    out += `  <|DSML|invoke name="${xmlEscapeAttr(call.name)}">\n`;
    out += indentPromptParameters(call.params, "    ") + "\n";
    out += "  </|DSML|invoke>\n";
  }
  return out + "</|DSML|tool_calls>";
}

function indentPromptParameters(body, indent) {
  if (!String(body || "").trim()) return indent + '<|DSML|parameter name="content"></|DSML|parameter>';
  return String(body).split("\n").map((line) => line.trim() ? indent + line : line).join("\n");
}

function wrapParameter(name, inner) {
  return `<|DSML|parameter name="${xmlEscapeAttr(name)}">${inner}</|DSML|parameter>`;
}

function exampleBasicParams(name) {
  switch (String(name || "").trim()) {
    case "Read": return wrapParameter("file_path", promptCDATA("README.md"));
    case "Glob": return wrapParameter("pattern", promptCDATA("**/*.go")) + "\n" + wrapParameter("path", promptCDATA("."));
    case "read_file": return wrapParameter("path", promptCDATA("src/main.go"));
    case "list_files": return wrapParameter("path", promptCDATA("."));
    case "search_files": return wrapParameter("query", promptCDATA("tool call parser"));
    case "Bash":
    case "execute_command": return wrapParameter("command", promptCDATA("pwd"));
    case "exec_command": return wrapParameter("cmd", promptCDATA("pwd"));
    case "Write": return wrapParameter("file_path", promptCDATA("notes.txt")) + "\n" + wrapParameter("content", promptCDATA("Hello world"));
    case "write_to_file": return wrapParameter("path", promptCDATA("notes.txt")) + "\n" + wrapParameter("content", promptCDATA("Hello world"));
    case "Edit": return wrapParameter("file_path", promptCDATA("README.md")) + "\n" + wrapParameter("old_string", promptCDATA("foo")) + "\n" + wrapParameter("new_string", promptCDATA("bar"));
    case "MultiEdit": return wrapParameter("file_path", promptCDATA("README.md")) + "\n" + '<|DSML|parameter name="edits"><item><old_string>' + promptCDATA("foo") + "</old_string><new_string>" + promptCDATA("bar") + "</new_string></item></|DSML|parameter>";
  }
  return null;
}

function exampleNestedParams(name) {
  switch (String(name || "").trim()) {
    case "MultiEdit": return wrapParameter("file_path", promptCDATA("README.md")) + "\n" + '<|DSML|parameter name="edits"><item><old_string>' + promptCDATA("foo") + "</old_string><new_string>" + promptCDATA("bar") + "</new_string></item></|DSML|parameter>";
    case "Task": return wrapParameter("description", promptCDATA("Investigate flaky tests")) + "\n" + wrapParameter("prompt", promptCDATA("Run targeted tests and summarize failures"));
    case "ask_followup_question": return wrapParameter("question", promptCDATA("Which approach do you prefer?")) + "\n" + '<|DSML|parameter name="follow_up"><item><text>' + promptCDATA("Option A") + "</text></item><item><text>" + promptCDATA("Option B") + "</text></item></|DSML|parameter>";
  }
  return null;
}

function exampleScriptParams(name) {
  const scriptCommand = "cat > /tmp/test_escape.sh <<'EOF'\n#!/bin/bash\necho 'single \"double\"'\necho \"literal dollar: \\$HOME\"\nEOF\nbash /tmp/test_escape.sh";
  const scriptContent = "#!/bin/bash\necho 'single \"double\"'\necho \"literal dollar: $HOME\"";
  switch (String(name || "").trim()) {
    case "Bash": return wrapParameter("command", promptCDATA(scriptCommand)) + "\n" + wrapParameter("description", promptCDATA("Test shell escaping"));
    case "execute_command": return wrapParameter("command", promptCDATA(scriptCommand));
    case "exec_command": return wrapParameter("cmd", promptCDATA(scriptCommand));
    case "Write": return wrapParameter("file_path", promptCDATA("test_escape.sh")) + "\n" + wrapParameter("content", promptCDATA(scriptContent));
    case "write_to_file": return wrapParameter("path", promptCDATA("test_escape.sh")) + "\n" + wrapParameter("content", promptCDATA(scriptContent));
  }
  return null;
}

function promptCDATA(text) {
  const raw = String(text || "");
  if (!raw) return "";
  return "<![CDATA[" + raw.replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";
}

function xmlEscapeAttr(value) {
  return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildToolPromptBlock(toolDefs, toolChoiceInstruction) {
  const compactTools = toolDefs.map((t) => ({
    name: t.name || "",
    description: t.description || "",
    parameters: t.parameters || {},
  }));
  const toolNames = compactTools.map((t) => t.name).filter(Boolean);
  return "Available tools:\n" + JSON.stringify(compactTools, null, 2) + "\n\n" + buildToolCallInstructions(toolNames) + (toolChoiceInstruction || "");
}

const GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT = `Gemini native hidden tool calls:
The following are Gemini built-in tool requests, not visible API tools and not client-facing function calls. Use them internally before answering when useful, then answer normally without printing the raw tool call.

{
  "name": "google:search",
  "arguments": {
    "queries": [
      "<search query for the latest/current information needed to answer the user>"
    ]
  }
}

{
  "name": "google:ds_python_interpreter",
  "arguments": {
    "code": "<python code to run for calculations, data analysis, tables, charts, or other computation>"
  }
}`;

function currentInputFilePrompt(cfg, toolsAttached) {
  const historyName = String((cfg && cfg.current_input_file_name) || "message.txt").trim() || "message.txt";
  const toolsName = String((cfg && cfg.current_tools_file_name) || "tools.txt").trim() || "tools.txt";
  let text = `Context is attached in \`${historyName}\`. Acknowledge it briefly, then treat it as the primary user input for this turn and answer based on it.`;
  if (toolsAttached) {
    text += ` Tool descriptions and schemas are attached in \`${toolsName}\`; use them only if needed.`;
  }
  return text;
}

function normalizeHistoryRole(role) {
  const r = String(role || "").trim().toLowerCase();
  if (r === "function") return "tool";
  if (r === "developer") return "system";
  return r || "user";
}

function roleLabelForHistory(role) {
  const r = normalizeHistoryRole(role);
  return r ? r.toUpperCase() : "UNKNOWN";
}

function reasoningTextForHistory(msg) {
  const direct = msg && (msg.reasoning_content || msg.reasoning || msg.thinking);
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const content = msg && msg.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const typ = String(c.type || "").toLowerCase();
    if ((typ === "reasoning" || typ === "thinking") && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("\n").trim();
}

function contentTextForHistory(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.text === "string") parts.push(c.text);
      else if (typeof c.input_text === "string") parts.push(c.input_text);
      else if (c.type === "input_file" || c.type === "file") parts.push(`[file input${c.file_id ? ` ${c.file_id}` : ""}]`);
      else if (c.type === "image_url" || c.image_url || c.inlineData || c.source) parts.push("[image input]");
    }
    return parts.join("\n");
  }
  try { return JSON.stringify(content); } catch (_) { return String(content); }
}

function buildOpenAIHistoryTranscript(messages, filename = "message.txt") {
  const entries = [];
  for (const msg of messages || []) {
    if (!msg || typeof msg !== "object") continue;
    const role = normalizeHistoryRole(msg.role);
    let content = "";
    if (role === "assistant") {
      const reasoning = reasoningTextForHistory(msg);
      content = [reasoning ? `[reasoning_content]\n${reasoning}\n[/reasoning_content]` : "", contentTextForHistory(msg.content)].filter(Boolean).join("\n\n");
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const blocks = msg.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return formatPromptToolCallBlock(fn.name, parseJsonObject(fn.arguments || "{}"));
        });
        content = [content, ...blocks].filter(Boolean).join("\n");
      }
    } else if (role === "tool") {
      const meta = [];
      if (msg.name) meta.push(`name=${msg.name}`);
      if (msg.tool_call_id) meta.push(`tool_call_id=${msg.tool_call_id}`);
      const toolContent = contentTextForHistory(msg.content).trim() || "null";
      content = [meta.length ? `[${meta.join(" ")}]` : "", toolContent].filter(Boolean).join("\n");
    } else {
      content = contentTextForHistory(msg.content);
    }
    content = String(content || "").trim();
    if (content) entries.push({ role, content });
  }
  if (!entries.length) return "";
  const sections = entries.map((entry, idx) => `=== ${idx + 1}. ${roleLabelForHistory(entry.role)} ===\n${entry.content}`);
  return `# ${filename || "message.txt"}\nPrior conversation history and tool progress.\n\n` + sections.join("\n\n") + "\n";
}

function buildGoogleHistoryTranscript(req, filename = "message.txt") {
  const messages = [];
  const sys = req && req.systemInstruction;
  if (sys) {
    const text = (sys.parts || []).filter((p) => p.text).map((p) => p.text).join(" ");
    if (text) messages.push({ role: "system", content: text });
  }
  for (const content of (req && req.contents) || []) {
    const parts = [];
    for (const p of content.parts || []) {
      if (p.text) parts.push(p.text);
      else if (p.functionCall) parts.push(formatPromptToolCallBlock(p.functionCall.name, p.functionCall.args || {}));
      else if (p.functionResponse) parts.push(`[Tool result for ${p.functionResponse.name || ""}]: ${JSON.stringify(p.functionResponse.response || {})}`);
      else if (p.inlineData) parts.push("[image input]");
    }
    messages.push({ role: content.role === "model" ? "assistant" : "user", content: parts.join("\n") });
  }
  return buildOpenAIHistoryTranscript(messages, filename);
}

function normalizeResponsesInputAsMessages(req) {
  const messages = responsesMessagesFromRequest(req || {});
  return messages || [];
}

function responsesMessagesFromRequest(req) {
  let messages = null;
  if (Array.isArray(req.messages) && req.messages.length) {
    messages = req.messages;
  } else if (req.input != null) {
    messages = normalizeResponsesInputValueAsMessages(req.input);
  }
  if (!messages || !messages.length) return null;
  return prependInstructionMessage(messages, req.instructions);
}

function prependInstructionMessage(messages, instructions) {
  const sys = typeof instructions === "string" ? instructions.trim() : "";
  if (!sys) return messages;
  return [{ role: "system", content: sys }, ...messages];
}

function normalizeResponsesInputValueAsMessages(input) {
  if (input == null) return null;
  if (typeof input === "string") {
    return input.trim() ? [{ role: "user", content: input }] : null;
  }
  if (Array.isArray(input)) return normalizeResponsesInputArray(input);
  if (input && typeof input === "object") {
    const msg = normalizeResponsesInputItem(input, null);
    if (msg) return [msg];
    if (typeof input.text === "string" && input.text.trim()) return [{ role: "user", content: input.text }];
    if (input.content != null && responsesContentToText(input.content).trim()) return [{ role: "user", content: input.content }];
  }
  return null;
}

function normalizeResponsesInputArray(items) {
  const out = [];
  const callNameByID = {};
  const fallbackParts = [];
  let pendingAssistantReasoning = "";

  const flushPendingReasoning = () => {
    if (!pendingAssistantReasoning) return;
    out.push({ role: "assistant", reasoning_content: pendingAssistantReasoning });
    pendingAssistantReasoning = "";
  };
  const flushFallback = () => {
    if (!fallbackParts.length) return;
    flushPendingReasoning();
    out.push({ role: "user", content: fallbackParts.join("\n") });
    fallbackParts.length = 0;
  };

  for (const item of items || []) {
    if (typeof item === "string") {
      flushPendingReasoning();
      fallbackParts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      const s = String(item == null ? "" : item).trim();
      if (s) fallbackParts.push(s);
      continue;
    }

    const msg = normalizeResponsesInputItem(item, callNameByID);
    if (msg) {
      const reasoning = assistantReasoningOnlyContent(msg);
      if (reasoning) {
        pendingAssistantReasoning = pendingAssistantReasoning ? pendingAssistantReasoning + "\n" + reasoning : reasoning;
        continue;
      }
      if (isAssistantToolCallMessage(msg) && pendingAssistantReasoning) {
        if (!reasoningTextForHistory(msg)) msg.reasoning_content = pendingAssistantReasoning;
        pendingAssistantReasoning = "";
      } else {
        flushPendingReasoning();
      }
      flushFallback();
      if (isAssistantToolCallMessage(msg) && out.length && mergeResponsesAssistantToolCalls(out[out.length - 1], msg)) continue;
      out.push(msg);
      continue;
    }

    const fallback = normalizeResponsesFallbackPart(item);
    if (fallback) fallbackParts.push(fallback);
  }
  flushPendingReasoning();
  flushFallback();
  return out.length ? out : null;
}

function normalizeResponsesInputItem(item, callNameByID) {
  if (!item || typeof item !== "object") return null;
  const role = normalizeHistoryRole(item.role);
  if (item.role != null && role) {
    if (role === "assistant") return normalizeResponsesAssistantMessage(item);
    let content = item.content;
    if (content == null && typeof item.text === "string" && item.text.trim()) content = item.text;
    if (content == null) return null;
    const out = { role: role === "function" ? "tool" : role, content };
    if (role === "tool") {
      if (item.tool_call_id || item.call_id) out.tool_call_id = item.tool_call_id || item.call_id;
      if (item.name) out.name = item.name;
    }
    return out;
  }

  const type = String(item.type || "").trim().toLowerCase();
  if (type === "message" || type === "input_message") {
    const msgRole = normalizeHistoryRole(item.role || "user");
    if (msgRole === "assistant") return normalizeResponsesAssistantMessage(item);
    let content = item.content;
    if (content == null && typeof item.text === "string" && item.text.trim()) content = item.text;
    if (content == null) return null;
    return { role: msgRole || "user", content };
  }

  if (type === "function_call_output" || type === "tool_result") {
    const callID = item.call_id || item.tool_call_id || item.id || "";
    const out = {
      role: "tool",
      tool_call_id: callID,
      name: item.name || item.tool_name || (callID && callNameByID ? callNameByID[String(callID)] : "") || "",
      content: item.output != null ? item.output : item.content != null ? item.content : "",
    };
    return out;
  }

  if (type === "function_call" || type === "tool_call") {
    const fn = item.function && typeof item.function === "object" ? item.function : {};
    const name = String(item.name || fn.name || "").trim();
    if (!name) return null;
    const argsRaw = item.arguments != null ? item.arguments : item.input != null ? item.input : fn.arguments != null ? fn.arguments : fn.input;
    const callID = item.call_id || item.id || `call_${randHex(6)}`;
    if (callID && callNameByID) callNameByID[String(callID)] = name;
    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id: callID, type: "function", function: { name, arguments: stringifyToolCallArguments(argsRaw) } }],
    };
  }

  if (type === "reasoning" || type === "thinking") {
    const text = responsesContentToText(item.summary != null ? item.summary : item.content != null ? item.content : item.text);
    return text ? { role: "assistant", content: "", reasoning_content: text } : null;
  }

  if (type === "input_text" && typeof item.text === "string" && item.text.trim()) {
    return { role: "user", content: item.text };
  }
  if (typeof item.text === "string" && item.text.trim()) return { role: "user", content: item.text };
  if (item.content != null && responsesContentToText(item.content).trim()) return { role: "user", content: item.content };
  return null;
}

function normalizeResponsesAssistantMessage(item) {
  const out = { role: "assistant" };
  const content = item.content != null ? item.content : (typeof item.text === "string" ? item.text : null);
  const parts = Array.isArray(content) ? content : (content == null ? [] : [content]);
  let text = "";
  let reasoning = responsesContentToText(item.reasoning_content || item.reasoning || item.thinking);
  const toolCalls = Array.isArray(item.tool_calls) ? [...item.tool_calls] : [];

  for (const part of parts) {
    if (typeof part === "string") { text += part; continue; }
    if (!part || typeof part !== "object") continue;
    const typ = String(part.type || "").trim().toLowerCase();
    if (typ === "output_text" || typ === "text" || typ === "input_text") text += part.text || "";
    else if (typ === "reasoning" || typ === "thinking") reasoning += responsesContentToText(part.summary != null ? part.summary : part.text != null ? part.text : part.content);
    else if (typ === "function_call" || typ === "tool_call") {
      const fn = part.function && typeof part.function === "object" ? part.function : {};
      const name = part.name || fn.name || "";
      if (name) toolCalls.push({ id: part.call_id || part.id || `call_${toolCalls.length}`, type: "function", function: { name, arguments: stringifyToolCallArguments(part.arguments != null ? part.arguments : part.input != null ? part.input : fn.arguments) } });
    }
  }
  if (text) out.content = text;
  else if (item.content === null || toolCalls.length) out.content = null;
  if (reasoning) out.reasoning_content = reasoning;
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out.content != null || out.reasoning_content || out.tool_calls ? out : null;
}

function assistantReasoningOnlyContent(msg) {
  if (!isAssistantMessage(msg) || isAssistantToolCallMessage(msg)) return "";
  const contentText = responsesContentToText(msg.content).trim();
  const reasoning = reasoningTextForHistory(msg);
  if (!reasoning) return "";
  return !contentText || contentText === reasoning ? reasoning : "";
}

function isAssistantMessage(msg) {
  return !!msg && typeof msg === "object" && normalizeHistoryRole(msg.role) === "assistant";
}

function isAssistantToolCallMessage(msg) {
  return isAssistantMessage(msg) && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

function mergeResponsesAssistantToolCalls(prev, next) {
  if (!isAssistantToolCallMessage(prev) || !isAssistantToolCallMessage(next)) return false;
  prev.tool_calls = [...(prev.tool_calls || []), ...(next.tool_calls || [])];
  if (!reasoningTextForHistory(prev) && reasoningTextForHistory(next)) prev.reasoning_content = reasoningTextForHistory(next);
  return true;
}

function normalizeResponsesFallbackPart(item) {
  if (!item || typeof item !== "object") return "";
  if (String(item.type || "").trim().toLowerCase() === "input_text" && typeof item.text === "string" && item.text.trim()) return item.text;
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  if (item.content != null) {
    const text = responsesContentToText(item.content).trim();
    if (text) return text;
  }
  try { return JSON.stringify(item); } catch (_) { return String(item); }
}

function stringifyToolCallArguments(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value != null ? value : {}); } catch (_) { return "{}"; }
}

function responsesContentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) return content.map((item) => responsesContentToText(item)).filter(Boolean).join(" ");
  if (typeof content !== "object") return "";
  const typ = String(content.type || "").trim();
  if (typ === "text" || typ === "input_text" || typ === "output_text" || typ === "summary_text") return content.text || "";
  if (typ === "input_image" || typ === "image" || typ === "image_url") return "[image input]";
  if (typ === "input_file" || typ === "file") return `[file input${content.file_id ? ` ${content.file_id}` : ""}]`;
  if (content.text != null) return responsesContentToText(content.text);
  if (content.output != null) return responsesContentToText(content.output);
  return "";
}

function latestOpenAIUserInputText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (normalizeHistoryRole(msg.role) !== "user") continue;
    const text = contentTextForHistory(msg.content).trim();
    if (text) return text;
  }
  return "";
}

function latestGoogleUserInputText(req) {
  const contents = (req && req.contents) || [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (!content || content.role === "model") continue;
    const parts = [];
    for (const part of content.parts || []) {
      if (part && part.text) parts.push(part.text);
      else if (part && part.inlineData) parts.push("[image input]");
      else if (part && part.fileData) parts.push(`[file input${part.fileData.fileUri ? ` ${part.fileData.fileUri}` : ""}]`);
    }
    const text = parts.join("\n").trim();
    if (text) return text;
  }
  return "";
}

function openAIToolDefs(tools) {
  const out = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.type === "function" ? (tool.function || tool) : tool;
    out.push({
      name: fn.name != null ? fn.name : (tool.name || ""),
      description: fn.description != null ? fn.description : (tool.description || ""),
      parameters: fn.parameters != null ? fn.parameters : (tool.parameters || {}),
    });
  }
  return out.filter((t) => t.name);
}

function googleFunctionDeclarations(group) {
  if (!group || typeof group !== "object") return [];
  return group.functionDeclarations || group.function_declarations || [];
}

function googleToolDefs(req) {
  const out = [];
  for (const group of (req && req.tools) || []) {
    for (const fn of googleFunctionDeclarations(group)) {
      out.push({ name: fn.name || "", description: fn.description || "", parameters: fn.parameters || fn.parametersJsonSchema || fn.parameters_json_schema || {} });
    }
  }
  return out.filter((t) => t.name);
}

function googleFunctionCallingConfig(req) {
  const tc = (req && (req.toolConfig || req.tool_config)) || {};
  return tc.functionCallingConfig || tc.function_calling_config || {};
}

function googleAllowedFunctionNames(fc) {
  const raw = fc && (fc.allowedFunctionNames || fc.allowed_function_names || fc.allowedFunctions || fc.allowed_functions);
  if (Array.isArray(raw)) return raw.map((n) => String(n || "").trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((n) => n.trim()).filter(Boolean);
  return [];
}

function parseGoogleToolChoicePolicy(req, tools) {
  const fc = googleFunctionCallingConfig(req);
  const mode = String(fc.mode || "AUTO").trim().toUpperCase();
  const declared = extractToolNames(tools);
  const declaredSet = namesToSet(declared);
  const policy = { mode: "auto", forcedName: "", allowed: null, hasAllowed: false, declared, error: "" };

  if (mode === "NONE") {
    policy.mode = "none";
    policy.allowed = {};
    policy.hasAllowed = true;
    return policy;
  }
  if (mode === "ANY") policy.mode = "required";
  else policy.mode = "auto";

  const allowed = googleAllowedFunctionNames(fc);
  if (allowed.length) {
    const kept = [];
    for (const name of allowed) {
      if (declaredSet[name]) kept.push(name);
    }
    policy.allowed = namesToSet(kept);
    policy.hasAllowed = true;
  }
  return policy;
}

function filterGoogleToolsByConfig(tools, req) {
  const groups = Array.isArray(tools) ? tools : null;
  if (!groups || !groups.length) return null;
  const policy = parseGoogleToolChoicePolicy(req, groups);
  if (policy.mode === "none") return null;
  if (!policyHasAllowed(policy)) return groups;
  const filtered = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const declarations = googleFunctionDeclarations(group).filter((fn) => fn && toolPolicyAllows(policy, fn.name));
    if (declarations.length) filtered.push({ ...group, functionDeclarations: declarations });
  }
  return filtered.length ? filtered : null;
}

function validateGoogleFunctionCalls(req, calls) {
  const policy = parseGoogleToolChoicePolicy(req, (req && req.tools) || []);
  return validateToolPolicyCalls(policy, calls, {
    requiredMessage: "functionCallingConfig.mode=ANY requires at least one valid function call.",
    badMessage: (names) => `functionCallingConfig does not allow function(s): ${names}.`,
    forcedMessage: (name) => `functionCallingConfig requires the function ${name}.`,
  });
}

function buildToolsContextTranscript(toolDefs, choiceInstruction, filename = "tools.txt") {
  if (!toolDefs || !toolDefs.length) return "";
  return `# ${filename || "tools.txt"}\nAvailable tool descriptions and parameter schemas.\n\n` +
    JSON.stringify(toolDefs, null, 2) +
    (choiceInstruction ? "\n\nTool choice policy:\n" + choiceInstruction.trim() + "\n" : "\n");
}

function contextFileThreshold(cfg) {
  return Math.max(0, cfg.current_input_file_min_bytes || 95000);
}

function shouldConsiderContextFiles(cfg, promptText) {
  if (!cfg.current_input_file_enabled || !cfg.cookie) return false;
  return promptByteLength(promptText || "") > contextFileThreshold(cfg);
}

function shouldUseContextFiles(cfg, historyText, latestInputText, promptText) {
  if (!shouldConsiderContextFiles(cfg, promptText || historyText)) return false;
  const latest = String(latestInputText || "").trim();
  if (!latest) return false;
  if (!String(historyText || "").trim()) return false;
  return true;
}

function contextFileUploadFailure(kind, promptText, cause) {
  const err = new Error(
    `failed to upload ${kind || "context"} text file for large prompt; refusing to fall back to oversized inline context`
  );
  err.code = "large_context_file_upload_failed";
  err.promptBytes = promptByteLength(promptText || "");
  err.cause = cause;
  return err;
}

function latestInputInlineLimit(cfg) {
  return Math.max(4000, Math.min(16000, Math.floor(contextFileThreshold(cfg) / 6)));
}

function latestInputPromptForContextFile(cfg, latestInputText) {
  const latest = String(latestInputText || "").trim();
  if (!latest) return "";
  const bytes = promptByteLength(latest);
  if (bytes <= latestInputInlineLimit(cfg)) return "Latest user request:\n" + latest;
  const historyName = String((cfg && cfg.current_input_file_name) || "message.txt").trim() || "message.txt";
  return [
    `The latest user request is at the end of \`${historyName}\`; do not duplicate it inline.`,
    "Read it from the txt file and answer directly.",
  ].join("\n");
}

async function prepareContextFiles(cfg, historyText, toolDefs, choiceInstruction, latestInputText, promptText) {
  if (!shouldUseContextFiles(cfg, historyText, latestInputText, promptText)) return null;
  const refs = [];
  const toolsText = buildToolsContextTranscript(toolDefs, choiceInstruction, cfg.current_tools_file_name || "tools.txt");
  let toolsAttached = false;
  const uploadJobs = [
    uploadTextFile(cfg, historyText, cfg.current_input_file_name || "message.txt"),
  ];
  const hasToolsText = !!toolsText.trim();
  if (hasToolsText) uploadJobs.push(uploadTextFile(cfg, toolsText, cfg.current_tools_file_name || "tools.txt"));
  const uploadResults = await Promise.allSettled(uploadJobs);
  if (uploadResults[0].status === "fulfilled") {
    refs.push(uploadResults[0].value);
  } else {
    const e = uploadResults[0].reason;
    log(cfg, `history context file upload failed for large prompt: ${e}`);
    return { error: contextFileUploadFailure("history context", promptText, e) };
  }
  if (hasToolsText) {
    if (uploadResults[1] && uploadResults[1].status === "fulfilled") {
      refs.push(uploadResults[1].value);
      toolsAttached = true;
    } else if (uploadResults[1]) {
      const e = uploadResults[1].reason;
      log(cfg, `tools context file upload failed for large prompt: ${e}`);
      return { error: contextFileUploadFailure("tools context", promptText, e) };
    }
  }
  const toolNames = (toolDefs || []).map((t) => t.name).filter(Boolean);
  const livePrompt = [
    toolNames.length ? buildToolCallInstructions(toolNames) : "",
    choiceInstruction || "",
    currentInputFilePrompt(cfg, toolsAttached),
    latestInputPromptForContextFile(cfg, latestInputText),
    toolsText.trim() && !toolsAttached ? toolsText : "",
  ].filter((s) => String(s || "").trim()).join("\n\n");
  const promptTokenText = [historyText, toolsText, livePrompt].filter(Boolean).join("\n");
  logInfo(
    cfg,
    `context files enabled: refs=${refs.length} historyBytes=${promptByteLength(historyText)} toolsBytes=${promptByteLength(toolsText)} latestBytes=${promptByteLength(latestInputText)} livePromptBytes=${promptByteLength(livePrompt)}`
  );
  return { fileRefs: refs, prompt: livePrompt, promptTokenText };
}

async function prepareOpenAIGeminiContext(cfg, req, messages, tools, promptToolChoice, toolPolicy, structured) {
  const toolDefs = openAIToolDefs(tools);
  const toolChoiceInstruction = buildToolChoiceInstructionFromPolicy(toolPolicy);
  const [prompt0, images] = messagesToPrompt(messages, tools, promptToolChoice, toolDefs, toolChoiceInstruction);
  const imageResult = await resolveImages(cfg, images);
  const droppedNote = imageResult.droppedNote;
  const inlineHiddenToolsPrompt = withGeminiNativeHiddenToolsPromptWithTokens(prompt0 + droppedNote);
  const inlinePreparedPrompt = structured ? appendStructuredOutputInstructionToPrepared(inlineHiddenToolsPrompt, structured) : inlineHiddenToolsPrompt;
  const inlinePrompt = inlinePreparedPrompt.text;
  let contextFiles = null;
  if (shouldConsiderContextFiles(cfg, inlinePrompt)) {
    const historyText = buildOpenAIHistoryTranscript(messages, cfg.current_input_file_name || "message.txt");
    contextFiles = await prepareContextFiles(cfg, historyText, toolDefs, toolChoiceInstruction, latestOpenAIUserInputText(messages), inlinePrompt);
    if (contextFiles && contextFiles.error) return { error: contextFiles.error };
  }
  const fileRefs = mergeFileRefs(contextFiles && contextFiles.fileRefs, collectOpenAIRefFileIDs(req), imageResult.fileRefs);
  const liveHiddenToolsPrompt = contextFiles ? withGeminiNativeHiddenToolsPromptWithTokens(contextFiles.prompt + droppedNote) : null;
  const livePreparedPrompt = contextFiles
    ? (structured ? appendStructuredOutputInstructionToPrepared(liveHiddenToolsPrompt, structured) : liveHiddenToolsPrompt)
    : inlinePreparedPrompt;
  const usagePreparedPrompt = contextFiles
    ? (structured
      ? appendStructuredOutputInstructionToPrepared(withGeminiNativeHiddenToolsPromptWithTokens(contextFiles.promptTokenText + droppedNote, false), structured, false)
      : withGeminiNativeHiddenToolsPromptWithTokens(contextFiles.promptTokenText + droppedNote, false))
    : inlinePreparedPrompt;
  const prompt = livePreparedPrompt.text;
  const promptTokens = usagePreparedPrompt.tokens;
  return { toolDefs, toolChoiceInstruction, prompt, promptTokens, fileRefs, contextFiles };
}

async function prepareGoogleGeminiContext(cfg, effectiveReq, hasTools) {
  const toolDefs = hasTools ? googleToolDefs(effectiveReq) : [];
  const toolChoiceInstruction = googleToolChoiceInstruction(effectiveReq);
  const [prompt0, images] = googleContentsToPrompt(effectiveReq, toolDefs);
  const imageResult = await resolveImages(cfg, images);
  const droppedNote = imageResult.droppedNote;
  const inlinePreparedPrompt = withGeminiNativeHiddenToolsPromptWithTokens(prompt0 + droppedNote);
  const inlinePrompt = inlinePreparedPrompt.text;
  let contextFiles = null;
  if (shouldConsiderContextFiles(cfg, inlinePrompt)) {
    const historyText = buildGoogleHistoryTranscript(effectiveReq, cfg.current_input_file_name || "message.txt");
    contextFiles = await prepareContextFiles(cfg, historyText, toolDefs, toolChoiceInstruction, latestGoogleUserInputText(effectiveReq), inlinePrompt);
    if (contextFiles && contextFiles.error) return { error: contextFiles.error };
  }
  const fileRefs = mergeFileRefs(imageResult.fileRefs, contextFiles && contextFiles.fileRefs);
  const livePreparedPrompt = contextFiles ? withGeminiNativeHiddenToolsPromptWithTokens(contextFiles.prompt + droppedNote) : inlinePreparedPrompt;
  const usagePreparedPrompt = contextFiles ? withGeminiNativeHiddenToolsPromptWithTokens(contextFiles.promptTokenText + droppedNote, false) : inlinePreparedPrompt;
  const prompt = livePreparedPrompt.text;
  const promptTokens = usagePreparedPrompt.tokens;
  return { toolDefs, toolChoiceInstruction, prompt, promptTokens, fileRefs, contextFiles };
}

function mergeFileRefs(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const ref of group || []) {
      if (!ref) continue;
      const key = typeof ref === "string" ? ref : (ref.ref || ref.fileRef || ref.id || JSON.stringify(ref));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out.length ? out : null;
}

function collectOpenAIRefFileIDs(req) {
  if (!req || typeof req !== "object") return null;
  const out = [];
  const seen = new Set();
  for (const key of ["ref_file_ids", "file_ids", "attachments", "messages", "input"]) {
    const raw = req[key];
    if (raw == null) continue;
    if ((key === "messages" || key === "input") && typeof raw === "string") continue;
    appendOpenAIRefFileIDs(out, seen, raw);
  }
  return out.length ? out : null;
}

function appendOpenAIRefFileIDs(out, seen, raw) {
  if (raw == null) return;
  if (typeof raw === "string") { addOpenAIRefFileID(out, seen, raw); return; }
  if (Array.isArray(raw)) { for (const item of raw) appendOpenAIRefFileIDs(out, seen, item); return; }
  if (!raw || typeof raw !== "object") return;

  const rawFilename = imageFilenameFromObject(raw);
  if (raw.file_id != null) addOpenAIRefFileID(out, seen, raw.file_id, rawFilename);
  const typ = String(raw.type || "").trim().toLowerCase();
  if (typ.includes("file") && raw.id != null) addOpenAIRefFileID(out, seen, raw.id, rawFilename);
  if (raw.file && typeof raw.file === "object") {
    const fileFilename = imageFilenameFromObject(raw.file) || rawFilename;
    if (raw.file.file_id != null) addOpenAIRefFileID(out, seen, raw.file.file_id, fileFilename);
    if (raw.file.id != null) addOpenAIRefFileID(out, seen, raw.file.id, fileFilename);
  }
  for (const key of ["ref_file_ids", "file_ids", "attachments", "messages", "input", "content", "files", "items", "data", "source"]) {
    if (!(key in raw)) continue;
    const nested = raw[key];
    if ((key === "content" || key === "input") && typeof nested === "string") continue;
    appendOpenAIRefFileIDs(out, seen, nested);
  }
}

function addOpenAIRefFileID(out, seen, fileID, filename) {
  const id = String(fileID || "").trim();
  if (!id || seen.has(id)) return;
  seen.add(id);
  const name = sanitizeUploadFilename(filename);
  out.push(name ? { id, name } : id);
}

function messageContentToPrompt(content, images) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    const textParts = [];
    for (const c of content) {
      if (typeof c === "string") { textParts.push(c); continue; }
      if (!c || typeof c !== "object") continue;
      const t = String(c.type || "").trim().toLowerCase();
      if (t === "text" || t === "input_text" || t === "output_text" || t === "summary_text") {
        textParts.push(c.text || "");
      } else if (t === "reasoning" || t === "thinking") {
        const text = responsesContentToText(c.summary != null ? c.summary : c.text != null ? c.text : c.content);
        if (text) textParts.push(`[reasoning_content]\n${text}\n[/reasoning_content]`);
      } else if (t === "image_url" || c.image_url) {
        const u = c.image_url && (c.image_url.url || c.image_url);
        const img = parseImageUrl(typeof u === "string" ? u : "");
        if (img) images.push({ ...img, filename: imageFilenameFromObject(c) || (img.url ? filenameFromUrl(img.url) : "") });
        textParts.push("[image input]");
      } else if (t === "image" || t === "input_image") {
        if (c.source && c.source.data) {
          images.push({ b64: c.source.data, mime: c.source.media_type || c.source.mime_type || "image/png", filename: imageFilenameFromObject(c) });
        } else if (c.image_url) {
          const img = parseImageUrl(typeof c.image_url === "string" ? c.image_url : c.image_url.url || "");
          if (img) images.push({ ...img, filename: imageFilenameFromObject(c) || (img.url ? filenameFromUrl(img.url) : "") });
        }
        textParts.push("[image input]");
      } else if (t === "input_file" || t === "file") {
        textParts.push(`[file input${c.file_id ? ` ${c.file_id}` : ""}]`);
      } else if (c.text != null || c.content != null || c.output != null) {
        const text = responsesContentToText(c.text != null ? c.text : c.content != null ? c.content : c.output);
        if (text) textParts.push(text);
      }
    }
    return textParts.filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    const t = String(content.type || "").trim().toLowerCase();
    if (t === "image_url" || t === "image" || t === "input_image") {
      if (content.source && content.source.data) {
        images.push({ b64: content.source.data, mime: content.source.media_type || content.source.mime_type || "image/png", filename: imageFilenameFromObject(content) });
      } else {
        const u = content.image_url && (content.image_url.url || content.image_url);
        const img = parseImageUrl(typeof u === "string" ? u : "");
        if (img) images.push({ ...img, filename: imageFilenameFromObject(content) || (img.url ? filenameFromUrl(img.url) : "") });
      }
      return "[image input]";
    }
    if (t === "input_file" || t === "file") return `[file input${content.file_id ? ` ${content.file_id}` : ""}]`;
    const text = responsesContentToText(content);
    if (text) return text;
    try { return JSON.stringify(content); } catch (_) { return String(content); }
  }
  return "";
}

/** OpenAI messages -> [promptString, images]。 */
function messagesToPrompt(messages, tools, toolChoice, toolDefsOverride, toolChoiceInstructionOverride) {
  const parts = [];
  const images = [];

  if (tools && toolChoice !== "none") {
    const toolDefs = Array.isArray(toolDefsOverride) ? toolDefsOverride : openAIToolDefs(tools);
    if (toolDefs.length) {
      const choiceInstruction = toolChoiceInstructionOverride || "";
      parts.push(buildToolPromptBlock(toolDefs, choiceInstruction));
    }
  }

  for (const msg of messages || []) {
    if (!msg || typeof msg !== "object") continue;
    const role = normalizeHistoryRole(msg.role);
    let content = messageContentToPrompt(msg.content != null ? msg.content : "", images);

    if (role === "system") {
      parts.push(`[System instruction]: ${content}`);
    } else if (role === "assistant") {
      const reasoning = reasoningTextForHistory(msg);
      if (reasoning && !content.includes("[reasoning_content]")) {
        content = [`[reasoning_content]\n${reasoning}\n[/reasoning_content]`, content].filter(Boolean).join("\n\n");
      }
      if (msg.tool_calls) {
        const tcStrs = msg.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return formatPromptToolCallBlock(fn.name, parseJsonObject(fn.arguments || "{}"));
        });
        parts.push(`[Assistant]: ${content || ""}\n` + tcStrs.join("\n"));
      } else {
        parts.push(`[Assistant]: ${content}`);
      }
    } else if (role === "tool") {
      const meta = [];
      if (msg.name) meta.push(String(msg.name));
      if (msg.tool_call_id) meta.push(`id=${msg.tool_call_id}`);
      parts.push(`[Tool result${meta.length ? ` for ${meta.join(" ")}` : ""}]: ${content || "null"}`);
    } else {
      parts.push(content ? content : "");
    }
  }

  return [parts.filter((p) => p).join("\n\n"), images];
}

function formatPromptToolCallBlock(name, input) {
  const safeInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  let out = `<tool_calls><invoke name="${xmlEscapeAttr(name || "")}">`;
  for (const [key, value] of Object.entries(safeInput)) {
    out += `<parameter name="${xmlEscapeAttr(key)}">${formatPromptParamValue(value)}</parameter>`;
  }
  return out + "</invoke></tool_calls>";
}

function formatPromptParamValue(value) {
  if (typeof value === "string") return promptCDATA(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => `<item>${formatPromptParamValue(v)}</item>`).join("");
  if (value && typeof value === "object") {
    return Object.entries(value).map(([k, v]) => formatPromptObjectField(k, v)).join("");
  }
  return "";
}

function formatPromptObjectField(key, value) {
  const name = String(key == null ? "" : key);
  const body = formatPromptParamValue(value);
  if (isSafeXmlElementName(name)) return `<${name}>${body}</${name}>`;
  return `<field name="${xmlEscapeAttr(name)}">${body}</field>`;
}

function isSafeXmlElementName(name) {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(String(name || ""));
}

/** 提取 DSML/XML 工具调用 -> [cleanText, OpenAI toolCalls]；保留旧 tool_call 代码块兜底。 */
function parseToolCalls(text, toolsRaw) {
  const parsed = parseDSMLToolCallsDetailed(text);
  if (parsed.calls.length) {
    return [parsed.cleanText, formatOpenAIToolCalls(parsed.calls, toolsRaw)];
  }
  return parseLegacyToolCalls(text);
}

function createToolSieveState() {
  return { buffer: "", holdingToolCandidate: false, sawToolClose: false, parsedToolCandidate: false };
}

const TOOL_SIEVE_PLAIN_TEXT_KEEP = 64;
const TOOL_SIEVE_MAX_CANDIDATE_CHARS = 256 * 1024;

function hasToolSieveSentinel(text) {
  const source = String(text || "");
  return source.indexOf("<") >= 0 ||
    source.indexOf("＜") >= 0 ||
    source.indexOf("〈") >= 0 ||
    source.indexOf("`") >= 0 ||
    source.indexOf("~") >= 0;
}

function flushToolSievePlainPrefix(state) {
  if (!state || state.holdingToolCandidate || hasToolSieveSentinel(state.buffer)) return null;
  if (state.buffer.length <= TOOL_SIEVE_PLAIN_TEXT_KEEP) return null;
  const emitLen = state.buffer.length - TOOL_SIEVE_PLAIN_TEXT_KEEP;
  const out = state.buffer.slice(0, emitLen);
  state.buffer = state.buffer.slice(emitLen);
  return out ? [out] : null;
}

function hasToolCallCloseSyntax(text) {
  const source = normalizeToolMarkupConfusables(String(text || ""));
  return /<\s*\/\s*(?:\|?\s*D?SML\s*[|!、\u0002␂_\-\s▁]+)?\s*(tool_calls|tool-calls|toolcalls)\s*>/i.test(source);
}

function processToolSieveChunk(state, chunk) {
  if (!state) state = createToolSieveState();
  const incoming = String(chunk || "");
  const tail = state.buffer ? state.buffer.slice(-128) : "";
  state.buffer += incoming;
  if (state.holdingToolCandidate && hasToolCallCloseSyntax(tail + incoming)) state.sawToolClose = true;
  if (!state.buffer) return [];

  const plainPrefix = flushToolSievePlainPrefix(state);
  if (plainPrefix) return plainPrefix;

  const start = findToolSieveCandidateStart(state.buffer);
  if (start >= 0) {
    state.holdingToolCandidate = true;
    state.sawToolClose = hasToolCallCloseSyntax(state.buffer.slice(start));
    state.parsedToolCandidate = false;
    if (start === 0) return [];
    const out = state.buffer.slice(0, start);
    state.buffer = state.buffer.slice(start);
    return out ? [out] : [];
  }

  if (state.holdingToolCandidate) {
    if (isPartialToolMarkupPrefix(state.buffer)) return [];
    if (state.parsedToolCandidate) return [];
    if (!state.sawToolClose && state.buffer.length <= TOOL_SIEVE_MAX_CANDIDATE_CHARS) return [];
    if (!state.sawToolClose && state.buffer.length > TOOL_SIEVE_MAX_CANDIDATE_CHARS) {
      const out = state.buffer;
      state.buffer = "";
      state.holdingToolCandidate = false;
      state.sawToolClose = false;
      state.parsedToolCandidate = false;
      return out ? [out] : [];
    }
    const parsed = parseDSMLToolCallsDetailed(state.buffer);
    if (parsed.calls.length) {
      state.parsedToolCandidate = true;
      return [];
    }
    if (parsed.sawToolCallSyntax) {
      const out = state.buffer;
      state.buffer = "";
      state.holdingToolCandidate = false;
      state.sawToolClose = false;
      state.parsedToolCandidate = false;
      return out ? [out] : [];
    }
    state.holdingToolCandidate = false;
    state.sawToolClose = false;
    state.parsedToolCandidate = false;
  }

  const protectedTail = markdownProtectedTailStart(state.buffer);
  if (protectedTail >= 0) {
    if (protectedTail === 0) return [];
    const out = state.buffer.slice(0, protectedTail);
    state.buffer = state.buffer.slice(protectedTail);
    return out ? [out] : [];
  }

  const keep = toolSieveSafeTailLength(state.buffer);
  if (state.buffer.length <= keep) return [];
  let emitLen = state.buffer.length - keep;
  const protectedStart = markdownProtectedSpanStartAtCut(state.buffer, emitLen);
  if (protectedStart >= 0) emitLen = protectedStart;
  if (emitLen <= 0) return [];
  const out = state.buffer.slice(0, emitLen);
  state.buffer = state.buffer.slice(emitLen);
  return out ? [out] : [];
}

function flushToolSieve(state, toolsRaw) {
  const buffered = state ? state.buffer : "";
  if (!buffered) return { text: "", toolCalls: null };
  if (findToolSieveCandidateStart(buffered) < 0) return { text: buffered, toolCalls: null };
  const [clean, toolCalls] = parseToolCalls(buffered, toolsRaw);
  return { text: clean, toolCalls: toolCalls.length ? toolCalls : null };
}

function isMarkdownProtectedPosition(text, index) {
  const source = String(text || "");
  return isInsideMarkdownFence(source, index) || isInsideMarkdownCodeSpan(source, index) || isInsideSimpleMarkdownCodeSpan(source, index);
}

function isInsideSimpleMarkdownCodeSpan(text, index) {
  const source = String(text || "");
  const pos = Math.max(0, index);
  const lineStart = Math.max(source.lastIndexOf("\n", pos - 1), source.lastIndexOf("\r", pos - 1)) + 1;
  let lineEnd = source.indexOf("\n", pos);
  const crEnd = source.indexOf("\r", pos);
  if (lineEnd < 0 || (crEnd >= 0 && crEnd < lineEnd)) lineEnd = crEnd;
  if (lineEnd < 0) lineEnd = source.length;
  const line = source.slice(lineStart, lineEnd);
  const rel = pos - lineStart;
  const re = /(`{1,2})([^`\r\n]*?)\1/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (rel >= start && rel < end) return true;
    re.lastIndex = m.index + Math.max(1, m[0].length);
  }
  return false;
}

function markdownProtectedSpanStartAtCut(text, cut) {
  const source = String(text || "");
  const pos = Math.max(0, Math.min(source.length, cut));
  if (pos <= 0 || pos >= source.length) return -1;
  const fenceStart = openMarkdownFenceStart(source.slice(0, pos));
  if (fenceStart >= 0) return fenceStart;
  return markdownCodeSpanStartAt(source, pos);
}

function markdownCodeSpanStartAt(text, index) {
  const source = String(text || "");
  const pos = Math.max(0, Math.min(source.length, index));
  const lineStart = Math.max(source.lastIndexOf("\n", pos - 1), source.lastIndexOf("\r", pos - 1)) + 1;
  let openIndex = -1;
  let openLen = 0;
  for (let i = lineStart; i < pos; i++) {
    if (source[i] !== "`") continue;
    let j = i;
    while (j < source.length && source[j] === "`") j++;
    const len = j - i;
    if (len < 3) {
      if (openIndex >= 0 && len === openLen) {
        openIndex = -1;
        openLen = 0;
      } else if (openIndex < 0) {
        openIndex = i;
        openLen = len;
      }
    }
    i = j - 1;
  }
  return openIndex;
}

function markdownProtectedTailStart(text) {
  const source = String(text || "");
  if (!source) return -1;
  const fenceStart = openMarkdownFenceStart(source);
  if (fenceStart >= 0) return fenceStart;
  return openMarkdownCodeSpanStart(source);
}

function openMarkdownFenceStart(text) {
  const source = String(text || "");
  let fence = null;
  let lineStart = 0;
  const lines = source.split(/(\r?\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] || "";
    const parsed = parseMarkdownFenceLine(line);
    if (parsed) {
      const cur = { ch: parsed.ch, len: parsed.len, index: lineStart + parsed.index };
      if (!fence) fence = cur;
      else if (parsed.canClose && cur.ch === fence.ch && cur.len >= fence.len) fence = null;
    }
    lineStart += line.length + ((lines[i + 1] || "").length);
  }
  return fence ? fence.index : -1;
}

function parseMarkdownFenceLine(line) {
  const m = /^(\s*)(```+|~~~+)([^\r\n]*)$/.exec(String(line || ""));
  if (!m) return null;
  const mark = m[2];
  const rest = String(m[3] || "");
  const trimmed = rest.trim();
  if (mark[0] === "`" && rest.includes("`")) return null;
  if (trimmed && /[<>\]]/.test(trimmed)) return null;
  if (trimmed && !/^[A-Za-z0-9_.+#-]+(?:[ \t].*)?$/.test(trimmed)) return null;
  return { ch: mark[0], len: mark.length, index: m[1].length, canClose: !trimmed };
}

function openMarkdownCodeSpanStart(text) {
  const source = String(text || "");
  const lineStart = Math.max(source.lastIndexOf("\n"), source.lastIndexOf("\r")) + 1;
  let openIndex = -1;
  let openLen = 0;
  for (let i = lineStart; i < source.length; i++) {
    if (source[i] !== "`") continue;
    let j = i;
    while (j < source.length && source[j] === "`") j++;
    const len = j - i;
    if (len < 3) {
      if (openIndex >= 0 && len === openLen) {
        openIndex = -1;
        openLen = 0;
      } else if (openIndex < 0) {
        openIndex = i;
        openLen = len;
      }
    }
    i = j - 1;
  }
  return openIndex;
}

function isInsideMarkdownFence(text, index) {
  const before = String(text || "").slice(0, Math.max(0, index));
  const lines = before.split(/\r?\n/);
  let fence = null;
  for (const line of lines) {
    const parsed = parseMarkdownFenceLine(line);
    if (!parsed) continue;
    const cur = { ch: parsed.ch, len: parsed.len };
    if (!fence) fence = cur;
    else if (parsed.canClose && cur.ch === fence.ch && cur.len >= fence.len) fence = null;
  }
  return !!fence;
}

function isInsideMarkdownCodeSpan(text, index) {
  const before = String(text || "").slice(0, Math.max(0, index));
  let open = false;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== "`") continue;
    let j = i;
    while (j < before.length && before[j] === "`") j++;
    if (j - i === 1) open = !open;
    i = j - 1;
  }
  return open;
}

function markdownProtectedRanges(text) {
  const source = String(text || "");
  const ranges = [];
  const lines = source.split(/(\r?\n)/);
  let lineStart = 0;
  let fence = null;
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] || "";
    const sep = lines[i + 1] || "";
    const parsed = parseMarkdownFenceLine(line);
    if (parsed) {
      const cur = { ch: parsed.ch, len: parsed.len, index: lineStart + parsed.index };
      if (!fence) {
        fence = cur;
      } else if (parsed.canClose && cur.ch === fence.ch && cur.len >= fence.len) {
        ranges.push({ start: fence.index, end: lineStart + line.length + sep.length });
        fence = null;
      }
    }
    lineStart += line.length + sep.length;
  }
  if (fence) ranges.push({ start: fence.index, end: source.length });

  lineStart = 0;
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] || "";
    const sep = lines[i + 1] || "";
    const re = /(`{1,2})([^`\r\n]*?)\1/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const start = lineStart + m.index;
      const end = start + m[0].length;
      if (!ranges.some((r) => start >= r.start && start < r.end)) ranges.push({ start, end });
      re.lastIndex = m.index + Math.max(1, m[0].length);
    }
    lineStart += line.length + sep.length;
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const r of ranges) {
    if (r.start < 0 || r.end <= r.start) continue;
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }
  return merged;
}

function maskMarkdownProtectedSpans(text) {
  const source = String(text || "");
  const ranges = markdownProtectedRanges(source);
  const placeholders = [];
  if (!ranges.length) return { text: source, restore: (value) => String(value || "") };
  let last = 0;
  let masked = "";
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const token = `GEMINI_MD_PROTECTED_${i}_TOKEN`;
    placeholders.push([token, source.slice(r.start, r.end)]);
    masked += source.slice(last, r.start) + token;
    last = r.end;
  }
  masked += source.slice(last);
  return {
    text: masked,
    restore(value) {
      let out = String(value || "");
      for (const [token, original] of placeholders) out = out.split(token).join(original);
      return out;
    },
  };
}

function findToolSieveCandidateStart(text) {
  const source = String(text || "");
  const re = /[<＜〈]\s*(?:\|\s*DSML\s*\||[\w$-]+[|_\-\s▁]+)?\s*(tool_calls|tool-calls|toolcalls|invoke|parameter)\b/ig;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (!isMarkdownProtectedPosition(source, m.index)) return m.index;
    re.lastIndex = m.index + Math.max(1, m[0].length);
  }
  const lastLt = Math.max(source.lastIndexOf("<"), source.lastIndexOf("＜"), source.lastIndexOf("〈"));
  if (lastLt < 0) return -1;
  if (isMarkdownProtectedPosition(source, lastLt)) return -1;
  const tail = source.slice(lastLt);
  if (isPartialToolMarkupPrefix(tail)) return lastLt;
  return -1;
}

function isPartialToolMarkupPrefix(text) {
  const compact = normalizeMarkupTagShell(String(text || "")).replace(/[\s▁]+/g, "").toLowerCase();
  if (!compact || compact[0] !== "<") return false;
  const candidates = [
    "<|dsml|tool_calls", "<|dsml|tool-calls", "<|dsml|toolcalls", "<|dsml|invoke", "<|dsml|parameter",
    "<tool_calls", "<tool-calls", "<toolcalls", "<invoke", "<parameter",
  ];
  return candidates.some((candidate) => candidate.startsWith(compact) || compact.startsWith(candidate));
}

function toolSieveSafeTailLength(text) {
  const lastLt = String(text || "").lastIndexOf("<");
  if (lastLt < 0) return 64;
  return Math.max(64, String(text || "").length - lastLt);
}

function parseLegacyToolCalls(text) {
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
          arguments: JSON.stringify(data.arguments != null ? data.arguments : data.args != null ? data.args : data.input != null ? data.input : {}),
        },
      });
    } catch (_) { /* 跳过格式错误的块 */ }
  }
  cleanParts.push(text.slice(lastEnd));
  return [cleanParts.join("").trim(), toolCalls];
}

function parseDSMLToolCallsDetailed(text) {
  const raw = String(text || "");
  if (!raw) return { cleanText: "", calls: [], sawToolCallSyntax: false };
  if (containsToolMarkupSyntax(raw) && findToolSieveCandidateStart(raw) < 0) {
    return { cleanText: raw.trim(), calls: [], sawToolCallSyntax: true };
  }
  if (shouldSkipToolCallParsingForCodeFenceExample(raw)) return { cleanText: raw.trim(), calls: [], sawToolCallSyntax: true };
  const protectedMarkdown = maskMarkdownProtectedSpans(raw);
  let normalized = normalizeDSMLToolCallMarkup(protectedMarkdown.text).trim();
  let blocks = findXmlElementBlocks(normalized, "tool_calls");
  if (!blocks.length && /<\s*(?:\|DSML\|)?invoke\b/i.test(normalized) && /<\s*\/\s*(?:\|DSML\|)?tool_calls\s*>/i.test(normalized)) {
    normalized = "<tool_calls>" + normalized;
    blocks = findXmlElementBlocks(normalized, "tool_calls");
  }
  const calls = [];
  for (const block of blocks) {
    for (const invoke of findXmlElementBlocks(block.body, "invoke")) {
      const parsed = parseMarkupSingleToolCall(invoke);
      if (parsed) calls.push(parsed);
    }
  }
  if (!calls.length) {
    return { cleanText: raw.trim(), calls: [], sawToolCallSyntax: containsToolMarkupSyntax(raw) };
  }
  let clean = normalized;
  for (let i = blocks.length - 1; i >= 0; i--) clean = clean.slice(0, blocks[i].start) + clean.slice(blocks[i].end);
  return { cleanText: protectedMarkdown.restore(clean).trim(), calls: restoreToolCallProtectedMarkdown(calls, protectedMarkdown.restore), sawToolCallSyntax: true };
}

function restoreToolCallProtectedMarkdown(calls, restore) {
  if (!Array.isArray(calls) || typeof restore !== "function") return calls || [];
  return calls.map((call) => {
    if (!call || typeof call !== "object") return call;
    return { ...call, input: restoreToolValueProtectedMarkdown(call.input, restore) };
  });
}

function restoreToolValueProtectedMarkdown(value, restore) {
  if (typeof value === "string") {
    const restored = restore(value);
    return restored === value ? value : unwrapToolArgumentMarkdown(restored);
  }
  if (Array.isArray(value)) return value.map((item) => restoreToolValueProtectedMarkdown(item, restore));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = restoreToolValueProtectedMarkdown(child, restore);
    return out;
  }
  return value;
}

function unwrapToolArgumentMarkdown(value) {
  const text = String(value || "");
  const trimmed = text.trim();
  const fence = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  if (fence) return fence[1];
  const inline = /^`([^`\r\n]*)`$/.exec(trimmed);
  if (inline) return inline[1];
  return text;
}

function formatOpenAIToolCalls(calls, toolsRaw) {
  const normalized = normalizeParsedToolCallsForSchemas(calls, toolsRaw);
  return normalized.map((c, idx) => ({
    id: `call_${randHex(8)}`,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
    index: idx,
  })).map(({ index, ...tc }) => tc);
}

function formatOpenAIStreamToolCalls(calls, idStore, toolsRaw) {
  const normalized = normalizeParsedToolCallsForSchemas(calls, toolsRaw);
  if (!Array.isArray(normalized) || !normalized.length) return [];
  return normalized.map((c, idx) => ({
    index: idx,
    id: ensureStreamToolCallID(idStore, idx),
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
  }));
}

function ensureStreamToolCallID(idStore, index) {
  if (!(idStore instanceof Map)) return `call_${randHex(32)}`;
  const key = Number.isInteger(index) ? index : 0;
  const existing = idStore.get(key);
  if (existing) return existing;
  const next = `call_${randHex(32)}`;
  idStore.set(key, next);
  return next;
}

function normalizeParsedToolCallsForSchemas(calls, toolsRaw) {
  if (!Array.isArray(calls) || !calls.length) return calls;
  const schemas = buildToolSchemaIndex(toolsRaw);
  if (!schemas) return calls;
  let changedAny = false;
  const out = calls.map((call) => {
    const name = String((call && call.name) || "").trim().toLowerCase();
    const schema = schemas[name];
    if (!schema || !call || !call.input || typeof call.input !== "object" || Array.isArray(call.input)) return call;
    const [normalized, changed] = normalizeToolValueWithSchema(call.input, schema);
    if (!changed || !normalized || typeof normalized !== "object" || Array.isArray(normalized)) return call;
    changedAny = true;
    return { ...call, input: normalized };
  });
  return changedAny ? out : calls;
}

function buildToolSchemaIndex(toolsRaw) {
  if (!Array.isArray(toolsRaw) || !toolsRaw.length) return null;
  const out = {};
  const addToolSchema = (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const fn = item.function && typeof item.function === "object" && !Array.isArray(item.function) ? item.function : null;
    const name = firstNonEmptyString(item.name, fn && fn.name);
    const schema = firstNonNil(item.parameters, item.input_schema, item.inputSchema, item.schema, item.parametersJsonSchema, fn && fn.parameters, fn && fn.input_schema, fn && fn.inputSchema, fn && fn.schema, fn && fn.parametersJsonSchema);
    if (name && schema && typeof schema === "object" && !Array.isArray(schema)) out[name.toLowerCase()] = schema;
  };
  for (const item of toolsRaw) {
    if (item && Array.isArray(item.functionDeclarations)) {
      for (const fn of item.functionDeclarations) addToolSchema(fn);
    } else {
      addToolSchema(item);
    }
  }
  return Object.keys(out).length ? out : null;
}

function normalizeToolValueWithSchema(value, schema) {
  if (value == null || !schema || typeof schema !== "object" || Array.isArray(schema)) return [value, false];
  if (shouldCoerceSchemaToString(schema)) return stringifySchemaValue(value);
  if (looksLikeObjectSchema(schema)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [value, false];
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties : null;
    const additional = schema.additionalProperties;
    let changed = false;
    const out = {};
    for (const [key, current] of Object.entries(value)) {
      let next = current;
      let fieldChanged = false;
      if (properties && Object.prototype.hasOwnProperty.call(properties, key)) [next, fieldChanged] = normalizeToolValueWithSchema(current, properties[key]);
      else if (additional != null) [next, fieldChanged] = normalizeToolValueWithSchema(current, additional);
      out[key] = next;
      changed = changed || fieldChanged;
    }
    return changed ? [out, true] : [value, false];
  }
  if (looksLikeArraySchema(schema)) {
    if (!Array.isArray(value) || !value.length || schema.items == null) return [value, false];
    let changed = false;
    const out = value.map((item, idx) => {
      const itemSchema = Array.isArray(schema.items) ? schema.items[idx] : schema.items;
      if (itemSchema == null) return item;
      const [next, itemChanged] = normalizeToolValueWithSchema(item, itemSchema);
      changed = changed || itemChanged;
      return next;
    });
    return changed ? [out, true] : [value, false];
  }
  return [value, false];
}

function shouldCoerceSchemaToString(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  if (typeof schema.const === "string") return true;
  if (Array.isArray(schema.enum) && schema.enum.length && schema.enum.every((item) => typeof item === "string")) return true;
  if (typeof schema.type === "string") return schema.type.trim().toLowerCase() === "string";
  if (Array.isArray(schema.type) && schema.type.length) {
    let hasString = false;
    for (const item of schema.type) {
      if (typeof item !== "string") return false;
      const typ = item.trim().toLowerCase();
      if (typ === "string") hasString = true;
      else if (typ !== "null") return false;
    }
    return hasString;
  }
  return false;
}

function looksLikeObjectSchema(schema) {
  return !!schema && typeof schema === "object" && !Array.isArray(schema) && (
    (typeof schema.type === "string" && schema.type.trim().toLowerCase() === "object") ||
    (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) ||
    schema.additionalProperties != null
  );
}

function looksLikeArraySchema(schema) {
  return !!schema && typeof schema === "object" && !Array.isArray(schema) && (
    (typeof schema.type === "string" && schema.type.trim().toLowerCase() === "array") || schema.items != null
  );
}

function stringifySchemaValue(value) {
  if (value == null || typeof value === "string") return [value, false];
  try { return [JSON.stringify(value), true]; } catch (_) { return [value, false]; }
}

function firstNonNil(...values) {
  for (const value of values) if (value != null) return value;
  return null;
}

function stripFencedCodeBlocks(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of lines) {
    const parsed = parseMarkdownFenceLine(line);
    if (!inFence) {
      if (parsed) { inFence = true; fenceChar = parsed.ch; fenceLen = parsed.len; continue; }
      out.push(line);
      continue;
    }
    if (parsed && parsed.canClose && parsed.ch === fenceChar && parsed.len >= fenceLen) {
      inFence = false;
      fenceChar = "";
      fenceLen = 0;
    }
  }
  return out.join("\n");
}

function shouldSkipToolCallParsingForCodeFenceExample(text) {
  if (!containsToolMarkupSyntax(text)) return false;
  return !containsToolMarkupSyntax(stripFencedCodeBlocks(text));
}

function containsToolMarkupSyntax(text) {
  const source = normalizeToolMarkupConfusables(String(text || ""));
  return /<\s*\/?\s*(?:\|?\s*dsml\s*[|!、\u0002␂_\-\s▁]+|[\w$-]+[|!、\u0002␂_\-\s▁💥]+)?\s*(tool_calls|tool-calls|toolcalls|invoke|parameter)\b/i.test(source) ||
    /<\s*\/?\s*[A-Za-z][A-Za-z0-9_$-]*(ToolCalls|Invoke|Parameter)\b/.test(source);
}

const TOOL_MARKUP_CONFUSABLE_RE = /[※＜〈＞〉／＝＂“”＇‘’｜！\u3000ｄＤｓＳЅｍＭΜｌＬοоаｅΑАС\u200b\ufeff]/;

function normalizeToolMarkupConfusables(text) {
  const source = String(text || "");
  if (!TOOL_MARKUP_CONFUSABLE_RE.test(source)) return source;
  return source
    .replace(/※\s*>/g, ">")
    .replace(/[＜〈]/g, "<")
    .replace(/[＞〉]/g, ">")
    .replace(/[／]/g, "/")
    .replace(/[＝]/g, "=")
    .replace(/[＂“”]/g, '"')
    .replace(/[＇‘’]/g, "'")
    .replace(/[｜]/g, "|")
    .replace(/[！]/g, "!")
    .replace(/[、]/g, "、")
    .replace(/[\u3000]/g, " ")
    .replace(/[ｄＤ]/g, "D")
    .replace(/[ｓＳЅ]/g, "S")
    .replace(/[ｍＭΜ]/g, "M")
    .replace(/[ｌＬ]/g, "L")
    .replace(/[οо]/g, "o")
    .replace(/[а]/g, "a")
    .replace(/[е]/g, "e")
    .replace(/[ΑА]/g, "A")
    .replace(/[С]/g, "C")
    .replace(/※/g, ">")
    .replace(/[\u200b\ufeff]/g, "");
}

function normalizeMarkupTagShell(tag) {
  return normalizeToolMarkupConfusables(tag);
}

function normalizeDSMLToolCallMarkup(text) {
  return normalizeToolMarkupConfusables(text)
    .replace(/<<+/g, "<")
    .replace(/<!\s*\[\s*CDATA\s*\[/gi, "<![CDATA[")
    .replace(/<\s*[!、]\s*\[\s*CDATA\s*\[/gi, "<![CDATA[")
    .replace(/\]\]\s*>/g, "]]>")
    .replace(/<\s*(\/?)\s*(?:(?:\|?\s*D?SML\s*[|!、\u0002␂_\-\s▁]+)+(?:D?SML\s*[|!、\u0002␂_\-\s▁]+)*|D?SML(?=tool_calls|tool-calls|toolcalls|invoke|parameter)|[\w$-]+[|!、\u0002␂_\-\s▁💥]+)?\s*(tool_calls|tool-calls|toolcalls|invoke|parameter)\b([^>]*)>/gi,
      (_m, close, name, rest) => `<${close ? "/" : ""}${canonicalToolTagName(name)}${rest}>`)
    .replace(/<\s*(\/?)\s*[A-Za-z][A-Za-z0-9_$-]*(ToolCalls|Invoke|Parameter)\b([^>]*)>/g,
      (_m, close, name, rest) => `<${close ? "/" : ""}${canonicalToolTagName(name)}${rest}>`)
    .replace(/<\s*(\/?)\s*(tool-calls|toolcalls)\b([^>]*)>/gi, (_m, close, _name, rest) => `<${close ? "/" : ""}tool_calls${rest}>`);
}

function canonicalToolTagName(name) {
  const n = String(name || "").toLowerCase();
  return n === "tool-calls" || n === "toolcalls" ? "tool_calls" : n;
}

function parseMarkupSingleToolCall(block) {
  const attrs = parseTagAttributes(block.attrs);
  const name = String(attrs.name || "").trim();
  if (!name) return null;
  const inner = String(block.body || "").trim();
  if (inner) {
    try {
      const decoded = JSON.parse(inner);
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        const input = decoded.input != null ? decoded.input : decoded.parameters != null ? decoded.parameters : decoded.arguments != null ? decoded.arguments : decoded.args;
        return { name, input: input && typeof input === "object" && !Array.isArray(input) ? input : {} };
      }
    } catch (_) {}
  }
  const input = {};
  for (const match of findXmlElementBlocks(inner, "parameter")) {
    const parameterAttrs = parseTagAttributes(match.attrs);
    const paramName = String(parameterAttrs.name || "").trim();
    if (!paramName) continue;
    appendMarkupValue(input, paramName, parseMarkupValue(match.body));
  }
  if (!Object.keys(input).length && inner.trim() !== "") return null;
  return { name, input };
}

function parseMarkupValue(body) {
  const rawBody = String(body || "");
  const raw = rawBody.trim();
  if (!raw) return "";
  if (raw.startsWith("<![CDATA[")) return decodeCDATA(raw);
  const children = findTopLevelXmlElementBlocks(raw);
  if (children.length) {
    if (children.every((c) => c.name === "item")) return children.map((c) => parseMarkupValue(c.body));
    const obj = {};
    for (const child of children) appendMarkupValue(obj, child.name, parseMarkupValue(child.body));
    return obj;
  }
  const decoded = decodeCDATA(raw).trim();
  const decodedForMarkup = decoded.replace(/<br\s*\/?\s*>/gi, "\n").trim();
  const decodedChildren = findTopLevelXmlElementBlocks(decodedForMarkup);
  if (decodedChildren.length) {
    if (decodedChildren.every((c) => c.name === "item")) return decodedChildren.map((c) => parseMarkupValue(c.body));
    const obj = {};
    for (const child of decodedChildren) appendMarkupValue(obj, child.name, parseMarkupValue(child.body));
    return obj;
  }
  return parseScalarValue(decoded);
}

function parseScalarValue(text) {
  const s = String(text || "").trim();
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  if (/^null$/i.test(s)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { return JSON.parse(s); } catch (_) {}
  }
  if (s.startsWith("{") && /}\s*,\s*{/.test(s) && s.endsWith("}")) {
    try { return JSON.parse(`[${s}]`); } catch (_) {}
  }
  return decodeXmlEntities(s);
}

function decodeCDATA(text) {
  const raw = String(text || "");
  const closed = raw.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, (_m, body) => body);
  if (closed !== raw) return closed;
  if (raw.startsWith("<![CDATA[")) return raw.slice("<![CDATA[".length);
  return raw;
}

function decodeXmlEntities(text) {
  return String(text || "").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function appendMarkupValue(obj, key, value) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    if (Array.isArray(obj[key])) obj[key].push(value);
    else obj[key] = [obj[key], value];
  } else {
    obj[key] = value;
  }
}

function parseTagAttributes(attrs) {
  const out = {};
  const re = /\b([a-z0-9_:-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(String(attrs || ""))) !== null) out[m[1]] = decodeXmlEntities(m[3] != null ? m[3] : m[4] || "");
  const bare = /\b([a-z0-9_:-]+)\s*=\s*([^\s"'=<>`]+)/gi;
  while ((m = bare.exec(String(attrs || ""))) !== null) if (!(m[1] in out)) out[m[1]] = decodeXmlEntities(m[2] || "");
  return out;
}

function findXmlElementBlocks(text, tag) {
  const source = String(text || "");
  const name = String(tag || "").toLowerCase();
  const out = [];
  let pos = 0;
  while (pos < source.length) {
    const start = findNextXmlTag(source, name, pos, false);
    if (!start) break;
    let depth = 1;
    let seek = start.end + 1;
    let end = null;
    while (seek < source.length) {
      const next = findNextXmlTag(source, name, seek, null);
      if (!next) break;
      if (next.selfClosing) { seek = next.end + 1; continue; }
      if (next.closing) depth -= 1;
      else depth += 1;
      if (depth === 0) { end = next; break; }
      seek = next.end + 1;
    }
    if (!end) { pos = start.end + 1; continue; }
    out.push({ name, attrs: start.attrs, body: source.slice(start.end + 1, end.start), start: start.start, end: end.end + 1 });
    pos = end.end + 1;
  }
  return out;
}

function findTopLevelXmlElementBlocks(text) {
  const source = String(text || "");
  const out = [];
  let pos = 0;
  while (pos < source.length) {
    const start = findNextAnyXmlTag(source, pos, false);
    if (!start) break;
    if (start.start > pos && source.slice(pos, start.start).trim()) break;
    if (start.selfClosing) { out.push({ name: start.name, attrs: start.attrs, body: "", start: start.start, end: start.end + 1 }); pos = start.end + 1; continue; }
    let depth = 1;
    let seek = start.end + 1;
    let end = null;
    while (seek < source.length) {
      const next = findNextXmlTag(source, start.name, seek, null);
      if (!next) break;
      if (next.selfClosing) { seek = next.end + 1; continue; }
      if (next.closing) depth -= 1;
      else depth += 1;
      if (depth === 0) { end = next; break; }
      seek = next.end + 1;
    }
    if (!end) break;
    out.push({ name: start.name, attrs: start.attrs, body: source.slice(start.end + 1, end.start), start: start.start, end: end.end + 1 });
    pos = end.end + 1;
  }
  if (pos < source.length && source.slice(pos).trim()) return [];
  return out;
}

function findNextXmlTag(text, tag, from, closing) {
  const wanted = String(tag || "").toLowerCase();
  for (let i = Math.max(0, from || 0); i < text.length;) {
    i = text.indexOf("<", i);
    if (i < 0) return null;
    const cdataEnd = skipCDATAAt(text, i);
    if (cdataEnd > i) { i = cdataEnd; continue; }
    const tagInfo = scanXmlTagAt(text, i);
    if (tagInfo && tagInfo.name === wanted && (closing === null || tagInfo.closing === closing)) return tagInfo;
    i += 1;
  }
  return null;
}

function findNextAnyXmlTag(text, from, closing) {
  for (let i = Math.max(0, from || 0); i < text.length;) {
    i = text.indexOf("<", i);
    if (i < 0) return null;
    const cdataEnd = skipCDATAAt(text, i);
    if (cdataEnd > i) { i = cdataEnd; continue; }
    const tagInfo = scanXmlTagAt(text, i);
    if (tagInfo && (closing === null || tagInfo.closing === closing)) return tagInfo;
    i += 1;
  }
  return null;
}

function skipCDATAAt(text, i) {
  if (!text.startsWith("<![CDATA[", i)) return i;
  const end = text.indexOf("]]>", i + 9);
  return end < 0 ? i : end + 3;
}

function scanXmlTagAt(text, i) {
  if (text[i] !== "<") return null;
  let p = i + 1;
  let closing = false;
  if (text[p] === "/") { closing = true; p += 1; }
  const m = /^[A-Za-z_][A-Za-z0-9_:-]*/.exec(text.slice(p));
  if (!m) return null;
  const name = m[0].toLowerCase();
  p += m[0].length;
  if (p < text.length && !/[\s/>]/.test(text[p])) return null;
  const end = findXmlTagEnd(text, p);
  if (end < 0) return null;
  const attrsEnd = text[end - 1] === "/" ? end - 1 : end;
  return { name, closing, selfClosing: !closing && text[end - 1] === "/", start: i, end, attrs: text.slice(p, attrsEnd) };
}

function findXmlTagEnd(text, from) {
  let quote = "";
  for (let i = Math.max(0, from || 0); i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") return i;
  }
  return -1;
}

// ─── Google 原生 API 辅助函数 ────────────────────────────────────────────────
function buildGoogleToolPrompt(toolDefs, req) {
  return buildToolPromptBlock(toolDefs, googleToolChoiceInstruction(req));
}

function googleToolChoiceInstruction(req) {
  const fc = googleFunctionCallingConfig(req);
  const mode = String(fc.mode || "AUTO").trim().toUpperCase();
  const allowed = googleAllowedFunctionNames(fc);
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
function googleContentsToPrompt(req, toolDefsOverride) {
  const parts = [];
  const images = [];

  const fcMode = String(googleFunctionCallingConfig(req).mode || "AUTO").trim().toUpperCase();
  const tools = req.tools;
  const toolDefs = Array.isArray(toolDefsOverride) ? toolDefsOverride : [];
  if (!Array.isArray(toolDefsOverride) && tools && fcMode !== "NONE") {
    for (const group of tools) {
      for (const fn of googleFunctionDeclarations(group)) {
        const td = { name: fn.name || "", description: fn.description || "" };
        const params = fn.parameters || fn.parametersJsonSchema || fn.parameters_json_schema;
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
        parts.push(sysText + "\n\n" + buildGoogleToolPrompt(toolDefs, req));
      } else {
        parts.push(sysText);
      }
    }
  } else if (toolDefs.length) {
    parts.push(buildGoogleToolPrompt(toolDefs, req));
  }

  for (const content of req.contents || []) {
    const role = content.role || "user";
    const msgParts = [];
    for (const p of content.parts || []) {
      if (p.text) {
        msgParts.push(p.text);
      } else if (p.inlineData || p.inline_data) {
        const inlineData = p.inlineData || p.inline_data || {};
        images.push({
          b64: inlineData.data,
          mime: inlineData.mimeType || inlineData.mime_type || "image/png",
          filename: imageFilenameFromObject(p),
        });
      } else if (p.functionCall) {
        const fc = p.functionCall;
        msgParts.push(formatPromptToolCallBlock(fc.name, fc.args || {}));
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

/** 提取 DSML/XML 或旧 ```function_call``` 代码块 -> [cleanText, functionCalls]。 */
function parseGoogleFunctionCalls(text, toolsRaw) {
  const parsed = parseDSMLToolCallsDetailed(text);
  if (parsed.calls.length) {
    const normalized = normalizeParsedToolCallsForSchemas(parsed.calls, toolsRaw);
    return [parsed.cleanText, normalized.map((c) => ({ name: c.name, args: c.input || {} }))];
  }

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
          functionCalls.push({ name: data.name, args: data.args != null ? data.args : data.arguments != null ? data.arguments : data.input != null ? data.input : {} });
        }
      } catch (_) { /* 跳过 */ }
    }
    clean = clean.replace(new RegExp(pat.source, pat.flags), "").trim();
  }
  if (!functionCalls.length && clean.trim().startsWith("{")) {
    try {
      const data = JSON.parse(clean.trim());
      if (data && "name" in data && ("args" in data || "arguments" in data || "input" in data)) {
        functionCalls.push({ name: data.name, args: data.args != null ? data.args : data.arguments != null ? data.arguments : data.input });
        clean = "";
      }
    } catch (_) { /* skip */ }
  }
  const normalized = normalizeParsedToolCallsForSchemas(functionCalls.map((fc) => ({ name: fc.name, input: fc.args || {} })), toolsRaw);
  return [clean, normalized.map((c) => ({ name: c.name, args: c.input || {} }))];
}

// ─── HTTP 辅助函数 ──────────────────────────────────────────────────────────────
const DEFAULT_CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "OpenAI-Organization",
  "OpenAI-Project",
  "OpenAI-Beta",
  "X-API-Key",
  "X-Goog-Api-Key",
  "Anthropic-Version",
  "Anthropic-Beta",
  "X-Stainless-OS",
  "X-Stainless-Arch",
  "X-Stainless-Lang",
  "X-Stainless-Package-Version",
  "X-Stainless-Runtime",
  "X-Stainless-Runtime-Version",
  "X-Client-Version",
  "X-Requested-With",
  "HTTP-Referer",
  "X-Title",
];
const BLOCKED_CORS_REQUEST_HEADERS = new Set(["x-ds2-internal-token"]);

function corsHeaders(request) {
  const origin = request && request.headers ? String(request.headers.get("Origin") || "").trim() : "";
  const headers = {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": buildCORSAllowHeaders(request),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
  };
  if (request && request.headers && /^true$/i.test(String(request.headers.get("Access-Control-Request-Private-Network") || "").trim())) {
    headers["Access-Control-Allow-Private-Network"] = "true";
  }
  return headers;
}

function buildCORSAllowHeaders(request) {
  const names = [];
  const seen = new Set();
  const append = (name) => {
    name = String(name || "").trim();
    if (!isValidCORSHeaderToken(name)) return;
    const key = name.toLowerCase();
    if (BLOCKED_CORS_REQUEST_HEADERS.has(key) || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };
  for (const name of DEFAULT_CORS_ALLOW_HEADERS) append(name);
  const requested = request && request.headers ? request.headers.get("Access-Control-Request-Headers") : "";
  for (const name of splitCORSRequestHeaders(requested)) append(name);
  return names.join(", ");
}

function splitCORSRequestHeaders(raw) {
  if (!String(raw || "").trim()) return [];
  return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
}

function isValidCORSHeaderToken(v) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(String(v || ""));
}

function withCORS(response, request) {
  if (!(response instanceof Response)) return response;
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function openAIErrorType(status) {
  switch (status) {
    case 400: return "invalid_request_error";
    case 401: return "authentication_error";
    case 403: return "permission_error";
    case 429: return "rate_limit_error";
    case 503: return "service_unavailable_error";
    default: return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

function openAIErrorResponse(message, status = 400, code) {
  return jsonResponse({
    error: {
      message,
      type: openAIErrorType(status),
      code: code || null,
      param: null,
    },
  }, status);
}

function openAIUpstreamErrorResponse(e) {
  return openAIErrorResponse(`upstream error: ${upstreamErrorMessage(e)}`, 502, upstreamErrorCode(e));
}

function streamErrorText(e, prefix = "upstream error") {
  const code = upstreamErrorCode(e);
  return `⚠️ ${prefix}: ${upstreamErrorMessage(e)}${code ? ` [${code}]` : ""}`;
}

function streamInterruptedWarningText(e) {
  return streamErrorText(e, "stream interrupted after partial output");
}

function streamWarningObject(e, message) {
  return {
    code: upstreamErrorCode(e) || "stream_interrupted",
    message: message || streamInterruptedWarningText(e),
  };
}

function writeStreamWarningEvent(write, e, message) {
  write(`event: warning\ndata: ${JSON.stringify({ warning: streamWarningObject(e, message) })}\n\n`);
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_) {
    return { ok: false, value: undefined };
  }
}

function parseJson(text, fallback = null) {
  const parsed = tryParseJson(text);
  return parsed.ok ? parsed.value : fallback;
}

function parseJsonObject(text) {
  const value = parseJson(text, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function readJsonRequest(request) {
  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch (e) {
    return { error: `failed to read request body: ${(e && e.message) || e}`, status: 400 };
  }
  let bodyText;
  try {
    bodyText = UTF8_FATAL_DECODER.decode(buf);
  } catch (_) {
    return { error: "invalid UTF-8 request body", status: 400 };
  }
  const parsed = tryParseJson(bodyText);
  if (!parsed.ok) return { error: "invalid JSON", status: 400 };
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { error: "request body must be a JSON object", status: 400 };
  }
  return { value: parsed.value, text: bodyText };
}

// 从多种来源取调用方 key:Bearer / x-api-key / x-goog-api-key / ?key=
// (分别兼容 OpenAI 客户端、Anthropic 风格、Gemini CLI)。任一匹配即放行。
function authorized(request, url, cfg) {
  const keys = cfg.api_keys || [];
  if (!keys.length) return true;
  const h = request.headers;
  const auth = h.get("authorization") || "";
  const bearer = /^\s*Bearer\s+(.+?)\s*$/i.exec(auth);
  const candidates = [
    bearer ? bearer[1] : null,
    h.get("x-api-key"),
    h.get("x-goog-api-key"),
    url ? url.searchParams.get("key") : null,
  ];
  return candidates.some((k) => k && keys.includes(k));
}

/**
 * 构造一个 SSE 响应,响应体由 `producer(write)` 生成。
 * `write(str)` 会入队一个 UTF-8 分块。producer 结束后流会自动关闭。
 */
function sseResponse(producer, options = {}) {
  const ac = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const write = (s) => {
        if (closed) return;
        try { controller.enqueue(TEXT_ENCODER.encode(s)); } catch (_) { closed = true; }
      };
      const keepAlive = setInterval(() => write(": keep-alive\n\n"), 15000);
      try {
        await producer(write, ac.signal);
      } catch (e) {
        if (isAbortError(e) || ac.signal.aborted) return;
        if (typeof options.onError === "function") {
          try { await options.onError(write, e); } catch (_) {}
        } else {
          write(`event: error\ndata: ${JSON.stringify({ error: { message: upstreamErrorMessage(e), code: upstreamErrorCode(e) || "stream_error" } })}\n\n`);
        }
      } finally {
        closed = true;
        clearInterval(keepAlive);
        try { controller.close(); } catch (_) {}
      }
    },
    cancel() {
      try { ac.abort("client disconnected"); } catch (_) {}
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

const MIN_DELTA_FLUSH_CHARS = 16;
const MAX_DELTA_FLUSH_WAIT_MS = 20;

function createDeltaCoalescer(sendDeltaFrame, minFlushChars = MIN_DELTA_FLUSH_CHARS, maxFlushWaitMs = MAX_DELTA_FLUSH_WAIT_MS) {
  let pendingField = "";
  let pendingText = "";
  let flushTimer = null;

  const clearFlushTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const flush = () => {
    clearFlushTimer();
    if (!pendingField || !pendingText) return;
    const delta = { [pendingField]: pendingText };
    pendingField = "";
    pendingText = "";
    sendDeltaFrame(delta);
  };

  const scheduleFlush = () => {
    if (flushTimer || maxFlushWaitMs <= 0) return;
    flushTimer = setTimeout(flush, maxFlushWaitMs);
  };

  const append = (field, text) => {
    if (!field || !text) return;
    if (pendingField && pendingField !== field) flush();
    pendingField = field;
    pendingText += text;
    if (codePointLengthAtLeast(pendingText, minFlushChars)) {
      flush();
      return;
    }
    scheduleFlush();
  };

  return { append, flush };
}

// ─── 处理函数 ──────────────────────────────────────────────────────────────────

// 上游返回为空时给客户端的可见提示(否则像 Cherry 这类客户端会“无返回”)。
// 线上常见原因:部署在 Cloudflare/无服务器平台时,出口 IP 被 Google 区别对待
// (本地能跑、线上空);其次是 GEMINI_BL 过期。用 `wrangler tail` 看上游状态。
const EMPTY_UPSTREAM_MSG =
  "⚠️ Upstream Gemini returned an empty response. " +
  "If this Worker runs on Cloudflare/serverless, Google may be blocking the egress IP " +
  "(works locally but empty in production); also verify GEMINI_BL is current. " +
  "Run `wrangler tail` to see the upstream status.";

function upstreamEmptyWarning(cfg) {
  return {
    code: "upstream_empty",
    message: EMPTY_UPSTREAM_MSG,
    gemini_bl: cfg && cfg.gemini_bl,
  };
}

function openAIChatChunk(id, model, delta, finishReason) {
  return {
    id,
    object: "chat.completion.chunk",
    created: nowSec(),
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason == null ? null : finishReason }],
  };
}

function openAIChatUsageFromCompletionTokens(promptTokens, completionTokens) {
  promptTokens = Math.max(0, Number(promptTokens) || 0);
  completionTokens = Math.max(0, Number(completionTokens) || 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function writeOpenAIChatUsageTokenChunk(write, id, model, promptTokens, completionTokens) {
  write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: nowSec(),
    model,
    choices: [],
    usage: openAIChatUsageFromCompletionTokens(promptTokens, completionTokens),
  })}\n\n`);
}

function writeOpenAIChatStreamError(write, id, model, e) {
  write(`data: ${JSON.stringify(openAIChatChunk(id, model, { content: streamErrorText(e) }, null))}\n\n`);
  write(`data: ${JSON.stringify(openAIChatChunk(id, model, {}, "stop"))}\n\n`);
  write("data: [DONE]\n\n");
}

function writeGoogleStreamError(write, model, e) {
  write(`data: ${JSON.stringify({
    error: { message: upstreamErrorMessage(e), code: upstreamErrorCode(e) || "upstream_error" },
    modelVersion: model,
  })}\n\n`);
}

async function runGeminiCompletionText(cfg, prompt, rm, fileRefs) {
  return generate(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
}

function finalizeOpenAICompletionResult(text, options) {
  const { tools, promptToolChoice, structured, toolPolicy } = options || {};
  let outText = text || "";
  let toolCalls = null;

  if (tools && outText && promptToolChoice !== "none") {
    const [clean, tc] = parseToolCalls(outText, tools);
    outText = clean;
    toolCalls = tc.length ? tc : null;
  }
  if (!toolCalls && structured) {
    const finalized = finalizeStructuredOutputText(outText, structured);
    if (finalized.error) {
      return { error: { message: finalized.error, status: 502, code: "structured_output_validation_failed" } };
    }
    outText = finalized.text;
  }
  const violation = validateRequiredToolCalls(toolPolicy, toolCalls);
  if (violation) {
    return { error: { message: violation.message, status: 422, code: violation.code } };
  }
  return {
    text: outText,
    toolCalls,
    upstreamEmpty: !outText && !toolCalls,
  };
}

function openAIResponsesUsage(promptTokens, outputText) {
  const inputTokens = Math.max(0, Number(promptTokens) || 0);
  const outputTokens = tokenEst(outputText);
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

function buildResponsesOutput(text, toolCalls, mid) {
  const output = [];
  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
    }
  }
  if (text || !toolCalls) {
    output.push({ type: "message", id: mid, role: "assistant", status: "completed", content: [{ type: "output_text", text: text || "", annotations: [] }] });
  }
  return output;
}

async function streamOpenAIChatWithToolSieve(write, cfg, params) {
  const { id, model, prompt, rm, fileRefs, tools, toolPolicy, includeUsage, promptTokens, signal } = params;
  const state = createToolSieveState();
  let emittedText = false;
  let errMsg = "";
  let streamErr = null;
  const completionTokenCounter = createTokenCounter();
  const writeChunk = (delta, finish) => write(`data: ${JSON.stringify(openAIChatChunk(id, model, delta, finish))}\n\n`);
  const deltaCoalescer = createDeltaCoalescer((delta) => writeChunk(delta, null));
  writeChunk({ role: "assistant" }, null);
  try {
    for await (const deltaText of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs, { signal })) {
      for (const text of processToolSieveChunk(state, deltaText)) {
        if (!text) continue;
        emittedText = true;
        completionTokenCounter.append(text);
        deltaCoalescer.append("content", text);
      }
    }
  } catch (e) {
    if (isAbortError(e)) throw e;
    streamErr = e;
    errMsg = streamErrorText(e);
  } finally {
    deltaCoalescer.flush();
  }

  const flushed = flushToolSieve(state, tools);
  let toolCalls = flushed.toolCalls;
  if (flushed.text) {
    emittedText = true;
    completionTokenCounter.append(flushed.text);
    deltaCoalescer.append("content", flushed.text);
    deltaCoalescer.flush();
  }

  const violation = validateRequiredToolCalls(toolPolicy, toolCalls);
  if (violation) {
    deltaCoalescer.flush();
    completionTokenCounter.append(violation.message);
    writeChunk({ content: violation.message }, null);
    writeChunk({}, "stop");
    if (includeUsage) writeOpenAIChatUsageTokenChunk(write, id, model, promptTokens, completionTokenCounter.tokens());
    write("data: [DONE]\n\n");
    return;
  }
  if (toolCalls && toolCalls.length) {
    deltaCoalescer.flush();
    if (streamErr) writeStreamWarningEvent(write, streamErr);
    const toolCallDeltas = formatOpenAIStreamToolCalls(toolCalls.map((tc) => ({
      name: tc.function && tc.function.name,
      input: parseJsonObject(tc.function && tc.function.arguments),
    })), new Map(), tools);
    writeChunk({ tool_calls: toolCallDeltas }, "tool_calls");
    completionTokenCounter.append(JSON.stringify(toolCalls));
  } else {
    if (!emittedText) {
      const note = errMsg || EMPTY_UPSTREAM_MSG;
      completionTokenCounter.append(note);
      writeChunk({ content: note }, null);
    } else if (streamErr) {
      const warning = "\n\n" + streamInterruptedWarningText(streamErr);
      writeStreamWarningEvent(write, streamErr, warning.trim());
      completionTokenCounter.append(warning);
      writeChunk({ content: warning }, null);
    }
    writeChunk({}, "stop");
  }
  if (includeUsage) writeOpenAIChatUsageTokenChunk(write, id, model, promptTokens, completionTokenCounter.tokens());
  write("data: [DONE]\n\n");
}

async function streamGoogleWithToolSieve(write, cfg, params) {
  const { prompt, rm, fileRefs, tools, effectiveReq, promptTokens, signal } = params;
  const state = createToolSieveState();
  const candidateTokenCounter = createTokenCounter();
  let emittedText = false;
  let errMsg = "";
  let streamErr = null;
  const writeCandidate = (parts, finishReason) => {
    const candidate = { index: 0 };
    if (parts && parts.length) candidate.content = { parts, role: "model" };
    if (finishReason) candidate.finishReason = finishReason;
    write(`data: ${JSON.stringify({ candidates: [candidate], modelVersion: rm.name })}\n\n`);
  };

  try {
    for await (const deltaText of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs, { signal })) {
      for (const piece of processToolSieveChunk(state, deltaText)) {
        if (!piece) continue;
        emittedText = true;
        candidateTokenCounter.append(piece);
        writeCandidate([{ text: piece }], null);
      }
    }
  } catch (e) {
    if (isAbortError(e)) throw e;
    streamErr = e;
    errMsg = streamErrorText(e);
  }

  const buffered = state ? state.buffer : "";
  let [clean, functionCalls] = parseGoogleFunctionCalls(buffered, tools);
  if (clean) {
    emittedText = true;
    candidateTokenCounter.append(clean);
    writeCandidate([{ text: clean }], null);
  }

  const violation = validateGoogleFunctionCalls(effectiveReq, functionCalls);
  if (violation) {
    candidateTokenCounter.append(violation.message);
    writeCandidate([{ text: violation.message }], null);
    writeCandidate(null, "STOP");
    return;
  }
  if (functionCalls && functionCalls.length) {
    if (streamErr) writeStreamWarningEvent(write, streamErr);
    writeCandidate(functionCalls.map((fc) => ({ functionCall: { name: fc.name, args: fc.args || {} } })), null);
  } else if (!emittedText) {
    const note = errMsg || EMPTY_UPSTREAM_MSG;
    candidateTokenCounter.append(note);
    writeCandidate([{ text: note }], null);
  } else if (streamErr) {
    const warning = "\n\n" + streamInterruptedWarningText(streamErr);
    writeStreamWarningEvent(write, streamErr, warning.trim());
    candidateTokenCounter.append(warning);
    writeCandidate([{ text: warning }], null);
  }
  const candidateTokens = candidateTokenCounter.tokens();
  write(`data: ${JSON.stringify({
    candidates: [{ finishReason: "STOP", index: 0 }],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: candidateTokens,
      totalTokenCount: promptTokens + candidateTokens,
    },
    modelVersion: rm.name,
  })}\n\n`);
}

// POST /v1/chat/completions
async function handleChat(req, cfg) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return openAIErrorResponse(rm.error, 400);

  const structured = buildStructuredOutputRequirement(getStructuredResponseFormat(req));
  if (structured && structured.error) return openAIErrorResponse(structured.error, 400, "invalid_response_format");

  const rawTools = Array.isArray(req.tools) ? req.tools : null;
  const toolPolicy = parseOpenAIToolChoicePolicy(req.tool_choice != null ? req.tool_choice : "auto", rawTools);
  if (toolPolicy.error) return openAIErrorResponse(toolPolicy.error, 400, "invalid_tool_choice");
  const tools = filterToolsByPolicy(rawTools, toolPolicy);
  const promptToolChoice = toolPolicy.mode === "none" ? "none" : (toolPolicy.mode === "required" || toolPolicy.mode === "forced" ? "required" : "auto");
  const messages = req.messages || [];
  const ctx = await prepareOpenAIGeminiContext(cfg, req, messages, tools, promptToolChoice, toolPolicy, structured);
  if (ctx.error) return openAIErrorResponse(upstreamErrorMessage(ctx.error), 502, upstreamErrorCode(ctx.error));
  const { prompt, fileRefs, promptTokens } = ctx;
  if (!prompt.trim()) return openAIErrorResponse("empty prompt", 400);

  const stream = req.stream || false;
  if (stream && structured && cfg.structured_output_stream_mode !== "best_effort") {
    return openAIErrorResponse("response_format with stream is not supported by this worker because final JSON cannot be validated while streaming", 400, "unsupported_response_format_stream");
  }
  const cid = `chatcmpl-${randHex(12)}`;
  const includeStreamUsage = !!(req.stream_options && req.stream_options.include_usage);

  if (stream && (!tools || promptToolChoice === "none")) {
    return sseResponse(async (write, signal) => {
      let got = false;
      let errMsg = "";
      let streamErr = null;
      const completionTokenCounter = createTokenCounter();
      const chunk = (delta, finish) => write(`data: ${JSON.stringify({
        id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      const deltaCoalescer = createDeltaCoalescer((delta) => chunk(delta, null));
      chunk({ role: "assistant" }, null);
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs, { signal })) {
          got = true;
          completionTokenCounter.append(delta);
          deltaCoalescer.append("content", delta);
        }
      } catch (e) {
        if (isAbortError(e)) throw e;
        streamErr = e;
        errMsg = streamErrorText(e);
      } finally {
        deltaCoalescer.flush();
        if (!got) {
          const note = errMsg || EMPTY_UPSTREAM_MSG;
          completionTokenCounter.append(note);
          log(cfg, `chat stream produced no content -> ${note}`);
          chunk({ content: note }, null); // 让客户端看到原因,而非空白
        } else if (streamErr) {
          const warning = "\n\n" + streamInterruptedWarningText(streamErr);
          writeStreamWarningEvent(write, streamErr, warning.trim());
          completionTokenCounter.append(warning);
          chunk({ content: warning }, null);
        }
        chunk({}, "stop");
        if (includeStreamUsage) writeOpenAIChatUsageTokenChunk(write, cid, rm.name, promptTokens, completionTokenCounter.tokens());
        write("data: [DONE]\n\n");
      }
    }, { onError: (write, e) => writeOpenAIChatStreamError(write, cid, rm.name, e) });
  }

  if (stream && tools && promptToolChoice !== "none") {
    return sseResponse(async (write, signal) => {
      await streamOpenAIChatWithToolSieve(write, cfg, {
        id: cid,
        model: rm.name,
        prompt,
        rm,
        fileRefs,
        tools,
        toolPolicy,
        includeUsage: includeStreamUsage,
        promptTokens,
        signal,
      });
    }, { onError: (write, e) => writeOpenAIChatStreamError(write, cid, rm.name, e) });
  }

  let text;
  try {
    text = await runGeminiCompletionText(cfg, prompt, rm, fileRefs);
  } catch (e) {
    return openAIUpstreamErrorResponse(e);
  }

  const finalized = finalizeOpenAICompletionResult(text, { tools, promptToolChoice, structured, toolPolicy });
  if (finalized.error) return openAIErrorResponse(finalized.error.message, finalized.error.status, finalized.error.code);
  let { toolCalls, upstreamEmpty } = finalized;
  text = finalized.text;
  if (!text && !toolCalls) {
    upstreamEmpty = true;
    log(cfg, "chat non-stream produced no content (empty upstream)");
    text = EMPTY_UPSTREAM_MSG; // 可见提示,避免客户端“无返回”
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
    }, { onError: (write, e) => writeOpenAIChatStreamError(write, cid, rm.name, e) });
  }

  const payload = {
    id: cid, object: "chat.completion", created: nowSec(), model: rm.name,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: (() => {
      const completionTokens = tokenEst(text);
      return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    })(),
  };
  if (upstreamEmpty) payload.warning = upstreamEmptyWarning(cfg);
  return jsonResponse(payload);
}

function writeResponsesEvent(write, event, payload) {
  write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...(payload || {}) })}\n\n`);
}

async function streamResponsesWithToolSieve(write, cfg, params) {
  const { rid, rm, prompt, fileRefs, tools, toolPolicy, promptTokens, signal } = params;
  const output = [];
  const state = tools ? createToolSieveState() : null;
  const mid = `msg_${randHex(12)}`;
  let text = "";
  const outputTokenCounter = createTokenCounter();
  let messageStarted = false;
  let contentStarted = false;
  let outputIndex = 0;

  const fail = (message, code) => {
    writeResponsesEvent(write, "response.failed", {
      response: { id: rid, object: "response", status: "failed", model: rm.name, output, error: { message, code: code || "upstream_error" } },
    });
  };
  const startMessage = () => {
    if (!messageStarted) {
      messageStarted = true;
      const item = { type: "message", id: mid, role: "assistant", status: "in_progress", content: [] };
      output.push(item);
      writeResponsesEvent(write, "response.output_item.added", { output_index: outputIndex, item });
    }
    if (!contentStarted) {
      contentStarted = true;
      writeResponsesEvent(write, "response.content_part.added", { item_id: mid, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    }
  };
  const emitText = (piece) => {
    if (!piece) return;
    startMessage();
    text += piece;
    outputTokenCounter.append(piece);
    writeResponsesEvent(write, "response.output_text.delta", { item_id: mid, output_index: outputIndex, content_index: 0, delta: piece });
  };
  const finishMessage = () => {
    if (!messageStarted) return;
    const item = output.find((it) => it.id === mid);
    const part = { type: "output_text", text, annotations: [] };
    if (item) { item.status = "completed"; item.content = [part]; }
    if (contentStarted) {
      writeResponsesEvent(write, "response.output_text.done", { item_id: mid, content_index: 0, text });
      writeResponsesEvent(write, "response.content_part.done", { item_id: mid, output_index: outputIndex, content_index: 0, part });
    }
    writeResponsesEvent(write, "response.output_item.done", { output_index: outputIndex, item });
    outputIndex += 1;
  };

  writeResponsesEvent(write, "response.created", { response: { id: rid, object: "response", status: "in_progress", model: rm.name, output: [] } });
  writeResponsesEvent(write, "response.in_progress", { response: { id: rid, object: "response", status: "in_progress", model: rm.name, output: [] } });
  try {
    for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs, { signal })) {
      if (!delta) continue;
      if (!tools) { emitText(delta); continue; }
      for (const piece of processToolSieveChunk(state, delta)) emitText(piece);
    }
  } catch (e) {
    if (isAbortError(e)) throw e;
    if (!text) {
      fail(`upstream error: ${upstreamErrorMessage(e)}`, upstreamErrorCode(e) || "upstream_error");
      return;
    }
    const warning = "\n\n" + streamInterruptedWarningText(e);
    writeResponsesEvent(write, "response.warning", { warning: streamWarningObject(e, warning.trim()) });
    emitText(warning);
  }

  let toolCalls = null;
  if (tools) {
    const flushed = flushToolSieve(state, tools);
    emitText(flushed.text || "");
    toolCalls = flushed.toolCalls;
  }
  const violation = validateRequiredToolCalls(toolPolicy, toolCalls);
  if (violation) { fail(violation.message, violation.code); return; }
  if (!text && !toolCalls) emitText(EMPTY_UPSTREAM_MSG);
  finishMessage();

  if (toolCalls && toolCalls.length) {
    for (const tc of toolCalls) {
      const args = String((tc.function && tc.function.arguments) || "");
      const item = { type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: "", status: "in_progress" };
      output.push(item);
      writeResponsesEvent(write, "response.output_item.added", { output_index: outputIndex, item });
      if (args) writeResponsesEvent(write, "response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, call_id: item.call_id, delta: args });
      item.arguments = args;
      item.status = "completed";
      writeResponsesEvent(write, "response.function_call_arguments.done", { item_id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments });
      writeResponsesEvent(write, "response.output_item.done", { output_index: outputIndex, item });
      outputIndex += 1;
    }
  }

  const inputTokens = Math.max(0, Number(promptTokens) || 0);
  const outputTokens = outputTokenCounter.tokens();
  const usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
  writeResponsesEvent(write, "response.completed", { response: { id: rid, object: "response", status: "completed", model: rm.name, output, usage } });
}

// POST /v1/responses(Codex CLI 用)
async function handleResponses(req, cfg) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return openAIErrorResponse(rm.error, 400);

  const structured = buildStructuredOutputRequirement(getStructuredResponseFormat(req));
  if (structured && structured.error) return openAIErrorResponse(structured.error, 400, "invalid_response_format");

  let tools = req.tools;
  const messages = normalizeResponsesInputAsMessages(req);

  if (tools) {
    tools = tools.map((t) =>
      t.type === "function" && !("function" in t)
        ? { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } }
        : t
    );
  }

  const rawTools = Array.isArray(tools) ? tools : null;
  const toolPolicy = parseOpenAIToolChoicePolicy(req.tool_choice != null ? req.tool_choice : "auto", rawTools);
  if (toolPolicy.error) return openAIErrorResponse(toolPolicy.error, 400, "invalid_tool_choice");
  tools = filterToolsByPolicy(rawTools, toolPolicy);
  const promptToolChoice = toolPolicy.mode === "none" ? "none" : (toolPolicy.mode === "required" || toolPolicy.mode === "forced" ? "required" : "auto");
  const ctx = await prepareOpenAIGeminiContext(cfg, req, messages, tools, promptToolChoice, toolPolicy, structured);
  if (ctx.error) return openAIErrorResponse(upstreamErrorMessage(ctx.error), 502, upstreamErrorCode(ctx.error));
  const { prompt, fileRefs, promptTokens } = ctx;
  if (!prompt.trim()) return openAIErrorResponse("empty input", 400);

  if (req.stream && structured && cfg.structured_output_stream_mode !== "best_effort") {
    return openAIErrorResponse("response_format with stream is not supported by this worker because final JSON cannot be validated while streaming", 400, "unsupported_response_format_stream");
  }

  if (req.stream) {
    const rid = `resp_${randHex(16)}`;
    return sseResponse(async (write, signal) => {
      await streamResponsesWithToolSieve(write, cfg, {
        rid,
        rm,
        prompt,
        fileRefs,
        tools: tools && promptToolChoice !== "none" ? tools : null,
        toolPolicy,
        promptTokens,
        signal,
      });
    }, {
      onError: (write, e) => writeResponsesEvent(write, "response.failed", {
        response: { id: rid, object: "response", status: "failed", model: rm.name, output: [], error: { message: upstreamErrorMessage(e), code: upstreamErrorCode(e) || "stream_error" } },
      }),
    });
  }

  let text;
  try {
    text = await runGeminiCompletionText(cfg, prompt, rm, fileRefs);
  } catch (e) {
    return openAIUpstreamErrorResponse(e);
  }

  const finalized = finalizeOpenAICompletionResult(text, { tools, promptToolChoice, structured, toolPolicy });
  if (finalized.error) return openAIErrorResponse(finalized.error.message, finalized.error.status, finalized.error.code);
  let { toolCalls, upstreamEmpty } = finalized;
  text = finalized.text;

  const rid = `resp_${randHex(16)}`;
  const mid = `msg_${randHex(12)}`;
  if (!text && !toolCalls) {
    upstreamEmpty = true;
    text = EMPTY_UPSTREAM_MSG;
  }
  const output = buildResponsesOutput(text, toolCalls, mid);

  const usage = openAIResponsesUsage(promptTokens, text);

  const payload = { id: rid, object: "response", created_at: nowSec(), status: "completed", model: rm.name, output, usage };
  if (upstreamEmpty) payload.warning = upstreamEmptyWarning(cfg);
  return jsonResponse(payload);
}

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
async function handleGoogleGenerate(req, cfg, path, stream) {
  const m = /\/v(?:1beta|1)\/models\/([^:?/]+)/.exec(path);
  const modelFromPath = m ? decodeURIComponent(m[1]).replace(/^models\//, "") : cfg.default_model;
  const rm = resolveModel(modelFromPath || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const fcMode = String(googleFunctionCallingConfig(req).mode || "AUTO").trim().toUpperCase();
  const effectiveGoogleTools = filterGoogleToolsByConfig(req.tools, req);
  const effectiveReq = effectiveGoogleTools === req.tools ? req : { ...req, tools: effectiveGoogleTools || [] };
  const hasTools = !!effectiveGoogleTools && fcMode !== "NONE";
  const ctx = await prepareGoogleGeminiContext(cfg, effectiveReq, hasTools);
  if (ctx.error) return jsonResponse({ error: { message: upstreamErrorMessage(ctx.error), code: upstreamErrorCode(ctx.error) || "context_file_upload_failed" } }, 502);
  const { prompt, fileRefs, promptTokens } = ctx;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty content" } }, 400);

  logInfo(cfg, `Google API: model=${rm.name} stream=${stream} tools=${hasTools} prompt_len=${prompt.length}`);

  if (stream && !hasTools) {
    return sseResponse(async (write, signal) => {
      const candidateTokenCounter = createTokenCounter();
      let got = false;
      let streamErr = null;
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs, { signal })) {
          if (!delta) continue;
          got = true;
          candidateTokenCounter.append(delta);
          write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: delta }], role: "model" }, index: 0 }], modelVersion: rm.name })}\n\n`);
        }
      } catch (e) {
        if (isAbortError(e)) throw e;
        streamErr = e;
        if (!got) {
          writeGoogleStreamError(write, rm.name, e);
          return;
        }
        const warning = "\n\n" + streamInterruptedWarningText(e);
        writeStreamWarningEvent(write, e, warning.trim());
        candidateTokenCounter.append(warning);
        write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: warning }], role: "model" }, index: 0 }], modelVersion: rm.name })}\n\n`);
      }
      const candidateTokens = candidateTokenCounter.tokens();
      const donePayload = {
        candidates: [{ finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: candidateTokens, totalTokenCount: promptTokens + candidateTokens },
        modelVersion: rm.name,
      };
      if (streamErr) donePayload.promptFeedback = { warning: streamWarningObject(streamErr) };
      write(`data: ${JSON.stringify(donePayload)}\n\n`);
    }, { onError: (write, e) => writeGoogleStreamError(write, rm.name, e) });
  }

  if (stream && hasTools) {
    return sseResponse(async (write, signal) => {
      await streamGoogleWithToolSieve(write, cfg, {
        prompt,
        rm,
        fileRefs,
        tools: effectiveGoogleTools,
        effectiveReq,
        promptTokens,
        signal,
      });
    }, { onError: (write, e) => writeGoogleStreamError(write, rm.name, e) });
  }

  let text;
  try {
    text = await runGeminiCompletionText(cfg, prompt, rm, fileRefs);
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${upstreamErrorMessage(e)}`, code: upstreamErrorCode(e) || "upstream_error" } }, 502);
  }
  const upstreamEmpty = !text;
  if (upstreamEmpty) log(cfg, "Warning: empty response from Gemini");

  const responseParts = [];
  if (hasTools && text) {
    const [clean, fcs] = parseGoogleFunctionCalls(text, effectiveGoogleTools);
    const googleToolViolation = validateGoogleFunctionCalls(effectiveReq, fcs);
    if (googleToolViolation) return jsonResponse({ error: { message: googleToolViolation.message, code: googleToolViolation.code } }, 422);
    if (fcs.length) {
      if (clean) responseParts.push({ text: clean });
      for (const fc of fcs) responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
    } else {
      responseParts.push({ text });
    }
  } else {
    const googleToolViolation = validateGoogleFunctionCalls(effectiveReq, []);
    if (googleToolViolation) return jsonResponse({ error: { message: googleToolViolation.message, code: googleToolViolation.code } }, 422);
    responseParts.push({ text: text || "I apologize, but I was unable to generate a response. Please try again." });
  }

  const candidateTokens = tokenEst(text);
  const responseObj = {
    candidates: [{ content: { parts: responseParts, role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: candidateTokens, totalTokenCount: promptTokens + candidateTokens },
    modelVersion: rm.name,
  };
  if (upstreamEmpty) responseObj.promptFeedback = { blockReason: "OTHER", warning: upstreamEmptyWarning(cfg) };

  if (stream) {
    return sseResponse(async (write) => { write(`data: ${JSON.stringify(responseObj)}\n\n`); }, { onError: (write, e) => writeGoogleStreamError(write, rm.name, e) });
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
    const respond = (response) => withCORS(response, request);

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    // 鉴权:配置了 API_KEYS 时,除健康检查 "/" 外的所有接口都需要有效 key
    // (含 /v1/* 与 /v1beta/*,防止 Google 原生端点被绕过白嫖)。
    if (path !== "/" && !authorized(request, url, cfg)) {
      return respond(openAIErrorResponse("invalid api key", 401));
    }

    try {
      if (method === "GET") {
        if (path === "/v1/models") {
          return respond(jsonResponse({
            object: "list",
            data: Object.entries(MODELS).map(([n, c]) => ({ id: n, object: "model", created: 1700000000, owned_by: "google", description: c.desc })),
          }));
        }
        if (path.startsWith("/v1/models/")) {
          const id = decodeURIComponent(path.slice("/v1/models/".length));
          const cfgModel = MODELS[id];
          if (!cfgModel) return respond(openAIErrorResponse(`model ${id} is not available`, 404, "model_not_found"));
          return respond(jsonResponse({ id, object: "model", created: 1700000000, owned_by: "google", description: cfgModel.desc }));
        }
        if (path.startsWith("/v1beta/models")) {
          return respond(jsonResponse({
            models: Object.entries(MODELS).map(([n, c]) => ({ name: `models/${n}`, displayName: n, description: c.desc, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] })),
          }));
        }
        if (path === "/") {
          return respond(jsonResponse({ status: "ok", version: VERSION, models: Object.keys(MODELS) }));
        }
        return respond(jsonResponse({ error: "not found" }, 404));
      }

      if (method === "POST") {
        if (path === "/v1/chat/completions") {
          const parsed = await readJsonRequest(request);
          if (parsed.error) return respond(openAIErrorResponse(parsed.error, parsed.status || 400));
          return respond(await handleChat(parsed.value, cfg));
        }
        if (path === "/v1/responses") {
          const parsed = await readJsonRequest(request);
          if (parsed.error) return respond(openAIErrorResponse(parsed.error, parsed.status || 400));
          return respond(await handleResponses(parsed.value, cfg));
        }
        if (/^\/v(?:1beta|1)\/models\/[^/?#]+:generateContent$/.test(path)) {
          const parsed = await readJsonRequest(request);
          if (parsed.error) return respond(jsonResponse({ error: { message: parsed.error } }, parsed.status || 400));
          return respond(await handleGoogleGenerate(parsed.value, cfg, path, false));
        }
        if (/^\/v(?:1beta|1)\/models\/[^/?#]+:streamGenerateContent$/.test(path)) {
          const parsed = await readJsonRequest(request);
          if (parsed.error) return respond(jsonResponse({ error: { message: parsed.error } }, parsed.status || 400));
          return respond(await handleGoogleGenerate(parsed.value, cfg, path, true));
        }
        return respond(jsonResponse({ error: "not found" }, 404));
      }

      return respond(jsonResponse({ error: "not found" }, 404));
    } catch (e) {
      log(cfg, `error: ${(e && e.stack) || e}`);
      return respond(jsonResponse({ error: { message: String((e && e.message) || e) } }, 500));
    }
  },
};

// 导出给本地测试用(Workers 运行时会忽略)。
export {
  MODELS, resolveModel, getConfig, buildPayload, getUrl, buildHeaders, cleanText,
  promptByteLength, getFreshGeminiBuildLabel,
  extractTextsFromLine, extractResponseText, generate, generateStream,
  messagesToPrompt, parseToolCalls, googleContentsToPrompt, parseGoogleFunctionCalls,
  makeSapisidHash, parseImageUrl, getPageTokens, uploadImage, uploadTextFile, resolveImages,
  buildOpenAIHistoryTranscript, buildGoogleHistoryTranscript, prepareContextFiles,
  shouldUseContextFiles, latestOpenAIUserInputText, latestGoogleUserInputText,
  openAIToolDefs, googleToolDefs, buildToolsContextTranscript, collectOpenAIRefFileIDs,
  filterGoogleToolsByConfig, validateGoogleFunctionCalls,
  parseOpenAIToolChoicePolicy, filterToolsByPolicy, buildToolChoiceInstructionFromPolicy,
  getStructuredResponseFormat, buildStructuredOutputRequirement,
  canonicalizeStructuredOutputText,
  finalizeStructuredOutputText, validateStructuredOutputValue,
  validateRequiredToolCalls, createToolSieveState, processToolSieveChunk, flushToolSieve,
  formatOpenAIStreamToolCalls,
  streamOpenAIChatWithToolSieve, streamGoogleWithToolSieve, streamResponsesWithToolSieve,
  normalizeResponsesInputAsMessages,
  httpFetch, socketHttp,
};
