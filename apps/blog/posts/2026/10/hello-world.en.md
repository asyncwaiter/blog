---
title: 'First Post <em>Placeholder</em>'
tags:
  - blogging
published: true
date: 2026-10-04 12:00:00
description: 'A placeholder post that keeps the build green. Next.js cacheComponents requires every generateStaticParams to return at least one result, so a blog with zero posts fails to build. Replace this file when you write your first post.'
series: '블로그 시작하기'
seriesOrder: 1
---

A placeholder that keeps the build green.

Because `cacheComponents: true` is set in `apps/blog/next.config.ts`, every
`generateStaticParams` must return at least one result. With no posts at all,
these routes all fail to build.

- `/[year]/[...slug]`
- `/en/[year]/[...slug]`
- `/pages/[id]`
- `/en/pages/[id]`
- `/series/[slug]`
- `/tags/[tag]/pages/[id]`

Replace this file, `hello-world.md`, and `series/getting-started.md` when you
write your first post.
