/**
 * CSS 作用域自查（L1-MR-3 双前缀铁律 / L0-10）
 *
 * ── 为什么必须有用例，而不是只写在规则里 ──
 * 这条铁律**有真实事故**：本仓群在 2026-09 发生过一次「裸选择器污染整个酒馆 UI」并被修复
 * （见 `ST-zip-converter/AGENTS.md`）。酒馆是单页应用，注入的 CSS 与宿主共享同一文档——
 * 一条 `.menu_button { ... }` 就能改掉全站按钮。靠人眼复查靠不住（新加一条样式时最容易忘），
 * 所以这里把它变成**机器可判**的门禁。
 *
 * ── 判据（口径以「会不会真的泄漏」为准，不是越严越好）──
 * 1. **主语必须是我们**：每条规则里每个逗号分隔的选择器，其**第一个复合选择器**必须含 `chatfilesys`。
 *    （这与本仓既有的自查 grep `'^\.' style.css | grep -vc chatfilesys` = 0 同义，并额外覆盖
 *    以元素/伪类开头的写法。）
 * 2. **后代随便**：`.chatfilesys-popup .menu_button:disabled` 是**安全**的——宿主类只在我们的
 *    作用域内生效。把这条判成违规会逼着人写出更脆的选择器（比如加 `!important` 去压宿主样式），
 *    所以这里**明确放行**并有用例钉住它不被误判。
 * 3. 主语位置禁止 `*` / `html` / `body` / `:root`。
 * 4. 主语位置禁止**裸宿主类名**（`.menu_button {}` 这类，一字不改地改掉全站按钮）。
 * 5. 颜色走 `var(--SmartTheme*` 或中性叠加色；数据可视化配色有显式白名单。
 *
 * ── 另一条更准的判据：**声明落点** ──
 * 选择器的**最后一个**复合选择器才是拿到声明的元素（`.mes:hover > .chatfilesys-mes-tools`
 * 里的声明落在我们的工具条上，主语是 `.mes` 也无妨）。故另有一条用例判「声明落点必须含
 * `chatfilesys`」，它比「主语」更贴近「会不会改到宿主」。
 *
 * ── 唯一白名单（有界，且写在下面这条用例里）──
 * `.mes:has(> .chatfilesys-mes-tools) { position: relative }`：给宿主的 `.mes` 加定位上下文，
 * 好让我们的工具条 `position: absolute` 有参照。它**只会命中「里面装了我们的节点」的消息**
 * （`:has(> ...)` 限定），且只改 `position` 一个属性 ⇒ 无界泄漏不可能发生。
 * 换成别处写法会更脆（用 `!important` 去压宿主，或把工具条挪出消息），故保留并登记在此。
 * **任何新增的宿主主语规则都必须显式登记**，否则用例变红——这是本文件防事故的方式。
 */

/** 允许「声明落在宿主元素上」的**有界**写法（键 = 归一化后的选择器） */
const HOST_TARGET_ALLOW = new Map([
    ['.mes:has(> .chatfilesys-mes-tools)',
        '给含本插件工具条的消息加定位上下文（:has 限定 + 仅改 position，有界）'],
]);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CSS_PATH = new URL(
    '../../public/scripts/extensions/third-party/chatfilesys/style.css', import.meta.url);
const RAW = fs.readFileSync(CSS_PATH, 'utf8');

/** 宿主全站类名（出现这些**裸选择器**就会污染整个酒馆） */
const HOST_CLASSES = [
    'menu_button', 'menu_button_icon', 'text_pole', 'checkbox_label', 'inline-drawer',
    'popup', 'popup-button-ok', 'popup-button-cancel', 'popup-button-close', 'mes',
    'mes_text', 'mes_block', 'chat', 'send_textarea', 'rightSendForm', 'leftSendForm',
];
/** 选择器主语位置上绝对禁止出现的东西 */
const FORBIDDEN_SUBJECTS = ['*', 'html', 'body', ':root'];

