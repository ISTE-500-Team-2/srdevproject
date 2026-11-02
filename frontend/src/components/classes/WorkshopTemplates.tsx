import { useApi } from '../../lib/useApi';
import { LoadState } from '../Management';
import type { ScheduleSeed } from './classData';
export type WorkshopTemplate={id:number;title:string;description:string;capacity:number};
export function WorkshopTemplates({manager,onSchedule}:{manager:boolean;onSchedule:(seed:ScheduleSeed)=>void}) {
  const catalog=useApi<WorkshopTemplate[]>('/classes/catalog');
  return <section className="panel management-panel" aria-label="Creative workshops">
    <h2>Creative workshops</h2><p>Explore our starting classes. Each class has up to 15 places; dates and instructors appear once a session is scheduled.</p>
    <LoadState {...catalog}/>
    {catalog.data?.map(item=><details key={item.id} className="member-record__section"><summary>{item.title}</summary>
      <p>{item.description}</p><p>Up to {item.capacity} participants.</p>
      {manager && <button type="button" className="button button--quiet" onClick={()=>onSchedule({catalogId:item.id,title:item.title,description:item.description,capacity:item.capacity})}>Schedule this workshop</button>}
    </details>)}
  </section>;
}
