---
title: "Is React Query's staleTime: 0 really 0? And why?"
tags:
  - react
  - state-management
  - tanstack-query
  - debugging
published: true
date: 2026-10-03 21:00:00
description: 'I prefetched the data and even hydrated it, and queryFn was still called twice. In the last post I explained that as staleTime being 0, and the explanation was not right. In Suspense mode staleTime is clamped to a minimum of 1,000ms. I followed React Query and React internals to find out why that floor is needed, where the gap is measured, and what pushed my experiment past one second. The answer came down to two things: a suspended render leaves nothing behind, and the cause was the device environment, not the code.'
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

## Why is the floor one second

### Why a floor was needed

Let us start with the first one. Why did the React Query team clamp `staleTime` to a minimum of one second in Suspense mode? The comment in the code above says it is there to prevent unnecessary refetching when a component remounts after suspending. Why one second of all numbers is not clearly spelled out, so I will come back to it later and make a guess from Suspense's throttle.

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

### Why useQuery has no suspend option

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

The feature is gone now, and the PR does not say why. Before the removal, the maintainer TkDodo had already said in [issue #9988](https://github.com/TanStack/query/issues/9988) that suspending the very component that called `useQuery` felt too hacky and that the experimental flag should go. I then found [a post written around the same time](https://tkdodo.eu/blog/reliable-query-prefetching-with-tanstack-router) as the removal PR. It introduces loaders and does not address `experimental_prefetchInRender` directly, but it is about where an ideal request should start, so I read it as related context.

> The takeaway here should be that a component should, if possible, probably never initiate data fetching on its own. Yes, it’s great in theory that you have a fully self-contained component that has its own data requirements and resolves them automatically when it renders. But in practice, if that’s the only place where we fetch, we are 1) doing this probably way later than we ideally should and 2) we can easily introduce fetch waterfalls (with or without suspense)

To put it short, a component is better off not starting a fetch on its own. A structure where a component works out the data it needs as it renders is nice in theory, but if that is the only place you fetch, you end up far later than you ideally would, and waterfalls are easy to introduce whether or not Suspense is involved. `experimental_prefetchInRender` is also a structure that fetches when the component renders, so I read the intent behind removing it as not far from that message.

