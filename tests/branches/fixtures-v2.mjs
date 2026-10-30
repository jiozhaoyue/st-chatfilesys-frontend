/**
 * v2 家族模型夹具（family-operation-v2.md §2 的唯一 Family 结构）
 *
 * 与 fixtures.mjs（旧 floorNo/group 模型）**互不替代**：旧夹具喂旧模块的回归，
 * 本夹具喂 family-state / family-codec / family-plan 的 v2 契约测试。
 *
 * 构造纪律（逐条有出处）：
 * · 身份 ≠ 位置 —— m1 在 A/B 各占第 1 层，但 m_b5 只属 B；同正文的两条消息用**不同 messageId**
 *   （spec §2 规则 2：原消息重复出现时分配不同 messageId，不按文本合一）。
 * · version.raw = 该版本**自己的**原生行内容（含未知字段，原样保留）；
 *   swipeInfo = 对应 swipe_info[i] 对象（spec §2 Version 定义）。
 * · rawRows = 各分支 entry 的**原生整行**（dirty=false 投影直接克隆它，spec §2 规则 3）。
 * · 分支 header 各带**未知字段**（unknown_*）—— 往返不得丢（spec §2 规则 5）。
 */

const D1 = '2026-01-01T00:00:00.000Z';
const D2 = '2026-01-01T00:01:00.000Z';
const D3 = '2026-01-01T00:02:00.000Z';

/** 一条裸消息行（未知字段随手带一个，验证往返保真） */
const row = (name, is_user, mes, extra = {}) => ({
    name, is_user, mes, send_date: D1, unknown_keep: 'x', ...extra,
});

/** v2 Entry（非公共构造器 —— 夹具专用；合法构造器在 core/family-state.js） */
const entry = (messageId, visibleVersionIds, selectedVersionId, rawRowRef) => ({
    messageId, visibleVersionIds, selectedVersionId, rawRowRef, dirty: false,
});

/**
 * 双分支家族：A/B 共享 m1（两个版本 v1/v2），A 选 v1、B 选 v2；
 * 各有私有尾楼（A→m2、B→m_b5）。默认分支 A，键绑定 A/B 各一条。
 */
export function twoBranches() {
    const v1raw = row('Seraphina', false, '夜色像湿苔一样贴上来。你确定要今晚走？', { send_date: D1 });
    const v2raw = row('Seraphina', false, '你握紧剑柄，摇了摇头：白天更安全。', { send_date: D2, extra: { note: '变体二' } });
    const m2raw = row('我', true, '火把给我，你在前面探路。', { send_date: D2 });
    const mb5raw = row('Seraphina', false, '『哨塔的石门虚掩着，门缝里渗出淡蓝色的光。』', { send_date: D3 });

    return {
        schemaVersion: 2,
        libraryId: 'lib-test',
        familyId: 'fam-two',
        revision: 'rev-1',
        activeBranchId: 'A',
        characterId: 'Seraphina',
        branches: {
            A: {
                name: '主分支', isDefault: true,
                header: { user_name: 'User', character_name: 'Seraphina', unknown_a_field: { keep: 1 } },
                entries: [
                    entry('m1', ['v1', 'v2'], 'v1', 'rw-a1'),
                    entry('m2', ['v3'], 'v3', 'rw-a2'),
                ],
                extensions: {},
            },
            B: {
                name: '导入分支', isDefault: false,
                header: { user_name: 'User', character_name: 'Seraphina', unknown_b_field: '保留我' },
                entries: [
                    entry('m1', ['v1', 'v2'], 'v2', 'rw-b1'),
                    entry('m_b5', ['v5'], 'v5', 'rw-b5'),
                ],
                extensions: {},
            },
        },
        messages: {
            m1: {
                versions: {
                    v1: { raw: v1raw, swipeInfo: { send_date: D1, extra: {} }, sourceRefs: ['src:file-a.jsonl'] },
                    v2: { raw: v2raw, swipeInfo: { send_date: D2, extra: { note: '变体二' } }, sourceRefs: ['src:file-b.jsonl'] },
                },
            },
            m2: { versions: { v3: { raw: m2raw, swipeInfo: { send_date: D2 }, sourceRefs: ['src:file-a.jsonl'] } } },
            m_b5: { versions: { v5: { raw: mb5raw, swipeInfo: { send_date: D3 }, sourceRefs: ['src:file-b.jsonl'] } } },
        },
        rawRows: {
            // A 的 m1 原生行：完整三件套，swipe_id 指 v1（A 的选择）
            'rw-a1': { ...v1raw, swipes: [v1raw.mes, v2raw.mes], swipe_info: [{ send_date: D1, extra: {} }, v2raw], swipe_id: 0 },
            // B 的 m1 原生行：同三件套，swipe_id 指 v2（B 的选择）
            'rw-b1': { ...v2raw, swipes: [v1raw.mes, v2raw.mes], swipe_info: [{ send_date: D1, extra: {} }, v2raw], swipe_id: 1 },
            'rw-a2': m2raw,
            'rw-b5': mb5raw,
        },
        relations: [
            { id: 'rel-1', fromBranchId: 'B', toBranchId: 'A', kind: 'derived', evidenceRefs: ['align:op-1'] },
        ],
        keyBindings: {
            chat_a: { branchId: 'A', isCheckpoint: false, markerMessageId: null },
            chat_b: { branchId: 'B', isCheckpoint: true, markerMessageId: 'm_b5' },
        },
        extensions: {},
    };
}

