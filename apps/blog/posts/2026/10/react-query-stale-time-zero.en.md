---
title: "Is React Query's staleTime: 0 really 0? And why?"
tags:
  - react
  - state-management
  - tanstack-query
  - debugging
published: true
date: 2026-10-03 21:00:00
description: 'I prefetched the data and even hydrated it, and queryFn was still called twice. In the last post I explained that as staleTime being 0, and the explanation was not right. In Suspense mode staleTime is clamped to a minimum of 1,000ms. This post follows why that floor is needed and why one second of all numbers, through the internals of React Query and React. The clues were that a suspended render leaves nothing behind, and the 300ms throttle in Suspense.'
art:
  undraw: alarm-clock
  hue: cyan
---

## Table of Contents

## How many times does queryFn run in the code below?

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
      <p>Scenario page</p>
      <Suspense fallback={<p>Loading</p>}>
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

It prefetches in SSR and hydrates that, so it feels like the answer should be once. But in the `hydrated-stale` experiment from [the previous post](/en/2026/10/rendering-boundary-server-functions), running this code 30 times in dev mode logged 60 requests. `queryFn` was called twice per run.

Why twice? In the previous post I explained the doubling as `staleTime` being 0, and that explanation was not right. In Suspense mode `staleTime` is not 0, it is clamped to a floor of 1,000ms, one second. Let us confirm that in React Query's internals.

## staleTime 0 is not 0 in Suspense mode

Looking at `suspense.ts` in `@tanstack/react-query@5.103.3`, `staleTime` in Suspense is not actually 0. Even when you pass 0, it is handled as a minimum of 1,000ms.

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

So the reason the test produced twice the network requests is not that more than 0 seconds had passed since the data arrived, but that more than one second had. There are three things here that puzzled me, and I want to dig into them.

1. Why is the floor set to one second?
2. Where and how is this gap measured?
3. What created that one second in my own environment?

## Why a floor was needed

Let us start with the first one. Why did the React Query team clamp `staleTime` to a minimum of one second in Suspense mode? The reason a floor is needed at all is written in a comment. The comment in the code above says it is there to prevent unnecessary refetching when a component remounts after suspending. Why one second of all numbers is not clearly spelled out, so I will come back to it later and make a guess from Suspense's throttle.

Let me restate the situation that comment describes. `useSuspenseQuery` starts the fetch during render and suspends. The render that was in progress is thrown away, and the observer created inside it disappears along with it. Then once the data has arrived, the retry creates a new observer that subscribes for the first time. So in the end, unlike `useQuery`, the data has already arrived by the time it subscribes. The stale judgement happens at that subscription, so with `staleTime` 0, more than zero has passed since the data arrived, the query is judged stale no matter what, and the network call goes out again. The floor is there to stop that.

But React components are supposed to be pure. They should produce the same result however many times they render, which means no side effects during render. And Suspense mode fetches during render. Strictly speaking that breaks the rule, so why does nothing go wrong? I went to the code.

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

