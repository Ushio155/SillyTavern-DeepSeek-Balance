/**
 * lib.js 纯逻辑单元测试（node --test，无第三方依赖）
 * 覆盖：密钥混淆、设置净化、请求构造、响应规范化、文本清洗、视图计算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as lib from '../lib.js';

// 故意写成"明显是假密钥"的形态（'sk-' 之后不足 16 个连续字母数字），
// 这样仓库里不可能存在看起来像真实密钥的字符串，也不影响 any 条断言。
const SECRET = 'sk-test-0123456789abcdef';

// ---------------------------------------------------------------------------
// 密钥混淆
// ---------------------------------------------------------------------------

test('encodeKey/decodeKey：ASCII 密钥可往返', () => {
    const enc = lib.encodeKey(SECRET);
    assert.ok(enc.startsWith(lib.KEY_PREFIX), '应带版本前缀');
    assert.equal(lib.decodeKey(enc), SECRET);
});

test('encodeKey：空值返回空串，不产生前缀', () => {
    assert.equal(lib.encodeKey(''), '');
    assert.equal(lib.encodeKey('   '), '');
    assert.equal(lib.encodeKey(null), '');
    assert.equal(lib.encodeKey(undefined), '');
});

test('encodeKey：密文里不含明文，且前缀之后只有 base64 字符', () => {
    const enc = lib.encodeKey(SECRET);
    assert.ok(!enc.includes(SECRET), '不能出现明文');
    assert.ok(!enc.includes('sk-'), '不能出现明文片段');
    assert.match(enc.slice(lib.KEY_PREFIX.length), /^[A-Za-z0-9+/=]+$/);
});

test('decodeKey：被篡改的密文不会还原成原密钥（且不抛错）', () => {
    const enc = lib.encodeKey(SECRET);
    const body = enc.slice(lib.KEY_PREFIX.length);
    const idx = Math.floor(body.length / 2);
    const swapped = body[idx] === 'A' ? 'B' : 'A';
    const tampered = lib.KEY_PREFIX + body.slice(0, idx) + swapped + body.slice(idx + 1);
    const out = lib.decodeKey(tampered);
    assert.notEqual(out, SECRET, '篡改后不应还原出原密钥');
});

test('decodeKey：非法输入一律返回空串（失败关闭）', () => {
    for (const bad of ['', null, undefined, 123, {}, 'v1:', 'v1:!!!!', 'v1:@@@@@@', 'plain-but-too-short', 'v1:' + 'A'.repeat(5000)]) {
        assert.equal(lib.decodeKey(bad), '', `输入 ${String(bad).slice(0, 20)} 应返回空串`);
    }
});

test('decodeKey：非 ASCII 的"解出来"结果会被拒绝（不会塞进请求头）', () => {
    // 手工构造一段解出来含中文的密文
    const mask = new TextEncoder().encode(lib.OBFUSCATION_KEY);
    const plain = new TextEncoder().encode('密钥中文测试abcdefgh');
    const out = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i++) out[i] = plain[i] ^ mask[i % mask.length];
    let bin = '';
    for (const b of out) bin += String.fromCharCode(b);
    const stored = lib.KEY_PREFIX + btoa(bin);
    assert.equal(lib.decodeKey(stored), '');
});

// ---------------------------------------------------------------------------
// 密钥形态校验
// ---------------------------------------------------------------------------

test('isPlausibleKey：挡掉空白/换行/非 ASCII/超长', () => {
    assert.equal(lib.isPlausibleKey(SECRET), true);
    assert.equal(lib.isPlausibleKey('sk-abc def'), false);
    assert.equal(lib.isPlausibleKey('sk-abc\r\nX-Injected: 1'), false, '头注入必须被挡住');
    assert.equal(lib.isPlausibleKey('sk-abc\ndef'), false);
    assert.equal(lib.isPlausibleKey('密钥abcdefgh'), false);
    assert.equal(lib.isPlausibleKey('short'), false);
    assert.equal(lib.isPlausibleKey('a'.repeat(300)), false);
    assert.equal(lib.isPlausibleKey(null), false);
});

// ---------------------------------------------------------------------------
// 设置净化
// ---------------------------------------------------------------------------

test('parseSettings：默认值', () => {
    const s = lib.parseSettings(undefined);
    assert.deepEqual(s, { ...lib.DEFAULT_SETTINGS });
});

test('parseSettings：区间与数值净化', () => {
    assert.equal(lib.parseSettings({ intervalSec: 1 }).intervalSec, lib.MIN_INTERVAL_SEC);
    assert.equal(lib.parseSettings({ intervalSec: 9e9 }).intervalSec, lib.MAX_INTERVAL_SEC);
    assert.equal(lib.parseSettings({ intervalSec: 'abc' }).intervalSec, lib.DEFAULT_SETTINGS.intervalSec);
    assert.equal(lib.parseSettings({ intervalSec: 60.7 }).intervalSec, 61);
    assert.equal(lib.parseSettings({ lowThreshold: -5 }).lowThreshold, 0);
    assert.equal(lib.parseSettings({ lowThreshold: 0 }).lowThreshold, 0, '显式 0 = 关闭告警，不能被默认值顶掉');
    assert.equal(lib.parseSettings({ lowThreshold: 'x' }).lowThreshold, lib.DEFAULT_SETTINGS.lowThreshold, '非数字才退回默认');
    assert.equal(lib.parseSettings({}).lowThreshold, lib.DEFAULT_SETTINGS.lowThreshold);
    assert.equal(lib.parseSettings({ lowThreshold: 3.5 }).lowThreshold, 3.5);
});

test('parseSettings：丢弃未知键，且不会原型污染', () => {
    const s = lib.parseSettings({ evil: 1, constructor: 'x', __proto__: { polluted: true } });
    assert.equal(Object.prototype.polluted, undefined, 'Object.prototype 不能被污染');
    assert.equal(s.polluted, undefined);
    assert.equal(Object.keys(s).sort().join(','), Object.keys(lib.DEFAULT_SETTINGS).sort().join(','));

    const json = JSON.parse('{"__proto__":{"polluted2":true}}');
    const s2 = lib.parseSettings(json);
    assert.equal(Object.prototype.polluted2, undefined);
    assert.equal(Object.getPrototypeOf(s2), Object.prototype);
});

test('parseSettings：apiKeyEnc 只接受字符串且限长', () => {
    assert.equal(lib.parseSettings({ apiKeyEnc: 42 }).apiKeyEnc, '');
    assert.equal(lib.parseSettings({ apiKeyEnc: 'x'.repeat(9999) }).apiKeyEnc.length, 4096);
});

// ---------------------------------------------------------------------------
// 请求构造：密钥只会去一个地方
// ---------------------------------------------------------------------------

test('buildBalanceRequest：URL 是常量，密钥只在 Authorization 头里', () => {
    const req = lib.buildBalanceRequest(SECRET);
    assert.ok(req);
    assert.equal(req.url, lib.BALANCE_URL);
    assert.equal(req.init.headers.Authorization, 'Bearer ' + SECRET);
    assert.equal(req.init.method, 'GET');
    assert.equal(req.init.credentials, 'omit', '不能把酒馆 Cookie 发给第三方');
    assert.equal(req.init.referrerPolicy, 'no-referrer');
    assert.equal(req.init.redirect, 'error', '不允许 302 把密钥带到别处');
    assert.ok(!req.url.includes(SECRET));
    assert.ok(!JSON.stringify(req.init.body ?? '').includes(SECRET));
});

test('buildBalanceRequest：密钥不合法时返回 null（绝不发出请求）', () => {
    assert.equal(lib.buildBalanceRequest('has space here'), null);
    assert.equal(lib.buildBalanceRequest('sk-a\r\nX: 1'), null);
    assert.equal(lib.buildBalanceRequest(''), null);
    assert.equal(lib.buildBalanceRequest(undefined), null);
});

test('buildSecretsRequest：同源、不带明文密钥', () => {
    const req = lib.buildSecretsRequest({ 'X-CSRF-Token': 't' }, lib.TAVERN_SECRET_KEY);
    assert.equal(req.url, lib.SECRETS_FIND_URL);
    assert.ok(req.url.startsWith('/'), '必须是同源相对路径');
    assert.equal(req.init.method, 'POST');
    assert.equal(req.init.credentials, 'same-origin');
    assert.equal(req.init.headers['X-CSRF-Token'], 't');
    assert.deepEqual(JSON.parse(req.init.body), { key: lib.TAVERN_SECRET_KEY });
});

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

test('classifyHttpError', () => {
    assert.equal(lib.classifyHttpError(401), 'BAD_KEY');
    assert.equal(lib.classifyHttpError(403), 'BAD_KEY');
    assert.equal(lib.classifyHttpError(429), 'RATE_LIMIT');
    assert.equal(lib.classifyHttpError(500), 'HTTP_500');
    assert.equal(lib.classifyHttpError(undefined), 'HTTP_0');
});

test('classifySecretStatus', () => {
    assert.equal(lib.classifySecretStatus(403), 'KEY_FORBIDDEN');
    assert.equal(lib.classifySecretStatus(404), 'KEY_MISSING');
    assert.equal(lib.classifySecretStatus(500), 'SECRET_FAILED');
});

// ---------------------------------------------------------------------------
// 文本清洗
// ---------------------------------------------------------------------------

test('sanitizeMessage：控制字符、双向覆盖、零宽字符、超长都被处理', () => {
    assert.equal(lib.sanitizeMessage('a\nb\tc'), 'a b c');
    assert.equal(lib.sanitizeMessage('a\u0000b'), 'a b');
    assert.equal(lib.sanitizeMessage('安全\u202Egnp.exe'), '安全gnp.exe', 'RTL 覆盖字符要去掉');
    assert.equal(lib.sanitizeMessage('a\u200Bb'), 'ab');
    const long = lib.sanitizeMessage('x'.repeat(1000));
    assert.equal(long.length, lib.MAX_ERROR_MESSAGE + 1, '超长要截断并加省略号');
    assert.equal(lib.sanitizeMessage(null), '');
    assert.equal(lib.sanitizeMessage(12345), '12345');
});

test('extractErrorMessage：多种错误回包形态', () => {
    assert.equal(lib.extractErrorMessage({ error: { message: 'bad key' } }), 'bad key');
    assert.equal(lib.extractErrorMessage({ message: 'oops' }), 'oops');
    assert.equal(lib.extractErrorMessage({ error: 'plain' }), 'plain');
    assert.equal(lib.extractErrorMessage(null), '');
    assert.equal(lib.extractErrorMessage('just a string'), '');
    assert.ok(lib.extractErrorMessage({ message: 'y'.repeat(999) }).length <= lib.MAX_ERROR_MESSAGE + 1);
});

// ---------------------------------------------------------------------------
// 响应规范化
// ---------------------------------------------------------------------------

const REAL_SHAPE = {
    is_available: true,
    balance_infos: [
        { currency: 'CNY', total_balance: '12.22', granted_balance: '0.00', topped_up_balance: '12.22' },
    ],
};

test('normalizeBalance：真实响应（字符串金额）被转成数字', () => {
    const r = lib.normalizeBalance(REAL_SHAPE, 'settings', '2025-01-01T00:00:00.000Z');
    assert.equal(r.ok, true);
    assert.equal(r.isAvailable, true);
    assert.equal(r.source, 'settings');
    assert.equal(r.at, '2025-01-01T00:00:00.000Z');
    assert.deepEqual(r.balances[0], { currency: 'CNY', total: 12.22, granted: 0, toppedUp: 12.22 });
});

test('normalizeBalance：结构异常一律判为 BAD_RESPONSE', () => {
    for (const bad of [null, undefined, 'str', 42, {}, { balance_infos: null }, { balance_infos: {} }]) {
        const r = lib.normalizeBalance(bad);
        assert.equal(r.ok, false);
        assert.equal(r.error, 'BAD_RESPONSE');
    }
});

test('normalizeBalance：脏数据不会变成 NaN，币种被清洗限长，条数被限制', () => {
    const r = lib.normalizeBalance({
        is_available: 'yes',
        balance_infos: [
            { currency: '<img src=x>', total_balance: 'abc', granted_balance: null, topped_up_balance: -3.5 },
            ...Array.from({ length: 40 }, () => ({ currency: 'USD', total_balance: '1' })),
        ],
    });
    assert.equal(r.balances[0].total, 0);
    assert.equal(r.balances[0].granted, 0);
    assert.equal(r.balances[0].toppedUp, -3.5);
    assert.equal(r.balances[0].currency, 'IMGSRCX');
    assert.ok(lib.normalizeBalance({ balance_infos: Array.from({ length: 99 }, () => ({})) }).balances.length <= lib.MAX_BALANCE_ENTRIES);
    assert.equal(r.isAvailable, true);
});

test('normalizeBalance：空数组是合法响应（ok=true，视图层再判"无数据"）', () => {
    const r = lib.normalizeBalance({ is_available: false, balance_infos: [] });
    assert.equal(r.ok, true);
    assert.equal(r.isAvailable, false);
    assert.equal(lib.headline(r), null);
});

test('normalizeBalance：source 只接受已知值', () => {
    assert.equal(lib.normalizeBalance(REAL_SHAPE, 'tavern').source, 'tavern');
    assert.equal(lib.normalizeBalance(REAL_SHAPE, 'evil').source, 'settings');
    assert.equal(lib.normalizeBalance(REAL_SHAPE, undefined).source, 'settings');
});

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

test('currencySymbol / formatAmount', () => {
    assert.equal(lib.currencySymbol('CNY'), '¥');
    assert.equal(lib.currencySymbol('USD'), '$');
    assert.equal(lib.currencySymbol('EUR'), 'EUR ');
    assert.equal(lib.formatAmount(12.2), (12.2).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    assert.equal(lib.formatAmount(NaN), (0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    assert.equal(lib.formatAmount('7'), (7).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
});

test('formatTime：非法输入返回占位符而不是 Invalid Date', () => {
    assert.equal(lib.formatTime('not-a-date'), '—');
    assert.equal(lib.formatTime(undefined), '—');
    assert.equal(lib.formatTime(''), '—');
    assert.notEqual(lib.formatTime(new Date().toISOString()), '—');
});

// ---------------------------------------------------------------------------
// 视图计算
// ---------------------------------------------------------------------------

/** @param {Partial<lib.DEFAULT_SETTINGS>} over */
const withSettings = (over = {}) => ({ ...lib.DEFAULT_SETTINGS, ...over });

