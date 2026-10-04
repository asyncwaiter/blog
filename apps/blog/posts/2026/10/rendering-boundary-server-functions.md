---
title: '렌더링 경계[1]: Server Functions cannot be called during initial render'
tags:
  - react
  - nextjs
  - debugging
  - tanstack-query
published: true
date: 2026-10-01 20:00:00
description: 'DataDog에 주 3,000건씩 쌓이던 에러를 추적했다. useSuspenseQuery가 커밋 전 렌더 단계에서 queryFn을 실행하고, 그 안에 Server Function이 들어 있던 것이 원인이었다. useQuery로 바꾸라는 조언 대신 use server 파일에서 읽기 함수를 분리해 에러를 0건으로 만들었지만, 같은 샌드박스에서 30회를 측정하자 요청은 60회가 나왔다. 서버와 브라우저의 queryClient가 다르기 때문이었다.'
series: '렌더링 경계'
seriesOrder: 1
art:
  undraw: server-error
  hue: cyan
---

## Table of Contents

## 들어가며

이 글은 렌더링 경계에 대한 문제를 해결한 과정을 기록한 글이다. 총 1, 2편으로 나누어지며, 1편은 서버 함수를 분리하며 겪은 시행착오와 해결 방법에 대해 이야기하고, 2편은 후속 작업으로 진행한 빌드 그래프를 분리 강제한 경험에 대해 이야기한다. 글의 대상은 `useQuery`와 `useSuspenseQuery`의 내부 구조와 Server Action, 그리고 Next.js에서 SSR과 브라우저 렌더의 내부 구현에 대해 알아보고 싶은 분들이다.

## 발생한 문제

DataDog에서 주 단위 약 3천 건의 특정 에러가 찍히고 있는 것을 발견했다.

```text
Server Functions cannot be called during initial render.
This would create a fetch waterfall.
Try to use a Server Component to pass data to Client Components instead.
```

왜 서버 함수가 렌더 중에 찍히는 걸까. AI에게 첫 검수를 시키자 원인은 `useSuspenseQuery`를 사용하는 부분에 있었다. 여기서 `useSuspenseQuery`에 Server Action이 들어가 있기에 이걸 `useQuery`로 바꾸라고 했다. 그런데 크게 세 가지 부분이 이해가 가지 않았다.

1. 어떻게 `useQuery`로 변경하는 게 문제를 해결해주는 걸까?
2. 왜 이 방식이 fetch waterfall을 만들어내는 것일까?
3. Server Component로 사용하는 방식에는 어떤 것들이 있을까?

위 의문들에 답하기 전, 이 문제가 발생한 코드를 먼저 살펴보자. 아래는 간단하게 문제 재현만 가능하게 만든 미니앱 코드이다.

```tsx
// ScenarioPage.tsx
'use client'
// import문 생략...

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
      <p>에러 발생 시나리오 페이지</p>
      <Suspense fallback={<p>로딩중</p>}>
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
  return fetchUser() // 단순 딜레이만 준 MockAPI
}
```

문제가 되는 코드는 Client 컴포넌트에서 발생했다. `Suspense`로 감싸 `useSuspenseQuery`로 데이터를 가져오고 있었고, `queryFn`에 Server Function이 들어갔다. 이제 코드를 확인했으니, 첫 번째 의문부터 답해보자.

## useQuery로 바꾸면 왜 에러가 사라질까

의문에 답하기 위해 `useQuery`와 `useSuspenseQuery`에 어떤 차이가 있는지부터 알아야 한다. `@tanstack/react-query@5.103.3` 기준으로, `useSuspenseQuery`는 `useQuery`와 다르게 `BaseQuery`에 `suspense`가 `true`로 들어가고 있다. 이 옵션 값이 어떻게 쓰이는지 알아보기 위해 `useBaseQuery` 코드를 확인해보자.

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

  // Handle suspense -> 여기서 suspense의 경우, 먼저 처리되고 있음
  if (shouldSuspend(defaultedOptions, result)) {
    throw fetchOptimistic(defaultedOptions, observer, errorResetBoundary)
  }

  // ...
}

