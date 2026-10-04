# asyncwaiter-monorepo

asyncwaiter's blog (asyncwaiter.com).

> Based on [yceffort-blog-v2](https://github.com/yceffort/yceffort-blog-v2) by [yceffort](https://yceffort.kr), used under the MIT License. The blog engine only — none of the original posts are included.

## Structure

```text
├── apps/
│   └── blog/              # Main blog (asyncwaiter.com)
├── packages/
│   ├── shared/            # Shared components and utilities
│   └── markdown-rs/       # Rust/WASM markdown pipeline
└── package.json           # Root workspace configuration
```

The `@yceffort/shared` package holds components (Providers, MobileNav, EmphasizedTitle, SocialIcon, icons) and utilities (cookie, contact, title). `@yceffort/markdown-rs` compiles the markdown pipeline to WebAssembly; the built `.wasm` is committed so deploys do not need the WASI SDK.

## Development

```bash
# Install dependencies
pnpm install

# Dev server (http://localhost:3000)
pnpm dev:blog

# Build
pnpm build:blog

# Lint (oxlint type-aware + markdownlint + frontmatter checks)
pnpm lint
pnpm lint:fix

# Format (oxfmt)
pnpm prettier
pnpm prettier:fix
```

## Writing posts

Posts live at `apps/blog/posts/{year}/{month}/{slug}.md`, with English translations as `{slug}.en.md`. Required frontmatter: `title`, `tags`, `published`, `date`, `description`.

Note that `cacheComponents: true` in `apps/blog/next.config.ts` makes Next.js require every `generateStaticParams` to return at least one result, so the build fails with zero posts. The minimum is one Korean post with an English translation, a series, and at least one tag.

## Configuration

`apps/blog/src/config.ts` is the single source for the domain, site name, and social links. Set `googleAnalyticsId` there to your own GA4 measurement ID (`G-...`); leaving it empty skips loading gtag entirely.

Optional environment variables go in `apps/blog/.env.local` (all features degrade gracefully when absent):

| Variable                                | Purpose                                         |
| --------------------------------------- | ----------------------------------------------- |
| `GA4_PROPERTY_ID`                       | Popular-post counts via the GA4 Data API        |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON`   | Service account JSON for the above              |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`          | Web push subscription in the browser            |
| `VAPID_PRIVATE_KEY`                     | Signing push sends                              |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis storing push subscribers          |
| `TYPESAFE_API_KEY`                      | Local scripts that pick related posts and retag |

## Deployment (Vercel)

| Setting         | Value                            |
| --------------- | -------------------------------- |
| Root Directory  | `apps/blog`                      |
| Install Command | `pnpm install --frozen-lockfile` |
| Domain          | asyncwaiter.com                  |
| Node            | 24.x                             |

## Tech Stack

Next.js 16 (App Router, Cache Components), React 19, TypeScript 5, StyleX, Rust/WebAssembly for markdown, pnpm workspaces, oxlint and oxfmt.

## Author

asyncwaiter <asyncwaiter@gmail.com>

## Credits

Originally created by [yceffort](https://github.com/yceffort). The original copyright notice is retained in [apps/blog/LICENSE](./apps/blog/LICENSE).
