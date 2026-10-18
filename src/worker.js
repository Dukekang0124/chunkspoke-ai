// ChunkSpoke AI 代理后端（Cloudflare Workers）
// 代调用智谱 GLM-4-Flash；密钥仅来自 env.ZHIPU_API_KEY（Cloudflare Secret）。
// 接口：POST /api/ai  { "action": "...", ... }

// —— 可选：浏览器端来源白名单（原生 App 不带 Origin，一律放行）——
const ALLOWED_ORIGINS = (typeof ALLOWED_ORIGINS_RAW !== 'undefined')
  ? String(ALLOWED_ORIGINS_RAW).split(',').map((s) => s.trim()).filter(Boolean)
  : [];

// ───────────────────────── CORS ─────────────────────────
function corsHeaders(req) {
  const origin = req.headers.get('Origin');
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    'Access-Control-Max-Age': '86400',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function shouldAllowOrigin(req) {
  const origin = req.headers.get('Origin');
  if (!origin) return true; // 原生 App / 无 Origin，放行
  return ALLOWED_ORIGINS.includes(origin);
}

// ───────────────────────── 配额（KV） ─────────────────────────
async function checkQuota(env) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `quota:${day}`;
  let count = 0;
  try {
    count = parseInt((await env.DAILY_STATS.get(key)) || '0', 10) || 0;
  } catch (_) {}
  const quota = parseInt(env.DAILY_QUOTA || '500', 10) || 500;
  if (count >= quota) return false;
  try {
    await env.DAILY_STATS.put(key, String(count + 1), { expirationTtl: 86400 });
  } catch (_) {}
  return true;
}

// ───────────────────────── 智谱调用（超时 + 重试） ─────────────────────────
async function callZhipu(messages, env, opts = {}) {
  const url = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const body = JSON.stringify({
    model: 'glm-4-flash',
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 600,
  });
  const retries = 2;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.ZHIPU_API_KEY}`,
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`Zhipu HTTP ${resp.status}`);
      const json = await resp.json();
      return json?.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < retries) continue; // 免费模型并发低，重试兜底
    }
  }
  throw lastErr || new Error('Zhipu call failed');
}

// ───────────────────────── 路由处理器 ─────────────────────────
async function handleWeekly(u, env) {
  const sys = `你是 ChunkSpoke 的 AI 学习教练，为用户生成每周学习报告。
要求：中文；语气温暖像朋友；结构为①本周亮点②需要加强的场景③下周1-2条具体行动；
150-200字；总词块<5时以鼓励起步为主。`;
  const user = `请基于以下数据生成周报：\n${JSON.stringify(u, null, 2)}`;
  const content = await callZhipu(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    env,
    { max_tokens: 600 }
  );
  return { type: 'weekly_report', content, result: null };
}

async function handleError(e, env) {
  const sys = `你是 ChunkSpoke 的 AI 口语教练。用户说错了一个句子。
任务：指出错误类型→一句话解释原因→给正确版本→鼓励再试。
中文，轻松友好，不超过80字，只鼓励不批评。`;
  const user = `场景：${e?.scenario ?? ''}\n目标句：${e?.targetSentence ?? ''}\n用户实际说的：${e?.userSpeech ?? ''}`;
  const content = await callZhipu(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    env,
    { max_tokens: 300, temperature: 0.4 }
  );
  return { type: 'error_analysis', content, result: null };
}

async function handleJudge(b, env) {
  const sys = `你是 ChunkSpoke 的 AI 口语教练。用户用学过的词块自由造句。
任务：判断是否表达出中文意思、是否包含核心词块、给1-5分、给简短反馈。
基本正确但有小瑕疵给4分并指出；完全正确给5分。
必须输出纯JSON：{"score":数字,"feedback":"...","corrected":"..."}
中文，不超过60字。`;
  const user = `场景：${b?.scenario ?? ''}\n中文意思：${b?.chinesePrompt ?? ''}
可用词块：${JSON.stringify(b?.availableChunks ?? [])}\n用户说的：${b?.userSpeech ?? ''}`;
  const content = await callZhipu(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    env,
    { max_tokens: 300, temperature: 0.3 }
  );
  const parsed = parseJsonSafe(content);
  if (!parsed) throw new Error('bad_json'); // 解析失败 → 走降级（客户端回退规则引擎）
  return { type: 'free_build_judge', content: '', result: parsed };
}

// 从模型输出里尽量抽出纯 JSON（容忍 ```json 代码块 / 前后废话）。
function parseJsonSafe(s) {
  if (!s) return null;
  let t = String(s).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const o = JSON.parse(t);
    return {
      score: Number(o.score) || 0,
      feedback: String(o.feedback ?? ''),
      corrected: String(o.corrected ?? ''),
    };
  } catch (_) {
    return null;
  }
}

// ───────────────────────── 统一错误响应 ─────────────────────────
function jsonResp(obj, status, req) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}

// ───────────────────────── 主入口 ─────────────────────────
export default {
  async fetch(req, env, _ctx) {
    // 1) 预检
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    // 2) 仅允许 POST
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: corsHeaders(req),
      });
    }
    // 3) CORS 来源
    if (!shouldAllowOrigin(req)) {
      return new Response('Forbidden', { status: 403, headers: corsHeaders(req) });
    }
    // 4) Token 校验
    const token = req.headers.get('X-App-Token');
    if (!token || token !== env.APP_TOKEN) {
      return jsonResp(
        { success: false, error: 'unauthorized', fallback: '请更新到最新版本' },
        401,
        req
      );
    }
    // 5) 配额
    let quotaOk = true;
    try {
      quotaOk = await checkQuota(env);
    } catch (_) {}
    if (!quotaOk) {
      return jsonResp(
        { success: false, error: 'quota_exceeded', fallback: '今日 AI 次数已用完，明天再来吧' },
        429,
        req
      );
    }
    // 6) 路由
    try {
      const payload = await req.json().catch(() => null);
      const action = payload?.action;
      let data;
      if (action === 'weekly_report') data = await handleWeekly(payload.userData, env);
      else if (action === 'error_analysis') data = await handleError(payload.errorData, env);
      else if (action === 'free_build_judge') data = await handleJudge(payload.buildData, env);
      else {
        return jsonResp({ success: false, error: 'unknown_action', fallback: '暂不支持该操作' }, 200, req);
      }
      return jsonResp({ success: true, data }, 200, req);
    } catch (e) {
      // 任何失败都降级为人话，绝不把原始错误抛给客户端
      return jsonResp(
        { success: false, error: String(e?.message || e), fallback: 'AI 正在休息，请稍后再试' },
        200,
        req
      );
    }
  },
};
