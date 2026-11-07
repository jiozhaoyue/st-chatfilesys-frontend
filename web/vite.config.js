// web 工作台构建配置（部署产物 = dist-web/，**本任务不部署到公开**，产物只本地验证）。
// dev 形态与 http-server 同号（PO-4：3050 strictPort，L0-16 段位）。
// 注意：**不 import 'vite'**（defineConfig 只是恒等函数）——本仓没有 node_modules，
// 直接导出普通对象才能让构建器从别的仓借用 vite 二进制时加载本配置。
export default {
    base: './',
    build: {
        outDir: '../dist-web',
        emptyOutDir: true,
        // 宿主模块不进本仓构建图：ui/versions.js 运行时才动态导入宿主 popup.js（插件形态专用，
        // web 形态永不执行该支路）。external = 构建时原样保留该 import，不解析不打包。
        rollupOptions: {
            external: [/popup\.js$/],
        },
    },
    server: {
        port: 3050,
        strictPort: true,
    },
    preview: {
        port: 4173, // L0-16 已登记为 Vite preview
        strictPort: true,
    },
    worker: {
        format: 'es',
    },
};
