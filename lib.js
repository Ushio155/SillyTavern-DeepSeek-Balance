/**
 * DeepSeek 余额 · 纯逻辑层（无 DOM、无网络、无全局依赖）
 * =====================================================================
 * 这里只放"可被单元测试直接 import"的纯函数：常量、密钥混淆、设置净化、
 * 请求构造、响应规范化、界面视图计算、文本清洗。
 *
 * 设计约束（由 tests/static-audit.test.mjs 强制校验）：
 *   - 不出现 document / window / jQuery / SillyTavern / localStorage
 *   - 不出现 fetch（网络调用一律留在 index.js）
 *   - 不出现 eval / new Function
 * 这样 index.js 只剩"接线"，安全敏感的解析与校验都集中在可测试的位置。
 *
 * 密钥处理原则：
 *   - 明文密钥只在内存中出现，唯一去向是 Authorization 头（且 URL 是常量）
 *   - 落盘前做异或混淆（obfuscation，不是加密；能读 settings.json 的人也能还原）
 *   - 混淆失败时"失败关闭"（宁可存不进去，也不退回明文）
 */

export const MODULE = 'deepseek-balance';

/** 唯一的余额端点：常量，绝不从设置拼接，避免密钥被带到别的域名 */
export const BALANCE_URL = 'https://api.deepseek.com/user/balance';

/** 酒馆密钥库里的 DeepSeek 条目名（src/endpoints/secrets.js） */
export const TAVERN_SECRET_KEY = 'api_key_deepseek';
export const SECRETS_FIND_URL = '/api/secrets/find';

export const REQUEST_TIMEOUT_MS = 15000;
export const MIN_INTERVAL_SEC = 10;
export const MAX_INTERVAL_SEC = 86400;
export const GEN_DEBOUNCE_MS = 2500;
export const STALE_MS = 30000;
export const MAX_BACKOFF_MS = 10 * 60 * 1000;

/** 混淆用的固定掩码。公开可知，只用于防止"肉眼直读"，不提供机密性。 */
export const OBFUSCATION_KEY = 'ds-balance-v1';
export const KEY_PREFIX = 'v1:';

/** 单次展示/记录的错误文本上限，避免上游回包把界面撑爆 */
export const MAX_ERROR_MESSAGE = 300;
/** 最多渲染多少个币种，避免异常回包生成上千行 */
export const MAX_BALANCE_ENTRIES = 10;
/** 密钥的合法形态：可打印 ASCII、无空白、长度合理 */
export const KEY_MIN_LENGTH = 8;
export const KEY_MAX_LENGTH = 200;

export const DEFAULT_SETTINGS = Object.freeze({
    apiKeyEnc: '',
    autoRefresh: true,
    intervalSec: 60,
    lowThreshold: 10,
    refreshOnGeneration: true,
    showRefreshButton: true,
});

/** 这些错误属于"还没配好密钥"，界面按待配置呈现而不是失败 */
export const CONFIG_ERRORS = Object.freeze(['NO_KEY', 'KEY_MISSING', 'KEY_FORBIDDEN', 'SECRET_FAILED']);

export const ERROR_TEXT = Object.freeze({
    NO_KEY: '未配置 API 密钥',
    KEY_MISSING: '酒馆密钥库里没有 DeepSeek 密钥',
    KEY_FORBIDDEN: '酒馆未开启 allowKeysExposure，无法自动读取密钥',
    SECRET_FAILED: '读取酒馆密钥失败',
    BAD_KEY: 'API 密钥无效（401）',
    BAD_KEY_FORMAT: '密钥格式不合法（应为无空白的 ASCII 字符）',
    RATE_LIMIT: '请求过于频繁（429）',
    BAD_RESPONSE: '接口返回结构异常',
    TIMEOUT: '请求超时',
    NETWORK: '网络请求失败（可能被跨域或代理拦截）',
});

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/**
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(n, min, max) {
    const value = Number(n);
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

/**
 * 把任意值转成有限数字，非数字一律 0（DeepSeek 的金额是字符串）
 * @param {unknown} value
 * @returns {number}
 */
