---
title: "Is React Query's staleTime: 0 really 0?"
tags:
  - react
  - state-management
  - tanstack-query
  - debugging
published: true
date: 2026-10-03 21:00:00
description: 'I prefetched the data and hydrated it, and 30 runs in dev mode still logged 60 requests. The conclusion from my last post, that staleTime 0 was the cause, was wrong. React Query raises staleTime to a 1,000ms floor in Suspense, and that number exists because React throttles reveals by 300ms after the fallback commit. In my experiment, content was revealed at 308ms, 608ms and 908ms.'
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

It prefetches in SSR and hydrates that, so it feels like the answer should be once. But in the `hydrated-stale` experiment from the previous post, running this code 30 times in dev mode logged 60 requests. `queryFn` was called twice per run.

Why twice? In the previous post I explained the doubling as `staleTime` being 0, and that explanation was not right. Let us look at React Query's `staleTime` internals to see why.

## staleTime 0 is not 0

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

So the reason the test produced twice the network requests is that more than a second had passed since the data arrived. To be sure, I added a step that logs the difference between `dataUpdatedAt`, set when it was prefetched in SSR, and `Date.now()` after mounting in the browser, and ran it again.

```ts
useEffect(() => {
  const state = queryClient.getQueryState(options.queryKey)
  logMountDataAge(scenario, state?.dataUpdatedAt)
}, [])
```

The last column is the age of the data at the remount (`Date.now() - dataUpdatedAt`).

| Scenario         | Request sequence | Median refetch | p95 refetch | Median data age at remount |
| ---------------- | ---------------- | -------------: | ----------: | -------------------------: |
| `hydrated-stale` | ssr-direct → bff |        355.0ms |     371.0ms |                  1,181.5ms |
| `hydrated-fresh` | ssr-direct only  |     no refetch |           — |                  1,180.0ms |

As expected, the result was over 1,000ms. That is why it was judged stale and the request went out twice.

But that one-second gap was created by the environment, not by the code. This experiment was in dev mode, which is why it took more than a second; running it in prod mode, where the bundle is optimized, load and hydration finish fast enough to land inside 1,000ms, and the second request does not happen.

Of course, even in prod mode a low-end device or network can take far longer than a second to load and hydrate, so a refetch can still occur. So the answer to the first question is "it could be once, it could be twice."

## Why 1,000ms of all numbers

That raises a question. Why did React Query delay the stale judgement by a whole second in Suspense? The comment in `suspense.ts` says it is to reduce unnecessary refetching when a component remounts after suspending.

Still, the doubt did not go away. Why does 1,000ms reduce unnecessary refetching? If data arrives at 300ms and that is reflected immediately, 700ms is a fairly big difference. Data usually arrives much faster than a second, so why leave that much delay? And if it is just generous padding, why does `useQuery` not use a 1,000ms floor too? I found the reason in [React PR #26611](https://github.com/react/react/pull/26611).

> If a Suspense fallback is shown, and the data finishes loading really quickly after that, we throttle the content from appearing for 500ms to reduce thrash.
>
> This already works for successive fallback states (like if one fallback is nested inside another) but it wasn't being applied to the final step in the sequence: if there were no more unresolved Suspense boundaries in the tree, the content would appear immediately.
>
> This fixes the throttling behavior so that it applies to all renders that are the result of suspended data being loaded. (Our internal jargon term for this is a "retry".)

To summarize the PR: inside Suspense, from the moment the fallback is shown until the requested data is reflected on screen, React throttles by 500ms. That throttle was not applied to the last step in the sequence, and this change applies it through to every commit.

So React already throttles by 500ms from the previous commit inside Suspense, which means that by the time it mounts, it takes longer than the moment the data arrived. In the worst case, data arriving at 400ms and 523ms can be pushed back with an extra 500ms of throttle, so React Query appears to have settled on about a second for the stale judgement. Otherwise a query could be fetched twice before it even reaches the UI.

## What is the throttle trying to prevent?

But why does React not reflect the data in the UI immediately? Is faster not better? The PR says it is to reduce thrashing.

When I first read the PR, I could not picture what thrashing would occur. It is a question of getting data into the UI, so what thrash is being reduced? Too many requests? Or yielding while a fallback is shown so more urgent work can run? The PR code gave me a hint.

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

But the reveal intervals in the numbers differed from the PR. The PR said the throttle was 500ms, while in the actual experiment reveals landed at 308ms, 608ms and 908ms, in 300ms steps. Had the value changed? And why lower the throttle from 500ms to 300ms? I dug through the PRs.

[The PR I found, #26803](https://github.com/react/react/pull/26803), made the reason for throttling clear.

> Now that the throttling mechanism applies more often, we've decided to lower this a tad to ensure it's not noticeable. The idea is it should be just large enough to prevent jank when lots of different parts of the UI load in rapid succession, but not large enough to make the UI feel sluggish. There's no perfect number, it's just a heuristic.

Since the previous PR (#26611) widened the throttle's reach, they lowered the optimal time from 500ms to 300ms to prevent the jank I had guessed at when the UI loads in rapid succession.

As for the number 300: because there is no perfect magic number, they settled on 300 heuristically, at a level where the UI does not feel sluggish. When a page loads a lot of data, a 500ms turn would certainly feel long on a page with many nested Suspense boundaries. In my experiment, three levels of nesting at 300ms already felt slow.

## When does it reveal?

While working through this mechanism there was a part that confused me, so let us check it as a quiz.

If the data arrives at 100ms, when is it revealed? The answer is 300ms, because the throttle started after the fallback commit.

Then if the data arrives at 324ms, when is it revealed? At 324ms. This was the confusing part, and the reason is that the throttle from the fallback commit has ended and there was no new commit.

Finally, data arrives at 100ms and 324ms. When is each revealed? At 300ms and 600ms, because a commit happened at 300ms and the throttle started again.

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

So, starting from `staleTime`, I ended up looking at how React's Suspense rendering works. I came to think you need to know all of this properly before you can set `staleTime` properly, which is what I was wondering about in the last post.

I used to think `staleTime` was just a cache duration you guess at, but it is really about understanding the gap between the data arriving from the server and the component mounting on screen. Of course, as with the throttling time PR and React Query's minimum `staleTime`, there is no perfect number and it stays a heuristic. Still, setting it to match my project's bundle size, the devices people actually use, and the country they are in makes it a way to cut network requests.
