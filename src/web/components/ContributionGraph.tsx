import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "../api.ts";
import { useAsync } from "../components.tsx";
import { Link } from "../router.tsx";
import type { ContributionCalendar } from "../types.ts";
import { Icon, type IconName } from "./Icons.tsx";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const INITIAL_MONTHS = 2;
type Day = { date: string; count: number };

export function contributionLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
}

export function calendarWeeks(days: readonly Day[]): (Day | null)[][] {
  if (days.length === 0) return [];
  const firstWeekday = new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay();
  const cells: (Day | null)[] = [...Array<null>(firstWeekday).fill(null), ...days];
  const weeks: (Day | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function monthLabels(weeks: readonly (Day | null)[][]): { week: number; label: string }[] {
  const labels: { week: number; label: string }[] = [];
  let previous = -1;
  weeks.forEach((week, index) => {
    const first = week.find((day): day is Day => day !== null);
    if (!first) return;
    const month = Number(first.date.slice(5, 7)) - 1;
    if (month === previous) return;
    previous = month;
    labels.push({ week: index, label: MONTHS[month]! });
  });
  if (labels.length > 1 && labels[1]!.week - labels[0]!.week < 2) labels.shift();
  return labels;
}

function ordinal(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix}`;
}

export function describeDay(day: Day): string {
  const month = MONTH_NAMES[Number(day.date.slice(5, 7)) - 1]!;
  const when = `${month} ${ordinal(Number(day.date.slice(8, 10)))}`;
  return day.count === 0 ? `No contributions on ${when}.` : `${day.count} contribution${day.count === 1 ? "" : "s"} on ${when}.`;
}

function monthTitle(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

const COLLAPSED_ROWS = 5;

function useCollapsed<T>(rows: readonly T[]): { shown: readonly T[]; toggle: ReactNode } {
  const [open, setOpen] = useState(false);
  const hidden = rows.length - COLLAPSED_ROWS;
  return {
    shown: open || hidden <= 0 ? rows : rows.slice(0, COLLAPSED_ROWS),
    toggle: hidden > 0 ? (
      <button type="button" className="activity-toggle ghost small" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Show fewer" : `Show ${hidden} more`}
      </button>
    ) : null,
  };
}

function RepoCounts({ rows, unit }: { rows: { repo: string; count: number }[]; unit: string }): ReactNode {
  const max = Math.max(...rows.map((row) => row.count));
  const { shown, toggle } = useCollapsed(rows);
  return (
    <>
    <ul className="activity-repos">
      {shown.map((row) => (
        <li key={row.repo}>
          <Link to={`/${row.repo}`} className="activity-repo">{row.repo}</Link>
          <span className="activity-count small muted">{plural(row.count, unit)}</span>
          <span className="activity-bar" aria-hidden="true"><span style={{ width: `${Math.max(4, (row.count / max) * 100)}%` }} /></span>
        </li>
      ))}
    </ul>
    {toggle}
    </>
  );
}

function CreatedRepos({ rows }: { rows: { repo: string; created_at: number }[] }): ReactNode {
  const { shown, toggle } = useCollapsed(rows);
  return (
    <>
      <ul className="activity-repos">
        {shown.map((row) => (
          <li key={row.repo}>
            <Link to={`/${row.repo}`} className="activity-repo">{row.repo}</Link>
            <span className="activity-count small muted">{new Date(row.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
          </li>
        ))}
      </ul>
      {toggle}
    </>
  );
}

function ActivityItem({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }): ReactNode {
  return (
    <li className="activity-item">
      <span className="activity-icon"><Icon name={icon} /></span>
      <div className="activity-body">
        <div className="activity-title">{title}</div>
        {children}
      </div>
    </li>
  );
}

function ActivityTimeline({ data, name }: { data: ContributionCalendar; name: string }): ReactNode {
  const [visible, setVisible] = useState(INITIAL_MONTHS);
  useEffect(() => setVisible(INITIAL_MONTHS), [data.from, data.to]);
  const joinedMonth = new Date(data.joined_at).toISOString().slice(0, 7);
  const inRange = joinedMonth >= data.from.slice(0, 7) && joinedMonth <= data.to.slice(0, 7);
  const months = data.months.slice(0, visible);
  const exhausted = visible >= data.months.length;

  return (
    <section className="activity" aria-labelledby="activity-title">
      <h2 id="activity-title" className="profile-section-title">Contribution activity</h2>
      {data.months.length === 0 ? (
        <p className="activity-empty small muted">{name} has no activity yet for this period.</p>
      ) : null}
      {months.map((month) => {
        const commits = month.commits.reduce((sum, row) => sum + row.count, 0);
        const issues = month.issues.reduce((sum, row) => sum + row.count, 0);
        const pulls = month.pulls.reduce((sum, row) => sum + row.count, 0);
        return (
          <div key={month.month} className="activity-month">
            <h3 className="activity-month-title"><span>{monthTitle(month.month)}</span></h3>
            <ul className="activity-items">
              {commits ? (
                <ActivityItem icon="commit" title={`Created ${plural(commits, "commit")} in ${plural(month.commits.length, "repository", "repositories")}`}>
                  <RepoCounts rows={month.commits} unit="commit" />
                </ActivityItem>
              ) : null}
              {month.repositories.length ? (
                <ActivityItem icon="repo" title={`Created ${plural(month.repositories.length, "repository", "repositories")}`}>
                  <CreatedRepos rows={month.repositories} />
                </ActivityItem>
              ) : null}
              {pulls ? (
                <ActivityItem icon="pull" title={`Opened ${plural(pulls, "pull request")} in ${plural(month.pulls.length, "repository", "repositories")}`}>
                  <RepoCounts rows={month.pulls} unit="pull request" />
                </ActivityItem>
              ) : null}
              {issues ? (
                <ActivityItem icon="issue" title={`Opened ${plural(issues, "issue")} in ${plural(month.issues.length, "repository", "repositories")}`}>
                  <RepoCounts rows={month.issues} unit="issue" />
                </ActivityItem>
              ) : null}
              {month.private ? (
                <ActivityItem icon="lock" title={`${plural(month.private, "contribution")} in private repositories`} />
              ) : null}
              {inRange && exhausted && month === data.months.at(-1) && month.month === joinedMonth ? (
                <ActivityItem icon="star" title={`Joined GitGood on ${new Date(data.joined_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`} />
              ) : null}
            </ul>
          </div>
        );
      })}
      {!exhausted ? (
        <button type="button" className="activity-more" onClick={() => setVisible((count) => count + 3)}>
          Show more activity
        </button>
      ) : null}
    </section>
  );
}

export function ContributionGraph({ username, name }: { username: string; name: string }): ReactNode {
  const [year, setYear] = useState<number | null>(null);
  const calendar = useAsync(() => api.contributions(username, year), [username, year]);
  const last = useRef<ContributionCalendar | null>(null);
  if (calendar.data) last.current = calendar.data;
  const data = calendar.data ?? last.current;
  const scroller = useRef<HTMLDivElement>(null);
  const weeks = useMemo(() => calendarWeeks(data?.days ?? []), [data]);
  const labels = useMemo(() => monthLabels(weeks), [weeks]);
  const max = useMemo(() => Math.max(0, ...(data?.days ?? []).map((day) => day.count)), [data]);
  const columns = weeks.length || 53;

  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = year === null ? scroller.current.scrollWidth : 0;
  }, [weeks, year]);

  const heading = !data
    ? "\u00a0"
    : data.year === null
      ? `${data.total.toLocaleString()} contribution${data.total === 1 ? "" : "s"} in the last year`
      : `${data.total.toLocaleString()} contribution${data.total === 1 ? "" : "s"} in ${data.year}`;

  return (
    <div className="contrib-layout">
      <div className="contrib-main">
        <section className="contrib" aria-labelledby="contrib-title" aria-busy={calendar.loading}>
          <h2 id="contrib-title" className="profile-section-title">{heading}</h2>
          <div className="contrib-box">
            <div className="contrib-scroll" ref={scroller}>
              <div className="contrib-grid" style={{ "--weeks": columns } as CSSProperties} role="img" aria-label={heading}>
                {labels.map((label) => (
                  <span key={`m${label.week}`} className="contrib-month" style={{ gridColumn: label.week + 2 }}>{label.label}</span>
                ))}
                {(["Mon", "Wed", "Fri"] as const).map((label, index) => (
                  <span key={label} className="contrib-weekday" style={{ gridRow: index * 2 + 3 }}>{label}</span>
                ))}
                {weeks.map((week, column) =>
                  week.map((day, row) =>
                    day ? (
                      <span
                        key={day.date}
                        className={`contrib-cell level-${contributionLevel(day.count, max)}`}
                        style={{ gridColumn: column + 2, gridRow: row + 2 }}
                        title={describeDay(day)}
                      />
                    ) : null,
                  ),
                )}
              </div>
            </div>
            <div className="contrib-footer">
              {data ? (
                <span className="small muted">
                  {plural(data.breakdown.commits, "commit")} · {plural(data.breakdown.pulls, "pull request")} · {plural(data.breakdown.issues, "issue")} · {plural(data.breakdown.comments, "comment")}
                  {data.breakdown.private ? ` · ${plural(data.breakdown.private, "private contribution")}` : ""}
                </span>
              ) : <span className="small">{"\u00a0"}</span>}
              <span className="spacer" />
              <span className="contrib-legend small muted" aria-hidden="true">
                Less {[0, 1, 2, 3, 4].map((level) => <span key={level} className={`contrib-cell level-${level}`} />)} More
              </span>
            </div>
          </div>
        </section>
        {data ? <ActivityTimeline data={data} name={name} /> : null}
      </div>
      {data && data.years.length > 0 ? (
        <nav className="contrib-years" aria-label="Contribution year">
          {data.years.map((value, index) => {
            const active = year === value || (year === null && index === 0);
            return (
              <button key={value} type="button" className={active ? "is-active" : ""} aria-pressed={active} onClick={() => setYear(index === 0 && year === value ? null : value)}>
                {value}
              </button>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}
