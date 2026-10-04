---
name: '렌더링 경계'
title: '<em>렌더링 경계</em>'
description: 'Server Functions cannot be called during initial render. 화면에는 멀쩡한데 로그에만 쌓이던 에러 메시지에서 시작해 답이 나올 때까지 React Query와 React, Next.js의 소스를 따라 내려간 기록. 중간에 내가 틀리게 짚었던 것도 수치로 확인해 함께 적었다'
---

같은 코드가 서버에서 한 번, 브라우저에서 한 번 실행된다. 그 경계에서 생기는 문제는 대개 에러로 드러나지 않고 로그에만 쌓인다. 이 시리즈는 그런 문제를 하나씩 붙잡고 원인을 찾아 내려간 기록이다.
