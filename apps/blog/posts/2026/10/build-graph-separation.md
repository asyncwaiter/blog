---
title: '렌더링 경계[2]: typeof window는 그래프를 모른다'
tags:
  - react
  - nextjs
  - debugging
published: true
date: 2026-10-20 00:10:00
description: 'SSR이 살아나자 getLocale is not supported in Client Components 에러가 드러났다. typeof window 분기는 서버인지 브라우저인지만 알 뿐, 지금 코드가 rsc 번들인지 ssr 번들인지는 모른다. Turbopack이 rsc, ssr, client 세 그래프를 어떻게 가르는지 소스로 따라가고, 라이브러리가 exports 조건으로 그래프별 파일을 고르게 두는 원리를 실험으로 확인한 뒤, server-only로 경계를 빌드 타임에 긋는 쪽을 택했다.'
series: '렌더링 경계'
seriesOrder: 2
art:
  undraw: local-server
  hue: cyan
---

## Table of Contents

## 들어가며

저번 글의 작업으로 `ServerFunctions cannot be called during initial render` 에러와 네트워크 중복 요청이 해결됐다. 그런데 이 작업이 기존에 숨겨져있던 문제를 드러냈다. `getLocale is not supported in Client Components`이라는 에러가 발생했다. 왜 이 에러가 이제야 드러났을까? 그 이유는 간단하다. 이전에 실패하던 SSR이 성공했기 때문이다. 전에는 Server Function이 SSR 환경에서 돌아 `noServerCall`로 에러가 발생하고 클라이언트로 넘어갔었기에 그 뒤의 코드는 실행될 기회조차 없었는데, SSR이 거기를 통과하자 `getLocale` 함수를 클라이언트 컴포넌트에서 부를 수 없다는 에러가 드러난 것이다.

현재 서비스에서는 i18n으로 `next-intl`을 써서 다국어를 관리하고 있다. `getLocale`은 서버 전용 함수로 url을 읽어 locale을 전달해주는 함수이다. 그런데 이상했다. `getLocale`이 클라이언트 컴포넌트에서 불리는 곳은 없어보였기 때문이다. 원인은 예상치못한 곳에 있었다. 바로 api조립부였다. 현재 프로젝트에서는 서버와 클라이언트 컴포넌트에서 따로 환경을 신경쓰지않고 `authApi`만 호출해서 GET, POST 요청을 보낼 수 있도록 관리하고 있다. 이 객체를 조립하는 부분에서 서버와 클라이언트가 런타임 분기에 따라 의존성이 다르게 들어가게된다. 샌드박스용 코드 예시를 하나 보고 가자.

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

이렇게 통합 `authClient`를 제공하고 이게 런타임에서 돌아갈 때 header와 url이 결정되는 시스템이다. 여기서 헤더에 locale을 전달하기위해 `getLocale`을 사용중이었다. 그런데 애초에 왜 직접 url을 읽어서 전달하는지 의문이 들 수 있다. 이유는 서비스가 BFF 구조이기 때문이다. 브라우저는 같은 오리진의 /api로 요청하고, Next 서버가 쿠키에서 토큰을 꺼내 백엔드로 넘긴다. 브라우저에 토큰이 노출되지 않고 CORS도 신경 쓸 필요가 없다. 그런데 이렇게 하면 서버 컴포넌트든 클라이언트든 백엔드가 보는 요청의 주인은 항상 Next 서버가 되어버리고, 실제 유저의 locale 같은 정보는 사라진다. 그래서 헤더에 직접 실어서 전달하는 것이다.

그럼 다시 돌아와서 왜 이 부분이 문제가 되었을까? 바로 경계를 갈라줄거라 생각했던 이 한 줄 때문이다.

```ts
const isServer = typeof window === 'undefined'
```

서버인지 아닌지를 런타임에서 확인하고 있는데, 이건 실행 위치만을 알려줄 뿐 지금 이 코드가 어느 그래프에서 실행되고 있는지는 알지 못한다. SSR에서 실행되기에 런타임 기준으로는 `isServer`가 맞지만, 이게 실행되는 번들은 클라이언트 그래프이기 때문이다. 그래서 서버 헤더를 넣어주려 `getLocale`을 호출했는데, 그 번들에 들어있는 `next-intl/server`에는 `getLocale`이 아닌 stub밖에 없었던 것이다.