export const shouldSuspend = (defaultedOptions, result) =>
  defaultedOptions?.suspense && result.isPending
```

React Query는 코드가 많고 복잡해 보이지만, 결국 `QueryCache` 객체를 Observer 패턴으로 관리하는 게 핵심이다. 코드를 보면 `useSyncExternalStore`를 사용해서 외부 객체들을 관리하는데, 이 `subscribe`는 커밋 이후에 실행된다. 그런데 `shouldSuspend` 검사와 `throw`는 그보다 앞인 렌더 중에 일어난다. `shouldSuspend`가 `true`가 되면, 바로 `fetchOptimistic`으로 Promise를 던지는 걸 코드에서 확인할 수 있다. 즉, `useQuery`의 `queryFn`은 커밋 후 `subscribe` 안에서 실행되고, `useSuspenseQuery`는 커밋 전, optimistic하게 이 컴포넌트가 렌더되고 있는 과정에서 `queryFn`을 실행해버리는 것이다.

`useSuspenseQuery`의 실행 순서를 다시 정리해보자면 아래와 같다.

1. 렌더 시작, 캐시 비어 있음 → 기본 pending 상태
2. `throw fetchOptimistic()` → 이 안에서 `query.fetch()` → `queryFn()` 실행
3. `throw`로 인해 렌더 중단 → 커밋, `subscribe` 단계 없음
4. Promise가 settle되면 React가 처음부터 다시 렌더함
5. 더 이상 상태가 pending이 아님 → `if` 통과 → `return result` → 커밋 → `subscribe`

내 문제는 여기서 2번, 렌더 단계에 Server Function이 호출된 것이었다. 서비스에 두 종류의 유저 정보를 가져오는 로직이 존재하는데, 이때 두 유저 로직이 한 파일에 응집되어 있었다. 로그인 시에 쿠키 정보를 업데이트하는 부분들을 모아둔 `'use server'` 파일이었는데, 여기에 쿠키와 무관한 불필요한 GET 요청이 있었다. 그게 바로 `useSuspenseQuery`에 들어가게 되는 게 문제였다. 이 함수가 SSR 패스 중 `useSuspenseQuery`로 인해 렌더 단계에서 실행되므로 에러를 발생시켰던 것이다.

그럼에도 화면에 에러로 보이지 않은 이유는, SSR에서 브라우저로 넘어오면 같은 쿼리가 진짜 fetch로 재실행되어 성공한 뒤 화면은 정상이 되고 로그만 남기 때문이다.

그럼 첫 번째 의문으로 돌아가 답해보자. 왜 `useQuery`를 사용하면 이 문제가 발생하지 않는 것일까? 정답은 두 훅의 코드에서 알 수 있다. `useQuery`에는 `suspense` 옵션이 존재하지 않았고, 그 결과 렌더 단계에서 `queryFn`의 실행도 없다. SSR에서는 `subscribe` 자체가 일어나지 않으니, 함수를 호출하지 않고 브라우저 패스에서 첫 실행되기 때문이다.

그런데 `useQuery`로 변경한다면 `Suspense`를 사용할 수 없는 것은 고사하고, 단순히 렌더 단계에서 서버 함수의 호출이 없다고 `useQuery`를 사용해도 되는 것인가? 애초에 렌더 중에 왜 Server Function이 불리는 게 문제가 되는 걸까? 다른 함수들은 문제가 없는데, 왜 서버 함수만 문제가 되는 것일까?

## 왜 Server Function만 렌더 중에 문제가 될까

나는 Server Function에 대해 얼마나 알고 있는가? [React 공식 문서](https://react.dev/reference/rsc/server-functions)와 [Next.js 공식 문서](https://nextjs.org/docs/app/getting-started/updating-data)를 다시 찬찬히 읽어봤다.

> 서버 함수는 서버 측 상태를 업데이트하는 Mutation을 위해 설계되었으며, 데이터 가져오기(Fetching)에는 권장하지 않습니다. 따라서, 서버 함수를 구현하는 프레임워크는 일반적으로 한 번에 하나의 작업만 처리하며, 반환 값을 캐시하는 방법을 제공하지 않습니다.
>
> — React 공식 문서

> A Server Action runs as a POST request against the page that invokes it. At build time, the `'use server'` directive tells the compiler to swap the function's implementation in client bundles for a reference (an action ID plus a dispatcher) that POSTs back to the server. The implementation stays on the server, but the route is reachable to anyone who can send the same POST. Treat every action as an untrusted entry point.
>
> — Next.js 공식 문서

두 개의 공식 문서에 나와 있듯 서버 함수는 서버 측 상태를 업데이트하는 Mutation을 위해 설계되었다. 그러니까 브라우저에서 서버 측에 요청하는 POST 요청인 것이다. 그런데 이런 서버 함수를 SSR 렌더 중에 호출한다? SSR 중에는 요청을 보내줄 브라우저도 없거니와, 자기가 자기 자신을 브라우저를 통해 호출하는 이상한 모습이 된다. 그래서 React에서는 이를 지원하지 않고 내가 겪은 에러를 발생시키고 있다. 이 에러가 발생하는 React 내부 구현 로직은 아래와 같다.

```js
function noServerCall() {
  throw new Error(
    'Server Functions cannot be called during initial render. ...',
  )
}

