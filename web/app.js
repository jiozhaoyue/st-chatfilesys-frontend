/**
 * ChatFilesys 工作台 —— web 入口（v1：完全同构挂载）
 *
 * 本文件只做「装配」（design.md §2）：把 web 侧 ports（localStorage 设置 / 页内 toast /
 * 原生对话框 / File API 下载）接进 ui/workbench.js 的宿主无关控制器，
 * UI = ui/popup.js#createPopupContent **原样整页挂载**（与酒馆弹窗同一模板源、
 * 同一 refresh(v) 合同、同一 data-action 动作名）。缺宿主的能力经 caps 置灰。
 *
 * 与 v0 的差异：不再自造「楼层明细 / 模型 JSON」面板——那会变成第二份业务 UI。
 */

import { createStorageAdapter } from '../public/scripts/extensions/third-party/chatfilesys/core/storage/adapter.js';
import { createPopupContent, ensureFloatWindowsAttached } from '../public/scripts/extensions/third-party/chatfilesys/ui/popup.js';
import { createWorkbench } from '../public/scripts/extensions/third-party/chatfilesys/ui/workbench.js';
import { readSetting, writeSetting, defaults as settingsDefaults } from '../public/scripts/extensions/third-party/chatfilesys/core/settings-registry.js';
import { computeStats, statsHtml, createReaderPanel, createSearchPanel } from './panels.js';

/* ---------------- 页内基础设施 ---------------- */

const $ = (id) => document.getElementById(id);

/** toast 容器：固定一个栈式容器（多提示纵向堆叠，不互相盖） */
const toastBox = document.createElement('div');
toastBox.className = 'cfsysw-toasts';
document.body.appendChild(toastBox);

function toast(kind, msg) {
    const box = document.createElement('div');
    box.className = `cfsysw-toast cfsysw-toast-${kind}`;
    box.textContent = msg;
    toastBox.appendChild(box);
    setTimeout(() => box.remove(), 4500);
}
const notify = {
    ok: (m) => toast('ok', m),
    info: (m) => toast('info', m),
    warn: (m) => toast('warn', m),
    error: (m) => toast('error', m),
};

function download(name, text) {
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------------- settings port（localStorage 后端；点分路径走 registry 纯函数） ---------------- */

const SETTINGS_LS_KEY = 'chatfilesys-web-settings';
const LAST_FAMILY_KEY = 'chatfilesys-web-last-family';

/** 记住上次打开的家族（对齐插件「当前聊天」语义：重开页面回到原处） */
function rememberFamily(familyId) {
    try {
        if (familyId) localStorage.setItem(LAST_FAMILY_KEY, familyId);
        else localStorage.removeItem(LAST_FAMILY_KEY);
    } catch { /* 隐私模式：不记忆，功能不受影响 */ }
}

function settingsTree() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_LS_KEY)) || {}; } catch { return {}; }
}
function persistSettings(tree) {
    try { localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(tree)); } catch { /* 配额/隐私模式：设置不落盘，内存态仍可用 */ }
}

const settingsPort = {
    get: (key) => readSetting(settingsTree(), key),
    set: (key, value) => {
        const tree = settingsTree();
        const r = writeSetting(tree, key, value);
        if (r.changed) persistSettings(tree);
        return r;
    },
    tree: settingsTree,
    resetAll: () => persistSettings(settingsDefaults()),
    exportAll: () => settingsTree(),
};

/* ---------------- 工作台装配 ---------------- */

let wb = null;
let content = null; // createPopupContent 产物 { el, refresh }
let reader = null;  // 阅读视图面板（web/panels.js）
let search = null;  // 全局搜索面板（web/panels.js）

function rerender() {
    if (!content || !wb) return;
    content.refresh(wb.view());
    ensureFloatWindowsAttached(); // PO-3 自愈兜底：小窗被清场后按记忆几何挂回
    syncFloorSelect();            // 楼层选择器跟随当前家族（版本管理入口）
    syncActionButtons();          // 删除家族等按钮跟随「有无家族」
    renderStats();
    reader?.refresh();
    syncGraphReadButton();        // 图节点选中 → 「阅读定位」按钮（web 壳层增强）
}

/** 统计条：家族统计概览（失败只降级成空条，不连坐页面） */
function renderStats() {
    const host = $('cfsysw-stats');
    if (!host) return;
    try {
        host.innerHTML = statsHtml(computeStats(wb));
    } catch { host.innerHTML = ''; }
}

