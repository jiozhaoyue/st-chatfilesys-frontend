/**
 * file:// 降级提示（经典脚本，非 module）——双击打开 dist-web/index.html 时：
 * 模块脚本在 file:// 下必然被 CORS 拒 ⇒ 没有它就只剩白屏。本脚本给一句「该怎么办」。
 * HTTP(S) 形态下立即返回、一个字节都不动（否则就成了第二份 UI）。
 * 实测与边界登记参照 ST-pack-transfer e2e/standalone/specs/file-protocol.e2e.cjs。
 */
(function () {
    if (location.protocol !== 'file:') return;
    document.addEventListener('DOMContentLoaded', function () {
        var el = document.createElement('div');
        el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#141417;color:#ff9d9d;'
            + 'padding:48px 32px;font:14px/1.8 system-ui,"Microsoft YaHei",sans-serif;white-space:pre-wrap;';
        el.textContent = 'ChatFilesys · 工作台不能以 file:// 双击方式运行\n\n'
            + '浏览器会以 CORS 拒绝 file:// 页面加载 ES 模块，所以你只看到空白页——这是浏览器的安全边界，不是坏了。\n\n'
            + '两个办法（任选其一）：\n'
            + '  1. 本地静态服务：在本仓根目录运行\n'
            + '       npx --yes http-server . -p 3050 -a 127.0.0.1 -s --cors -c-1\n'
            + '     然后打开  http://127.0.0.1:3050/web/index.html\n'
            + '  2. 使用构建产物（dist-web/）：同样需要静态服务指向 dist-web 目录。\n\n'
            + '数据说明：web 工作台默认把家族存进浏览器 IndexedDB（本机缓存档）；'
            + '「导出当前分支」得到的标准 JSONL 是可带走的持久物。';
        document.body.textContent = '';
        document.body.appendChild(el);
    });
})();