export function createServerReference(id, callServer) {
  // 넘겨받은 callServer를 무시하고 noServerCall로 끼워짐
  return createServerReferenceImpl(id, noServerCall)
}
```

```js
// 번들러가 만들어낸 actions.ts (클라이언트용)
import {createServerReference, callServer} from '...'

export const getUserAction = createServerReference('40abc...', callServer)
```

그러니까 Server Action은 빌드 시에 클라이언트에 import 되어 있으면 이 함수는 바로 특정 id 값으로 참조가 된다. 그리고 그 서버 함수는 `createServerReference`를 통해 실행된다. 그런데 이때 SSR의 경우, 저게 실제 함수로 넘어가는 게 아니라 `noServerCall`로 인해 바로 에러가 발생하는 것이다. 그렇게 연쇄적으로 `useSuspenseQuery`가 실패하게 되고, 이 정보가 브라우저로 넘어가서 다시 재요청을 하게 된다. 그때 비로소 `callServer`로 `queryFn`이 실행될 수 있는 것이다.

[React 공식 Suspense 문서](https://react.dev/reference/react/Suspense)를 보면, 서버에서 컴포넌트가 에러를 던지면 렌더를 중단하지 않고 가장 가까운 `Suspense`의 fallback을 HTML에 넣어서 보내고 다시 클라이언트에서 렌더를 시작한다고 나와 있다. 그런데 이것 또한 내부적으로 어떻게 구현되어 있어서 에러를 만들지 않고 재요청을 만드는 것일지 궁금해서 찾아보았다.

## 에러가 났는데 화면은 왜 멀쩡했을까

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

Fizz는 `Suspense` 경계 안에서 `throw`가 나면 요청 전체를 실패시키지 않는다. 그 경계만 `CLIENT_RENDERED`로 표시하고, 에러는 `logRecoverableError`로 `onError` 콜백에 넘긴 뒤(이게 DataDog에 찍힌 로그다), 돌려받은 digest를 경계에 저장한다. 그리고 flush 단계에서 이 status와 HTML에 특정 주석을 함께 넘기는데, 주석의 종류는 아래와 같다.

```js
// packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js