다시 말해보자면, `typeof window`는 서버냐 브라우저냐를 묻지만, `getLocale`이 존재하느냐는 rsc 번들이냐 ssr 번들이냐로 갈리고, 둘 다 서버다. 분기가 긋는 선과 문제가 있는 선이 다르다. 어떻게 이렇게 되는건지 세 가지 질문을 따라가며 알아가보도록 하자.

1. 서버, 브라우저 그래프는 어떻게 만들어지는가?
2. 그럼 라이브러리는 내가 지금 어떤 그래프에서 실행되고 있는지 어떻게 알 수 있을까? 실제로 브라우저 그래프 내에서도 달라야한다면 어떻게 처리할 수 있을까?
3. 해결 방법은?

## 서버와 브라우저 그래프는 어떻게 만들어지는가

하나씩 살펴보기로하자. Next.js에 들어가면 빌드 과정에 대해 안내하는 문서를 찾을 수 있다.

> Setup. Loads environment variables (.env files), validates your next.config, and generates a build ID.
> Route discovery. Scans the app/ and pages/ directories for routes, and detects root-level convention files like proxy and instrumentation. Generates TypeScript route definitions.
> Compilation. Bundles client, server, and edge code with Turbopack (or webpack). Transpiles TypeScript and JSX, tree-shakes unused code, and optimizes CSS and fonts.
> Static analysis. Classifies each route for prerendering versus on-demand rendering. Collects generateStaticParams output. With Cache Components, checks for prerender-blocking errors.
> Prerendering. Prerenders static pages and PPR shells to HTML. Generates RSC payloads for client-side navigation.
> Output. Writes the build to .next/. For output: 'standalone', bundles only the files needed at runtime. For output: 'export', generates a full static site. Prints the route table.

여기서 살펴보고자하는 단계는 세 번째 Compilation 단계이다. 이 단계에서 서버, 클라이언트 그래프가 분리되기 때문이다. 네 번째 정적 분석과 다섯 번째 프리렌더링은 3번이 만든 번들을 요청 없이 한 번 실행해보는 단계라, 그래프가 갈라지는 건 세 번째 단계에서 다 끝난다. 직접 `.next`의 산출물을 확인해보자.

![.next 산출물 디렉토리. server 아래 app, chunks, edge가 있고 static이 따로 있다](../images/rendering-boundary/build-result.png)

여기서 내가 처음에 오해했던 부분이 있다. 서버, 클라이언트 그래프의 구분이 `server`, `static` 디렉토리로 된다고 생각했지만 실제 그래프는 세 개였다. rsc가 실행되는 서버 그래프는 `server/chunks` 안으로 들어가고, 클라이언트 그래프는 `server/chunks/ssr`과 `static/chunks` 두 곳으로 나뉜다. 그러니까 `server` 안에서 돌아가는 것은 모두 서버 그래프일 거라고 착각했던 것이다. SSR은 서버 머신에서 돌지만, 하는 일은 클라이언트 컴포넌트를 렌더하는 것이라 React 입장에서는 클라이언트 그래프다. 이 그래프 경계가 나뉘는 과정을 코드로 살펴봤다. (앞으로의 코드는 `vercel/next.js` @9b87239 (canary, 2026-10-15), `next-intl@4.14.9` 기준이다.)

### 그래프마다 하나씩 있는 ModuleAssetContext

Turbopack은 그래프마다 `ModuleAssetContext`라는 객체를 하나씩 만들어둔다. 성능을 위해 rust로 짜여있는 코드인데 잘 이해가 되지않아서, 이 컨텍스트가 만들어지는 과정을 ts로 간략하게 짜달라고 AI에게 부탁했다.

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

그래프별로 Context가 존재하고, 객체 생성 시 들어가는 인자가 다르다. `process` 메서드 본문은 셋이 똑같다. 같은 코드가 다른 결과를 내는 건 순전히 이 다섯 인자가 달라서다. 인자를 하나씩 이해하면 그래프가 어떻게 만들어지는지 보이니 하나씩 알아보자.