/** 去掉注释（`/* *​/`），避免把注释里的例子当成真选择器 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 抽出「顶层选择器 → 声明块」的扁平列表（不做完整 CSS 解析——够用且无依赖） */
function selectors(css) {
    const src = stripComments(css);
    const out = [];
    // 逐字符扫描，跳过 @media 之类的 at-rule 外壳但保留其内部规则
    let i = 0;
    while (i < src.length) {
        const brace = src.indexOf('{', i);
        if (brace < 0) break;
        let head = src.slice(i, brace).trim();
        // at-rule（@media/@supports）：进入其内部继续扫
        if (head.startsWith('@')) {
            const q = head.replace(/\s+/g, ' ');
            // @media/@supports 里包着嵌套规则 → 递归扫它内部
            let depth = 1;
            let j = brace + 1;
            while (j < src.length && depth > 0) {
                if (src[j] === '{') depth += 1;
                else if (src[j] === '}') depth -= 1;
                j += 1;
            }
            const inner = src.slice(brace + 1, j - 1);
            if (head.startsWith('@media') || head.startsWith('@supports')) {
                for (const s of selectors(inner)) out.push({ ...s, at: q });
            }
            i = j;
            continue;
        }
        // 普通规则：跳过声明块
        let depth = 1;
        let j = brace + 1;
        while (j < src.length && depth > 0) {
            if (src[j] === '{') depth += 1;
            else if (src[j] === '}') depth -= 1;
            j += 1;
        }
        const body = src.slice(brace + 1, j - 1);
        if (head) out.push({ selector: head.replace(/\s+/g, ' '), body, at: null });
        i = j;
    }
    return out;
}

/** 一个规则的选择器串 → 每个**逗号分隔的选择器**（顺序列表里的每一项都独立生效，都要判） */
function selectorListOf(selector) {
    return String(selector).split(',').map((s) => s.trim()).filter(Boolean);
}

/** 一个选择器 → 它的各个「复合选择器」（按空格/>,+/~ 切开），去掉伪类与伪元素的内容 */
function compoundsOf(selector) {
    return selector
        .split(/\s*[>+~]\s*|\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        // `:hover` 这类伪类不影响「谁被选中」，去掉后再判主语
        .map((s) => s.replace(/::?[a-z-]+(\([^)]*\))?/gi, ''))
        .filter(Boolean);
}

/** 主语 = 第一个复合选择器（去掉伪类后） */
const subjectOf = (one) => compoundsOf(one)[0] || '';

const RULES = selectors(RAW);

test('CSS：style.css 读得到且真被解析出了规则（防「文件空了用例还全绿」）', () => {
    assert.ok(RAW.length > 2000, `style.css 太小（${RAW.length} 字节），是不是读错了文件？`);
    assert.ok(RULES.length > 40, `只解析出 ${RULES.length} 条规则，解析器可能坏了`);
});

test('CSS 铁律 5：**声明落点**必须被我们的类限定过（或登记在案的有界例外）', () => {
    // 「限定」的两种形态：
    //  ① 落点自己就是我们的：`.chatfilesys-popup .chatfilesys-error`
    //  ② 落点之前有我们的祖先：`.chatfilesys-popup .chatfilesys-section h4` —— `h4` 只在
    //     我们的弹窗里被选中，宿主别处的 `h4` 不受影响（**这是安全的，不该判违规**）
    // 真正危险的只有一种：整条选择器里我们的类**只在 `:has()` 里**、落点却是宿主元素
    // （`.mes:has(> .chatfilesys-mes-tools) { position: relative }`）——那条走白名单。
    const bad = [];
    for (const r of RULES) {
        for (const one of selectorListOf(r.selector)) {
            if (HOST_TARGET_ALLOW.has(one)) continue;
            const parts = compoundsOf(one.replace(/:(has|is|not|where)\([^)]*\)/gi, ''));
            const target = parts[parts.length - 1] || '';
            const ancestors = parts.slice(0, -1);
            const scoped = target.includes('chatfilesys')
                || ancestors.some((a) => a.includes('chatfilesys'));
            if (!scoped) bad.push(`${one} → 声明落在「${target}」上，前面也没有我们的祖先`);
        }
    }
    assert.deepEqual(bad, [],
        `这些规则的声明落在未被我们限定的宿主元素上：\n  ${bad.slice(0, 10).join('\n  ')}`);
});

