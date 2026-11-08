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

import { esc } from '../public/scripts/extensions/third-party/chatfilesys/ui/common.js';

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
 * 某条分支的投影（带 floorNo 的行）：branchId 缺省 = 当前视图分支（与 workbench.activeRows()
 * 口径一致——variantId ∈ 该分支 path 值集，按楼层序）；给别的分支 = 只读投影（阅读视图的「读其他分支」模式）。
 * @param {object} wb createWorkbench 产物
 * @param {string|null} [branchId] 目标分支；null = 当前视图分支
 */
function branchProjection(wb, branchId = null) {
    const v = wb.view();
    if (!v.model) return [];
    const target = branchId || v.branchId;
    const branch = v.model.branches.find((b) => b.id === target);
    if (!branch) return [];
    const pathSet = new Set(Object.values(branch.path || {}));
    return wb.allRows().filter((r) => pathSet.has(r.variantId) && r.line);
}

/* ==========================================================================
 * 阅读视图（活跃分支完整投影；点任意楼层 → 该层版本管理）
 * ========================================================================== */

/**
 * 创建阅读视图面板。
 * @param {object} opts
 * @param {object} opts.workbench createWorkbench 产物
 * @param {(msg: string) => void} [opts.info] 轻提示（只读投影点正文等）
 * @param {(msg: string) => void} [opts.warn] 提示（家族未打开等）
 * @param {(floor: number) => Promise<void>} opts.openVersions 打开该层版本管理（= wb.openVersions）
 * @param {(branchId: string) => Promise<void>} [opts.switchBranch] 切换活跃分支（= wb.handleAction('switch')）
 * @param {(name: string, text: string) => Promise<void>} [opts.exportText] 文本导出（下载端口）
 * @returns {{el, refresh, scrollToFloor, toggle, isOpen}}
 */
