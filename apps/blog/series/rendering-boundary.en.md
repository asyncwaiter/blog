---
name: 'Rendering Boundaries'
title: '<em>Rendering Boundaries</em>'
description: 'Server Functions cannot be called during initial render. It started with an error that never showed on screen and only piled up in the logs. This series follows the React Query, React and Next.js sources down until the answer came out, and records the places where I guessed wrong, with the numbers that proved it.'
---

The same code runs once on the server and once in the browser. Problems at that boundary rarely surface as errors. They pile up in the logs. This series takes those problems one at a time and traces each one down to its cause.