/** 依「有无打开家族」启停顶部按钮（删除/改名家族只在有家族时可点） */
function syncActionButtons() {
    const has = Boolean(wb?.familyId);
    const del = $('cfsysw-delete');
    if (del) del.disabled = !has;
    const ren = $('cfsysw-rename');
    if (ren) ren.disabled = !has;
}

/**
 * 图节点 → 阅读定位：选中图节点后，在弹窗的「节点」面板尾部补一个「阅读定位」按钮
 * （web 壳层增强：不进共享模板——插件侧没有阅读视图；refresh 重填会清掉，每次重加）
 */
function syncGraphReadButton() {
    const panel = document.querySelector('.cfsysw-popup-host [data-role="graph-selection"]');
    if (!panel) return;
    panel.querySelector('[data-web-act="graph-read"]')?.remove();
    // 图选中是缓存态（家族关掉后仍残留）——没有打开家族就不给按钮（点了也只能看到空阅读）
    if (!wb?.view().model) return;
    const sel = wb.view().graphSelection;
    if (!sel || !Number.isFinite(sel.floor)) return;
    const btn = document.createElement('button');
    btn.className = 'cfsysw-btn';
    btn.dataset.webAct = 'graph-read';
    btn.title = `在阅读视图里定位到第 ${sel.floor} 层`;
    btn.textContent = `📖 阅读定位 #${sel.floor}`;
    panel.appendChild(btn);
}

/** 版本管理的统一入口（顶部按钮 / 阅读视图 / 搜索结果三处共用） */
function openVersionsAt(floor) {
    wb.openVersions(floor).catch((e) => notify.error(`版本管理打开失败：${e?.message || e}`));
}

/** 阅读视图开关 → 主区切换（阅读时藏管理面板，关了回来） */
function syncReaderVisibility() {
    $('app').classList.toggle('cfsysw-reading', Boolean(reader?.isOpen()));
    $('cfsysw-reader-btn')?.classList.toggle('cfsysw-btn-active', Boolean(reader?.isOpen()));
}

/** 楼层选择器：选项 = 活跃分支的楼层数（**选择器不是楼层列表**——不逐层枚举内容，铁律同插件） */
function syncFloorSelect() {
    const sel = $('cfsysw-floor');
    const btn = $('cfsysw-versions');
    if (!wb || !wb.activeRows().length) {
        sel.innerHTML = '<option value="">—</option>';
        sel.disabled = true;
        btn.disabled = true;
        return;
    }
    const n = wb.activeRows().length;
    sel.innerHTML = Array.from({ length: n }, (_, i) =>
        `<option value="${i + 1}" ${Number(sel.value) === i + 1 ? 'selected' : ''}>第 ${i + 1} 层</option>`).join('');
    if (!sel.value) sel.value = '1';
    sel.disabled = false;
    btn.disabled = false;
}

async function refreshFamilySelect(selectedId) {
    const sel = $('cfsysw-family');
    const list = await wb.listFamilies();
    sel.innerHTML = '<option value="">— 选择家族 —</option>' + list
        .map((f) => `<option value="${f.familyId}">${f.name || f.familyId}</option>`).join('');
    $('cfsysw-libcount').textContent = `${list.length} 个家族`;
    if (selectedId) sel.value = selectedId; // 导入/恢复后选择器与当前家族同步
}

/** 统一的「打开家族」路径：选择器、示例、导入、恢复全都走这里（状态单点同步） */
async function openById(familyId) {
    if (!familyId) return;
    try {
        await wb.openFamily(familyId);
        rememberFamily(familyId);
        $('cfsysw-family').value = familyId;
    } catch (e) { notify.error(`打开失败：${e?.message || e}`); }
    rerender();
}

/** 删除当前家族（web 壳层的库管理闭环；适配器契约自带 deleteFamily） */
async function deleteCurrentFamily() {
    const v = wb.view();
    const famId = wb.familyId;
    if (!v.model || !famId) { notify.warn('先打开一个家族。'); return; }
    const name = v.familyName || famId;
    const ok = globalThis.confirm(
        `删除家族「${name}」？\n该家族的全部楼层与分支将从当前存储档移除，不可还原。`
        + `\n（当前档位是浏览器本机缓存——重新导入源 .jsonl 即可重建）`);
    if (!ok) return;
    try {
        const r = await wb.adapter.deleteFamily({ familyId: famId });
        if (!r?.ok) throw new Error(r?.reason || '存储拒绝');
        rememberFamily(null);
        wb.closeFamily();
        notify.ok(`已删除家族「${name}」。`);
        await refreshFamilySelect(null);
    } catch (e) {
        notify.error(`删除失败：${e?.message || e}`);
    }
    rerender();
}

