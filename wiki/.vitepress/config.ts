import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Aigency Router v2',
  description: 'Multi-agent AI skill orchestration hub documentation',
  base: '/',
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Getting Started', link: '/01-getting-started/overview' },
      { text: 'Deep Dive', link: '/02-deep-dive/architecture/' },
      { text: 'Onboarding', link: '/onboarding/contributor' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/01-getting-started/overview' },
          { text: 'Setup', link: '/01-getting-started/setup' },
          { text: 'Quick Reference', link: '/01-getting-started/quick-reference' },
        ]
      },
      {
        text: 'Deep Dive',
        collapsed: false,
        items: [
          { text: 'Architecture', link: '/02-deep-dive/architecture/' },
          { text: 'Skills System', link: '/02-deep-dive/skills-system/' },
          { text: 'Agent Platforms', link: '/02-deep-dive/agent-platforms/' },
          { text: 'Integrations', link: '/02-deep-dive/integrations/' },
          { text: 'BMad Framework', link: '/02-deep-dive/bmad-framework/' },
        ]
      },
      {
        text: 'Onboarding',
        collapsed: false,
        items: [
          { text: 'Contributor', link: '/onboarding/contributor' },
          { text: 'Staff Engineer', link: '/onboarding/staff-engineer' },
          { text: 'Executive', link: '/onboarding/executive' },
          { text: 'Product Manager', link: '/onboarding/product-manager' },
        ]
      },
      {
        text: 'Reference',
        collapsed: false,
        items: [
          { text: 'AGENTS.md', link: '/AGENTS.md' },
          { text: 'llms.txt', link: '/llms.txt' },
          { text: 'llms-full.txt', link: '/llms-full.txt' },
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com' }
    ],

    search: {
      provider: 'local'
    }
  },

  markdown: {
    theme: {
      dark: 'one-dark-pro',
      light: 'github-light'
    },
    lineNumbers: true
  }
})
