import * as stylex from '@stylexjs/stylex'

import '@/styles/reading.css'
const sx = stylex.create({
  div: {
    '@layer utilities': {
      paddingTop: 'calc(var(--spacing) * 8)',
      paddingBottom: 'calc(var(--spacing) * 8)',
      gridColumn: {
        default: null,
        '@media (width >= 80rem)': 'span 2 / span 2',
      },
    },
  },
  div2: {
    '@layer utilities': {
      maxWidth: 'none',
    },
  },
})

// 본문은 아직 쓰지 않았다. 자리만 잡아 두고, 쓸 때 이 문단을 내용으로 바꾼다.
export function AboutIntro() {
  return (
    <div className={stylex.props(sx.div).className}>
      <div
        className={`markdown-body markdown-dark ${stylex.props(sx.div2).className}`}
      >
        <p>...</p>
      </div>
    </div>
  )
}