/** 家族改名（web 壳层库管理；适配器契约 renameFamily，idb/authority/official 三档齐备） */
async function renameCurrentFamily() {
    const v = wb.view();
    const famId = wb.familyId;
    if (!v.model || !famId) { notify.warn('先打开一个家族。'); return; }
    const cur = v.familyName || famId;
    const name = globalThis.prompt('新的家族名：', cur);
    if (!name || name === cur) return;
    try {
        const r = await wb.adapter.renameFamily({ familyId: famId, newName: name });
        if (!r?.ok) throw new Error(r?.reason || '存储拒绝');
        notify.ok(`已改名为「${name}」。`);
        await refreshFamilySelect(famId);
        await wb.openFamily(famId); // 重开让视图/统计读到新名（meta.name 变了）
    } catch (e) {
        notify.error(`改名失败：${e?.message || e}`);
    }
    rerender();
}

async function importFiles(files) {
    let lastId = null;
    for (const f of files) {
        try {
            const text = await f.text();
            const r = await wb.importText(f.name, text);
            lastId = r.familyId;
        } catch (e) {
            notify.error(`${f.name}：${e?.message || e}`);
        }
    }
    if (lastId) await openById(lastId);
    await refreshFamilySelect(lastId);
    rerender();
}

/* ---------------- 内置示例（走真导入路径，不直载模型） ---------------- */

const SAMPLE_HEADER = { user_name: 'User', character_name: '莉莉娅', create_date: 1700000000000, chat_metadata: {} };

const SAMPLE_ROWS = [
    {
        name: '莉莉娅', is_user: false, is_name: true, send_date: '2023-11-15T06:13:00',
        mes: '“请等一下，冒险者！前面的迷雾森林最近很不寻常，如果你要前往旧神圣所，最好先备齐清醒药草。”\n一位身着灰绿色斗篷的精灵少女从古树后探出头，手中握着刚刚摘下的发光地衣。',
        swipes: [
            '“请等一下，冒险者！前面的迷雾森林最近很不寻常，如果你要前往旧神圣所，最好先备齐清醒药草。”\n一位身着灰绿色斗篷的精灵少女从古树后探出头，手中握着刚刚摘下的发光地衣。',
            '“止步，旅人。前方三里已被瘴气封锁，若不想迷失心智，便收下这片宁神花叶。”\n少女眼神清澈警惕，法杖尖端泛着柔和的微光。',
        ],
        swipe_id: 0,
    },
    { name: 'User', is_user: true, is_name: true, send_date: '2023-11-15T06:14:00', mes: '我停下脚步打量着她：“谢谢你的提醒，我是接受了公会的委托前去调查异象的。你对森林深处的古遗迹了解多少？”' },
    {
        name: '莉莉娅', is_user: false, is_name: true, send_date: '2023-11-15T06:15:00',
        mes: '“古遗迹……”莉莉娅的神色微微一变，“那里曾封印着上古时期的梦境残影。如果执意前往，我们可以结伴同行，我正好需要采集遗迹石缝中的月光藓。”',
        swipes: [
            '“古遗迹……”莉莉娅的神色微微一变，“那里曾封印着上古时期的梦境残影。如果执意前往，我们可以结伴同行，我正好需要采集遗迹石缝中的月光藓。”',
            '莉莉娅轻叹了一口气：“古遗迹的结界在昨夜松动了。你一个人去太危险了，跟我来营地，我先为你调配一瓶破瘴药水。”',
            '“那是一片被遗忘的禁地。”莉莉娅压低声音，“相传只要靠近，耳边就会响起低语。我劝你放弃委托回城镇去。”',
        ],
        swipe_id: 0,
    },
    { name: 'User', is_user: true, is_name: true, send_date: '2023-11-15T06:16:00', mes: '“好，我们先在林间寻找月光藓，顺便观察遗迹周边的魔力波动。”' },
    { name: '莉莉娅', is_user: false, is_name: true, send_date: '2023-11-15T06:17:00', mes: '莉莉娅点点头，轻快地拨开荆棘：“跟紧我，踩在我走过的苔藓上，这样不会触碰到林中的幻觉蘑菇孢子。”' },
];

/* ---------------- 启动 ---------------- */

