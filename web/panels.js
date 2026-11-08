/**
 * ChatFilesys 工作台 —— web 壳层面板（阅读视图 / 全局搜索 / 统计概览）
 *
 * **落点声明**（11-08 任务 design.md §1）：这三个面板是 web 壳层的新增能力
 * （11-07 PRD 定调「web 可以做尽可能多的事」），**不进弹窗模板**（ui/popup.js）——
 * 「绝不逐层列举楼层」铁律约束的是弹窗内的信息架构；阅读/搜索是壳层的
 * 「聊天记录查看」定位面，且编辑一律转交既有同源版本管理（openVersions），
 * 不新造第二份编辑 UI。插件侧未来接线时复用本模块（它只依赖 ports，零宿主假设）。
 *
 * 数据源全部来自 workbench 既有导出：activeRows()（活跃投影）与 allRows()（全家族行）。
 * 本模块零写路径——所有修改都经 wb.openVersions(floor) 的四能力（与插件同一份 UI）。
 */

import { esc, getActiveBranch } from '../public/scripts/extensions/third-party/chatfilesys/ui/common.js';

/**
 * 每个楼层的版本总数：库行数（分支级变体）与正文内联 swipes 数（库行把 swipe
 * 原样存在 line.swipes 里——buildFamilyFromJsonl 不拆行）取较大者。
 * 「这一层有过几个版本」的口径以 versionsAt 的展示为准（组内 swipe + 跨组变体），
 * 这里是给统计徽章与阅读视图角标用的近似口径：两者都算上，不少报也不重复计。
 * @param {object} wb createWorkbench 产物
 * @returns {Map<number, number>} floorNo → 版本数
 */
function floorVariantCount(wb) {
    const m = new Map();
    for (const r of wb.allRows()) m.set(r.floorNo, (m.get(r.floorNo) || 0) + 1);
    for (const r of wb.allRows()) {
        const sw = Array.isArray(r.line?.swipes) ? r.line.swipes.length : 0;
        if (sw > (m.get(r.floorNo) || 0)) m.set(r.floorNo, sw);
    }
    return m;
}

/* ==========================================================================
 * 统计概览（全家族 + 活跃分支双口径）
 * ========================================================================== */

/**
 * 计算家族统计（纯函数，无 DOM）。
 * 口径：
 * - 行去重按 variantId（共享楼层不重复计字数）；
 * - 「分叉层」= 同一楼层有 >1 个变体行（该层出现过 swipe / 分支）；
 * - 字数 = mes 字符数求和；用户/角色占比按 is_user 计条数；
 * - 时间跨度取行 send_date 里可解析的 min/max（解析不了就如实缺省，不编日期）。
 * @param {object} wb createWorkbench 产物（需 view() / activeRows() / allRows()）
 */
export function computeStats(wb) {
    const v = wb.view();
    const model = v.model;
    if (!model) return null;
    const rows = wb.allRows();
    const seen = new Set();
    let chars = 0;
    let userCount = 0;
    let charCount = 0;
    let minDate = null;
    let maxDate = null;
    for (const r of rows) {
        if (seen.has(r.variantId)) continue;
        seen.add(r.variantId);
        const mes = String(r.line?.mes ?? '');
        chars += mes.length;
        if (r.line?.is_user) userCount += 1;
        else charCount += 1;
        const d = r.sendDate ? new Date(String(r.sendDate)) : null;
        if (d && !Number.isNaN(d.getTime())) {
            if (!minDate || d < minDate) minDate = d;
            if (!maxDate || d > maxDate) maxDate = d;
        }
    }
    const variantCount = floorVariantCount(wb);
    const active = wb.activeRows();
    const branchName = model.branches.find((b) => b.id === v.branchId)?.name
        || model.branches.find((b) => b.is_default)?.name || '—';
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
        branchCount: model.branches.length,
        activeBranchName: branchName,
        activeFloors: active.length,
        activeChars: active.reduce((s, r) => s + String(r?.mes ?? '').length, 0),
        totalFloors: variantCount.size,
        forkFloors: [...variantCount.values()].filter((n) => n > 1).length,
        totalVariants: rows.length,
        chars,
        userCount,
        charCount,
        span: minDate && maxDate ? `${fmt(minDate)} ~ ${fmt(maxDate)}` : null,
    };
}

