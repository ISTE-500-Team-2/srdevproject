import { Users } from "lucide-react";
import { ClassThumb } from "./ClassBits";
import { WORKSHOP_LABEL, workshopImage, type WorkshopTemplate } from "./classData";

/**
 * Creative workshops the shop runs that have no session on the schedule yet.
 * Members can read about them; staff schedule them from the Schedule class dialog.
 */
export function WorkshopCards({ workshops }: { workshops: WorkshopTemplate[] }) {
  if (!workshops.length) return null;
  return (
    <section className="workshops" aria-labelledby="more-workshops">
      <div className="workshops-head">
        <h2 id="more-workshops">More creative workshops</h2>
        <p>Workshops the shop runs. They appear in the schedule above once a session is booked.</p>
      </div>
      <ul className="workshop-grid">
        {workshops.map((item) => (
          <li className="workshop-card" key={item.id}>
            <ClassThumb certification={WORKSHOP_LABEL} photo={workshopImage(item.title)} />
            <h3>{item.title}</h3>
            <span className="status-pill status-pill--neutral">Not scheduled yet</span>
            <p>{item.description}</p>
            <footer>
              <span>
                <Users aria-hidden="true" />
                Up to {item.capacity} {item.capacity === 1 ? "person" : "people"}
              </span>
            </footer>
          </li>
        ))}
      </ul>
    </section>
  );
}
