import SeriesDetailView, {
  seriesDetailMetadata,
  seriesStaticParams,
} from '@/components/series/SeriesDetailView'

export async function generateMetadata(props: {
  params: Promise<{slug: string}>
}) {
  const {slug} = await props.params
  return seriesDetailMetadata(slug, 'ko')
}

export function generateStaticParams() {
  return seriesStaticParams('ko')
}

export default async function Page(props: {params: Promise<{slug: string}>}) {
  const {slug} = await props.params
  return <SeriesDetailView slug={slug} locale="ko" />
}