async function boot() {
    const pick = await createStorageAdapter({ log: () => {} }); // 无宿主 ⇒ 自动落档3
    wb = createWorkbench({
        adapter: pick.adapter,
        settings: settingsPort,
        notify,
        dialog: { prompt: (m, d) => globalThis.prompt(m, d), confirm: (m) => globalThis.confirm(m) },
        files: { exportJsonl: download, listHostChats: null },
        caps: { liveChat: false, mirror: false, ai: false, graph: true },
        events: { rendered: rerender },
    });
    wb.tier = pick.tier;
    const chain = pick.attempts.map((a) => `${a.tier}:${a.ok ? '✓' : a.reason}`).join(' → ');
    $('cfsysw-tier').textContent = `档位 ${pick.tier}（降级链 ${chain}）`;

    content = createPopupContent({}, wb.view()); // ctx 无 renderLukerTabs → 内置降级 Tab（与 ST 同款降级路径）
    $('cfsysw-popup-host').appendChild(content.el);
    wb.bind(document); // 文档级委托：弹窗内容 + PO-3 小窗全覆盖

    // web 壳层面板（阅读 / 搜索 / 统计）：编辑一律转交同一份版本管理，不新造编辑面
    reader = createReaderPanel({
        workbench: wb,
        warn: notify.warn,
        info: notify.info,
        openVersions: openVersionsAt,
        switchBranch: async (branchId) => {
            await wb.handleAction('switch', { dataset: { branch: branchId } });
            syncFloorSelect(); // 活跃分支变了 → 楼层选择器跟随
        },
        exportText: download,
    });
    reader.el.addEventListener('cfsysw-reader-toggle', syncReaderVisibility);
    $('cfsysw-reader-host').appendChild(reader.el);
    search = createSearchPanel({ workbench: wb, info: notify.info, openVersions: openVersionsAt, reader });
    $('cfsysw-search-host').appendChild(search.el);
    $('cfsysw-reader-btn').addEventListener('click', () => reader.toggle());

    $('cfsysw-family').addEventListener('change', (e) => openById(e.target.value));
    $('cfsysw-versions').addEventListener('click', () => openVersionsAt(Number($('cfsysw-floor').value || 1)));
    $('cfsysw-delete').addEventListener('click', () => deleteCurrentFamily());
    $('cfsysw-rename').addEventListener('click', () => renameCurrentFamily());
    // 图节点「阅读定位」（syncGraphReadButton 注入的 web 壳层按钮；capture 阶段先于弹窗委托也无妨）
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-web-act="graph-read"]');
        if (!btn) return;
        if (!wb?.view().model) { notify.warn('先打开一个家族。'); return; }
        const floor = wb.view().graphSelection?.floor;
        if (Number.isFinite(floor)) { reader.scrollToFloor(floor); notify.info(`阅读视图已定位到第 ${floor} 层。`); }
    });
    // 点搜索面板外面收起结果（Esc 已有；这里补鼠标路径）
    document.addEventListener('click', (e) => {
        if (e.target.closest('.cfsysw-search')) return;
        const res = document.querySelector('[data-role="search-results"]');
        if (res && !res.hidden) res.hidden = true;
    });

    // 页面级异常兜底：任何漏网异常至少在页面上说一声（不静默）
    window.addEventListener('error', (e) => notify.error(`页面异常：${e?.message || e}`));
    window.addEventListener('unhandledrejection', (e) => notify.error(`未处理的异步异常：${e?.reason?.message || e?.reason || e}`));
    $('cfsysw-sample').addEventListener('click', async () => {
        const lines = [JSON.stringify(SAMPLE_HEADER), ...SAMPLE_ROWS.map((r) => JSON.stringify(r))];
        try {
            const r = await wb.importText('莉莉娅 - 示例.jsonl', lines.join('\n'));
            await openById(r.familyId);
            await refreshFamilySelect(r.familyId); // 重建选项后保持选中（openById 先设的值会被重建冲掉）
        } catch (e) { notify.error(e?.message || String(e)); }
        rerender();
    });
    $('cfsysw-file').addEventListener('change', (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        if (files.length) importFiles(files);
    });

    rerender();
    await refreshFamilySelect();
    // 恢复上次打开的家族（重开页面回到原处；家族已删则静默停留在未启用态）
    const last = (() => { try { return localStorage.getItem(LAST_FAMILY_KEY); } catch { return null; } })();
    if (last && (await wb.listFamilies()).some((f) => f.familyId === last)) {
        await openById(last);
    }
}

boot().catch((e) => {
    console.error('[chatfilesys-web] 启动失败:', e);
    notify.error(`启动失败：${e?.message || e}`);
});

// 开发/自动化钩子（e2e 需要从页面触达工作台；生产用户不感知）。
// 命名刻意不像产品 API——只给测试脚本用，不作为任何功能的依赖面。
window.__cfsysw_web_hook = { get workbench() { return wb; }, notify };
