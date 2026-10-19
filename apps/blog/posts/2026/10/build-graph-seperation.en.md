---
title: 'Rendering Boundaries[2]: typeof window does not know the graph'
tags:
  - react
  - nextjs
  - debugging
published: true
date: 2026-10-20 00:10:00
description: 'Once SSR came back to life, a new error surfaced: getLocale is not supported in Client Components. A typeof window check only tells you server or browser; it does not know whether the code is in the rsc bundle or the ssr bundle. I followed the Turbopack source to see how it splits the rsc, ssr, and client graphs, ran an experiment to confirm that libraries only offer choices through exports conditions, and ended up drawing the boundary at build time with server-only.'
series: 'Rendering Boundaries'
seriesOrder: 2
art:
  undraw: local-server
  hue: cyan
---

## Table of Contents

## Introduction

The work in the previous post fixed the `ServerFunctions cannot be called during initial render` error and the duplicated network requests. But it also exposed a problem that had been hiding underneath. A new error appeared: `getLocale is not supported in Client Components`. Why did it only show up now? The reason is simple. SSR, which used to fail, now succeeded. Before, a Server Function ran during SSR, threw through `noServerCall`, and the work fell through to the client, so the code after that point never had a chance to run. Once SSR made it past that spot, the error that `getLocale` cannot be called from a Client Component came out into the open.

The service uses `next-intl` for i18n. `getLocale` is a function that only runs on the server and reads the URL and returns the locale. But something was off. I could not find any place where `getLocale` was called from a Client Component. The cause was somewhere I did not expect: the place where the API client is assembled. In this project, both server and client components call a single `authApi` to send GET and POST requests without thinking about which environment they are in. Where that object is assembled, the dependencies that go in differ based on a runtime branch between server and client. Here is a sandbox version of the code.

```ts
// lib/api/index.ts
const isServer = typeof window === 'undefined'

// 서버 렌더링 중에는 요청 URL에서 locale을 읽어 헤더로 넣는다
const serverHeaderProvider = isServer
  ? async () => {
      const {getLocale} = await import('next-intl/server')
      return {[LOCALE_HEADER]: await getLocale()}
    }
  : undefined

// 클라이언트에서는 URL에서 locale을 읽는다
const clientHeaderProvider = isServer
  ? undefined
  : async () => ({
      [LOCALE_HEADER]: resolveLocaleFromPath(window.location.pathname),
    })

// 서버, 클라이언트 구분 없이 이거 하나만 쓴다
export const authApi = new ApiClient(
  baseUrl,
  serverHeaderProvider ?? clientHeaderProvider,
)
```

So there is one unified `authClient`, and the headers and URL are decided at runtime when it runs. `getLocale` was used here to put the locale into a header. You might wonder why we read the URL and pass it along by hand in the first place. The reason is that the service is a BFF. The browser requests the same-origin `/api/v1`, and the Next server pulls the token out of the cookie and forwards it to the backend. The token is never exposed to the browser and there is no CORS to worry about. But with this setup, whether the request comes from a Server Component or the client, the backend always sees the Next server as the owner of the request, and information like the actual user's locale is lost. That is why we carry it in a header ourselves.

So, back to the question: why did this part become a problem? Because of the one line I thought was drawing the boundary.

```ts
const isServer = typeof window === 'undefined'
```

It checks at runtime whether we are on the server, but that only tells you where the code is executing, not which graph the code is running in. During SSR, `isServer` is `true` as far as the runtime is concerned, but the bundle executing it is the client graph. So it called `getLocale` to add the server header, and the `next-intl/server` inside that bundle had nothing but a stub, no `getLocale`.

To put it in one line: `typeof window` asks "server or browser?", but whether `getLocale` exists depends on "rsc bundle or ssr bundle?", and both of those are the server. The line the branch draws and the line where the problem sits are different lines. Let us follow three questions to see how this happens.

1. How are the server and browser graphs built?
2. How can a library know which graph it is running in? And if things need to differ even within the browser graph, how is that handled?
3. What is the fix?

## How the server and browser graphs are built

Let us take them one at a time. The Next.js docs have a page describing the build process.

> What next build does
> When you run next build, the build moves through these phases:

