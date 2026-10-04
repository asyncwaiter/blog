import {getContactHref} from '@yceffort/shared/utils'

const isDev = process.env.NODE_ENV === 'development'

export const SiteConfig = {
  url: isDev ? 'http://localhost:3000' : 'https://asyncwaiter.com',
  pathPrefix: '/',
  title: 'asyncwaiter',
  subtitle: 'Fail more. Learn more.',
  copyright: 'asyncwaiter © All rights reserved.',
  disqusShortname: '',
  postsPerPage: 5,
  // 자신의 GA4 측정 ID(G-...)를 넣으면 켜진다. 비어 있으면 gtag를 아예 싣지 않는다.
  googleAnalyticsId: 'G-95FZE9FYFJ',
  useKatex: false,
  menu: [
    {
      label: 'Posts',
      path: '/pages/1',
    },
    {
      label: 'Series',
      path: '/series',
    },
    {
      label: 'Tags',
      path: '/tags',
    },
    {
      label: 'About',
      path: '/about',
    },
  ],
  author: {
    name: 'asyncwaiter',
    photo: '/profile.jpg',
    bio: 'frontend engineer',
    contacts: {
      email: 'asyncwaiter@gmail.com',
      facebook: '',
      telegram: '',
      twitter: '',
      github: getContactHref('github', 'asyncwaiter'),
      rss: '',
      linkedin: '',
      instagram: '',
      line: '',
      gitlab: '',
      codepen: '',
      youtube: '',
      soundcloud: '',
    },
  },
}
