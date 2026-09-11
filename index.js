/**
 * DeepSeek 余额 · SillyTavern 第三方扩展（主入口）
 * =====================================================================
 * 显示原理移植自 DSH 插件 @local/ds-balance：
 *   1) 固定端点 GET https://api.deepseek.com/user/balance（Bearer 鉴权）
 *   2) 把响应规范化成 { ok, at, isAvailable, balances[] } 单一结果对象
 *   3) 挂载即查一次 → 定时轮询（默认 60s）→ 手动 ↻ → 低余额阈值变红
 *   4) 同一时刻只允许一个在途请求（inFlight 互斥）
 *
 * 与 ds-balance 的差异（ST 扩展没有 Host 半部）：
 *   - ds-balance 由主机端读密钥、浏览器只读同源端点；本扩展在浏览器直连 DeepSeek。
 *     已实测 api.deepseek.com 回显 Origin（access-control-allow-origin +
 *     allow-headers: authorization），故无需服务端插件即可跨域访问。
 *   - 密钥优先取扩展设置里的（用户粘贴），否则尝试读酒馆密钥库的 api_key_deepseek
 *     （需要 config.yaml 里 allowKeysExposure: true，否则 /api/secrets/find 返回 403）。
 *
 * ST 侧增强（比纯轮询更"实时"）：
 *   - 监听 GENERATION_ENDED：生成刚结束、余额刚变化时刷新（防抖 2.5s）
 *   - 监听 visibilitychange：标签页重新可见且数据过期时刷新
 *   - 连续失败指数退避（最多 10 分钟），恢复后自动回到正常间隔
 *
 * 本文件只做"接线"：所有解析、校验、格式化、视图计算都在 lib.js（纯函数，可单测）。
 * 安全约束：动态内容一律走 textContent / attribute setter，从不拼 HTML；
 *          密钥只出现在 lib.js buildBalanceRequest 产出的 Authorization 头里。
 */

import {
    MODULE,
    DEFAULT_SETTINGS,
    ERROR_TEXT,
    CONFIG_ERRORS,
    REQUEST_TIMEOUT_MS,
    MIN_INTERVAL_SEC,
    MAX_INTERVAL_SEC,
    GEN_DEBOUNCE_MS,
    STALE_MS,
    MAX_BACKOFF_MS,
    TAVERN_SECRET_KEY,
    parseSettings,
    encodeKey,
    decodeKey,
    buildBalanceRequest,
    buildSecretsRequest,
    classifySecretStatus,
    classifyHttpError,
    extractErrorMessage,
    normalizeBalance,
    computeBalanceView,
    currencySymbol,
    formatAmount,
    formatTime,
    headline,
    sanitizeMessage,
} from './lib.js';

const BAR_ID = 'ds_balance_bar';
const PANEL_ID = 'ds_balance_panel';

const ctx = SillyTavern.getContext();
const { extensionSettings, saveSettingsDebounced, eventSource, eventTypes } = ctx;

/** 运行时状态（不持久化） */
const state = {
    active: false,
    inFlight: false,
    failures: 0,
    result: null,
    lastOkAt: 0,
    delta: null,
    lastTotal: null,
    timer: null,
    genTimer: null,
    mounted: false,
};

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function getSettings() {
    const raw = extensionSettings[MODULE];
    const clean = parseSettings(raw);

    // 只在必要时写回，避免每次读取都触发 settings 变更
    if (!raw || typeof raw !== 'object') {
        extensionSettings[MODULE] = clean;
    } else {
        let dirty = false;
        for (const [k, v] of Object.entries(clean)) {
            if (raw[k] !== v) { raw[k] = v; dirty = true; }
        }
        for (const k of Object.keys(raw)) {
            if (!(k in clean)) { delete raw[k]; dirty = true; }
        }
        if (dirty) saveSettings();
    }
    return extensionSettings[MODULE];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// 密钥解析：扩展设置 → 酒馆密钥库
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{key?: string, source?: 'settings'|'tavern', error?: string}>}
 */
