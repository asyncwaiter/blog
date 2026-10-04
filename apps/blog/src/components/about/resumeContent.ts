import type {Locale} from '@/utils/postPaths'

interface Job {
  company: string
  role: string
  period: string
  description: string
  contributions: string[]
  stack: string
  link?: {href: string; label: string}
}

interface Entry {
  period: string
  title: string
  // '/'로 시작하면 사이트 안 링크
  href?: string
  description: string
  honor?: string
}

interface Heading {
  title: string
  // 한국어 제목 옆에 붙는 영어 부제. 영어 페이지에서는 제목과 같아 생략한다.
  sub?: string
}

export interface ResumeContent {
  eyebrow: string
  title: string
  lead: string
  status: string
  expertise: {term: string; detail: string}[]
  navLabel: string
  sections: {id: string; label: string}[]
  experience: Heading & {note: string; jobs: Job[]}
  projects: Heading
  activities: Heading & {entries: Entry[]}
  education: Heading & {entries: Entry[]}
  certifications: Heading & {entries: Entry[]}
}

// 아직 쓰지 않았다. 섹션 구조와 목차만 남겨 두고 항목은 비워 둔다.
// 내용을 채울 때 jobs / entries 배열에 항목을 넣고 '...' 를 문장으로 바꾼다.
const ko: ResumeContent = {
  eyebrow: 'EXPERIENCE & CONTRIBUTIONS',
  title: '...',
  lead: '...',
  status: '...',
  expertise: [],
  navLabel: '이력서 목차',
  sections: [
    {id: 'experience', label: '경력'},
    {id: 'projects', label: '사이드 프로젝트'},
    {id: 'activities', label: '활동'},
    {id: 'education', label: '학력'},
    {id: 'certifications', label: '자격·어학'},
  ],
  experience: {title: '경력', sub: 'Experience', note: '...', jobs: []},
  projects: {title: '사이드 프로젝트', sub: 'Side projects'},
  activities: {title: '활동', sub: 'Beyond work', entries: []},
  education: {title: '학력', sub: 'Education', entries: []},
  certifications: {title: '자격·어학', sub: 'Certifications', entries: []},
}

const en: ResumeContent = {
  eyebrow: 'EXPERIENCE & CONTRIBUTIONS',
  title: '...',
  lead: '...',
  status: '...',
  expertise: [],
  navLabel: 'Resume contents',
  sections: [
    {id: 'experience', label: 'Experience'},
    {id: 'projects', label: 'Side projects'},
    {id: 'activities', label: 'Beyond work'},
    {id: 'education', label: 'Education'},
    {id: 'certifications', label: 'Certifications'},
  ],
  experience: {title: 'Experience', note: '...', jobs: []},
  projects: {title: 'Side projects'},
  activities: {title: 'Beyond work', entries: []},
  education: {title: 'Education', entries: []},
  certifications: {title: 'Certifications', entries: []},
}

export const resumeContent: Record<Locale, ResumeContent> = {ko, en}
