import type {ReactNode} from 'react'

import {tagsLayoutMetadata} from '@/components/tags/TagsIndexView'

export const metadata = tagsLayoutMetadata('ko')

export default function Layout({children}: {children: ReactNode}) {
  return <>{children}</>
}