async function resolveKey() {
    const manual = decodeKey(getSettings().apiKeyEnc);
    if (manual) return { key: manual, source: 'settings' };

    try {
        const request = buildSecretsRequest(ctx.getRequestHeaders());
        const res = await fetch(request.url, request.init);
        if (res.ok) {
            const data = await res.json();
            const value = typeof data?.value === 'string' ? data.value.trim() : '';
            return value ? { key: value, source: 'tavern' } : { error: 'KEY_MISSING' };
        }
        return { error: classifySecretStatus(res.status) };
    } catch (e) {
        return { error: 'SECRET_FAILED' };
    }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

async function queryBalance() {
    const resolved = await resolveKey();
    if (resolved.error) {
        return { ok: false, error: resolved.error, message: ERROR_TEXT[resolved.error] || resolved.error };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const request = buildBalanceRequest(resolved.key, controller.signal);
        if (!request) {
            return { ok: false, error: 'BAD_KEY_FORMAT', message: ERROR_TEXT.BAD_KEY_FORMAT };
        }

        const res = await fetch(request.url, request.init);

        if (!res.ok) {
            let message = 'HTTP ' + res.status;
            try {
                message = extractErrorMessage(await res.json()) || message;
            } catch (e) { /* 非 JSON 响应 */ }
            const error = classifyHttpError(res.status);
            const known = ERROR_TEXT[error];
            return {
                ok: false,
                error,
                message: sanitizeMessage(known ? `${known}：${message}` : message),
            };
        }

        return normalizeBalance(await res.json(), resolved.source);
    } catch (e) {
        if (e?.name === 'AbortError') {
            return { ok: false, error: 'TIMEOUT', message: ERROR_TEXT.TIMEOUT };
        }
        console.warn('[ds-balance] 请求失败', e?.name || e?.message || e);
        return { ok: false, error: 'NETWORK', message: ERROR_TEXT.NETWORK };
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// 刷新调度
// ---------------------------------------------------------------------------

/**
 * @param {{reason?: string}} [opts]
 */
async function refresh(opts = {}) {
    if (state.inFlight || !state.active) return;

    state.inFlight = true;
    render({ loading: true });

    let result;
    try {
        result = await queryBalance();
    } catch (e) {
        result = { ok: false, error: 'NETWORK', message: ERROR_TEXT.NETWORK };
    } finally {
        state.inFlight = false;
    }

    // 请求飞在半路时扩展被停用（onDisable）→ 结果直接丢掉：
    // 既不再碰已经拆掉的界面，也不排下一轮 —— 否则停用后会一直偷偷轮询下去。
    if (!state.active) return;

    if (result.ok) {
        const head = headline(result);
        state.delta = (head && state.lastTotal !== null) ? head.total - state.lastTotal : null;
        state.lastTotal = head ? head.total : null;
        state.lastOkAt = Date.now();
        state.failures = 0;
    } else {
        state.failures++;
    }

    state.result = result;
    render();
    renderPanelStatus();
    scheduleNext(result.ok);
}

function scheduleNext(ok) {
    clearTimeout(state.timer);
    const s = getSettings();
    if (!s.autoRefresh || !state.active) return;

    let intervalMs = s.intervalSec * 1000;
    if (!ok) {
        // 指数退避：失败 1/2/3/4 次 → 2x/4x/8x/16x，封顶 10 分钟
        const factor = Math.pow(2, Math.min(state.failures, 4));
        intervalMs = Math.min(intervalMs * factor, MAX_BACKOFF_MS);
    }
    state.timer = setTimeout(() => refresh({ reason: 'timer' }), intervalMs);
}

function scheduleGenerationRefresh() {
    if (!state.active || !getSettings().refreshOnGeneration) return;
    clearTimeout(state.genTimer);
    // 生成刚结束时上游余额可能还没结算，延迟一点再查
    state.genTimer = setTimeout(() => refresh({ reason: 'generation' }), GEN_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// 界面：输入框里额外那一行（余额条，挂在 #send_form 内部）
// ---------------------------------------------------------------------------

function buildBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'ds-balance-bar';

    const chip = document.createElement('div');
    chip.className = 'ds-balance-chip';
    chip.id = `${BAR_ID}_chip`;
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');

    const dot = document.createElement('span');
    dot.className = 'ds-balance-dot';

    const label = document.createElement('span');
    label.className = 'ds-balance-label';
    label.textContent = 'DeepSeek';

    const amount = document.createElement('span');
    amount.className = 'ds-balance-amount';
    amount.id = `${BAR_ID}_amount`;
    amount.textContent = '—';

    chip.append(dot, label, amount);

    const refreshBtn = document.createElement('div');
    refreshBtn.className = 'ds-balance-refresh';
    refreshBtn.id = `${BAR_ID}_refresh`;
    refreshBtn.textContent = '↻';
    refreshBtn.title = '立即刷新余额';
    refreshBtn.setAttribute('role', 'button');
    refreshBtn.tabIndex = 0;

    bar.append(chip, refreshBtn);

    chip.addEventListener('click', () => showDetailPopup());
    chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetailPopup(); }
    });
    refreshBtn.addEventListener('click', () => refresh({ reason: 'manual' }));
    refreshBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refresh({ reason: 'manual' }); }
    });

    return bar;
}

