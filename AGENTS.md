# asyncwaiter blog monorepo

## 프로젝트 구조

- pnpm 모노레포 (Node 24, pnpm 12)
- `apps/blog` — Next.js 16 메인 블로그 (asyncwaiter.com)
- `packages/shared` — 공유 컴포넌트·유틸
- `packages/markdown-rs` — Rust/WASM 마크다운 파이프라인
- StyleX, React 19, TypeScript 5

## 포스트

- 경로: `apps/blog/posts/{year}/{month}/{slug}.md`
- 영문 번역: `{slug}.en.md`
- frontmatter 필수 필드: `title`, `tags`, `published`, `date`, `description`
- `apps/blog/next.config.ts`의 `cacheComponents: true` 때문에 **글이 0개면 빌드가 실패한다.**
  모든 `generateStaticParams`가 최소 1건을 반환해야 하므로, 한국어 글 1개 + 영문 번역 +
  시리즈 소속 + 태그 1개가 최소 콘텐츠 단위다.

## 주요 스크립트

- `pnpm dev:blog` — 블로그 로컬 개발
- `pnpm build:blog` — 블로그 빌드
- `pnpm lint` — 전체 린트
- `pnpm prettier:fix` — 전체 포매팅

## 사이트 설정

- `apps/blog/src/config.ts`가 도메인·이름·소셜의 단일 소스다. 도메인을 바꿀 때
  하드코딩된 곳을 찾지 말고 이 파일만 고치면 된다.
- GA4 측정 ID는 `config.ts`의 `googleAnalyticsId`. 비어 있으면 gtag를 싣지 않는다.
- GA4 Data API(인기 글 집계)는 `apps/blog/src/utils/analytics.ts`.
  환경 변수 `GA4_PROPERTY_ID`, `GOOGLE_APPLICATION_CREDENTIALS_JSON` (apps/blog/.env.local).
  없으면 빈 배열로 폴백하므로 빌드는 깨지지 않는다.

## 블로그 포스트 전략

> 아래는 원본 저장소(yceffort)의 GA4 데이터에서 나온 일반 원칙이다. 이 블로그의
> 자체 데이터는 아직 없으므로, 트래픽이 쌓이면 `/ga4-report`로 다시 판단할 것.

### 쓰지 말아야 할 글

- "X vs Y" 비교글, "N가지 방법" 나열형, "~란 무엇인가" 설명형
- AI가 즉답 가능한 주제는 검색 트래픽이 급감하는 추세

### 써야 할 글

- **AI + 프론트엔드 실전**: coding agent 활용기, AI 기반 개발 워크플로우, LLM 기반 UI 패턴
- **"직접 해봤다" 류**: 성능 분석, 마이그레이션 후기, 장애 분석 (AI가 만들어낼 수 없는 경험 기반)
- **프레임워크 내부 딥다이브**: AST, React 컴파일러, 번들러 동작 원리
- **실무 레퍼런스형**: 린트 규칙 설명, 보안 취약점 분석 등 GitHub PR에서 인용될 수 있는 근거 자료

### 핵심 원칙

> "ChatGPT에 물어보면 나오는 글"은 쓰지 말고, "ChatGPT가 이 글을 참고해야 답할 수 있는 글"을 쓸 것.
