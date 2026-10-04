---
title: 'Rendering Boundaries[1]: Server Functions cannot be called during initial render'
tags:
  - react
  - nextjs
  - debugging
  - tanstack-query
published: true
date: 2026-10-01 20:00:00
description: 'I traced an error that was piling up in DataDog at about 3,000 a week. The cause was that useSuspenseQuery runs queryFn during render, before commit, and a Server Function was sitting inside it. Instead of the advice to switch to useQuery, I pulled the read function out of the use server file and the error went to zero. But when I measured 30 runs in the same sandbox, the requests came back as 60. The server and the browser have different queryClients.'
series: 'Rendering Boundaries'
seriesOrder: 1
art:
  undraw: server-error
  hue: cyan
---

## Table of Contents

## Introduction

This post is a record of how I solved a problem at a rendering boundary. It comes in two parts. Part 1 is about the trial and error of separating a server function and how I fixed it; part 2 is about the follow-up work, where I forced the build graph to stay split. It is written for people who want to look into the internals of `useQuery` and `useSuspenseQuery`, Server Actions, and how SSR and browser rendering are implemented in Next.js.

## The problem

I found an error in DataDog that was being logged roughly three thousand times a week.

```text
Server Functions cannot be called during initial render.
This would create a fetch waterfall.
Try to use a Server Component to pass data to Client Components instead.
```

Why was a server function being logged during render? I had an AI take a first look, and it pointed at the part using `useSuspenseQuery`. A Server Action was sitting inside `useSuspenseQuery`, so it told me to switch to `useQuery`. But three things did not make sense to me.

1. How does switching to `useQuery` fix the problem?
2. Why does this approach create a fetch waterfall?
3. What are the ways to use a Server Component here?

Before answering those, let us look at the code where the problem happened. Below is a mini app that reproduces it and nothing more.

```tsx
// ScenarioPage.tsx
'use client'
// imports omitted...

function BrokenUserCard() {
  const {data: user} = useSuspenseQuery({
    queryKey: ['user', 'broken'],
    queryFn: () => getUserAction(),
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
      <p>Error scenario page</p>
      <Suspense fallback={<p>Loading</p>}>
        <BrokenUserCard />
      </Suspense>
    </main>
  )
}
```

```ts
// actions.ts
'use server'

import {fetchUser, type User} from './user'

export async function getUserAction(): Promise<User> {
  return fetchUser() // a mock API with nothing but a delay
}
```

The offending code was in a Client Component. It was wrapped in `Suspense` and fetching data with `useSuspenseQuery`, and a Server Function had gone into `queryFn`. Now that we have seen the code, let us answer the first question.

## Why does switching to useQuery make the error disappear

To answer that, I first had to know how `useQuery` and `useSuspenseQuery` differ. In `@tanstack/react-query@5.103.3`, `useSuspenseQuery` differs from `useQuery` in that it passes `suspense: true` into the base query. To see how that option is used, let us look at `useBaseQuery`.

```ts
// useBaseQuery.ts
export function useBaseQuery(options, Observer, queryClient) {
  // ...

  // note: this must be called before useSyncExternalStore
  const result = observer.getOptimisticResult(defaultedOptions)

  const shouldSubscribe = !isRestoring && subscribed
  React.useSyncExternalStore(
    React.useCallback(
      (onStoreChange) => {
        const unsubscribe = shouldSubscribe
          ? observer.subscribe(notifyManager.batchCalls(onStoreChange))
          : noop

        // Update result to make sure we did not miss any query updates
        // between creating the observer and subscribing to it.
        observer.updateResult()

        return unsubscribe
      },
      [observer, shouldSubscribe],
    ),
    () => observer.getCurrentResult(),
    () => observer.getCurrentResult(),
  )

  React.useEffect(() => {
    observer.setOptions(defaultedOptions)
  }, [defaultedOptions, observer])

  // Handle suspense -> the suspense case is handled first, here
  if (shouldSuspend(defaultedOptions, result)) {
    throw fetchOptimistic(defaultedOptions, observer, errorResetBoundary)
  }

  // ...
}

export const shouldSuspend = (defaultedOptions, result) =>
  defaultedOptions?.suspense && result.isPending
```