const STATE_CLASSES = ['is-loading', 'is-low', 'is-error', 'is-unconfigured'];

/**
 * 把 lib.js 算出的视图落到两处界面元素上（余额条 + 设置面板标题栏）
 * 全程 textContent / classList / 属性赋值，无 innerHTML。
 * @param {{loading?: boolean}} [opts]
 */
function render(opts = {}) {
    const view = computeBalanceView({
        result: state.result,
        settings: getSettings(),
        loading: Boolean(opts.loading),
        delta: state.delta,
    });

    const bar = document.getElementById(BAR_ID);
    const settings = getSettings();

    if (bar) {
        bar.classList.toggle('is-loading', Boolean(opts.loading));
        for (const cls of STATE_CLASSES) {
            if (cls === 'is-loading') continue;
            bar.classList.toggle(cls, view.state === cls.replace('is-', ''));
        }
        const amountEl = document.getElementById(`${BAR_ID}_amount`);
        if (amountEl) amountEl.textContent = view.text;
        const refreshEl = document.getElementById(`${BAR_ID}_refresh`);
        if (refreshEl) refreshEl.style.display = settings.showRefreshButton ? '' : 'none';
        const chip = bar.querySelector('.ds-balance-chip');
        if (chip) chip.title = view.title;
    }

    const headerChip = document.getElementById(`${BAR_ID}_header_chip`);
    if (headerChip) {
        headerChip.classList.toggle('is-loading', Boolean(opts.loading));
        for (const cls of STATE_CLASSES) {
            if (cls === 'is-loading') continue;
            headerChip.classList.toggle(cls, view.state === cls.replace('is-', ''));
        }
        const headerAmount = document.getElementById(`${BAR_ID}_header_amount`);
        if (headerAmount) headerAmount.textContent = view.text;
        headerChip.title = view.title;
    }

    const headerRefresh = document.getElementById(`${BAR_ID}_header_refresh`);
    if (headerRefresh) headerRefresh.style.display = settings.showRefreshButton ? '' : 'none';
}

/**
 * 点击余额条 / 标题栏上的余额 → 详情弹窗
 */
async function showDetailPopup() {
    const result = state.result;
    const s = getSettings();
    const wrap = document.createElement('div');
    wrap.className = 'ds-balance-popup';

    const title = document.createElement('h3');
    title.textContent = 'DeepSeek 账户余额';
    wrap.append(title);

    if (!result) {
        const p = document.createElement('p');
        p.textContent = '尚未查询，请先点击刷新。';
        wrap.append(p);
    } else if (!result.ok) {
        const p = document.createElement('p');
        p.className = 'ds-balance-popup-error';
        p.textContent = `查询失败 [${sanitizeMessage(result.error, 40)}]：${sanitizeMessage(result.message)}`;
        wrap.append(p);
        if (CONFIG_ERRORS.includes(result.error)) {
            const tip = document.createElement('p');
            tip.textContent = '两种解决办法（任选其一）：\n1) 打开「扩展设置 → DeepSeek 余额」，在 API 密钥里填入你的 sk- 密钥并保存；\n2) 或把 config.yaml 里的 allowKeysExposure 改成 true 并重启酒馆，扩展就会自动使用密钥库里已保存的 DeepSeek 密钥。';
            tip.style.whiteSpace = 'pre-line';
            wrap.append(tip);
        }
    } else {
        const table = document.createElement('div');
        table.className = 'ds-balance-popup-table';

        const rows = [['账户状态', result.isAvailable ? '可用' : '不可用']];
        for (const b of result.balances || []) {
            rows.push([`${b.currency} 总额`, currencySymbol(b.currency) + formatAmount(b.total)]);
            rows.push([`${b.currency} 赠送余额`, currencySymbol(b.currency) + formatAmount(b.granted)]);
            rows.push([`${b.currency} 充值余额`, currencySymbol(b.currency) + formatAmount(b.toppedUp)]);
        }
        if (state.delta !== null && state.delta !== 0) {
            rows.push(['较上次查询', `${state.delta > 0 ? '+' : '−'}${formatAmount(Math.abs(state.delta))}`]);
        }
        rows.push(['查询时间', formatTime(result.at)]);
        rows.push(['密钥来源', result.source === 'tavern' ? '酒馆密钥库（api_key_deepseek）' : '扩展设置']);
        rows.push(['低余额阈值', s.lowThreshold > 0 ? s.lowThreshold.toFixed(2) : '已关闭']);
        rows.push(['自动刷新', s.autoRefresh ? `每 ${s.intervalSec} 秒` : '已关闭']);

        for (const [k, v] of rows) {
            const row = document.createElement('div');
            row.className = 'ds-balance-popup-row';
            const kEl = document.createElement('span');
            kEl.className = 'ds-balance-popup-key';
            kEl.textContent = k;
            const vEl = document.createElement('span');
            vEl.className = 'ds-balance-popup-val';
            vEl.textContent = v;
            row.append(kEl, vEl);
            table.append(row);
        }
        wrap.append(table);
    }

    try {
        await ctx.callGenericPopup(wrap, ctx.POPUP_TYPE.TEXT, '', { okButton: '关闭', wide: false, allowVerticalScrolling: true });
    } catch (e) {
        console.warn('[ds-balance] 弹窗失败', e?.message || e);
    }
}