> Setup. Loads environment variables (.env files), validates your next.config, and generates a build ID.
> Route discovery. Scans the app/ and pages/ directories for routes, and detects root-level convention files like proxy and instrumentation. Generates TypeScript route definitions.
> Compilation. Bundles client, server, and edge code with Turbopack (or webpack). Transpiles TypeScript and JSX, tree-shakes unused code, and optimizes CSS and fonts.
> Static analysis. Classifies each route for prerendering versus on-demand rendering. Collects generateStaticParams output. With Cache Components, checks for prerender-blocking errors.
> Prerendering. Prerenders static pages and PPR shells to HTML. Generates RSC payloads for client-side navigation.
> Output. Writes the build to .next/. For output: 'standalone', bundles only the files needed at runtime. For output: 'export', generates a full static site. Prints the route table.

The phase we care about is the third one, Compilation, because that is where the server and client graphs get separated. Phases 4 (static analysis) and 5 (prerendering) just run the bundles that phase 3 produced once, without a request, so the splitting of the graphs is all finished inside phase 3. Let us look at the output in `.next` directly.

![The .next output directory. Under server there are app, chunks, and edge, and static sits separately](../images/rendering-boundary/build-result.png)

Here is where my first misunderstanding was. I assumed the server and client graphs mapped to the `server` and `static` directories, but there are actually three graphs. The server graph, where rsc runs, goes into `server/chunks`, and the client graph is split across two places: `server/chunks/ssr` and `static/chunks`. In other words, I had assumed everything that runs under `server` belongs to the server graph. SSR runs on the server machine, but its job is to render Client Components, so from React's point of view it is the client graph. I went through the code to see how this graph boundary is drawn. (All code from here on is based on `vercel/next.js` @9b87239 (canary, 2026-10-15) and `next-intl@4.14.9`.)

### One ModuleAssetContext per graph

Turbopack creates one object called `ModuleAssetContext` per graph. The code is written in Rust for performance and I had a hard time following it, so I asked an AI to sketch the process of building these contexts in a short TypeScript version.

```rust
pub(crate) fn rsc_module_context(self: Vc<Self>) -> Result<Vc<ModuleAssetContext>> {
    Ok(ModuleAssetContext::new(
        self.get_rsc_transitions(
            self.ecmascript_client_reference_transition(),
            Vc::upcast(self.ssr_transition()),
            self.shared_transition(),
        ),
        self.project().server_compile_time_info(),
        self.rsc_module_options_context(),
        self.rsc_resolve_options_context(),
        Layer::new_with_user_friendly_name(rcstr!("app-rsc"), rcstr!("Server Component")),
    ))
}

// 652행 ssr_module_context → Layer "app-ssr" ("Client Component SSR")
// 565행 client_module_context → Layer "app-client"
```

```ts
class ModuleAssetContext {
  constructor(
    private transitions: Map<string, Transition>,
    private compileTimeInfo: CompileTimeInfo,
    private moduleOptions: ModuleOptionsContext, // 변환 목록
    private resolveOptions: ResolveOptionsContext, // resolve 조건
    private layer: string,
  ) {}

  process(file: Source): Module {
    // ← 파일은 여기서 들어옴
    // this.moduleOptions의 변환을 돌리고, this.resolveOptions로 import를 풀고 ...
  }
}

// 객체 세 개를 미리 만든다. 파일은 아직 없음.
const rscCtx = new ModuleAssetContext(
  rscTransitions,
  info,
  rscModuleOptions,
  rscResolveOptions,
  'app-rsc',
)
const ssrCtx = new ModuleAssetContext(
  ssrTransitions,
  info,
  ssrModuleOptions,
  ssrResolveOptions,
  'app-ssr',
)
const clientCtx = new ModuleAssetContext(
  clientTransitions,
  info,
  clientModuleOptions,
  clientResolveOptions,
  'app-client',
)

// 빌드 시작: 파일을 객체에 넣는다.
rscCtx.process(pageTsx)
// → 내부에서 import 따라가며 rscCtx.process(다음파일) 재귀
// → 'use client' 만나면 ssrCtx.process(같은파일), clientCtx.process(같은파일)
```

There is one Context per graph, and the arguments passed at construction differ. The body of the `process` method is identical for all three. The same code produces different results purely because these five arguments differ. Understanding the arguments one by one shows how the graphs are built, so let us go through them.

