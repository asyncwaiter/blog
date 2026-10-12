---
title: 'ReactQuery의 staleTime: 0은 정말 0일까? 왜?'
tags:
  - react
  - state-management
  - tanstack-query
  - debugging
published: true
date: 2026-10-03 21:00:00
updated: 2026-10-12 21:41:41
description: 'prefetch하고 hydrate까지 했는데 queryFn이 두 번 호출됐다. 지난 글에서는 staleTime이 0이라서라고 설명했는데, 이 설명은 옳지 못했다. Suspense 모드에서 staleTime은 최소 1,000ms로 보정된다. 왜 최소값이 필요한지, 이 시간 차는 어디서 재는지, 내 실험에서 1초를 넘긴 건 무엇이었는지를 React Query와 React 내부 코드로 따라가 봤다. 핵심은 suspend된 렌더가 아무것도 남기지 않는다는 점이었다. 그리고 같은 코드라도 실행 환경에 따라 흐르는 시간은 달라진다.'
art:
  undraw: alarm-clock
  hue: cyan
---

## Table of Contents

## 아래 코드에서 queryFn은 몇 번 요청될까

```tsx
// ScenarioPage.tsx
'use client'

function UserCard() {
  const {data: user} = useSuspenseQuery({
    queryKey: ['user'],
    queryFn: () => getUser(),
    staleTime: 0,
  })

  return (
    <article>
      <strong>{user.name}</strong>
      <small>{user.id}</small>
    </article>
  )
}

export function ScenarioPage() {
  return (
    <main>
      <p>시나리오 페이지</p>
      <Suspense fallback={<p>로딩중</p>}>
        <UserCard />
      </Suspense>
    </main>
  )
}
```

```tsx
// page.tsx
export default async function Page() {
  const queryClient = getQueryClient()

  await queryClient.prefetchQuery({
    queryKey: ['user'],
    queryFn: () => getUser(),
  })

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ScenarioPage />
    </HydrationBoundary>
  )
}
```

SSR에서 prefetch를 하고 이를 hydrate했으니 한 번일 것 같다. 그런데 [이전 포스팅](/2026/10/rendering-boundary-server-functions)의 `hydrated-stale` 실험에서, 이 코드를 dev 모드에서 30회 돌렸을 때 요청이 60회 찍히는 것을 확인할 수 있었다. 매 실행마다 `queryFn`이 두 번 호출된 것이다.

왜 두 번 찍혔을까? 이전 포스팅에서는 두 배의 이유를 `staleTime`이 0이기 때문이라 설명했는데, 이 설명은 옳지 못했다. Suspense 모드에서 `staleTime`은 0이 아니라 최소 1,000ms, 1초로 설정된다. 이를 React Query 내부 코드로 확인해보자.

## Suspense 모드에서 staleTime 0은 0이 아니다

`@tanstack/react-query@5.103.3`의 `suspense.ts` 코드를 보면 Suspense에서는 `staleTime`이 사실 0이 아님을 알 수 있다. `staleTime`이 0이어도 최소 1,000ms로 처리되도록 하고 있다.

```ts
// suspense.ts
export const ensureSuspenseTimers = (
  defaultedOptions: DefaultedQueryObserverOptions<any, any, any, any, any>,
) => {
  if (defaultedOptions.suspense) {
    // Handle staleTime to ensure minimum 1000ms in Suspense mode
    // This prevents unnecessary refetching when components remount after suspending
    const MIN_SUSPENSE_TIME_MS = 1000

    const clamp = (value: number | 'static' | undefined) =>
      value === 'static'
        ? value
        : Math.max(value ?? MIN_SUSPENSE_TIME_MS, MIN_SUSPENSE_TIME_MS)

    const originalStaleTime = defaultedOptions.staleTime
    defaultedOptions.staleTime =
      typeof originalStaleTime === 'function'
        ? (...args) => clamp(originalStaleTime(...args))
        : clamp(originalStaleTime)
  }
}
```

결국 테스트에서 네트워크 요청이 2배 발생한 이유는, 데이터가 도착한 뒤 0초가 넘었기 때문이 아니라 1초가 넘었기 때문이다. 여기서 의아한 점 세 가지를 한 번 파볼 예정이다.

1. 왜 최소 1초로 설정이 되어 있는가?
2. 이 시간 차는 어디서, 어떻게 측정되고 있는가?
3. 내 실험 환경에서 이 1초를 만든 원인은 무엇인가?

## 왜 최소 1초로 설정되어 있을까

### 왜 최소값이 필요했을까

첫 번째부터 알아보자. 왜 리액트쿼리팀은 Suspense 모드 내에서 `staleTime`을 최소 1초로 설정했을까? 위 코드의 주석을 보면 suspend 뒤 리마운트될 때의 불필요한 refetch를 막기 위해서라고 한다. 다만 왜 하필 1초인지는 확실히 명시되어 있지 않았는데, 이 부분은 뒤에서 Suspense의 throttle을 근거로 추측해볼 예정이다.

주석이 말하는 상황을 다시 설명해보자면 이렇다. `useSuspenseQuery`는 렌더 중에 fetch를 시작하고 suspend된다. 이때 기존 render는 버려지고, 그 안에서 만들어진 observer도 함께 사라진다. 그리고 데이터가 도착한 뒤 재시도 때 새 observer가 만들어져 처음 구독한다. 결국 기존 `useQuery`와는 다르게 구독 시점에 이미 데이터가 도착해 있다는 것이다. stale 판정은 이 구독 시점에 이뤄지는데, `staleTime`이 0이라면 데이터가 도착한 지 시간이 0보다는 지나 있을 테니 무조건 stale 판정이 되고 네트워크 재호출이 발생한다. 최소값은 이를 막기 위한 것이다.

그런데 React의 컴포넌트는 순수해야 한다. 몇 번이고 렌더해도 동일한 결과를 내야하고, 그러기에 렌더 중 부수효과를 발생시키면 안된다. 근데 Suspense 모드에서는 렌더 중 fetch를 한다. 엄밀히는 규칙을 어기는 것인데, 왜 문제가 생기지 않을까? 코드를 직접 살펴보았다.

