// AI 后端发版前自检：node --experimental-vm-modules 不需要，直接 node 跑。
//   node chunkspoke-ai/test/worker.test.mjs
// 智谱调用被打桩，不联网、不消耗配额。
const here = new URL('.', import.meta.url).pathname;
const mod = (await import('file://' + here + '../src/worker.js')).default;
const handler = mod.fetch;

const TOKEN = 'chunkspoke_2026_secure_token_change_me';
const store = new Map();
const env = {
  APP_TOKEN: TOKEN,
  PER_IP_QUOTA: '3',
  DAILY_QUOTA: '10',
  DAILY_STATS: {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
  },
};

globalThis.fetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: '{"score":5,"feedback":"很好","corrected":"I am fine."}' } }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

const post = (ip, body, token = TOKEN) => new Request('http://x/api/ai', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { 'X-App-Token': token } : {}),
    ...(ip ? { 'CF-Connecting-IP': ip } : {}),
  },
  body: JSON.stringify(body),
});

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (期望 ${JSON.stringify(want)})`}`);
}

const judge = {
  action: 'free_build_judge',
  buildData: { scenario: 's', chinesePrompt: 'c', availableChunks: ['a'], userSpeech: 'I am fine.' },
};

// 单 IP 上限必须先生效，否则一个人就能把全局额度吃光（对所有用户等于 DoS）。
const seq = [];
for (let i = 0; i < 5; i++) seq.push((await handler(post('1.1.1.1', judge), env)).status);
check('同一 IP 前 3 次通过、第 4 次起 429', seq, [200, 200, 200, 429, 429]);
check('换 IP 不受他人消耗影响', (await handler(post('2.2.2.2', judge), env)).status, 200);
check('未知 action 报 400（不是旧的 200）', (await handler(post('3.3.3.3', { action: 'nope' }), env)).status, 400);
check('超大 body 报 413，不转发给智谱',
  (await handler(post('3.3.3.3', { action: 'error_analysis', errorData: { userSpeech: 'x'.repeat(20000) } }), env)).status, 413);
check('缺 token 报 401', (await handler(post('3.3.3.3', judge, null), env)).status, 401);
check('GET 仍报 405', (await handler(new Request('http://x/api/ai', { method: 'GET' }), env)).status, 405);

// sanitize：缺字段不能把字面量 "undefined" 喂给模型
const r = await handler(post('5.5.5.5', { action: 'free_build_judge' }), env);
const j = await r.json();
check('空载荷仍走降级而非崩溃', typeof j.success, 'boolean');

console.log(failed ? `\n✗ ${failed} 项未通过` : '\n✓ 全部通过，可以 wrangler deploy');
process.exit(failed ? 1 : 0);
