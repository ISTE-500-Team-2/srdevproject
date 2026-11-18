// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EquipmentAdd, type AddOptions } from './EquipmentAdd';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../lib/api', () => ({ api, ApiError: class extends Error {}, errorMessage: (e: Error) => e.message }));

let options: AddOptions;
const onAdded = vi.fn(), onClose = vi.fn();
beforeEach(() => {
  options = {
    canManage: true,
    certifications: [
      { id: 1, name: 'Wood lathe basics', state: 'now', startsOn: '2026-01-01', endedOn: null, holders: 6 },
      { id: 2, name: 'Resin casting', state: 'later', startsOn: '2026-12-01', endedOn: null, holders: 0 },
      { id: 3, name: 'Intro to welding', state: 'ended', startsOn: '2025-03-02', endedOn: '2026-03-02', holders: 0 },
      { id: 4, name: 'Laser safety', state: 'now', startsOn: null, endedOn: null, holders: 0 },
    ],
    groups: [
      { name: 'Laser engraver', machines: [{ id: 2, name: 'Darth Vader', image: '/assets/laser-engraver.webp' }] },
      { name: 'Metal lathe', machines: [{ id: 5, name: 'Kirk', image: '/assets/wood-lathe.webp' }] },
      { name: 'Wood lathe', machines: [{ id: 4, name: 'Spock', image: '/photos/spock.webp' }] },
    ],
  };
  api.mockImplementation((path: string) => path === '/admin/equipment/catalog-options' ? Promise.resolve(structuredClone(options)) : Promise.resolve({ id: 12 }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const open = async () => {
  render(<EquipmentAdd onClose={onClose} onAdded={onAdded} />);
  const dialog = await screen.findByRole('dialog', { name: 'Add equipment' });
  await waitFor(() => expect((within(dialog).getByRole('combobox', { name: 'Required certification' }) as HTMLButtonElement).disabled).toBe(false));
  return dialog;
};
const type = (dialog: HTMLElement, label: string, value: string) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
const category = (dialog: HTMLElement, value: string) => {
  const input = within(dialog).getByRole('combobox', { name: 'Category' });
  fireEvent.focus(input); fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
};
const add = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Add equipment' }) as HTMLButtonElement;
const check = (dialog: HTMLElement) => within(dialog).getByRole('list').textContent;
const footer = (dialog: HTMLElement) => within(dialog).getByRole('status').textContent;
const pickCertification = async (dialog: HTMLElement, name: RegExp) => {
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Required certification' }));
  fireEvent.click(await screen.findByRole('option', { name }));
};

test('the booking check holds back a machine members could not book, and says why', async () => {
  const dialog = await open();
  expect(add(dialog).disabled).toBe(true);
  expect(check(dialog)).toContain('Give it a name');
  type(dialog, 'Name', 'Glowforge Pro');
  category(dialog, 'Laser engraver');
  expect(check(dialog)).toContain('Set a price');
  type(dialog, 'Hourly rate in dollars', '0.25');
  expect(check(dialog)).toContain('Too low to charge a card');
  expect(within(dialog).getByText(/card payments start at \$0\.50/)).toBeTruthy();
  expect(add(dialog).disabled).toBe(true);
  type(dialog, 'Hourly rate in dollars', '4166.67');
  expect(check(dialog)).toContain('Too high for a full-day booking');
  type(dialog, 'Hourly rate in dollars', '0');
  expect(check(dialog)).toContain('The rate is $0');
  type(dialog, 'Hourly rate in dollars', '4166.66');
  expect(check(dialog)).toContain('$4,166.66 an hour');
  expect(footer(dialog)).toBe('Members can book it as soon as you add it.');
  expect(add(dialog).disabled).toBe(false);
  type(dialog, 'Location', ' ');
  expect(check(dialog)).toContain('Add a location');
  expect(footer(dialog)).toBe('Fix 1 item in the booking check to add this machine.');
});

test('free equipment saves a zero rate with the chosen picture, and reports what was added', async () => {
  const dialog = await open();
  type(dialog, 'Name', '  Glowforge Pro ');
  category(dialog, 'laser ENGRAVER');
  expect((within(dialog).getByRole('combobox', { name: 'Category' }) as HTMLInputElement).value).toBe('Laser engraver');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Free to use' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Laser engraver stock picture' }));
  fireEvent.click(within(dialog).getByRole('switch', { name: /equipment waiver/ }));
  fireEvent.click(add(dialog));
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: 12, name: 'Glowforge Pro', note: 'Members can book it now.' }));
  expect(api).toHaveBeenCalledWith('/admin/equipment', { method: 'POST', body: {
    name: 'Glowforge Pro', type: 'Laser engraver', location: 'Makerspace', image: '/assets/laser-engraver.webp', rate: 0, certId: null, waiverRequired: false,
  } });
});