/** 统计条 HTML（chips）；stats=null 时返回空串 */
export function statsHtml(stats) {
    if (!stats) return '';
    const chip = (label, value, title) =>
        `<span class="cfsysw-chip" title="${esc(title)}">${esc(label)}<b>${esc(String(value))}</b></span>`;
    return [
        chip('分支', stats.branchCount, '全家族分支数'),
        chip('活跃分支', `${stats.activeBranchName} · ${stats.activeFloors} 层`, '当前打开的分支与它的层数'),
        chip('全库楼层', stats.totalFloors, '全家族出现过的楼层数（去重）'),
        chip('多版本层', stats.forkFloors, '版本数 >1 的楼层（含 swipe 变体与分支变体）'),
        chip('库行', stats.totalVariants, '全家族库行总数（分支级变体各占一行；swipe 内联在正文里）'),
        chip('字数', stats.chars.toLocaleString(), '全家族正文总字数（去重行）'),
        chip('用户 / 角色', `${stats.userCount} / ${stats.charCount}`, '消息条数（去重行）'),
        ...(stats.span ? [chip('时间跨度', stats.span, '按消息发送日期')] : []),
    ].join('');
}

/**
 * 活跃分支投影（带 floorNo 的行）：workbench.activeRows() 只给行内容本身（无楼层号），
 * 阅读视图需要楼层号 ⇒ 从 allRows()（带 floorNo/variantId）按活跃 path 值集过滤推导。
 * 口径与 workbench.activeRows() 一致（variantId ∈ 活跃 path，按楼层序）。
 * @param {object} wb createWorkbench 产物
 */
function activeProjection(wb) {
    const v = wb.view();
    if (!v.model) return [];
    const active = getActiveBranch(v.model, v.branchId);
    if (!active) return [];
    const pathSet = new Set(Object.values(active.path || {}));
    return wb.allRows().filter((r) => pathSet.has(r.variantId) && r.line);
}

/* ==========================================================================
 * 阅读视图（活跃分支完整投影；点任意楼层 → 该层版本管理）
 * ========================================================================== */

/**
 * 创建阅读视图面板。
 * @param {object} opts
 * @param {object} opts.workbench createWorkbench 产物
 * @param {(msg: string) => void} [opts.warn] 提示（家族未打开等）
 * @param {(floor: number) => Promise<void>} opts.openVersions 打开该层版本管理（= wb.openVersions）
 * @returns {{el, refresh, scrollToFloor, toggle, isOpen}}
 */
