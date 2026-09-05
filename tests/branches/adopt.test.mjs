import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptNativeCopy, validate, getBranch } from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';
import { seedModel, seedBody } from './fixtures.mjs';

test('收编：复制文件=前缀截断 → 建共享引用分支，零复制', () => {
    const body = seedBody();
    const m = seedModel(body);
    const copiedLines = structuredClone(body).slice(0, 3);

    const r = adoptNativeCopy(m, { name: '收编·F3后', copiedLines, body });
    assert.equal(r.ok, true);

    const b = getBranch(m, r.branch.id);
    assert.equal(b.fork_base, 3);
    assert.deepEqual(Object.values(b.path).slice(0, 3), ['g1', 'g2', 'g3']);
    assert.equal(Object.keys(b.path).length, 3);
    assert.equal(m.active_branch, 'b_main', '收编不应切换分支');
    assert.equal(validate(m, body.length).ok, true);
});

test('收编：复制文件被用户改动过 → 严格拒绝并给出首个差异位', () => {
    const body = seedBody();
    const m = seedModel(body);
    const copiedLines = structuredClone(body).slice(0, 3);
    copiedLines[1].mes = '被用户改过的文本';

    const r = adoptNativeCopy(m, { name: 'x', copiedLines, body });
    assert.equal(r.ok, false);
    assert.equal(r.firstDiff, 1);
});

test('收编：复制文件行数超过当前分支 → 拒绝', () => {
    const body = seedBody();
    const m = seedModel(body);
    const r = adoptNativeCopy(m, { name: 'x', copiedLines: structuredClone(body).concat([{}]), body });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('超过'));
});
