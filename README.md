# SillyTavern-DeepSeek-Balance · DeepSeek 余额

在**输入框里额外扩展一行**显示 DeepSeek 账户余额的 SillyTavern 扩展。

```
┌──────────────────────────────────────────────┐
│ ● DeepSeek ¥12.22 ↻                          │ ← 输入框里多出来的这一行（无分隔线）
│ [☰] 在这里输入消息…                      [➤] │ ← 原本的输入行
└──────────────────────────────────────────────┘
```

- 余额行就是 `#send_form`（输入框那个框）**内部的第一行**，和输入行共用同一个边框、同一层毛玻璃底色 ——
  外观上就是输入框自己扩展出来的一行，而不是浮在框外面的小胶囊
- 点余额徽标 → 详情弹窗（总额 / 赠送 / 充值 / 较上次变化 / 查询时间 / 密钥来源）
- 点 `↻` → 立即刷新
- 扩展设置里是 **ST 标准可折叠抽屉**（和其他扩展一样的标题栏 + 折叠箭头），标题栏右侧直接显示当前余额，不用展开也能看
- 余额低于阈值时整行变红

只用 DeepSeek，不需要任何服务端插件或 API 中转。

---

## 安装

**推荐方式一**（带 git 的安装）：以后更新就是酒馆里点一下的事。
方式二是纯拷贝，能用，但酒馆的更新按钮对它无效，每次升级都要重新拷一遍。

### 方式一：从 GitHub 安装（推荐）

1. 打开酒馆 → **扩展**（Extensions）→ **Install extension**
2. 粘贴仓库地址：
   ```
   https://github.com/Ushio155/SillyTavern-DeepSeek-Balance
   ```
3. 刷新页面。扩展默认启用（若没出现，在扩展列表里手动打开开关）

> ⚠️ 如果你之前用方式二拷过一份，**先把那个文件夹删掉再装**：
> 酒馆安装时会按仓库名新建文件夹（`SillyTavern-DeepSeek-Balance`），旧文件夹若同时存在，
> 输入框里会出现**两条余额行**（两个扩展都在跑）。

### 方式二：手动拷贝

把 `manifest.json`、`index.js`、`lib.js`、`style.css` 复制到：

```
<SillyTavern>/data/<你的用户名>/extensions/SillyTavern-DeepSeek-Balance/
```

（文件夹名可以随意，但建议保持一致；`manifest.json` 里的 `name` 只作标识，不影响加载。）

### 更新

本仓库 manifest 里是 `auto_update: true`，配合上面方式一的 git 安装，更新路径有两条：

| 触发 | 行为 |
|---|---|
| 酒馆**检查更新** | 每天一次（需要在扩展设置里打开 **通知扩展更新**，打开的那一刻会立刻查一次）；有新版就弹提示 |
| 酒馆**自动更新** | 酒馆版本变化后自动拉取；也可以随时在**扩展**菜单里点 **Update all**，或单个扩展自己的更新按钮 |

两种都会对扩展目录执行 `git pull`，拉完**刷新页面**才生效。
手动拷贝（方式二）的安装拿不到这个能力 —— 目录里没有 git 仓库，更新检查会直接跳过。

---

## 配置密钥

扩展有两条取密钥的路径，**先看第一条，没有才看第二条**：

| 来源 | 怎么用 | 说明 |
|---|---|---|
| 扩展设置（推荐） | 扩展设置 → **DeepSeek 余额** → API 密钥 → 填入 `sk-...` → 保存密钥 | 不需要改酒馆配置，不需要重启；密钥以混淆形式存在 `settings.json` 的 `extension_settings` 里 |
| 酒馆密钥库 | 在 `config.yaml` 里把 `allowKeysExposure` 改成 `true` 并重启，然后在「连接」里填好 DeepSeek 密钥 | 扩展会读 `api_key_deepseek`。**默认关闭**：`/api/secrets/find` 会返回 403，此时界面显示中性的「未配置密钥」（不是报错） |

> 没配密钥时余额行不会发任何请求，也不会报红——只是显示「未配置密钥」，点开弹窗里有操作指引。

---

## 显示原理

移植自 DSH 插件 **`@local/ds-balance`** 的四步骨架：

1. 固定端点 `GET https://api.deepseek.com/user/balance`，用 `Authorization: Bearer <key>` 鉴权
2. 把响应规范化成单一结果对象 `{ ok, at, isAvailable, balances[] }`
   （注意：DeepSeek 返回的金额是**字符串**，必须显式转数字）
3. 挂载即查一次 → 定时轮询（默认 60 秒）→ 手动 `↻`
4. 同一时刻只允许一个在途请求（`inFlight` 互斥），失败指数退避

