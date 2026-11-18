// Adds a machine and checks, while the form is filled in, everything a member needs to book it:
// a listing members can find, a price booking can charge, a certification in effect and the waiver.

import { Fragment, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, ChevronDown, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { editingFormRef } from '../../lib/editingForms';
import { equipmentGroup } from '../../lib/equipmentGroups';
import { useApi } from '../../lib/useApi';
import { Modal } from '../../components/Modal';
import { LoadState } from '../../components/Management';
import { EquipmentImagePicker, type EquipmentImageChoice, type EquipmentImageOption } from './EquipmentImagePicker';

export interface CertificationOption {
  id: number; name: string;
  /** In effect now, starting later, or ended (an ended one can't be required). */
  state?: 'now' | 'later' | 'ended';
  startsOn?: string | null; endedOn?: string | null;
  /** Members with active access who hold it today. */
  holders?: number;
}
/** `type` is the machine's own category spelling, which decides its member card. */
interface CatalogMachine { id: number; name: string; image: string; type?: string }
export interface AddOptions {
  canManage: boolean;
  certifications: CertificationOption[];
  /** Categories still in the catalog, with their machines in member-page order. */
  /** A group with no name holds machines without a category; they still appear on member cards. */
  groups?: { name: string | null; machines: CatalogMachine[] }[];
  /** Whether the facility and equipment waivers a waiver-required booking checks are published. */
  waiversPublished?: boolean;
  /** Pictures the image picker offers: ones already in the catalog, then the stock ones. */
  images?: EquipmentImageOption[];
}
export interface Added { id: number; name: string; note: string }
type Tone = 'ok' | 'warn' | 'bad';
interface Item { tone: Tone; title: string; note: string }

/** Booking's own limits (backend equipmentPricing): card payments from $0.50, 24 hours within $100,000. */
const MIN_PAID_RATE = 0.5;
const MAX_RATE = 4166.66;
/** What a machine without a picture shows members. */
const DEFAULT_PICTURE = '/assets/3d-printer.webp';

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (date?: string | null) => date ? new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const linkProblem = (link: string) => link && !/^\/(?!\/)/.test(link) && !/^https:\/\//i.test(link);

function priceCheck(free: boolean, raw: string): Item & { field: string; error?: boolean; rate?: number } {
  if (free) return { tone: 'ok', title: 'Free to use', note: 'No payment step when booking', field: 'Members book it at no charge.', rate: 0 };
  const text = raw.trim();
  if (!text) return { tone: 'bad', title: 'Set a price', note: 'Enter an hourly rate, or choose Free to use', field: 'Enter an hourly rate, or choose Free to use.' };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { tone: 'bad', error: true, title: 'Check the rate', note: 'Use dollars and cents, like 18.50', field: 'Use dollars and cents, like 18.50.' };
  const rate = Number(text);
  if (rate === 0) return { tone: 'bad', error: true, title: 'The rate is $0', note: 'Choose Free to use instead', field: 'For no charge, choose Free to use.' };
  if (rate < MIN_PAID_RATE) return { tone: 'bad', error: true, title: 'Too low to charge a card', note: `A 1-hour booking would be ${money(rate)}. Card payments start at ${money(MIN_PAID_RATE)}`, field: `A 1-hour booking would be ${money(rate)}, and card payments start at ${money(MIN_PAID_RATE)}. Use ${money(MIN_PAID_RATE)} or more, or choose Free to use.` };
  if (rate > MAX_RATE) return { tone: 'bad', error: true, title: 'Too high for a full-day booking', note: '24 hours would pass the $100,000 limit', field: `Keep it at ${money(MAX_RATE)} an hour or less so a 24-hour booking stays within the $100,000 limit.` };
  return { tone: 'ok', title: `${money(rate)} an hour`, note: `2 hours = ${money(rate * 2)}, paid by card`, field: `A 2-hour booking costs ${money(rate * 2)}.`, rate };
}

interface MenuPlace { left: number; width: number; top?: number; bottom?: number; maxHeight: number }
/** Below its field when the list fits there, otherwise above; never wider than it needs. */
function placeMenu(anchor: HTMLElement, wanted: number): MenuPlace {
  const r = anchor.getBoundingClientRect(), gap = 6, edge = 12;
  const below = window.innerHeight - r.bottom - gap - edge, above = r.top - gap - edge;
  const width = Math.min(380, r.width, window.innerWidth - r.left - edge);
  return below >= Math.min(wanted, 220) || below >= above
    ? { left: r.left, width, top: r.bottom + gap, maxHeight: below }
    : { left: r.left, width, bottom: window.innerHeight - r.top + gap, maxHeight: above };
}

export function EquipmentAdd({ onClose, onAdded }: { onClose: () => void; onAdded: (added: Added) => void }) {
  const options = useApi<AddOptions>('/admin/equipment/catalog-options');
  const allGroups = options.data?.groups ?? [];
  const groups = allGroups.flatMap(g => g.name ? [{ ...g, name: g.name }] : []);
  const certs = options.data?.certifications ?? [];
  const ids = useId();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryActive, setCategoryActive] = useState(-1);
  const [location, setLocation] = useState('Makerspace');
  // Same picker and upload as editing: a saved or stock picture, a link, or a new upload saved with the machine.
  const [image, setImage] = useState<EquipmentImageChoice>({ path: '' });
  const [processingImage, setProcessingImage] = useState(false);
  const [free, setFree] = useState(false);
  const [rate, setRate] = useState('');
  const [certId, setCertId] = useState<number | null>(null);
  const [certMenu, setCertMenu] = useState<MenuPlace | null>(null);
  const [certActive, setCertActive] = useState(0);
  const [waiver, setWaiver] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = saving || processingImage;
  const [error, setError] = useState('');
  const rateRef = useRef<HTMLInputElement>(null);
  const certRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const touch = () => setDirty(true);
  const categoryList = `${ids}-categories`, certList = `${ids}-certifications`, certLabel = `${ids}-certification-label`;

  // Category: typed or chosen; a match in other capitals becomes the existing spelling.
  const query = category.trim().toLowerCase();
  const exact = groups.find(g => g.name.toLowerCase() === query);
  const matches = groups.filter(g => !query || g.name.toLowerCase().includes(query));
  const categoryChoices = [...matches.map(g => g.name), ...(query && !exact ? [category.trim()] : [])];
  const chosenCategory = query ? exact?.name ?? category.trim() : '';
  const settleCategory = (value = chosenCategory) => { setCategory(value); setCategoryOpen(false); setCategoryActive(-1); };

  // The member page shows one card per display group, its first machine's picture on top.
  const card = chosenCategory ? (() => {
    const title = equipmentGroup(chosenCategory);
    return { title, machines: allGroups.flatMap(g => g.machines.filter(m => equipmentGroup(m.type ?? g.name ?? m.name) === title)).sort((a, b) => a.id - b.id) };
  })() : null;
  const trimmed = name.trim();
  // Names are unique within a category, as the server requires; a merged card labels each machine with its category.
  const duplicate = !!exact && !!trimmed && exact.machines.some(m => m.name.trim().toLowerCase() === trimmed.toLowerCase());

  // Certifications: in effect first, then ones that start later; ended ones are shown but can't be picked.
  const certChoices: (CertificationOption | null)[] = [null, ...certs.filter(c => (c.state ?? 'now') === 'now'), ...certs.filter(c => c.state === 'later'), ...certs.filter(c => c.state === 'ended')];
  const cert = certs.find(c => c.id === certId) ?? null;
  const later = cert?.state === 'later';
  const pickable = (c: CertificationOption | null) => c?.state !== 'ended';

  const price = priceCheck(free, rate);
  const link = image.upload ? '' : image.path.trim();
  const listing: Item = !trimmed ? { tone: 'bad', title: 'Give it a name', note: 'Members pick machines by name' }
    : !card ? { tone: 'bad', title: 'Choose a category', note: 'It decides which card it appears on' }
    : duplicate ? { tone: 'bad', title: `Another ${chosenCategory} is called ${trimmed}`, note: `Members pick machines by name. Try ${trimmed} #2` }
    : !location.trim() ? { tone: 'bad', title: 'Add a location', note: 'Members see where to find it' }
    : linkProblem(link) ? { tone: 'bad', title: 'Check the photo link', note: 'Use a link that starts with https:// or /' }
    : card.machines.length ? { tone: 'ok', title: `On the ${card.title} card`, note: `Next to ${plural(card.machines.length, 'other machine')}` }
    : { tone: 'ok', title: `New ${card.title} card`, note: 'Members will see a new card' };
  const certItem: Item = !cert ? { tone: 'ok', title: 'No certification needed', note: 'Any member with access can book' }
    : later ? { tone: 'warn', title: `Needs ${cert.name}`, note: `It starts ${day(cert.startsOn)}. No one can book before then` }
    : cert.holders === 0 ? { tone: 'warn', title: `Needs ${cert.name}`, note: 'No member holds it yet' }
    : { tone: 'ok', title: `Needs ${cert.name}`, note: cert.holders === undefined ? 'Members need it to book' : `${plural(cert.holders, 'member')} hold${cert.holders === 1 ? 's' : ''} it today` };
  const noWaiver = waiver && options.data?.waiversPublished === false;
  const items: Item[] = [listing, price, certItem,
    !waiver ? { tone: 'ok', title: 'No waiver needed', note: 'Members can book without signing' }
    : noWaiver ? { tone: 'warn', title: 'Equipment waiver', note: 'The required waivers aren’t all published yet. No one can book until they are' }
    : { tone: 'ok', title: 'Equipment waiver', note: 'Unsigned members are asked first' }];
  const bad = items.filter(i => i.tone === 'bad').length;
  const warn = items.some(i => i.tone === 'warn');
  // What still stands between members and a booking once the machine is added.
  const waits = [
    later ? `From ${day(cert!.startsOn)}, members who hold ${cert!.name} can book it.` : '',
    cert?.state !== 'later' && cert?.holders === 0 ? `Members need ${cert.name} to book it, and no one holds it yet.` : '',
    noWaiver ? 'No one can book it until the required waivers are published.' : '',
  ].filter(Boolean);
  const footer = bad ? `Fix ${plural(bad, 'item')} in the booking check to add this machine.`
    : waits.length ? `You can add it now. ${waits.join(' ')}`
    : 'Members can book it as soon as you add it.';

  // Preview: the card as members will see it.
  const listed = [...(card?.machines.map(m => m.name) ?? []), trimmed || 'Your machine'];
  const mineShown = listed.length <= 3;
  const chosenPicture = image.upload || (linkProblem(link) ? '' : link);
  const cover = card?.machines[0]?.image ?? (chosenPicture || DEFAULT_PICTURE);
  const opensTo = !!card?.machines.length && (!mineShown || (!!chosenPicture && chosenPicture !== cover));

  const openCert = () => { if (certRef.current) { setCertMenu(placeMenu(certRef.current, 300)); setCertActive(Math.max(0, certChoices.findIndex(c => (c?.id ?? null) === certId))); } };
  const pickCert = (c: CertificationOption | null) => { if (!pickable(c)) return; setCertId(c?.id ?? null); setCertMenu(null); touch(); certRef.current?.focus(); };
  // The list is pinned to the window: it closes on an outside press or if the page under it moves.
  // Keyboard moves keep the active option in view; focus stays on the field, so the list scrolls itself.
  useEffect(() => {
    if (certMenu) document.getElementById(`${certList}-${certActive}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [certMenu, certActive, certList]);
  useEffect(() => {
    if (categoryOpen && categoryActive >= 0) document.getElementById(`${categoryList}-${categoryActive}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [categoryOpen, categoryActive, categoryList]);
  useEffect(() => {
    if (!certMenu) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (menuRef.current?.contains(target) || certRef.current?.contains(target));
    const press = (event: MouseEvent) => { if (!inside(event.target)) setCertMenu(null); };
    const moved = (event: Event) => { if (!inside(event.target)) setCertMenu(null); };
    document.addEventListener('mousedown', press);
    document.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => { document.removeEventListener('mousedown', press); document.removeEventListener('scroll', moved, true); window.removeEventListener('resize', moved); };
  }, [certMenu]);

  const step = (from: number, by: number, count: number, allowed: (i: number) => boolean) => {
    for (let n = 1; n <= count; n++) { const i = (from + by * n + count * n) % count; if (allowed(i)) return i; }
    return from;
  };
  const certKeys = (event: KeyboardEvent) => {
    if (!certMenu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openCert(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCertMenu(null); }
    else if (event.key === 'Tab') setCertMenu(null);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setCertActive(i => step(i, event.key === 'ArrowDown' ? 1 : -1, certChoices.length, j => pickable(certChoices[j]!))); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pickCert(certChoices[certActive] ?? null); }
  };
  const categoryKeys = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && categoryOpen) { event.preventDefault(); event.stopPropagation(); setCategoryOpen(false); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setCategoryOpen(true);
      setCategoryActive(i => categoryChoices.length ? step(i < 0 && event.key === 'ArrowUp' ? 0 : i, event.key === 'ArrowDown' ? 1 : -1, categoryChoices.length, () => true) : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (categoryOpen && categoryActive >= 0 && categoryChoices[categoryActive]) { settleCategory(categoryChoices[categoryActive]); touch(); }
      else settleCategory();
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (bad || busy || !options.data?.canManage) return;
    setSaving(true); setError('');
    try {
      const saved = await api<{ id: number }>('/admin/equipment', {
        method: 'POST',
        body: { name: trimmed, type: chosenCategory, location: location.trim(), image: link, ...(image.upload ? { imageUpload: image.upload } : {}), rate: price.rate, certId, waiverRequired: waiver },
      });
      onAdded({ id: saved.id, name: trimmed, note: waits.length ? waits.join(' ') : 'Members can book it now.' });
    } catch (err) { setError(errorMessage(err)); }
    finally { setSaving(false); }
  };

  return <Modal open title="Add equipment" onClose={onClose} dirty={dirty} dismissible={!busy} className="eqa-card">
    {close => <form ref={editingFormRef} className="eqa" onChange={touch} onSubmit={save}>
      <div className="eqa-form">
        <LoadState {...options} />
        <EquipmentImagePicker value={image} images={options.data?.images ?? []} disabled={busy} onProcessing={setProcessingImage} onChange={choice => { setImage(choice); touch(); }} />
        {linkProblem(link) && <small className="eqa-photo-error is-error">Use a photo link that starts with https:// or /.</small>}
        <label className="eqa-field"><span className="eqa-label">Name</span><input maxLength={100} value={name} placeholder="e.g. Glowforge Pro" disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <div className="eqa-two">
          <div className="eqa-field eqa-combo">
            <label className="eqa-label" htmlFor={`${ids}-category`}>Category</label>
            <input id={`${ids}-category`} role="combobox" aria-expanded={categoryOpen} aria-controls={categoryList} aria-autocomplete="list"
              aria-activedescendant={categoryOpen && categoryActive >= 0 ? `${categoryList}-${categoryActive}` : undefined}
              autoComplete="off" maxLength={100} placeholder="Type or choose" value={category} disabled={busy}
              onChange={e => { setCategory(e.target.value); setCategoryOpen(true); setCategoryActive(-1); }}
              onFocus={() => setCategoryOpen(true)} onBlur={() => settleCategory()} onKeyDown={categoryKeys} />
            {categoryOpen && categoryChoices.length > 0 && <div className="eqa-menu" id={categoryList} role="listbox" aria-label="Categories" onMouseDown={e => e.preventDefault()}>
              {matches.map((g, i) => <div key={g.name} id={`${categoryList}-${i}`} role="option" aria-selected={exact === g}
                className={`eqa-opt${exact === g ? ' is-on' : ''}${categoryActive === i ? ' is-active' : ''}`} onClick={() => { settleCategory(g.name); touch(); }}>
                <span>{g.name}</span><small>{exact === g && category.trim() !== g.name && <><b className="eqa-match">Matches existing</b> · </>}{plural(g.machines.length, 'machine')}</small>
              </div>)}
              {query && !exact && <>{matches.length > 0 && <hr aria-hidden="true" />}<div id={`${categoryList}-${matches.length}`} role="option" aria-selected="false"
                className={`eqa-opt eqa-opt--create${categoryActive === matches.length ? ' is-active' : ''}`} onClick={() => settleCategory(category.trim())}>+ Create “{category.trim()}”</div></>}
            </div>}
          </div>
          <label className="eqa-field"><span className="eqa-label">Location</span><input maxLength={100} value={location} disabled={busy} onChange={e => setLocation(e.target.value)} /></label>
        </div>
        <div className="eqa-field">
          <span className="eqa-label" id={certLabel}>Required certification</span>
          <button type="button" ref={certRef} className="eqa-pick" role="combobox" aria-haspopup="listbox" aria-expanded={!!certMenu} aria-controls={certList}
            aria-labelledby={certLabel} aria-activedescendant={certMenu ? `${certList}-${certActive}` : undefined} disabled={busy || !options.data}
            onClick={() => certMenu ? setCertMenu(null) : openCert()} onKeyDown={certKeys}>
            <span>{cert?.name ?? 'None'}</span>
            {cert && (later ? <em className="is-warn">starts {day(cert.startsOn)}</em> : cert.holders !== undefined && <em>{plural(cert.holders, 'member')} hold{cert.holders === 1 ? 's' : ''} it</em>)}
            <ChevronDown aria-hidden="true" />
          </button>
          {certMenu && createPortal(<div ref={menuRef} className="eqa-menu eqa-menu--fixed"
            style={{ left: certMenu.left, width: certMenu.width, top: certMenu.top, bottom: certMenu.bottom, maxHeight: certMenu.maxHeight }}>
            <div id={certList} role="listbox" aria-labelledby={certLabel}>
            {certChoices.map((c, i) => <Fragment key={c?.id ?? 0}>
              {c?.state === 'ended' && certChoices[i - 1]?.state !== 'ended' && <hr aria-hidden="true" />}
              <div id={`${certList}-${i}`} role="option" aria-selected={(c?.id ?? null) === certId} aria-disabled={!pickable(c) || undefined}
                className={`eqa-opt${(c?.id ?? null) === certId ? ' is-on' : ''}${certActive === i ? ' is-active' : ''}${pickable(c) ? '' : ' is-off'}`}
                onMouseEnter={() => pickable(c) && setCertActive(i)} onClick={() => pickCert(c)}>
                <span>{c?.name ?? 'None'}</span>
                <small>{!c ? '' : c.state === 'later' ? `starts ${day(c.startsOn)}` : c.state === 'ended' ? `ended ${day(c.endedOn)}` : c.holders === undefined ? '' : plural(c.holders, 'member')}</small>
              </div>
            </Fragment>)}
            </div>
            {certs.some(c => c.state === 'ended') && <p className="eqa-why">Ended certifications can’t be required.</p>}
          </div>, certRef.current?.closest('.modal-backdrop') ?? document.body)}
          <small className={later ? 'is-warn' : undefined}>{later ? `${cert!.name} starts ${day(cert!.startsOn)}. Members can’t book this machine before then.` : 'Only certifications in effect can be required.'}</small>
        </div>
        <div className="eqa-field">
          <span className="eqa-label" id={`${ids}-price`}>Price</span>
          <div className="eqa-rate-row">
            <span className="eqa-seg" role="group" aria-labelledby={`${ids}-price`}>
              <button type="button" aria-pressed={!free} disabled={busy} onClick={() => { setFree(false); touch(); window.setTimeout(() => rateRef.current?.focus()); }}>Hourly rate</button>
              <button type="button" aria-pressed={free} disabled={busy} onClick={() => { setFree(true); touch(); }}>Free to use</button>
            </span>
            {!free && <span className="eqa-money"><span aria-hidden="true">$</span><input ref={rateRef} inputMode="decimal" aria-label="Hourly rate in dollars" aria-invalid={price.error || undefined}
              className={price.error ? 'is-error' : undefined} value={rate} disabled={busy} onChange={e => setRate(e.target.value)} /><span aria-hidden="true">per hour</span></span>}
          </div>
          <small className={price.error ? 'is-error' : undefined}>{price.field}</small>
        </div>
        <button type="button" role="switch" aria-checked={waiver} className="eqa-switch" disabled={busy} onClick={() => { setWaiver(w => !w); touch(); }}><span className="eqa-knob" aria-hidden="true" />Members must sign the equipment waiver first</button>
      </div>

      <aside className="eqa-side" aria-label="Preview and booking check">
        <p className="eqa-eyebrow">Where members find it</p>
        <div className="eqa-preview">
          <div className="eqa-tile"><img src={cover} alt="" onError={e => { if (!e.currentTarget.src.endsWith(DEFAULT_PICTURE)) e.currentTarget.src = DEFAULT_PICTURE; }} /></div>
          <div className="eqa-rule" />
          <h3 className={card ? undefined : 'is-empty'}>{card?.title ?? 'Category'}</h3>
          <p className="eqa-names">{listed.slice(0, 3).map((n, i) => <span key={i}>{i > 0 && ' · '}{i === listed.length - 1 ? <mark>{n}</mark> : n}</span>)}{listed.length > 3 && `… + ${listed.length - 3} more`}</p>
          <p className="eqa-meta">{[free ? 'Free' : price.rate ? `${money(price.rate)}/hour` : 'Price not set', location.trim() || 'Location not set'].join(' · ')}</p>
          {opensTo && <p className="eqa-meta eqa-meta--note">Members see {trimmed || 'it'}{chosenPicture && chosenPicture !== cover ? ' and its picture' : ''} when they open the card.</p>}
        </div>
        <hr />
        <div className="eqa-check-head"><p className="eqa-eyebrow" id={`${ids}-check`}>Booking check</p><span className={`eqa-pill eqa-pill--${bad ? 'bad' : warn ? 'warn' : 'ok'}`}>{bad ? 'Can’t add yet' : later ? `From ${day(cert!.startsOn)}` : warn ? 'Check' : 'Ready'}</span></div>
        <ul className="eqa-checks" aria-labelledby={`${ids}-check`}>{items.map(i => <li key={i.title}>
          <span className={`eqa-ic eqa-ic--${i.tone}`} aria-hidden="true">{i.tone === 'ok' ? <Check /> : i.tone === 'warn' ? <AlertTriangle /> : <X />}</span>
          <span><b>{i.title}</b><small>{i.note}</small></span>
        </li>)}</ul>
      </aside>

      <div className="eqa-foot">
        {error ? <p className="eqa-foot__msg is-bad" role="alert">{error}</p> : <p className={`eqa-foot__msg is-${bad ? 'bad' : warn ? 'warn' : 'ok'}`} role="status">{footer}</p>}
        <button type="button" className="button button--quiet" disabled={busy} onClick={close}>Cancel</button>
        <button className="button button--primary" disabled={busy || !!bad || !options.data?.canManage}>{saving ? 'Adding…' : 'Add equipment'}</button>
      </div>
    </form>}
  </Modal>;
}
