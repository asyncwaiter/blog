---
title: '첫 글 <em>플레이스홀더</em>'
tags:
  - blogging
published: true
date: 2026-10-04 12:00:00
description: '빌드를 세워 두기 위한 플레이스홀더 글입니다. Next.js의 cacheComponents 옵션은 모든 generateStaticParams가 최소 한 건을 반환하도록 요구하므로, 글이 0개면 빌드가 실패합니다. 첫 글을 쓸 때 이 파일을 교체하세요.'
series: '블로그 시작하기'
seriesOrder: 1
---

빌드를 세워 두기 위한 플레이스홀더입니다.

`apps/blog/next.config.ts`의 `cacheComponents: true` 때문에 모든 `generateStaticParams`가
최소 한 건을 반환해야 합니다. 글이 하나도 없으면 아래 라우트들이 전부 빌드에 실패합니다.

- `/[year]/[...slug]`
- `/en/[year]/[...slug]`
- `/pages/[id]`
- `/en/pages/[id]`
- `/series/[slug]`
- `/tags/[tag]/pages/[id]`

첫 글을 쓸 때 이 파일과 `hello-world.en.md`, `series/getting-started.md`를 교체하세요.
