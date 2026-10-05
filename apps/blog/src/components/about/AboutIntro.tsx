import * as stylex from '@stylexjs/stylex'
import Link from 'next/link'

import type {Locale} from '@/utils/postPaths'

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

export function AboutIntro({locale = 'ko'}: {locale?: Locale}) {
  return (
    <div className={stylex.props(sx.div).className}>
      <div
        className={`markdown-body markdown-dark ${stylex.props(sx.div2).className}`}
      >
        {locale === 'en' ? <IntroEn /> : <IntroKo />}
      </div>
    </div>
  )
}

function IntroKo() {
  return (
    <>
      <p>
        안녕하세요. 프론트엔드 개발자 이수진입니다. 탁월함을 목표로 하며, 많은
        사람들에게 도움이 되는 일에 쓰이고 싶습니다. 그래서 빨리 더 틀리고, 더
        많이 실패하고자 합니다. 실패한만큼 성장한다고 믿기 때문입니다. 그 경험과
        생각들을 블로그에 담기 위해 노력합니다.
      </p>

      <h2>관심을 두고 있는 것들</h2>
      <ul>
        <li>
          <strong>수치로 확인하는 성능</strong> 증상과 개선은 항상 숫자로
          확인합니다.{' '}
          <Link href="/series/rendering-boundary">
            주 3천 건의 SSR 실패를 발견하고 네트워크 요청을 반으로
          </Link>{' '}
          줄인 경험처럼 제가 한 일이 숫자로 프로덕트에 변화를 만들 때, 가장 큰
          보람과 즐거움을 느낍니다.
        </li>
        <li>
          <strong>AI를 활용한 개발과 학습</strong> AI를 제대로 활용할 수 있는
          방법에 관심이 많습니다. AI에게 생각을 맡기는 것이 아닌, 사고를 넓히는
          도구로 쓰기 위해 고민하고 실험하고 있습니다. 요즘은 AI가 답을 주기
          전에 제 생각부터 묻도록 시스템을 바꿔, 직접 틀려보며 배우는 실험을
          진행하고 있습니다.
        </li>
      </ul>

      <h2>언어와 국경을 넘어 일하기</h2>
      <p>
        현재는 22개국을 대상으로 하는 유저 서비스를 개발하고 있습니다. 글로벌
        서비스에서 겪게 되는 RTL 레이아웃, 중국의 해외 서비스 차단 대응, 언어별
        폰트 로드 최적화 등의 문제를 다뤄왔습니다. 북미팀과 북유럽 파트너사와
        직접 소통하며 협업해 PoC를 개발한 경험이 있습니다. 영어 외에 일본어,
        아랍어를 할 수 있으며, 화면을 만들 때에도 제게 익숙한 방식이 항상
        기본값이 되지 않는다는 것을 알고 있습니다.
      </p>
    </>
  )
}

function IntroEn() {
  return (
    <>
      <p>
        Hi, I&apos;m Soojin Lee, a frontend developer. I aim for excellence and
        want my work to be useful to many people. That is why I try to be wrong
        sooner and fail more often: I believe I grow as much as I fail. I do my
        best to put those experiences and thoughts into this blog.
      </p>

      <h2>What I pay attention to</h2>
      <ul>
        <li>
          <strong>Performance, confirmed in numbers</strong> I always check
          symptoms and improvements in numbers. Nothing is more rewarding than
          seeing my work change the product in a measurable way, as when I{' '}
          <Link href="/series/rendering-boundary">
            found 3,000 SSR failures a week and cut network requests in half
          </Link>
          .
        </li>
        <li>
          <strong>Building and learning with AI</strong> I care a lot about
          using AI well. I keep thinking and experimenting so that AI widens my
          thinking instead of doing it for me. Lately I have changed my setup so
          that AI asks what I think before it gives an answer, and I am learning
          by getting things wrong first.
        </li>
      </ul>

      <h2>Working across languages and borders</h2>
      <p>
        I currently build a user-facing service for 22 countries. I have dealt
        with the problems that come with a global service: RTL layouts, foreign
        services blocked in China, and per-language font loading. I have also
        built a PoC while working directly with our North American team and a
        Nordic partner. Besides English, I speak Japanese and Arabic, and I know
        that what feels familiar to me is not always the default when I build a
        screen.
      </p>
    </>
  )
}