### 첫 번째 인자, transitions

첫 번째 `transitions`는 `Map` 객체다. 키로 찾아서 쓰기 위한 것임을 알 수 있다.

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

이 `Map`은 빌드 시작 때 한 번 만들어두고 이후엔 읽기만 한다. 뒤에서 나올 `ClientDirectiveTransformer`가 `use client` 파일의 AST를 `import * as p from "./Button.tsx" with { "turbopack-transition": "next-ecmascript-client-reference" }` 이런 한 줄짜리 프록시로 교체해두면, 참조를 분석하는 단계에서 이 어노테이션의 이름을 들고 `Map`을 찾는다. `next-ecmascript-client-reference` 키에 걸린 객체는 `clientCtx`와 `ssrCtx`을 두 개 다 들고 있어서, 이 객체가 실행되면 같은 파일이 두 컨텍스트에서 각각 다시 `process`된다. 결국 교체된 import문에 적힌 이름을 보고 그 파일을 어느 컨텍스트로 보낼지 정해두는 `Map`이다.

### 두 번째 인자, compileTimeInfo

두 번째 `compileTimeInfo`는 환경별로 다른 상수를 치환하는 역할을 한다.

```ts
// packages/next/src/build/define-env.ts 272행
'process.browser': isClient,
```

`process.browser`가 서버에선 `false`, 클라이언트에선 `true`이듯 그래프 환경별 값이 들어간다. `NEXT_PUBLIC_` 환경변수도 여기서 번들에 박히게 된다. 참고로 `typeof window`는 여기 목록에 없다. 이건 치환되지 않고 런타임까지 그대로 간다.

### 세 번째 인자, moduleOptions

세 번째는 `moduleOptions`다. 여기에 "어떤 파일에 어떤 변환을 돌릴지" 규칙들이 들어간다. .tsx면 TS 제거 + JSX 변환 같은 공통 규칙은 세 컨텍스트가 같고, 다른 건 딱 디렉티브 처리 두 가지다.

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

`ClientDirectiveTransformer`는 rsc 컨텍스트에만 있다. 이게 하는 일은 파일이 SWC로 AST형식으로 변환되고, 이 AST에서 `use client`를 발견하면 원래 코드를 전부 버리고 위에서 본 프록시 한 줄로 변경하는 것이다.

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

rsc 컨텍스트가 `use client` 파일을 만나면 참조만 남기고 더 내려가지 않는다. 대신 첫 번째 인자의 `Map`을 통해 `ssrCtx`와 `clientCtx`가 같은 파일을 디스크에서 다시 읽는데, 이 두 컨텍스트에는 `ClientDirectiveTransformer`가 없어서 `use client`는 그냥 문자열로 남고 진짜 코드가 컴파일된다. 이게 ssr과 client에만 있어야 할 이유였다. 만약 ssr에도 이 변환기가 있었다면 `Button.tsx`를 읽을 때마다 또 프록시로 바뀌어서 끝없이 재귀됐을 것이다.

그리고 `use server`는 반대 방향이다. `server_actions` 변환이 rsc에서는 `Server` 모드로, ssr, client에서는 `Client` 모드로 돈다. rsc에서는 함수 본문을 그대로 두고 export를 `registerServerReference(fn, id)`로 감싸서 이 id로 호출될 수 있다고 등록하고, ssr, client에서는 본문을 지우고 export를 `createServerReference(id, callServer)` stub으로 교체한다. 저번 글의 Server Function 에러가 바로 이 stub을 SSR에서 호출했을 때 난 것이다. `useSuspenseQuery`의 `queryFn`이 `use server` 파일의 함수를 부르고 있었는데, 그 훅은 `use client` 아래에 있으니 ssr 그래프에서 컴파일됐고, 거기서 그 함수는 본문이 지워진 `createServerReference(id, callServer)` stub이었다. 렌더 중에 stub이 호출되자 `callServer` 자리에 꽂혀 있던 `noServerCall`이 `throw`한 것이다. 이 `callServer`가 왜 ssr에서는 `noServerCall`이고 브라우저에서는 진짜 fetch인지는 네 번째 인자를 소개할 때 알 수 있다.

