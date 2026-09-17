/**
 * 静态安全审计（node --test）
 * =====================================================================
 * 这些测试不跑浏览器，而是把"安全约束"写成对源码本身的断言，防止以后改代码时
 * 悄悄引入注入点、把密钥写进日志、或让密钥流向别的域名。
 *
 * 规则一览：
 *   1) manifest.json 结构完整、指向的文件真实存在
 *   2) lib.js 保持纯净：不碰 DOM / 全局 / 网络（这样它才能被单测全覆盖）
 *   3) index.js 不出现 eval / new Function / document.write / insertAdjacentHTML
 *   4) 唯一一次 innerHTML 赋值必须是"无插值的静态模板"
 *   5) 每个 fetch 的目标必须是白名单常量（余额端点 / 酒馆同源接口）
 *   6) Authorization 在源码中只出现一次，且位于 lib.js 的请求构造里
 *   7) 不使用 console.log，且任何 console.* 都不打印密钥相关变量
 *   8) index.js 从 lib.js 导入的名字必须都真实存在
 *   9) 全仓库不出现形如真实 API 密钥的字符串
 *  10) CSS 不引用外部资源（无 @import / 远程 url()）
 *  11) CSS 里"输入框里那一行"必须保持一体式（无独立底色），且状态色落在行本身而不是胶囊边框上
 *  12) CSS 里窄屏适配不能被核心样式压掉：设置面板按钮必须覆盖 .menu_button 的 width:min-content，
 *      详情弹窗的 min-width 必须写成 min(260px, 100%)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 去掉注释后再做扫描：文档注释里会提到被禁用的名字（例如"不要出现 document"），
 * 那是说明而不是用法。字符串里的内容不处理——真要在字符串里藏用法，下面的规则照样抓得到。
 * @param {string} src
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        // 只把"行首 //" 和 "代码后的 //" 当注释，避开 https:// 里的双斜杠
        .replace(/(^|[^:'"\w])\/\/[^\n]*/g, '$1 ');
}

const INDEX_RAW = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const LIB_RAW = fs.readFileSync(path.join(ROOT, 'lib.js'), 'utf8');
const INDEX = stripComments(INDEX_RAW);
const LIB = stripComments(LIB_RAW);
const CSS = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const MANIFEST_RAW = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');

/** 递归列出仓库内所有文本文件（跳过 .git / node_modules / 本地 npm 缓存） */
function listFiles(dir = ROOT, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['.git', 'node_modules', '.npm-cache'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) listFiles(full, out);
        else out.push(full);
    }
    return out;
}

// ---------------------------------------------------------------------------
// 1) manifest
// ---------------------------------------------------------------------------

test('manifest.json：结构完整且指向真实文件', () => {
    const manifest = JSON.parse(MANIFEST_RAW);
    assert.equal(manifest.js, 'index.js');
    assert.equal(manifest.css, 'style.css');
    assert.equal(manifest.name, path.basename(ROOT), 'name 必须与扩展目录名一致');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    for (const file of [manifest.js, manifest.css, 'lib.js', 'README.md']) {
        assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} 不存在`);
    }
    assert.ok(manifest.hooks?.enable && manifest.hooks?.disable, 'hooks 需要 enable/disable');
    assert.equal(manifest.requires?.length ?? 0, 0);
});

// ---------------------------------------------------------------------------
// 2) lib.js 纯净性
// ---------------------------------------------------------------------------

test('lib.js 不依赖 DOM / 全局 / 网络（保证可被单测完全覆盖）', () => {
    const banned = [
        [/\bdocument\b/, 'document'],
        [/\bwindow\b/, 'window'],
        [/\blocalStorage\b/, 'localStorage'],
        [/\bfetch\s*\(/, 'fetch'],
        [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
        [/\bSillyTavern\b/, 'SillyTavern'],
        [/\bjQuery\b|\$\s*\(/, 'jQuery'],
        [/\beval\s*\(/, 'eval'],
        [/\bnew Function\b/, 'new Function'],
        [/\bimport\s*\(/, 'dynamic import'],
    ];
    for (const [pattern, name] of banned) {
        assert.ok(!pattern.test(LIB), `lib.js 不应出现 ${name}`);
    }
});

// ---------------------------------------------------------------------------
// 3) 危险 sink
// ---------------------------------------------------------------------------

test('index.js 不出现 eval / new Function / document.write / insertAdjacentHTML', () => {
    for (const [pattern, name] of [
        [/\beval\s*\(/, 'eval'],
        [/\bnew Function\b/, 'new Function'],
        [/document\.write\s*\(/, 'document.write'],
        [/insertAdjacentHTML/, 'insertAdjacentHTML'],
        [/\.outerHTML\s*=/, 'outerHTML 赋值'],
        [/setTimeout\s*\(\s*['"`]/, 'setTimeout 字符串代码'],
    ]) {
        assert.ok(!pattern.test(INDEX), `index.js 不应出现 ${name}`);
    }
});