React Query looks large and complicated, but at its core it manages a `QueryCache` object with the observer pattern. The code uses `useSyncExternalStore` to manage those external objects, and that `subscribe` runs after commit. The `shouldSuspend` check and the `throw`, however, happen before that, during render. When `shouldSuspend` is `true`, the code throws a Promise through `fetchOptimistic` right away. In other words, `useQuery` runs `queryFn` after commit inside `subscribe`, while `useSuspenseQuery` runs `queryFn` optimistically, while the component is still rendering, before commit.

The order for `useSuspenseQuery` looks like this.

1. Render starts, cache is empty → pending by default
2. `throw fetchOptimistic()` → inside it, `query.fetch()` → `queryFn()` runs
3. The throw aborts the render → no commit, no `subscribe`
4. Once the Promise settles, React renders from the start again
5. The state is no longer pending → the `if` is skipped → `return result` → commit → `subscribe`

My problem was step 2: a Server Function was called during render. The service has two pieces of logic that fetch user information, and both lived in the same file. It was a `'use server'` file that collected the parts updating cookie information at login, and a GET request with nothing to do with cookies had ended up in there. That was the one going into `useSuspenseQuery`. Because `useSuspenseQuery` runs it during the render phase of the SSR pass, it raised the error.

The reason it never showed up on screen is that once execution moves from SSR to the browser, the same query runs again as a real fetch, succeeds, and leaves only the log behind.

So, back to the first question. Why does the problem not happen with `useQuery`? The answer is in the code of the two hooks. `useQuery` has no `suspense` option, so there is no `queryFn` call during render. In SSR the `subscribe` never happens, so the function is not called at all and first runs on the browser pass.

But switching to `useQuery` means losing `Suspense`, and beyond that: is "no server function call during render" really enough reason to use it? Why is calling a Server Function during render a problem in the first place? Other functions are fine, so why only server functions?

## Why only Server Functions break during render