정리하면 `use client`는 그래프를 분기시키는 디렉티브이고, `use server`는 같은 그래프 안에서 파일 내용을 변환하는 디렉티브다. 그래서 디렉티브가 없는 평범한 파일(내 `api/index.ts` 같은)은 둘 중 어느 변환도 건드리지 않고, 그 파일이 어느 그래프에 들어가느냐는 오로지 누가 import했느냐로 정해진다.

### 동적 import는 왜 빌드 검사를 피했을까

근데 여기서 또 궁금해지는게 생겼다. 그럼 빌드 검사를 우회하는 동적 파일 임포트, `await import()`는 내부적으로 어떻게 처리되고 있을까. 이게 어떻게 처리되기에 빌드 검사를 피하는걸까? 왜냐면 사실 이 문제가 빌드에서 발견되지 않고 런타임에서 발견된 이유가 `await import` 동적 임포트 방식이었기 때문이다. 그 이유를 코드로 살펴보자.

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

수집하는 게 `ImportDecl`, 즉 정적 import 선언문뿐이다. `await import()`는 함수 호출 표현식이라 애초에 수집되지 않는다. 그러니까 우회가 맞긴 한데, 피한게 이 문법 검사 하나뿐이었다. 참조 분석 단계는 `import()`도 똑같이 잡고 같은 resolve를 태우기 때문에, `next/headers`는 여전히 ssr 번들에 들어갔고 런타임에 `cookies()`를 부르는 순간 터졌다. 빌드 에러를 런타임 에러로 바꿔놓은 것뿐이었다.

실제로 문제가 됐던 부분을 정적 import로 바꿔보니 빌드가 바로 에러를 던졌다.

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

이 `Import traces`를 보면 그래프를 한눈에 확인할 수 있다. 같은 `lib/api/index.ts`가 `Server Component`, `Client Component Browser`, `Client Component SSR` 세 그래프에 전부 들어가 있다. Browser, SSR에서는 `SomeGuard.tsx`가 `[Server Component]`와 `[Client Component …]` 두 줄로 찍히는데, 그 줄이 `use client` 경계이고 거기서 컨텍스트가 바뀐 것이다. 아래에서 위로 읽으면 `layout.tsx`(rsc) → `SomeGuard.tsx`(rsc에서 만나 분기) → 같은 파일(client/ssr 컨텍스트로 재처리) → `lib/api/index.ts`(그 컨텍스트로 따라감)이다. 세 번째 인자에서 봤던 디렉티브 없는 파일은 누가 import했느냐로 그래프가 정해진다가 빌드 출력에 그대로 찍혀 있다. 그러니까 지금까지의 호출은 지난번에 이어 SSR에서 매번 실패하고 클라이언트에서만 작동하는 문제의 연장선이었던 것이다.

### 네 번째 인자, resolveOptions

다시 돌아와 네 번째 `resolveOptions`는 실제로 파일을 찾는 역할이다. `tsconfig`에 정의한 alias의 실제 위치, `node_modules` 탐색, 확장자 후보 순서 등을 담당한다. 위에 세 번째 인자와 하는 역할이 조금 헷갈리기도 했는데, `moduleOption`은 파일을 어떻게 처리할까였으면 이건 import에 적힌 문자열이 어느 파일이지를 찾는 쪽이다.

이 어느 파일이지가 그래프마다 다르게 답이 나온다는 게 핵심이다. 내 코드만이 아니라 `node_modules` 안의 라이브러리도 마찬가지다. 앞에서 미뤄둔 `callServer`가 변경되는 부분이 여기다. ssr 그래프에서 `react-server-dom-turbopack/client`를 찾으면 `node` 조건이 맞아 `client.node.js`가 골라지고, 이 파일 안에서는 `callServer` 자리에 `noServerCall`이 들어가있다. 브라우저 그래프에서는 `browser` 조건이 맞아 `client.browser.js`가 골라지고, 거기엔 진짜 fetch가 들어 있다. stub 코드는 둘이 똑같은데 stub이 부르는 React 파일이 달라서, 같은 호출이 SSR에서만 터진 것이다. React가 막은 게 아니라 `resolveOptions`가 ssr에 꽂아준 파일이 그렇게 짜여 있었던 것이다.

