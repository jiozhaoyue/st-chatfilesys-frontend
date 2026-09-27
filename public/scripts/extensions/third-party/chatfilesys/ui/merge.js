/**
 * ChatFilesys — 分支合并弹窗
 *
 * 宿主 = **官方 Popup（DISPLAY + wide）**，与 `ui/versions.js` 同形；不挂 `document.body`、
 * 不自造浮层（spec/frontend/ui-placement.md）。关窗连带清 DOM（同一处置，防宿主直接 `close()`
 * 绕开清理留下残骸）。
 *
 * ── 它的职责边界 ──
 * 本模块只做**界面**：选两条分支、看规划结果、逐层处理冲突。
 * 「合并怎么算」全在 `core/branch-merge.js`（纯函数，有单测）；「怎么落盘」在 `index.js`
 * （走既有 `branches.js` + `saveMetadata`）。本模块**不碰模型**——它只把 `plan` 和用户的
 * 选择交给调用方。
 *
 * ── 弹窗铁律的落地 ──
 * 冲突列表**不显示正文**，只显示「第 N 层 · A 侧 132 字 / B 侧 98 字」+「看 A」「看 B」两个按钮
 * ——想看全文是**用户主动动作**，那时交给调用方用既有的展示层打开（不在本模块里渲染正文）。
 */

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';   // 子目录多一级：ui/ 比 index.js 深一层
import { esc } from './common.js';
import { planMerge, describeMerge } from '../core/branch-merge.js';

/**
 * 打开合并弹窗。
 *
 * @param {object} opts
 * @param {object} opts.model 家族模型
 * @param {string} opts.aId 默认「目标分支」（保留方）——一般是当前选中的分支
 * @param {(floor:number, gid:string) => number} opts.charsOf 取某层某组的字数（正文不进弹窗）
 * @param {(args:{floor:number, gid:string, side:string}) => void} [opts.onPeek] 用户点「看 A/B」时调
 * @param {(args:{plan:object, name:string, aId:string, bId:string}) => Promise<void>} opts.onApply
 *   用户点「合并」时调（**落盘由调用方做**）；抛错则弹窗内显示错误、不关闭
 * @returns {object} Popup 实例
 */
