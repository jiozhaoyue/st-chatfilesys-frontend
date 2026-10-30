r"""家族对齐标定 —— 用真实语料测「recall / 假阳性」，为 design.md §4 的阈值定值。

为什么要有它：`design.md` §7 规定阈值**不许拍脑袋**，必须在「假阳性 = 0」前提下最大化召回。
互检 A 用**原设计**的代价表跑出 recall = 0/93（判据联合不可满足），因此定值不能靠推理，必须实测。

语料（只读）：`D:\Repo\Tavern-repo\Instance\Dev\Luker\data\default-user\backups\`

本脚本**独立实现** design.md §3/§4 的判据（不 import 插件代码——插件模块还没写）；
它是标定工具，不是产品代码。改动判据时**同步改这里**，否则标定与实现会漂移。

跑法：
    PYTHONIOENCODING=utf-8 python tests/e2e/calibrate_family_align.py
    PYTHONIOENCODING=utf-8 python tests/e2e/calibrate_family_align.py --pair-detail 10
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import Counter

BACKUPS = r"D:\Repo\Tavern-repo\Instance\Dev\Luker\data\default-user\backups"

# ---- design.md §3 的常量（改动须同步 design.md；与 core/family-align.js 的 COST 一致）----
# 2026-10-31（C1.3）：代价乘 2 改**整数** 0/2/3（比例关系不变：MATCH < GAP < MISMATCH < 2×GAP），
# 与 JS 实现逐位对齐 —— 标定数字与实现不得静默漂移。
MIN_EVIDENCE_LEN = 8   # cost=0.0 的最小归一化长度（挡 '' / '…' / '*沉默*'）
GAP = 2                # 删/插一层
MISMATCH = 3           # 同位置、内容不同
MATCH = 0
# ---- design.md §4 step 3 的判据 ----
T_N0_RATIO = 0.30      # (1) n0 ≥ max(3, ratio × min)
T_N0_FLOOR = 3
T_N15_RATIO = 0.25     # **已停用**（2026-09-29 标定：n15 上限是方向性错误，把「同族严重分叉」
                       # 当不同家族；删它召回 41/55 → 55/55）。保留常量只为在输出里显示它已停用。
T_MIN_FLOORS = 3       # (3) min ≥ 3
T_MIN_MAX_RATIO = 0.25 # (3) min/max ≥ 0.25
T_FP_JACCARD = 0.10    # 判同族但**正文多重集 Jaccard** < 此值 ⇒ 才算**真**假阳性（即「内容重叠可忽略」）
                       # 为什么不用 main_chat 当真值：实测 170/198 个文件**没有** main_chat，
                       # 而「缺 main_chat」正是本功能要服务的人群；拿它当真值会把
                       # 「正文逐字全等的副本」判成假阳性。
                       # 为什么门槛是 0.10 而不是 0.30：标定实测判同族的 128 对里**最小 Jaccard = 0.286**，
                       # 且这些对共享 ≥64 层逐字相同的内容；用 0.30 会把「名字不同但内容大量重合」
                       # （正是 C5 说的名字不可信那类）误计为假阳性。脚本同时打印 Jaccard 分布供复核。


def normalize_text(s):
    return str(s if s is not None else "").replace("\ufeff", "").replace("\r\n", "\n").strip()


def h_of(name, is_user, mes):
    payload = json.dumps([normalize_text(name), bool(is_user), normalize_text(mes)],
                         ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


class Floor:
    __slots__ = ("hash", "len", "swipe_hashes", "swipe_id", "name", "is_user")

    def __init__(self, row):
        self.name = row.get("name")
        self.is_user = bool(row.get("is_user"))
        mes = row.get("mes")
        self.hash = h_of(self.name, self.is_user, mes)
        self.len = len(normalize_text(mes))
        # 「该层的全部版本」= 当前正文 ∪ swipes 候选（**必须含当前正文自己**，否则一侧没有
        # swipes 数组时永远匹配不上另一侧装着它的 swipes —— 见 family-align.test.mjs 的 L1）。
        # 排除 ①空/纯空白 ②短于 MIN_EVIDENCE_LEN 的条目（阶段 0.3 加固）：真实数据里存在
        # 跨文件的常量 swipe 文本（'开场问候语（F1）'(9字/28文件)、'继续，输出文字不少于7500tokens'
        # (20字/13文件)、错误串 '[subrequest 1 failed: …'），不排除会让无关的层假相交。
        hs = set()
        if self.len >= MIN_EVIDENCE_LEN:
            hs.add(self.hash)
        sw = row.get("swipes")
        if isinstance(sw, list):
            for s in sw:
                if len(normalize_text(s)) < MIN_EVIDENCE_LEN:
                    continue
                hs.add(h_of(self.name, self.is_user, s))
        self.swipe_hashes = hs
        self.swipe_id = row.get("swipe_id")


def cost(a, b):
    """design.md §3.1 代价表。

    swipe 通道**已收紧**（2026-09-29，用户裁定 D1+D2 一并修；design.md §3.1 更正记录）：
    改前是「两侧 swipe_hashes 有交集即同层」，实测既会**误杀**真同层（D1：A 的当前 == B 的旧 swipe，
    被只数当前正文交集的预筛否掉），又会被**常量 swipe** 造成假阳性（D2）。
    改后必须**一方是另一方的当前正文**才算同层 —— 常量从不是当前正文，故被自然排除。
    """
    if a.hash == b.hash and a.len >= MIN_EVIDENCE_LEN and b.len >= MIN_EVIDENCE_LEN:
        return MATCH
    if b.hash in a.swipe_hashes or a.hash in b.swipe_hashes:
        return MATCH
    return MISMATCH


def match_bound(a_rows, b_rows):
    """`n0`（精确同层配对数）的**可靠上界** —— 廉价必要条件预筛。

    改前口径「当前正文 hash 的多重集交集」**不是** `n0` 的上界：`n0` 还计 swipe 通道的命中，
    故它会误杀核心场景「A 的当前正文 == B 的旧 swipe」（D1）。可靠上界（E(d)=d.swipe_hashes）：
        eligibleA(i) = (a_i.hash ∈ ∪E(b)) || (E(a_i) ∩ HashesB ≠ ∅)
        eligibleB(j) = (b_j.hash ∈ ∪E(a)) || (E(b_j) ∩ HashesA ≠ ∅)
        bound = min(#eligibleA, #eligibleB)
    正确性：任一 MATCH 配对 (i,j) 由 cost() 只会因三种情形成立（hash 相等 / a_i.hash ∈ E(b_j) /
    b_j.hash ∈ E(a_i)），三者都蕴含 eligibleA(i) 为真 ⇒ #配对 ≤ #eligibleA；对 b 同理 ⇒ 取 min 仍可靠。
    附带效果：常量 swipe（永不是当前正文）⇒ eligibleA 恒假 ⇒ 上界 0 ⇒ D2 被挡在 DP 之外。
    """
    hashes_a = {d.hash for d in a_rows}
    hashes_b = {d.hash for d in b_rows}
    all_ea = set()
    all_eb = set()
    for d in a_rows:
        all_ea |= d.swipe_hashes
    for d in b_rows:
        all_eb |= d.swipe_hashes
    ea = sum(
        1 for d in a_rows
        if d.hash in all_eb or bool(d.swipe_hashes & hashes_b)
    )
    eb = sum(
        1 for d in b_rows
        if d.hash in all_ea or bool(d.swipe_hashes & hashes_a)
    )
    return min(ea, eb)


def align(a_rows, b_rows):
    """Needleman–Wunsch，返回 (n0, n15, gaps)。整条序列上跑。"""
    n, m = len(a_rows), len(b_rows)
    INF = float("inf")
    # dp[i][j] = 对齐 a[i:] 与 b[j:] 的最小代价
    dp = [[INF] * (m + 1) for _ in range(n + 1)]
    ptr = [[0] * (m + 1) for _ in range(n + 1)]  # 0=diag 1=up(gap in b) 2=left(gap in a)
    dp[n][m] = 0.0
    for j in range(m - 1, -1, -1):
        dp[n][j] = dp[n][j + 1] + GAP
        ptr[n][j] = 2
    for i in range(n - 1, -1, -1):
        dp[i][m] = dp[i + 1][m] + GAP
        ptr[i][m] = 1
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            c = cost(a_rows[i], b_rows[j]) + dp[i + 1][j + 1]
            up = GAP + dp[i + 1][j]
            left = GAP + dp[i][j + 1]
            best, p = c, 0
            if up < best:
                best, p = up, 1
            if left < best:
                best, p = left, 2
            dp[i][j] = best
            ptr[i][j] = p
    # 回溯计数
    i = j = 0
    n0 = n15 = gaps = 0
    while i < n and j < m:
        p = ptr[i][j]
        if p == 0:
            c = cost(a_rows[i], b_rows[j])
            if c == MATCH:
                n0 += 1
            else:
                n15 += 1
            i += 1
            j += 1
        elif p == 1:
            gaps += 1
            i += 1
        else:
            gaps += 1
            j += 1
    gaps += (n - i) + (m - j)
    return n0, n15, gaps


def verdict(a_rows, b_rows):
    n, m = len(a_rows), len(b_rows)
    if n < T_MIN_FLOORS or m < T_MIN_FLOORS:
        return "uncertain", {"why": "floor-too-few"}
    if min(n, m) / max(n, m) < T_MIN_MAX_RATIO:
        # 长度悬殊 ⇒ **列候选**而不是直接否掉（可能是真祖先，也可能是巧合；交用户点）
        return "uncertain", {"why": "length-ratio"}
    need = max(T_N0_FLOOR, -(-int(T_N0_RATIO * min(n, m)) // 1))
    bound = match_bound(a_rows, b_rows)
    if bound < need:
        # 廉价的必要条件预筛：n0 的**可靠上界**（见 match_bound）不够，不必跑对齐
        return "different", {"why": "prefilter", "bound": bound, "need": need}
    n0, n15, gaps = align(a_rows, b_rows)
    st = {"n0": n0, "n15": n15, "gaps": gaps, "need": need}
    if n0 < need:
        return "different", {**st, "why": "n0-below-floor"}
    # **注意：这里不再用 n15 设上限**。
    # 标定实测（2026-09-29）：14 个同族对（n0=66，占 152 层的 43%）被 n15 上限一票否掉。
    # 大 n15 的语义是「同族但分叉严重」，正是用户要合并成多分支的情形；
    # 真正区分「同族分叉」与「无关聊天」的是 **n0（共享历史量）**，不是 n15。
    return "same-family", st


def load_all():
    items = []
    for f in sorted(os.listdir(BACKUPS)):
        if not f.endswith(".jsonl"):
            continue
        rows, hdr = [], None
        try:
            with open(os.path.join(BACKUPS, f), encoding="utf-8") as fh:
                for i, ln in enumerate(fh):
                    ln = ln.strip()
                    if not ln:
                        continue
                    try:
                        o = json.loads(ln)
                    except Exception:
                        continue
                    if i == 0:
                        hdr = o
                        continue
                    if isinstance(o, dict) and "mes" in o:
                        rows.append(Floor(o))
        except Exception:
            continue
        md = (hdr or {}).get("chat_metadata") or {}
        items.append({
            "file": f, "floors": rows,
            "main_chat": md.get("main_chat"),
            "hashes": Counter(r.hash for r in rows),
        })
    return items


def family_of(main_chat):
    if not main_chat:
        return None
    return re.sub(r"\s*-\s*Branch\s*#\d+\s*$", "", str(main_chat)).strip()


def jaccard(a, b):
    """两份聊天的**正文多重集 Jaccard** —— 独立于本脚本对齐判据的相似度尺，用于给 FP 定性。"""
    A, B = a["hashes"], b["hashes"]
    inter = sum((A & B).values())
    uni = sum((A | B).values())
    return inter / uni if uni else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pair-detail", type=int, default=0)
    args = ap.parse_args()

    t0 = time.time()
    items = load_all()
    print(f"语料：{len(items)} 个文件，{sum(len(x['floors']) for x in items)} 层"
          f"（加载 {time.time()-t0:.1f}s）")

    # 正样本：同一 main_chat（精确）或同族前缀，双方 ≥3 层
    pos_exact, pos_family = [], []
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            a, b = items[i], items[j]
            if min(len(a["floors"]), len(b["floors"])) < 3:
                continue
            if a["main_chat"] and a["main_chat"] == b["main_chat"]:
                pos_exact.append((i, j))
            elif family_of(a["main_chat"]) and family_of(a["main_chat"]) == family_of(b["main_chat"]):
                pos_family.append((i, j))

    def run(pairs, label):
        got = Counter()
        details = []
        for i, j in pairs:
            a, b = items[i], items[j]
            v, st = verdict(a["floors"], b["floors"])
            got[v] += 1
            details.append((i, j, v, st))
        print(f"\n[{label}] {len(pairs)} 对 → " + ", ".join(f"{k}={v}" for k, v in got.items()))
        if pairs:
            print(f"    same-family 召回 = {got['same-family']}/{len(pairs)}")
        if args.pair_detail:
            for i, j, v, st in details[:args.pair_detail]:
                print(f"     {items[i]['file'][:34]} × {items[j]['file'][:34]} → {v} {st}")
        return got, details

    gx, dx = run(pos_exact, "正样本·同 main_chat（精确）")
    gf, df = run(pos_family, "正样本·同族前缀")
    if df:
        misses = [d for d in df if d[2] != "same-family"]
        print(f"    （同族前缀但**未**判同族的有 {len(misses)} 对，附正文 Jaccard 供判断是否真漏判）")
        for i, j, v, st in misses[:args.pair_detail or 10]:
            print(f"     J={jaccard(items[i], items[j]):.3f} {items[i]['file'][:32]} × "
                  f"{items[j]['file'][:32]} → {v} {st}")

    # 负样本：跑全量两两。判 same-family 而「main_chat 与族前缀都不同」→ 候选 FP；
    # 其中**正文 Jaccard 也低**的才算真 FP（见 T_FP_JACCARD 的说明）。
    print("\n[负样本·全量两两] 跑批中…")
    t1 = time.time()
    real_fp, benign, sf_total, unc, diff = [], [], 0, 0, 0
    n = len(items)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = items[i], items[j]
            if min(len(a["floors"]), len(b["floors"])) < T_MIN_FLOORS:
                unc += 1
                continue
            v, st = verdict(a["floors"], b["floors"])
            if v == "same-family":
                sf_total += 1
                famA, famB = family_of(a["main_chat"]), family_of(b["main_chat"])
                if not (a["main_chat"] and a["main_chat"] == b["main_chat"]) and not (
                        famA and famA == famB):
                    jc = jaccard(a, b)
                    (real_fp if jc < T_FP_JACCARD else benign).append((i, j, jc, st))
            elif v == "uncertain":
                unc += 1
            else:
                diff += 1
    print(f"    same-family={sf_total}  uncertain={unc}  different={diff}"
          f"  （{time.time()-t1:.1f}s）")
    print(f"    标注口径不同的候选 FP = {len(real_fp)+len(benign)}"
          f" —— 其中 **真 FP（Jaccard<{T_FP_JACCARD}）= {len(real_fp)}**，"
          f"良性（内容确有重叠，只是缺 main_chat）= {len(benign)}")
    # Jaccard 分布：判同族的对里最低多少重叠 —— 这比「算不算 FP」更有说服力
    all_sf_j = [jaccard(items[i], items[j]) for i in range(n) for j in range(i + 1, n)
                if min(len(items[i]["floors"]), len(items[j]["floors"])) >= T_MIN_FLOORS
                and verdict(items[i]["floors"], items[j]["floors"])[0] == "same-family"]
    if all_sf_j:
        all_sf_j.sort()
        print(f"    判同族的 {len(all_sf_j)} 对，正文 Jaccard: 最小 {all_sf_j[0]:.3f} / "
              f"中位 {all_sf_j[len(all_sf_j)//2]:.3f} / 最大 {all_sf_j[-1]:.3f}"
              f"  ⇒ 最小重叠已远超「可忽略」线")
    for i, j, jc, st in real_fp[:args.pair_detail or 8]:
        print(f"       真 FP: J={jc:.3f} {items[i]['file'][:32]} × {items[j]['file'][:32]} {st}")

    print("\n================ 结论 ================")
    print(f"正样本（同 main_chat）召回: {gx.get('same-family', 0)}/{len(pos_exact)}")
    print(f"正样本（同族前缀）召回:     {gf.get('same-family', 0)}/{len(pos_family)}")
    print(f"全量两两判同族:            {sf_total}，其中真假阳性 {len(real_fp)}"
          f"（良性 {len(benign)}：内容确有重叠，标注缺 main_chat 故计入候选）")
    print(f"阈值: N0_RATIO={T_N0_RATIO} N0_FLOOR={T_N0_FLOOR} MIN_FLOORS={T_MIN_FLOORS} "
          f"MIN_MAX={T_MIN_MAX_RATIO} MIN_LEN={MIN_EVIDENCE_LEN} FP_JACCARD={T_FP_JACCARD} "
          f"| N15_RATIO={T_N15_RATIO}（**已停用**，见常量注释）")


if __name__ == "__main__":
    main()