export function createReaderPanel(opts) {
    const wb = opts.workbench;
    let open = false;
    // 字号记忆（浏览器本地；隐私模式读不到就用默认值）
    const FONT_KEY = 'chatfilesys-web-reader-font';
    let fontPx = (() => { try { return Math.min(20, Math.max(12, Number(localStorage.getItem(FONT_KEY)) || 14)); } catch { return 14; } })();
    const rememberFont = () => { try { localStorage.setItem(FONT_KEY, String(fontPx)); } catch { /* 配额/隐私模式：不记忆，内存态仍可用 */ } };
    let lastFloors = [];           // 当前渲染过的楼层号（上下层导航用）
    let readBranchId = null;       // 正在读的分支；null = 当前视图分支（活跃投影）
    const swipePreview = new Map(); // floorNo → 内联 swipe 预览下标（**只读预览**，不落库）

    const el = document.createElement('section');
    el.className = 'cfsysw-reader';
    el.hidden = true;

    function msgHtml(r, variantCount, clickable) {
        const line = r.line || {};
        const name = String(line.name ?? (line.is_user ? 'User' : 'Char'));
        const time = line.send_date ? esc(String(line.send_date).replace('T', ' ').slice(0, 16)) : '';
        // 内联 swipe 只读预览：正文取「预览下标」覆盖（没翻过 = 当前选中版）；
        // 这是给阅读时对照用的纯客户端视图，正式切换/编辑走版本管理
        const swipes = Array.isArray(line.swipes) ? line.swipes : null;
        const hasFlip = clickable && swipes && swipes.length > 1;
        const idx = Math.min(hasFlip ? (swipePreview.get(r.floorNo) ?? (Number.isInteger(line.swipe_id) ? line.swipe_id : 0)) : 0, (swipes?.length || 1) - 1);
        const mes = String(hasFlip ? (swipes[idx] ?? line.mes ?? '') : (line.mes ?? ''));
        return `
            <article class="cfsysw-msg${line.is_user ? ' cfsysw-msg-user' : ''}${clickable ? '' : ' cfsysw-msg-readonly'}"
                data-floor="${esc(String(r.floorNo))}"
                title="${clickable
                ? `点这条打开第 ${esc(String(r.floorNo))} 层的版本管理（切换 / 删除 / 重排 / 编辑）`
                : '只读投影：这是别的分支的内容，先「切到此分支」才能编辑'}">
                <header class="cfsysw-msg-head">
                    <span class="cfsysw-msg-floor">#${esc(String(r.floorNo))}</span>
                    <span class="cfsysw-msg-name">${esc(name)}</span>
                    ${time ? `<span class="cfsysw-msg-time">${time}</span>` : ''}
                    ${variantCount > 1 ? `<span class="cfsysw-msg-variants" title="该层共 ${esc(String(variantCount))} 个版本（含其他分支）">${esc(String(variantCount))} 版</span>` : ''}
                </header>
                <div class="cfsysw-msg-body">${esc(mes) || '<span class="cfsysw-note">（空正文）</span>'}</div>
                ${hasFlip ? `
                <div class="cfsysw-swipe-flip" title="只读预览这一层的各个版本（正式切换 / 编辑请点正文打开版本管理）">
                    <button class="cfsysw-btn" data-swipe-act="prev" data-floor="${esc(String(r.floorNo))}" ${idx <= 0 ? 'disabled' : ''}>◀</button>
                    <span>版本 ${idx + 1}/${swipes.length}（预览）</span>
                    <button class="cfsysw-btn" data-swipe-act="next" data-floor="${esc(String(r.floorNo))}" ${idx >= swipes.length - 1 ? 'disabled' : ''}>▶</button>
                </div>` : ''}
            </article>`;
    }

    /** 日期分隔线：相邻两条消息的日期不同时插一条（解析不了日期的行不打断） */
    function daySeparator(prev, cur) {
        const d = (r) => { try { return String(r?.line?.send_date ?? '').slice(0, 10); } catch { return ''; } };
        const day = d(cur);
        if (!day || day === d(prev)) return '';
        return `<div class="cfsysw-day-sep"><span>${esc(day)}</span></div>`;
    }

    /** 导出当前阅读投影为 Markdown（只读快照；正文原样，不带插件命名空间） */
    function buildMarkdown(familyName, branchName, rows) {
        const out = [`# ${familyName} — ${branchName}`, ''];
        for (const r of rows) {
            const line = r.line || {};
            const who = `${line.is_user ? '👤' : '🎭'} ${String(line.name ?? (line.is_user ? 'User' : 'Char'))}`;
            const when = line.send_date ? ` · ${String(line.send_date).replace('T', ' ').slice(0, 16)}` : '';
            out.push(`## #${r.floorNo} ${who}${when}`, '', String(line.mes ?? ''), '');
        }
        return out.join('\n');
    }

    function render() {
        const v = wb.view();
        const rows = branchProjection(wb, readBranchId);
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
        const isCurrent = !readBranchId || readBranchId === v.branchId;
        const branchLabel = v.model.branches.find((b) => b.id === (readBranchId || v.branchId))?.name || '—';
        const branchOpts = v.model.branches
            .map((b, i) => `<option value="${esc(b.id)}" ${(readBranchId || v.branchId) === b.id ? 'selected' : ''}>#${i + 1} ${esc(b.name)}${b.is_default ? '（主分支）' : ''}</option>`)
            .join('');
        el.innerHTML = `
            <div class="cfsysw-reader-progress" data-role="reader-progress"></div>
            <div class="cfsysw-reader-toolbar">
                <span class="cfsysw-reader-title"><i class="fa-solid fa-book-open"></i> 阅读 · ${esc(v.familyName)}</span>
                <select class="text_pole" data-role="reader-branch" title="选一条分支来读（别的分支是只读投影）">${branchOpts}</select>
                <span class="cfsysw-note">${esc(branchLabel)} · ${rows.length} 层 · ${isCurrent ? '点任意一条管理该层版本' : '只读投影——「切到此分支」后可编辑'}</span>
                <span class="cfsysw-reader-tools">
                    ${isCurrent ? '' : `<button class="cfsysw-btn" data-reader-act="switch-branch" title="把正在读的分支设为活跃分支（落库；打开这个聊天看到它）"><i class="fa-solid fa-arrow-right-arrow-left"></i> 切到此分支</button>`}
                    <button class="cfsysw-btn" data-reader-act="export-md" title="把当前阅读的分支导出为 Markdown 文稿（只读快照）"><i class="fa-solid fa-file-arrow-down"></i> 导出 Markdown</button>
                    <button class="cfsysw-btn" data-reader-act="prev" title="滚到上一条（快捷键 ←）">↑ 上一层</button>
                    <button class="cfsysw-btn" data-reader-act="next" title="滚到下一条（快捷键 →）">↓ 下一层</button>
                    <button class="cfsysw-btn" data-reader-act="font-down" title="字号减小">A－</button>
                    <button class="cfsysw-btn" data-reader-act="font-up" title="字号增大">A＋</button>
                    <button class="cfsysw-btn" data-reader-act="close" title="回到管理界面（快捷键 Esc）">关闭</button>
                </span>
            </div>
            <div class="cfsysw-reader-scroll" style="--cfsysw-reader-font:${fontPx}px">
                ${rows.map((r, i) => daySeparator(rows[i - 1], r) + msgHtml(r, variantCount.get(r.floorNo) || 1, isCurrent)).join('')}
            </div>`;
    }

    /** 把某层滚到视口中央（手动 scrollTop 算术——scrollIntoView 在后台标签页会被浏览器搁置） */
    function scrollMsgIntoCenter(target) {
        const sc = el.querySelector('.cfsysw-reader-scroll');
        if (!sc || !target) return;
        const scRect = sc.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();
        sc.scrollTop += (tRect.top + tRect.height / 2) - (scRect.top + scRect.height / 2);
        updateProgress();
    }

    /** 阅读进度条：显式更新为主（scroll 事件在后台标签页会被搁置，事件只作兜底） */
    function updateProgress() {
        const sc = el.querySelector('.cfsysw-reader-scroll');
        const bar = el.querySelector('[data-role="reader-progress"]');
        if (!sc || !bar) return;
        const max = sc.scrollHeight - sc.clientHeight;
        bar.style.width = `${max > 0 ? Math.min(100, (sc.scrollTop / max) * 100) : 100}%`;
    }

    // 兜底：用户滚轮/拖动滚动条时（scroll 不冒泡，捕获阶段在面板根上收）
    el.addEventListener('scroll', (e) => {
        if (e.target?.classList?.contains('cfsysw-reader-scroll')) updateProgress();
    }, true);

    /** 滚到指定楼层（搜索「阅读定位」/ 键盘翻层用）：没开着就先开 */
    function scrollToFloor(floor) {
        if (!open) toggle(true);
        render();
        const target = el.querySelector(`.cfsysw-msg[data-floor="${Number(floor)}"]`);
        if (!target) return;
        scrollMsgIntoCenter(target);
        target.classList.remove('cfsysw-msg-flash');
        // 强制重启动画
        void target.offsetWidth;
        target.classList.add('cfsysw-msg-flash');
    }

    /** 当前读到的楼层 = 覆盖滚动容器**中线**的那一层（按顶部判定会在滚动余量不足时卡住） */
    function currentFloor() {
        const sc = el.querySelector('.cfsysw-reader-scroll');
        if (!sc) return lastFloors[0] ?? null;
        const mid = sc.getBoundingClientRect().top + sc.clientHeight / 2;
        const nodes = [...sc.querySelectorAll('.cfsysw-msg[data-floor]')];
        let cur = null;
        for (const n of nodes) {
            if (n.getBoundingClientRect().top <= mid) cur = Number(n.dataset.floor);
            else break;
        }
        return cur ?? lastFloors[0] ?? null;
    }

    function step(delta) {
        const cur = currentFloor();
        const idx = lastFloors.indexOf(cur);
        const next = lastFloors[Math.min(lastFloors.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta))];
        if (next != null) scrollToFloor(next);
    }

    el.addEventListener('click', async (e) => {
        // 内联 swipe 只读预览（不与「点层开版本管理」冲突：flipper 优先消费）
        const flip = e.target.closest('[data-swipe-act]');
        if (flip) {
            e.stopPropagation();
            const floor = Number(flip.dataset.floor);
            const line = branchProjection(wb, readBranchId).find((r) => r.floorNo === floor)?.line;
            const n = Array.isArray(line?.swipes) ? line.swipes.length : 0;
            if (!n) return;
            const cur = swipePreview.get(floor) ?? (Number.isInteger(line.swipe_id) ? line.swipe_id : 0);
            swipePreview.set(floor, Math.min(n - 1, Math.max(0, cur + (flip.dataset.swipeAct === 'next' ? 1 : -1))));
            const keep = currentFloor();
            render();
            if (keep != null) {
                const t = el.querySelector(`.cfsysw-msg[data-floor="${Number(keep)}"]`);
                if (t) scrollMsgIntoCenter(t);
            }
            return;
        }
        const act = e.target.closest('[data-reader-act]')?.dataset.readerAct;
        if (act === 'close') { toggle(false); return; }
        if (act === 'prev') { step(-1); return; }
        if (act === 'next') { step(1); return; }
        if (act === 'font-up') { fontPx = Math.min(20, fontPx + 1); rememberFont(); render(); keepScroll(); return; }
        if (act === 'font-down') { fontPx = Math.max(12, fontPx - 1); rememberFont(); render(); keepScroll(); return; }
        if (act === 'switch-branch') {
            if (readBranchId && opts.switchBranch) await opts.switchBranch(readBranchId);
            readBranchId = null; // 已成为活跃分支 → 回到可编辑投影
            render();
            return;
        }
        if (act === 'export-md') {
            const v = wb.view();
            const rows = branchProjection(wb, readBranchId);
            if (!rows.length) { opts.info?.('没有可导出的内容。'); return; }
            const branchName = v.model.branches.find((b) => b.id === (readBranchId || v.branchId))?.name || '分支';
            const md = buildMarkdown(v.familyName, branchName, rows);
            await opts.exportText(`${v.familyName || 'chat'} - ${branchName}.md`, md);
            opts.info?.('已导出 Markdown（只读快照）。');
            return;
        }
        const msg = e.target.closest('.cfsysw-msg[data-floor]');
        if (!msg) return;
        if (!readBranchId || readBranchId === wb.view().branchId) {
            await opts.openVersions(Number(msg.dataset.floor));
        } else {
            opts.info?.('这是别的分支的只读投影——先点「切到此分支」再编辑。');
        }
    });

    // 分支选择器：换一条来读（只读投影；不动库内活跃分支）
    el.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-role="reader-branch"]');
        if (!sel) return;
        const active = wb.view().branchId;
        readBranchId = sel.value && sel.value !== active ? sel.value : null;
        swipePreview.clear();
        render();
    });

    // 键盘导航（← / → 翻层，Esc 关阅读）：输入框聚焦或任何模态开着时不抢按键
    el.dataset.keybound = ''; // 标记位：本面板只绑一次（app.js 每页建一个 reader）
    document.addEventListener('keydown', (e) => {
        if (!open) return;
        if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
        if (document.querySelector('dialog[open]')) return;
        if (e.key === 'ArrowLeft') { step(-1); }
        else if (e.key === 'ArrowRight') { step(1); }
        else if (e.key === 'Escape') { toggle(false); }
    });

    /** 字号重渲染后保持视口大致位置（按当前楼层重新定位到视口顶部） */
    function keepScroll() {
        const cur = currentFloor();
        if (cur == null) return;
        const sc = el.querySelector('.cfsysw-reader-scroll');
        const t = el.querySelector(`.cfsysw-msg[data-floor="${Number(cur)}"]`);
        if (!sc || !t) return;
        const scRect = sc.getBoundingClientRect();
        const tRect = t.getBoundingClientRect();
        sc.scrollTop += tRect.top - scRect.top - 12;
    }

    // 阅读进度条：scroll 不冒泡，用捕获阶段在面板根上收（面板只建一次，监听跟着活全程）
    el.addEventListener('scroll', (e) => {
        const sc = e.target;
        if (!sc?.classList?.contains('cfsysw-reader-scroll')) return;
        const bar = el.querySelector('[data-role="reader-progress"]');
        if (!bar) return;
        const max = sc.scrollHeight - sc.clientHeight;
        bar.style.width = `${max > 0 ? Math.min(100, (sc.scrollTop / max) * 100) : 100}%`;
    }, true);

    function toggle(force) {
        open = typeof force === 'boolean' ? force : !open;
        el.hidden = !open;
        el.dispatchEvent(new CustomEvent('cfsysw-reader-toggle', { bubbles: true }));
        if (open) { swipePreview.clear(); render(); } // 预览下标跟着打开动作重置（各分支内容不同）
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
                time: r.sendDate ? esc(String(r.sendDate).replace('T', ' ').slice(0, 16)) : '',
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
                        ${h.time ? `<span class="cfsysw-search-hit-time">${h.time}</span>` : ''}
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
