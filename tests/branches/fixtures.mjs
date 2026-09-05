/**
 * 测试夹具：复刻演示（demo/branches-core.js）的种子剧情
 * 主分支 5 层（第 2 层带 2 个 swipe 变体）
 * + 分支「支线·塔顶」(fork@4，私有楼层 5/6)
 * + 分支「好奇线」(fork@2，未续聊)
 */
import { enableForChat, createBranch } from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';

export const T = 1771009329448;

export const line = (name, is_user, mes, extra = {}) => ({ name, is_user, mes, send_date: T, extra });

/** 主分支 5 行 body（含一条原生多 swipe 行） */
export function seedBody() {
    return [
        line('我', true, '我们出发吧，森林的北边有个废弃的哨塔。'),
        {
            ...line('Seraphina', false, '夜色像湿苔一样贴上来。你确定要今晚走？'),
            swipes: ['夜色像湿苔一样贴上来。你确定要今晚走？', '你握紧剑柄，摇了摇头：白天更安全。'],
            swipe_info: [{ send_date: T, extra: {} }, { send_date: T + 1000, extra: { note: '变体二' } }],
            swipe_id: 0,
        },
        line('我', true, '火把给我，你在前面探路。'),
        line('Seraphina', false, '『哨塔的石门虚掩着，门缝里渗出淡蓝色的光。』'),
        line('Seraphina', false, '『塔顶传来风铃般的声响——那里有东西在等我们。』'),
    ];
}

/**
 * 种子模型：
 * - main(b_main)：1..5 层（组 g1..g5，全部在 body）
 * - b1「支线·塔顶」：fork@4，私有组 g6@5、g7@6（折叠在 groups）
 * - b2「好奇线」：fork@2，未续聊
 */
export function seedModel(body = seedBody()) {
    const m = enableForChat(body);
    const b1 = createBranch(m, { name: '支线·塔顶', forkFloor: 4, activate: false });
    m.groups['g6'] = {
        id: 'g6', floor: 5, owner: b1.id, active: 0,
        variants: [line('Seraphina', false, '『你们攀上旋梯。塔顶的风铃是一个古老的警报器——它醒了。』')],
    };
    b1.path[5] = 'g6';
    m.groups['g7'] = {
        id: 'g7', floor: 6, owner: b1.id, active: 0,
        variants: [line('我', true, '拔剑。先下手为强。')],
    };
    b1.path[6] = 'g7';
    createBranch(m, { name: '好奇线', forkFloor: 2, activate: false });
    return m;
}
