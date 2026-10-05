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

interface Project {
  name: string
  tags: string[]
  /** 공개 저장소나 소개 페이지가 있을 때만 링크로 렌더링한다 */
  href?: string
  category: string
  description: string
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
  projects: Heading & {items: Project[]}
  education: Heading & {entries: Entry[]}
  certifications: Heading & {entries: Entry[]}
}

const ko: ResumeContent = {
  eyebrow: 'EXPERIENCE',
  title: '이상한 숫자를 지나치지 않습니다',
  lead: '대시보드에서 브라우저 환경이 찍히는 비율이 이상해 원인을 추적했고, SDK의 UA 파싱을 고쳐 그동안 보이지 않던 유저들의 브라우저 분포를 찾아냈습니다. 모든 개선은 숫자로 말할 수 있도록 노력합니다.',
  status: '프론트엔드 엔지니어 · 재직 중',
  expertise: [{term: '서비스 개발', detail: 'TypeScript · React · Next'}],
  navLabel: '이력서 목차',
  sections: [
    {id: 'experience', label: '경력'},
    {id: 'projects', label: '사이드 프로젝트'},
    {id: 'education', label: '교육'},
    {id: 'certifications', label: '자격·어학'},
  ],
  experience: {
    title: '경력',
    sub: 'Experience',
    note: '근무한 곳에서의 경험입니다.',
    jobs: [
      {
        company: '크래프톤',
        role: 'Frontend Engineer',
        period: '2025. 03 - 재직 중',
        description: '22개국 대상 유저 서비스 개발과 프론트엔드 계측·성능 개선',
        contributions: [
          'Krafton Players, 게임 공식 홈페이지, 이벤트 페이지 등 글로벌 서비스 개발',
          '대시보드 지표 이상을 추적해 SDK UA 파싱 수정, 누락된 중국 유저 브라우저 분포 복구',
          'Server Function 렌더 에러 원인 추적·제거, 서버·클라이언트 모듈 경계 분리',
          'RTL 레이아웃, 언어별 폰트 로드, 중국 접속 환경 대응과 북유럽 파트너사 PoC 개발',
        ],
        stack: 'React · TypeScript · Next · Vue · Nuxt · pnpm',
      },
      {
        company: '코나아이',
        role: 'Frontend Engineer',
        period: '2022. 01 - 2023. 06',
        description: 'AMI 가스 검침 데이터 백오피스와 지역화폐 서비스 개발',
        contributions: [
          'AMI 가스 계량기 검침 데이터 백오피스 도입 제안·개발 → 메일 기반 업무량 약 90% 절감',
          '지역화폐 부산 동백전 지급 페이지 개발',
        ],
        stack: 'React · TypeScript · Spring · MyBatis',
      },
    ],
  },
  projects: {
    title: '사이드 프로젝트',
    sub: 'Side projects',
    items: [
      {
        name: 'X-MAS RUN',
        href: 'https://github.com/Crazy-Cow/Client',
        category: '3D 웹 게임',
        description:
          '3D 멀티플레이어 웹 게임. 분산된 물리 연산을 커스텀 훅으로 일원화하고 충돌체를 줄여 33fps → 61fps로 개선',
        tags: ['React', 'react-three-fiber', 'TypeScript', 'Rapier'],
      },
      {
        name: 'MoA',
        href: 'https://github.com/MoA-Gift-Funding/Moa-React-Native',
        category: '창업',
        description:
          '선물 펀딩 서비스. 아이디어 발굴부터 프론트엔드 단독 개발, 팀원 모집, 파트너사 미팅까지 주도',
        tags: ['React Native', 'TypeScript'],
      },
    ],
  },
  education: {
    title: '교육',
    sub: 'Education',
    entries: [
      {
        period: '2024. 08 - 2024. 12',
        title: 'KAIST 전산학부 비학위 과정 (SW사관학교 정글)',
        description:
          '전산학 기초 집중 기숙형 프로그램 (자료구조, 알고리즘, OS, 네트워크)',
      },
      {
        period: '2019. 02',
        title: '경희대학교 경영학과',
        description: '학사 졸업',
      },
    ],
  },
  certifications: {
    title: '자격·어학',
    sub: 'Certifications',
    entries: [
      {
        period: '2024. 06',
        title: 'AWS Certified Solutions Architect – Associate',
        description: 'AWS',
      },
      {
        period: '2023. 07',
        title: 'SQLD',
        description: '한국데이터산업진흥원',
      },
      {
        period: '2021. 11',
        title: '정보처리기사',
        description: '과학기술정보통신부',
      },
      {
        period: '2023. 07',
        title: '영어 · OPIc AL',
        description: '',
      },
      {
        period: '2022. 12',
        title: '일본어 · JLPT N3',
        description: '',
      },
    ],
  },
}

