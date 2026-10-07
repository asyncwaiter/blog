---
title: 'ReactQuery의 staleTime: 0은 정말 0일까? 왜?'
tags:
  - react
  - state-management
  - tanstack-query
  - debugging
published: true
date: 2026-10-03 21:00:00
description: '글 다쓰고 다시작성해야함'
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

## 왜 최소값이 필요했을까

첫 번째부터 알아보자. 리액트쿼리팀은 Suspense 모드 내에서 왜 `staleTime`을 최소 1초로 설정했을까? 사실 왜 최소값이 필요한지는 코드 주석에 적혀 있었다. 위 코드의 주석을 보면 suspend 뒤 리마운트될 때의 불필요한 refetch를 막기 위해서라고 한다. 다만 왜 하필 1초인지는 어디에도 적혀 있지 않았다. 이 부분은 뒤에서 Suspense의 throttle을 근거로 추측해볼 예정이다.

주석이 말하는 상황을 다시 설명해보자면 이렇다. `useSuspenseQuery`는 렌더 중에 fetch를 시작하고 suspend된다. 이때 기존 render는 버려지고, 그 안에서 만들어진 observer도 구독 한 번 못 해보고 함께 사라진다. 요청은 그동안 캐시에서 끝나고, 데이터가 도착한 뒤 재시도 때 새 observer가 만들어져 처음 구독한다. 기존 `useQuery`와는 다르게 구독 시점에 이미 데이터가 도착해 있다는 것이다. stale 판정은 이 구독 시점에 이뤄지는데, `staleTime`이 0이라면 데이터가 도착한 지 시간이 0보다는 지나 있을 테니 무조건 stale 판정이 되고 네트워크 재호출이 발생한다. 최소값은 이를 막기 위한 것이다.

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