[query-core/src/query.ts#L590-L609](https://github.com/TanStack/query/blob/fe053bf8e947cd869db91e10372bad3c41bc7b77/packages/query-core/src/query.ts#L590-L609) The code uses the `retryer` to check whether a request has already gone out and hands that same request back, so a repeated render does not fire the request again and again. Even when the previous render is thrown away, the new render picks up that request. When the request finishes, the query data changes, the promise resolves, and React starts a retry. A retry is not a re-render: if the component has never been committed, it is effectively mounting from scratch. Let us put that in a table.

|                            | Re-render                                                                           | Remount                                             | Retry                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| When it happens            | A state change, a parent re-render, a notification from a subscribed external store | When the key or the component type changes          | When the promise that caused the suspend resolves                                               |
| State just before          | Mounted and on screen                                                               | Mounted and on screen                               | Never committed (the fallback is on screen instead)                                             |
| Fiber                      | Carried over as is                                                                  | The old one is dropped and a new one is built       | Nothing was stored, so a new one is built                                                       |
| useState initializer       | Not run                                                                             | Run again                                           | Run again                                                                                       |
| Cleanup of earlier effects | Only effects whose dependencies changed                                             | All of them run                                     | Nothing to run (no effect ever ran)                                                             |
| React Query's observer     | The same observer is kept                                                           | The old observer unsubscribes, a new one subscribes | The first observer disappears without ever subscribing, a new one subscribes for the first time |

Once it has been committed, state survives a later suspend. Running the experiment and watching the console was a far more intuitive way to see this, and I put the experiment in [a separate repo](https://github.com/asyncwaiter/blog-experiment/blob/main/src/experiments/rerender-remount-retry/index.tsx). That left me with another question. If purity can be kept during render by folding everything into a single request, why does `useQuery` not offer the same option? It turns out [the feature did exist](https://github.com/TanStack/query/pull/7988/changes), but a [PR removing it](https://github.com/TanStack/query/pull/11221) landed in August 2026. It is a bit of a detour from the main thread, but going through it seemed useful for working with the library, so I want to take a look.

## Why useQuery has no suspend option

The feature was called `experimental_prefetchInRender`. Let us look at the code from the PR first.

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

The thing not to get wrong here is that `useQuery` sits outside Suspense, so its observer is never thrown away. It is called outside the boundary, and React's `use` is what makes the value awaited inside. The observer builds a promise and puts it on the result object, and handing that to `use` lets the promise be thrown during render, as if you were using `useSuspenseQuery`. In this PR example no observer subscribes after the data arrives, so there is a single request. But call `use` in the same component and the observer is thrown away, and on the retry a new observer subscribes and requests the `staleTime` 0 data again, because `useQuery` has no one second correction.

The feature was dropped this August, and the PR does not say why. Before the removal, the maintainer TkDodo had already said in [issue #9988](https://github.com/TanStack/query/issues/9988) that suspending the very component that called `useQuery` felt too hacky and that the experimental flag should go. I then found [a post written around the same time](https://tkdodo.eu/blog/reliable-query-prefetching-with-tanstack-router) as the removal PR. It introduces loaders and does not address `experimental_prefetchInRender` directly, but it is about where an ideal request should start, so I read it as related context.

> The takeaway here should be that a component should, if possible, probably never initiate data fetching on its own. Yes, it’s great in theory that you have a fully self-contained component that has its own data requirements and resolves them automatically when it renders. But in practice, if that’s the only place where we fetch, we are 1) doing this probably way later than we ideally should and 2) we can easily introduce fetch waterfalls (with or without suspense)

To put it short, a component is better off not starting a fetch on its own. A structure where a component works out the data it needs as it renders is nice in theory, but if that is the only place you fetch, you end up far later than you ideally would, and waterfalls are easy to introduce whether or not Suspense is involved. `experimental_prefetchInRender` is also a structure that fetches when the component renders, so the intent behind removing it did not read as far from that message.

What is this ideal moment? Fetching during render is earlier than anything after the commit, so why call it later than ideal? Because tkDodo places that ideal moment before the render in the first place. So my guess is that calling `useQuery` outside Suspense and passing the result down disappeared, even though it works in theory, because loaders and prefetching before the render already exist and are faster, which left little reason to keep a detour through a promise. There is [a very well put together deck](https://research.yceffort.kr/slides/why-usequery-cannot-suspend-itself) that follows the same line of questions I had. If you are curious, take a look.

## Why 1,000ms of all numbers

Back to the question I set aside, why one second, I want to talk about Suspense's throttle mechanism. Let us look at the code in [React PR #26611](https://github.com/react/react/pull/26611).

> If a Suspense fallback is shown, and the data finishes loading really quickly after that, we throttle the content from appearing for 500ms to reduce thrash.
>
> This already works for successive fallback states (like if one fallback is nested inside another) but it wasn't being applied to the final step in the sequence: if there were no more unresolved Suspense boundaries in the tree, the content would appear immediately.
>
> This fixes the throttling behavior so that it applies to all renders that are the result of suspended data being loaded. (Our internal jargon term for this is a "retry".)

To summarize the PR: inside Suspense, from the moment the fallback is shown until the requested data is reflected on screen, React throttles by 500ms. That throttle was not applied to the last step in the sequence, and this change applies it through to the final retry after the suspended data arrives.

So React Suspense throttles by 500ms from the previous commit, which means that by the time it mounts, more time has gone by than the moment the data arrived. In the worst case, data arriving at 400ms and 523ms gets pushed back with an extra 500ms of throttle, so mounting can take several hundred more ms even after the data is there. It is not written down anywhere, but I would guess the one second is a number that accounts for all of the context up to this point. Otherwise a query could be fetched twice before it even reaches the UI.

## What is the throttle trying to prevent?

But why does React not reflect the data in the UI immediately? Is faster not better? The PR says it is to reduce thrashing. When I first read the PR, I could not picture what thrashing would occur. It is a question of getting data into the UI, so what thrash is being reduced? Too many requests? Or yielding while a fallback is shown so more urgent work can run? The PR code gave me a hint.

The comment says it is to prevent too many loading states from appearing and disappearing too quickly. Say there are several Suspense boundaries. Without throttling, content would be reflected as the data arrives, and the loading fallbacks would flicker in and out one by one. I ran another sandbox experiment to see it.

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

This tests Suspense as siblings, nested, and not applied at all. Boundary delays were 80ms, 200ms and 350ms. `arrived` is when the data was ready, `revealed` is when React committed it, and `gap` is the throttle hold.

**Sibling Suspense — 2 reveal batches**

| #   | delay | arrived | revealed |   gap |
| --- | ----- | ------: | -------: | ----: |
| 0   | 80ms  |   107ms |    308ms | 201ms |
| 1   | 200ms |   226ms |    308ms |  82ms |
| 2   | 350ms |   378ms |    608ms | 230ms |

**Nested Suspense — 3 reveal batches**

| #   | delay | arrived | revealed |   gap |
| --- | ----- | ------: | -------: | ----: |
| 0   | 80ms  |   108ms |    308ms | 200ms |
| 1   | 200ms |   432ms |    608ms | 176ms |
| 2   | 350ms |   791ms |    908ms | 117ms |

**Baseline (no Suspense) — 3 reveal batches**

| #   | delay | arrived | revealed | gap |
| --- | ----- | ------: | -------: | --: |
| 0   | 80ms  |   197ms |    198ms | 1ms |
| 1   | 200ms |   319ms |    320ms | 1ms |
| 2   | 350ms |   553ms |    553ms | 0ms |

In Sibling and Nested you can see the throttle applied at every commit before the reveal. The Baseline, without Suspense, reflected the data within 1ms of arrival.

## Why 500ms became 300ms

But the reveal intervals in the numbers differed from the PR. The PR said the throttle was 500ms, while in the actual experiment reveals landed at 308ms, 608ms and 908ms, in 300ms steps. Had the value changed? And why lower the throttle from 500ms to 300ms? I dug through the PRs, and the explanation in [the PR I found, #26803](https://github.com/react/react/pull/26803), made the reason for throttling a little clearer.

> Now that the throttling mechanism applies more often, we've decided to lower this a tad to ensure it's not noticeable. The idea is it should be just large enough to prevent jank when lots of different parts of the UI load in rapid succession, but not large enough to make the UI feel sluggish. There's no perfect number, it's just a heuristic.

Since the previous PR (#26611) widened the throttle's reach, they lowered the optimal time from 500ms to 300ms to prevent the jank I had guessed at when the UI loads in rapid succession.

As for the number 300: because there is no perfect magic number, they settled on 300 heuristically, at a level where the UI does not feel sluggish. When a page loads a lot of data, a 500ms turn would certainly feel long on a page with many nested Suspense boundaries. In my experiment, three levels of nesting at 300ms already felt slow.

## When does it reveal?

While working through this mechanism there was a part that confused me, so let us check it as a quiz.

1. If the data arrives at 100ms, when is it revealed?
   The answer is 300ms, because the throttle started after the fallback commit.

2. Then if the data arrives at 324ms, when is it revealed?
   At 324ms. This was the confusing part, and the reason is that the throttle from the fallback commit has ended and there was no new commit.

3. Finally, the data arrives at 100ms and 324ms. When is each revealed?
   At 300ms and 600ms, because a commit happened at 300ms and the throttle started again.

You can see the related PR code below. The current main has a few more parameters on the functions, but the core flow is the same.

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

`scheduleTimeout()` pushes the commit function back by the throttle time. What I found interesting is that `nextLanes` also handles the priority work I had guessed at. From the comment and the PR it is not the main purpose, but since it is waiting anyway, it gets on with it.

## Closing

So, starting from `staleTime`, I ended up walking through how React's Suspense rendering works. In the end, a suspended component leaves nothing behind, and knowing that properly is what let me answer the questions tangled up with `staleTime` and the ones that followed from it. Wondering how a retry differs from a remount and a re-render, and wondering why a minimum `staleTime` is needed at all, both came down to not understanding that one thing properly. Knowing how the things I use actually work matters more than I thought for seeing the wider context. I hope the hours I am putting in now keep stacking up as a layer for the decisions that matter later.