test('computeBalanceView：未查询 / 查询中', () => {
    assert.equal(lib.computeBalanceView({}).state, 'idle');
    assert.equal(lib.computeBalanceView({ loading: true }).state, 'loading');
    assert.equal(lib.computeBalanceView({ loading: true, result: lib.normalizeBalance(REAL_SHAPE) }).state, 'ok');
});

test('computeBalanceView：待配置 vs 失败要区分开', () => {
    for (const error of lib.CONFIG_ERRORS) {
        const v = lib.computeBalanceView({ result: { ok: false, error, message: 'm' }, settings: withSettings() });
        assert.equal(v.state, 'unconfigured', `${error} 应显示为待配置`);
        assert.equal(v.unconfigured, true);
    }
    const bad = lib.computeBalanceView({ result: { ok: false, error: 'BAD_KEY', message: '密钥无效' }, settings: withSettings() });
    assert.equal(bad.state, 'error');
    assert.equal(bad.text, '查询失败');
    assert.ok(bad.title.includes('BAD_KEY'));
});

test('computeBalanceView：正常余额、低余额、账户不可用', () => {
    const result = lib.normalizeBalance(REAL_SHAPE, 'settings', new Date().toISOString());
    const ok = lib.computeBalanceView({ result, settings: withSettings({ lowThreshold: 1 }) });
    assert.equal(ok.state, 'ok');
    assert.equal(ok.text, '¥' + lib.formatAmount(12.22));
    assert.ok(ok.title.includes('账户可用'));

    const low = lib.computeBalanceView({ result, settings: withSettings({ lowThreshold: 50 }) });
    assert.equal(low.state, 'low');
    assert.ok(low.title.includes('⚠'));

    const off = lib.computeBalanceView({ result, settings: withSettings({ lowThreshold: 0 }) });
    assert.equal(off.state, 'ok', '阈值为 0 时不再告警');

    const unavailable = lib.computeBalanceView({
        result: lib.normalizeBalance({ is_available: false, balance_infos: REAL_SHAPE.balance_infos }),
        settings: withSettings({ lowThreshold: 1 }),
    });
    assert.equal(unavailable.state, 'low');
    assert.ok(unavailable.title.includes('账户不可用'));
});