How much did I actually know about Server Functions? I read the [React docs](https://react.dev/reference/rsc/server-functions) and the [Next.js docs](https://nextjs.org/docs/app/getting-started/updating-data) again, slowly.

> Server Functions are designed for Mutations that update server-side state; they are not recommended for data fetching. Accordingly, frameworks implementing Server Functions typically process one action at a time and do not provide a way to cache the return value.
>
> — React docs

> A Server Action runs as a POST request against the page that invokes it. At build time, the `'use server'` directive tells the compiler to swap the function's implementation in client bundles for a reference (an action ID plus a dispatcher) that POSTs back to the server. The implementation stays on the server, but the route is reachable to anyone who can send the same POST. Treat every action as an untrusted entry point.
>
> — Next.js docs

As both documents say, server functions are designed for mutations that update server-side state. They are a POST request made from the browser to the server. So what happens when you call one during an SSR render? There is no browser to send the request, and it turns into the strange shape of the server calling itself through a browser. React does not support that, and raises the error I hit. The internal implementation that produces it looks like this.

```js
function noServerCall() {
  throw new Error(
    'Server Functions cannot be called during initial render. ...',
  )
}

export function createServerReference(id, callServer) {
  // the callServer that was passed in is ignored and noServerCall is wired in
  return createServerReferenceImpl(id, noServerCall)
}
```

```js
// actions.ts as produced by the bundler (client build)
import {createServerReference, callServer} from '...'

export const getUserAction = createServerReference('40abc...', callServer)
```

So when a Server Action is imported into the client at build time, the function becomes a reference to a particular id, and it runs through `createServerReference`. During SSR, though, that does not hand over the real function: `noServerCall` throws immediately. `useSuspenseQuery` fails as a consequence, that information travels to the browser, and the request is made again. Only then can `queryFn` run through `callServer`.

The [React Suspense docs](https://react.dev/reference/react/Suspense) say that when a component throws on the server, React does not abort the render: it puts the nearest `Suspense` fallback into the HTML and starts rendering again on the client. I wanted to know how that is implemented internally, so that an error turns into a retry instead of a failure.

## Why the screen was fine even though an error was thrown

```js
// react/packages/react-server/src/ReactFizzServer.js

renderSuspenseBoundary() {
  // ...
} catch (thrownValue: mixed) {
  newBoundary.status = CLIENT_RENDERED;
  let error: mixed;
  if (request.aborted) {
    contentRootSegment.status = ABORTED;
    error = request.fatalError;
  } else {
    contentRootSegment.status = ERRORED;
    error = thrownValue;
  }

  const thrownInfo = getThrownInfo(task.componentStack);
  const errorDigest = logRecoverableError(
    request,
    error,
    thrownInfo,
    __DEV__ ? task.debugTask : null,
  );
  encodeErrorForBoundary(/* ... */)
}
```

When a throw happens inside a `Suspense` boundary, Fizz does not fail the whole request. It marks only that boundary as `CLIENT_RENDERED`, passes the error to the `onError` callback through `logRecoverableError` (this is the log that showed up in DataDog), and stores the returned digest on the boundary. Then, during flush, it sends that status along with a specific comment in the HTML. The comments are these.

```js
// packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js

const SUSPENSE_START_DATA = '$' // boundary completed normally
const SUSPENSE_END_DATA = '/$'
const SUSPENSE_PENDING_START_DATA = '$?' // still streaming
const SUSPENSE_FALLBACK_START_DATA = '$!' // failed on the server, client must render
```

When the client meets `SUSPENSE_FALLBACK_START_DATA` in the HTML, it does not hydrate that boundary and renders it from scratch instead. The logic calls `retrySuspenseComponentWithoutHydrating`.

```js
// packages/react-reconciler/src/ReactFiberBeginWork.js

if (isSuspenseInstanceFallback(suspenseInstance)) {
  // This boundary is in a permanent fallback state. In this case, we'll never
  // get an update and we'll never be able to hydrate the final content.
  // Let's just try the client side render instead.
  const {digest} = getSuspenseInstanceFallbackErrorDetails(suspenseInstance)
  const error = new Error(
    'The server could not finish this Suspense boundary, likely due to ' +
      'an error during server rendering. Switched to client rendering.',
  )
  error.digest = digest
  const capturedValue = createCapturedValueFromError(error, digest, stack)
  return retrySuspenseComponentWithoutHydrating(
    current,
    workInProgress,
    renderLanes,
    capturedValue,
  )
}
```

This is why no error appeared on screen and it recovered with only a log. Without `Suspense` it would have surfaced like any other error. I used to think `Suspense` was good because it lets you write code knowing the data is there and gives you a loading fallback, but looking at this, `Suspense` is also a boundary that makes error and render handling possible. It ships a comment inside the HTML from SSR, and when the client meets that comment it can decide how to handle everything from that point on.

Honestly, until now I thought of Server Functions as just server functions for touching a database or handling sensitive data; I do not think I had really understood what the docs were saying. Server Functions have to be used properly. The conditions are roughly POST, no caching, and sequential execution.

Why does a server function have to be a POST? First, for GET, which fetches data, Next.js already does that work by reading the data during SSR and building the HTML. As the lower part of the Next.js docs explains, GET is considered safe in HTTP, so caching and prefetching apply. Put a mutation on a GET and the cache answers instead, so the change is not reflected, and a CDN cache cannot tell users apart, so you receive someone else's response.

Now I can answer the second question: why does this create a fetch waterfall? A call happening during render means the request only starts once the render reaches that point. `Suspense` points are wired in series, so the next request can only run after the previous one finishes.

> I checked this with an experiment, and it only applies to nesting; sibling nodes ran in parallel. Even nesting can go out in parallel if you hydrate with a prefetch.

In the end, I came to think the fetch waterfall this error talks about is the one created by not doing the work during the initial render, in SSR, where the server is already running, and instead making another server call later through the browser. That is why it recommends passing the data down from a Server Component, to avoid this round trip.

## The fix I chose

Putting all of this together, `useQuery` is not an answer either. Calling `queryFn` from the browser with `useQuery` only removes the error by never calling it on the server, and the browser still sends a read as a POST. It erases the symptom.

So instead of switching to `useQuery`, I pulled the plain user read out of the `'use server'` file. It is now an ordinary function rather than a Server Action, so calling it during SSR does not throw `noServerCall`. The server calls the API with GET itself, and so does the browser. That works here because the request does not need cookies.

After the deploy, this error message went straight to zero. But only the error is gone; the structure where the request starts during render is unchanged.

## Zero errors, twice the requests?

Then my mentor gave me feedback. This was not a problem to close by fixing the error, he said; it is a problem you can look at from the perspective of performance and logging. Three thousand errors a week are in fact three thousand SSR failures, and the same query failing on the server and being requested again from the browser.

So, to see in numbers how much better it got, I ran an experiment in the mini app sandbox I showed earlier. I was embarrassed at how simply I had framed the problem. I learned that when something like this comes up I should think about it once more from the performance side and other angles, and record it with measurements. And once I ran the experiment, things started coming out differently from what I expected.

```tsx
// the scenario components used for the comparison
function BrokenUserCard({runId, delayMs}: Omit<ScenarioProps, 'scenario'>) {
  // Intentionally incorrect: calling a Server Action while rendering lets this
  // benchmark reproduce Next.js's initial-render protection.
  const {data} = useSuspenseQuery({
    queryKey: ['user', 'broken', runId, delayMs],
    queryFn: () => getUserAction(runId, delayMs),
  })
  return <UserCard user={data} />
}

function FixedUserCard({
  runId,
  delayMs,
  staleTime,
}: Omit<ScenarioProps, 'scenario'> & {readonly staleTime: number}) {
  const {data} = useSuspenseQuery(userQueryOptions(runId, delayMs, staleTime))
  return <UserCard user={data} />
}
```

`broken` is the code that ran a Server Action inside `useSuspenseQuery`, and `fixed` is the code that fixed the error by pulling the GET out of `'use server'`. But when I actually watched the network requests, `fixed` was still making duplicate data requests.

| Scenario | Requests | Total network time | Median per run | p95 per run |
| -------- | -------: | -----------------: | -------------: | ----------: |
| `broken` |       30 |          9,027.0ms |        300.9ms |     301.9ms |
| `fixed`  |       60 |         18,050.5ms |        601.7ms |     602.8ms |

The reason `broken` shows 30 is, as explained above, that `noServerCall` throws immediately, so only the browser request is counted. But `fixed`, which I expected to show 30 thanks to a proper SSR request, came out as 60. Why?

## Ways to carry the server's cache to the browser

The cause was that the server and the browser have different `queryClient`s. The `fixed` code did succeed in SSR and the result was cached. But that was cached in the server's `queryClient`; nothing was handed to the browser's `queryClient`. So the browser's `queryClient` still had an empty query and made the request again. This was the moment the third question, why you should use a Server Component, finally made sense.

The textbook approach is the one the error message recommends: use a Server Component. You `prefetch` the data, `dehydrate` it, pass it to `HydrationBoundary`, and let `useSuspenseQuery` use it. You move the cache filled in the server's `queryClient` straight into the browser's `queryClient`. Then `useSuspenseQuery` only reads the cache, on both sides.

```tsx
// page.tsx (server component)
export default async function Page() {
  const queryClient = getQueryClient()
  await queryClient.prefetchQuery(userQueryOptions())

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ScenarioPage />
    </HydrationBoundary>
  )
}
```

Then it struck me that `useSuspenseQuery` is rather half-finished in Next.js. SSR always happens in Next.js, so does using this query mean the cache never arrives on the initial load and the data is always requested twice? Is `HydrationBoundary` plus `prefetch` the only way to handle the initial load? It felt cumbersome, so I looked for other options.

Since React Query v5.40.0 there is another way: do not `await` the prefetch, pass the Promise straight through, and use it in `useSuspenseQuery`. The difference is whether you draw the boundary with `loading.tsx` or handle the fallback branch with a single `Suspense`.

If you `await`, the server component itself stops until the data arrives, so the boundary above it shows the fallback. If you do not, the page goes out first and only the `Suspense` wrapping `useSuspenseQuery` waits. So for a slow API, if you are not going to build a separate loading layout, passing the Promise beats always awaiting. To use it, include queries still in the pending state in the `dehydrate` option.

```ts
dehydrate: {
  shouldDehydrateQuery: (query) =>
    defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
}
```

The second option is the experimental package `@tanstack/react-query-next-experimental`, and the way it works is genuinely fun. You wrap the provider in `ReactQueryStreamedHydration`, and it dehydrates the result that `useSuspenseQuery` got during SSR and slips the query state into the HTML stream as a script. That script does nothing but these two lines.

```js
window[id] = window[id] || []
window[id].push(dehydratedState)
```

On the browser, when React comes up it takes the state that had piled up in the array, hydrates it to fill the browser `queryClient`'s cache, and replaces `push` with the hydrate function for the stream data still to come.

```js
onEntries(...(window[id] ?? [])) // the ones that arrived first
window[id] = {initialized: true, push: onEntries} // the ones still coming
```

So the script only ever has to call `push`, whenever it arrives, and once React is ready that `push` is already the function that puts things in the cache. Scripts arrive one by one as each `Suspense` boundary finishes, and solving "we do not know who will be ready first" this way struck me as genuinely clever. It turns out the RSC payload streams server component results the same way.

I did not pick this one, though. For one thing it only works on the first load, when the HTML is built. Navigating with `Link` does not build new HTML, so client components render only in the browser and the waterfall, where the request starts once the render reaches it, remains. Server components, on the other hand, run on the server during navigation too, so the prefetch always leaves first. I think I now understand why it is still experimental and carries a warning.

In the end I chose to `await` the prefetch. The API that fetches user information responds quickly enough for `await`, and I judged that touching the `dehydrate` option and adding configuration was the larger tradeoff. Then I ran 30 iterations again in the same sandbox.

## So what was the effect

Again something came out differently from what I expected. I thought prefetching and passing it through `HydrationBoundary` would be the end of it, but to give the result first: `hydrated-stale` logged 60, exactly like `fixed`. The cause was `staleTime`. So I added two more tests, `hydrated-stale` and `hydrated-fresh`.

| Scenario         | Requests | Total network time | Median per run | p95 per run |
| ---------------- | -------: | -----------------: | -------------: | ----------: |
| `broken`         |       30 |          9,027.0ms |        300.9ms |     301.9ms |
| `fixed`          |       60 |         18,050.5ms |        601.7ms |     602.8ms |
| `hydrated-stale` |       60 |         18,054.3ms |        601.8ms |     602.9ms |
| `hydrated-fresh` |       30 |          9,027.9ms |        301.1ms |     301.8ms |

With `staleTime` at its default of 0, data coming from the server is treated as stale the moment it reaches the browser. So as `useSuspenseQuery` mounts, it uses the cache as the cache and still sends another request from the browser.

> The sentence above is wrong. In `Suspense`, `staleTime` is clamped to a minimum of 1,000ms. More than a second passed between receiving the data and mounting, which is why two requests happened. I wrote about it in detail in [Is React Query's staleTime: 0 really 0?](/en/2026/10/react-query-stale-time-zero).

The build graph problem I solved afterwards continues in part 2.

## p.s.

One more thing I keep wondering about: how to set `staleTime`. This comes up every time at work. This time it was an API fetching user information that rarely changes, so I set it to about five seconds, but is it fine to decide the number per API on instinct alone? Honestly I do not know what the right number of seconds would be.

What `staleTime` prevents is only the automatic refetch on mount or focus. If you `invalidate` directly wherever the value changes, it refetches right away even with `staleTime` remaining. So a value I changed is reflected immediately anyway, and five seconds is only a problem when the value changes somewhere I do not know about.

If freshness matters enough for those seconds to be a problem, I would go to polling or a websocket. But in the end, too short a `staleTime` brings duplicate requests back on slow devices, and too long means a value changed on another device shows up late. Hmm. Maybe I change it when I see a problem.
