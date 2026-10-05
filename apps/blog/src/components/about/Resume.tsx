import Link from 'next/link'

import * as resumeStyles from '@/components/about/Resume.styles'
import type {Locale} from '@/utils/postPaths'

import {ProjectTags} from './ProjectTags'
import {resumeContent} from './resumeContent'
import type {ResumeContent} from './resumeContent'

function SectionHeading({
  id,
  heading,
}: {
  id: string
  heading: {title: string; sub?: string}
}) {
  return (
    <div
      className={`resume-sectionHeading ${resumeStyles.resume_sectionHeading}`}
    >
      <h2 id={`${id}-title`} className={resumeStyles.resume_sectionHeading_h2}>
        {heading.title}
      </h2>
      {heading.sub ? (
        <span className={resumeStyles.resume_sectionHeading_span}>
          {heading.sub}
        </span>
      ) : null}
    </div>
  )
}

function EntryList({
  entries,
}: {
  entries: ResumeContent['education']['entries']
}) {
  return (
    <ul className="resume-entries">
      {entries.map((entry) => (
        <li key={entry.title} className={resumeStyles.resume_entries_li}>
          <span className={`resume-period ${resumeStyles.resume_period}`}>
            {entry.period}
          </span>
          <div>
            <h3 className={resumeStyles.element_h3}>
              {entry.href ? (
                entry.href.startsWith('/') ? (
                  <Link
                    href={entry.href}
                    className={resumeStyles.resume_link_hover}
                  >
                    {entry.title} <span aria-hidden="true">↗</span>
                  </Link>
                ) : (
                  <a
                    href={entry.href}
                    className={resumeStyles.resume_link_hover}
                  >
                    {entry.title} <span aria-hidden="true">↗</span>
                  </a>
                )
              ) : (
                entry.title
              )}
            </h3>
            <p className={resumeStyles.resume_entries_p}>{entry.description}</p>
            {entry.honor ? (
              <p className={`resume-honor ${resumeStyles.resume_honor}`}>
                {entry.honor}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
export function Resume({locale = 'ko'}: {locale?: Locale}) {
  const c = resumeContent[locale]
  return (
    <div className={`resume-resume ${resumeStyles.resume_resume}`}>
      <header className={`resume-summary ${resumeStyles.resume_summary}`}>
        <p className={`resume-eyebrow ${resumeStyles.resume_eyebrow}`}>
          {c.eyebrow}
        </p>
        <h2 className={resumeStyles.resume_summary_h2}>{c.title}</h2>
        <p className={`resume-lead ${resumeStyles.resume_lead}`}>{c.lead}</p>
        <p className={`resume-status ${resumeStyles.resume_status}`}>
          <span
            aria-hidden="true"
            className={resumeStyles.resume_status_span}
          />
          {c.status}
        </p>
        <dl className={`resume-expertise ${resumeStyles.resume_expertise}`}>
          {c.expertise.map(({term, detail}) => (
            <div key={term}>
              <dt className={resumeStyles.element_dt}>{term}</dt>
              <dd className={resumeStyles.element_dd}>{detail}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className={`resume-layout ${resumeStyles.resume_layout}`}>
        <nav
          className={`resume-nav ${resumeStyles.resume_nav}`}
          aria-label={c.navLabel}
        >
          {c.sections.map(({id, label}, index) => (
            <a
              key={id}
              href={`#${id}`}
              className={resumeStyles.resume_nav_link}
            >
              <span aria-hidden="true" className={resumeStyles.resume_nav_span}>
                0{index + 1}
              </span>
              {label}
            </a>
          ))}
        </nav>

        <div className={`resume-content ${resumeStyles.resume_content}`}>
          <section
            id="experience"
            className={`resume-section ${resumeStyles.resume_section}`}
            aria-labelledby="experience-title"
          >
            <SectionHeading id="experience" heading={c.experience} />
            <p
              className={`resume-sectionNote ${resumeStyles.resume_sectionNote}`}
            >
              {c.experience.note}
            </p>
            <ol className={`resume-timeline ${resumeStyles.resume_timeline}`}>
              {c.experience.jobs.map((job) => (
                <li
                  key={job.company}
                  className={`resume-job ${resumeStyles.resume_job}`}
                >
                  <div
                    className={`resume-jobHeading ${resumeStyles.resume_jobHeading}`}
                  >
                    <h3 className={resumeStyles.element_h3}>{job.company}</h3>
                    <span
                      className={`resume-period ${resumeStyles.resume_period}`}
                    >
                      {job.period}
                    </span>
                  </div>
                  <p className={`resume-role ${resumeStyles.resume_role}`}>
                    {job.role}
                  </p>
                  <p
                    className={`resume-jobDescription ${resumeStyles.resume_jobDescription}`}
                  >
                    {job.description}
                  </p>
                  <ul
                    className={`resume-contributions ${resumeStyles.resume_contributions}`}
                  >
                    {job.contributions.map((contribution) => (
                      <li
                        key={contribution}
                        className={resumeStyles.resume_contributions_li}
                      >
                        {contribution}
                      </li>
                    ))}
                  </ul>
                  <p className={`resume-stack ${resumeStyles.resume_stack}`}>
                    {job.stack}
                  </p>
                  {job.link ? (
                    <a
                      className={`resume-textLink ${resumeStyles.resume_textLink} ${resumeStyles.resume_link_hover}`}
                      href={job.link.href}
                    >
                      {job.link.label} <span aria-hidden="true">↗</span>
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>

          <section
            id="projects"
            className={`resume-section ${resumeStyles.resume_section}`}
            aria-labelledby="projects-title"
          >
            <SectionHeading id="projects" heading={c.projects} />
            <ul className="resume-entries">
              {c.projects.items.map((project) => (
                <li
                  key={project.name}
                  className={resumeStyles.resume_entries_li}
                >
                  <span
                    className={`resume-period ${resumeStyles.resume_period}`}
                  >
                    {project.category}
                  </span>
                  <div>
                    <h3 className={resumeStyles.element_h3}>
                      {project.href ? (
                        <a
                          href={project.href}
                          className={resumeStyles.resume_link_hover}
                        >
                          {project.name} <span aria-hidden="true">↗</span>
                        </a>
                      ) : (
                        project.name
                      )}
                    </h3>
                    <p className={resumeStyles.resume_entries_p}>
                      {project.description}
                    </p>
                    <ProjectTags tags={project.tags} locale={locale} />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section
            id="education"
            className={`resume-section ${resumeStyles.resume_section}`}
            aria-labelledby="education-title"
          >
            <SectionHeading id="education" heading={c.education} />
            <EntryList entries={c.education.entries} />
          </section>

          <section
            id="certifications"
            className={`resume-section ${resumeStyles.resume_section}`}
            aria-labelledby="certifications-title"
          >
            <SectionHeading id="certifications" heading={c.certifications} />
            <EntryList entries={c.certifications.entries} />
          </section>
        </div>
      </div>
    </div>
  )
}