export function createReaderPanel(opts) {
    const wb = opts.workbench;
    let open = false;
    let fontPx = 14;               // 正文字号（12–20）
    let lastFloors = [];           // 当前渲染过的楼层号（上下层导航用）

    const el = document.createElement('section');
    el.className = 'cfsysw-reader';
    el.hidden = true;

    function msgHtml(r, variantCount) {
        const line = r.line || {};
        const name = String(line.name ?? (line.is_user ? 'User' : 'Char'));
        const time = line.send_date ? esc(String(line.send_date).replace('T', ' ').slice(0, 16)) : '';
        const mes = String(line.mes ?? '');
        return `
            <article class="cfsysw-msg${line.is_user ? ' cfsysw-msg-user' : ''}" data-floor="${esc(String(r.floorNo))}"
                title="点这条打开第 ${esc(String(r.floorNo))} 层的版本管理（切换 / 删除 / 重排 / 编辑）">
                <header class="cfsysw-msg-head">
                    <span class="cfsysw-msg-floor">#${esc(String(r.floorNo))}</span>
                    <span class="cfsysw-msg-name">${esc(name)}</span>
                    ${time ? `<span class="cfsysw-msg-time">${time}</span>` : ''}
                    ${variantCount > 1 ? `<span class="cfsysw-msg-variants" title="该层共 ${esc(String(variantCount))} 个版本（含其他分支）">${esc(String(variantCount))} 版</span>` : ''}
                </header>
                <div class="cfsysw-msg-body">${esc(mes) || '<span class="cfsysw-note">（空正文）</span>'}</div>
            </article>`;
    }

    function render() {
        const v = wb.view();
        const rows = activeProjection(wb);
        if (!v.model || !rows.length) {
            el.innerHTML = `
                <div class="cfsysw-reader-toolbar">
                    <span class="cfsysw-reader-title">阅读</span>
                    <span class="cfsysw-note">先打开一个家族（顶部选择或导入），这里会铺开当前分支的完整对话。</span>
                    <button class="cfsysw-btn" data-reader-act="close">关闭</button>
                </div>`;
            lastFloors = [];
            return;
        }
        // 每层的版本总数（库行 ∪ 内联 swipe——见 floorVariantCount 的口径注释）
        const variantCount = floorVariantCount(wb);
        lastFloors = rows.map((r) => r.floorNo);
        const branchLabel = v.model.branches.find((b) => b.id === v.branchId)?.name || '主分支';
        el.innerHTML = `
            <div class="cfsysw-reader-toolbar">
                <span class="cfsysw-reader-title"><i class="fa-solid fa-book-open"></i> 阅读 · ${esc(v.familyName)}</span>
                <span class="cfsysw-note">${esc(branchLabel)} · ${rows.length} 层 · 点任意一条管理该层版本</span>
                <span class="cfsysw-reader-tools">
                    <button class="cfsysw-btn" data-reader-act="prev" title="滚到上一条">↑ 上一层</button>
                    <button class="cfsysw-btn" data-reader-act="next" title="滚到下一条">↓ 下一层</button>
                    <button class="cfsysw-btn" data-reader-act="font-down" title="字号减小">A－</button>
                    <button class="cfsysw-btn" data-reader-act="font-up" title="字号增大">A＋</button>
                    <button class="cfsysw-btn" data-reader-act="close" title="回到管理界面">关闭</button>
                </span>
            </div>
            <div class="cfsysw-reader-scroll" style="--cfsysw-reader-font:${fontPx}px">
                ${rows.map((r) => msgHtml(r, variantCount.get(r.floorNo) || 1)).join('')}
            </div>`;
    }

    /** 滚到指定楼层（搜索「阅读定位」用）：没开着就先开 */
    function scrollToFloor(floor) {
        if (!open) toggle(true);
        render();
        const target = el.querySelector(`.cfsysw-msg[data-floor="${Number(floor)}"]`);
        if (!target) return;
        target.scrollIntoView({ block: 'center' });
        target.classList.remove('cfsysw-msg-flash');
        // 强制重启动画
        void target.offsetWidth;
        target.classList.add('cfsysw-msg-flash');
    }

    /** 当前滚动位置附近（视口内最靠上）的楼层号 */
    function currentFloor() {
        const nodes = [...el.querySelectorAll('.cfsysw-msg[data-floor]')];
        const top = el.querySelector('.cfsysw-reader-scroll')?.getBoundingClientRect().top ?? 0;
        for (const n of nodes) {
            if (n.getBoundingClientRect().top >= top - 8) return Number(n.dataset.floor);
        }
        return lastFloors[0] ?? null;
    }

    function step(delta) {
        const cur = currentFloor();
        const idx = lastFloors.indexOf(cur);
        const next = lastFloors[Math.min(lastFloors.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta))];
        if (next != null) scrollToFloor(next);
    }

    el.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-reader-act]')?.dataset.readerAct;
        if (act === 'close') { toggle(false); return; }
        if (act === 'prev') { step(-1); return; }
        if (act === 'next') { step(1); return; }
        if (act === 'font-up') { fontPx = Math.min(20, fontPx + 1); render(); keepScroll(); return; }
        if (act === 'font-down') { fontPx = Math.max(12, fontPx - 1); render(); keepScroll(); return; }
        const msg = e.target.closest('.cfsysw-msg[data-floor]');
        if (msg) await opts.openVersions(Number(msg.dataset.floor));
    });

    /** 字号重渲染后保持视口大致位置（按当前楼层重新定位） */
    function keepScroll() {
        const cur = currentFloor();
        if (cur != null) {
            const t = el.querySelector(`.cfsysw-msg[data-floor="${Number(cur)}"]`);
            t?.scrollIntoView({ block: 'start' });
        }
    }

    function toggle(force) {
        open = typeof force === 'boolean' ? force : !open;
        el.hidden = !open;
        el.dispatchEvent(new CustomEvent('cfsysw-reader-toggle', { bubbles: true }));
        if (open) render();
    }

    return {
        el,
        refresh: () => { if (open) render(); },
        scrollToFloor,
        toggle,
        isOpen: () => open,
    };
}

/* ==========================================================================
 * 全局搜索（全家族正文；结果 → 版本管理 / 阅读定位）
 * ========================================================================== */

/**
 * 创建搜索面板（输入框 + 结果面板）。
 * @param {object} opts
 * @param {object} opts.workbench createWorkbench 产物
 * @param {(msg: string) => void} [opts.info] 提示
 * @param {(floor: number) => Promise<void>} opts.openVersions 打开该层版本管理
 * @param {{ scrollToFloor: (n: number) => void }} opts.reader 阅读视图（「阅读定位」用）
 */