test('CSS：白名单不许变成垃圾桶（每条都要写得出手里那点理由）', () => {
    for (const [sel, why] of HOST_TARGET_ALLOW) {
        assert.ok(why && why.length >= 12, `白名单 ${sel} 没写清理由`);
        // 白名单里的选择器必须**真的**出现在样式表里（改了样式忘了改白名单 = 白名单腐化）
        const norm = RULES.flatMap((r) => selectorListOf(r.selector)).map((s) => s.replace(/\s+/g, ' '));
        assert.ok(norm.includes(sel), `白名单里的 ${sel} 在 style.css 里已经不存在了（该删掉这条白名单）`);
    }
});

test('CSS 铁律 1（作用域）：每个选择器都必须被 chatfilesys 限定过', () => {
    // 这条抓的是**真正的事故形态**：`.menu_button {}` / `body {}` / `* {}`——
    // 选择器里**完全没有**我们的类 ⇒ 规则影响全世界。
    const bad = [];
    for (const r of RULES) {
        for (const one of selectorListOf(r.selector)) {
            if (!one.includes('chatfilesys')) {
                bad.push(`${r.at ? r.at + ' | ' : ''}${one}`);
            }
        }
    }
    assert.deepEqual(bad, [], `这些选择器完全没有本扩展前缀，会污染宿主：\n  ${bad.slice(0, 12).join('\n  ')}`);
});

test('CSS 铁律 2：主语位置不出现 * / html / body / :root', () => {
    const bad = [];
    for (const r of RULES) {
        for (const one of selectorListOf(r.selector)) {
            const subj = subjectOf(one);
            for (const f of FORBIDDEN_SUBJECTS) {
                if (subj === f || subj.startsWith(`${f} `) || subj.startsWith(`${f}.`)
                    || subj.startsWith(`${f}[`) || subj.startsWith(`${f}:`)) {
                    bad.push(`${one}（主语「${subj}」命中禁用项 ${f}）`);
                }
            }
        }
    }
    assert.deepEqual(bad, []);
});

test('CSS 铁律 3：裸宿主类名作主语，且声明落点也是宿主 —— 必须被前两条抓到', () => {
    // 这条是**判据自测**（不是对 style.css 的断言）：证明 `铁律 1 + 铁律 5` 合起来能抓住
    // 「一字不改地改掉全站按钮」这种形态。没有它，「全绿」可能只是判据失灵。
    const leak = `.chatfilesys-a{color:#fff}\n.menu_button, .chatfilesys-b{color:#fff}\nbody{color:#fff}\n`;
    const rules = selectors(leak);
    const ones = rules.flatMap((r) => selectorListOf(r.selector));
    // 铁律 1：`.menu_button`（逗号列表里那一项）与 `body` 都不含 chatfilesys
    assert.ok(ones.includes('.menu_button'), '逗号列表里的裸选择器必须被当成独立项');
    assert.ok(ones.filter((s) => !s.includes('chatfilesys')).length >= 2);
    // 铁律 5：`.menu_button` 的声明落在宿主类上
    const target = (one) => {
        const parts = compoundsOf(one);
        return parts[parts.length - 1] || '';
    };
    assert.ok(!target('.menu_button').includes('chatfilesys'));
    // 而合法写法不该被误判
    assert.ok(target('.chatfilesys-a .chatfilesys-error').includes('chatfilesys'));
    assert.ok(target('.mes:hover > .chatfilesys-mes-tools').includes('chatfilesys'));
});

