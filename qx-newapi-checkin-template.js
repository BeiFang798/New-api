// ===== 用户可改区域（直接在脚本里填写）=====
// 必填：目标站点地址，例如 https://example.com
const DIRECT_BASE_URL = "";
// 必填：登录用户名
const DIRECT_USERNAME = "";
// 必填：登录密码
const DIRECT_PASSWORD = "";
// 可选：站点开启 Turnstile 时填写
const DIRECT_TURNSTILE = "";

function parseKv(raw) {
  if (!raw || typeof raw !== "string") return {};
  const out = {};
  raw.split("&").forEach((pair) => {
    if (!pair) return;
    const i = pair.indexOf("=");
    const k = i >= 0 ? pair.slice(0, i) : pair;
    const v = i >= 0 ? pair.slice(i + 1) : "";

    let key = "";
    let val = "";
    try {
      key = decodeURIComponent((k || "").trim());
      val = decodeURIComponent((v || "").replace(/\+/g, " ").trim());
    } catch (_) {
      return;
    }
    if (key) out[key] = val;
  });
  return out;
}

function parseHashParams() {
  try {
    const src = ($environment && $environment.sourcePath) || "";
    const i = src.indexOf("#");
    if (i < 0 || i === src.length - 1) return {};
    return parseKv(src.slice(i + 1));
  } catch (_) {
    return {};
  }
}