const SUSPENSE_START_DATA = '$' // 정상 완료된 경계
const SUSPENSE_END_DATA = '/$'
const SUSPENSE_PENDING_START_DATA = '$?' // 아직 스트리밍 중
const SUSPENSE_FALLBACK_START_DATA = '$!' // 서버에서 실패, 클라가 렌더해야 함
```

HTML에서 `SUSPENSE_FALLBACK_START_DATA`를 만나면 하이드레이션을 하지 않고 그 경계를 클라이언트에서 처음부터 렌더한다. 아래 로직과 같이 `retrySuspenseComponentWithoutHydrating`를 하도록 만들어져 있다.

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

이 로직으로 인해서 화면에 에러가 발생하지 않고, 로그로만 기록되고 복구되었던 것이다. `Suspense`를 쓰지 않았다면 그냥 다른 에러들처럼 에러가 발생했겠지. `Suspense`를 사용하면 데이터가 존재한다는 확신 아래에 코드를 작성할 수 있는 장점과 로딩 fallback 처리가 가능해서 좋은 것이라고만 생각했는데, 이걸 보니 `Suspense`는 에러와 렌더 처리를 가능하게 하는 경계이기도 하구나라는 생각이 든다. SSR에서 HTML에 주석을 포함시켜 보내고, 그 주석을 만나면 여기부터는 어떻게 처리할지 결정이 가능하기 때문이다.

사실 지금까지 Server Function을 단순히 DB에 접근하거나 민감 데이터를 조작하기 위한 서버 함수라고만 생각했지, 공식 문서에서 말하는 내용을 제대로 이해하지 못했던 것 같다. Server Function은 제대로 써야 한다. 그 조건은 크게 POST, 캐시 없음, 순차 실행이라는 성질을 갖는다.

이 서버 함수가 꼭 POST가 되어야 하는 이유는 뭘까? 우선 데이터를 가져오는 GET의 경우, Next.js에서는 항상 SSR로 이미 데이터를 읽어와 HTML을 만들어주는 그 역할을 이미 해주고 있다. Next.js 공식 문서 아랫부분에 보면 자세히 나와 있지만, GET은 HTTP상 안전하다고 판단돼서 캐시와 프리페치가 동작한다. 그래서 Mutation을 GET에 실으면 캐시가 대신 응답해서 변경이 반영이 안 되고, CDN 캐시는 유저를 구분 못 해 남의 응답을 받게 된다.

이제 두 번째 의문, '왜 이 방식이 fetch waterfall을 만들어내는 것일까?'에 답할 수 있게 되었다. 렌더 중에 호출이 발생한다는 것은 렌더가 그 지점에 닿아야 요청이 발생한다는 것이다. `Suspense` 지점은 앞의 요청이 끝나야 그다음 요청이 실행될 수 있게 직렬로 연결되어 있다.

> 실험으로 확인해보았으나 이는 중첩의 경우에만 해당하는 것이고, 형제 노드의 경우 병렬로 실행되었다. 이마저 prefetch로 hydrate한다면 중첩도 병렬로 나갈 수 있게 만들 수 있다.

결국 이 에러에서 말하는 fetch waterfall은, 초기 렌더 시 SSR에서 즉 서버에서 이미 실행 중인데 이때 작업하지 않고, 브라우저를 통해서 추후에 또 서버 콜을 하는 방식으로 생기는 waterfall을 뜻하는 것이라는 생각을 했다. 그래서 이렇게 다시 왕복하는 것을 피하기 위해서 Server Component로 내려주라고 권고한 것이다.

## 내가 선택한 해결 방법

결국 지금까지의 내용을 종합해보면 `useQuery`도 답이 되지 않음을 알 수 있다. `useQuery`를 사용해 브라우저에서 `queryFn`을 호출한들, 이는 서버에서 아예 호출을 안 해서 에러를 없앤 것일 뿐이다. 그리고 브라우저에서는 여전히 읽기를 POST로 보낼 것이다. 증상만 지운 것이다.

그래서 `useQuery`로 바꾸는 것이 아닌, `'use server'` 파일에서 단순 유저 읽기 요청이었던 메서드를 별도로 분리했다. 이제 이 함수는 Server Action이 아닌 일반 함수라서, SSR 중에 호출돼도 `noServerCall`이 던져지지 않는다. 서버에서는 서버가, 브라우저에서는 브라우저가 API를 GET으로 직접 부른다. 쿠키가 필요 없는 요청이라 가능한 방식이다.

배포 후 이 에러 메시지는 바로 0건이 됐다. 다만 에러가 사라졌을 뿐, 렌더 중에 요청이 출발하는 구조는 그대로다.

## 에러는 0건인데 요청은 두 배?

그런데 여기서 멘토님이 피드백을 해주셨다. 단순히 에러를 잡고 끝낼 문제가 아니라, 이건 성능과 로깅 측면에서 바라볼 수 있는 문제라고 말씀해주셨다. 주 3천 건의 에러는 사실 3천 번의 SSR 실패이며, 같은 쿼리가 서버에서 실패한 뒤 브라우저에서 다시 요청된 문제이기도 하기 때문이다.

그래서 성능 측면에서 얼마나 좋아진 것일지 수치로 확인하기 위해 처음 코드로 보여준 미니앱 샌드박스 환경에서 실험을 돌려보았다. 문제를 너무 단순히 본 게 부끄러웠다. 앞으로는 이런 문제가 발생하면 성능과 또 다른 측면에서 한 번 더 생각해보고, 이를 꼭 실험해서 수치로 기록해야겠다고 배웠다. 그리고 실험을 돌리자 내 생각과 달랐던 부분들이 나오기 시작했다.

```tsx
// 비교에 쓴 시나리오 컴포넌트
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

