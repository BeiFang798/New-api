// Required: target site base URL, example https://example.com
const DIRECT_BASE_URL = "";
// Required: login username
const DIRECT_USERNAME = "";
// Required: login password
const DIRECT_PASSWORD = "";
// Optional: turnstile token when your site enables Turnstile
const DIRECT_TURNSTILE = "";

function parseKv(raw) {
  if (!raw || typeof raw !== "string") return {};
  const out = {};
  raw.split("&").forEach((pair) => {
    if (!pair) return;
    const i = pair.indexOf("=");
    const k = i >= 0 ? pair.slice(0, i) : pair;
    const v = i >= 0 ? pair.slice(i + 1) : "";
    const key = decodeURIComponent((k || "").trim());
    const val = decodeURIComponent((v || "").replace(/\+/g, " ").trim());
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

function pickFirst(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

const ARG = parseKv(typeof $argument === "string" ? $argument : "");
const HASH = parseHashParams();

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

function nzh(key) {
  const dict = {
    title: "New-API Auto Check-in",
    done: "Task Completed",
    failed: "Task Failed",
    result: "Result",
    reward: "Reward",
    stats: "Stats",
    result_ok: "✅ Check-in Success",
    result_already: "ℹ️ Already Checked In Today",
    result_fail: "❌ Check-in Failed",
    reward_empty: "-",
    stats_empty: "-",
    stats_a: "Checked in ",
    stats_b: " days this month, total "
  };
  return dict[key] || key;
}

function failNotify() {
  const body = [
    `${nzh("result")}: ${nzh("result_fail")}`,
    `${nzh("reward")}: ${nzh("reward_empty")}`,
    `${nzh("stats")}: ${nzh("stats_empty")}`
  ].join("\n");
  notify(nzh("title"), nzh("failed"), body);
}

function successNotify(ctx) {
  const rewardText =
    ctx.rewardTokens > 0
      ? `+${fmtM(ctx.rewardTokens)} quota (${fmtInt(ctx.rewardTokens)} tokens)`
      : nzh("reward_empty");
  const totalText =
    ctx.totalTokens > 0 ? `${fmtM(ctx.totalTokens)} quota` : "0.00M quota";
  const body = [
    `${nzh("result")}: ${ctx.result}`,
    `${nzh("reward")}: ${rewardText}`,
    `${nzh("stats")}: ${nzh("stats_a")}${ctx.monthDays}${nzh("stats_b")}${totalText}`
  ].join("\n");
  notify(nzh("title"), nzh("done"), body);
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
    const keys = ["quota", "quota_awarded", "reward", "amount", "tokens", "token", "granted_quota"];
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
  if (!BASE_URL) throw new Error("Missing base_url/site.");
  if (!/^https?:\/\//i.test(BASE_URL)) throw new Error("Invalid base_url. Must start with http:// or https://");
  if (!USERNAME || !PASSWORD) throw new Error("Missing username/password.");

  const ctx = {
    result: nzh("result_fail"),
    rewardTokens: 0,
    monthDays: 0,
    totalTokens: 0
  };

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
    (loginResp.headers && (loginResp.headers["set-cookie"] || loginResp.headers["Set-Cookie"])) || "";
  const cookie = extractCookie(setCookie);

  const headers = { "New-Api-User": userId };
  if (cookie) headers.Cookie = cookie;

  const before = normalizeStats(await queryStatus(BASE_URL, headers));
  if (before.checkedToday) {
    ctx.result = nzh("result_already");
    ctx.rewardTokens = before.todayReward;
    ctx.monthDays = before.monthDays;
    ctx.totalTokens = before.totalTokens;
    successNotify(ctx);
    return;
  }

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
  const ok = !!checkinData.success || msg.includes("已签到");
  if (!ok) throw new Error(`Check-in failed: ${msg || "unknown error"}`);

  const after = normalizeStats(await queryStatus(BASE_URL, headers));
  ctx.result = checkinData.success ? nzh("result_ok") : nzh("result_already");
  ctx.rewardTokens = after.todayReward || rewardFromPayload(checkinData);
  ctx.monthDays = after.monthDays;
  ctx.totalTokens = after.totalTokens;
  successNotify(ctx);
}

main().catch(() => failNotify());

