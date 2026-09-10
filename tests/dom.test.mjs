/**
 * DOM 集成测试（jsdom，node --test）
 * =====================================================================
 * 把真实的 index.js 塞进一个"迷你酒馆 DOM"里跑起来，验证：
 *   - 余额条确实落在 #form_sheld 内、#send_form（输入框）之前 → 对话框左上方
 *   - 设置面板是 ST 标准 inline-drawer 结构（可折叠，与其他扩展同款）
 *   - 走完"保存密钥 → 查询 → 渲染"全流程，数字落到两处界面元素上
 *   - 密钥永远不会出现在 DOM 里；Authorization 头只在真正请求时出现一次
 *   - GENERATION_ENDED 触发的是防抖刷新（不是立刻打接口）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const SECRET = 'sk-test-0123456789abcdef';
const BALANCE_JSON = {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '12.22', granted_balance: '0.00', topped_up_balance: '12.22' }],
};

const HTML = `<!DOCTYPE html><html><body>
    <div id="extensions_settings"></div>
    <div id="extensions_settings2"></div>
    <div id="form_sheld">
        <div id="dialogue_del_mes"></div>
        <div id="send_form">
            <div id="file_form"></div>
            <div id="nonQRFormItems">
                <div id="leftSendForm"></div>
                <textarea id="send_textarea"></textarea>
                <div id="rightSendForm"></div>
            </div>
        </div>
    </div>
</body></html>`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const fakeResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
});

let caseId = 0;

/**
 * 起一个最小的"酒馆"，把 index.js 作为模块加载进去。
 * @param {{secretsStatus?: number, secretsValue?: string, balanceStatus?: number, balanceBody?: object}} opts
 */
async function boot(opts = {}) {
    const {
        secretsStatus = 403,
        secretsValue = SECRET,
        balanceStatus = 200,
        balanceBody = BALANCE_JSON,
    } = opts;

    const dom = new JSDOM(HTML, { url: 'http://127.0.0.1:8000/' });
    const { window } = dom;

    const calls = [];
    const events = new Map();

    const ctx = {
        extensionSettings: {},
        saveSettingsDebounced: () => { calls.push({ type: 'save' }); },
        eventSource: {
            on: (name, handler) => {
                if (!events.has(name)) events.set(name, []);
                events.get(name).push(handler);
            },
        },
        eventTypes: { GENERATION_ENDED: 'generation_ended', SETTINGS_UPDATED: 'settings_updated', APP_READY: 'app_ready' },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
        callGenericPopup: async (content) => { calls.push({ type: 'popup', content }); },
        POPUP_TYPE: { TEXT: 1 },
    };

    const fetchCalls = [];
    window.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        if (String(url).includes('/api/secrets/find')) {
            return secretsStatus === 200
                ? fakeResponse(200, { value: secretsValue })
                : fakeResponse(secretsStatus, { error: true });
        }
        return fakeResponse(balanceStatus, balanceBody);
    };

    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.fetch = window.fetch;
    globalThis.SillyTavern = { getContext: () => ctx };
    globalThis.toastr = undefined;

    let initPromise = null;
    globalThis.jQuery = (fn) => { initPromise = Promise.resolve().then(fn); return { on() { return this; } }; };
    window.jQuery = globalThis.jQuery;

    // 每个用例用不同的 URL 查询串，拿到互不干扰的模块实例
    const href = new URL(`../index.js?case=${++caseId}`, import.meta.url).href;
    const mod = await import(href);
    await initPromise;
    await sleep(30); // 等假 fetch 的回调跑完

    return {
        window,
        document: window.document,
        mod,
        ctx,
        calls,
        fetchCalls,
        balanceCalls: () => fetchCalls.filter(c => c.url.includes('api.deepseek.com')),
        fire: (name) => (events.get(name) || []).forEach(h => h()),
        shutdown: () => mod.onDisable(),
        $: (sel) => window.document.querySelector(sel),
        id: (id) => window.document.getElementById(id),
    };
}