```ts
  async fetch(
    options?: QueryOptions<TQueryFnData, TError, TData, TQueryKey>,
    fetchOptions?: FetchOptions<TQueryFnData>,
  ): Promise<TData> {
    if (
      this.state.fetchStatus !== 'idle' &&
      // If the promise in the retryer is already rejected, we have to definitely
      // re-start the fetch; there is a chance that the query is still in a
      // pending state when that happens
      this.#retryer?.status() !== 'rejected'
    ) {
      if (this.state.data !== undefined && fetchOptions?.cancelRefetch) {
        // Silently cancel current fetch if the user wants to cancel refetch
        this.cancel({ silent: true })
      } else if (this.#retryer) {
        // make sure that retries that were potentially cancelled due to unmounts can continue
        this.#retryer.continueRetry()
        // Return current promise if we are already fetching
        return this.#retryer.promise
      }
```

[query-core/src/query.ts#L590-L609](https://github.com/TanStack/query/blob/fe053bf8e947cd869db91e10372bad3c41bc7b77/packages/query-core/src/query.ts#L590-L609) 코드를 보면 다시 렌더가 된다해도 몇 번이고 재요청하지 않도록, `retryer`로 이미 요청이 갔는지 확인하고 그 요청을 다시 돌려주고 있다. 이전 렌더가 버려지더라도 새로운 렌더가 그 요청을 이어받도록 하는 것이다. 그리고 이 요청이 끝나면 쿼리 데이터가 바뀌게 되고, Promise가 resolve되어 React에서 retry(재시도)를 시작한다. 여기서 재시도는 리렌더와 다르고, 한 번도 커밋된 적이 없다면 사실상 처음부터 다시 마운트하는 것과 같다. 표로 한 번 살펴보자.

|                        | 리렌더                                             | 리마운트                                      | 재시도 (retry)                                                 |
| ---------------------- | -------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| 언제 발생              | state 변경, 부모 리렌더, 구독한 외부 저장소의 알림 | key나 컴포넌트 타입이 바뀔 때                 | suspend를 일으킨 Promise가 resolve될 때                        |
| 직전 상태              | 마운트되어 화면에 있음                             | 마운트되어 화면에 있음                        | 커밋된 적 없음 (fallback이 대신 보임)                          |
| fiber 상태             | 그대로 이어 씀                                     | 기존 것을 버리고 새로 만듦                    | 저장된 것이 없어서 새로 만듦                                   |
| useState 초기화 함수   | 실행 안 됨                                         | 다시 실행됨                                   | 다시 실행됨                                                    |
| 이전 effect의 cleanup  | 의존성이 바뀐 effect만                             | 전부 실행됨                                   | 실행할 것이 없음 (effect가 돈 적 없음)                         |
| React Query의 observer | 같은 observer 유지                                 | 기존 observer는 구독 해제, 새 observer가 구독 | 첫 observer는 구독한 적 없이 사라지고, 새 observer가 처음 구독 |

한 번 커밋된 뒤 다시 suspend되면 state는 유지된다. 이건 실험을 돌려서 console이 찍히는 것을 보는게 훨씬 직관적이었다. 실험은 따로 [별도의 레포](https://github.com/asyncwaiter/blog-experiment/blob/main/src/experiments/rerender-remount-retry/index.tsx)에 올려두었다. 그런데 또 궁금해지는게 있었다. 이렇게 렌더 중에도 하나의 요청으로 만들어 순수성을 지키는게 가능했으면 왜 `useQuery`에서는 이런 옵션을 주지 않은걸까 싶어 찾아봤다. 그랬더니 실제로 [해당 기능을 지원](https://github.com/TanStack/query/pull/7988/changes)하는 부분이 있었으나 2026년 8월에 [이를 없애는 PR](https://github.com/TanStack/query/pull/11221)이 올라왔다. 기존 논점에서 조금 벗어난 감이 있으나, 이를 이해하고 넘어가는게 앞으로 라이브러리 사용에 도움이 될 것 같아 한 번 살펴보고 가려한다.

### useQuery는 왜 suspend 옵션이 없는걸까

이 기능은 `experimental_prefetchInRender`라고 불리는 기능이었으며, PR에 올라왔던 코드를 먼저 살펴보자.

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      experimental_prefetchInRender: true,
    },
  },
})

import React from 'react'
import {useQuery} from '@tanstack/react-query'
import {fetchTodos, type Todo} from './api'