### The first argument, transitions

The first one, `transitions`, is a `Map`. You can tell it is meant to be looked up by key.

```rust
// crates/next-api/src/app.rs 360행
named_transitions: [
    (AppProject::client_transition_name(),      // "next-ecmascript-client-reference"
     ecmascript_client_reference_transition),  // ← clientCtx, ssrCtx로 가는 길을 둘 다 들고 있는 객체
    (rcstr!("next-dynamic"),        NextDynamicTransition::new_marker()),
    (rcstr!("next-dynamic-client"), NextDynamicTransition::new_client(client_transition)),
    (rcstr!("next-ssr"),            ssr_transition),
    (rcstr!("next-shared"),         shared_transition),
    // ...
]

// crates/next-core/src/next_client_reference/ecmascript_client_reference/ecmascript_client_reference_transition.rs 14행
pub struct NextEcmascriptClientReferenceTransition {
    client_transition: ResolvedVc<Box<dyn Transition>>,   // → app-client 컨텍스트
    ssr_transition: ResolvedVc<Box<dyn Transition>>,      // → app-ssr 컨텍스트
}
```

This `Map` is built once when the build starts and only read afterwards. When the `ClientDirectiveTransformer`, which we will see shortly, replaces the AST of a `use client` file with a one-line proxy like `import * as p from "./Button.tsx" with { "turbopack-transition": "next-ecmascript-client-reference" }`, the reference analysis step takes the name in that annotation and looks it up in the `Map`. The object under the `next-ecmascript-client-reference` key holds both `clientCtx` and `ssrCtx`, so when it runs, the same file gets processed again in each of the two contexts. In the end, this `Map` decides which context a file is sent to, based on the name written in the rewritten import.

### The second argument, compileTimeInfo

The second one, `compileTimeInfo`, substitutes constants that differ per environment.

```ts
// packages/next/src/build/define-env.ts 272행
'process.browser': isClient,
```

Just as `process.browser` is `false` on the server and `true` on the client, values specific to each graph's environment go in here. `NEXT_PUBLIC_` environment variables get baked into the bundle here too. Note that `typeof window` is not on this list. It is not substituted and goes all the way to runtime as is.

### The third argument, moduleOptions

The third is `moduleOptions`. This holds the rules for "which transforms to run on which files". The common rules, like stripping TS and transforming JSX for .tsx files, are the same across all three contexts. The only differences are the two directive handlers.

```rust
// crates/next-core/src/next_server/transforms.rs 96행
ServerContextType::AppSSR { .. } => {
    // Yah, this is SSR, but this is still treated as a Client transform layer. -> 클라이언트 레이어라고 명시해둠
    rules.push(get_server_actions_transform_rule(mode, ActionsTransform::Client, ...));
}
ServerContextType::AppRSC { .. } => {
    rules.push(get_server_actions_transform_rule(mode, ActionsTransform::Server, ...));
}

// crates/next-core/src/next_server/context.rs 751행, rsc 컨텍스트에만 등록
ServerContextType::AppRSC { app_dir, ecmascript_client_reference_transition_name, .. } => {
    let client_directive_transformer = Some(get_ecma_transform_rule(
        client_directive_transform_plugin(name),   // ClientDirectiveTransformer
        ...
    ));
    next_server_rules.extend(client_directive_transformer.clone());
    // ...
}
```

The `ClientDirectiveTransformer` exists only in the rsc context. What it does is this: once a file has been parsed into an AST by SWC, if it finds `use client` in that AST, it throws away the original code entirely and replaces it with the one-line proxy we saw above.

```rust
// turbopack/crates/turbopack-ecmascript-plugins/src/transform/directives/client.rs 24행
async fn transform(&self, program: &mut Program, ctx: &TransformContext<'_>) -> Result<()> {
    if is_client_module(program) {
        *program = create_proxy_module(self.transition_name.as_str(), &format!("./{}", ctx.file_name_str));
        // ...
    }
    Ok(())
}
```