test('computeBalanceView：变化量显示正负号', () => {
    const result = lib.normalizeBalance(REAL_SHAPE, 'settings', new Date().toISOString());
    assert.ok(lib.computeBalanceView({ result, settings: withSettings(), delta: -0.03 }).title.includes('−¥0.03'));
    assert.ok(lib.computeBalanceView({ result, settings: withSettings(), delta: 5 }).title.includes('+¥5.00'));
    assert.ok(!lib.computeBalanceView({ result, settings: withSettings(), delta: 0 }).title.includes('较上次查询'));
});

test('computeBalanceView：异常回包只能产出纯文本（注入面交给 textContent）', () => {
    const v = lib.computeBalanceView({
        result: { ok: false, error: 'HTTP_500', message: '<img src=x onerror=alert(1)>' },
        settings: withSettings(),
    });
    assert.equal(typeof v.text, 'string');
    assert.equal(typeof v.title, 'string');
    // 视图只吐字符串；渲染侧全程 textContent，所以标签会原样当文字显示
    assert.ok(v.title.includes('<img src=x onerror=alert(1)>'));
});

test('computeBalanceView：无 balances 时给出"无数据"', () => {
    const v = lib.computeBalanceView({ result: lib.normalizeBalance({ balance_infos: [] }), settings: withSettings() });
    assert.equal(v.state, 'error');
    assert.equal(v.text, '无数据');
});
