import { Check, ChevronDown, Edit3, Filter, RotateCcw, Save, Users } from 'lucide-react';
import { useState } from 'react';
import { BarChart, LineChart } from '../components/Charts';
import { Toast } from '../components/Toast';
import { classes, machineRevenueSeries, revenueSeries, usageSeries } from '../data/mockData';

const labels = ['Apr 12', 'Apr 13', 'Apr 14', 'Apr 15', 'Apr 16', 'Apr 17'];

export function AdminDashboardPage() {
  const [expandedClass, setExpandedClass] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [period, setPeriod] = useState('Weekly');
  const [toast, setToast] = useState<string | null>(null);

  const saveLayout = () => {
    setEditing(false);
    setToast('Dashboard layout saved for this prototype.');
    window.setTimeout(() => setToast(null), 2600);
  };

  return (
    <div className="admin-dashboard page-enter">
      <section className="dashboard-intro dashboard-intro--admin">
        <div>
          <p className="eyebrow">Operations overview</p>
          <h1>Welcome back, Admin</h1>
        </div>
        <div className="admin-toolbar">
          <button className="button button--quiet"><Filter aria-hidden="true" /> Filter</button>
          {editing ? (
            <>
              <button className="button button--quiet" onClick={() => setEditing(false)}><RotateCcw aria-hidden="true" /> Cancel</button>
              <button className="button button--primary" onClick={saveLayout}><Save aria-hidden="true" /> Save dashboard</button>
            </>
          ) : (
            <button className="button button--quiet" onClick={() => setEditing(true)}><Edit3 aria-hidden="true" /> Edit dashboard</button>
          )}
        </div>
      </section>

      <div className={'admin-layout' + (editing ? ' is-editing' : '')}>
        <aside className="admin-sidebar panel">
          <div className="active-users">
            <span><Users aria-hidden="true" /></span>
            <div><small>Right now</small><strong>Active Users: 56</strong></div>
            <i aria-label="Systems operational"><Check aria-hidden="true" /></i>
          </div>
          <div className="admin-class-list">
            {classes.map((item) => (
              <article className="admin-class" key={item.id}>
                <button onClick={() => setExpandedClass(expandedClass === item.id ? null : item.id)} aria-expanded={expandedClass === item.id}>
                  <span>
                    <strong>{item.title}</strong>
                    <small>Instructor: {item.instructor}</small>
                    <small>Equipment: {item.equipment}</small>
                  </span>
                  <span className="admin-class__meta">
                    <b>{item.enrolled} / {item.capacity} slots</b>
                    <time>{item.date}<small>{item.time}</small></time>
                    <ChevronDown aria-hidden="true" />
                  </span>
                </button>
                {expandedClass === item.id ? (
                  <div className="admin-class__details">
                    <p>{item.description}</p>
                    <button className="text-button">Open roster</button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          <div className="admin-class-list__footer">
            <span>Class details</span>
            <strong>All Classes <Filter aria-hidden="true" /></strong>
          </div>
        </aside>

        <section className="admin-metrics">
          <article className="metric-card metric-card--wide panel">
            <LineChart values={revenueSeries} labels={labels} max={6000} />
            <div className="metric-card__footer">
              <div><small>Gross Revenue</small><strong>$3,982.00</strong></div>
              <div className="metric-controls"><select aria-label="Chart type"><option>Line Chart</option><option>Area Chart</option></select><select value={period} onChange={(event) => setPeriod(event.target.value)} aria-label="Period"><option>Weekly</option><option>Monthly</option><option>Quarterly</option></select></div>
            </div>
          </article>

          <article className="metric-card panel">
            <LineChart values={machineRevenueSeries} labels={labels.slice(1)} max={3000} height={220} compact />
            <div className="metric-card__footer">
              <div><small>Machine Revenue · All Machines</small><strong>$1,874.02</strong></div>
              <select aria-label="Machine revenue period"><option>Weekly</option><option>Monthly</option></select>
            </div>
          </article>

          <article className="metric-card panel">
            <BarChart values={usageSeries} labels={labels.slice(1)} max={15} />
            <div className="metric-card__footer">
              <div><small>Machine Usage · All Machines</small><strong>52.8 hours</strong></div>
              <select aria-label="Machine usage period"><option>Weekly</option><option>Monthly</option></select>
            </div>
          </article>
        </section>
      </div>
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
