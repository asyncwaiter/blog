import SeriesIndexView, {
  seriesIndexMetadata,
} from '@/components/series/SeriesIndexView'

export const metadata = seriesIndexMetadata('ko')

export default function Page() {
  return <SeriesIndexView locale="ko" />
}
