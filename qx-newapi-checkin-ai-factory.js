/*
 * Quantumult X - New API 自动签到
 *
 * 用法优先级:
 * 1) 任务参数 $argument: base_url=...&username=...&password=...&turnstile=...
 * 2) QX 持久化配置 $prefs:
 *    newapi_base_url / newapi_username / newapi_password / newapi_turnstile
 * 3) 下面 DIRECT_* 常量
 */

// ===== 用户可改区域 =====
const DIRECT_BASE_URL = "";
const DIRECT_USERNAME = "";
const DIRECT_PASSWORD = "";
// 仅当站点启用 Turnstile 时填写（token 可能会过期，不建议长期硬编码）
const DIRECT_TURNSTILE = "";
// 反馈中的金额符号，默认使用 💲
const DIRECT_SYMBOL = "💲";
// ========================

const TITLE = "AI Factory 自动签到";

function parseKv(raw) {
  if (!raw || typeof raw !== "string") return {};
  const out = {};
  raw.split("&").forEach((pair) => {
    if (!pair) return;
    const i = pair.indexOf("=");
    const k = i >= 0 ? pair.slice(0, i) : pair;
    const v = i >= 0 ? pair.slice(i + 1) : "";
    try {
      const key = decodeURIComponent((k || "").trim());
      const val = decodeURIComponent((v || "").replace(/\+/g, " ").trim());
      if (key) out[key] = val;
    } catch (_) {}
  });
  return out;
}

