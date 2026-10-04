import type {Locale} from '@/utils/postPaths'

interface SideProject {
  name: string
  tags: string[]
  /** 공개 저장소나 소개 페이지가 있을 때만 링크로 렌더링한다. */
  href?: string
  category: Record<Locale, string>
  description: Record<Locale, string>
}

// 아직 쓰지 않았다. 항목을 넣으면 /resume 의 사이드 프로젝트 섹션에 그대로 렌더링된다.
export const sideProjects: SideProject[] = []