// ---------------------------------------------------------------------------
// 用例 1：没配密钥时的挂载与外观
// ---------------------------------------------------------------------------

test('余额条落在 #form_sheld 内、#send_form 之前（对话框左上方）', async () => {
    const h = await boot({ secretsStatus: 403 });
    try {
        const bar = h.id('ds_balance_bar');
        assert.ok(bar, '余额条应已挂载');
        assert.equal(bar.parentElement.id, 'form_sheld');
        assert.equal(bar.nextElementSibling.id, 'send_form', '必须紧贴在输入框之前');
        assert.ok(bar.className.includes('ds-balance-bar'));
        assert.ok(bar.querySelector('.ds-balance-chip'), '应有余额徽标');
        assert.ok(!bar.querySelector('#send_textarea'), '不能把输入框包进来');
    } finally {
        h.shutdown();
    }
});

test('设置面板是 ST 标准 inline-drawer 结构（与其他扩展同款，可折叠）', async () => {
    const h = await boot({ secretsStatus: 403 });
    try {
        const panel = h.id('ds_balance_panel');
        assert.ok(panel, '面板应已挂载');
        assert.equal(panel.parentElement.id, 'extensions_settings', '应挂在扩展设置主列');

        const drawer = panel.querySelector('.inline-drawer');
        assert.ok(drawer, '外层必须是 .inline-drawer');

        // ST 核心的折叠逻辑：$(document).on('click', '.inline-drawer-toggle')
        // → closest('.inline-drawer') → 找 '>.inline-drawer-header .inline-drawer-icon' 与 '>.inline-drawer-content'
        const header = drawer.querySelector(':scope > .inline-drawer-toggle.inline-drawer-header');
        const content = drawer.querySelector(':scope > .inline-drawer-content');
        const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
        assert.ok(header, '标题栏必须同时带 inline-drawer-toggle 与 inline-drawer-header');
        assert.ok(content, '内容区必须是 .inline-drawer 的直接子元素');
        assert.ok(icon, '必须有折叠箭头图标');

        // 箭头初始态：收起（down + fa-circle-chevron-down）
        assert.ok(icon.classList.contains('fa-solid'));
        assert.ok(icon.classList.contains('fa-circle-chevron-down'));
        assert.ok(icon.classList.contains('down'));

        // 标题栏里带实时余额徽标 + 刷新按钮
        assert.ok(header.querySelector('#ds_balance_bar_header_chip'), '标题栏应有余额徽标');
        assert.ok(header.querySelector('#ds_balance_bar_header_refresh'), '标题栏应有刷新按钮');
        assert.equal(header.querySelectorAll('script').length, 0);

        // 模板是静态的：面板里不应出现任何脚本
        assert.equal(panel.querySelectorAll('script').length, 0);
    } finally {
        h.shutdown();
    }
});

test('未配置密钥时呈现中性的"未配置密钥"，且完全不发余额请求', async () => {
    const h = await boot({ secretsStatus: 403 });
    try {
        assert.equal(h.id('ds_balance_bar_amount').textContent, '未配置密钥');
        assert.ok(h.id('ds_balance_bar').classList.contains('is-unconfigured'));
        assert.ok(!h.id('ds_balance_bar').classList.contains('is-error'), '待配置不该显示成红色失败');
        assert.equal(h.id('ds_balance_bar_header_amount').textContent, '未配置密钥');
        assert.equal(h.balanceCalls().length, 0, '没密钥就不该打 DeepSeek 接口');
        assert.ok(h.id('ds_balance_status').textContent.includes('KEY_FORBIDDEN') || h.id('ds_balance_status').textContent.includes('失败'));
    } finally {
        h.shutdown();
    }
});

// ---------------------------------------------------------------------------
// 用例 2：保存密钥 → 查询 → 渲染（端到端）
// ---------------------------------------------------------------------------