test('ended certifications are listed but cannot be required; one that starts later warns', async () => {
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Required certification' }));
  const ended = await screen.findByRole('option', { name: /^Intro to welding/ });
  expect(ended.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText('Ended certifications can’t be required.')).toBeTruthy();
  fireEvent.click(ended);
  expect(within(dialog).getByRole('combobox', { name: 'Required certification' }).textContent).toContain('None');
  fireEvent.click(screen.getByRole('option', { name: /^Resin casting/ }));
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(within(dialog).getByText('Resin casting starts Dec 1. Members can’t book this machine before then.')).toBeTruthy();
  type(dialog, 'Name', 'Resin pot'); category(dialog, 'Resin'); type(dialog, 'Hourly rate in dollars', '8');
  expect(footer(dialog)).toBe('You can add it now. From Dec 1, members who hold Resin casting can book it.');
  expect(add(dialog).disabled).toBe(false);
  // In effect but held by no one yet: allowed, with a warning.
  await pickCertification(dialog, /^Laser safety/);
  expect(check(dialog)).toContain('No member holds it yet');
  await pickCertification(dialog, /^Wood lathe basics/);
  expect(check(dialog)).toContain('6 members hold it today');
});

test('the preview is the card members see, and a name already in the category is refused', async () => {
  const dialog = await open();
  type(dialog, 'Name', 'Oneway 1224');
  category(dialog, 'wood lathe');
  const preview = within(dialog).getByRole('complementary', { name: 'Preview and booking check' });
  // Wood and metal lathes share the member page's "Lathe" card, under its first machine's picture.
  expect(within(preview).getByRole('heading', { name: 'Lathe' })).toBeTruthy();
  expect(preview.textContent).toContain('Spock · Kirk · Oneway 1224');
  expect(check(dialog)).toContain('On the Lathe card');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Wood lathe stock picture' }));
  expect(preview.textContent).toContain('Members see Oneway 1224 and its picture when they open the card.');
  // The card labels each machine with its own category, so a metal lathe's name is free for a wood lathe...
  type(dialog, 'Name', 'Kirk');
  expect(check(dialog)).toContain('On the Lathe card');
  // ...but not a name already in the same category.
  type(dialog, 'Name', 'SPOCK');
  expect(check(dialog)).toContain('Another Wood lathe is called SPOCK');
  expect(add(dialog).disabled).toBe(true);
  category(dialog, 'Bench grinder');
  expect(check(dialog)).toContain('New Bench grinder card');
});

