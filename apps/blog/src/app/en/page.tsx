import type {Metadata} from 'next'

import HomeView from '@/components/home/HomeView'
import {SiteConfig} from '@/config'
import {buildOgImageUrl} from '@/utils/og'
export const metadata: Metadata = {
  title: `${SiteConfig.title} — English`,
  description: SiteConfig.subtitle,
  // openGraph를 정의하면 layout.tsx의 것을 통째로 대체하므로 images를 여기서 다시 준다.
  // 빠뜨리면 링크를 공유해도 카드에 이미지가 붙지 않는다.
  openGraph: {
    title: `${SiteConfig.title} — English`,
    description: SiteConfig.subtitle,
    url: `${SiteConfig.url}/en`,
    images: [
      {
        url: buildOgImageUrl({
          title: SiteConfig.title,
          description: `${SiteConfig.title}'s blog`,
          path: '/en',
          type: 'page',
        }),
        width: 1200,
        height: 630,
        alt: SiteConfig.title,
      },
    ],
  },
}
export default function EnPage() {
  return <HomeView locale="en" />
}