test('走完"保存密钥 → 查询 → 渲染"全流程，余额落到余额条与标题栏', async () => {
    const h = await boot({ secretsStatus: 403 });
    try {
        const input = h.id('ds_balance_key');
        assert.equal(input.type, 'password', '密钥输入框必须是密码框');
        input.value = SECRET;
        h.id('ds_balance_key_save').click();
        await sleep(30);

        assert.equal(h.id('ds_balance_bar_amount').textContent, '¥12.22');
        assert.equal(h.id('ds_balance_bar_header_amount').textContent, '¥12.22');
        assert.ok(!h.id('ds_balance_bar').classList.contains('is-error'));
        assert.ok(!h.id('ds_balance_bar').classList.contains('is-unconfigured'));
        assert.equal(input.value, '', '保存后输入框要被清空');
        assert.equal(h.id('ds_balance_key_hint').textContent, '已保存密钥（不回显）');

        // 真的把这把密钥送去 DeepSeek，且请求头是 lib.js 构造的那一套
        const balanceCalls = h.balanceCalls();
        assert.equal(balanceCalls.length, 1);
        const { url, init } = balanceCalls[0];
        assert.equal(url, 'https://api.deepseek.com/user/balance');
        assert.equal(init.headers.Authorization, 'Bearer ' + SECRET);
        assert.equal(init.credentials, 'omit');
        assert.equal(init.redirect, 'error');

        // 密钥绝不落进 DOM：整个 body 的 HTML 里都不能出现它（连混淆值也不行）
        const enc = h.ctx.extensionSettings['deepseek-balance'].apiKeyEnc;
        assert.ok(enc.startsWith('v1:'), '落盘的是 v1 混淆值');
        assert.ok(!h.document.body.innerHTML.includes(SECRET), '明文密钥不能出现在 DOM');
        assert.ok(!h.document.body.innerHTML.includes(enc), '混淆值也不该出现在 DOM');

        // 标题栏徽标的 tooltip 是纯文本，可读
        const title = h.id('ds_balance_bar_header_chip').title;
        assert.ok(title.includes('账户可用'));
        assert.ok(title.includes('¥12.22'));
        assert.ok(title.includes('扩展设置'), '应标出密钥来源');
    } finally {
        h.shutdown();
    }
});

test('点击余额徽标弹出的详情是 DOM 节点、且不含脚本', async () => {
    const h = await boot({ secretsStatus: 403 });
    try {
        h.id('ds_balance_key').value = SECRET;
        h.id('ds_balance_key_save').click();
        await sleep(30);

        h.id('ds_balance_bar_chip').click();
        await sleep(10);

        const popup = h.calls.filter(c => c.type === 'popup').pop();
        assert.ok(popup, '应调用 callGenericPopup');
        assert.ok(popup.content instanceof h.window.HTMLElement, '传的是 DOM 节点而不是 HTML 字符串');
        assert.ok(popup.content.textContent.includes('¥12.22'));
        assert.equal(popup.content.querySelectorAll('script').length, 0);
    } finally {
        h.shutdown();
    }
});

test('GENERATION_ENDED 触发的是防抖刷新，而不是立刻打接口', async () => {
    const h = await boot({ secretsStatus: 403 });
    try {
        h.id('ds_balance_key').value = SECRET;
        h.id('ds_balance_key_save').click();
        await sleep(30);
        const before = h.balanceCalls().length;

        h.fire('generation_ended');
        await sleep(50);
        assert.equal(h.balanceCalls().length, before, '防抖期内不应发请求');

        await sleep(2700);
        assert.equal(h.balanceCalls().length, before + 1, '防抖结束后应刷新一次');
    } finally {
        h.shutdown();
    }
});

test('标题栏刷新按钮可用，且不会连累折叠（stopPropagation）', async () => {
    const h = await boot({ secretsStatus: 403 });
    try {
        h.id('ds_balance_key').value = SECRET;
        h.id('ds_balance_key_save').click();
        await sleep(30);
        const before = h.balanceCalls().length;

        let propagated = false;
        h.document.addEventListener('click', () => { propagated = true; });
        h.id('ds_balance_bar_header_refresh').click();
        await sleep(30);

        assert.equal(h.balanceCalls().length, before + 1, '点标题栏刷新应立刻查一次');
        assert.equal(propagated, false, '事件不应冒泡到 document（否则会顺带收起抽屉）');
    } finally {
        h.shutdown();
    }
});