**与 ds-balance 的唯一区别**：ds-balance 有 Host 半部（由主机端读密钥、浏览器只读同源端点），
而 ST 扩展没有 Host 半部，所以本扩展在浏览器里直连 DeepSeek。
`api.deepseek.com` 会回显 Origin 并允许 `authorization` 头（已实测），因此纯前端即可跨域访问，
不需要 `enableServerPlugins`。

### 什么时候会刷新（比纯轮询更"实时"）

| 触发 | 说明 |
|---|---|
| 挂载后 | 立刻查一次 |
| 定时器 | 默认 60 秒（可调 10–86400 秒；失败时指数退避，最多 10 分钟一次） |
| `GENERATION_ENDED` | 每次 AI 回复结束后防抖 2.5 秒再查一次——余额刚变化，这才是真正"跟着用"的刷新 |
| 标签页重新可见 | 数据超过 30 秒才查，切回来就是新的 |
| 手动 | 点余额行里的 `↻`，或设置面板里的「立即查询」/标题栏刷新按钮 |

---

## 设置项

| 项 | 默认 | 说明 |
|---|---|---|
| API 密钥 | 空 | 保存后不回显（输入框清空，只显示「已保存密钥」） |
| 自动刷新 | 开 | 关掉后只在挂载 / 生成结束 / 手动时刷新 |
| 间隔（秒） | 60 | 限 10–86400 |
| 低余额告警阈值 | 10 | 余额低于它时徽标变红并提示充值；**填 0 = 关闭告警** |
| 每次生成结束后自动刷新 | 开 | 即上面的 `GENERATION_ENDED` |
| 显示刷新按钮 | 开 | 关掉后输入框里那一行的 `↻` 隐藏（设置面板里的按钮仍在） |

---

## 外观怎么调

余额行完全由 `style.css` 控制，全部走 ST 主题变量（`--SmartTheme*` / `--mainFontSize`），不写死颜色，
换主题会自动跟着变。想微调的话：

| 想改什么 | 改哪里 |
|---|---|
| 加一条和输入行之间的细分割线 | 加回 `.ds-balance-bar--inline::after`（默认**不加**，整行无痕融进输入框）：`content:''; position:absolute; left:0; right:0; bottom:0; height:1px; background-color: var(--SmartThemeBorderColor, currentColor); opacity:.5; pointer-events:none;` |
| 余额离输入行多远 | `.ds-balance-bar--inline` 里的 `--ds-balance-row-drop`（用负下边距把输入行往上拉；上限约 3px，再大会压到输入行顶部的生成进度条） |
| 余额离输入框顶边多远 | 同一个规则里的 `--ds-balance-row-top`（调大 = 整行下移，但输入框会等高变高，**不改变**和输入行的距离） |
| 左右留白 | `.ds-balance-bar--inline` 的 `padding` 第 2、4 个值 |
| 字号（默认 `--mainFontSize × 0.85`） | `.ds-balance-bar` 的 `font-size` |
| 让文字对齐到输入框正文那一列 | 给 `.ds-balance-bar--inline` 加 `padding-left: calc(13px + var(--bottomFormBlockSize, 34px))` |
| 低余额 / 失败的颜色 | `.ds-balance-bar.is-low` / `.is-error`（已接 `--progErrorColor`） |
| 分隔线的浓淡（加回上面那条线时） | `.ds-balance-bar--inline::after` 的 `opacity`（默认 0.5） |

> 为什么状态色加在"行"上而不是胶囊上：框内那一行把胶囊的边框去掉了，没有边框可以变红，
> 所以颜色必须写在行上、再靠 `color` 继承给文字和圆点（`tests/static-audit.test.mjs` 会守住这条）。

---

## 安全说明（重要，请读完）

**密钥怎么存的**
扩展内的密钥是 **异或 + base64 混淆**（`v1:` 前缀），**不是加密**：任何能读到
`data/<user>/settings.json` 的人都能还原它。混淆只防"肉眼直接看到 `sk-...`"。

> 因为它存在 `extension_settings` 里，**会跟着酒馆的「下载设置 / 备份 / 用户数据迁移」一起走**。
> 如果你会分享自己的设置文件或截图，请用下面任一方式规避：
> 1) 不用扩展内密钥，改为打开 `allowKeysExposure: true` 让扩展读密钥库（密钥库同样会被导出，但至少不在这份 JSON 里）；
> 2) 分享前先在扩展里点「清除密钥」；
> 3) 用一把**单独的、限额的** DeepSeek key。