/**
 * 三分支错位家族：共享首楼 m1 与末楼 m4，中段各持**位置相同、内容不同**的私有楼
 * （A→m_a2 / B→m_b2 / C→m_c2）。用于「同层私有组」与多分支选择独立性的测试。
 * 注意 C 对 m1 选的是 v2（三分支各选可以不同）。
 */
export function shiftedThreeBranches() {
    const base = twoBranches();
    const dRow = (mes) => row('Seraphina', false, mes, { send_date: D2 });
    const priv = (mid, mes) => ({
        [mid]: { versions: { [`v_${mid}`]: { raw: dRow(mes), swipeInfo: { send_date: D2 }, sourceRefs: ['src:x'] } } },
    });

    const messages = {
        m1: base.messages.m1,
        ...priv('m_a2', 'A 线私有：走北边的哨塔。'),
        ...priv('m_b2', 'B 线私有：先去村子里打听。'),
        ...priv('m_c2', 'C 线私有：原地扎营等天亮。'),
        m4: { versions: { v4: { raw: row('我', true, '决定了吗。', { send_date: D3 }), swipeInfo: { send_date: D3 }, sourceRefs: ['src:a'] } } },
    };

    const mk = (branchId, privMid, selected, extraHeader) => ({
        name: branchId,
        isDefault: branchId === 'A',
        header: { user_name: 'User', character_name: 'Seraphina', ...extraHeader },
        entries: [
            entry('m1', ['v1', 'v2'], selected, `rw-${branchId}1`),
            entry(privMid, [`v_${privMid}`], `v_${privMid}`, `rw-${branchId}2`),
            entry('m4', ['v4'], 'v4', `rw-${branchId}4`),
        ],
        extensions: {},
    });

    return {
        schemaVersion: 2,
        libraryId: 'lib-test',
        familyId: 'fam-shift',
        revision: 'rev-1',
        activeBranchId: 'A',
        characterId: 'Seraphina',
        branches: {
            A: mk('A', 'm_a2', 'v1', { unknown_a: 1 }),
            B: mk('B', 'm_b2', 'v2', {}),
            C: mk('C', 'm_c2', 'v2', { unknown_c: 'c' }),
        },
        messages,
        rawRows: {
            ...base.rawRows,
            'rw-A2': dRow('A 线私有：走北边的哨塔。'),
            'rw-B2': dRow('B 线私有：先去村子里打听。'),
            'rw-C2': dRow('C 线私有：原地扎营等天亮。'),
            'rw-A4': messages.m4.versions.v4.raw,
            'rw-B4': messages.m4.versions.v4.raw,
            'rw-C4': messages.m4.versions.v4.raw,
            // 三分支各自的 m1 原生行（A 指 v1，B/C 指 v2）
            'rw-A1': base.rawRows['rw-a1'],
            'rw-B1': base.rawRows['rw-b1'],
            'rw-C1': base.rawRows['rw-b1'],
        },
        relations: [],
        keyBindings: {},
        extensions: {},
    };
}