export function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * 清洗来自上游/用户的文本：去掉控制字符、双向覆盖字符、零宽字符，压缩空白并截断。
 * 这些字符会让界面出现"看起来正常其实被改写"的内容（RTL 欺骗、隐藏指令）。
 * @param {unknown} value
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeMessage(value, maxLen = MAX_ERROR_MESSAGE) {
    const raw = typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value));
    // eslint-disable-next-line no-control-regex
    const cleaned = raw
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const limit = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : MAX_ERROR_MESSAGE;
    return cleaned.length > limit ? cleaned.slice(0, limit) + '…' : cleaned;
}

/**
 * 密钥是否为可安全放进 HTTP 头的形态。
 * 拒绝空白与非 ASCII，等于顺带挡掉 CR/LF 头注入。
 * @param {unknown} key
 * @returns {boolean}
 */
export function isPlausibleKey(key) {
    return typeof key === 'string'
        && key.length >= KEY_MIN_LENGTH
        && key.length <= KEY_MAX_LENGTH
        && /^[\x21-\x7E]+$/.test(key);
}

// ---------------------------------------------------------------------------
// 密钥混淆（obfuscation，非加密）
// ---------------------------------------------------------------------------

/**
 * 异或 + base64。失败时抛错，由调用方决定"不保存"，绝不退回明文。
 * @param {unknown} raw
 * @returns {string} 形如 `v1:<base64>`；输入为空时返回 ''
 */
export function encodeKey(raw) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) return '';
    const data = new TextEncoder().encode(key);
    const mask = new TextEncoder().encode(OBFUSCATION_KEY);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
        out[i] = data[i] ^ mask[i % mask.length];
    }
    let bin = '';
    for (let i = 0; i < out.length; i++) {
        bin += String.fromCharCode(out[i]);
    }
    return KEY_PREFIX + btoa(bin);
}

/**
 * 还原密钥。任何解码异常都返回 ''（失败关闭），并且只接受"看起来合法"的结果，
 * 这样被篡改的密文不会变成垃圾字符串被塞进请求头。
 * @param {unknown} stored
 * @returns {string}
 */
export function decodeKey(stored) {
    // 只认带版本前缀的混淆值：手写进去的明文不会被当成密钥使用
    if (typeof stored !== 'string' || !stored.startsWith(KEY_PREFIX)) return '';

    try {
        const bin = atob(stored.slice(KEY_PREFIX.length));
        const mask = new TextEncoder().encode(OBFUSCATION_KEY);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            out[i] = bin.charCodeAt(i) ^ mask[i % mask.length];
        }
        const decoded = new TextDecoder().decode(out);
        return isPlausibleKey(decoded) ? decoded : '';
    } catch (e) {
        return '';
    }
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/**
 * 把外部（settings.json / 界面）来的对象净化成"只含已知字段"的新对象。
 * 不认识的键被丢弃，因此不会把 `__proto__` 之类的键写回全局设置（原型污染防护）。
 * @param {unknown} raw
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function parseSettings(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    const out = { ...DEFAULT_SETTINGS };

    // 只用白名单键逐个赋值：绕开 __proto__ / constructor 一类的键
    if (typeof source.apiKeyEnc === 'string') out.apiKeyEnc = source.apiKeyEnc.slice(0, 4096);
    if (typeof source.autoRefresh === 'boolean') out.autoRefresh = source.autoRefresh;
    if (typeof source.refreshOnGeneration === 'boolean') out.refreshOnGeneration = source.refreshOnGeneration;
    if (typeof source.showRefreshButton === 'boolean') out.showRefreshButton = source.showRefreshButton;

    const interval = Number(source.intervalSec);
    out.intervalSec = Number.isFinite(interval)
        ? Math.round(clamp(interval, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC))
        : DEFAULT_SETTINGS.intervalSec;

    const threshold = Number(source.lowThreshold);
    // 显式的 0（或负数）表示"关闭告警"；只有缺失/非数字才退回默认阈值
    out.lowThreshold = Number.isFinite(threshold) ? Math.max(0, threshold) : DEFAULT_SETTINGS.lowThreshold;

    return out;
}

// ---------------------------------------------------------------------------
// 请求构造（纯函数，便于断言"密钥只会去一个地方"）
// ---------------------------------------------------------------------------

/**
 * @param {string} key 明文密钥
 * @param {AbortSignal} [signal]
 * @returns {{url: string, init: RequestInit}|null} 密钥不合法时返回 null
 */
