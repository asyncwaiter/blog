---
name: publish-post
description: 블로그 초안을 발행할 준비를 한다. 영문 번역, 태그, unDraw 썸네일을 만들고 결과를 사용자에게 확인받은 뒤 `published: true`로 바꿔 커밋한다. 사용자가 "배포 준비", "발행 준비", "/publish-post"로 요청할 때 사용.
argument-hint: <apps/blog/posts/YYYY/MM/slug.md>
---

# 블로그 글 발행 준비

대상: `$ARGUMENTS`. 비어 있으면 `published: false`인 글 중 가장 최근 수정된 것을 후보로 제시하고 사용자에게 확인받는다.

순서가 중요하다. 영문본을 먼저 만들어야 태그와 썸네일이 영문본에도 같은 값으로 들어간다.

**API 키는 쓰지 않는다.** `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`를 `.env.local`에 두지
않기로 했다(값이 비어 있는 건 실수가 아니다). 태그, 관련 글, unDraw 이름을 "고르는" 판단은
전부 Claude Code가 직접 한다. 스크립트는 키가 필요 없는 부분(SVG 렌더링, 파일 쓰기, 검사)에만
쓴다. 키가 없다고 멈추거나 사용자에게 키를 요청하지 않는다.

## 1. 사전 점검

- frontmatter 필수 필드(`title`, `tags`, `published`, `date`, `description`)를 확인한다.
- `node ~/.claude/skills/my-writing/scan.mjs <파일>`에서 1(즉시 수정)과 2(축자 번역)가 0건인지 확인한다. 0건이 아니면 발행 준비를 멈추고 사용자에게 알린다.
- em dash(—), en dash(–), 가운뎃점(·)이 본문에 없는지 `grep`으로 확인한다.
- 본문의 코드 링크가 커밋 해시에 고정돼 있으면, 그 커밋이 `origin/main`에 있는지 `git merge-base --is-ancestor`로 확인한다.

## 2. 영문 번역 (`{slug}.en.md`)

이미 있으면 한국어본과 달라진 부분만 반영한다. 새로 만들 때 규칙:

- frontmatter는 `title`, `description`만 번역하고 `tags`, `date`, `published`, `series`, `seriesOrder`, `art`는 한국어본과 같게 둔다.
- 내부 링크 경로(`/2026/...`), 이미지 경로, 각주 번호와 링크는 그대로 둔다. 코드 블록은 번역하지 않는다.
- 이미지 alt, 표, mermaid 라벨, 각주 설명은 번역한다.
- 영문본에도 em dash, en dash(범위는 `122-128ms`처럼 하이픈), 가운뎃점을 쓰지 않는다.
- 각주 수가 한국어본과 같은지 확인한다.

기존 영문본(`apps/blog/posts/2026/09/*.en.md`)의 문체를 참고한다. 직역보다 자연스러운 영어를 우선하되 주장과 수치는 바꾸지 않는다.

## 3. 태그

`retag-posts.mjs`는 `TYPESAFE_API_KEY`가 필요하므로 쓰지 않는다. `apps/blog/data/tag-vocabulary.json`의
설명문을 읽고 Claude Code가 직접 고른다.

- 어휘에 **없는** 태그는 만들지 않는다. 맞는 게 없으면 `propose-tags.mjs` 대신 사용자와 정한다.
- 한국어본과 영문본 frontmatter에 같은 태그를 쓴다.
- 최근 글이 어떤 태그를 썼는지 `grep -rhA6 '^tags:' apps/blog/posts/<최근 월>`로 참고한다.

## 4. 썸네일 (unDraw)

```bash
node apps/blog/scripts/generate-undraw-thumbnail.mjs <파일>
```

`art.undraw`가 frontmatter에 **이미 있으면 이 스크립트는 API를 타지 않고** SVG만 렌더해
`apps/blog/public/thumbnails/{slug}.webp`를 만든다. 그러니 이름은 Claude Code가 먼저 고르고
한국어본·영문본 frontmatter에 `art:\n  undraw: <이름>\n  hue: <색>`을 넣은 뒤 위 명령을 돌린다.
이름 없이 돌리면 `ANTHROPIC_API_KEY`를 찾다가 실패한다. `generate-thumbnail.mjs`(Gemini)와
`generate-art-spec.mjs`는 쓰지 않는다.

- 만든 webp를 png로 바꿔 직접 열어 보고 확인한다(`sharp(webp).png().toFile(...)`).
- **사람이 들어간 그림은 쓰지 않는다.** 카탈로그 필터(피부색 fill)를 통과한 이름이라도 사람 실루엣이 새어 나올 수 있다.
- 고를 수 있는 이름은 스크립트의 `PEOPLE_NAME`, `SKIN` 필터를 `node_modules/undraw-svg/svgs`에 적용해 뽑는다.
- 최근 글들과 같은 이름이 겹치지 않게 한다(`grep -rh "undraw:" apps/blog/posts/<최근 월>`).

## 5. 관련 글

`generate-related-posts.mjs`도 `TYPESAFE_API_KEY`가 필요하므로 쓰지 않는다. 커밋 훅
(`lefthook.yml`의 `related-posts`)은 돌다가 `관련 글 갱신 실패. 태그 방식으로 폴백됩니다.`를
출력하는데, **이건 정상이고 커밋을 막지 않는다.**

대신 Claude Code가 `apps/blog/data/related-posts.json`에 직접 적는다. 형식은
`{"ko": {"<slug>": [{"slug": "...", "score": 0.0}, ...]}, "en": {...}}`이고, score 내림차순
최대 8편이다. `score`는 0~1 사이로 직접 매긴다.

- 비워 두면 `getRelatedPosts`가 태그 겹침으로 폴백한다([Post.ts](apps/blog/src/utils/Post.ts)).
  태그만으로 충분한 글은 손대지 않아도 된다.
- 적을 때는 ko/en 양쪽에 같은 글 목록을 넣는다(영문본이 있는 글만).
- `related-scores.json`은 스크립트 캐시이므로 손대지 않는다.

## 6. 검증

- 커밋 훅과 같은 검사를 돌린다: `npx lefthook run pre-commit --file <한국어본> --file <영문본>`.
- dev 서버가 떠 있으면 `http://localhost:3000/<경로>`와 `/en/<경로>`가 200인지 확인한다.

## 7. 사용자 확인 (필수)

아래를 한 번에 보여 주고 AskUserQuestion으로 발행 여부를 묻는다. 확인 없이 `published: true`로 바꾸지 않는다.

- 태그(기존 → 새), 썸네일 이름과 이미지(Read로 보여 줌)
- 영문 title, description
- 점검 결과(스캔, 린트)와 확인하지 못한 것

## 8. 발행

승인받으면 한국어본과 영문본 모두 `published: true`로 바꾸고 `date`를 발행 시각(`date "+%Y-%m-%d %H:%M:00"`)으로 바꾼다. 두 파일의 `date`는 같아야 한다. 글, 영문본, 썸네일, (손댔다면) `apps/blog/data/related-posts.json`을 한 커밋으로 묶는다(메시지 예: `📝 Publish <slug>`). **푸시는 사용자가 따로 요청할 때만 한다.**

푸시하면 `.github/workflows/notify-push.yaml`이 `published: false → true` 전환을 감지해 구독자에게 웹 푸시를 보낸다. 한 번 나가면 되돌릴 수 없으니 푸시 전에 이 점을 사용자에게 알린다. 발송이 실패하면 `gh workflow run notify-push.yaml -f files=<경로>`로 수동 발송한다.
