import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { api } from "../api.ts";
import { useAsync } from "../components.tsx";
import type { ContributionCalendar } from "../types.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function contributionLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
}

export function calendarWeeks(days: ContributionCalendar["days"]): ({ date: string; count: number } | null)[][] {
  if (days.length === 0) return [];
  const firstWeekday = new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay();
  const cells: ({ date: string; count: number } | null)[] = [...Array<null>(firstWeekday).fill(null), ...days];
  const weeks: ({ date: string; count: number } | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function describe(day: { date: string; count: number }): string {
  const when = new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${day.count === 0 ? "No" : day.count} contribution${day.count === 1 ? "" : "s"} on ${when}`;
}

export function ContributionGraph({ username }: { username: string }): ReactNode {
  const calendar = useAsync(() => api.contributions(username), [username]);
  const scroller = useRef<HTMLDivElement>(null);
  const weeks = useMemo(() => calendarWeeks(calendar.data?.days ?? []), [calendar.data]);
  const max = useMemo(() => Math.max(0, ...(calendar.data?.days ?? []).map((day) => day.count)), [calendar.data]);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [weeks]);

  const monthLabels = weeks.map((week, index) => {
    const first = week.find((day) => day !== null);
    if (!first) return null;
    const month = Number(first.date.slice(5, 7)) - 1;
    const previous = index > 0 ? weeks[index - 1]!.find((day) => day !== null) : null;
    return !previous || Number(previous.date.slice(5, 7)) - 1 !== month ? MONTHS[month] : null;
  });

  const data = calendar.data;
  return (
    <section className="contrib" aria-labelledby="contrib-title">
      <h2 id="contrib-title" className="profile-section-title">
        {data ? `${data.total.toLocaleString()} contribution${data.total === 1 ? "" : "s"} in the last year` : "\u00a0"}
      </h2>
      <div className="contrib-box">
        <div className="contrib-scroll" ref={scroller}>
          <table className="contrib-grid" role="grid" aria-readonly="true" aria-busy={calendar.loading}>
            <thead>
              <tr>
                <td className="contrib-weekday" />
                {(weeks.length ? weeks : Array.from({ length: 53 }, () => [])).map((_, index) => (
                  <td key={index} className="contrib-month">{monthLabels[index] ? <span>{monthLabels[index]}</span> : null}</td>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
                <tr key={weekday}>
                  <td className="contrib-weekday">{weekday === 1 ? "Mon" : weekday === 3 ? "Wed" : weekday === 5 ? "Fri" : ""}</td>
                  {(weeks.length ? weeks : Array.from({ length: 53 }, () => [])).map((week, index) => {
                    const day = (week as ({ date: string; count: number } | null)[])[weekday] ?? null;
                    if (!day) return <td key={index} className="contrib-cell is-empty" />;
                    return <td key={index} className={`contrib-cell level-${contributionLevel(day.count, max)}`} title={describe(day)} aria-label={describe(day)} />;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="contrib-footer">
          {data ? (
            <span className="small muted">
              {data.breakdown.commits.toLocaleString()} commits · {data.breakdown.pulls.toLocaleString()} pull requests · {data.breakdown.issues.toLocaleString()} issues · {data.breakdown.comments.toLocaleString()} comments
            </span>
          ) : <span className="small">{"\u00a0"}</span>}
          <span className="spacer" />
          <span className="contrib-legend small muted" aria-hidden="true">
            Less {[0, 1, 2, 3, 4].map((level) => <span key={level} className={`contrib-cell level-${level}`} />)} More
          </span>
        </div>
      </div>
    </section>
  );
}
