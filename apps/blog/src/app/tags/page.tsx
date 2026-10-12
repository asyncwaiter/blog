import TagsIndexView, {tagsIndexMetadata} from '@/components/tags/TagsIndexView'

export const metadata = tagsIndexMetadata('ko')

export default function Page() {
  return <TagsIndexView locale="ko" />
}