function pickFirst() {
  for (let i = 0; i < arguments.length; i += 1) {
    const v = arguments[i];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function normalizeBaseUrl(url) {
  const s = (url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmt2(v) {
  return toNum(v).toFixed(2);
}

function notifyOk(resultText, dateText, rewardAmount, monthDays, balanceAmount, symbol) {
  const body = [
    `结果: ${resultText}`,
    `日期: ${dateText}`,
    `奖励: +${fmt2(rewardAmount)} ${symbol}`,
    `统计: 本月已签 ${monthDays} 天，账户剩余额度 ${fmt2(balanceAmount)} ${symbol}`
  ].join("\n");
  $notify(TITLE, "任务完成", body);
  $done();
}

function notifyFail(err, stage) {
  const body = [
    `结果: ❌ 签到失败`,
    `日期: ${todayYmd()}`,
    `阶段: ${stage || "unknown"}`,
    `原因: ${err || "unknown error"}`
  ].join("\n");
  $notify(TITLE, "任务失败", body);
  $done();
}

function fetchJson(opts) {
  return $task.fetch(opts).then((resp) => {
    let data = {};
    try {
      data = resp.body ? JSON.parse(resp.body) : {};
    } catch (e) {
      throw new Error(`响应不是 JSON: ${e.message}`);
    }
    return { resp, data };
  });
}

function appendQuery(url, key, val) {
  const sep = url.indexOf("?") >= 0 ? "&" : "?";
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
}

function splitSetCookie(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return String(raw).split(/,(?=\s*[A-Za-z0-9_\-]+=)/g);
}

function extractCookie(headers) {
  const setCookie = headers && (headers["set-cookie"] || headers["Set-Cookie"]);
  const parts = splitSetCookie(setCookie);
  return parts
    .map((x) => String(x).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function parseStatus(statusData) {
  const stats = (statusData && statusData.data && statusData.data.stats) || {};
  const records = Array.isArray(stats.records) ? stats.records : [];
  const today = todayYmd();

  const monthDays = toNum(stats.checkin_count) || records.length || 0;
  let totalTokens = toNum(stats.total_quota);
  if (!totalTokens) {
    totalTokens = records.reduce((sum, r) => sum + toNum(r && r.quota_awarded), 0);
  }

  const todayRec = records.find(
    (r) => String((r && r.checkin_date) || "").slice(0, 10) === today
  );
  return {
    checkedToday: !!stats.checked_in_today,
    monthDays: monthDays,
    totalTokens: totalTokens,
    todayReward: todayRec ? toNum(todayRec.quota_awarded) : 0
  };
}

function parseRewardFromCheckinPayload(checkinData) {
  const d = checkinData && checkinData.data;
  if (d && typeof d === "object") {
    const keys = ["quota_awarded", "quota", "reward", "amount", "tokens"];
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (k in d) {
        const v = toNum(d[k]);
        if (v > 0) return v;
      }
    }
  }
  return 0;
}

function quotaToAmount(quota, quotaPerUnit) {
  const q = toNum(quota);
  const unit = toNum(quotaPerUnit);
  if (unit > 0) return q / unit;
  return q / 1000000;
}

async function getSiteStatus(baseUrl) {
  const { data } = await fetchJson({
    url: `${baseUrl}/api/status`,
    method: "GET",
    headers: { Accept: "application/json" }
  });
  if (!data || !data.success || !data.data) {
    throw new Error(`读取站点状态失败: ${(data && data.message) || "unknown error"}`);
  }
  return data.data;
}

async function login(baseUrl, username, password, turnstileRequired, turnstileToken) {
  let url = `${baseUrl}/api/user/login`;
  if (turnstileRequired || turnstileToken) {
    if (!turnstileToken) {
      throw new Error("站点开启了 Turnstile，但脚本未提供 turnstile token。");
    }
    url = appendQuery(url, "turnstile", turnstileToken);
  }

  const { resp, data } = await fetchJson({
    url: url,
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: username, password: password })
  });

  if (!data || !data.success) {
    throw new Error(`登录失败: ${(data && data.message) || "unknown error"}`);
  }
  if (data.data && data.data.require_2fa) {
    throw new Error("账号开启了 2FA，当前脚本不支持 2FA 登录。");
  }

  const userId = String(data.data && data.data.id ? data.data.id : "");
  if (!userId) throw new Error("登录成功但未返回用户 ID。");

  const cookie = extractCookie(resp.headers || {});
  if (!cookie) {
    throw new Error("登录成功但未获取到会话 Cookie。");
  }

  return { userId: userId, cookie: cookie };
}

async function queryCheckinStatus(baseUrl, headers) {
  const { data } = await fetchJson({
    url: `${baseUrl}/api/user/checkin?month=${monthKey()}`,
    method: "GET",
    headers: headers
  });
  if (!data || !data.success || !data.data || !data.data.stats) {
    throw new Error(`查询签到状态失败: ${(data && data.message) || "unknown error"}`);
  }
  return data;
}

async function queryUserSelf(baseUrl, headers) {
  const { data } = await fetchJson({
    url: `${baseUrl}/api/user/self`,
    method: "GET",
    headers: headers
  });
  if (!data || !data.success || !data.data) {
    throw new Error(`查询用户信息失败: ${(data && data.message) || "unknown error"}`);
  }
  return data.data;
}

async function doCheckin(baseUrl, headers, turnstileRequired, turnstileToken) {
  let url = `${baseUrl}/api/user/checkin`;
  if (turnstileRequired || turnstileToken) {
    if (!turnstileToken) {
      throw new Error("签到接口需要 Turnstile，但脚本未提供 turnstile token。");
    }
    url = appendQuery(url, "turnstile", turnstileToken);
  }
  const { data } = await fetchJson({
    url: url,
    method: "POST",
    headers: Object.assign({}, headers, { "Content-Type": "application/json" }),
    body: "{}"
  });

  if (!data) throw new Error("签到响应为空");
  const msg = String(data.message || "");
  const already = /已签到|already|checked\s*in/i.test(msg);
  if (!data.success && !already) {
    throw new Error(`签到失败: ${msg || "unknown error"}`);
  }
  return { data: data, already: already };
}

async function main() {
  const arg = parseKv(typeof $argument === "string" ? $argument : "");
  const baseUrl = normalizeBaseUrl(
    pickFirst(arg.base_url, arg.site, $prefs.valueForKey("newapi_base_url"), DIRECT_BASE_URL)
  );
  const username = pickFirst(arg.username, $prefs.valueForKey("newapi_username"), DIRECT_USERNAME);
  const password = pickFirst(arg.password, $prefs.valueForKey("newapi_password"), DIRECT_PASSWORD);
  const turnstile = pickFirst(
    arg.turnstile,
    $prefs.valueForKey("newapi_turnstile"),
    DIRECT_TURNSTILE
  );
  const symbol = pickFirst(
    arg.symbol,
    $prefs.valueForKey("newapi_symbol"),
    DIRECT_SYMBOL
  );

  if (!baseUrl) throw new Error("缺少 base_url/site，且未设置 DIRECT_BASE_URL。");
  if (!username || !password) throw new Error("缺少 username/password。");

  const siteStatus = await getSiteStatus(baseUrl);
  const quotaPerUnit = toNum(siteStatus.quota_per_unit);
  if (siteStatus.checkin_enabled === false) {
    throw new Error("站点未开启签到功能（checkin_enabled=false）。");
  }

  const turnstileRequired = !!siteStatus.turnstile_check;
  const loginResult = await login(
    baseUrl,
    username,
    password,
    turnstileRequired,
    turnstile
  );

  const headers = {
    "New-Api-User": loginResult.userId,
    Cookie: loginResult.cookie,
    Accept: "application/json"
  };

  const beforeRaw = await queryCheckinStatus(baseUrl, headers);
  const before = parseStatus(beforeRaw);
  const beforeSelf = await queryUserSelf(baseUrl, headers);
  const beforeBalanceAmount = quotaToAmount(beforeSelf.quota, quotaPerUnit);
  if (before.checkedToday) {
    notifyOk(
      "ℹ️ 今日已签到",
      todayYmd(),
      quotaToAmount(before.todayReward, quotaPerUnit),
      before.monthDays,
      beforeBalanceAmount,
      symbol
    );
    return;
  }

  const checkinResult = await doCheckin(
    baseUrl,
    headers,
    turnstileRequired,
    turnstile
  );

  const afterRaw = await queryCheckinStatus(baseUrl, headers);
  const after = parseStatus(afterRaw);
  const afterSelf = await queryUserSelf(baseUrl, headers);
  const rewardQuota = after.todayReward || parseRewardFromCheckinPayload(checkinResult.data);
  const rewardAmount = quotaToAmount(rewardQuota, quotaPerUnit);
  const balanceAmount = quotaToAmount(afterSelf.quota, quotaPerUnit);
  const resultText = checkinResult.already ? "ℹ️ 今日已签到" : "✅ 签到成功";
  notifyOk(resultText, todayYmd(), rewardAmount, after.monthDays, balanceAmount, symbol);
}

main().catch((e) => {
  const msg = e && e.message ? e.message : "unknown error";
  notifyFail(msg, "main");
});
