# ChunkSpoke AI 代理后端（Cloudflare Workers / Pages）

代调用智谱 `glm-4-flash` 的轻量代理：**GLM-4-Flash 密钥只存在于 Cloudflare Secret，绝不进 APK / 代码 / git。**

## ✅ 实际部署状态（2026-10-18 已上线）
- **生产地址**：`https://chunkspoke-ai.pages.dev`（Cloudflare Pages，`_worker.js` 高级模式）
- 为什么用 Pages 而非 Workers：`*.workers.dev` 在大陆被墙，而 `*.pages.dev` 大陆可达（Sinoky 实测）。
  为保证中国用户可达，同一份 `src/worker.js` 以 `_worker.js` 形式部署到了 Pages。
- 已配置：KV `DAILY_STATS`、环境变量 `APP_TOKEN`/`DAILY_QUOTA`、Secret `ZHIPU_API_KEY`（生产+预览）。
- 已端到端验证：`GET→405`、无 token→`401`、`weekly_report→200 真实中文周报`、`free_build_judge→200 {score,feedback,corrected}`。
- App 端已用 `--dart-define=AI_BASE_URL=https://chunkspoke-ai.pages.dev` 重打包并发布 **v1.3.1（2034）**。

## 目录
- `wrangler.toml` — Worker 配置（`APP_TOKEN` / `DAILY_QUOTA` 变量 + KV 绑定 + account_id）
- `src/worker.js` — 完整可部署代码（CORS / Token / 配额 / 智谱调用 / 三路由 / 统一降级）
- `pages-dist/_worker.js` — 部署到 Pages 的副本（与 src/worker.js 一致）

## 接口契约
```
POST /api/ai
Headers: Content-Type: application/json, X-App-Token: <token>
Body:
  { "action": "weekly_report",  "userData": {...} }
  { "action": "error_analysis", "errorData": {...} }
  { "action": "free_build_judge", "buildData": {...} }
Response:
  { "success": true,  "data": { "type": "...", "content": "...", "result": {...} } }
  { "success": false, "error": "...", "fallback": "AI 正在休息，请稍后再试" }
```

## 部署命令
```bash
npm install -g wrangler
wrangler login
wrangler kv:namespace create "DAILY_STATS"        # 把返回的 id 填进 wrangler.toml 的 [[kv_namespaces]] id
wrangler secret put ZHIPU_API_KEY                 # 终端粘贴 sk-xxx（智谱密钥，绝不写进文件）
wrangler deploy                                   # 记下输出的 Worker URL
```
部署后把 Worker URL 与 APP_TOKEN 注入到 Flutter 构建（见下）。

## Flutter 端配置（baseUrl / appToken 注入）
通过编译期 `--dart-define` 注入：
```bash
flutter build apk --release --split-per-abi \
  --dart-define=AI_BASE_URL=https://chunkspoke-ai.pages.dev \
  --dart-define=AI_APP_TOKEN=chunkspoke_2026_secure_token_change_me
```
> 关于这个 token 的定位，说清楚以免误导后来人：它是**应用识别符，不是秘密**。任何拿到 APK
> 的人都能从二进制里提取它，`ai_service.dart` 的 `_kDefaultAppToken` 默认值就是线上生效值，
> 并且连同部署命令一起提交在公开仓库里。所以防滥用靠的是**两层配额**（按 IP + 全局），
> 不是靠 token 保密。若将来要对外开放 API 或接入计费，请换成服务端签发的短期凭证，
> 别在混淆上自欺。

若想用 `android/local.properties`（gradle）驱动，可在 `android/app/build.properties` 写法里读取后在
`android/app/build.gradle` 透传为 `dartDefines`（团队已有先例）。

## 验收清单

| 项 | 验证 | 通过标准 |
|---|---|---|
| 路由通 | 浏览器 `GET <worker-url>` | 返回 405 Method Not Allowed |
| 鉴权 | 不带 `X-App-Token` 请求 | 401 |
| CORS | App 发起请求（原生无 Origin，放行） | 无跨域报错 |
| 周报 | 发 `weekly_report` | 返回中文周报（data.content） |
| 错因分析 | 发 `error_analysis` | 返回具体建议 |
| 造句评判 | 发 `free_build_judge` | 返回可解析 JSON（score/feedback/corrected） |
| 单 IP 限额 | 同一出口 IP 连续请求超过 `PER_IP_QUOTA`（默认 40/天） | 第 41 次起返回 429，文案提示可在设置里关掉联网点评 |
| 全局上限 | 把 `DAILY_QUOTA` 改成 1，请求两次 | 第二次 429；它只是总额保险丝，不再能被单个人吃光 |
| 体积上限 | 发一个 >8192 字符的 body | 返回 413，不会转发给智谱 |
| 未知 action | 发 `{"action":"nope"}` | 返回 400（旧版返回 200，会让监控误判成功） |
| 降级 | 断网 / 填错 ZHIPU_API_KEY | App 显示降级文案，不崩溃不弹原始错误 |
| Key 安全 | 全局搜索 `sk-` | 代码中无任何真实 Key |

## 设计要点
- **离线优先降级**：自由造句在客户端先尝试云端 AI 评判；失败 / 无网络时自动回退到 App 内置的离线规则引擎（见 `lib/screens/free_build_screen.dart`），绝不阻断用户开口。
- **节流（调用方负责）**：`error_analysis` 仅在「同一句连续错 2 次」时调用；`weekly_report` 每天只请求一次（客户端按日期缓存）。
- **限流（后端负责）**：两层 KV 计数器——`quota:ip:YYYY-MM-DD:<ip>` 限单来源（`PER_IP_QUOTA`），
  `quota:day:YYYY-MM-DD` 限全站总额（`DAILY_QUOTA`），TTL 90000s，超限 429。计数器 get+put 非原子，
  高并发下会少量低估；本用途是挡滥用，不是计费，可接受。
- **免费模型兜底**：智谱 `glm-4-flash` 并发低，所有调用带 15s 超时 + 2 次重试。
- **人话降级**：任何异常（网络 / Key 失效 / 超配额 / 解析失败）都返回中文 fallback，绝不让客户端弹原始错误。
