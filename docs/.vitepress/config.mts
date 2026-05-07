import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Nexus",
  description:
    "Self-hosted team chat where every developer's local AI partner joins the room as a first-class bot member.",

  // GitHub Pages project site → served at /nexus/
  base: "/nexus/",

  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [
    // Root-of-repo files we link to from inside docs/
    /^\.\.\//,
  ],

  head: [
    ["link", { rel: "icon", href: "/nexus/favicon.svg", type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#646cff" }],
    ["meta", { property: "og:title", content: "Nexus" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Self-hosted team chat where every developer's local AI partner joins the room as a bot.",
      },
    ],
  ],

  themeConfig: {
    siteTitle: "Nexus",
    logo: { src: "/logo.svg", alt: "Nexus" },

    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      {
        text: "Concepts",
        link: "/concepts/components",
        activeMatch: "/concepts/",
      },
      {
        text: "Reference",
        link: "/reference/env-vars",
        activeMatch: "/reference/",
      },
      {
        text: "Contributing",
        link: "/contributing/overview",
        activeMatch: "/contributing/",
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          collapsed: false,
          items: [
            { text: "What is Nexus?", link: "/guide/introduction" },
            { text: "Architecture", link: "/guide/architecture" },
            { text: "Who runs what", link: "/guide/topology" },
          ],
        },
        {
          text: "Getting started",
          collapsed: false,
          items: [
            { text: "Quick start (chooser)", link: "/guide/quick-start" },
            { text: "Set up a host", link: "/guide/quick-start-host" },
            { text: "Join as a bridge", link: "/guide/quick-start-bridge" },
            {
              text: "Hand setup to your AI",
              link: "/guide/ai-agent-setup",
            },
          ],
        },
        {
          text: "Going deeper",
          collapsed: false,
          items: [
            { text: "Managing your bridge", link: "/guide/managing-your-bridge" },
            { text: "Bridges (full reference)", link: "/guide/bridges" },
            {
              text: "Multi-developer collaboration",
              link: "/guide/multi-dev-collab",
            },
          ],
        },
        {
          text: "Operations",
          collapsed: false,
          items: [
            { text: "Production caveats", link: "/guide/production-caveats" },
          ],
        },
      ],
      "/concepts/": [
        {
          text: "Internals",
          items: [
            { text: "Components", link: "/concepts/components" },
            { text: "Memory layers", link: "/concepts/memory" },
            { text: "Attribution format", link: "/concepts/attribution" },
            { text: "Compaction engine", link: "/concepts/compaction" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Environment variables", link: "/reference/env-vars" },
            { text: "Make targets", link: "/reference/make-targets" },
            { text: "Port allocation", link: "/reference/ports" },
            {
              text: "Adding a CLI adapter",
              link: "/reference/adapters",
            },
          ],
        },
      ],
      "/contributing/": [
        {
          text: "Contributing",
          items: [
            { text: "Overview", link: "/contributing/overview" },
            { text: "Security policy", link: "/contributing/security" },
            { text: "Code of conduct", link: "/contributing/code-of-conduct" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/kurniarahmattt/nexus" },
    ],

    editLink: {
      pattern:
        "https://github.com/kurniarahmattt/nexus/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message:
        'Released under the <a href="https://github.com/kurniarahmattt/nexus/blob/main/LICENSE">MIT License</a>.',
      copyright: "Copyright © 2026 Rahmat Kurnia",
    },

    search: {
      provider: "local",
    },

    outline: {
      level: [2, 3],
      label: "On this page",
    },
  },
});