`broken`이 `useSuspenseQuery`에서 Server Action을 실행시켰던 문제가 되었던 코드이고, `fixed`가 GET 요청을 `'use server'`에서 분리하여 에러를 잡은 코드이다. 그런데 막상 네트워크 요청을 시켜보니, `fixed`가 여전히 중복 데이터 요청이 발생하고 있는 것을 확인했다.

| 시나리오 | 요청 수 | 총 네트워크 시간 | 실행당 중앙값 | 실행당 p95 |
| -------- | ------: | ---------------: | ------------: | ---------: |
| `broken` |      30 |        9,027.0ms |       300.9ms |    301.9ms |
| `fixed`  |      60 |       18,050.5ms |       601.7ms |    602.8ms |

`broken`에서 30회가 나오는 이유는 위에서 설명한 대로 `noServerCall`로 바로 에러가 발생하기 때문에 브라우저 요청만 잡힌 것이다. 그런데 `fixed`에서 제대로 된 SSR 요청으로 인해 30회가 나올 것으로 기대했던 결과가 60회로 나왔다. 도대체 왜 이런 결과가 나온 것일까?

## 서버의 캐시를 브라우저로 넘기는 방법들

원인은 서버와 브라우저의 `queryClient`가 다르다는 데에 있었다. 분명 `fixed` 코드는 SSR에서 성공하고 캐싱이 되었다. 그러나 그건 서버 `queryClient`에서 캐싱이 된 것이지, 브라우저 `queryClient`에는 아무것도 전달되지 못했다. 그래서 브라우저 `queryClient`에는 여전히 비어 있는 query가 되었고, 다시 재요청이 발생한 것이었다. 세 번째 의문이었던 Server Component를 사용해야 하는 이유에 대한 부분이 이해가 되는 순간이었다.