function TodoList({query}: {query: UseQueryResult<Todo[]>}) {
  const data = React.use(query.promise)

  return (
    <ul>
      {data.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  )
}

export function App() {
  const query = useQuery({queryKey: ['todos'], queryFn: fetchTodos})

  return (
    <>
      <h1>Todos</h1>
      <React.Suspense fallback={<div>Loading...</div>}>
        <TodoList query={query} />
      </React.Suspense>
    </>
  )
}
```

```ts
// useBaseQuery.ts
 if (
    defaultedOptions.experimental_prefetchInRender &&
    !isServer &&
    willFetch(result, isRestoring)
  ) {
    const promise = isNewCacheEntry
      ? // Fetch immediately on render in order to ensure `.promise` is resolved even if the component is unmounted
        fetchOptimistic(defaultedOptions, observer, errorResetBoundary)
      : // subscribe to the "cache promise" so that we can finalize the currentThenable once data comes in
        client.getQueryCache().get(defaultedOptions.queryHash)?.promise

    promise?.catch(noop).finally(() => {
      if (!observer.hasListeners()) {
        // ...

    // `.updateResult()` will trigger `.#currentThenable` to finalize
    observer.updateResult()
```

여기서 오해하지 말아야했던 점이 `useQuery`는 Suspense 바깥에 있다는 점이다. 그래서 observer가 버려지지 않는다. Suspense 바깥에서 호출하고 이를 React의 `use`를 활용해 안쪽에서 값을 기다리게 만들고 있다. observer가 promise를 만들어 결과 객체에 넣어주고, 이를 `use`로 넘겨 `useSuspenseQuery`를 사용하는 것처럼 Promise가 렌더 중에 throw될 수 있도록 했다. 이 PR 예시에서는 데이터가 도착한 뒤 새로 구독하는 observer가 없어서 요청은 한 번이다. 하지만 같은 컴포넌트에서 `use`까지 호출하면 observer가 버려지고, 재시도 때 새 observer가 구독하면서 `staleTime` 0인 데이터를 다시 요청한다. `useQuery`에는 1초 보정이 없기 때문이다.

그리고 이 기능은 이제 사라졌으나, 그 이유에 대해서는 PR에 명시되어있지 않았다. 메인테이너인 TkDodo는 삭제 전 [이슈 #9988](https://github.com/TanStack/query/issues/9988)에서, `useQuery`를 호출한 컴포넌트를 그대로 suspend시키는 방식이 너무 꼼수 같다(too hacky)고 이 실험 플래그를 없애야 한다고 미리 말한 적이 있다. 그러다 삭제 PR이 올라온 [비슷한 시기에 쓰인 글](https://tkdodo.eu/blog/reliable-query-prefetching-with-tanstack-router)을 발견했고, loader를 소개하는 글이고 `experimental_prefetchInRender` 직접 다루지는 않는데, 이상적인 요청을 어디서 시작할지에 대한 이야기라 관련 맥락으로 읽었다.

> The takeaway here should be that a component should, if possible, probably never initiate data fetching on its own. Yes, it’s great in theory that you have a fully self-contained component that has its own data requirements and resolves them automatically when it renders. But in practice, if that’s the only place where we fetch, we are 1) doing this probably way later than we ideally should and 2) we can easily introduce fetch waterfalls (with or without suspense)

결국 요약하자면, 컴포넌트는 가능하면 스스로 fetch를 시작하지 않는 편이 좋다는 것이다. 컴포넌트가 렌더될 때 필요한 데이터를 알아서 fetching하는 구조는 이론상 좋지만, 거기서만 fetch하면 이상적인 시점보다 훨씬 늦어지고, Suspense를 쓰든 안 쓰든 waterfall이 생기기 쉽다고 말하고 있다. `experimental_prefetchInRender` 또한 결국 컴포넌트가 렌더될 때 fetch되는 구조이니, 이 기능을 없앤 의도와 전하고자 하는 메세지가 크게는 다르지 않다고 읽었다.

여기서 말하는 이상적인 시점이 뭘까? 렌더 중에 fetch하면 커밋 이후의 단계보다 더 빨리 fetch되는 것인데 왜 이상적인 시점보다 느리다고 말하는 것일까? 그건 tkDodo는 이 이상적 시점을 애초에 렌더 전으로 보고 있기 때문이다. 결국 Suspense 바깥에서 `useQuery`를 사용하고 이를 전달하던 방식이 이론상 문제없음에도 사라진 이유는, 렌더 전에 loader 사용이나 prefetch하는 방법이 이미 있고 그쪽이 더 빠르니 promise로 굳이 우회하는 방법을 남길 이유가 약했던 것이 아닐까 추측해본다. 지금까지 내가 가졌던 의문의 흐름에 대해 [굉장히 잘 정리된 자료](https://research.yceffort.kr/slides/why-usequery-cannot-suspend-itself)가 있다. 관심있는 분들은 확인해보시길 바란다.

### 왜 하필 1,000ms일까

그리고 다시 앞에서 미뤄둔, 왜 하필 1초일까에 대한 맥락으로 Suspense의 throttle 매커니즘에 대해 말해보려한다. [React PR #26611](https://github.com/react/react/pull/26611) 코드를 살펴보겠다.

> If a Suspense fallback is shown, and the data finishes loading really quickly after that, we throttle the content from appearing for 500ms to reduce thrash.
>
> This already works for successive fallback states (like if one fallback is nested inside another) but it wasn't being applied to the final step in the sequence: if there were no more unresolved Suspense boundaries in the tree, the content would appear immediately.
>
> This fixes the throttling behavior so that it applies to all renders that are the result of suspended data being loaded. (Our internal jargon term for this is a "retry".)

이 PR 내용을 요약하자면, Suspense에서 fallback이 화면에 보여지고 요청한 데이터를 화면에 반영하기까지 500ms throttle을 발생시킨다는 것이다. 그런데 마지막 시퀀스에서는 throttle이 발생하지 않았고, 이번 작업으로 suspended data가 도착하고 난 후 마지막 retry까지 throttle을 발생시킨다는 게 주된 내용이다.

즉 React Suspense는 직전 커밋부터 throttle을 500ms 줘버리니까, 이게 mount될 때쯤이면 데이터가 도착한 시간보다 더 오래 걸리게 된다. 최악의 상황에서 400ms, 523ms에 데이터들이 도착하면 반영되기까지 밀려서 throttle 500ms가 추가되어 버릴 수 있으니, 데이터가 도착하고도 마운트까지 수백 ms가 더 걸릴 수 있다. 명시적으로 쓰여 있진 않았으나 1초라는 숫자가 지금까지의 모든 맥락을 고려한 값이 아닐까 추측해봤다. 안 그러면 UI에 반영되기도 전에 두 번이나 fetch될 수 있으니 말이다.

### throttle은 무엇을 막으려는 걸까

그런데 React에서는 왜 데이터를 바로 UI에 반영하지 않고 이런 작업을 하는 걸까? 데이터는 빨리 보여줄수록 좋지 않나? 본문에서는 이를 thrashing을 줄이기 위해서라고 말한다. 처음에 이 PR을 읽었을 때, 어떤 thrashing이 발생하는 것일지 와닿지 않았다. 결국 data를 UI에 반영하기까지의 문제인데, 어떤 thrash를 줄이려고 한 걸까? 너무 요청이 많아서? 혹은 fallback을 보여주고 있으니 양보하고 더 급한 작업들을 처리하기 위해서? PR 코드를 보고 힌트를 얻었다.

주석을 보면, 너무 많은 로딩들이 빠르게 보였다 사라졌다 하는 것을 방지하기 위해서라고 한다. 예를 들어 여러 개의 Suspense가 존재할 때, 만약 throttle이 없다면 데이터가 오는 대로 화면에 반영할 것이다. 그러다 보면 loading fallback이 각각 보였다 사라졌다 버벅거리는 느낌이 나게 된다. 실제로 확인해보기 위해 샌드박스 실험을 또 돌려봤다.

```tsx
export function ThrottleExperiment({
  runId,
  delays,
}: {
  readonly runId: string
  readonly delays: readonly number[]
}) {
  const [started, setStarted] = useState(false)
  const startEpoch = useRef(0)

  useLayoutEffect(() => {
    startEpoch.current = Date.now()
    setStarted(true)
  }, [])

  if (!started) {
    return <p data-experiment-status="pending">Starting experiment…</p>
  }

  return (
    <MeasurementProvider
      startEpoch={startEpoch.current}
      expectedReveals={delays.length * 3}
    >
      <p data-experiment-status="running">
        Open the Console and Performance tabs to watch reveals land.
      </p>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 12}}>
        <section style={columnStyle} aria-label="Sibling Suspense column">
          <h2>Sibling</h2>
          <SuspenseColumn runId={runId} delays={delays} />
        </section>
        <section style={columnStyle} aria-label="Nested Suspense column">
          <h2>Nested</h2>
          <NestedSuspenseColumn runId={runId} delays={delays} />
        </section>
        <section style={columnStyle} aria-label="Baseline column">
          <h2>Baseline</h2>
          <BaselineColumn runId={runId} delays={delays} />
        </section>
      </div>
      <ResultsPanel delays={delays} />
    </MeasurementProvider>
  )
}
```

Suspense를 차례대로 형제, 중첩, 적용하지 않았을 때를 테스트한 결과다. 경계 지연은 80ms, 200ms, 350ms로 뒀다. `arrived`는 데이터가 준비된 시점, `revealed`는 React가 커밋한 시점, `gap`이 throttle로 붙잡아 둔 시간이다.

**Sibling Suspense — reveal 2회**

| #   | 지연  | arrived | revealed |   gap |
| --- | ----- | ------: | -------: | ----: |
| 0   | 80ms  |   107ms |    308ms | 201ms |
| 1   | 200ms |   226ms |    308ms |  82ms |
| 2   | 350ms |   378ms |    608ms | 230ms |

**Nested Suspense — reveal 3회**

| #   | 지연  | arrived | revealed |   gap |
| --- | ----- | ------: | -------: | ----: |
| 0   | 80ms  |   108ms |    308ms | 200ms |
| 1   | 200ms |   432ms |    608ms | 176ms |
| 2   | 350ms |   791ms |    908ms | 117ms |

**Baseline (Suspense 없음) — reveal 3회**

| #   | 지연  | arrived | revealed | gap |
| --- | ----- | ------: | -------: | --: |
| 0   | 80ms  |   197ms |    198ms | 1ms |
| 1   | 200ms |   319ms |    320ms | 1ms |
| 2   | 350ms |   553ms |    553ms | 0ms |

Sibling과 Nested에서 매 커밋마다 throttle이 적용되어 reveal되고 있음을 알 수 있다. Suspense를 쓰지 않은 Baseline은 데이터가 도착하자마자 1ms 안에 반영됐다.

### 500ms는 왜 300ms가 되었을까

그런데 수치 값에서 reveal의 간격이 위 PR과 다른 결과를 확인할 수 있었다. PR에서는 throttle이 500ms였으나, 실제 실험에서는 노출이 308ms, 608ms, 908ms로 300ms 단위로 되고 있었다. 값이 변경된 것일까? 그럼 또 500ms에서 300ms로 throttle 시간을 변경시킨 이유는 무엇일까? PR을 뒤져봤고, [찾은 PR #26803](https://github.com/react/react/pull/26803)의 설명을 보니 왜 throttling을 적용한 것인지 이유가 좀 더 명확해졌다.

> Now that the throttling mechanism applies more often, we've decided to lower this a tad to ensure it's not noticeable. The idea is it should be just large enough to prevent jank when lots of different parts of the UI load in rapid succession, but not large enough to make the UI feel sluggish. There's no perfect number, it's just a heuristic.

이전 PR(#26611)에서 throttle 범위를 넓혔으니, 빠른 연속된 UI 로드가 될 때 아까 예상했던 버벅임(jank)을 방지하기 위한 최적의 시간을 500ms에서 300ms로 낮췄다는 내용이다.

300이란 숫자는, 완벽한 magic number는 존재하지 않기에 UI가 느릿한(sluggish) 느낌이 들지 않는 수준에서 휴리스틱하게 300으로 정했다고 했다. 한 페이지에 많은 데이터들을 불러오는데 이 턴이 500ms이면 Suspense 중첩이 많은 페이지에서는 확실히 500은 조금 길게 느껴질 것이다. 실험을 통해서 300ms로 3번 중첩만 돼도 느리게 나타나는 느낌이 들었으니 말이다.

### 언제 reveal되는가

그런데 이 메커니즘을 이해하면서 헷갈리는 부분이 있었는데, 문제로 확인해보자.

1. 만약 데이터 도착이 100ms이면 언제 reveal될까?

   정답은 300ms이다. fallback 커밋 이후 throttle이 발생했기 때문이다.

2. 그럼 데이터가 324ms에 도착한다면 언제 reveal될까?

   324ms에 reveal된다. 이 부분이 조금 헷갈렸는데, fallback 커밋 후 300ms가 이미 지났고 그 사이에 fallback이 나타나거나 사라진 커밋도 없었기 때문이다.

3. 마지막으로 데이터가 100ms, 324ms에 도착한다. 각각 언제 reveal될까?

   300ms, 600ms가 될 것이다. 300ms에 첫 콘텐츠가 드러나면서 fallback이 사라졌고, 이 커밋이 throttle의 새 기준점이 되었기 때문이다.

관련 PR 코드는 아래에서 확인해볼 수 있다. 지금의 main과는 함수의 파라미터들이 더 추가된 부분들이 좀 다르긴 하지만 핵심 플로우는 동일하다.

```js
if (includesOnlyRetries(lanes)) {
  // This render only included retries, no updates. Throttle committing
  // retries so that we don't show too many loading states too quickly.
  const msUntilTimeout =
    globalMostRecentFallbackTime + FALLBACK_THROTTLE_MS - now()

  // Don't bother with a very short suspense time.
  if (msUntilTimeout > 10) {
    markRootSuspended(root, lanes)

    const nextLanes = getNextLanes(root, NoLanes)
    if (nextLanes !== NoLanes) {
      // There's additional work we can do on this root. We might as well
      // attempt to work on that while we're suspended.
      return
    }

    // The render is suspended, it hasn't timed out, and there's no
    // lower priority work to do. Instead of committing the fallback
    // immediately, wait for more data to arrive.
    // TODO: Combine retry throttling with Suspensey commits. Right now they
    // run one after the other.
    root.timeoutHandle = scheduleTimeout(
      commitRootWhenReady.bind(
        null,
        root,
        finishedWork,
        workInProgressRootRecoverableErrors,
        workInProgressTransitions,
        lanes,
      ),
      msUntilTimeout,
    )
    return
  }
}
commitRootWhenReady(
  root,
  finishedWork,
  workInProgressRootRecoverableErrors,
  workInProgressTransitions,
  lanes,
)
```

`scheduleTimeout()`에서 커밋 함수를 throttle 시간만큼 뒤로 미루는 것이다. 그리고 신기한 점은 `nextLanes`에서 아까 추측했던 우선순위 작업도 처리해주고 있었다. 주석이나 PR로 보면 이게 주 목적은 아니지만, 기다리는 김에 처리를 해주고 있는 듯했다. 이렇게 Suspense는 데이터가 도착한 뒤에도 커밋을 최대 300ms까지 미룬다. 데이터 도착과 마운트 사이에는 항상 delay가 있다는 뜻이고, ReactQuery의 staleTime 1초는 그 시간을 커버하기 위한 값으로 예상했다.

## 시간은 어디서 재는가

이제 두 번째 질문으로 넘어가자. 이 시간 차는 어디서, 어떻게 측정되고 있을까? stale 판정에는 두 개의 시간이 필요하다. 데이터가 언제 도착했는지, 그리고 지금이 언제인지다. 어디서 이 시간을 찍고 있는지 확인하기 위해 코드 흐름을 따라가보자.

### 도착 시각을 찍는 곳

[`query-core/src/query.ts`](https://github.com/TanStack/query/blob/fe053bf8e947cd869db91e10372bad3c41bc7b77/packages/query-core/src/query.ts#L312-L327) 코드를 보면 dataUpdatedAt을 찍는 곳을 알 수 있다. fetch가 성공하면 `setData`가 호출되고, `success` 액션이 dispatch된다. reducer는 이 액션을 받아 `successState`로 새 state를 만들어준다.

```ts
// query.ts
setData(
  newData: TData,
  options?: SetDataOptions & { manual: boolean },
): TData {
  const data = replaceData(this.state.data, newData, this.options)

  // Set data and mark it as cached
  this.#dispatch({
    data,
    type: 'success',
    dataUpdatedAt: options?.updatedAt,
    manual: options?.manual,
  })

  return data
}
//...

case 'success':
  const newState = {
    ...state,
    ...successState(action.data, action.dataUpdatedAt),
    dataUpdateCount: state.dataUpdateCount + 1,
    ...(!action.manual && {
      fetchStatus: 'idle' as const,
      fetchFailureCount: 0,
      fetchFailureReason: null,
    }),
  }

// ...

function successState<TData>(data: TData | undefined, dataUpdatedAt?: number) {
  return {
    data,
    dataUpdatedAt: dataUpdatedAt ?? Date.now(),
    error: null,
    isInvalidated: false,
    status: 'success' as const,
  }
}
```

실험 코드에서 `prefetchQuery`는 서버 컴포넌트에서 실행되기에, 이 `Date.now()`는 서버의 시계다. 그리고 [`query-core/src/hydration.ts#L149-L157`](https://github.com/TanStack/query/blob/fe053bf8e947cd869db91e10372bad3c41bc7b77/packages/query-core/src/hydration.ts#L149-L157) 코드로 이어지게 된다. 서버에서 `dehydrate`을 통해 서버 query의 state를 담고, 이를 브라우저에서 `hydrate`를 통해 그 state로 클라이언트 query를 새로 만든다.

```ts
// hydration.ts
export function dehydrateQuery(
  query: Query,
  serializeData?: TransformerFn,
  shouldRedactErrors?: (error: unknown) => boolean,
): DehydratedQuery {
  return {
    dehydratedAt: Date.now(),
    state: {
      ...query.state,

// ...

} else {
  // Restore query
  query = queryCache.build(
    client,
    {
      ...client.getDefaultOptions().hydrate?.queries,
      ...options?.defaultOptions?.queries,
      queryKey,
      queryHash,
      meta,
      _type: queryType,
    },
    // Reset fetch status to idle to avoid
    // query being stuck in fetching state upon hydration
    {
      ...state,
      data,
      fetchStatus: 'idle',
      // ...
    },
  )
}
```

`...state` 안에 `dataUpdatedAt`이 들어 있다. 서버가 찍은 시간이 브라우저의 캐시에 들어가는 것이다. 그런데 여기서보면 `dehydratedAt`도 찍히고 있는 것을 볼 수 있다. 이건 왜 찍는걸까? 분명 stale 여부를 판정하는데는 필요하지 않다. 그럼에도 `dehydratedAt` 시간을 찍는 이유는 prefetch를 await 하지않고 Promise로 넘길 수 있는 방법이 존재하기 때문이다. 이전 글에서 [서버의 캐시를 브라우저로 넘기는 방법](/2026/10/rendering-boundary-server-functions#서버의-캐시를-브라우저로-넘기는-방법들) 중 하나였던 요청을 await 하지 않고 Promise로 넘기면, `dataUpdatedAt`이 없으니 hydrate 시점에서 클라에서의 캐시와 비교해서 새로운 걸로 덮어쓸지 말지 판단해야하기 위해 찍고 있는 것으로 파악됐다.

### 지금 시각과 비교하는 곳

그리고 브라우저에서 컴포넌트가 마운트되면 observer가 구독을 시작하고, `onSubscribe`가 실행된다. [`query-core/src/queryObserver.ts#L110-L122`](https://github.com/TanStack/query/blob/fe053bf8e947cd869db91e10372bad3c41bc7b77/packages/query-core/src/queryObserver.ts#L110-L122) 쪽 코드를 보면 확인할 수 있다.

```ts
// queryObserver.ts
protected onSubscribe(): void {
  if (this.listeners.size === 1) {
    this.#currentQuery.addObserver(this)

    if (shouldFetchOnMount(this.#currentQuery, this.options)) {
      this.#executeFetch()
    } else {
      this.updateResult()
    }

    this.#updateTimers()
  }
}

// ...

function shouldFetchOnMount(
  query: Query<any, any, any, any>,
  options: QueryObserverOptions<any, any, any, any, any>,
): boolean {
  return (
    shouldLoadOnMount(query, options) ||
    (query.state.data !== undefined &&
      shouldFetchOn(query, options, options.refetchOnMount))
  )
}

function shouldFetchOn(
  query: Query<any, any, any, any>,
  options: QueryObserverOptions<any, any, any, any, any>,
  field: (typeof options)['refetchOnMount'] &
    (typeof options)['refetchOnWindowFocus'] &
    (typeof options)['refetchOnReconnect'],
) {
  if (
    resolveQueryValue(options.enabled, query) !== false &&
    resolveQueryValue(options.staleTime, query) !== 'static'
  ) {
    const value = resolveQueryValue(field, query)

    return value === 'always' || (value !== false && isStale(query, options))
  }
  return false
}

function isStale(
  query: Query<any, any, any, any>,
  options: QueryObserverOptions<any, any, any, any, any>,
): boolean {
  return (
    resolveQueryValue(options.enabled, query) !== false &&
    query.isStaleByTime(resolveQueryValue(options.staleTime, query))
  )
}
```

hydrate된 데이터가 있으니 `shouldLoadOnMount`는 false가 되고, 다음 조건으로 넘어간다. 여기서 `isStale`의 판정을 정하고 observer의 `staleTime`을 `query.isStaleByTime`에 넘긴다. 글을 시작할 때 봤던 코드 `ensureSuspenseTimers`가 1,000ms로 올려둔 이 값이다.

```ts
// query.ts
isStaleByTime(staleTime: StaleTime = 0): boolean {
  // no data is always stale
  if (this.state.data === undefined) {
    return true
  }
  // static is never stale
  if (staleTime === 'static') {
    return false
  }
  // if the query is invalidated, it is stale
  if (this.state.isInvalidated) {
    return true
  }

  return !timeUntilStale(this.state.dataUpdatedAt, staleTime)
}
```

```ts
// utils.ts
export function timeUntilStale(updatedAt: number, staleTime?: number): number {
  return Math.max(updatedAt + (staleTime || 0) - Date.now(), 0)
}
```

그리고 `timeUntilStale` 함수로 stale 상태가 되기까지 남은 시간을 계산한다. 여기는 구독이 시작된 커밋 이후의 클라이언트 시점이기에 `Date.now()`는 브라우저의 시계가 된다. 클라이언트에서 서버가 찍은 시각과 브라우저가 읽은 시간의 차이를 직접 구하고 있었다.

## 내 측정은 유효했을까

이렇게 라이브러리 코드 흐름을 끝까지 따라온 이유는, 이전 실험이 `useEffect` 안에서 `Date.now()`로 시간 차를 쟀는데, 이게 유효한 측정이었는지 다시 확인해보기 위함이었다. 위의 코드 흐름을 보면 결국 실험 측정과 React Query의 판정은 거의 같은 계산이었다. 왜냐면 판정은 `onSubscribe`에서 이뤄지는데, 이 구독과 `useEffect`는 같은 커밋 직후에 이어서 실행되기 때문이다. stale 판정에는 문제가 없었다.

그런데 나는 이 값을 "데이터가 도착한 뒤 흐른 시간"이라고 말했다. 하지만 서버가 찍은 시각에서 브라우저가 읽은 시각을 뺀 값에는 두 가지가 섞여 있다는 것을 알게됐다.

- 데이터가 도착한 뒤 실제로 흐른 시간
- 서버와 브라우저의 시계 차이

앞의 것은 stale 판정이 원래 재려던 값이고, 뒤의 것은 다른 환경의 시간 오차다.

## 시계가 다르면 얼마나 틀릴까

이 계산에 오차가 있다면 이 오차는 내가 한 실험만의 문제는 아니다. React Query의 stale 판정에도 똑같이 들어있기 때문이다. 그런데 이건 사실 서버와 사용자 디바이스의 시계가 얼마나 틀어져 있는지의 문제라, 결국 어디까지를 지원할 것이냐의 문제였다. 당연하게도 브라우저 시계가 서버보다 1초 만큼 빠르면 데이터는 실제보다 1초 만큼 오래된 것으로 보이고, 느리면 1초 만큼 새것으로 보이게 된다.

- **브라우저 시계가 빠를 때**: Suspense의 최소값 1초가 기준이라면, 시계가 1초만 빨라도 hydrate된 데이터는 마운트하자마자 stale이 된다. 서버에서 받은 데이터를 매번 한 번 더 refetch 하게 된다.
- **브라우저 시계가 느릴 때**: `staleTime`이 1분이어도 시계가 1시간 느리면, 그 데이터는 1시간 1분 동안 fresh로 남는다. 요청은 아끼지만 오래된 데이터를 보여주게 된다.

그럼 이 케이스는 얼마나 될까? AI를 통해 물어보니 [Cloudflare의 글](https://blog.cloudflare.com/roughtime/)을 알려줬다. 이 글은 Chrome의 인증서 오류 보고를 분석한 연구인데, 수집된 오류 보고 중 6.7%는 클라이언트 시계가 24시간 넘게 늦어 있었고 0.05%는 24시간 넘게 빨랐다고 한다. 오류가 난 사용자만 모은 표본이라 전체 사용자의 비율은 아니었지만, 시계가 하루 넘게 틀린 기기가 드물지 않다는 것, 그리고 느린 쪽이 훨씬 많다는 것을 알 수 있다. 그런데 React Query 코드에서는 이 시계 차이를 보정하는 부분을 찾지 못했다. 이걸 해결할 수 있는 방법이 있을까?

이 시계 차이를 없앨 방법을 생각해보면 앞에서 본 `dehydratedAt`을 사용할 수 있지 않을까? `dehydratedAt`과 `dataUpdatedAt`은 둘 다 서버 시계로 찍은 값이라 시계 차이가 사라지기 기도 하고, 클라이언트로 넘어가기 전 가장 마지막 단계이기도 하기 때문이다. 그리고 브라우저에서 hydrate할 때 브라우저 시계로 그 시간만큼 거슬러 올라간 시간을 다시 찍으면 될 것 같았다.

```ts
// 이런 식으로
const age = dehydratedAt - state.dataUpdatedAt // 서버 시계끼리 뺀 값
const dataUpdatedAt = Date.now() - age // 브라우저 시계로 다시 찍기
```

그런데 이렇게 리액트쿼리팀이 하지 않은 이유는 뭘까? 어떤 트레이드오프가 있을까? 데이터가 fetch된 뒤 구독까지의 시간을 세 구간으로 나눠보자.

| 구간                                | 지금 방식 | 서버시간차 방식               |
| ----------------------------------- | --------- | ----------------------------- |
| fetch 완료 → dehydrate              | 반영됨    | 반영됨 (서버 시계끼리 뺌)     |
| dehydrate → hydrate (전송, JS 로드) | 반영됨    | **빠짐**                      |
| hydrate → 구독                      | 반영됨    | 반영됨 (브라우저 시계끼리 뺌) |
| 서버와 브라우저의 시계 차이         | 섞임      | 섞이지 않음                   |

내가 생각한 방식에서는 저 구간이 통째로 빠진다. 서버 시계에서 브라우저 시계로 넘어가는 구간이라 어느 쪽 시계로도 잴 수 없기 때문이다. 그런데 내 실험에서 시간 차이를 만든 건 주로 이 구간이었다. 이 단순한 서버 시간차를 전달하는 방식이었다면 `hydrated-stale`의 데이터는 갓 받은 것으로 판정되어 refetch가 나가지 않았을 것이다. 결국 지금 방식은 시계가 맞는 대부분의 기기에서는 저 구간들을 모두 정확히 반영한지만, 두 번째 방식은 모든 기기에서 조금씩 틀리는 방식이 된다. 왜 그런건지 이 구간에 대해서 좀 더 자세히 알아보자.

## 내 실험에서 1초를 만든 것

이제 세 번째 질문이다. 내 실험에서 1초를 넘긴 건 무엇이었을까?

먼저 짚을 것이 있다. 이 실험은 첫 본문에서 staleTime의 이유로 분석했던 상황과는 다르다. 위에서 1초가 필요한 이유에 대해 말했던 건 prefetch 없이 단순 useSuspenseQuery만을 썼을 때, 캐시에 데이터가 없어서 컴포넌트가 suspend했고, 재시도 때 새 observer가 구독하면서 delay가 생긴다는 것이다. 근데 실험에서는 서버가 prefetch한 데이터가 이미 hydrate되어 있다. 다만 처음에 stale을 0이라 설명하는게 틀렸다는 것이 었고, 이 실험 자체는 컴포넌트는 suspend하지 않고, 재시도도 throttle도 일어나지 않는다. 그런데도 `useSuspenseQuery`를 쓰는 이상 1,000ms 기준은 똑같이 적용된다. 재시도까지의 시간을 커버하기 위해 만든 기준이, 서버에서 받은 데이터가 브라우저에서 마운트되기까지의 시간이라는 다른 시간에도 적용된 것이다.

그리고 실험은 서버와 브라우저가 같은 내 컴퓨터에서 돌았다. 시계 차이는 0이니, 측정값 전부가 실제로 흐른 시간일 것이다.

```ts
useEffect(() => {
  const state = queryClient.getQueryState(options.queryKey)
  logMountDataAge(scenario, state?.dataUpdatedAt)
}, [])
```

두 시나리오를 dev 모드에서 각각 30회씩 돌린 결과다. 마지막 열이 실제로 흐른 시간(`Date.now() - dataUpdatedAt`)이다.

| 시나리오         | 요청 순서        | refetch 중앙값 | refetch p95 | 마운트 시 시간 차이 중앙값 |
| ---------------- | ---------------- | -------------: | ----------: | -------------------------: |
| `hydrated-stale` | ssr-direct → bff |        355.0ms |     371.0ms |                  1,181.5ms |
| `hydrated-fresh` | ssr-direct only  |   refetch 없음 |           — |                  1,180.0ms |

### 1.18초 안에 들어 있는 것

서버에서 데이터를 받은 순간부터 브라우저에서 마운트되기까지는 이런 일이 일어난다.

1. 서버가 나머지 렌더를 마치고 HTML을 보낸다
2. 브라우저가 JS를 내려받는다
3. JS를 파싱하고 실행한다
4. React가 hydrate하고, 컴포넌트가 마운트된다

같은 컴퓨터라 전송에 걸리는 시간은 거의 없을 것이기에, 남는 건 JS를 받고, 읽고, 실행하는 시간이다. 그리고 이 부분이 dev와 prod에서 크게 갈린다.

|                     | dev (`next dev`)                       | prod (`next build` 후 `next start`) |
| ------------------- | -------------------------------------- | ----------------------------------- |
| 압축(minify)        | 안 함                                  | 함                                  |
| 쓰지 않는 코드 제거 | 거의 안 함                             | tree shaking으로 제거               |
| React               | development 빌드 (경고·검증 코드 포함) | production 빌드 (검증 코드 제거)    |
| 함께 실리는 것      | HMR 런타임, 에러 오버레이              | 없음                                |

dev에서 브라우저는 압축되지 않은 더 큰 JS를 받고, 검증 코드가 들어 있는 React로 hydrate한다. 같은 페이지의 JS 크기를 재보면 dev는 3,837KB, prod는 484KB였다. 그런데 이 차이만으로는 1초가 설명되지 않았다. 같은 실험을 지금 글을 쓰는 맥에서 다시 돌리면 dev는 169ms, prod는 66ms로 둘 다 1,000ms 안에 들어왔고, 요청은 두 번 나가지 않았다. 같은 dev 모드인데 노트북에서는 1,181ms, 맥에서는 169ms였다. 기기 차이로 보기엔 간격이 너무 컸다.

### 1초는 AI가 만들었다

1,181ms가 나온 노트북에서 실험을 다시 열어보니, 같은 실험이었지만 같은 테스트 코드가 아니었다. 실험 컴포넌트는 따로 복사해 둔 게 있어서 두 기기에서 같았지만, 측정하는 테스트 코드는 달랐다. 거기에 1.1초짜리 `waitFor`가 들어 있었다. AI에게 `staleTime`의 최소 시간 실험과 이 시간 측정의 차이까지 동시에 재라고 시켰었는데, 그 과정에서 들어간 것 같았다. 컴포넌트 쪽 실험 조건만 열심히 봤지 테스트 코드는 꼼꼼히 읽지 않았고, 그래서 그 1초가 들어간걸 모르고 있었다. 그럼에도 1초의 출처가 바뀌었을 뿐 기기마다 달라진다는 글의 결론은 그대로다. 다만 이번 일로 배운 게 있다. 이걸 늦게 발견한 데에는 테스트 코드를 레포에 올려두지 않은 탓도 있었다. 어떤 컴퓨터에서 돌리느냐에 따라 코드가 달랐고, 그 노트북이 손에 없던 며칠 동안은 확인조차 할 수 없었다. 그래서 테스트 코드도 [레포](https://github.com/asyncwaiter/blog-experiment/tree/main/src/app/hydration)에 올려뒀다. 그리고 앞으로는 컴포넌트만이 아니라 테스트 코드도 제대로 검증해야겠다고 다짐했다.

결국 다시 돌아와 숫자를 보면 모든게 맞아떨어진다. 1,181ms에서 1,100ms를 빼면 80ms 남짓이고, 내 맥에서 잰 169ms와 같은 자릿수다. `hydrated-fresh`가 refetch 없이도 1,180ms로 거의 같은 값을 찍은 것도, 두 시나리오가 같은 `waitFor`를 거쳤기 때문이었다. 글 첫 부분의 60회도 이 대기가 만든 숫자였다.

그래도 이 1초 덕분에 얻은 게 있었다. 왜 이렇게 차이가 나는지 파고들다 그 시간 안에 숨어 있던 두 값을 알게 됐기 때문이다. 기기 환경마다 달라지는 JS 로드 시간과, 서버와 브라우저의 시계 차이다.

### 기기가 달라지면

기기가 달라지면 실제로 시간이 달라진다는 건 실험으로 확인해볼 수 있다. prod라고 숫자가 고정되는 것이 아니다. 위 과정에서 3번과 4번은 CPU가 하는 일이라, 같은 번들이라도 기기 성능에 따라 걸리는 시간이 달라진다. Chrome DevTools의 CPU throttling으로 prod 빌드를 다시 돌려봤다. 이 실험은 [여기](https://github.com/asyncwaiter/blog-experiment/blob/main/scripts/measure.mjs)에 올려뒀다.

| CPU throttling | 마운트 시 데이터 나이 중앙값 | refetch |
| -------------- | ---------------------------- | ------- |
| 없음           | 66ms                         | 없음    |
| 4x             | 194ms                        | 없음    |
| 6x             | 306ms                        | 없음    |

실제 기기가 아니라 시뮬레이션이고 6x에서도 1,000ms를 넘지는 않았지만, 같은 번들인데 66ms가 306ms로 늘어났다. 여기에 느린 네트워크가 더해지면 더 길어진다. 지금까지 내용을 정리하면 prefetch 사용 시 마운트 시점의 시간 차이를 늘리는 건 결국 두 가지다. 서버에서 데이터를 받은 뒤 브라우저에서 마운트되기까지 실제로 흐르는 시간, 그리고 서버와 기기의 시계 차이다.

## 마치며

이렇게 `staleTime`에서 시작해 React의 Suspense 렌더링 동작 과정까지 알아보았다. 결국 suspend된 컴포넌트는 아무것도 남지 않는다는 이 핵심을 제대로 알고 있어야 `staleTime`에 얽혀있는 고민들과 추가로 이어진 의문에 대해 제대로 답할 수 있었다. retry가 리마운트, 리렌더와 무엇이 다른지 고민했던 것도, 최소 staleTime이 왜 필요한지 고민했던 것도 전부 이 한 가지를 제대로 몰라서였다.

처음에 던진 세 질문으로 돌아가면 이렇다. 최소 1초는 suspend 뒤 재시도까지의 시간을 커버하려고 만든 값인데, prefetch한 데이터를 hydrate하는 경로에도 똑같이 적용된다. 그 시간 차는 서버가 찍은 `dataUpdatedAt`과 브라우저가 구독하는 순간의 `Date.now()` 사이에서 재고, 거기에는 실제로 흐른 시간과 두 시계의 차이가 섞여 있다. 그리고 내 실험에서 그 값을 1초 넘게 만든 범인은 기기인 줄 알았는데, 추적해보니 측정 AI가 넣은 1.1초 대기였다. 실제 hydrate는 내가 가진 기기에서는 50~300ms로 floor 한참 아래였고, 그래서 저 테스트는 대부분의 환경에서는 refetch가 나지 않았을 것으로 예상된다. 그래도 그 1초 덕분에 그 안에 숨어 있던 두 값, 기기마다 달라지는 JS 로드 시간과 서버, 브라우저의 시계 차이를 알게 됐다.

그래서 hydrate한 데이터에 주는 `staleTime`은 캐시를 얼마나 오래 쓸지의 숫자가 아니라, 서버에서 데이터를 받은 뒤 사용자의 기기에서 마운트되기까지 얼마나 걸리는지를 정하는 숫자로 볼 수 있었다. React의 300ms도 React Query의 1,000ms도 완벽한 숫자가 아니라 휴리스틱이었듯, 이 값도 내 번들 크기와 주로 쓰는 기기, 네트워크를 보고 정해야 한다. [지난 글](/2026/10/rendering-boundary-server-functions)에서 막연히 고민했던 `staleTime`을 이제는 근거를 가지고 정해볼 수 있겠다 싶었다.

내가 쓰는 것에 대한 동작 원리를 제대로 아는 것은 더 많은 맥락을 보는데 너무 중요했다. 지금의 시간들이 훗날 중요한 판단을 위한 레이어로 꾸준히 쌓여가길.