test('keyboard: arrows and Enter choose a category and a certification; Escape closes only the list', async () => {
  // jsdom has no layout; record what the list scrolls into view.
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  const dialog = await open();
  const input = within(dialog).getByRole('combobox', { name: 'Category' });
  fireEvent.focus(input); fireEvent.change(input, { target: { value: 'lathe' } });
  fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect((input as HTMLInputElement).value).toBe('Wood lathe');
  const certification = within(dialog).getByRole('combobox', { name: 'Required certification' });
  fireEvent.keyDown(certification, { key: 'ArrowDown' });
  expect(screen.getByRole('listbox')).toBeTruthy();
  // None, then the two in effect, then the one that starts later; the ended one is skipped.
  for (let i = 0; i < 4; i++) fireEvent.keyDown(certification, { key: 'ArrowDown' });
  expect(certification.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /^None/ }).id);
  fireEvent.keyDown(certification, { key: 'ArrowUp' });
  // The active option is kept in view on a list too long for the window.
  expect((scrolled.mock.contexts.at(-1) as HTMLElement).id).toBe(screen.getByRole('option', { name: /^Resin casting/ }).id);
  fireEvent.keyDown(certification, { key: 'Enter' });
  expect(certification.textContent).toContain('Resin casting');
  fireEvent.keyDown(certification, { key: 'ArrowDown' });
  fireEvent.keyDown(certification, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Add equipment' })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

test('a photo link must be one the server accepts', async () => {
  const dialog = await open();
  type(dialog, 'Name', 'Shopbot'); category(dialog, 'CNC router'); type(dialog, 'Hourly rate in dollars', '22');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
  type(dialog, 'Photo link', 'http://example.com/shopbot.jpg');
  expect(check(dialog)).toContain('Check the photo link');
  expect(add(dialog).disabled).toBe(true);
  type(dialog, 'Photo link', 'https://example.com/shopbot.jpg');
  fireEvent.click(add(dialog));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/equipment', expect.objectContaining({ body: expect.objectContaining({ image: 'https://example.com/shopbot.jpg' }) })));
});

test('a refusal from the server is shown and the form stays open', async () => {
  const dialog = await open();
  type(dialog, 'Name', 'Spock 2'); category(dialog, 'Wood lathe'); type(dialog, 'Hourly rate in dollars', '12');
  api.mockRejectedValueOnce(new Error('Another Wood lathe is already called Spock 2.'));
  fireEvent.click(add(dialog));
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Another Wood lathe is already called Spock 2.');
  expect(onAdded).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Add equipment' })).toBeTruthy();
});

test('the confirmation says so when no member holds the required certification yet', async () => {
  const dialog = await open();
  type(dialog, 'Name', 'Fiber laser'); category(dialog, 'Laser engraver'); type(dialog, 'Hourly rate in dollars', '30');
  await pickCertification(dialog, /^Laser safety/);
  fireEvent.click(add(dialog));
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: 12, name: 'Fiber laser', note: 'Members need Laser safety to book it, and no one holds it yet.' }));
});

test('without a published equipment waiver, a machine that requires one is added with a warning', async () => {
  options.equipmentWaiver = false;
  const dialog = await open();
  type(dialog, 'Name', 'Fiber laser'); category(dialog, 'Laser engraver'); type(dialog, 'Hourly rate in dollars', '30');
  expect(check(dialog)).toContain('None is published yet. No one can book until one is');
  expect(footer(dialog)).toBe('You can add it now. No one can book it until an equipment waiver is published.');
  // Not requiring the waiver clears it.
  fireEvent.click(within(dialog).getByRole('switch', { name: /equipment waiver/ }));
  expect(footer(dialog)).toBe('Members can book it as soon as you add it.');
  fireEvent.click(within(dialog).getByRole('switch', { name: /equipment waiver/ }));
  fireEvent.click(add(dialog));
  await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: 12, name: 'Fiber laser', note: 'No one can book it until an equipment waiver is published.' }));
});

test('the preview follows each machine’s own spelling, as the member page does', async () => {
  // An older machine spelled differently stays on its own member card.
  options.groups = [{ name: 'Bench Grinder', machines: [
    { id: 20, name: 'Old grinder', image: '/old.webp', type: 'Bench grinder' },
    { id: 21, name: 'Grinder A', image: '/a.webp', type: 'Bench Grinder' },
    { id: 22, name: 'Grinder B', image: '/b.webp', type: 'Bench Grinder' },
  ] }];
  const dialog = await open();
  type(dialog, 'Name', 'Grinder C'); category(dialog, 'bench grinder');
  const preview = within(dialog).getByRole('complementary', { name: 'Preview and booking check' });
  expect(preview.textContent).toContain('Grinder A · Grinder B · Grinder C');
  expect(preview.textContent).not.toContain('Old grinder');
  expect(preview.querySelector('.eqa-tile img')!.getAttribute('src')).toBe('/a.webp');
});