test('index.js 的 innerHTML 赋值只能是"无插值的静态模板"', () => {
    const matches = [...INDEX.matchAll(/\.innerHTML\s*=\s*([^;\n]+)/g)];
    assert.ok(matches.length >= 1, '至少应有一处（静态面板模板）');
    for (const [, rhs] of matches) {
        const expr = rhs.trim();
        assert.ok(!expr.includes('${'), `innerHTML 右侧不能有模板插值：${expr}`);
        assert.ok(!expr.includes('+'), `innerHTML 右侧不能拼接字符串：${expr}`);
        assert.match(expr, /^[A-Za-z_$][\w$]*$|^['"][^'"]*['"]$/, `只允许裸标识符或字符串字面量：${expr}`);
    }
});

test('动态内容一律走 textContent（不出现 innerText/outerHTML 拼装）', () => {
    assert.ok(/\.textContent\s*=/.test(INDEX), '应大量使用 textContent');
    assert.ok(!/\.innerText\s*=/.test(INDEX));
});

// ---------------------------------------------------------------------------
// 4) 网络去向白名单
// ---------------------------------------------------------------------------

test('每个 fetch 的目标都必须是白名单常量', () => {
    const sites = [...INDEX.matchAll(/fetch\s*\(/g)];
    assert.equal(sites.length, 2, '预期只有两处网络调用：读密钥 + 查余额');

    const allowed = new Set(['request.url', 'BALANCE_URL', 'SECRETS_FIND_URL']);
    for (const site of sites) {
        const rest = INDEX.slice(site.index + site[0].length);
        const firstArg = rest.slice(0, rest.indexOf(',')).trim();
        assert.ok(allowed.has(firstArg), `fetch 第一参数必须是白名单常量，实际是：${firstArg}`);
    }
});

test('密钥不可能被带到别的域名：URL 常量里没有模板插值', () => {
    const urls = [...LIB.matchAll(/(?:BALANCE_URL|SECRETS_FIND_URL)\s*=\s*([^\n;]+)/g)];
    assert.equal(urls.length, 2);
    for (const [, value] of urls) {
        assert.ok(!value.includes('${'), 'URL 必须是纯字面量');
    }
    assert.ok(LIB.includes("'https://api.deepseek.com/user/balance'"));
    assert.ok(/SECRETS_FIND_URL\s*=\s*'\/api\/secrets\/find'/.test(LIB), '读密钥必须走同源相对路径');
});

test('Authorization 头在源码里只出现一次，且位于 lib.js 的请求构造中', () => {
    const inIndex = [...INDEX.matchAll(/Authorization/g)].length;
    const inLib = [...LIB.matchAll(/Authorization/g)].length;
    assert.equal(inIndex, 0, 'index.js 不应出现 Authorization');
    assert.equal(inLib, 1, 'lib.js 里应只有一处');
    const idx = LIB.indexOf('Authorization');
    const around = LIB.slice(Math.max(0, idx - 400), idx + 200);
    assert.ok(around.includes('export function buildBalanceRequest'), '这一处必须在 buildBalanceRequest 里');
});

// ---------------------------------------------------------------------------
// 5) 日志纪律
// ---------------------------------------------------------------------------

test('不打印密钥：禁用 console.log，console.* 参数不得提及密钥/令牌', () => {
    for (const [name, src] of [['index.js', INDEX], ['lib.js', LIB]]) {
        assert.ok(!/console\.log\s*\(/.test(src), `${name} 不应使用 console.log`);
        for (const m of src.matchAll(/console\.(?:warn|error|info|debug)\s*\(([^\n]*)\)/g)) {
            const args = m[1];
            assert.ok(!/key|token|secret|authoriz/i.test(args), `${name} 的日志可能泄露密钥：${args}`);
        }
    }
});

test('密钥不会被写进 localStorage / URL / DOM 属性', () => {
    assert.ok(!/localStorage/.test(INDEX), 'index.js 不使用 localStorage');
    assert.ok(!/sessionStorage/.test(INDEX));
    assert.ok(!/location\.(href|search|hash)\s*=/.test(INDEX), '不写 URL');
    // 明文密钥只允许出现在这两个变量名里：resolved.key（查询用）、e.key（键盘事件）
    const keyRefs = [...INDEX.matchAll(/\b\w*\.key\b/g)].map(m => m[0]);
    for (const ref of keyRefs) {
        assert.ok(['resolved.key', 'e.key'].includes(ref), `出现了意外的密钥引用：${ref}`);
    }
});

// ---------------------------------------------------------------------------
// 6) 导入/导出一致性
// ---------------------------------------------------------------------------

test('index.js 从 lib.js 导入的名字都存在', async () => {
    const importBlock = INDEX.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/lib\.js'/);
    assert.ok(importBlock, '应存在对 lib.js 的静态导入');
    const names = importBlock[1].split(',').map(s => s.trim()).filter(Boolean);
    assert.ok(names.length > 5);

    const libExports = new Set(Object.keys(await import('../lib.js')));
    for (const name of names) {
        assert.ok(libExports.has(name), `lib.js 未导出 ${name}`);
    }
});

// ---------------------------------------------------------------------------
// 7) 仓库里不能有真实密钥
// ---------------------------------------------------------------------------

test('全仓库不出现形如真实 API 密钥的字符串', () => {
    const suspicious = /sk-[A-Za-z0-9]{16,}/g;
    const hits = [];
    for (const file of listFiles()) {
        if (/\.(png|jpg|jpeg|ico|woff2?|zip)$/i.test(file)) continue;
        const content = fs.readFileSync(file, 'utf8');
        for (const match of content.matchAll(suspicious)) {
            hits.push(`${path.relative(ROOT, file)}: ${match[0].slice(0, 6)}…`);
        }
    }
    assert.deepEqual(hits, [], '疑似真实密钥：' + hits.join(', '));
});

test('仓库里不出现酒馆的用户数据文件', () => {
    const forbidden = ['settings.json', 'secrets.json', '.credentials.yaml', 'config.yaml'];
    for (const file of listFiles()) {
        assert.ok(!forbidden.includes(path.basename(file)), `不应提交 ${file}`);
    }
});

// ---------------------------------------------------------------------------
// 8) CSS
// ---------------------------------------------------------------------------

test('style.css 不引用任何外部资源', () => {
    assert.ok(!/@import/.test(CSS), '不使用 @import');
    assert.ok(!/url\(\s*['"]?https?:/i.test(CSS), '不引用远程资源');
    assert.ok(!/expression\s*\(/i.test(CSS));
    assert.ok(!/javascript:/i.test(CSS));
});

test('style.css：输入框里那一行必须保持"一体"，状态色不能只挂在胶囊边框上', () => {
    // 框内那一行不能自带底色 —— 要透出输入框自己的 BlurTint，否则又变成"浮在框里的小条"
    const inline = CSS.match(/\.ds-balance-bar--inline\s*\{[^}]*\}/);
    assert.ok(inline, '应有 .ds-balance-bar--inline 规则');
    assert.ok(!/background(-color)?\s*:/.test(inline[0]), '框内那一行不能自带底色');

    // 去胶囊化必须用 :where() 压住优先级：压得过基础样式，又压不过后面的低余额/失败颜色
    assert.match(
        CSS,
        /:where\(\.ds-balance-bar--inline\)\s+\.ds-balance-chip/,
        '框内胶囊应用 :where() 去掉边框和底色（写死高优先级会把状态色一起压掉）',
    );

    // 状态色必须落在"行"本身上：框内已经没有胶囊边框可以变红了
    assert.match(CSS, /\.ds-balance-bar\.is-low[\s\S]{0,400}--progErrorColor/, '低余额要能把整行染红');
    assert.match(CSS, /\.ds-balance-bar\.is-error[\s\S]{0,400}--progErrorColor/, '失败态同理');

    // 注：与输入行之间那条内嵌细线（.ds-balance-bar--inline::after）是可选的观感开关，
    // 加不加都不影响上面这些约束，所以这里不断言它。

    // 兜底挂载样式必须保留（#send_form 缺失时的退化外观）
    assert.match(CSS, /\.ds-balance-bar--above/);
});

test('style.css：窄屏适配——按钮不能被压成竖条、弹窗不能有硬性最小宽度', () => {
    // 酒馆核心 .menu_button{width:min-content}（public/style.css:3825）对中文标签而言就是"一个字宽"：
    // 按钮被压成约 27px 宽、文字逐字换行，四个字就是 27x92 的细长竖条（手机上尤其明显）。
    // 实测：不写 fit-content 时 保存密钥 = 27x92（4.63 行文本），写上之后 = 72x29（1 行）。
    const buttons = CSS.match(/\.ds-balance-panel-body\s+\.menu_button\s*\{[^}]*\}/);
    assert.ok(buttons, '应有 .ds-balance-panel-body .menu_button 规则');
    assert.match(buttons[0], /width:\s*fit-content/, '按钮宽度必须显式写 fit-content');
    assert.match(buttons[0], /white-space:\s*nowrap/, '中文标签不能被逐字拆行');

    // 标题栏刷新按钮同理：别指望 .menu_button_icon 的 fit-content 恰好排在核心 .menu_button 之后
    const header = CSS.match(/\.ds-balance-header-refresh\s*\{[^}]*\}/);
    assert.ok(header, '应有 .ds-balance-header-refresh 规则');
    assert.match(header[0], /width:\s*fit-content/, '标题栏刷新按钮同样不能被压成竖条');

    // 详情弹窗：min-width 必须是 min(..., 100%)。
    // 写死 260px 时，320px 视口下 .popup-content 只有 258px 宽（酒馆的 .popup 是 width:min(500px,100dvw-2em)
    // 再扣 14px*2 + 8px*2 内边距），而它是 overflow:hidden —— 实测 scrollWidth 276 > clientWidth 258，
    // 右侧对齐的数值被裁掉。
    const popup = CSS.match(/\.ds-balance-popup\s*\{[^}]*\}/);
    assert.ok(popup, '应有 .ds-balance-popup 规则');
    assert.match(popup[0], /min-width:\s*min\([^)]*100%\)/, '弹窗最小宽度必须跟随容器，不能是硬下限');
});
