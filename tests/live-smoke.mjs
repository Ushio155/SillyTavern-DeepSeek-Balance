/**
 * 实网烟囱测试（不属于单测，需要真密钥，故不参与 CI）
 * =====================================================================
 * 用 lib.js 里那套请求构造 + 规范化逻辑，真的打一次 DeepSeek 接口，验证：
 *   1) 正常密钥 → ok=true，金额被正确解析成数字
 *   2) 伪造密钥 → 401 被判成 BAD_KEY（错误分支可用）
 *   3) 请求参数确实带上了 credentials:omit / redirect:error 等加固项
 * 打印时只显示密钥长度与前缀，绝不回显密钥本身。
 *
 * 用法（PowerShell，密钥从凭据文件读入环境变量，不落盘、不打印）：
 *   $env:DEEPSEEK_API_KEY = '<你的密钥>'
 *   node tests/live-smoke.mjs
 */
import assert from 'node:assert/strict';

import {
    buildBalanceRequest,
    normalizeBalance,
    classifyHttpError,
    extractErrorMessage,
    computeBalanceView,
    formatAmount,
    currencySymbol,
    DEFAULT_SETTINGS,
} from '../lib.js';

const apiKey = process.env.DEEPSEEK_API_KEY;

if (!apiKey) {
    console.error('缺少环境变量 DEEPSEEK_API_KEY，跳过实网测试');
    process.exit(2);
}

console.log(`使用密钥：${apiKey.slice(0, 3)}…（长度 ${apiKey.length}，不回显）`);

// --- 1) 正常密钥 -----------------------------------------------------------
const request = buildBalanceRequest(apiKey);
assert.ok(request, '密钥形态校验应当通过');
assert.equal(request.init.credentials, 'omit');
assert.equal(request.init.redirect, 'error');

const started = Date.now();
const response = await fetch(request.url, {
    ...request.init,
    signal: AbortSignal.timeout(15000),
});
console.log(`HTTP ${response.status}（${Date.now() - started} ms）`);

if (!response.ok) {
    const body = await response.text();
    console.error('请求失败：', classifyHttpError(response.status), extractErrorMessage(JSON.parse(body || '{}')));
    process.exit(1);
}

const payload = await response.json();
const result = normalizeBalance(payload, 'settings');
assert.equal(result.ok, true, '应解析成功');
assert.ok(result.balances.length >= 1, '至少应有一个币种');

for (const b of result.balances) {
    assert.equal(typeof b.total, 'number', '金额必须是数字');
    assert.ok(Number.isFinite(b.total));
    console.log(`  ${b.currency}: 总额 ${currencySymbol(b.currency)}${formatAmount(b.total)}` +
        `（赠送 ${formatAmount(b.granted)}，充值 ${formatAmount(b.toppedUp)}）`);
}

const view = computeBalanceView({ result, settings: DEFAULT_SETTINGS });
console.log(`  视图状态：${view.state} → ${view.text}`);
assert.ok(['ok', 'low'].includes(view.state), '真实响应应落到 ok/low');
assert.equal(result.isAvailable, true);
console.log('  ✓ 响应结构、金额解析、视图计算全部符合预期');

// --- 2) 伪造密钥（错误分支） ----------------------------------------------
const badRequest = buildBalanceRequest('sk-definitely-not-a-real-key-000000');
const badResponse = await fetch(badRequest.url, { ...badRequest.init, signal: AbortSignal.timeout(15000) });
const badError = classifyHttpError(badResponse.status);
console.log(`错误分支：HTTP ${badResponse.status} → ${badError}`);
assert.ok([401, 403].includes(badResponse.status), '伪造密钥应被拒绝');
assert.equal(badError, 'BAD_KEY');

// --- 3) 越权防护：不合法密钥根本不会发出请求 ------------------------------
assert.equal(buildBalanceRequest('sk-with space and \r\nX-Evil: 1'), null);
console.log('  ✓ 含换行/空白的密钥被本地挡下，不会构造出请求');

console.log('\n实网烟囱测试通过。');