When the rsc context meets a `use client` file, it keeps only the reference and goes no deeper. Instead, through the `Map` from the first argument, `ssrCtx` and `clientCtx` read the same file from disk again, and since those two contexts do not have the `ClientDirectiveTransformer`, `use client` stays as a plain string and the real code is compiled. That is why the real code should exist only in ssr and client. If ssr had this transformer too, every read of `Button.tsx` would be turned into a proxy again and it would recurse forever.

`use server` goes the opposite direction. The `server_actions` transform runs in `Server` mode in rsc and in `Client` mode in ssr and client. In rsc it leaves the function body alone and wraps the export in `registerServerReference(fn, id)` to register it as callable by that id. In ssr and client it erases the body and replaces the export with a `createServerReference(id, callServer)` stub. The Server Function error from the previous post came from calling exactly this stub during SSR. The `queryFn` of `useSuspenseQuery` was calling a function from a `use server` file, but that hook lives under `use client`, so it was compiled in the ssr graph, where that function was a `createServerReference(id, callServer)` stub with its body removed. When the stub was called during render, the `noServerCall` plugged into the `callServer` slot threw. Why this `callServer` is `noServerCall` in ssr and a real fetch in the browser becomes clear when we get to the fourth argument.

To sum up: `use client` is a directive that splits the graph, and `use server` is a directive that transforms the contents of a file within the same graph. So an ordinary file with no directive (like my `api/index.ts`) is touched by neither transform, and which graph it ends up in is decided entirely by who imports it.

### Why the dynamic import slipped past the build check

This raised another question. How is a dynamic import, `await import()`, handled internally, given that it bypasses the build check? What about its handling lets it escape? I ask because the reason this problem was found at runtime rather than at build time was precisely the `await import` dynamic import. Let us look at the code.

```rust
// 510행
ModuleItem::ModuleDecl(ModuleDecl::Import(import @ ImportDecl { type_only: false, .. })) => {
    // import 선언문만 수집
    imports.push(ModuleImports { source: (import.src.value, import.span), ... });
}

// 874행, 검사
fn assert_client_graph(&self, imports: &[ModuleImports]) {
    for import in imports {
        if self.invalid_client_imports.contains(&import.source.0) {
            report_error(... NextRscErrClientImport ...) // 에러 발생!
        }
    }
}
```

What gets collected is only `ImportDecl`, that is, static import declarations. `await import()` is a call expression, so it is never collected in the first place. So yes, it was a bypass, but the only thing it bypassed was this one syntax check. The reference analysis step catches `import()` just the same and runs it through the same resolve, so `next/headers` still went into the ssr bundle and blew up the moment `cookies()` was called at runtime. All it did was turn a build error into a runtime error.

When I changed the problematic spot to a static import, the build threw an error right away.

```md
You're importing a component that needs "next/headers". That only works in a Server Component ...

Import traces:
Server Component:
./lib/api/index.ts
./lib/auth/actions.ts

Client Component Browser:
./lib/api/index.ts [Client Component Browser]
./components/SomeGuard.tsx [Client Component Browser]
./components/SomeGuard.tsx [Server Component]
./app/[locale]/layout.tsx [Server Component]

Client Component SSR:
./lib/api/index.ts [Client Component SSR]
./components/SomeGuard.tsx [Client Component SSR]
./components/SomeGuard.tsx [Server Component]
./app/[locale]/layout.tsx [Server Component]
```

These `Import traces` show the graphs at a glance. The same `lib/api/index.ts` is in all three graphs: `Server Component`, `Client Component Browser`, and `Client Component SSR`. In Browser and SSR, `SomeGuard.tsx` is printed twice, once as `[Server Component]` and once as `[Client Component ...]`. That pair of lines is the `use client` boundary, where the context switched. Reading from the bottom up: `layout.tsx` (rsc) → `SomeGuard.tsx` (met in rsc, the split happens) → the same file (reprocessed in the client/ssr context) → `lib/api/index.ts` (followed into that context). What we saw with the third argument, that a file with no directive gets its graph from whoever imports it, is printed right there in the build output. So every call up to now was a continuation of the same problem as last time: failing on every SSR and working only on the client.

### The fourth argument, resolveOptions

Back to the list. The fourth argument, `resolveOptions`, is what actually finds files. It handles the real location of aliases defined in `tsconfig`, `node_modules` lookup, the order of extension candidates, and so on. I found it a little confusing next to the third argument, but where `moduleOptions` is about how to process a file, this one is about which file the string in an import refers to.