**密钥会去哪里**
只会在 `lib.js` 的 `buildBalanceRequest()` 里被放进请求头，且 URL 是**写死的常量**：

- 目标域名固定为 `https://api.deepseek.com`，不存在任何从设置拼 URL 的路径
- `credentials: 'omit'` —— 不把酒馆的 Cookie 发给第三方
- `referrerPolicy: 'no-referrer'` —— 不带 Referer
- `redirect: 'error'` —— 就算对方 302 跳转，也不会带着密钥跟过去
- 密钥形态在本地先校验（可打印 ASCII、无空白、8–200 字符），带换行/空格的密钥**连请求都不会构造**（顺带挡住 CRLF 头注入）

**密钥不会出现在**
DOM（包括混淆值，已由 jsdom 测试断言整个 `<body>` 里都搜不到）、`console.log`、
URL、`localStorage`。日志只保留 `console.warn/info`，且不打印任何密钥相关变量。

**注入面为零**
所有动态内容（余额数字、上游错误文本、tooltip）一律走 `textContent` / 属性赋值，
唯一一次 `innerHTML` 是**无插值的静态模板**（由 `tests/static-audit.test.mjs` 强制校验）。
上游返回的错误文本还会被清洗：去掉控制字符、双向覆盖字符（RTL 欺骗）、零宽字符并截断到 300 字。

---

## 测试

59 项测试，零运行时依赖（只有开发期的 jsdom）：

```bash
npm install        # 装 jsdom（仅测试用）
npm test           # 单元测试 + 静态安全审计 + jsdom 集成测试
npm run smoke      # 实网烟囱测试，需要环境变量 DEEPSEEK_API_KEY，会真的调一次接口
```

| 文件 | 覆盖内容 |
|---|---|
| `tests/lib.test.mjs` | 密钥混淆往返、篡改检测、设置净化（含原型污染）、请求构造、响应规范化、错误分类、文本清洗、视图计算 |
| `tests/static-audit.test.mjs` | 危险 sink 扫描（`eval` / `new Function` / `document.write` / `innerHTML` 插值）、fetch 目标白名单、`Authorization` 只出现一次且只在 `buildBalanceRequest` 里、日志纪律、`lib.js` 保持纯净、仓库里不得出现真实密钥或酒馆用户数据文件、CSS 不外链、CSS 里"框内那一行"保持一体式且状态色落在行本身 |
| `tests/dom.test.mjs` | 在 jsdom 里真的加载 `index.js`：余额行位置（`#send_form` **内部第一行**，且输入行结构不被扰动）、`#send_form` 缺失时的兜底挂载、挂载幂等（重复 enable 不会插出两条）、抽屉结构符合 ST 折叠约定、保存密钥→查询→渲染全流程、密钥不进 DOM、生成结束防抖、停用后丢弃在途结果并不再轮询、标题栏刷新按钮不冒泡、错误文本不当成 HTML |

`lib.js` 是纯函数层（不碰 DOM / 全局 / 网络），`index.js` 只做接线——这也是这些测试能覆盖到安全关键逻辑的原因。

---

## 兼容与已知限制

- SillyTavern **≥ 1.11.0**（`minimum_client_version`），实测 1.18.0
- 浏览器需能直连 `https://api.deepseek.com`（公司代理/广告拦截插件可能拦掉，界面会显示「网络请求失败」）
- 只支持 **DeepSeek**。多厂商（中转站 / New API `/api/usage/token` / OpenRouter `/api/credits`）需要各自端点和解析器，暂未实现
- `total_balance` 取 `balance_infos[0]`（DeepSeek 目前只返回一个币种）
- 余额是**查询**，不是实时推送：最快也就是「每次生成结束后 2.5 秒」

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 显示「未配置密钥」 | 还没给密钥。扩展设置里填，或打开 `allowKeysExposure: true` |
| 显示「查询失败」+ `BAD_KEY` | 密钥错了或被禁用（401） |
| `HTTP_429` | 请求太频繁，调大间隔 |
| 「网络请求失败」 | 被跨域/代理/拦截插件挡住；确认浏览器能打开 `https://api.deepseek.com` |
| 输入框里没有那一行 | 页面没刷新（先硬刷新 Ctrl+Shift+R，扩展脚本没有加 cache-busting 参数）；若仍没有，看控制台有没有模块加载错误 |
| 那一行跑到输入框外面去了 | 说明 `#send_form` 当时还没渲染出来，走了 `index.js` 里 `mount()` 的兜底分支（`.ds-balance-bar--above`）；刷新页面即可，正常情况下不会发生 |
| 想改那一行的样子 | 见上面「外观怎么调」 |

---

## 许可

MIT
