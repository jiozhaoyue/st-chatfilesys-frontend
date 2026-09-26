/**
 * 模块导入路径守卫：插件里每个**相对** import/export-from 的落点都必须对。
 *
 * 教训来源（2026-09-26，T8 实施时真机踩到）：新建的 `ui/import-prompt.js` 把官方
 * `popup.js` 的相对深度写成 `../../../`（正确应为 `../../../../`，ui/ 比 index.js 深一层）——
 * 浏览器里这个 import 直接失败 → **整个扩展激活失败**（入口按钮都不出现、面板打不开），
 * 而单测全绿、`node --check` 也只报「语法 OK」（它只解析语法，不解析路径）。
 * 这类错误只在真机才暴露，代价是整轮 e2e 白跑，故用零依赖的静态用例钉住。
 *
 * 两条规则（实测过的宿主布局）：
 *   ① 落点在插件目录**内** → 文件必须真实存在；
 *   ② 落点**逃出**插件目录（引用宿主模块）→ 必须正好落在宿主布局的固定位置：
 *      插件住在 `public/scripts/extensions/third-party/chatfilesys/`，故
 *      `public/script.js` 或 `public/scripts/<名字>.js`（多一层目录就是深度写错）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../../public/scripts/extensions/third-party/chatfilesys');
/** 宿主 `public/` 根：插件 → third-party → extensions → scripts → public（4 级 ../） */
const PUBLIC_ROOT = path.resolve(PLUGIN_ROOT, '../../../..');

/** 递归收集插件目录下全部 .js */
function collectJs(dir) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...collectJs(p));
        else if (ent.isFile() && ent.name.endsWith('.js')) out.push(p);
    }
    return out;
}

/** 源码里静态 import/export-from 的模块说明符（只取相对路径） */
function relativeSpecifiers(src) {
    const specs = [];
    const re = /(?:^|[\s;{(])(?:import|export)\s[\s\S]*?from\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
    const re2 = /(?:^|[\s;{(])import\s*['"]([^'"]+)['"]/g;   // `import './x.js'`（无 from）
    while ((m = re2.exec(src)) !== null) specs.push(m[1]);
    return specs.filter((s) => s.startsWith('./') || s.startsWith('../'));
}

function existsAny(target) {
    return [target, `${target}.js`, path.join(target, 'index.js')]
        .some((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

test('module-paths：插件内的相对 import 全部指向存在的文件', () => {
    const files = collectJs(PLUGIN_ROOT);
    assert.ok(files.length >= 15, `插件文件数异常（${files.length}）`);
    const bad = [];
    let checked = 0;
    for (const f of files) {
        for (const spec of relativeSpecifiers(fs.readFileSync(f, 'utf8'))) {
            const target = path.resolve(path.dirname(f), spec);
            if (!target.startsWith(PLUGIN_ROOT + path.sep)) continue;  // 逃出插件目录的见下一条
            checked++;
            if (!existsAny(target)) bad.push(`${path.relative(PLUGIN_ROOT, f)} → ${spec}`);
        }
    }
    assert.ok(checked >= 20, `插件内部相对 import 解析到的太少（${checked}），正则可能失配`);
    assert.deepEqual(bad, [], `相对 import 指向不存在的文件：\n${bad.join('\n')}`);
});

test('module-paths：引用宿主模块的相对路径深度正确（必须落在宿主布局的固定位置）', () => {
    const bad = [];
    let checked = 0;
    for (const f of collectJs(PLUGIN_ROOT)) {
        for (const spec of relativeSpecifiers(fs.readFileSync(f, 'utf8'))) {
            const target = path.resolve(path.dirname(f), spec);
            if (target.startsWith(PLUGIN_ROOT + path.sep)) continue;  // 插件内部，上一条管
            checked++;
            const rel = path.relative(PUBLIC_ROOT, target).replaceAll('\\', '/');
            // 宿主模块只有两种落点：public/script.js、public/scripts/<名字>.js
            if (!/^(script\.js|scripts\/[^/]+)$/.test(rel)) {
                bad.push(`${path.relative(PLUGIN_ROOT, f)} → ${spec} （解析到 public/${rel}）`);
            }
        }
    }
    assert.ok(checked >= 3, `引用宿主模块的相对 import 解析到的太少（${checked}）`);
    assert.deepEqual(bad, [],
        `相对路径深度错（宿主模块只在 public/script.js 或 public/scripts/*.js）：\n${bad.join('\n')}`);
});

test('module-paths：动态 import 的相对路径也指向存在的文件', () => {
    const re = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    const bad = [];
    for (const f of collectJs(PLUGIN_ROOT)) {
        const src = fs.readFileSync(f, 'utf8');
        let m;
        while ((m = re.exec(src)) !== null) {
            const target = path.resolve(path.dirname(f), m[1]);
            if (!existsAny(target)) bad.push(`${path.relative(PLUGIN_ROOT, f)} → ${m[1]}`);
        }
    }
    assert.deepEqual(bad, [], `动态 import 指向不存在的文件：\n${bad.join('\n')}`);
});

test('module-paths：ui/ 与 index.js 的宿主模块深度点对点（错一位就是扩展整体起不来）', () => {
    const index = fs.readFileSync(path.join(PLUGIN_ROOT, 'index.js'), 'utf8');
    const popupUi = fs.readFileSync(path.join(PLUGIN_ROOT, 'ui/import-prompt.js'), 'utf8');
    const versionsUi = fs.readFileSync(path.join(PLUGIN_ROOT, 'ui/versions.js'), 'utf8');
    assert.match(index, /from '\.\.\/\.\.\/\.\.\/popup\.js'/);            // chatfilesys/ → scripts/popup.js
    assert.match(index, /from '\.\.\/\.\.\/\.\.\/\.\.\/script\.js'/);      // chatfilesys/ → public/script.js
    assert.match(popupUi, /from '\.\.\/\.\.\/\.\.\/\.\.\/popup\.js'/);    // ui/ 多一级
    assert.match(versionsUi, /from '\.\.\/\.\.\/\.\.\/\.\.\/popup\.js'/);
});