const en: ResumeContent = {
  eyebrow: 'EXPERIENCE',
  title: "I don't walk past numbers that look off",
  lead: "A browser breakdown on our dashboard looked off, so I traced it to the SDK's user-agent parsing, fixed it, and uncovered the browser distribution of users we had never been able to see. I try to back every improvement with a number.",
  status: 'Frontend Engineer · Currently employed',
  expertise: [
    {term: 'Product development', detail: 'TypeScript · React · Next'},
  ],
  navLabel: 'Resume contents',
  sections: [
    {id: 'experience', label: 'Experience'},
    {id: 'projects', label: 'Side projects'},
    {id: 'education', label: 'Education'},
    {id: 'certifications', label: 'Certifications'},
  ],
  experience: {
    title: 'Experience',
    note: 'Where I have worked.',
    jobs: [
      {
        company: 'KRAFTON',
        role: 'Frontend Engineer',
        period: 'Mar 2025 - Present',
        description:
          'User-facing services for 22 countries, plus frontend instrumentation and performance work',
        contributions: [
          'Built global services including Krafton Players, official game websites, and event pages',
          'Traced an anomaly in dashboard metrics to SDK user-agent parsing and fixed it, recovering the missing browser distribution of users in China',
          'Tracked down and eliminated a Server Function render error; separated server and client module boundaries',
          'Handled RTL layouts, per-language font loading, and access from China; built a PoC with a Nordic partner',
        ],
        stack: 'React · TypeScript · Next · Vue · Nuxt · pnpm',
      },
      {
        company: 'Kona I',
        role: 'Frontend Engineer',
        period: 'Jan 2022 - Jun 2023',
        description:
          'Back office for AMI gas meter-reading data and local currency services',
        contributions: [
          'Proposed and built a back office for AMI gas meter-reading data, cutting email-based request handling by about 90%',
          'Built the payout page for Dongbaekjeon, the local currency of Busan',
        ],
        stack: 'React · TypeScript · Spring · MyBatis',
      },
    ],
  },
  projects: {
    title: 'Side projects',
    items: [
      {
        name: 'X-MAS RUN',
        href: 'https://github.com/Crazy-Cow/Client',
        category: '3D web game',
        description:
          'A 3D multiplayer web game. Consolidated scattered physics logic into a single custom hook and reduced colliders, improving 33fps → 61fps',
        tags: ['React', 'react-three-fiber', 'TypeScript', 'Rapier'],
      },
      {
        name: 'MoA',
        href: 'https://github.com/MoA-Gift-Funding/Moa-React-Native',
        category: 'Startup',
        description:
          'A gift crowdfunding service. Led it from the initial idea through solo frontend development, recruiting the team, and partner meetings',
        tags: ['React Native', 'TypeScript'],
      },
    ],
  },
  education: {
    title: 'Education',
    entries: [
      {
        period: 'Aug 2024 - Dec 2024',
        title:
          'KAIST School of Computing, Non-degree Program (SW Academy Jungle)',
        description:
          'Intensive residential program in CS fundamentals (data structures, algorithms, OS, networking)',
      },
      {
        period: 'Feb 2019',
        title: 'Kyung Hee University, Business Administration',
        description: "Bachelor's degree",
      },
    ],
  },
  certifications: {
    title: 'Certifications',
    entries: [
      {
        period: 'Jun 2024',
        title: 'AWS Certified Solutions Architect – Associate',
        description: 'AWS',
      },
      {
        period: 'Jul 2023',
        title: 'SQL Developer (SQLD)',
        description: 'Korea Data Agency',
      },
      {
        period: 'Nov 2021',
        title: 'Engineer Information Processing',
        description: 'Ministry of Science and ICT',
      },
      {
        period: 'Jul 2023',
        title: 'English · OPIc AL',
        description: '',
      },
      {
        period: 'Dec 2022',
        title: 'Japanese · JLPT N3',
        description: '',
      },
    ],
  },
}

export const resumeContent: Record<Locale, ResumeContent> = {ko, en}
