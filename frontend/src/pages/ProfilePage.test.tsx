// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ProfilePage } from './ProfilePage';

const mocks = vi.hoisted(() => ({
    api: vi.fn(),
    refresh: vi.fn(),
    savePreferences: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
    useAuth: () => ({
        user: {
            id: 7,
            firstName: 'Jane',
            lastName: 'Member',
            email: 'jane@example.invalid',
            phone: '555-0100',
            role: 'member',
            roles: ['member'],
            membership: 'Monthly',
            status: 'active',
            accessStatus: 'active',
        },
        refresh: mocks.refresh,
    }),
}));

vi.mock('../context/AccountPreferencesContext', () => ({
    useAccountPreferences: () => ({
        preferences: {
            notifications: {
                reservations: true,
                classes: true,
                membershipPayments: true,
            },
            accessibility: {
                largeText: false,
                highContrast: false,
                reducedMotion: false,
            },
        },
        loading: false,
        error: '',
        save: mocks.savePreferences,
        reload: vi.fn(),
    }),
}));

vi.mock('../lib/api', () => ({
    api: mocks.api,
    errorMessage: () => 'Request failed',
}));

vi.mock('../lib/useApi', () => ({
    useApi: (path: string) =>
        path === '/me/memberships'
            ? {
                data: {
                    memberships: [{
                        id: 12,
                        effectiveStatus: 'active',
                        plan: { name: 'Workshop membership' },
                        startsAt: '2026-01-01T00:00:00.000Z',
                        endsAt: '2027-01-01T00:00:00.000Z',
                    }],
                    passes: [],
                    timeZone: 'America/New_York',
                    accessStatus: 'active',
                },
                loading: false,
                error: '',
                reload: vi.fn(),
            }
            : {
                data: {
                    items: [{
                        id: 20,
                        amount: '125.50',
                        status: 'paid',
                        planName: 'Workshop membership',
                        recordedAt: '2026-09-01T12:00:00.000Z',
                    }],
                    nextOffset: null,
                },
                loading: false,
                error: '',
                reload: vi.fn(),
            },
}));

function renderPage() {
    return render(
        <MemoryRouter>
            <ProfilePage />
        </MemoryRouter>,
    );
}

describe('account settings page', () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.api.mockResolvedValue({});
        mocks.refresh.mockResolvedValue(undefined);
        mocks.savePreferences.mockResolvedValue({});
    });

    it('shows the settings cards, membership and payment summaries, and contact block', () => {
        renderPage();
        expect(screen.getByRole('heading', { name: 'User Settings' })).toBeTruthy();
        for (const title of [
            'Personal Details',
            'Membership',
            'Notification Settings',
            'Accessibility',
            'Payments',
        ]) {
            expect(screen.getByRole('heading', { name: title })).toBeTruthy();
        }
        expect(screen.getAllByText('Workshop membership')).toHaveLength(2);
        expect(screen.getByText('$125.50')).toBeTruthy();
        expect(screen.getByText('Studio email address to be confirmed.')).toBeTruthy();
        expect(
            (screen.getByRole('button', { name: /Add image/ }) as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    it('persists notification and accessibility toggles', async () => {
        renderPage();
        fireEvent.click(screen.getByRole('checkbox', { name: /Reservation updates/ }));
        await waitFor(() => {
            expect(mocks.savePreferences).toHaveBeenCalledWith({
                notifications: { reservations: false },
            });
        });
        fireEvent.click(screen.getByRole('checkbox', { name: /Larger text/ }));
        await waitFor(() => {
            expect(mocks.savePreferences).toHaveBeenCalledWith({
                accessibility: { largeText: true },
            });
        });
    });

    it('saves profile fields using the existing member profile API', async () => {
        renderPage();
        fireEvent.submit(screen.getByRole('button', { name: 'Save details' }).closest('form')!);
        await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/me/profile', {
            method: 'PATCH',
            body: { firstName: 'Jane', lastName: 'Member', phone: '555-0100' },
        }));
        expect(mocks.refresh).toHaveBeenCalledOnce();
    });
});