// 取第一个非空字符串，用于参数优先级合并
function pickFirst() {
  for (let i = 0; i < arguments.length; i += 1) {
    const v = arguments[i];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

const ARG = parseKv(typeof $argument === "string" ? $argument : "");
const HASH = parseHashParams();

// 参数优先级：
// 1) argument
// 2) script-path#hash
// 3) QX prefs
// 4) DIRECT_*
const BASE_URL = pickFirst(
  ARG.base_url,
  ARG.site,
  HASH.base_url,
  HASH.site,
  $prefs.valueForKey("newapi_base_url"),
  DIRECT_BASE_URL
);
const USERNAME = pickFirst(
  ARG.username,
  HASH.username,
  $prefs.valueForKey("newapi_username"),
  DIRECT_USERNAME
);
const PASSWORD = pickFirst(
  ARG.password,
  HASH.password,
  $prefs.valueForKey("newapi_password"),
  DIRECT_PASSWORD
);
const TURNSTILE = pickFirst(
  ARG.turnstile,
  HASH.turnstile,
  $prefs.valueForKey("newapi_turnstile"),
  DIRECT_TURNSTILE
);

function notify(title, subtitle, content) {
  $notify(title, subtitle, content);
  $done();
}

function labels(key) {
  const dict = {
    title: "New-API 自动签到",
    done: "任务完成",
    failed: "任务失败",
    result: "结果",
    reward: "奖励",
    stats: "统计",
    result_ok: "✅ 签到成功",
    result_already: "ℹ️ 今日已签到",
    result_fail: "❌ 签到失败",
    reward_empty: "-",
    stats_empty: "-",
    stats_a: "本月已签 ",
    stats_b: " 天，累计 "
  };
  return dict[key] || key;
}

function failNotify(msg) {
  const body = [
    `${labels("result")}: ${labels("result_fail")}`,
    `${labels("reward")}: ${labels("reward_empty")}`,
    `${labels("stats")}: ${labels("stats_empty")}`,
    msg ? `错误: ${msg}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  notify(labels("title"), labels("failed"), body);
}

function successNotify(ctx) {
  const rewardText =
    ctx.rewardTokens > 0
      ? `+${fmtM(ctx.rewardTokens)} 额度 (${fmtInt(ctx.rewardTokens)} tokens)`
      : labels("reward_empty");
  const totalText =
    ctx.totalTokens > 0 ? `${fmtM(ctx.totalTokens)} 额度` : "0.00M 额度";
  const body = [
    `${labels("result")}: ${ctx.result}`,
    `${labels("reward")}: ${rewardText}`,
    `${labels("stats")}: ${labels("stats_a")}${ctx.monthDays}${labels("stats_b")}${totalText}`
  ].join("\n");
  notify(labels("title"), labels("done"), body);
}

function fetchJson(opts) {
  return $task.fetch(opts).then((resp) => {
    let data = {};
    try {
      data = resp.body ? JSON.parse(resp.body) : {};
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }
    return { resp, data };
  });
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function monthKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtInt(v) {
  return String(Math.floor(num(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtM(v) {
  return `${(num(v) / 1000000).toFixed(2)}M`;
}

function extractCookie(setCookieHeader) {
  if (!setCookieHeader) return "";
  if (Array.isArray(setCookieHeader)) {
    return setCookieHeader
      .map((x) => String(x).split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
  }
  return String(setCookieHeader).split(";")[0].trim();
}

function normalizeStats(statusData) {
  const stats = (statusData && statusData.data && statusData.data.stats) || {};
  const records = Array.isArray(stats.records) ? stats.records : [];
  const today = todayYmd();

  let monthDays = num(stats.checkin_count);
  if (!monthDays) monthDays = records.length;

  let totalTokens = num(stats.total_quota);
  if (!totalTokens) {
    totalTokens = records.reduce((sum, r) => sum + num(r.quota_awarded), 0);
  }

  const todayRecord = records.find(
    (r) => String(r.checkin_date || "").slice(0, 10) === today
  );

  return {
    checkedToday: !!stats.checked_in_today,
    monthDays,
    totalTokens,
    todayReward: todayRecord ? num(todayRecord.quota_awarded) : 0
  };
}

function rewardFromPayload(checkinData) {
  if (!checkinData || typeof checkinData !== "object") return 0;
  const d = checkinData.data;
  if (d && typeof d === "object") {
    const keys = [
      "quota",
      "quota_awarded",
      "reward",
      "amount",
      "tokens",
      "token",
      "granted_quota"
    ];
    for (const k of keys) {
      if (k in d) {
        const v = num(d[k]);
        if (v > 0) return v;
      }
    }
  }

  const msg = String(checkinData.message || "");
  const m = msg.match(/(\d[\d,]*)/);
  if (m && m[1]) return num(m[1].replace(/,/g, ""));
  return 0;
}

async function queryStatus(baseUrl, headers) {
  const req = {
    url: `${baseUrl}/api/user/checkin?month=${monthKey()}`,
    method: "GET",
    headers
  };
  const { data } = await fetchJson(req);
  if (!data.success || !data.data || !data.data.stats) {
    throw new Error(`Check-in status failed: ${data.message || "unknown error"}`);
  }
  return data;
}

async function main() {
  // 1) 参数校验
  if (!BASE_URL) throw new Error("Missing base_url/site.");
  if (!/^https?:\/\//i.test(BASE_URL)) {
    throw new Error("Invalid base_url. Must start with http:// or https://");
  }
  if (!USERNAME || !PASSWORD) throw new Error("Missing username/password.");

  const ctx = {
    result: labels("result_fail"),
    rewardTokens: 0,
    monthDays: 0,
    totalTokens: 0
  };

  // 2) 登录
  let loginUrl = `${BASE_URL}/api/user/login`;
  if (TURNSTILE) loginUrl += `?turnstile=${encodeURIComponent(TURNSTILE)}`;

  const loginReq = {
    url: loginUrl,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD })
  };

  const { resp: loginResp, data: loginData } = await fetchJson(loginReq);
  if (!loginData.success || !loginData.data || !loginData.data.id) {
    throw new Error(`Login failed: ${loginData.message || "unknown error"}`);
  }

  const userId = String(loginData.data.id);
  const setCookie =
    (loginResp.headers &&
      (loginResp.headers["set-cookie"] || loginResp.headers["Set-Cookie"])) ||
    "";
  const cookie = extractCookie(setCookie);

  const headers = { "New-Api-User": userId };
  if (cookie) headers.Cookie = cookie;

  // 3) 先查询状态，若今日已签到直接通知
  const before = normalizeStats(await queryStatus(BASE_URL, headers));
  if (before.checkedToday) {
    ctx.result = labels("result_already");
    ctx.rewardTokens = before.todayReward;
    ctx.monthDays = before.monthDays;
    ctx.totalTokens = before.totalTokens;
    successNotify(ctx);
    return;
  }

  // 4) 未签到则发起签到
  let checkinUrl = `${BASE_URL}/api/user/checkin`;
  if (TURNSTILE) checkinUrl += `?turnstile=${encodeURIComponent(TURNSTILE)}`;

  const checkinReq = {
    url: checkinUrl,
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}"
  };

  const { data: checkinData } = await fetchJson(checkinReq);
  const msg = String(checkinData.message || "");
  const ok =
    !!checkinData.success ||
    msg.includes("\u5df2\u7b7e\u5230") ||
    /already|checked\s*in/i.test(msg);
  if (!ok) throw new Error(`Check-in failed: ${msg || "unknown error"}`);

  // 5) 再查状态，计算奖励和累计
  const after = normalizeStats(await queryStatus(BASE_URL, headers));
  ctx.result = checkinData.success ? labels("result_ok") : labels("result_already");
  ctx.rewardTokens = after.todayReward || rewardFromPayload(checkinData);
  ctx.monthDays = after.monthDays;
  ctx.totalTokens = after.totalTokens;
  successNotify(ctx);
}

main().catch((e) => failNotify(e && e.message ? e.message : "unknown error"));
