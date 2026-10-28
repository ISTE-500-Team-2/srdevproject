import { useEffect, useState } from "react";
import { AvailabilityCalendar } from "../components/studios/AvailabilityCalendar";
import { StaffRental } from "../components/studios/StaffRental";
import { StudioConfig } from "../components/studios/StudioConfig";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import type { Rental, Studio } from "../lib/studioContracts";
import { bookable, money, policy, sizeLabel } from "../lib/studioDisplay";
import "./studios.css";

/** Staff workspace tab: studio payments to record, occupancy, and rates. */
export function StaffStudios() {
  const { user } = useAuth();
  const admin = !!user?.roles.some((r) => ["admin", "super-admin"].includes(r));
  const [studios, setStudios] = useState<Studio[]>([]);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    const [data, management] = await Promise.all([
      api<{ studios: Studio[] }>("/studios"),
      api<Rental[]>("/studio-management/rentals"),
    ]);
    setStudios(data.studios);
    setRentals(management);
    setLoaded(true);
  }
  // Holds and payments arrive from members and card checkout while staff
  // watch this tab, so keep it current without a manual refresh.
  useEffect(() => {
    const update = () => void refresh().catch((e) => setError(errorMessage(e)));
    update();
    const timer = window.setInterval(update, 15000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, []);

  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const unconfigured = studios.filter((s) => !bookable(s));
  // Only rentals with a payment or refund to record; the occupancy grid
  // covers everything else.
  const toRecord = rentals.filter(
    (r) =>
      (r.status === "pending" && r.payment_method === "manual") ||
      ["refund_pending", "refund_failed"].includes(r.payment_status),
  );

  return (
    <section className="studio-desk" aria-labelledby="studio-desk">
      <h2 id="studio-desk">Studios</h2>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="studio-message" role="status">{message}</p>}
      {!loaded && !error && <p role="status">Loading studios…</p>}
      {unconfigured.length > 0 && (
        <p className="studio-desk__warning" role="note">
          Not offered to members until a rate and terms are saved:{" "}
          {unconfigured.map((s) => s.name).join(", ")}.
        </p>
      )}
      <h3>Payments to record</h3>
      {loaded && !toRecord.length && <p>Nothing waiting.</p>}
      {toRecord.map((r) => (
        <StaffRental
          key={r.id}
          rental={r}
          busy={busy}
          perform={(path, body) =>
            action(async () => {
              await api(path, { method: "POST", body });
              setMessage("Payment record updated.");
            })
          }
        />
      ))}
      <h3>Occupancy</h3>
      <AvailabilityCalendar studios={studios} />
      {admin && (
        <>
          <h3>Rates and terms</h3>
          <div className="studio-config-list">
            {studios.map((s) => (
              <article className="studio-config" key={s.id}>
                <h4>
                  {s.name} <small>{sizeLabel(s.size)}</small>
                </h4>
                <p>
                  {s.monthly_cents ? money(s.monthly_cents) + " / month" : "No rate"} ·{" "}
                  {policy(s.cancellation_policy)}
                </p>
                <StudioConfig
                  studio={s}
                  busy={busy}
                  save={(body) =>
                    action(async () => {
                      await api(`/studio-management/studios/${s.id}`, {
                        method: "PATCH",
                        body,
                      });
                      setMessage(`${s.name} saved. Existing rentals keep the terms they booked with.`);
                    })
                  }
                />
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