What is this ideal moment? Fetching during render is earlier than anything after the commit, so why call it later than ideal? Because tkDodo places that ideal moment before the render in the first place. So my guess is that calling `useQuery` outside Suspense and passing the result down disappeared, even though it works in theory, because loaders and prefetching before the render already exist and are faster, which left little reason to keep a detour through a promise. There is [a very well put together deck](https://research.yceffort.kr/slides/why-usequery-cannot-suspend-itself) that follows the same line of questions I had. If you are curious, take a look.

### Why 1,000ms of all numbers

Back to the question I set aside, why one second, I want to talk about Suspense's throttle mechanism. Let us look at the code in [React PR #26611](https://github.com/react/react/pull/26611).

> If a Suspense fallback is shown, and the data finishes loading really quickly after that, we throttle the content from appearing for 500ms to reduce thrash.
>
> This already works for successive fallback states (like if one fallback is nested inside another) but it wasn't being applied to the final step in the sequence: if there were no more unresolved Suspense boundaries in the tree, the content would appear immediately.
>
> This fixes the throttling behavior so that it applies to all renders that are the result of suspended data being loaded. (Our internal jargon term for this is a "retry".)

To summarize the PR: inside Suspense, from the moment the fallback is shown until the requested data is reflected on screen, React throttles by 500ms. That throttle was not applied to the last step in the sequence, and this change applies it through to the final retry after the suspended data arrives.

So React Suspense throttles by 500ms from the previous commit, which means that by the time it mounts, more time has gone by than the moment the data arrived. In the worst case, data arriving at 400ms and 523ms gets pushed back with an extra 500ms of throttle, so mounting can take several hundred more ms even after the data is there. It is not written down anywhere, but I would guess the one second is a number that accounts for all of the context up to this point. Otherwise a query could be fetched twice before it even reaches the UI.

### What is the throttle trying to prevent?

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

### Why 500ms became 300ms

But the reveal intervals in the numbers differed from the PR. The PR said the throttle was 500ms, while in the actual experiment reveals landed at 308ms, 608ms and 908ms, in 300ms steps. Had the value changed? And why lower the throttle from 500ms to 300ms? I dug through the PRs, and the explanation in [the PR I found, #26803](https://github.com/react/react/pull/26803), made the reason for throttling a little clearer.

> Now that the throttling mechanism applies more often, we've decided to lower this a tad to ensure it's not noticeable. The idea is it should be just large enough to prevent jank when lots of different parts of the UI load in rapid succession, but not large enough to make the UI feel sluggish. There's no perfect number, it's just a heuristic.

Since the previous PR (#26611) widened the throttle's reach, they lowered the optimal time from 500ms to 300ms to prevent the jank I had guessed at when the UI loads in rapid succession.

As for the number 300: because there is no perfect magic number, they settled on 300 heuristically, at a level where the UI does not feel sluggish. When a page loads a lot of data, a 500ms turn would certainly feel long on a page with many nested Suspense boundaries. In my experiment, three levels of nesting at 300ms already felt slow.

### When does it reveal?

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

`scheduleTimeout()` pushes the commit function back by the throttle time. What I found interesting is that `nextLanes` also handles the priority work I had guessed at. From the comment and the PR it is not the main purpose, but since it is waiting anyway, it gets on with it. So Suspense holds the commit back for up to 300ms even after the data has arrived. There is always a delay between the data arriving and the mount, and I took React Query's one second `staleTime` to be the value meant to cover that time.

## Where the time is measured

On to the second question. Where, and how, is this gap measured? The stale judgement needs two points in time: when the data arrived, and what time it is now. Let us follow the code to see where each one is stamped.

### Where the arrival time is stamped

[`query-core/src/query.ts`](https://github.com/TanStack/query/blob/fe053bf8e947cd869db91e10372bad3c41bc7b77/packages/query-core/src/query.ts#L312-L327) shows where `dataUpdatedAt` is stamped. When a fetch succeeds, `setData` is called and a `success` action is dispatched. The reducer takes that action and builds the new state with `successState`.

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

In the experiment, `prefetchQuery` runs in a Server Component, so this `Date.now()` is the server's clock. From there it flows into [`query-core/src/hydration.ts#L149-L157`](https://github.com/TanStack/query/blob/fe053bf8e947cd869db91e10372bad3c41bc7b77/packages/query-core/src/hydration.ts#L149-L157). On the server, `dehydrate` packs up the server query's state, and in the browser, `hydrate` builds a new client query from that state.

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

`dataUpdatedAt` is inside `...state`. The time the server stamped goes straight into the browser's cache. But notice that `dehydratedAt` is stamped here too. Why? It is clearly not needed to judge staleness. The reason it exists is that there is a way to hand a prefetch over as a promise without awaiting it. With that approach, one of the [ways to carry the server's cache to the browser](/en/2026/10/rendering-boundary-server-functions#ways-to-carry-the-servers-cache-to-the-browser) from the previous post, there is no `dataUpdatedAt` yet, so at hydrate time the client needs something to compare against its own cache to decide whether to overwrite it. As far as I can tell, that is what `dehydratedAt` is for.

### Where it is compared with now

Then, when the component mounts in the browser, the observer starts subscribing and `onSubscribe` runs. You can see it in [`query-core/src/queryObserver.ts#L110-L122`](https://github.com/TanStack/query/blob/fe053bf8e947cd869db91e10372bad3c41bc7b77/packages/query-core/src/queryObserver.ts#L110-L122).

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

Since there is hydrated data, `shouldLoadOnMount` is false and it moves on to the next condition. This is where `isStale` is decided, passing the observer's `staleTime` into `query.isStaleByTime`. That is the value `ensureSuspenseTimers`, the code from the start of this post, raised to 1,000ms.

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

`timeUntilStale` then computes how long is left until the data goes stale. This runs on the client, after the commit in which the subscription started, so this `Date.now()` is the browser's clock. The client was directly taking the difference between a time the server stamped and a time the browser read.

## Was my measurement valid

The reason I followed the library code all the way through is that the earlier experiment measured the gap with `Date.now()` inside a `useEffect`, and I wanted to check again whether that was a valid measurement. Looking at the flow above, the experiment and React Query's judgement are almost the same calculation. The judgement happens in `onSubscribe`, and that subscription and the `useEffect` run back to back right after the same commit. The stale judgement itself was fine.

But I had been reading that value as "the time that passed after the data arrived". A server-stamped time subtracted from a browser-read time turns out to mix two things together.

- The time that actually passed after the data arrived
- The difference between the server's clock and the browser's

The first is what the stale judgement set out to measure. The second is a timing error from a different environment.

## How wrong can a clock be

If there is an error in this calculation, it is not a problem of my experiment alone, because the same calculation sits inside React Query's stale judgement. Really it is a question of how far the server's clock and the user's device can drift apart, which in the end is a question of how far you want to support. Naturally, if the browser's clock is one second ahead of the server, the data looks one second older than it is, and if it is behind, one second newer.

- **When the browser's clock is ahead**: with Suspense's one second floor as the bar, a clock just one second ahead makes hydrated data stale the moment it mounts. Data received from the server gets refetched one more time, every time.
- **When the browser's clock is behind**: even with a `staleTime` of one minute, a clock an hour behind keeps that data fresh for an hour and a minute. You save requests, but you show old data.

How often does this happen? I asked an AI and it pointed me to [a Cloudflare post](https://blog.cloudflare.com/roughtime/). It is a study of Chrome's certificate error reports, and among the reports collected, 6.7% had a client clock more than 24 hours behind and 0.05% more than 24 hours ahead. The sample is only users who hit an error, so it is not a share of all users, but it does show that devices with a clock off by more than a day are not rare, and that being behind is far more common. And I could not find anywhere in the React Query code that corrects for this clock difference. Is there a way to fix it?

Thinking about how to remove the clock difference, could the `dehydratedAt` we saw earlier be used? Both `dehydratedAt` and `dataUpdatedAt` are stamped with the server's clock, so the difference between them is free of clock skew, and dehydrate is also the last step before things cross over to the client. Then, when hydrating in the browser, you could stamp a new time by going back that far on the browser's clock.

```ts
// something like this
const age = dehydratedAt - state.dataUpdatedAt // server clock minus server clock
const dataUpdatedAt = Date.now() - age // stamp again on the browser clock
```

So why did the React Query team not do this? What is the trade-off? Let us split the time from fetch to subscription into three segments.

| Segment                                 | Current approach | Server-delta approach                       |
| --------------------------------------- | ---------------- | ------------------------------------------- |
| fetch done → dehydrate                  | Counted          | Counted (server clock minus server clock)   |
| dehydrate → hydrate (transfer, JS load) | Counted          | **Missing**                                 |
| hydrate → subscribe                     | Counted          | Counted (browser clock minus browser clock) |
| Server vs browser clock difference      | Mixed in         | Not mixed in                                |

In the approach I had in mind, that whole segment drops out. It is the stretch where we cross from the server's clock to the browser's, so neither clock can measure it. And in my experiment, that segment was where most of the gap came from. With this simple server-delta approach, the `hydrated-stale` data would have been judged brand new and no refetch would have gone out. So the current approach counts every segment exactly on the majority of devices whose clocks are right, while the second approach is a little wrong on every device. Let us look at that segment more closely to see why.

## What made the one second in my experiment

Now the third question. What pushed my experiment past one second?

One thing to settle first. This experiment is not the situation I analyzed earlier as the reason for `staleTime`. What I said about why one second is needed was about plain `useSuspenseQuery` with no prefetch: the cache is empty, the component suspends, and on the retry a new observer subscribes, which is where the delay comes from. In the experiment, the data the server prefetched is already hydrated. The point was only that explaining it as `staleTime` 0 was wrong. The experiment itself does not suspend the component, and neither a retry nor a throttle happens. Even so, as long as `useSuspenseQuery` is in use, the 1,000ms bar applies all the same. A bar built to cover the time until a retry got applied to a different time: the time from the server receiving the data to the component mounting in the browser.

And the experiment ran the server and the browser on the same machine, my own. The clock difference is zero, so every measured value is time that actually passed.

```ts
useEffect(() => {
  const state = queryClient.getQueryState(options.queryKey)
  logMountDataAge(scenario, state?.dataUpdatedAt)
}, [])
```

Here are the results from running each scenario 30 times in dev mode. The last column is the time that actually passed (`Date.now() - dataUpdatedAt`).

| Scenario         | Request sequence | Median refetch | p95 refetch | Median gap at mount |
| ---------------- | ---------------- | -------------: | ----------: | ------------------: |
| `hydrated-stale` | ssr-direct → bff |        355.0ms |     371.0ms |           1,181.5ms |
| `hydrated-fresh` | ssr-direct only  |     no refetch |           — |           1,180.0ms |

### What is inside 1.18 seconds

From the moment the server receives the data to the moment the component mounts in the browser, this is what happens.

1. The server finishes the rest of the render and sends the HTML
2. The browser downloads the JS
3. It parses and executes the JS
4. React hydrates and the component mounts

On the same machine, transfer takes almost no time, so what is left is receiving, reading and running the JS. And that is where dev and prod diverge sharply.

|                     | dev (`next dev`)                                 | prod (`next build` then `next start`) |
| ------------------- | ------------------------------------------------ | ------------------------------------- |
| Minify              | No                                               | Yes                                   |
| Unused code removal | Almost none                                      | Removed by tree shaking               |
| React               | development build (warnings and checks included) | production build (checks stripped)    |
| Also shipped        | HMR runtime, error overlay                       | Nothing                               |

In dev the browser receives larger, unminified JS and hydrates with a React that still carries its checks. Measuring the JS for the same page, dev was 3,837KB and prod 484KB. And running the same experiment again on the Mac I am writing this on, dev came in at 169ms and prod at 66ms, both inside 1,000ms, and the request did not go out twice. The laptop that produced 1,181ms and this Mac that produced 169ms ran the same code in the same dev mode. What made the one second was not the code but the environment. (This is a rough test and a rough comparison for now; I plan to write a separate post about the build later.)

### When the device changes

Prod does not pin the number down either. Steps 3 and 4 above are CPU work, so even with the same bundle, the time depends on the device. I ran the prod build again with CPU throttling in Chrome DevTools.

| CPU throttling | Median data age at mount | refetch |
| -------------- | -----------------------: | ------- |
| None           |                     66ms | none    |
| 4x             |                    194ms | none    |
| 6x             |                    306ms | none    |

It is a simulation rather than a real device, and even at 6x it did not cross 1,000ms, but the same bundle went from 66ms to 306ms. Add a slow network and steps 1 and 2 stretch too. To sum up, when you prefetch, two things widen the gap at mount time: the time that actually passes until the JS is received and hydrated, and the clock difference between the server and the device. Both sit outside my code, and both vary with the user's device and network.

## Closing

So, starting from `staleTime`, I ended up walking through how React's Suspense rendering works. In the end, a suspended component leaves nothing behind, and knowing that properly is what let me answer the questions tangled up with `staleTime` and the ones that followed from it. Wondering how a retry differs from a remount and a re-render, and wondering why a minimum `staleTime` is needed at all, both came down to not understanding that one thing properly.

Back to the three questions I started with. The one second floor was built to cover the time until a retry after a suspend, and it applies just the same on the path where prefetched data is hydrated. The gap is measured between the `dataUpdatedAt` the server stamped and the `Date.now()` the browser reads at the moment it subscribes, and it mixes together the time that actually passed and the difference between the two clocks. And what pushed that value past one second in my experiment was not the code but the environment. I have not yet isolated exactly what it was, but the fact that the same code ranges from 66ms to 1,181ms depending on the device was itself the answer.

So the `staleTime` you give hydrated data is not a number for how long to keep using the cache. It is a number for how long it takes, on your users' devices, to get from the server receiving the data to the component mounting. Just as React's 300ms and React Query's 1,000ms are heuristics rather than perfect numbers, this value has to be set by looking at your bundle size, the devices people mostly use, and their network. The `staleTime` I was vaguely worrying about in [the last post](/en/2026/10/rendering-boundary-server-functions) is something I now feel I can set with reasons behind it.

Knowing how the things I use actually work matters more than I thought for seeing the wider context. I hope the hours I am putting in now keep stacking up as a layer for the decisions that matter later.