export function buildBalanceRequest(key, signal) {
    if (!isPlausibleKey(key)) return null;
    return {
        url: BALANCE_URL,
        init: {
            method: 'GET',
            // 密钥只出现在这里，且 URL 是常量 → 不可能带到别的域名
            headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
            signal,
            cache: 'no-store',
            credentials: 'omit',        // 不把酒馆的 Cookie 发给第三方
            referrerPolicy: 'no-referrer',
            mode: 'cors',
            redirect: 'error',          // 302 到别处会直接失败，而不是带着密钥跳过去
        },
    };
}

/**
 * 读酒馆密钥库用的同源请求（不携带明文密钥，只带酒馆自己的 CSRF 头）
 * @param {Record<string, string>} headers
 * @param {string} [keyName]
 * @returns {{url: string, init: RequestInit}}
 */
export function buildSecretsRequest(headers, keyName = TAVERN_SECRET_KEY) {
    return {
        url: SECRETS_FIND_URL,
        init: {
            method: 'POST',
            headers: { ...(headers || {}), 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: String(keyName) }),
            credentials: 'same-origin',
        },
    };
}

/**
 * @param {number} status
 * @returns {string} 错误码
 */
export function classifySecretStatus(status) {
    if (status === 403) return 'KEY_FORBIDDEN';
    if (status === 404) return 'KEY_MISSING';
    return 'SECRET_FAILED';
}

/**
 * @param {number} status
 * @returns {string} 错误码
 */
export function classifyHttpError(status) {
    if (status === 401) return 'BAD_KEY';
    if (status === 403) return 'BAD_KEY';
    if (status === 429) return 'RATE_LIMIT';
    return 'HTTP_' + toNumber(status);
}

/**
 * 从错误响应体里取一句可展示的话（已清洗）
 * @param {unknown} payload
 * @returns {string}
 */
export function extractErrorMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const candidate = payload.error?.message ?? payload.message ?? payload.error;
    return sanitizeMessage(typeof candidate === 'object' ? JSON.stringify(candidate) : candidate);
}

/**
 * 把 DeepSeek 的 /user/balance 响应规范化成内部结构
 * @param {unknown} payload
 * @param {'settings'|'tavern'} [source]
 * @param {string} [at]
 * @returns {{ok: boolean, error?: string, message?: string, at?: string, isAvailable?: boolean,
 *   source?: string, balances?: Array<{currency: string, total: number, granted: number, toppedUp: number}>}}
 */
export function normalizeBalance(payload, source = 'settings', at = new Date().toISOString()) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.balance_infos)) {
        return { ok: false, error: 'BAD_RESPONSE', message: ERROR_TEXT.BAD_RESPONSE };
    }

    const balances = payload.balance_infos.slice(0, MAX_BALANCE_ENTRIES).map((entry) => {
        const rawCurrency = typeof entry?.currency === 'string' ? entry.currency : '';
        const currency = rawCurrency.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
        return {
            currency: currency || 'CNY',
            // DeepSeek 返回字符串金额，必须显式转数字
            total: toNumber(entry?.total_balance),
            granted: toNumber(entry?.granted_balance),
            toppedUp: toNumber(entry?.topped_up_balance),
        };
    });

    return {
        ok: true,
        at: typeof at === 'string' ? at : new Date().toISOString(),
        isAvailable: Boolean(payload.is_available),
        source: source === 'tavern' ? 'tavern' : 'settings',
        balances,
    };
}