export function createSearchPanel(opts) {
    const wb = opts.workbench;
    const MAX_RESULTS = 50;

    const el = document.createElement('div');
    el.className = 'cfsysw-search';
    el.innerHTML = `
        <div class="cfsysw-search-bar">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" class="text_pole cfsysw-search-input" data-role="search-input"
                placeholder="在当前家族的全部楼层正文里搜索（回车执行）…" />
            <button class="cfsysw-btn" data-search-act="run">搜索</button>
        </div>
        <div class="cfsysw-search-results" data-role="search-results" hidden></div>`;

    const input = el.querySelector('[data-role="search-input"]');
    const results = el.querySelector('[data-role="search-results"]');

    /** 高亮片段：先转义再包 <mark>（防注入） */
    function snippet(text, query) {
        const lower = text.toLowerCase();
        const q = query.toLowerCase();
        const at = lower.indexOf(q);
        const from = Math.max(0, at - 40);
        const raw = text.slice(from, Math.min(text.length, at + query.length + 40));
        const pre = from > 0 ? '…' : '';
        const post = at + query.length + 40 < text.length ? '…' : '';
        // 逐段拼：匹配处包 mark（大小写不敏感、逐字面量）
        let out = '';
        let i = 0;
        const lowRaw = raw.toLowerCase();
        while (i < raw.length) {
            const hit = lowRaw.indexOf(q, i);
            if (hit < 0) { out += esc(raw.slice(i)); break; }
            out += esc(raw.slice(i, hit)) + '<mark>' + esc(raw.slice(hit, hit + q.length)) + '</mark>';
            i = hit + q.length;
        }
        return pre + out + post;
    }

    function run() {
        const query = input.value.trim();
        if (!wb.view().model) { opts.info?.('先打开一个家族再搜索。'); return; }
        if (query.length < 2) {
            results.hidden = false;
            results.innerHTML = '<div class="cfsysw-note">至少输入 2 个字符。</div>';
            return;
        }
        const branchLabel = new Map((wb.view().model.branches || []).map((b, i) => [b.id, `#${i + 1} ${b.name}`]));
        const hits = [];
        for (const r of wb.allRows()) {
            const mes = String(r.line?.mes ?? '');
            if (!mes.toLowerCase().includes(query.toLowerCase())) continue;
            hits.push({
                floorNo: r.floorNo,
                name: String(r.line?.name ?? (r.line?.is_user ? 'User' : 'Char')),
                isUser: Boolean(r.line?.is_user),
                snippetHtml: snippet(mes, query),
                branches: r.branchIds.map((id) => branchLabel.get(id) || id).join('、'),
            });
            if (hits.length >= MAX_RESULTS) break;
        }
        results.hidden = false;
        if (!hits.length) {
            results.innerHTML = `<div class="cfsysw-note">没有命中：「${esc(query)}」在全家族正文里零匹配（变体行也算进来了）。</div>`;
            return;
        }
        results.innerHTML = `
            <div class="cfsysw-search-meta">命中 ${hits.length}${hits.length >= MAX_RESULTS ? `（只显示前 ${MAX_RESULTS} 条）` : ''} 条</div>
            ${hits.map((h) => `
                <div class="cfsysw-search-hit" data-floor="${esc(String(h.floorNo))}">
                    <div class="cfsysw-search-hit-main">
                        <span class="cfsysw-msg-floor">#${esc(String(h.floorNo))}</span>
                        <span class="cfsysw-search-hit-name">${esc(h.name)}</span>
                        <span class="cfsysw-search-hit-branches" title="这一行出现的分支">${esc(h.branches)}</span>
                    </div>
                    <div class="cfsysw-search-hit-text">${h.snippetHtml}</div>
                    <div class="cfsysw-search-hit-ops">
                        <button class="cfsysw-btn" data-search-act="versions" data-floor="${esc(String(h.floorNo))}">版本管理</button>
                        <button class="cfsysw-btn" data-search-act="locate" data-floor="${esc(String(h.floorNo))}">阅读定位</button>
                    </div>
                </div>`).join('')}`;
    }

    el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-search-act]');
        if (!btn) return;
        const act = btn.dataset.searchAct;
        if (act === 'run') { run(); return; }
        const floor = Number(btn.dataset.floor);
        if (!Number.isFinite(floor)) return;
        if (act === 'versions') await opts.openVersions(floor);
        else if (act === 'locate') opts.reader.scrollToFloor(floor);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); run(); }
        if (e.key === 'Escape') { results.hidden = true; }
    });

    return { el, refresh: () => { results.hidden = true; } };
}