// ---------------------------------------------------------------------------
// 界面：扩展设置面板（ST 标准 inline-drawer，可折叠，与其他扩展同款）
// ---------------------------------------------------------------------------

/** 纯静态模板：没有插值，唯一一次 innerHTML 赋值（静态审计会校验这一点） */
const PANEL_TEMPLATE = `
<div class="extension_container" id="ds_balance_container">
    <div class="inline-drawer" id="ds_balance_drawer">
        <div class="inline-drawer-toggle inline-drawer-header" id="ds_balance_toggle">
            <span class="flex-container alignItemsCenter flexGap5 flexGrow">
                <b>DeepSeek 余额</b>
                <span class="ds-balance-chip ds-balance-chip--header" id="ds_balance_bar_header_chip">
                    <span class="ds-balance-dot"></span>
                    <span class="ds-balance-amount" id="ds_balance_bar_header_amount">—</span>
                </span>
            </span>
            <span class="flex-container alignItemsCenter flexGap5">
                <span class="menu_button menu_button_icon ds-balance-header-refresh" id="ds_balance_bar_header_refresh" title="立即刷新余额">
                    <i class="fa-solid fa-rotate"></i>
                </span>
                <span class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></span>
            </span>
        </div>
        <div class="inline-drawer-content">
          <div class="ds-balance-panel-body">
            <small class="ds-balance-hint">在输入框上方显示 DeepSeek 账户余额。默认可自动使用酒馆已保存的 DeepSeek 密钥（需 config.yaml 里 allowKeysExposure: true），否则请在下方填写。</small>

            <div class="ds-balance-field">
                <label for="ds_balance_key">API 密钥</label>
                <input id="ds_balance_key" type="password" class="text_pole" placeholder="sk-...（留空则尝试读取酒馆密钥库）" autocomplete="off" spellcheck="false">
            </div>
            <div class="ds-balance-row">
                <div id="ds_balance_key_save" class="menu_button">保存密钥</div>
                <div id="ds_balance_key_clear" class="menu_button">清除密钥</div>
                <div id="ds_balance_key_hint" class="ds-balance-keyhint"></div>
            </div>

            <div class="ds-balance-row">
                <label class="checkbox_label" for="ds_balance_auto"><input id="ds_balance_auto" type="checkbox"><span>自动刷新</span></label>
                <label for="ds_balance_interval">间隔（秒）</label>
                <input id="ds_balance_interval" type="number" min="10" max="86400" step="10" class="text_pole ds-balance-num">
            </div>

            <div class="ds-balance-row">
                <label for="ds_balance_threshold">低余额告警阈值</label>
                <input id="ds_balance_threshold" type="number" min="0" step="1" class="text_pole ds-balance-num">
                <span class="ds-balance-note">0 = 关闭告警</span>
            </div>

            <div class="ds-balance-row">
                <label class="checkbox_label" for="ds_balance_gen"><input id="ds_balance_gen" type="checkbox"><span>每次生成结束后自动刷新</span></label>
            </div>
            <div class="ds-balance-row">
                <label class="checkbox_label" for="ds_balance_btn"><input id="ds_balance_btn" type="checkbox"><span>显示刷新按钮</span></label>
            </div>

            <div class="ds-balance-row">
                <div id="ds_balance_now" class="menu_button">立即查询</div>
                <div id="ds_balance_save" class="menu_button">保存设置</div>
                <div id="ds_balance_details" class="menu_button">查看详情</div>
            </div>
            <div id="ds_balance_status" class="ds-balance-status"></div>
          </div>
        </div>
    </div>
</div>
`;