test('CSS：**后代**里的宿主类名与元素选择器不被误判（这是有意放行的写法）', () => {
    // 反例守卫：若把判据写成「每个复合片段都必须含 chatfilesys」，下面两类会被误判成违规——
    // 而它们恰恰是**正确**的写法（宿主类只在我们的作用域内、元素选择器本就被祖先限定）。
    const withHostDescendant = RULES.filter((r) => selectorListOf(r.selector)
        .some((one) => /\.chatfilesys-[\w-]+[^,]*\s+\.(menu_button|text_pole|checkbox_label|popup-button-close)/.test(one)));
    assert.ok(withHostDescendant.length > 0,
        '应当存在「本扩展前缀 + 后代宿主类」的合法写法（一条都没有？那用例没验到真东西）');

    const withElementDescendant = RULES.filter((r) => selectorListOf(r.selector)
        .some((one) => /\.chatfilesys-[\w-]+\s+(h\d|label|rect|path|text|circle|pre|svg|input|textarea|details|summary)\b/.test(one)));
    assert.ok(withElementDescendant.length > 0, '应当存在「本扩展前缀 + 后代元素」的合法写法');

    // 并且这些合法写法的**主语**确实都是我们的
    for (const r of [...withHostDescendant, ...withElementDescendant]) {
        for (const one of selectorListOf(r.selector)) {
            assert.ok(subjectOf(one).includes('chatfilesys'), `主语没前缀：${one}`);
        }
    }
});

test('CSS：能抓到「逗号列表里混进一个裸选择器」这种真泄漏', () => {
    // 用一段**故意写坏**的 CSS 自测解析器与判据（不然「全绿」可能只是判据失灵）
    const badCss = `
        .chatfilesys-a { color: #fff }
        .chatfilesys-b, .menu_button { color: #fff }
        .chatfilesys-c .mes_text { color: #fff }
        body { color: #fff }
    `;
    const rules = selectors(badCss);
    const subjects = rules.flatMap((r) => selectorListOf(r.selector).map(subjectOf));
    assert.ok(subjects.includes('.menu_button'), '逗号列表里的裸选择器必须被当成独立主语抓出来');
    assert.ok(subjects.includes('body'), 'body 必须被抓出来');
    assert.ok(!subjects.includes('.chatfilesys-c .mes_text'), '后代宿主类不该被判成主语');
    assert.ok(subjects.filter((s) => s === '.chatfilesys-c').length > 0);
});

test('CSS 铁律 4：颜色走宿主主题变量或中性色，不硬编码主色', () => {
    // 允许：var(--SmartTheme*)、rgba(0,0,0,.x)/rgba(255,255,255,.x) 这类中性叠加、
    // 以及 #58a6ff 这类**数据可视化配色**（图/树的节点色，与宿主 UI 无关）
    const VIS_OK = /^#[0-9a-f]{3,8}$/i;
    const NEUTRAL = /^rgba?\(\s*(0|255)\s*,\s*(0|255)\s*,\s*(0|255)/i;
    const bad = [];
    for (const r of RULES) {
        for (const m of r.body.matchAll(/(?:^|[\s;])(color|background|background-color|border-color)\s*:\s*([^;]+);/gi)) {
            const val = m[2].trim();
            if (val.includes('var(--SmartTheme')) continue;
            if (NEUTRAL.test(val)) continue;
            if (/^(transparent|inherit|currentcolor|none)$/i.test(val)) continue;
            // 只对**纯色值**较真；含 var() 回退的整串放行
            const hex = /#[0-9a-f]{3,8}/i.exec(val);
            if (hex && VIS_OK.test(hex[0])) {
                // 数据可视化配色白名单（图节点 / 分支色，见 ui/common.js 与 ui/graph/view.js）
                const VIS_ALLOW = ['#58a6ff', '#f0883e', '#a371f7', '#db61a2', '#d29922', '#39c5cf',
                    '#f0c040', '#6f9fd8', '#9b8fd0'];
                if (!VIS_ALLOW.includes(hex[0].toLowerCase())) bad.push(`${r.selector} { ${m[1]}: ${val} }`);
                continue;
            }
            if (hex) bad.push(`${r.selector} { ${m[1]}: ${val} }`);
        }
    }
    assert.deepEqual(bad, [], `这些地方硬编码了颜色（应改用 var(--SmartTheme*, 回退)）：\n  ${bad.slice(0, 10).join('\n  ')}`);
});
