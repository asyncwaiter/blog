import type {MetadataRoute} from 'next'

import {SiteConfig} from '@/config'
import {getAllPosts, getAllTagsFromPosts} from '@/utils/Post'
import {getAllSeries} from '@/utils/Series'

const SITE = SiteConfig.url

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [posts, enPosts, tags, series] = await Promise.all([
    getAllPosts(),
    getAllPosts('en'),
    getAllTagsFromPosts(),
    getAllSeries(),
  ])

  const enSlugs = new Set(enPosts.map((p) => p.fields.slug))

  return [
    {
      url: SITE,
      lastModified: new Date(),
    },
    ...['about', 'resume'].flatMap((page) =>
      ['', '/en'].map((prefix) => ({
        url: `${SITE}${prefix}/${page}`,
        lastModified: new Date(),
        alternates: {
          languages: {
            ko: `${SITE}/${page}`,
            en: `${SITE}/en/${page}`,
          },
        },
      })),
    ),
    {
      url: `${SITE}/archive`,
      lastModified: new Date(),
    },
    ...posts.map((post) => ({
      url: `${SITE}/${post.fields.slug}`,
      lastModified: new Date(post.frontMatter.date),
      ...(enSlugs.has(post.fields.slug) && {
        alternates: {
          languages: {
            ko: `${SITE}/${post.fields.slug}`,
            en: `${SITE}/en/${post.fields.slug}`,
          },
        },
      }),
    })),
    ...enPosts.map((post) => ({
      url: `${SITE}/en/${post.fields.slug}`,
      lastModified: new Date(post.frontMatter.date),
      alternates: {
        languages: {
          ko: `${SITE}/${post.fields.slug}`,
          en: `${SITE}/en/${post.fields.slug}`,
        },
      },
    })),
    ...tags.map(({tag}) => ({
      url: `${SITE}/tags/${tag}`,
    })),
    {
      url: `${SITE}/series`,
      lastModified: new Date(),
    },
    ...series.map((s) => ({
      url: `${SITE}/series/${s.slug}`,
      lastModified: new Date(),
    })),
  ]
}
