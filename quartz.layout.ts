import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {
      // 外部链接（记得加双引号）
      "GitHub": "https://github.com/XqiLiu",
      // 内部链接（直接写路径，对应 content/resume.md）
      "简历": "/Resume", 
    },
  }),
}
// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer(),
  ],
  afterBody: [
    Component.ConditionalRender({
      // 1. 设置组件：显示最近的 10 篇文章，标题叫“最近更新”
      component: Component.RecentNotes({ 
        title: "📅 最近更新", 
        limit: 10,
        showTags: true,     // 显示标签
        filter: (f) => !f.slug!.startsWith("tags/") // 过滤掉 tag 页面，只显示笔记
      }),
      // 2. 设置条件：只有当页面 slug 是 "index" 时才显示
      // 这样你的普通文章页底部就不会出现这个列表了
      condition: (page) => page.fileData.slug === "index"
    }),
  ],
  right: [
    Component.Graph(),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
}

// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [],
}