The key point is that "which file" gets a different answer per graph. That applies not only to my code but to libraries inside `node_modules`. This is where the `callServer` swap I put off earlier happens. When the ssr graph resolves `react-server-dom-turbopack/client`, the `node` condition matches and `client.node.js` is chosen, and inside that file `noServerCall` sits in the `callServer` slot. In the browser graph the `browser` condition matches and `client.browser.js` is chosen, which contains a real fetch. The stub code is identical in both, but the React file the stub calls into is different, which is why the same call blew up only in SSR. React did not block it; the file that `resolveOptions` handed to ssr was simply written that way.

This `getLocale` error is the same. `resolveOptions` differs per graph, and the heart of it is this one line.

```rust
// crates/next-core/src/next_server/context.rs 112행
impl ServerContextType {
    pub fn should_use_react_server_condition(&self) -> bool {
        matches!(
            self,
            ServerContextType::AppRSC { .. }
                | ServerContextType::AppRoute { .. }
                | ServerContextType::Middleware { .. }
                | ServerContextType::Instrumentation { .. }
        )   // AppSSR 없음
    }
}

// 195행
if ty.should_use_react_server_condition() {
    custom_conditions.push(rcstr!("react-server"));
};
```

`AppSSR` is not in the list. So `react-server` is not among the resolve conditions of the ssr context. In `next-intl`'s `package.json`, that condition looks like this.

```json
"exports": {
  "./server": {
    "react-server": "./dist/esm/production/server.react-server.js",
    "default":      "./dist/esm/production/server.react-client.js"
  }
}
```

The same string `'next-intl/server'` matched the `react-server` condition in the rsc context and resolved to the real implementation, while in the ssr and client contexts the condition did not match and it resolved to the `default`, the stub. Since this is all settled at build time, a `typeof window` at runtime cannot undo a file that has already been baked into the bundle.

### What is left when the build is done

With different arguments going into each graph, once the build starts it runs through the steps below, starting from `rscCtx` (in the abbreviated TS version).

```md
next build 시작

1. 환경변수
2. 라우트 스캔
3. Compilation ─────────────────────────────────── 여기 안
   rscCtx.process(page.tsx)
   ├ 디스크에서 page.tsx 읽기 → 파싱 → 변환 → import 분석
   └ import './Button' 발견 → resolve → rscCtx.process(Button.tsx)
   ├ 디스크에서 Button.tsx 읽기 (원본 그대로)
   ├ SWC 파싱 → AST (메모리)
   ├ 변환 루프 ← ★ 여기서 교체. AST가 프록시 1줄짜리로 바뀜
   ├ 바뀐 AST에서 import 분석 → 어노테이션 발견 → with_transition
   └ clientCtx.process(Button.tsx), ssrCtx.process(Button.tsx)
   └ 디스크에서 Button.tsx 다시 읽기 (원본 그대로. 프록시 아님)
   → 이 컨텍스트엔 ClientDirectiveTransformer 없음 → 교체 안 됨
4. 정적 분석
5. 프리렌더링
6. 출력
```

The AST that SWC parses is used only in memory and then discarded. The result comes out as JS text files for each graph. The build only decides which file goes into which chunk; which line inside that chunk gets executed is decided at runtime. My `typeof window` was an attempt to solve the former problem with the latter tool.

### Why are there two browser graphs

That covers how the server and browser graphs split. But before moving to the second question, why are there two browser graphs (ssr and client) at all? If you trace a single first request on its way from the server to the browser, it looks like this.

```md
1. rsc 번들 실행 (server/chunks)
   서버 컴포넌트를 실행 -> React 트리 생성
   클라이언트 컴포넌트 자리엔 코드 대신 참조만 남김 -> RSC 페이로드

2. ssr 번들 실행 (server/chunks/ssr)
   1의 페이로드를 읽고, 참조를 진짜 컴포넌트로 바꿔 서버에서 실행 -> HTML

3. 응답
   2가 만든 HTML + 2의 페이로드를 <script>로 같이 실어 보냄

4. 브라우저 (static/chunks)
   HTML로 화면이 먼저 보임
   JS 로드 후 페이로드를 읽고 같은 컴포넌트를 다시 실행 -> hydrate
```