// ---------------------------------------------------------------------------
// 展示格式化
// ---------------------------------------------------------------------------

/**
 * @param {string} currency
 * @returns {string}
 */
export function currencySymbol(currency) {
    if (currency === 'CNY') return '¥';
    if (currency === 'USD') return '$';
    return currency + ' ';
}

/**
 * @param {number} n
 * @returns {string}
 */
export function formatAmount(n) {
    const value = toNumber(n);
    try {
        return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch (e) {
        return value.toFixed(2);
    }
}

/**
 * @param {string} iso
 * @returns {string}
 */
export function formatTime(iso) {
    if (typeof iso !== 'string' || !iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    try {
        return date.toLocaleTimeString();
    } catch (e) {
        return '—';
    }
}

/**
 * @param {{balances?: Array<{currency: string, total: number, granted: number, toppedUp: number}>}} result
 */
export function headline(result) {
    return result?.balances?.[0] ?? null;
}

/**
 * 算出"该显示什么"——输入框上方的余额条与扩展设置面板共用同一份视图，
 * 这样两处永远不会不一致，也让这段逻辑可以脱离浏览器直接测。
 *
 * @param {{result?: object|null, settings?: object, loading?: boolean, delta?: number|null}} input
 * @returns {{state: 'loading'|'idle'|'unconfigured'|'error'|'low'|'ok', text: string, title: string,
 *   currency?: string, total?: number|null, unconfigured?: boolean}}
 */
export function computeBalanceView(input = {}) {
    const settings = parseSettings(input.settings);
    const result = input.result || null;
    const delta = Number.isFinite(input.delta) ? input.delta : null;

    if (input.loading && !result) {
        return { state: 'loading', text: '查询中…', title: '正在查询 DeepSeek 余额…' };
    }

    if (!result) {
        return { state: 'idle', text: '—', title: '尚未查询 DeepSeek 余额，点击刷新' };
    }

    if (!result.ok) {
        const unconfigured = CONFIG_ERRORS.includes(result.error);
        const message = sanitizeMessage(result.message);
        if (unconfigured) {
            return {
                state: 'unconfigured',
                text: '未配置密钥',
                title: `DeepSeek 余额：${message || ERROR_TEXT.NO_KEY}。点开查看解决办法。`,
                unconfigured: true,
            };
        }
        return {
            state: 'error',
            text: '查询失败',
            title: `DeepSeek 余额查询失败 [${sanitizeMessage(result.error, 40)}]：${message}`,
        };
    }

    const head = headline(result);
    if (!head) {
        return { state: 'error', text: '无数据', title: 'DeepSeek 余额：接口未返回 balance_infos' };
    }

    const below = settings.lowThreshold > 0 && head.total < settings.lowThreshold;
    const unavailable = result.isAvailable === false;
    const text = currencySymbol(head.currency) + formatAmount(head.total);

    const parts = [
        `DeepSeek 余额：账户${result.isAvailable ? '可用' : '不可用'}`,
        `总额 ${currencySymbol(head.currency)}${formatAmount(head.total)}` +
        `（赠送 ${formatAmount(head.granted)}，充值 ${formatAmount(head.toppedUp)}）`,
    ];
    if (delta !== null && delta !== 0) {
        parts.push(`较上次查询 ${delta > 0 ? '+' : '−'}${currencySymbol(head.currency)}${formatAmount(Math.abs(delta))}`);
    }
    parts.push(`查询于 ${formatTime(result.at)}`);
    parts.push(`密钥来源：${result.source === 'tavern' ? '酒馆密钥库' : '扩展设置'}`);
    if (below) {
        parts.push(`⚠ 余额低于 ${currencySymbol(head.currency)}${formatAmount(settings.lowThreshold)}，请及时充值`);
    }
    if (input.loading) parts.push('（正在刷新…）');

    return {
        state: below || unavailable ? 'low' : 'ok',
        text,
        title: parts.join('｜'),
        currency: head.currency,
        total: head.total,
    };
}
