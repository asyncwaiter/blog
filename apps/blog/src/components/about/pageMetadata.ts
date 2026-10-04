import type {Metadata} from 'next'

import {SiteConfig} from '@/config'
import {buildOgImageUrl} from '@/utils/og'
import type {Locale} from '@/utils/postPaths'

const pages = {
  about: {
    title: 'About',
    description: {
      ko: '프론트엔드 엔지니어 이수진. 계측과 렌더링, 번들 경계처럼 추상화 아래로 내려가야 설명되는 문제를 측정하고 기록합니다.',
      en: 'Soojin Lee, a frontend engineer who measures and writes about problems that only make sense below the abstraction: instrumentation, rendering, and bundle boundaries.',
    },
  },
  resume: {
    title: 'Resume',
    description: {
      ko: '프론트엔드 엔지니어 이수진의 경력과 기여. 계측 데이터 복구, 번들 경계 재설계, 렌더링 성능 개선과 사이드 프로젝트를 소개합니다.',
      en: 'Career and contributions of frontend engineer Soojin Lee: recovering broken analytics, redrawing bundle boundaries, improving rendering performance, and side projects.',
    },
  },
}

// about과 resume은 한국어와 영어가 같은 구성이라 메타데이터를 한 곳에서 만든다
export function pageMetadata(
  page: keyof typeof pages,
  locale: Locale,
): Metadata {
  const {title, description} = pages[page]
  const path = `${locale === 'en' ? '/en' : ''}/${page}`
  const fullTitle = `${title} - ${SiteConfig.title}`
  return {
    title: fullTitle,
    description: description[locale],
    openGraph: {
      title: fullTitle,
      description: description[locale],
      url: `${SiteConfig.url}${path}`,
      images: [
        {
          url: buildOgImageUrl({
            title: fullTitle,
            description: description[locale],
            path,
            type: 'page',
          }),
          width: 1200,
          height: 630,
        },
      ],
    },
    alternates: {
      canonical: `${SiteConfig.url}${path}`,
      languages: {
        ko: `${SiteConfig.url}/${page}`,
        en: `${SiteConfig.url}/en/${page}`,
      },
    },
  }
}