이번 `getLocale` 에러도 같다. 그래프별로 `resolveOptions`가 다르게 들어가는데, 핵심은 이 한 줄이다.

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

`AppSSR`이 목록에 없다. 그래서 ssr 컨텍스트의 resolve 조건에는 `react-server`가 들어가지 않는다. 이 조건이 `next-intl`의 `package.json`에서는 이렇게 되어있다.

```json
"exports": {
  "./server": {
    "react-server": "./dist/esm/production/server.react-server.js",
    "default":      "./dist/esm/production/server.react-client.js"
  }
}
```

같은 `'next-intl/server'` 문자열이 rsc 컨텍스트에서는 `react-server` 조건이 맞아 진짜 구현으로 들어갔고, ssr과 client 컨텍스트에서는 조건이 안맞기에 `default`인 stub으로 들어간다. 이게 빌드 타임에 끝나버리니 런타임의 `typeof window`는 이미 번들에 박힌 파일을 되돌릴 수 없는 것이다.

### 빌드가 끝나면 남는 것

이렇게 그래프별로 다른 인자가 들어가고, 빌드가 시작되면 `rscCtx`(ts 축약버전)를 시작으로 아래 과정을 거친다.

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

SWC가 파싱한 AST는 메모리에서만 쓰이고 버려진다. 결과는 각 그래프의 JS 텍스트 파일로 나온다. 빌드는 어느 파일이 어느 청크에 들어가느냐까지만 정하고, 그 청크 안의 어느 줄이 실행되느냐는 런타임이 정한다. 내 `typeof window` 전자의 문제를 후자의 도구로 풀려고 한 셈이었다.

### 브라우저 그래프는 왜 둘일까

이렇게 서버, 브라우저 그래프가 나뉘는 것을 확인했다. 근데 두 번째 질문으로 들어가기 전에, 왜 브라우저 그래프가 굳이 둘(ssr, client)일까? 첫 진입 요청 하나가 서버에서 브라우저까지 가는 길을 그려보면 아래와 같다.

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

2와 4가 같은 코드를 두 번 실행하는 건 각각 얻는 게 다르기 때문이다. 2는 JS 없이도 보이는 HTML을, 4는 클릭에 반응하는 살아있는 컴포넌트를 얻는다. 둘 중 하나만 하면 정적 문서거나 CSR이고, 둘 다 해야 빠른 첫 화면과 상호작용을 같이 가져갈 수 있다.

그런데 4는 2가 만든 DOM을 새로 그리는 게 아니다. `hydrateRoot`는 자기가 렌더한 트리와 이미 화면에 있는 DOM을 비교해서, 같으면 이벤트 핸들러만 붙이고 넘어간다. 그러니까 이 설계는 같은 컴포넌트는 서버에서 돌든 브라우저에서 돌든 같은 결과를 낸다는 전제 위에 서 있다. 컴포넌트는 입력이 같으면 출력이 같아야 한다는 React의 원칙이 SSR과 hydration이라는 형태로 코드에 박힌 것이다. ssr 그래프와 client 그래프가 같은 소스를 같은 방식으로 컴파일하는 것도 그 전제를 지키기 위해서다.

## 라이브러리는 자기가 어느 그래프에 있는지 어떻게 알까

여기서 두 번째 질문이 나온다. 라이브러리는 그럼 내가 지금 어떤 그래프에서 실행되고 있는지 어떻게 알 수 있을까? 이 라이브러리의 그래프는 어디서 만들어지는 것일까?