Steps 2 and 4 run the same code twice because each gets something different out of it. Step 2 gets HTML that is visible without JS, and step 4 gets live components that respond to clicks. Do only one of them and you have either a static document or CSR. You need both to get a fast first paint and interactivity together.

But step 4 does not redraw the DOM that step 2 produced. `hydrateRoot` compares the tree it rendered against the DOM already on screen, and if they match, it only attaches event handlers and moves on. So this design rests on the premise that the same component produces the same result whether it runs on the server or in the browser. React's principle that a component with the same input must produce the same output is baked into the code in the form of SSR and hydration. The ssr graph and the client graph compiling the same source the same way is also there to protect that premise.

## How does a library know which graph it is in

This brings us to the second question. How, then, can a library know which graph it is currently running in? Where does the library's graph get built?

Anyone who has published a package to npm even once will find this part easy. The library does not actually know. Instead, it writes its source along whatever axis it cares about, builds each variant, and writes in `package.json`'s `exports`: for this condition, this file. The choosing is done by Next.js's resolve, the fourth argument. For example, if you want to serve the Server Component graph differently from everything else, you split `exports` into `react-server` and `default`. To see with my own eyes how this gets read differently per graph, I ran a very small [experiment](https://github.com/asyncwaiter/blog-experiment/commit/970829214f60dd7a15386dd22dcd491d144bf054).

```ts
// client.ts
export const whereAmI = (): string => {
  throw new Error('STUB: not react-server graph')
}

// server.ts
export const whereAmI = () => 'REAL: react-server graph'

/** package.json
 * // ...
 * "exports": {
    ".": {
      "react-server": "./dist/server.js",
      "default": "./dist/client.js"
    }
  },
  */
```

I built a package called `where-am-i` with tsup and added it to the app. The build tool knows nothing about environments. It just turned `server.ts` and `client.ts` into JS, and the environment split is decided by the developer who writes the `exports`. I called it from a Server Component and a Client Component, and this is what came out.

![Result of the where-am-i experiment. whereAmI() in the Server Component prints REAL: react-server graph, the Client Component prints STUB: not react-server graph, and the browser console shows the same error](../images/rendering-boundary/where-am-i-result.png)

The Server Component printed `REAL: react-server graph` as intended. For the Client Component, the part that ran through ssr showed `STUB: not react-server graph` on screen, and the browser graph logged the same error in the `console`.

### Separating ssr and client within the same browser graph

So what if ssr and client need to come out differently even though they are both the browser graph? Use a different axis in `exports`. The conditions Next passes differ per layer.

| Layer  | `react-server` | Platform condition |
| ------ | -------------- | ------------------ |
| rsc    | yes            | `node`             |
| ssr    | no             | `node`             |
| client | no             | `browser`          |

`react-server` is a condition defined by React, and `node`/`browser` are standard Node.js conditions. The library knows nothing about Next's three graphs; it only knows these condition names, and Next passes a different set of conditions for each graph. Split along the `react-server` axis and ssr and client receive the same file; split along the `node`/`browser` axis and they receive different files. The `noServerCall` I mentioned earlier is exactly this case. The React Flight client is split by `node`/`browser`, so when called from ssr it errors out immediately with `noServerCall`, and when called from the browser it fetches with the real `callServer`.

```js
// next/dist/compiled/react-server-dom-turbopack/cjs/react-server-dom-turbopack-client.edge.production.js 2153행
function noServerCall() {
  throw Error(
    'Server Functions cannot be called during initial render. This would create a fetch waterfall. ...',
  )
}
```

The browser build (`client.browser.production.js`) does not have this function. It is the same React, but ssr and browser receive different files, so the error in part 1 happened because the file ssr received was written that way.

One more question came up here. What happens if you export under a name Next cannot find? Say, `"asyncwaiter": "./dist/server.js"`? It falls through to `default`. `exports` is read from top to bottom and picks the first key that is in the resolver's condition list. And if there is no `default` either? The build fails. In the end, the library does not know where it is running; it picks an axis, writes it in `exports`, and Next does the choosing accordingly.

## How to fix it

So then, what is the best way to fix this? The problem exists because a single file imports a function that only exists on the server regardless of which component uses it, so the assembly has to be split: a client api and a server api.

```ts
// lib/api/server.ts
import 'server-only'
import {getLocale} from 'next-intl/server' // 이제 정적 import. 잘못된 그래프에 들어오면 빌드가 막는다

const serverHeaderProvider = async () => ({[LOCALE_HEADER]: await getLocale()})

export const serverAuthApi = new ApiClient(backendUrl, serverHeaderProvider)

// lib/api/client.ts
const clientHeaderProvider = async () => ({
  [LOCALE_HEADER]: resolveLocaleFromPath(window.location.pathname),
})

export const clientAuthApi = new ApiClient('/api/v1', clientHeaderProvider)

// 소비처는 어느 api를 쓸지 직접 넣어준다
export const userQueryOptions = (api: ApiClient) =>
  queryOptions({
    queryKey: userKeys.all,
    queryFn: () => api.get<User>('/user'),
  })

// 서버 컴포넌트에서
queryClient.prefetchQuery(userQueryOptions(serverAuthApi))

// 클라이언트 훅에서
useSuspenseQuery(userQueryOptions(clientAuthApi))
```

Before, one client could be used anywhere regardless of the call site. Now the call site has to pass in `serverAuthApi` or `clientAuthApi`. I could also have done what I did with the experiment package and hung different files per graph behind the same name through `exports` conditions. But that approach, as `next-intl` showed, silently drops in a stub when imported from the wrong graph and never tells you. It does not fail at build time; it fails at runtime. That was exactly the structure that produced this error, so even though it costs the call site some awareness, I chose to separate the boundary explicitly and make mistakes fail at the build step.

What about values that legitimately have to differ between step 2 (the ssr bundle) and step 4 (the browser), like the locale or auth information that goes into headers? Instead of 2 and 4 each computing them, step 1 (the rsc bundle) decides and passes them down the tree. `getLocale` is only usable in 1, so it is read there once and sent along as a prop of `NextIntlClientProvider`, and then 2 and 4 both get the same value through `useLocale()`. The client-side api does not compute anything; it only receives. The prefetch in part 1's fix was, in the end, the same approach. The server decides, and hands it down.

### What server-only does

The internals of the `server-only` package are about as simple as the experiment package I built above.

```json
// server-only/package.json
"exports": {
  ".": {
    "react-server": "./empty.js",
    "default": "./index.js"
  }
}
```

```ts
// server-only/index.js 파일 전체
throw new Error(
  'This module cannot be imported from a Client Component module. ' +
    'It should only be used from a Server Component.',
)
```

When imported from a graph without the `react-server` condition, this file is chosen instead of the empty one, so it throws at load time. And in Next's build transform step, the list of modules that must not be imported from the client layer includes the `server-only` we just saw.

```rust
// crates/next-custom-transforms/src/transforms/react_server_components.rs 719행
invalid_client_imports: vec![
    atom!("server-only").into(),
    atom!("next/headers").into(),
    atom!("next/root-params").into(),
],
```

`next-intl/server` is not on this list. The `getLocale` problem would have failed at call time, but until then, even as a static import, the build would not have caught it. `server-only`, however, is on the list, so the moment my file that imports it enters the client graph, the build stops it. I cannot add `next-intl/server` to the check list, but I made the file that uses it land on the list.

## Wrapping up

At first I thought fixing one line of `typeof window` would be the end of it, but explaining why that one line was the wrong question meant properly understanding the build graphs first. To sum up: the App Router has three build graphs, rsc, ssr, and client, and SSR runs on the server but is the client graph as far as React is concerned. A file with no directive gets its graph from whoever imports it, and a library, without knowing which graph it is in, only offers choices through `exports` conditions. If no condition matches, it goes to `default`. So a runtime branch cannot draw this boundary, and I chose to draw the line at build time with `server-only` and have the call site choose explicitly. With that, the work of taking three thousand silent errors a week down to zero was done. Both parts 1 and 2 were, at the root, about the same spot: a file pulled under `use client` getting compiled into a different shape in the ssr graph. One called the stub that `use server` had rewritten, the other called a stub because the `react-server` condition was missing. Only after writing both posts did the whole flow come into view.