function buildSettingsPanel() {
    if (document.getElementById(PANEL_ID)) return;

    // 与其他扩展同款：挂到扩展设置主列（#extensions_settings），退化时才用第二列
    const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!host) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'ds-balance-panel';
    panel.innerHTML = PANEL_TEMPLATE;
    host.append(panel);

    const s = getSettings();
    const $ = (id) => document.getElementById(id);

    $('ds_balance_auto').checked = s.autoRefresh;
    $('ds_balance_interval').value = String(s.intervalSec);
    $('ds_balance_threshold').value = String(s.lowThreshold);
    $('ds_balance_gen').checked = s.refreshOnGeneration;
    $('ds_balance_btn').checked = s.showRefreshButton;
    $('ds_balance_key_hint').textContent = s.apiKeyEnc ? '已保存密钥（不回显）' : '未保存密钥';

    // 标题栏里的刷新按钮：阻止冒泡，避免顺带把抽屉收起来
    $('ds_balance_bar_header_refresh').addEventListener('click', (e) => {
        e.stopPropagation();
        refresh({ reason: 'manual' });
    });

    $('ds_balance_key_save').addEventListener('click', () => {
        const raw = $('ds_balance_key').value.trim();
        if (!raw) {
            toast('请先填入 API 密钥', 'warning');
            return;
        }
        if (!raw.startsWith('sk-')) {
            toast('密钥一般以 sk- 开头，请确认是否填错', 'warning');
        }
        try {
            // 混淆失败就"失败关闭"：宁可存不进去，也不退回明文
            getSettings().apiKeyEnc = encodeKey(raw);
        } catch (e) {
            console.warn('[ds-balance] 密钥混淆失败，已放弃保存', e?.message || e);
            toast('密钥保存失败（本地混淆出错），未写入任何内容', 'error');
            return;
        }
        saveSettings();
        $('ds_balance_key').value = '';
        $('ds_balance_key_hint').textContent = '已保存密钥（不回显）';
        toast('已保存 DeepSeek 密钥', 'success');
        refresh({ reason: 'manual' });
    });

    $('ds_balance_key_clear').addEventListener('click', () => {
        getSettings().apiKeyEnc = '';
        saveSettings();
        $('ds_balance_key').value = '';
        $('ds_balance_key_hint').textContent = '未保存密钥';
        toast('已清除扩展内保存的密钥', 'info');
        refresh({ reason: 'manual' });
    });

    $('ds_balance_save').addEventListener('click', () => {
        const st = getSettings();
        const intervalRaw = $('ds_balance_interval').value.trim();
        const thresholdRaw = $('ds_balance_threshold').value.trim();
        const interval = Number(intervalRaw);
        if (!intervalRaw || !Number.isFinite(interval) || interval < MIN_INTERVAL_SEC || interval > MAX_INTERVAL_SEC) {
            toast(`刷新间隔需在 ${MIN_INTERVAL_SEC}–${MAX_INTERVAL_SEC} 秒之间`, 'error');
            return;
        }
        const threshold = Number(thresholdRaw);
        if (!thresholdRaw || !Number.isFinite(threshold) || threshold < 0) {
            toast('低余额阈值需 ≥ 0（填 0 表示关闭告警）', 'error');
            return;
        }
        st.intervalSec = Math.round(interval);
        st.lowThreshold = threshold;
        st.autoRefresh = $('ds_balance_auto').checked;
        st.refreshOnGeneration = $('ds_balance_gen').checked;
        st.showRefreshButton = $('ds_balance_btn').checked;
        saveSettings();
        toast('设置已保存', 'success');
        render();
        renderPanelStatus();
        scheduleNext(true);
    });

    $('ds_balance_now').addEventListener('click', () => refresh({ reason: 'manual' }));
    $('ds_balance_details').addEventListener('click', () => showDetailPopup());

    renderPanelStatus();
}

