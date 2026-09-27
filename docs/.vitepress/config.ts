import { defineConfig } from 'vitepress'

/**
 * ChatFilesys 文档站配置（VitePress）。
 *
 * 两个易错点，改之前先看清：
 *  1. **`base` 必须是项目站点的子路径**（本站部署在
 *     `https://<user>.github.io/st-chatfilesys-frontend/`）。不设或设错 → 站上 CSS/JS 全部 404，
 *     本地 `dev` 却看不出问题（本地 base 是 `/`）。
 *  2. **单一语言（中文），但结构预留 i18n**：将来加语种时只在本文件扩充
 *     `locales` 与各 group 的 `label`，页面路径与内容组织不用改。
 */
export default defineConfig({
    title: 'ChatFilesys',
    description: 'SillyTavern / Luker 聊天文件系统扩展 · 文档',
    lang: 'zh-CN',
    base: '/st-chatfilesys-frontend/',
    cleanUrls: true,
    lastUpdated: true,

    themeConfig: {
        nav: [
            { text: '指南', link: '/guide/' },
            { text: '开发', link: '/dev/' },
        ],

        // 路径前缀 → 侧边栏。VitePress 取最长前缀匹配：
        // `/guide/xxx` 命中 `/guide/` 那组，不会被 `/` 那组抢走。
        sidebar: {
            '/guide/': [
                {
                    text: '指南',
                    items: [{ text: '总览', link: '/guide/' }],
                },
            ],
            '/dev/': [
                {
                    text: '开发',
                    items: [{ text: '总览', link: '/dev/' }],
                },
            ],
            '/': [
                {
                    text: '其他文档',
                    items: [
                        { text: '纯数据库模式说明（人话版）', link: '/pure-db-mode-explained' },
                        { text: '多聊天 / PR 存储接缝建议书', link: '/multi-chat-pr-storage-seam-proposal' },
                        { text: 'Timelines 迁移计划', link: '/timelines-migration-plan' },
                        { text: 'Timelines 迁移 PRD', link: '/timelines-migration-prd' },
                    ],
                },
            ],
        },

        outline: { label: '本页目录', level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
        // 本地搜索：构建期生成索引，**不依赖任何外部服务**（与本仓「零外部依赖」一致）
        search: { provider: 'local' },
        socialLinks: [{ icon: 'github', link: 'https://github.com/jiozhaoyue/st-chatfilesys-frontend' }],
        footer: {
            message: 'AGPL-3.0',
            copyright: '与 SillyTavern 上游一致',
        },
    },
})