사실 이 부분은 npm에 한 번이라도 패키지를 올려봤다면 쉽게 알 수 있을 부분이다. 라이브러리는 사실 모른다. 대신 자기가 원하는 축으로 소스를 써서 각각 빌드하고, `package.json`의 `exports`에 이 조건이면 이 파일을 적어둔다. 고르는 건 Next.js의 resolve, 네 번째 인자가 한다. 예를 들어 서버 컴포넌트 그래프와 그 외를 다르게 제공하고 싶다면 `exports`를 `react-server`와 `default`로 나누면 된다. 이게 실제로 그래프별로 어떻게 다르게 읽히는지 눈으로 확인해보고자 아주 간단한 [실험](https://github.com/asyncwaiter/blog-experiment/commit/970829214f60dd7a15386dd22dcd491d144bf054)을 돌려봤다.

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

이렇게 `where-am-i`라는 패키지를 tsup으로 빌드해서 추가해봤다. 빌드 도구는 환경을 전혀 모른다. 그냥 `server.ts`와 `client.ts`를 각각 JS로 바꿨을 뿐이고, 환경 분기는 `exports`를 쓰는 개발자가 결정한다. 이를 서버 컴포넌트, 클라이언트 컴포넌트에서 호출해보았고 다음과 같은 결과가 나왔다.

![where-am-i 실험 결과. 서버 컴포넌트의 whereAmI()는 REAL: react-server graph를, 클라이언트 컴포넌트는 STUB: not react-server graph를 출력하고 브라우저 콘솔에도 같은 에러가 찍힌다](../images/rendering-boundary/where-am-i-result.png)

서버 컴포넌트에서는 의도한대로 `REAL: react-server graph`가 찍히고, 클라이언트 컴포넌트에서는 ssr로 돌아간 부분이 `STUB: not react-server graph`로 화면에 보이고 브라우저 그래프는 `console`에 같은 에러가 찍히는 것을 확인할 수 있었다.

### 같은 브라우저 그래프에서 ssr과 client를 가르려면

그렇다면 같은 브라우저 그래프임에도 불구하고 SSR과 client 그래프가 다르게 나와야한다면 어떻게 해야할까? 다른 축으로 `exports`를 쓰면 된다. Next가 넘기는 조건은 레이어마다 다르다.

| 레이어 | `react-server` | 플랫폼 조건 |
| ------ | -------------- | ----------- |
| rsc    | 있음           | `node`      |
| ssr    | 없음           | `node`      |
| client | 없음           | `browser`   |

`react-server`는 React가 정한 조건이고 `node`/`browser`는 Node.js 표준 조건이다. 라이브러리는 Next의 세 그래프를 모르고 이 조건 이름들만 알고, Next가 그래프마다 조건 세트를 다르게 넘기는 것이다. `react-server` 축으로 나누면 ssr과 client는 같은 파일을 받고, `node`/`browser` 축으로 나누면 다른 파일을 받는다. 아까 얘기했던 `noServerCall`이 딱 이 경우다. React Flight 클라이언트는 `node`/`browser`로 나눠서, ssr에서 호출되면 `noServerCall`로 바로 에러를 내고 browser에서 호출되면 진짜 `callServer`로 fetch한다.

```js
// next/dist/compiled/react-server-dom-turbopack/cjs/react-server-dom-turbopack-client.edge.production.js 2153행
function noServerCall() {
  throw Error(
    'Server Functions cannot be called during initial render. This would create a fetch waterfall. ...',
  )
}
```

브라우저용 빌드(`client.browser.production.js`)에는 이 함수가 없다. 같은 React인데 ssr과 browser가 다른 파일을 받으니, 1편의 에러는 ssr이 받은 파일에 그렇게 짜여 있어서 난 것이었다.

그런데 여기서 또 의문, 만약 Next에서 찾을 수 없는 이름으로 `exports`하면 어떻게 되는걸까? 그러니까 `"asyncwaiter": "./dist/server.js"` 이런식으로 한다면? `default`로 찾아간다. `exports`는 위에서 아래로 내려가며 내 조건 목록에 있는 첫 번째 키를 고르기 때문이다. 그런데 `default`도 설정되어있지않다? 그러면 빌드가 실패한다. 결국 라이브러리가 실행 위치를 아는게 아니라, 축을 골라 `exports`에 적어둔 대로 Next가 골라주는 것이다.

## 어떻게 해결할까

자 그러면 이제 어떻게 이걸 해결하는게 좋을까? 일단 지금 이 문제가 발생하는 이유가 컴포넌트에 상관없이 한 파일에서 서버 전용 함수를 import하고 있기 때문이니 조립부를 분리해야 한다. 클라이언트 api와 서버 api를 나누는 것이다.

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

export const clientAuthApi = new ApiClient('/api', clientHeaderProvider)

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

기존에는 사용처에 상관없이 하나로 쓸 수 있었지만, 이제 소비처에서 `serverAuthApi`/`clientAuthApi` 넣어주는 방식으로 써야 한다. 위에서 패키지를 만들었던 것처럼 `exports` 조건으로 같은 이름에 그래프별 다른 파일을 물려줄 수도 있었다. 하지만 그 방식은 `next-intl`이 그랬듯 잘못된 그래프에서 import해도 조용히 stub이 들어갈 뿐 알려주지 않는다. 빌드에서 실패하지 않고 런타임에 실패한다. 이번 에러가 생긴 구조가 바로 그것이었기에 소비처가 알고 써야한다는 비용은 있지만, 경계를 명확하게 분리하고 틀리면 빌드 단계에서 실패하도록 하는 쪽을 택했다.

그런데 헤더에 들어갈 locale이나 인증 정보처럼 아까 단계에서 2(ssr 번들)와 4(브라우저)가 정당하게 달라야 하는 값은 어떻게 할까? 2, 4가 각자 계산하지 말고 1(rsc 번들)이 결정해서 트리로 내려주도록 했다. `getLocale`은 1에서만 쓸 수 있으니 거기서 한 번 읽고, `NextIntlClientProvider`의 prop으로 실어 보내면 2, 4도 `useLocale()`로 같은 값을 받는다. 클라이언트 쪽 api는 값을 계산하지 않고 받기만 하면 된다. 1편 해결 과정에서의 prefetch도 결국 같은 방식이었다. 서버에서 결정한 걸 넘겨주는 구조.

### server-only가 하는 일

`server-only` 패키지의 내부 코드는 위에서 내가 만든 실험 패키지 수준으로 간단하다.

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

`react-server` 조건이 없는 그래프에서 import되면 빈 파일 대신 이 파일이 골라져 로드 시점에 에러가 발생하도록 했다. 그리고 Next의 빌드 변환 단계에 클라이언트 레이어에서 import하면 안 되는 모듈 목록에 위에서 본 `server-only`가 포함되어 있다.

```rust
// crates/next-custom-transforms/src/transforms/react_server_components.rs 719행
invalid_client_imports: vec![
    atom!("server-only").into(),
    atom!("next/headers").into(),
    atom!("next/root-params").into(),
],
```

여기에 `next-intl/server`는 이 목록에 없다. `getLocale` 문제는 호출 시점에 실패했긴 했겠지만, 그 전까진 정적 import였어도 빌드가 잡아주지 않았을 것이다. 하지만 `server-only`는 목록에 있으니, 그걸 import하는 내 파일이 클라이언트 그래프에 들어오는 순간 빌드가 막아준다. `next-intl/server`를 검사 목록에 넣을 수는 없지만, 그걸 쓰는 파일을 목록에 들어가게 만들어줬다.

## 마무리

처음엔 `typeof window` 한 줄을 고치면 끝날 줄 알았는데, 그 한 줄이 왜 틀린 질문인지를 설명하려면 빌드 그래프부터 제대로 알아야했다. 정리해보자면 App Router의 빌드 그래프는 rsc, ssr, client 셋이고, SSR은 서버에서 돌지만 React 기준으로는 클라이언트 그래프다. 디렉티브가 없는 파일은 누가 import했느냐로 그래프가 정해지고, 라이브러리는 자기가 어느 그래프에 있는지 모른 채 `exports` 조건으로 선택지만 준다. 조건이 안 맞으면 `default`로 간다. 그래서 런타임 분기로는 이 경계를 가를 수 없고, 빌드 타임에 `server-only`로 선을 긋고 소비처가 명시적으로 고르게 하는 쪽을 택했다. 이렇게 주 3천건의 조용한 에러를 0건으로 만든 작업이 끝이났다. 1, 2편 다 근본적으로는 `use client` 아래로 끌려 들어간 파일이 ssr 그래프에서 다른 모습으로 컴파일되는 그 자리에서 난 것이었다. 하나는 `use server`가 고쳐 쓴 stub을 불러서, 하나는 `react-server` 조건이 빠지고 stub을 불러서였다. 두 글을 쓰고 나니 전체 흐름이 보이게됐다.