function renderPanelStatus() {
    const el = document.getElementById('ds_balance_status');
    if (!el) return;
    const result = state.result;
    if (!result) {
        el.textContent = '状态：尚未查询';
        el.className = 'ds-balance-status';
        return;
    }
    if (result.ok) {
        const head = headline(result);
        el.textContent = `状态：正常 · ${head ? currencySymbol(head.currency) + formatAmount(head.total) : '无数据'} · 查询于 ${formatTime(result.at)} · 来源 ${result.source === 'tavern' ? '酒馆密钥库' : '扩展设置'}`;
        el.className = 'ds-balance-status is-ok';
    } else {
        el.textContent = `状态：失败 [${sanitizeMessage(result.error, 40)}] ${sanitizeMessage(result.message)}`;
        el.className = 'ds-balance-status is-error';
    }
}

function toast(message, type = 'info') {
    if (typeof toastr !== 'undefined' && typeof toastr[type] === 'function') {
        toastr[type](message, 'DeepSeek 余额');
    } else {
        console.info('[ds-balance] ' + message);
    }
}

// ---------------------------------------------------------------------------
// 挂载
// ---------------------------------------------------------------------------

/**
 * 给余额行打上"放在哪儿"的标记，决定 CSS 走哪一套样式
 * （框内一行 = 一体式；框外一条 = 旧的独立小条外观）
 * @param {HTMLElement} bar
 * @param {'inline'|'above'} mode
 */
function setBarPlacement(bar, mode) {
    bar.classList.toggle('ds-balance-bar--inline', mode === 'inline');
    bar.classList.toggle('ds-balance-bar--above', mode === 'above');
}

function mount() {
    const sendForm = document.getElementById('send_form');
    const existing = document.getElementById(BAR_ID);

    // 已经待在输入框里了 → 什么都不用做（挂载是幂等的，onEnable/重试都会走到这里）
    if (existing && sendForm && existing.parentElement === sendForm) {
        state.mounted = true;
        return true;
    }

    const bar = existing || buildBar();

    // 首选：#send_form 内部的第一行。
    // #send_form 本身就是 flex-wrap 容器（见 public/style.css），宽 100% 的子元素会自动独占一行，
    // 所以余额行和输入行共用同一个带边框 + 毛玻璃底色的盒子 —— 外观上就是输入框多出来的一行。
    // 布局顺序交给 CSS 的 order 管（余额行 order:-1，压过 #file_form:0 / #qr--bar:1 /
    // #nonQRFormItems:25），因此这里用 prepend 就够：它是幂等的，重复调用不会插出第二份。
    if (sendForm) {
        sendForm.prepend(bar);
        setBarPlacement(bar, 'inline');
        state.mounted = true;
        return true;
    }

    // 兜底：#send_form 还没渲染出来（index.html 里是静态节点，正常不会发生）。
    // 退回旧行为 —— 先挂在 #form_sheld 顶部、用独立小条样式；下次 mount() 会把它挪进框内。
    const formSheld = document.getElementById('form_sheld');
    if (formSheld) {
        formSheld.prepend(bar);
        setBarPlacement(bar, 'above');
        state.mounted = true;
        return true;
    }

    return false;
}

function mountWithRetry(attempt = 0) {
    state.active = true;
    buildSettingsPanel();

    if (mount()) {
        render();
        refresh({ reason: 'init' });
        return;
    }
    if (attempt < 40) {
        setTimeout(() => {
            if (state.active) mountWithRetry(attempt + 1);
        }, 250);
    } else {
        console.warn('[ds-balance] 未找到 #form_sheld / #send_form，无法挂载余额行');
    }
}

function cleanup() {
    state.active = false;
    clearTimeout(state.timer);
    clearTimeout(state.genTimer);
    state.timer = null;
    state.genTimer = null;
    document.getElementById(BAR_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
    state.mounted = false;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

jQuery(async () => {
    getSettings();

    mountWithRetry();

    // 生成结束：余额刚变化，防抖后刷新（ST 独有的"实时"来源）
    eventSource.on(eventTypes.GENERATION_ENDED, scheduleGenerationRefresh);

    // 标签页重新可见：数据过期才刷新，避免无谓请求
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - state.lastOkAt > STALE_MS) {
            refresh({ reason: 'visible' });
        }
    });

    // 设置变化（例如别处改动了 extension_settings）后重建定时器
    eventSource.on(eventTypes.SETTINGS_UPDATED, () => {
        render();
        scheduleNext(true);
    });
});

export function onDisable() {
    cleanup();
}

export function onEnable() {
    mountWithRetry();
}