출처: [query-core/src/query.ts#L590-L609](https://github.com/TanStack/query/blob/fe053bf8e947cd869db91e10372bad3c41bc7b77/packages/query-core/src/query.ts#L590-L609)

코드를 보면 다시 렌더가 된다해도 몇 번이고 재요청하지 않도록, `retryer`로 이미 요청이 갔는지 확인하고 그 요청을 다시 돌려주고 있다. 이전 렌더가 버려지더라도 새로운 렌더가 그 요청을 이어받도록 하는 것이다. 그리고 이 요청이 끝나면 쿼리 데이터가 바뀌게 되고, Promise가 reolve되어 React에서 retry(재시도)를 시작한다. 여기서 재시도는 리렌더와 다르고, 한 번도 커밋된 적이 없다면 사실상 처음부터 다시 마운트하는 것과 같다. 표로 한 번 살펴보자.

|                        | 리렌더                                             | 리마운트                                      | 재시도 (retry)                                                 |
| ---------------------- | -------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| 언제 발생              | state 변경, 부모 리렌더, 구독한 외부 저장소의 알림 | key나 컴포넌트 타입이 바뀔 때                 | suspend를 일으킨 Promise가 resolve될 때                        |
| 직전 상태              | 마운트되어 화면에 있음                             | 마운트되어 화면에 있음                        | 커밋된 적 없음 (fallback이 대신 보임)                          |
| fiber 상태             | 그대로 이어 씀                                     | 기존 것을 버리고 새로 만듦                    | 저장된 것이 없어서 새로 만듦                                   |
| useState 초기화 함수   | 실행 안 됨                                         | 다시 실행됨                                   | 다시 실행됨                                                    |
| 이전 effect의 cleanup  | 의존성이 바뀐 effect만                             | 전부 실행됨                                   | 실행할 것이 없음 (effect가 돈 적 없음)                         |
| React Query의 observer | 같은 observer 유지                                 | 기존 observer는 구독 해제, 새 observer가 구독 | 첫 observer는 구독한 적 없이 사라지고, 새 observer가 처음 구독 |

한 번 커밋된 뒤 다시 suspend되면 state는 유지된다. 이건 실험을 돌려서 console이 찍히는 것을 보는게 훨씬 직관적이었다. 실험은 따로 [별도의 레포](https://github.com/asyncwaiter/blog-experiment/blob/main/src/experiments/rerender-remount-retry/index.tsx)에 올려두었다. 그런데 또 궁금해지는게 있었다. 이렇게 렌더 중에도 하나의 요청으로 만들어 순수성을 지키는게 가능했으면 왜 `useQuery`에서는 이런 옵션을 주지 않은걸까 싶어 찾아봤다. 그랬더니 실제로 [해당 기능을 지원](https://github.com/TanStack/query/pull/7988/changes)하는 부분이 있었으나 2026년 8월에 [이를 없애는 PR](https://github.com/TanStack/query/pull/11221)이 올라왔다. 기존 논점에서 조금 벗어난 감이 있으나, 이를 이해하고 넘어가는게 앞으로 라이브러리 사용에 도움이 될 것 같아 한 번 살펴보고 가려한다.

## useQuery는 왜 스스로 suspend하지 않을까

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
import { useQuery } from '@tanstack/react-query'
import { fetchTodos, type Todo } from './api'

function TodoList({ query }: { query: UseQueryResult<Todo[]> }) {
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
  const query = useQuery({ queryKey: ['todos'], queryFn: fetchTodos })

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

## 왜 하필 1,000ms일까

그런데 여기서 궁금한 점이 생긴다. React Query는 왜 Suspense에서 1초나 stale 판정을 지연시킨 걸까? `suspense.ts` 주석을 살펴보면 suspense 이후 컴포넌트가 remount 되었을 때 불필요한 refetch를 줄이기 위해서라고 한다.

그럼에도 의문이 가시지 않는다. 왜 1,000ms가 불필요한 refetch를 줄여주는 걸까? 실제로 데이터 도착 시간을 300ms로 가정했을 때, 이게 바로 반영이 된다면 700ms는 꽤나 큰 차이이다. 데이터는 보통 1초보다 훨씬 빨리 도착하는데 왜 지연을 저만큼이나 둔 걸까? 만약 그냥 넉넉하게 둔 것이라면 `useQuery`는 왜 최소 시간을 1,000ms로 두지 않은 걸까? 그 이유는 [React PR #26611](https://github.com/react/react/pull/26611)에서 확인할 수 있었다.

> If a Suspense fallback is shown, and the data finishes loading really quickly after that, we throttle the content from appearing for 500ms to reduce thrash.
>
> This already works for successive fallback states (like if one fallback is nested inside another) but it wasn't being applied to the final step in the sequence: if there were no more unresolved Suspense boundaries in the tree, the content would appear immediately.
>
> This fixes the throttling behavior so that it applies to all renders that are the result of suspended data being loaded. (Our internal jargon term for this is a "retry".)

이 PR 내용을 요약하자면, Suspense에서 fallback이 화면에 보여지고 요청한 데이터를 화면에 반영하기까지 500ms throttle을 발생시킨다는 것이다. 그런데 마지막 시퀀스에서는 throttle이 발생하지 않았고, 이번 작업으로 모든 커밋에 마지막까지 throttle을 발생시킨다는 게 주된 내용이다.

즉 React에서 애초에 Suspense 안에서 직전 커밋부터 throttle을 500ms 줘버리니까, 이게 mount될 때쯤이면 데이터가 도착한 시간보다 더 오래 걸리게 된다. 최악의 상황에서 400ms, 523ms에 데이터들이 도착하면 반영되기까지 밀려서 throttle 500ms가 추가되어 버릴 수 있으니, React Query에서는 이를 고려해 1초 정도를 stale하게 판정한 것으로 보인다. 안 그러면 UI에 반영되기도 전에 두 번이나 fetch될 수 있으니 말이다.

## throttle은 무엇을 막으려는 걸까

그런데 React에서는 왜 데이터를 바로 UI에 반영하지 않고 이런 작업을 하는 걸까? 데이터는 빨리 보여줄수록 좋지 않나? 본문에서는 이를 thrashing을 줄이기 위해서라고 말한다.

처음에 이 PR을 읽었을 때, 어떤 thrashing이 발생하는 것일지 와닿지 않았다. 결국 data를 UI에 반영하기까지의 문제인데, 어떤 thrash를 줄이려고 한 걸까? 너무 요청이 많아서? 혹은 fallback을 보여주고 있으니 양보하고 더 급한 작업들을 처리하기 위해서? PR 코드를 보고 힌트를 얻었다.

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

그런데 수치 값에서 reveal의 간격이 위 PR과 다른 결과를 확인할 수 있었다. PR에서는 throttle이 500ms였으나, 실제 실험에서는 노출이 308ms, 608ms, 908ms로 300ms 단위로 되고 있었다. 값이 변경된 것일까? 그럼 또 500ms에서 300ms로 throttle 시간을 변경시킨 이유는 무엇일까? PR을 뒤져봤다.

[찾은 PR #26803](https://github.com/react/react/pull/26803)의 설명을 보니 왜 throttling을 적용한 것인지 이유가 명확해졌다.

> Now that the throttling mechanism applies more often, we've decided to lower this a tad to ensure it's not noticeable. The idea is it should be just large enough to prevent jank when lots of different parts of the UI load in rapid succession, but not large enough to make the UI feel sluggish. There's no perfect number, it's just a heuristic.

이전 PR(#26611)에서 throttle 범위를 넓혔으니, 빠른 연속된 UI 로드가 될 때 아까 예상했던 버벅임(jank)을 방지하기 위한 최적의 시간을 500ms에서 300ms로 낮췄다는 내용이다.

300이란 숫자는, 완벽한 magic number는 존재하지 않기에 UI가 느릿한(sluggish) 느낌이 들지 않는 수준에서 휴리스틱하게 300으로 정했다고 했다. 한 페이지에 많은 데이터들을 불러오는데 이 턴이 500ms이면 Suspense 중첩이 많은 페이지에서는 확실히 500은 조금 길게 느껴질 것이다. 실험을 통해서 300ms로 3번 중첩만 돼도 느리게 나타나는 느낌이 들었으니 말이다.

## 언제 reveal되는가

그런데 이 메커니즘을 이해하면서 헷갈리는 부분이 있었는데, 문제로 확인해보자.

만약 데이터 도착이 100ms이면 언제 reveal될까? 정답은 300ms이다. fallback 커밋 이후 throttle이 발생했기 때문이다.

그럼 데이터가 324ms에 도착한다면 언제 reveal될까? 324ms에 reveal된다. 이 부분이 조금 헷갈렸던 부분인데, 이유는 fallback 커밋 이후의 throttle은 끝이 났고 새로운 커밋이 없었기 때문이다.

마지막으로 데이터가 100ms, 324ms에 도착한다. 각각 언제 reveal될까? 300ms, 600ms가 될 것이다. 이유는 300ms에 커밋이 되었고, throttle이 발생했기 때문이다.

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

`scheduleTimeout()`에서 커밋 함수를 throttle 시간만큼 뒤로 미루는 것이다. 그리고 신기한 점은 `nextLanes`에서 아까 추측했던 우선순위 작업도 처리해주고 있었다. 주석이나 PR로 보면 이게 주 목적은 아니지만, 기다리는 김에 처리를 해주고 있는 듯했다.

## 마치며

이렇게 `staleTime`에서 시작해 React의 Suspense 렌더링 동작까지 알아보았다. 이 모든 것들을 제대로 알고 있어야, [지난 글](/2026/10/rendering-boundary-server-functions)에서 고민했었던 `staleTime`에 대해 제대로 정할 수 있겠구나 싶었다.

`staleTime`은 그냥 예측으로 정하는 캐싱 시간 정도라 생각했는데, 사실 이건 서버에서 데이터가 오고 나서 화면에 마운트되기까지의 간격을 파악하는 일이었다. 물론 앞선 throttling time PR이나 React Query 최소 `staleTime`에서처럼 완벽한 숫자는 없고 휴리스틱한 숫자겠지만, 지금 내 프로젝트의 번들 크기, 주로 사용되는 기기, 국가 환경에 따라 알맞게 설정한다면 네트워크 요청을 최적화할 수 있는 방법이 되기 때문이다.