test('低余额阈值：改阈值后徽标进入 is-low 告警态', async () => {
    const h = await boot({ secretsStatus: 403 });
    try {
        h.id('ds_balance_key').value = SECRET;
        h.id('ds_balance_key_save').click();
        await sleep(30);
        assert.ok(!h.id('ds_balance_bar').classList.contains('is-low'));

        h.id('ds_balance_threshold').value = '50';
        h.id('ds_balance_save').click();
        await sleep(10);

        assert.ok(h.id('ds_balance_bar').classList.contains('is-low'), '¥12.22 低于 ¥50 应告警');
        assert.ok(h.id('ds_balance_bar_header_chip').classList.contains('is-low'));
        assert.ok(h.id('ds_balance_bar_header_chip').title.includes('请及时充值'));
    } finally {
        h.shutdown();
    }
});

test('非法间隔/阈值不会写进设置（前端也要校验）', async () => {
    const h = await boot({ secretsStatus: 403 });
    try {
        const st = h.ctx.extensionSettings['deepseek-balance'];
        const before = { ...st };

        h.id('ds_balance_interval').value = '1';
        h.id('ds_balance_save').click();
        assert.equal(st.intervalSec, before.intervalSec, '低于最小间隔应被拒绝');

        h.id('ds_balance_interval').value = '60';
        h.id('ds_balance_threshold').value = '';
        h.id('ds_balance_save').click();
        assert.equal(st.lowThreshold, before.lowThreshold, '空阈值应被拒绝');

        h.id('ds_balance_interval').value = 'abc';
        h.id('ds_balance_save').click();
        assert.equal(st.intervalSec, before.intervalSec);
    } finally {
        h.shutdown();
    }
});

// ---------------------------------------------------------------------------
// 用例 3：密钥来自酒馆密钥库（allowKeysExposure: true 的场景）
// ---------------------------------------------------------------------------

test('扩展设置没密钥时回落到酒馆密钥库，并在界面上标出来源', async () => {
    const h = await boot({ secretsStatus: 200, secretsValue: SECRET });
    try {
        assert.equal(h.id('ds_balance_bar_amount').textContent, '¥12.22');
        assert.equal(h.balanceCalls().length, 1);
        assert.equal(h.balanceCalls()[0].init.headers.Authorization, 'Bearer ' + SECRET);
        assert.ok(h.id('ds_balance_bar_header_chip').title.includes('酒馆密钥库'));
        assert.ok(!h.document.body.innerHTML.includes(SECRET));
    } finally {
        h.shutdown();
    }
});

test('接口报错时呈现失败态，且错误文本被清洗（含标签也只会当文字）', async () => {
    const h = await boot({
        secretsStatus: 200,
        secretsValue: SECRET,
        balanceStatus: 500,
        balanceBody: { error: { message: '<img src=x onerror=alert(1)>\u202Eevil' } },
    });
    try {
        assert.equal(h.id('ds_balance_bar_amount').textContent, '查询失败');
        assert.ok(h.id('ds_balance_bar').classList.contains('is-error'));
        // 响应里的 HTML 只能以文字形态存在：不能变成真元素，也不能出现在 text 位置的 innerHTML 里
        assert.equal(h.document.querySelectorAll('img').length, 0, '响应里的标签不能变成真元素');
        assert.ok(h.id('ds_balance_status').textContent.includes('<img src=x'), '应原样当文字显示');
        assert.ok(!h.id('ds_balance_status').innerHTML.includes('<img'), '文本位置的 innerHTML 必须是转义过的');
        const status = h.id('ds_balance_status').textContent;
        assert.ok(status.includes('HTTP_500'));
        assert.ok(!status.includes('\u202E'), '双向覆盖字符要被清掉');
    } finally {
        h.shutdown();
    }
});