정석적인 방법으로는 에러 메시지에서 추천한 방법인 Server Component를 활용하는 방법이 있다. `prefetch`를 사용해서 미리 받아온 내용을 `dehydrate`해서 `HydrationBoundary`에 넘기고, 이를 `useSuspenseQuery`에서 사용하도록 만드는 방법이다. 서버 `queryClient`에 채워진 캐시를 브라우저 `queryClient`로 그대로 옮겨주는 것이다. 그러면 `useSuspenseQuery`는 서버에서도 브라우저에서도 캐시만 읽게 된다.

```tsx
// page.tsx (서버 컴포넌트)
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

그런데 문득 `useSuspenseQuery`가 Next.js에서는 너무 반쪽짜리 아닌가란 생각이 들었다. Next.js에서는 항상 SSR이 발생하는데, 그러면 이 쿼리를 사용하면 매번 초기 로드에는 캐싱이 전달이 안 돼서 데이터가 중복 요청이 될 수밖에 없는 건가? 초기 로드를 위해서는 `HydrationBoundary`와 `prefetch`와 함께 사용할 수밖에 없나? 뭔가 번거롭다는 생각이 들어 다른 방법들은 없는지 찾아보았다.

React Query v5.40.0부터 추가된 방법으로는 `prefetch`를 `await`하지 않고 바로 Promise로 넘겨 이를 `useSuspenseQuery`에서 사용하도록 하는 방법도 있는데, `loading.tsx`로 경계를 만들 것이냐 혹은 `Suspense` 하나로 fallback 분기를 쉽게 처리할 것이냐의 차이가 있다.

`await`을 하면 서버 컴포넌트 자체가 데이터를 받을 때까지 멈추기 때문에 그 위의 경계가 fallback을 보여주게 되고, `await`을 하지 않으면 페이지는 먼저 나가고 `useSuspenseQuery`를 감싼 `Suspense`만 기다리게 된다. 그래서 오래 걸리는 API의 경우, loading 레이아웃을 따로 만들지 않을 거면 무조건 `await`하는 방법보다 Promise를 넘기는 방식이 유리하다. 이를 적용하려면 아래 코드처럼 `queryClient`의 `dehydrate` 옵션에 기본 pending 상태인 쿼리까지 포함시키면 된다.

```ts
dehydrate: {
  shouldDehydrateQuery: (query) =>
    defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
}
```

그리고 두 번째 방법으로는 실험 패키지인 `@tanstack/react-query-next-experimental`을 쓰는 방법인데 방식이 되게 재밌었다. Provider만 `ReactQueryStreamedHydration`으로 감싸면 되는데, SSR에서 `useSuspenseQuery`로 받은 결과를 `dehydrate`시켜서 HTML 스트림 안에 script로 query state를 끼워 보낸다. 그 script가 하는 일은 아래 두 줄이 전부다.

```js
window[id] = window[id] || []
window[id].push(dehydratedState)
```

그리고 브라우저에서는 React가 뜰 때 그동안 배열에 쌓여 있던 state를 꺼내 hydrate해서 브라우저 `queryClient`의 캐시를 채우고, 이후의 스트림 데이터를 위해 `push` 함수를 hydrate 함수로 변경해둔다.

```js
onEntries(...(window[id] ?? [])) // 먼저 도착한 것들
window[id] = {initialized: true, push: onEntries} // 나중에 올 것들
```

그러니까 script는 언제 도착하든 `push`만 부르면 되는 것이고, React가 준비된 뒤에는 그 `push`가 곧 캐시에 넣는 함수가 되어 있는 것이다. `Suspense` 경계가 끝날 때마다 script가 제각각 도착할 텐데, 누가 먼저 준비될지 모르는 상황을 이렇게 풀었다는 게 진짜 똑똑한 방법이라고 생각했다. 이게 알아보니 RSC의 payload도 같은 방식으로 서버 컴포넌트 결과를 스트리밍하는 방식이었다.

그런데 이 방법은 선택하지 않았다. 일단 이 방식은 HTML을 만드는 첫 로드에서만 동작한다. `Link`로 페이지를 이동할 때는 HTML을 새로 만들지 않으니, 클라이언트 컴포넌트는 브라우저에서만 렌더되고 렌더가 닿아야 요청이 시작되는 waterfall이 그대로 남게 된다. 반면 서버 컴포넌트는 페이지 이동 때도 서버에서 실행되기 때문에 `prefetch`는 항상 제일 먼저 출발한다. 그래서 왜 experimental로 남아 있고 경고가 쓰여 있는지 알 것 같았다.

최종적으로는 `prefetch`를 `await`하는 방식을 선택했다. 유저 정보를 가져오는 API는 응답이 빨라서 `await`으로도 충분했고, 굳이 `dehydrate` 옵션까지 건드려서 설정을 늘리는 게 더 큰 트레이드오프라 판단했기 때문이다. 그리고 같은 샌드박스에서 다시 30회를 돌려보았다.

## 그래서 효과는

또 내 생각과 다른 부분이 나왔다. `prefetch`해서 `HydrationBoundary`로 넘겨주기만 하면 끝일 줄 알았는데, 결과만 먼저 말하자면 `hydrated-stale`은 `fixed`와 똑같이 60회가 찍혔다. 원인은 `staleTime`이었다. 그래서 `hydrated-stale`, `hydrated-fresh` 테스트 두 가지를 더 추가했다.

| 시나리오         | 요청 수 | 총 네트워크 시간 | 실행당 중앙값 | 실행당 p95 |
| ---------------- | ------: | ---------------: | ------------: | ---------: |
| `broken`         |      30 |        9,027.0ms |       300.9ms |    301.9ms |
| `fixed`          |      60 |       18,050.5ms |       601.7ms |    602.8ms |
| `hydrated-stale` |      60 |       18,054.3ms |       601.8ms |    602.9ms |
| `hydrated-fresh` |      30 |        9,027.9ms |       301.1ms |    301.8ms |

`staleTime`이 기본값인 0이면 서버에서 넘어온 데이터가 브라우저에 도착하자마자 stale로 취급된다. 그래서 `useSuspenseQuery`가 마운트되면서 캐시는 캐시대로 쓰고, 브라우저에서 또 요청을 보내버린 것이다.

> 위 문장은 틀렸다. `Suspense`에서 `staleTime`은 최소 1,000ms로 설정된다. 데이터를 받고 마운트되기까지 1초가 초과되어 두 번 요청이 발생한 것이다. 자세한 내용은 [ReactQuery의 staleTime: 0은 정말 0일까?](/2026/10/react-query-stale-time-zero)에 썼다.

후속으로 해결한 빌드 그래프 문제는 2편에서 계속.

## p.s.

그런데 여기서 고민이 하나 더 생겼다. `staleTime`의 시간 설정. 이건 실무에서 매번 고민되는 부분이다. 이번엔 유저의 잘 바뀌지 않는 정보를 가져오는 API라 5초 정도로 설정했는데, 매번 API별로 단순히 내 감으로 숫자를 결정해도 되는 걸까? 솔직히 몇 초가 맞는 값일지 잘 모르겠다.

`staleTime`이 막는 건 마운트나 포커스 때 알아서 다시 가져오는 동작뿐이다. 값이 바뀌는 곳에서 직접 `invalidate`를 해주면 `staleTime`이 남아 있어도 바로 다시 가져온다. 그러니까 내가 바꾼 값은 어차피 바로 반영이 되는 거고, 5초가 문제가 되는 건 내가 모르는 곳에서 값이 바뀌는 경우뿐이다.

그 초가 문제될 만큼 최신성이 중요하면 polling이나 웹소켓으로 가겠지만, 결국 `staleTime`이 너무 짧으면 느린 기기에서는 중복 요청이 다시 생길 것이고, 너무 길면 다른 기기에서 바꾼 값이 늦게 보일 것이다. 흠... 문제가 보이면 그때 바꾸면 되려나.