export function openMergePopup(opts) {
    const model = opts.model;
    const branches = Array.isArray(model?.branches) ? model.branches : [];
    const charsOf = typeof opts.charsOf === 'function' ? opts.charsOf : () => 0;

    /** 界面状态（唯一可变处） */
    const state = {
        aId: opts.aId || branches[0]?.id || '',
        bId: '',
        choices: {},        // 层号 → 'a' | 'b'
        plan: null,
        busy: false,
        error: '',
    };
    // 默认「要并进来的」= 第一条不是目标的分支（省一次点击）
    state.bId = branches.find((b) => b.id !== state.aId)?.id || '';

    const root = document.createElement('div');
    root.className = 'chatfilesys-merge';

    /** 名字（列表里用 `#N 名字` 的既有口径，见 ui/common.js#nodeLabel 的同一考虑） */
    const labelOf = (b, i) => `#${i + 1}${b.name ? ` ${b.name}` : ''}${b.is_default ? '（主分支）' : ''}`;

    function recompute() {
        if (!state.aId || !state.bId || state.aId === state.bId) {
            state.plan = null;
            return;
        }
        state.plan = planMerge(model, {
            aId: state.aId, bId: state.bId, choices: state.choices, charsOf,
        });
    }

    function render() {
        recompute();
        const p = state.plan;
        const aIdx = branches.findIndex((b) => b.id === state.aId);
        const bIdx = branches.findIndex((b) => b.id === state.bId);

        const optsHtml = branches.map((b, i) => `<option value="${esc(b.id)}">${esc(labelOf(b, i))}</option>`).join('');

        let planHtml;
        if (!p) {
            planHtml = '<div class="chatfilesys-note">选两条分支，看它们能合成什么。</div>';
        } else if (!p.ok) {
            planHtml = `<div class="chatfilesys-note">${esc(p.reason || '无法合并')}</div>`;
        } else {
            const rows = p.steps.map((s) => {
                const side = s.side === 'shared' ? '共享' : s.side === 'a' ? '取目标' : '取另一条';
                const g = s.side === 'shared' ? 'chatfilesys-side-shared'
                    : s.side === 'a' ? 'chatfilesys-side-a' : 'chatfilesys-side-b';
                return `<span class="chatfilesys-merge-step ${g}" title="第 ${s.floor} 层">#${s.floor} ${esc(side)}</span>`;
            }).join('');
            const conflicts = p.conflicts.map((c) => `
                <div class="chatfilesys-merge-conflict" data-floor="${c.floor}">
                    <span class="hdr">第 ${c.floor} 层 · 两边内容不同</span>
                    <span class="side">
                        <label><input type="radio" name="cf${c.floor}" value="a" data-act="pick"
                            data-floor="${c.floor}" ${c.picked === 'a' ? 'checked' : ''}> 用目标（${c.aChars} 字）</label>
                        <label><input type="radio" name="cf${c.floor}" value="b" data-act="pick"
                            data-floor="${c.floor}" ${c.picked === 'b' ? 'checked' : ''}> 用另一条（${c.bChars} 字）</label>
                        <button class="menu_button" data-act="peek" data-floor="${c.floor}"
                            data-gid="${esc(c.aGid)}" data-side="a">看目标</button>
                        <button class="menu_button" data-act="peek" data-floor="${c.floor}"
                            data-gid="${esc(c.bGid)}" data-side="b">看另一条</button>
                    </span>
                </div>`).join('');
            planHtml = `
                <div class="chatfilesys-merge-summary">${esc(describeMerge(p))}</div>
                <div class="chatfilesys-merge-steps">${rows}</div>
                ${conflicts ? `<div class="chatfilesys-merge-conflicts"><h5>冲突（${p.conflicts.length} 处）</h5>${conflicts}</div>` : ''}`;
        }

        root.innerHTML = `
            <div class="chatfilesys-merge-pick">
                <label>目标分支
                    <select class="text_pole" data-role="a">${optsHtml}</select>
                </label>
                <label>并入
                    <select class="text_pole" data-role="b">${optsHtml}</select>
                </label>
                <label>结果名
                    <input type="text" class="text_pole" data-role="name"
                        value="${esc(defaultName())}" title="新分支的名字（可改）">
                </label>
            </div>
            <div class="chatfilesys-note">合并不改动原分支：结果是一条**新分支**，不满意删掉它即可。</div>
            ${planHtml}
            ${state.error ? `<div class="chatfilesys-error">${esc(state.error)}</div>` : ''}
            <div class="chatfilesys-btnrow">
                <button class="menu_button" data-act="apply" ${!p?.ok || state.busy ? 'disabled' : ''}>
                    <i class="fa-solid fa-code-merge"></i> ${state.busy ? '正在合并…' : '合并'}
                </button>
            </div>`;

        root.querySelector('[data-role="a"]').value = state.aId;
        root.querySelector('[data-role="b"]').value = state.bId;
    }

    function defaultName() {
        const a = branches.find((x) => x.id === state.aId);
        const b = branches.find((x) => x.id === state.bId);
        const short = (x) => {
            const n = String(x?.name || '').trim();
            return n.length > 8 ? `${n.slice(0, 8)}…` : (n || '?');
        };
        return `合并·${short(a)}+${short(b)}`;
    }

    root.addEventListener('change', (e) => {
        const el = e.target;
        if (el.dataset?.role === 'a' || el.dataset?.role === 'b') {
            state[el.dataset.role === 'a' ? 'aId' : 'bId'] = el.value;
            state.choices = {};         // 换了分支，旧的逐层选择不再适用
            state.error = '';
            render();
            return;
        }
        if (el.dataset?.act === 'pick') {
            state.choices[Number(el.dataset.floor)] = el.value;
            // 只更新那一行的高亮与摘要，不整表重绘（重绘会让用户正在点的单选失焦）
            const row = root.querySelector(`.chatfilesys-merge-conflict[data-floor="${el.dataset.floor}"]`);
            row?.classList.remove('picked-a', 'picked-b');
            row?.classList.add(el.value === 'a' ? 'picked-a' : 'picked-b');
            recompute();
        }
    });

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'peek') {
            opts.onPeek?.({ floor: Number(btn.dataset.floor), gid: btn.dataset.gid, side: btn.dataset.side });
            return;
        }
        if (btn.dataset.act === 'apply') {
            const plan = state.plan;
            if (!plan?.ok) return;
            const name = root.querySelector('[data-role="name"]')?.value?.trim() || defaultName();
            state.busy = true;
            state.error = '';
            render();
            Promise.resolve(opts.onApply?.({ plan, name, aId: state.aId, bId: state.bId }))
                .then(() => { state.busy = false; popup.complete(POPUP_RESULT.AFFIRMATIVE); })
                .catch((err) => {
                    // 落盘失败留在弹窗里（关掉就把错误也关掉了，用户只看到「没反应」）
                    state.busy = false;
                    state.error = `合并失败：${err?.message || err}`;
                    render();
                });
        }
    });

    const popup = new Popup(root, POPUP_TYPE.DISPLAY, '', { wide: true, large: true });
    render();
    popup.show();
    const dialog = root.closest('dialog');
    dialog?.addEventListener('close', () => {
        if (dialog.open) return;   // 被宿主拦下的关闭不能拆节点
        dialog.remove();
    });
    return popup;
}
